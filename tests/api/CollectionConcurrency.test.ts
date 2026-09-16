import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Force in-memory DB and isolated temp directory before any imports
(process.env as Record<string, string | undefined>).NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = ':memory:';
process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'lit-review-graph-collection-concurrency-' + Date.now());

import { getDb } from '../../src/lib/db.js';
import { PaperRepository } from '../../src/domain/repositories/PaperRepository.js';
import { CitationRepository } from '../../src/domain/repositories/CitationRepository.js';
import { POST, GET } from '../../src/api/collection/route.js';

describe('Milestone 6 (R2): Collection Route Concurrency & Atomic Upsert Suite', () => {
  const physicalDbPath = path.join(process.cwd(), 'data', 'papers.db');
  let initialMtime = 0;
  let initialSize = 0;

  const colA = 'col-concurrency-test-a';
  const colB = 'col-concurrency-test-b';

  before(() => {
    if (fs.existsSync(physicalDbPath)) {
      const stats = fs.statSync(physicalDbPath);
      initialMtime = stats.mtimeMs;
      initialSize = stats.size;
    }

    const db = getDb();
    // Inhibit background backup from touching disk during testing
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
      'last_db_backup_time',
      Date.now().toString()
    );

    // Create test collections
    db.prepare('INSERT OR IGNORE INTO collections (id, name) VALUES (?, ?)').run(colA, 'Concurrency Collection A');
    db.prepare('INSERT OR IGNORE INTO collections (id, name) VALUES (?, ?)').run(colB, 'Concurrency Collection B');
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM citations WHERE collectionId IN (?, ?)').run(colA, colB);
    db.prepare('DELETE FROM papers WHERE collectionId IN (?, ?)').run(colA, colB);
  });

  after(() => {
    if (fs.existsSync(physicalDbPath)) {
      const stats = fs.statSync(physicalDbPath);
      assert.strictEqual(stats.mtimeMs, initialMtime, 'Physical DB mtime was modified!');
      assert.strictEqual(stats.size, initialSize, 'Physical DB size was modified!');
    }
  });

  describe('1. High Concurrency Burst (Same Paper, Same Collection)', () => {
    it('handles 25 concurrent requests to add the same seed paper without any 500 errors or duplicate rows', async () => {
      const payload = {
        id: 'concurrent-p1',
        collectionId: colA,
        title: 'Attention Is All You Need',
        status: 'seed',
        doi: '10.1234/5678',
        abstract: 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks...',
        authors: [{ name: 'Ashish Vaswani' }, { name: 'Noam Shazeer' }],
        year: 2017,
        venue: 'NeurIPS'
      };

      const promises = Array.from({ length: 25 }, () => {
        const req = new Request('http://localhost:3000/api/collection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        return POST(req);
      });

      const responses = await Promise.all(promises);

      // Verify 0 requests threw 500 error or crashed
      for (const res of responses) {
        assert.strictEqual(res.status, 200, `Expected 200 but got ${res.status}`);
        const data = await res.json();
        assert.strictEqual(data.success, true);
        assert.ok(
          data.message === 'Paper added successfully' || data.message === 'Paper already in collection',
          `Unexpected message: ${data.message}`
        );
      }

      // Verify paper is present in the database with status 'seed'
      const paper = PaperRepository.getPaper('concurrent-p1', colA);
      assert.ok(paper, 'Paper should exist in collection A');
      assert.strictEqual(paper.id, 'concurrent-p1');
      assert.strictEqual(paper.status, 'seed');
      assert.strictEqual(paper.title, 'Attention Is All You Need');

      // Verify no duplicate rows exist in SQLite
      const db = getDb();
      const countRow = db.prepare('SELECT COUNT(*) as count FROM papers WHERE id = ? AND collectionId = ?').get('concurrent-p1', colA) as { count: number };
      assert.strictEqual(countRow.count, 1, 'Exactly one row should exist for (id, collectionId)');
    });
  });

  describe('2. Mixed Status Concurrency Burst (Concurrent seed and recommended)', () => {
    it('concurrently processes 15 seed and 15 recommended requests, resulting in status seed without crash', async () => {
      const basePayload = {
        id: 'mixed-status-p1',
        collectionId: colA,
        title: 'BERT: Pre-training of Deep Bidirectional Transformers',
        year: 2018,
        venue: 'NAACL'
      };

      const seedPromises = Array.from({ length: 15 }, () => {
        const req = new Request('http://localhost:3000/api/collection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...basePayload, status: 'seed' })
        });
        return POST(req);
      });

      const recPromises = Array.from({ length: 15 }, () => {
        const req = new Request('http://localhost:3000/api/collection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...basePayload, status: 'recommended' })
        });
        return POST(req);
      });

      // Interleave seed and recommended requests
      const allPromises: Promise<Response>[] = [];
      for (let i = 0; i < 15; i++) {
        allPromises.push(recPromises[i]);
        allPromises.push(seedPromises[i]);
      }

      const responses = await Promise.all(allPromises);

      // Verify all 30 responses return HTTP 200
      for (const res of responses) {
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.success, true);
      }

      // Verify final status in DB is 'seed' (curated seed status is preserved/upgraded)
      const paper = PaperRepository.getPaper('mixed-status-p1', colA);
      assert.ok(paper);
      assert.strictEqual(paper.status, 'seed', 'Status should be seed when seed requests are part of concurrent mix');

      const db = getDb();
      const countRow = db.prepare('SELECT COUNT(*) as count FROM papers WHERE id = ? AND collectionId = ?').get('mixed-status-p1', colA) as { count: number };
      assert.strictEqual(countRow.count, 1);
    });
  });

  describe('3. Status Upgrade from recommended to seed under Concurrency', () => {
    it('upgrades pre-existing recommended paper to seed when concurrent seed additions occur', async () => {
      // Pre-seed paper as recommended (e.g. from background expansion)
      PaperRepository.addPapers([
        {
          id: 'upgrade-p1',
          title: 'Deep Residual Learning for Image Recognition',
          year: 2015,
          venue: 'CVPR'
        }
      ], colA, 'recommended');

      const initial = PaperRepository.getPaper('upgrade-p1', colA);
      assert.strictEqual(initial.status, 'recommended');

      // 10 concurrent requests attempting to add as seed
      const promises = Array.from({ length: 10 }, () => {
        const req = new Request('http://localhost:3000/api/collection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: 'upgrade-p1',
            collectionId: colA,
            title: 'Deep Residual Learning for Image Recognition',
            status: 'seed'
          })
        });
        return POST(req);
      });

      const responses = await Promise.all(promises);

      for (const res of responses) {
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.success, true);
        assert.ok(
          data.message === 'Paper status updated' || data.message === 'Paper already in collection',
          `Expected update or already in collection, got: ${data.message}`
        );
      }

      const upgraded = PaperRepository.getPaper('upgrade-p1', colA);
      assert.strictEqual(upgraded.status, 'seed');

      const db = getDb();
      const countRow = db.prepare('SELECT COUNT(*) as count FROM papers WHERE id = ? AND collectionId = ?').get('upgrade-p1', colA) as { count: number };
      assert.strictEqual(countRow.count, 1);
    });
  });

  describe('4. Data Preservation (No ON DELETE CASCADE / No Data Loss)', () => {
    it('preserves existing citations, localTags, and notes when concurrent POST requests arrive for an existing paper', async () => {
      // 1. Insert seed paper with tags and notes
      const db = getDb();
      db.prepare(`
        INSERT INTO papers (id, collectionId, title, status, localTags, notes)
        VALUES (?, ?, ?, 'seed', ?, ?)
      `).run('casc-p1', colA, 'Citation Anchor Paper', JSON.stringify(['tag-alpha', 'tag-beta']), 'My extensive research notes');

      db.prepare(`
        INSERT INTO papers (id, collectionId, title, status, localTags, notes)
        VALUES (?, ?, ?, 'seed', '[]', '')
      `).run('casc-p2', colA, 'Connected Target Paper');

      // 2. Add citation edges
      CitationRepository.addLinks(colA, [
        { source: 'casc-p1', target: 'casc-p2' },
        { source: 'casc-p2', target: 'casc-p1' }
      ]);

      const initialLinks = CitationRepository.getLinksForCollection(colA);
      assert.strictEqual(initialLinks.length, 2);

      // 3. Fire 15 concurrent POST requests for casc-p1
      const promises = Array.from({ length: 15 }, () => {
        const req = new Request('http://localhost:3000/api/collection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: 'casc-p1',
            collectionId: colA,
            title: 'Citation Anchor Paper',
            status: 'seed'
          })
        });
        return POST(req);
      });

      const responses = await Promise.all(promises);
      for (const res of responses) {
        assert.strictEqual(res.status, 200);
      }

      // 4. Verify citations are NOT wiped by ON DELETE CASCADE
      const finalLinks = CitationRepository.getLinksForCollection(colA);
      assert.strictEqual(finalLinks.length, 2, 'Citation links must be preserved and not deleted by cascade');

      // 5. Verify localTags and notes are preserved
      const paper = PaperRepository.getPaper('casc-p1', colA);
      assert.deepStrictEqual(paper.localTags, ['tag-alpha', 'tag-beta']);
      assert.strictEqual(paper.notes, 'My extensive research notes');
    });
  });

  describe('5. Multi-Collection Isolation under Concurrency', () => {
    it('isolates concurrent additions of the same paper ID across distinct collections', async () => {
      const payloadA = { id: 'cross-col-p', collectionId: colA, title: 'Cross Collection Paper', status: 'seed' };
      const payloadB = { id: 'cross-col-p', collectionId: colB, title: 'Cross Collection Paper', status: 'recommended' };

      const promisesA = Array.from({ length: 15 }, () => {
        const req = new Request('http://localhost:3000/api/collection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payloadA)
        });
        return POST(req);
      });

      const promisesB = Array.from({ length: 15 }, () => {
        const req = new Request('http://localhost:3000/api/collection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payloadB)
        });
        return POST(req);
      });

      const responses = await Promise.all([...promisesA, ...promisesB]);
      for (const res of responses) {
        assert.strictEqual(res.status, 200);
      }

      const paperA = PaperRepository.getPaper('cross-col-p', colA);
      const paperB = PaperRepository.getPaper('cross-col-p', colB);

      assert.ok(paperA);
      assert.ok(paperB);
      assert.strictEqual(paperA.status, 'seed');
      assert.strictEqual(paperB.status, 'recommended');

      const db = getDb();
      const countA = (db.prepare('SELECT COUNT(*) as c FROM papers WHERE id = ? AND collectionId = ?').get('cross-col-p', colA) as { c: number }).c;
      const countB = (db.prepare('SELECT COUNT(*) as c FROM papers WHERE id = ? AND collectionId = ?').get('cross-col-p', colB) as { c: number }).c;
      assert.strictEqual(countA, 1);
      assert.strictEqual(countB, 1);
    });
  });

  describe('6. Defensive Constraint Error Handling', () => {
    it('catches SQLite UNIQUE constraint collisions defensively and returns HTTP 200', async () => {
      // We can directly verify the defensive catch by stubbing upsertPaper to throw a SQLite constraint error
      const originalUpsert = PaperRepository.upsertPaper;
      try {
        PaperRepository.upsertPaper = () => {
          const err = new Error('UNIQUE constraint failed: papers.id, papers.collectionId') as Error & { code?: string };
          err.code = 'SQLITE_CONSTRAINT_PRIMARYKEY';
          throw err;
        };

        const req = new Request('http://localhost:3000/api/collection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: 'mock-conflict',
            collectionId: colA,
            title: 'Mock Conflict Paper',
            status: 'seed'
          })
        });

        const res = await POST(req);
        assert.strictEqual(res.status, 200, 'Must catch constraint error and return 200');
        const data = await res.json();
        assert.strictEqual(data.success, true);
        assert.strictEqual(data.message, 'Paper already in collection');
      } finally {
        PaperRepository.upsertPaper = originalUpsert;
      }
    });
  });

  describe('7. Validation & GET Endpoint', () => {
    it('returns 400 when id or collectionId are missing', async () => {
      const req1 = new Request('http://localhost:3000/api/collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'No ID', collectionId: colA })
      });
      const res1 = await POST(req1);
      assert.strictEqual(res1.status, 400);

      const req2 = new Request('http://localhost:3000/api/collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'no-col', title: 'No Collection' })
      });
      const res2 = await POST(req2);
      assert.strictEqual(res2.status, 400);
    });

    it('returns 400 when paper title is missing for a new paper', async () => {
      const req = new Request('http://localhost:3000/api/collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'brand-new-paper', collectionId: colA })
      });
      const res = await POST(req);
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.error, 'Full paper details are required');
    });

    it('allows updating status without title if paper already exists', async () => {
      PaperRepository.addPaper({ id: 'existing-for-update', title: 'Existing Paper' }, colA, 'recommended');

      const req = new Request('http://localhost:3000/api/collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'existing-for-update', collectionId: colA, status: 'seed' })
      });
      const res = await POST(req);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.message, 'Paper status updated');

      const paper = PaperRepository.getPaper('existing-for-update', colA);
      assert.strictEqual(paper.status, 'seed');
    });

    it('GET /api/collection returns papers for the requested collection', async () => {
      PaperRepository.addPaper({ id: 'get-p1', title: 'Get Paper 1' }, colA, 'seed');
      PaperRepository.addPaper({ id: 'get-p2', title: 'Get Paper 2' }, colA, 'recommended');

      const req = new Request(`http://localhost:3000/api/collection?collectionId=${colA}`);
      const res = await GET(req);
      assert.strictEqual(res.status, 200);
      const papers = await res.json();
      assert.strictEqual(papers.length, 2);
    });

    it('GET /api/collection without collectionId returns 400', async () => {
      const req = new Request('http://localhost:3000/api/collection');
      const res = await GET(req);
      assert.strictEqual(res.status, 400);
    });
  });

  describe('8. PaperRepository.upsertPaper Direct Contract Suite', () => {
    it('returns inserted action when adding a new paper', () => {
      const res = PaperRepository.upsertPaper({
        id: 'direct-p1',
        title: 'Direct Test Paper',
        authors: ['Direct Author'],
        localTags: ['tagA'],
        notes: 'Initial direct note'
      }, colA, 'seed');

      assert.deepStrictEqual(res, { action: 'inserted' });

      const paper = PaperRepository.getPaper('direct-p1', colA);
      assert.ok(paper);
      assert.strictEqual(paper.status, 'seed');
      assert.deepStrictEqual(paper.localTags, ['tagA']);
      assert.strictEqual(paper.notes, 'Initial direct note');
    });

    it('returns unchanged action when re-upserting identical status', () => {
      PaperRepository.upsertPaper({ id: 'direct-p2', title: 'Direct P2' }, colA, 'seed');
      const res = PaperRepository.upsertPaper({ id: 'direct-p2', title: 'Direct P2' }, colA, 'seed');
      assert.deepStrictEqual(res, { action: 'unchanged' });
    });

    it('upgrades recommended to seed and returns updated action without overwriting notes/tags', () => {
      PaperRepository.upsertPaper({
        id: 'direct-p3',
        title: 'Direct P3',
        localTags: ['keep-tag'],
        notes: 'keep-note'
      }, colA, 'recommended');

      const res = PaperRepository.upsertPaper({ id: 'direct-p3', title: 'Direct P3' }, colA, 'seed');
      assert.deepStrictEqual(res, { action: 'updated' });

      const paper = PaperRepository.getPaper('direct-p3', colA);
      assert.strictEqual(paper.status, 'seed');
      assert.deepStrictEqual(paper.localTags, ['keep-tag']);
      assert.strictEqual(paper.notes, 'keep-note');
    });

    it('does not demote seed or collection status to recommended', () => {
      PaperRepository.upsertPaper({ id: 'direct-seed', title: 'Direct Seed' }, colA, 'seed');
      const resSeed = PaperRepository.upsertPaper({ id: 'direct-seed', title: 'Direct Seed' }, colA, 'recommended');
      assert.deepStrictEqual(resSeed, { action: 'unchanged' });
      assert.strictEqual(PaperRepository.getPaper('direct-seed', colA).status, 'seed');

      const db = getDb();
      db.prepare("INSERT INTO papers (id, collectionId, title, status, localTags, notes) VALUES (?, ?, ?, 'collection', '[]', '')")
        .run('direct-col', colA, 'Direct Col');
      const resCol = PaperRepository.upsertPaper({ id: 'direct-col', title: 'Direct Col' }, colA, 'recommended');
      assert.deepStrictEqual(resCol, { action: 'unchanged' });
      assert.strictEqual(PaperRepository.getPaper('direct-col', colA).status, 'collection');
    });
  });
});
