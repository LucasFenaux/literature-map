import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import Database from 'better-sqlite3';

// Ensure isolated in-memory DB and temp app data directory
(process.env as Record<string, string | undefined>).NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = ':memory:';
process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'lit-review-graph-challenger2-' + Date.now());

import { getDb } from '../../src/lib/db.js';
import { PaperRepository } from '../../src/domain/repositories/PaperRepository.js';
import { CitationRepository } from '../../src/domain/repositories/CitationRepository.js';
import { POST } from '../../src/api/collection/route.js';

describe('Milestone 6 (R2): Challenger 2 Adversarial Database State & Integrity Suite', () => {
  const physicalDbPath = path.join(process.cwd(), 'data', 'papers.db');
  let initialMtime = 0;
  let initialSize = 0;
  let initialSha256 = '';

  const colA = 'col-c2-stress-a';
  const colB = 'col-c2-stress-b';
  const isoCols = [
    'col-c2-iso-1',
    'col-c2-iso-2',
    'col-c2-iso-3',
    'col-c2-iso-4',
    'col-c2-iso-5',
    'col-c2-iso-6'
  ];
  const allCols = [colA, colB, ...isoCols];

  function getFileSha256(filePath: string): string {
    if (!fs.existsSync(filePath)) return '';
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
  }

  before(() => {
    // Record physical database baseline if it exists
    if (fs.existsSync(physicalDbPath)) {
      const stats = fs.statSync(physicalDbPath);
      initialMtime = stats.mtimeMs;
      initialSize = stats.size;
      initialSha256 = getFileSha256(physicalDbPath);
    }

    const db = getDb();
    // Guard against background backups triggering
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
      'last_db_backup_time',
      Date.now().toString()
    );

    // Create collections in isolated test db
    for (const colId of allCols) {
      db.prepare('INSERT OR IGNORE INTO collections (id, name) VALUES (?, ?)').run(colId, `Challenger2 Collection ${colId}`);
    }
  });

  beforeEach(() => {
    const db = getDb();
    const placeholders = allCols.map(() => '?').join(',');
    db.prepare(`DELETE FROM citations WHERE collectionId IN (${placeholders})`).run(...allCols);
    db.prepare(`DELETE FROM papers WHERE collectionId IN (${placeholders})`).run(...allCols);
  });

  after(() => {
    // Physical DB integrity and immutability checks
    if (fs.existsSync(physicalDbPath)) {
      const stats = fs.statSync(physicalDbPath);
      const finalSha256 = getFileSha256(physicalDbPath);

      assert.strictEqual(stats.mtimeMs, initialMtime, 'Physical DB mtime was modified during tests!');
      assert.strictEqual(stats.size, initialSize, 'Physical DB size was modified during tests!');
      assert.strictEqual(finalSha256, initialSha256, 'Physical DB SHA256 checksum changed during tests!');

      // Check SQLite integrity of physical database
      const diskDb = new Database(physicalDbPath, { readonly: true });
      try {
        const integrity = diskDb.pragma('integrity_check') as Array<{ integrity_check: string }>;
        assert.ok(Array.isArray(integrity) && integrity.length > 0);
        assert.strictEqual(integrity[0].integrity_check, 'ok', 'Physical DB failed integrity check!');
      } finally {
        diskDb.close();
      }
    }
  });

  describe('1. Citations, Notes, and LocalTags Preservation Under Concurrent Upserts', () => {
    it('verifies that citations, custom notes, and localTags are NEVER wiped or cascaded away during 150 concurrent upserts', async () => {
      const db = getDb();

      // 1. Setup anchor paper with rich tags and notes
      const initialTags = ['deep-learning', 'seminal-2017', 'must-cite', 'graph-theory'];
      const initialNotes = 'Fundamental architectural breakthrough with multi-head self-attention mechanisms.';

      db.prepare(`
        INSERT INTO papers (id, collectionId, doi, title, abstract, authors, year, status, localTags, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'seed', ?, ?)
      `).run(
        'preserved-p1',
        colA,
        '10.1000/pres-1',
        'Preserved Attention Paper',
        'Seminal abstract content...',
        JSON.stringify([{ name: 'Vaswani et al.' }]),
        2017,
        JSON.stringify(initialTags),
        initialNotes
      );

      // 2. Setup connected papers in collection A
      db.prepare(`INSERT INTO papers (id, collectionId, title, status, localTags, notes) VALUES (?, ?, ?, 'recommended', '[]', '')`)
        .run('target-p2', colA, 'Target Paper 2');
      db.prepare(`INSERT INTO papers (id, collectionId, title, status, localTags, notes) VALUES (?, ?, ?, 'recommended', '[]', '')`)
        .run('target-p3', colA, 'Target Paper 3');
      db.prepare(`INSERT INTO papers (id, collectionId, title, status, localTags, notes) VALUES (?, ?, ?, 'recommended', '[]', '')`)
        .run('source-p4', colA, 'Source Paper 4');

      // 3. Create foreign-keyed citation graph edges
      CitationRepository.addLinks(colA, [
        { source: 'preserved-p1', target: 'target-p2' },
        { source: 'target-p2', target: 'preserved-p1' }, // bidirectional
        { source: 'preserved-p1', target: 'target-p3' },
        { source: 'source-p4', target: 'preserved-p1' }
      ]);

      const initialCitations = CitationRepository.getLinksForCollection(colA);
      assert.strictEqual(initialCitations.length, 4, 'Should have exactly 4 citation edges initially');

      // 4. Concurrency Wave 1: 50 requests with status seed, default empty tags/notes payload
      const wave1 = Array.from({ length: 50 }, () => {
        const req = new Request('http://localhost:3000/api/collection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: 'preserved-p1',
            collectionId: colA,
            title: 'Preserved Attention Paper',
            status: 'seed'
            // Omitting localTags and notes to test if upsert wipes them
          })
        });
        return POST(req);
      });

      // 5. Concurrency Wave 2: 50 requests with status recommended attempting to demote or overwrite
      const wave2 = Array.from({ length: 50 }, () => {
        const req = new Request('http://localhost:3000/api/collection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: 'preserved-p1',
            collectionId: colA,
            title: 'Preserved Attention Paper',
            status: 'recommended',
            localTags: ['overwriting-tag-attempt'],
            notes: 'Overwriting notes attempt'
          })
        });
        return POST(req);
      });

      // 6. Concurrency Wave 3: 50 status-only update requests omitting title
      const wave3 = Array.from({ length: 50 }, () => {
        const req = new Request('http://localhost:3000/api/collection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: 'preserved-p1',
            collectionId: colA,
            status: 'seed'
          })
        });
        return POST(req);
      });

      // Interleave all 150 requests into a single concurrent burst
      const allWaves: Promise<Response>[] = [];
      for (let i = 0; i < 50; i++) {
        allWaves.push(wave1[i]);
        allWaves.push(wave2[i]);
        allWaves.push(wave3[i]);
      }

      const allResponses = await Promise.all(allWaves);

      // Verify all 150 requests returned HTTP 200 without a single 500 error
      for (const res of allResponses) {
        assert.strictEqual(res.status, 200, `Expected 200 OK but received ${res.status}`);
        const data = await res.json();
        assert.strictEqual(data.success, true);
      }

      // Verify paper data in database
      const paper = PaperRepository.getPaper('preserved-p1', colA);
      assert.ok(paper, 'Paper preserved-p1 must still exist');
      assert.strictEqual(paper.status, 'seed', 'Status must remain seed');
      assert.deepStrictEqual(paper.localTags, initialTags, 'localTags must NOT be wiped or overwritten');
      assert.strictEqual(paper.notes, initialNotes, 'notes must NOT be wiped or overwritten');

      // Verify all 4 citation graph edges are preserved (0 cascaded away)
      const finalCitations = CitationRepository.getLinksForCollection(colA);
      assert.strictEqual(finalCitations.length, 4, 'All 4 citations must be preserved; ON DELETE CASCADE must not trigger');

      // Verify SQLite row count
      const count = (db.prepare('SELECT COUNT(*) as cnt FROM papers WHERE id = ? AND collectionId = ?')
        .get('preserved-p1', colA) as { cnt: number }).cnt;
      assert.strictEqual(count, 1, 'Exactly one row must exist for (id, collectionId)');
    });

    it('verifies that PaperRepository.upsertPaper atomic transactions protect existing tags and notes', () => {
      // Direct repository test
      const res1 = PaperRepository.upsertPaper({
        id: 'direct-repo-p1',
        title: 'Initial Title',
        localTags: ['tagX', 'tagY'],
        notes: 'Initial user research thoughts'
      }, colA, 'seed');

      assert.deepStrictEqual(res1, { action: 'inserted' });

      // Re-upsert with blank/different tags/notes
      const res2 = PaperRepository.upsertPaper({
        id: 'direct-repo-p1',
        title: 'Updated Title Attempt',
        localTags: [],
        notes: ''
      }, colA, 'seed');

      assert.deepStrictEqual(res2, { action: 'unchanged' });

      // Re-upsert with status update
      const res3 = PaperRepository.upsertPaper({
        id: 'direct-repo-p1',
        title: 'Initial Title',
        localTags: ['should-not-override'],
        notes: 'should-not-override'
      }, colA, 'seed');

      assert.deepStrictEqual(res3, { action: 'unchanged' });

      const stored = PaperRepository.getPaper('direct-repo-p1', colA);
      assert.deepStrictEqual(stored.localTags, ['tagX', 'tagY']);
      assert.strictEqual(stored.notes, 'Initial user research thoughts');
    });
  });

  describe('2. Multi-Collection Isolation Under Extreme Concurrency', () => {
    it('simultaneously adds and queries the same paper ID across 6 distinct collections with 30 requests each (180 total)', async () => {
      const sharedPaperId = 'universal-paper-isolated-42';
      const promises: Promise<Response>[] = [];

      // Launch 30 concurrent requests per collection across all 6 collections
      for (let i = 0; i < isoCols.length; i++) {
        const colId = isoCols[i];
        const status = i % 2 === 0 ? 'seed' : 'recommended';
        const customTitle = `Universal Paper in Collection ${colId}`;

        for (let r = 0; r < 30; r++) {
          const req = new Request('http://localhost:3000/api/collection', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: sharedPaperId,
              collectionId: colId,
              title: customTitle,
              status,
              doi: `10.1234/col-${i}`
            })
          });
          promises.push(POST(req));
        }
      }

      assert.strictEqual(promises.length, 180, 'Must fire 180 concurrent requests');

      const responses = await Promise.all(promises);

      // Verify all 180 responses are HTTP 200
      for (const res of responses) {
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.success, true);
      }

      // Verify multi-collection isolation in database
      const db = getDb();
      for (let i = 0; i < isoCols.length; i++) {
        const colId = isoCols[i];
        const expectedStatus = i % 2 === 0 ? 'seed' : 'recommended';
        const expectedTitle = `Universal Paper in Collection ${colId}`;

        const countRow = db.prepare('SELECT COUNT(*) as count FROM papers WHERE id = ? AND collectionId = ?')
          .get(sharedPaperId, colId) as { count: number };
        assert.strictEqual(countRow.count, 1, `Collection ${colId} must have exactly 1 row`);

        const paper = PaperRepository.getPaper(sharedPaperId, colId);
        assert.ok(paper, `Paper must exist in ${colId}`);
        assert.strictEqual(paper.status, expectedStatus);
        assert.strictEqual(paper.title, expectedTitle);
      }
    });

    it('verifies that deleting or clearing papers in one collection has ZERO effect on other collections sharing the same paper ID', async () => {
      const crossId = 'cross-isolation-cascade-test';

      // Insert paper into Collection 1 and Collection 2
      PaperRepository.upsertPaper({
        id: crossId,
        title: 'Cross Col Paper',
        localTags: ['tag-col1'],
        notes: 'Notes in Col 1'
      }, isoCols[0], 'seed');

      PaperRepository.upsertPaper({
        id: crossId,
        title: 'Cross Col Paper',
        localTags: ['tag-col2'],
        notes: 'Notes in Col 2'
      }, isoCols[1], 'seed');

      // Add target paper in col 1 and citation link
      PaperRepository.upsertPaper({ id: 'target-col1', title: 'Target Col 1' }, isoCols[0], 'seed');
      CitationRepository.addLinks(isoCols[0], [{ source: crossId, target: 'target-col1' }]);

      // Add target paper in col 2 and citation link
      PaperRepository.upsertPaper({ id: 'target-col2', title: 'Target Col 2' }, isoCols[1], 'seed');
      CitationRepository.addLinks(isoCols[1], [{ source: crossId, target: 'target-col2' }]);

      assert.strictEqual(CitationRepository.getLinksForCollection(isoCols[0]).length, 1);
      assert.strictEqual(CitationRepository.getLinksForCollection(isoCols[1]).length, 1);

      // Now completely wipe / clear Collection 2
      PaperRepository.clearCollection(isoCols[1]);

      // Assert Collection 2 is completely empty
      assert.strictEqual(PaperRepository.getPapersForCollection(isoCols[1]).length, 0);
      assert.strictEqual(CitationRepository.getLinksForCollection(isoCols[1]).length, 0);

      // Assert Collection 1 is 100% unaffected and fully intact
      const paper1 = PaperRepository.getPaper(crossId, isoCols[0]);
      assert.ok(paper1, 'Paper in Collection 1 must still exist');
      assert.strictEqual(paper1.status, 'seed');
      assert.deepStrictEqual(paper1.localTags, ['tag-col1']);
      assert.strictEqual(paper1.notes, 'Notes in Col 1');

      const links1 = CitationRepository.getLinksForCollection(isoCols[0]);
      assert.strictEqual(links1.length, 1, 'Citation link in Collection 1 must be untouched');
      assert.strictEqual(links1[0].source, crossId);
      assert.strictEqual(links1[0].target, 'target-col1');
    });
  });

  describe('3. Physical SQLite Database Non-Corruption and Immutability', () => {
    it('confirms physical database data/papers.db has not been written to or corrupted during test execution', () => {
      if (!fs.existsSync(physicalDbPath)) {
        return; // If running in environment without physical DB, skip
      }

      const currentStats = fs.statSync(physicalDbPath);
      const currentSha256 = getFileSha256(physicalDbPath);

      assert.strictEqual(currentStats.mtimeMs, initialMtime, 'Physical DB mtime was modified!');
      assert.strictEqual(currentStats.size, initialSize, 'Physical DB size was modified!');
      assert.strictEqual(currentSha256, initialSha256, 'Physical DB SHA256 checksum changed!');

      // Check SQLite database integrity directly
      const diskDb = new Database(physicalDbPath, { readonly: true });
      try {
        const integrity = diskDb.pragma('integrity_check') as Array<{ integrity_check: string }>;
        assert.ok(Array.isArray(integrity) && integrity.length > 0);
        assert.strictEqual(integrity[0].integrity_check, 'ok', 'Physical DB corrupted!');
      } finally {
        diskDb.close();
      }
    });
  });
});
