import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Force in-memory DB and isolated temp directory before any imports
(process.env as Record<string, string | undefined>).NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = ':memory:';
process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'lit-review-graph-challenger1-concurrency-' + Date.now());

import { getDb } from '../../src/lib/db.js';
import { PaperRepository } from '../../src/domain/repositories/PaperRepository.js';
import { CitationRepository } from '../../src/domain/repositories/CitationRepository.js';
import { POST } from '../../src/api/collection/route.js';

describe('Milestone 6 (R2): Challenger 1 Empirical Concurrency & Stress Suite', () => {
  const physicalDbPath = path.join(process.cwd(), 'data', 'papers.db');
  let initialMtime = 0;
  let initialSize = 0;

  const colTestA = 'col-challenger1-a';
  const colTestB = 'col-challenger1-b';

  before(() => {
    if (fs.existsSync(physicalDbPath)) {
      const stats = fs.statSync(physicalDbPath);
      initialMtime = stats.mtimeMs;
      initialSize = stats.size;
    }

    const db = getDb();
    // Inhibit background backup
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
      'last_db_backup_time',
      Date.now().toString()
    );

    // Create test collections
    db.prepare('INSERT OR IGNORE INTO collections (id, name) VALUES (?, ?)').run(colTestA, 'Challenger Collection A');
    db.prepare('INSERT OR IGNORE INTO collections (id, name) VALUES (?, ?)').run(colTestB, 'Challenger Collection B');
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM citations WHERE collectionId IN (?, ?)').run(colTestA, colTestB);
    db.prepare('DELETE FROM papers WHERE collectionId IN (?, ?)').run(colTestA, colTestB);
  });

  after(() => {
    if (fs.existsSync(physicalDbPath)) {
      const stats = fs.statSync(physicalDbPath);
      assert.strictEqual(stats.mtimeMs, initialMtime, 'Physical DB mtime was modified!');
      assert.strictEqual(stats.size, initialSize, 'Physical DB size was modified!');
    }
  });

  describe('1. Concurrency Benchmark: 50 Simultaneous Requests for Exact Same Paper & Collection', () => {
    it('handles 50 simultaneous identical POST requests without any 500 errors or constraint crashes', async () => {
      const payload = {
        id: 'c1-paper-burst-50',
        collectionId: colTestA,
        title: 'Deep Residual Learning for Image Recognition',
        doi: '10.1109/CVPR.2016.90',
        abstract: 'Deeper neural networks are more difficult to train...',
        authors: [{ name: 'Kaiming He' }, { name: 'Xiangyu Zhang' }],
        year: 2016,
        venue: 'CVPR',
        status: 'seed'
      };

      const requests = Array.from({ length: 50 }, () => {
        const req = new Request('http://localhost:3000/api/collection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        return POST(req);
      });

      const responses = await Promise.all(requests);

      // Verify every response is HTTP 200 with success: true
      let insertedCount = 0;
      let alreadyInColCount = 0;

      for (const res of responses) {
        assert.strictEqual(res.status, 200, `Expected HTTP 200 but received ${res.status}`);
        const data = await res.json();
        assert.strictEqual(data.success, true);
        if (data.message === 'Paper added successfully') {
          insertedCount++;
        } else if (data.message === 'Paper already in collection') {
          alreadyInColCount++;
        } else {
          assert.fail(`Unexpected response message: ${data.message}`);
        }
      }

      // Exactly 1 request successfully inserted, other 49 safely reported already in collection
      assert.strictEqual(insertedCount, 1, 'Exactly one concurrent request should perform the insert');
      assert.strictEqual(alreadyInColCount, 49, 'Remaining 49 requests should report already in collection');

      // Verify database state: exactly 1 row
      const db = getDb();
      const count = (db.prepare('SELECT COUNT(*) as cnt FROM papers WHERE id = ? AND collectionId = ?')
        .get('c1-paper-burst-50', colTestA) as { cnt: number }).cnt;
      assert.strictEqual(count, 1, 'Only 1 row must exist in the papers table');

      const saved = PaperRepository.getPaper('c1-paper-burst-50', colTestA);
      assert.ok(saved);
      assert.strictEqual(saved.title, 'Deep Residual Learning for Image Recognition');
      assert.strictEqual(saved.status, 'seed');
    });
  });

  describe('2. Mixed Status Race Condition: 25 seed vs 25 recommended concurrent requests', () => {
    it('preserves status "seed" when 25 seed and 25 recommended requests race simultaneously on an empty collection', async () => {
      const basePayload = {
        id: 'c1-paper-mixed-50',
        collectionId: colTestA,
        title: 'Mastering the Game of Go with Deep Neural Networks and Tree Search',
        year: 2016,
        venue: 'Nature'
      };

      const seedRequests = Array.from({ length: 25 }, () =>
        new Request('http://localhost:3000/api/collection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...basePayload, status: 'seed' })
        })
      );

      const recRequests = Array.from({ length: 25 }, () =>
        new Request('http://localhost:3000/api/collection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...basePayload, status: 'recommended' })
        })
      );

      // Interleave seed and recommended requests
      const interleaved: Request[] = [];
      for (let i = 0; i < 25; i++) {
        interleaved.push(recRequests[i]);
        interleaved.push(seedRequests[i]);
      }

      const responses = await Promise.all(interleaved.map(req => POST(req)));

      for (const res of responses) {
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.success, true);
      }

      // Final status must be 'seed'
      const paper = PaperRepository.getPaper('c1-paper-mixed-50', colTestA);
      assert.ok(paper);
      assert.strictEqual(paper.status, 'seed', 'Seed status must take precedence over recommended under race conditions');

      const db = getDb();
      const count = (db.prepare('SELECT COUNT(*) as cnt FROM papers WHERE id = ? AND collectionId = ?')
        .get('c1-paper-mixed-50', colTestA) as { cnt: number }).cnt;
      assert.strictEqual(count, 1);
    });

    it('upgrades "recommended" to "seed" and resists demotion from subsequent "recommended" concurrent waves', async () => {
      // Step A: Insert initially as recommended
      PaperRepository.addPaper({
        id: 'c1-upgrade-demote-test',
        title: 'Generative Adversarial Nets',
        year: 2014
      }, colTestA, 'recommended');

      assert.strictEqual(PaperRepository.getPaper('c1-upgrade-demote-test', colTestA).status, 'recommended');

      // Step B: Fire 25 concurrent seed upgrade requests
      const upgradePromises = Array.from({ length: 25 }, () => {
        const req = new Request('http://localhost:3000/api/collection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: 'c1-upgrade-demote-test',
            collectionId: colTestA,
            title: 'Generative Adversarial Nets',
            status: 'seed'
          })
        });
        return POST(req);
      });

      const upResponses = await Promise.all(upgradePromises);
      for (const res of upResponses) {
        assert.strictEqual(res.status, 200);
      }
      assert.strictEqual(PaperRepository.getPaper('c1-upgrade-demote-test', colTestA).status, 'seed');

      // Step C: Fire 25 concurrent recommended requests trying to demote
      const demotePromises = Array.from({ length: 25 }, () => {
        const req = new Request('http://localhost:3000/api/collection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: 'c1-upgrade-demote-test',
            collectionId: colTestA,
            title: 'Generative Adversarial Nets',
            status: 'recommended'
          })
        });
        return POST(req);
      });

      const demResponses = await Promise.all(demotePromises);
      for (const res of demResponses) {
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.success, true);
        assert.strictEqual(data.message, 'Paper already in collection');
      }

      // Paper status must still be 'seed'
      assert.strictEqual(PaperRepository.getPaper('c1-upgrade-demote-test', colTestA).status, 'seed');
    });
  });

  describe('3. Graph Integrity & Citation Cascade Protection', () => {
    it('preserves foreign-keyed citation links and custom user tags/notes across concurrent re-insertions', async () => {
      const db = getDb();
      // Insert source and target papers
      db.prepare(`
        INSERT INTO papers (id, collectionId, title, status, localTags, notes)
        VALUES (?, ?, ?, 'seed', ?, ?)
      `).run('graph-root-p', colTestA, 'Graph Root Paper', JSON.stringify(['seminal', 'survey']), 'Core theoretical foundation');

      db.prepare(`
        INSERT INTO papers (id, collectionId, title, status, localTags, notes)
        VALUES (?, ?, ?, 'seed', '[]', '')
      `).run('graph-child-p', colTestA, 'Graph Child Paper');

      // Insert citation link
      CitationRepository.addLinks(colTestA, [{ source: 'graph-root-p', target: 'graph-child-p' }]);

      const initialLinks = CitationRepository.getLinksForCollection(colTestA);
      assert.strictEqual(initialLinks.length, 1);

      // Fire 30 concurrent POST requests attempting to re-insert graph-root-p without tags/notes
      const promises = Array.from({ length: 30 }, () => {
        const req = new Request('http://localhost:3000/api/collection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: 'graph-root-p',
            collectionId: colTestA,
            title: 'Graph Root Paper',
            status: 'seed'
          })
        });
        return POST(req);
      });

      const responses = await Promise.all(promises);
      for (const res of responses) {
        assert.strictEqual(res.status, 200);
      }

      // Verify citation link was NOT deleted by cascade
      const finalLinks = CitationRepository.getLinksForCollection(colTestA);
      assert.strictEqual(finalLinks.length, 1, 'Citation link must be intact');

      // Verify tags and notes were preserved
      const savedRoot = PaperRepository.getPaper('graph-root-p', colTestA);
      assert.deepStrictEqual(savedRoot.localTags, ['seminal', 'survey']);
      assert.strictEqual(savedRoot.notes, 'Core theoretical foundation');
    });
  });

  describe('4. Mixed Valid and Malformed Requests Under Concurrency', () => {
    it('properly returns 400 for malformed requests while concurrently processing valid requests without interference', async () => {
      const validPayload = {
        id: 'mixed-valid-p',
        collectionId: colTestA,
        title: 'Valid Paper Title',
        status: 'seed'
      };

      // 20 valid requests
      const validPromises = Array.from({ length: 20 }, () => {
        const req = new Request('http://localhost:3000/api/collection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(validPayload)
        });
        return POST(req);
      });

      // 10 missing id requests
      const missingIdPromises = Array.from({ length: 10 }, () => {
        const req = new Request('http://localhost:3000/api/collection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ collectionId: colTestA, title: 'No ID Paper' })
        });
        return POST(req);
      });

      // 10 missing collectionId requests
      const missingColPromises = Array.from({ length: 10 }, () => {
        const req = new Request('http://localhost:3000/api/collection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'no-col-paper', title: 'No Col Paper' })
        });
        return POST(req);
      });

      const [validRes, noIdRes, noColRes] = await Promise.all([
        Promise.all(validPromises),
        Promise.all(missingIdPromises),
        Promise.all(missingColPromises)
      ]);

      // All 20 valid requests must succeed (HTTP 200)
      for (const res of validRes) {
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.success, true);
      }

      // All 10 missing ID requests must return HTTP 400
      for (const res of noIdRes) {
        assert.strictEqual(res.status, 400);
        const data = await res.json();
        assert.strictEqual(data.error, 'Paper ID and collectionId are required');
      }

      // All 10 missing Collection ID requests must return HTTP 400
      for (const res of noColRes) {
        assert.strictEqual(res.status, 400);
        const data = await res.json();
        assert.strictEqual(data.error, 'Paper ID and collectionId are required');
      }

      // Exactly 1 row in DB for valid paper
      const paper = PaperRepository.getPaper('mixed-valid-p', colTestA);
      assert.ok(paper);
      assert.strictEqual(paper.status, 'seed');
    });
  });

  describe('5. Multi-Collection Isolation Under High Concurrency', () => {
    it('concurrently adds identical paper ID to separate collections (25 requests each) without cross-contamination', async () => {
      const payloadA = { id: 'shared-id-100', collectionId: colTestA, title: 'Shared Paper', status: 'seed' };
      const payloadB = { id: 'shared-id-100', collectionId: colTestB, title: 'Shared Paper', status: 'recommended' };

      const promisesA = Array.from({ length: 25 }, () => {
        const req = new Request('http://localhost:3000/api/collection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payloadA)
        });
        return POST(req);
      });

      const promisesB = Array.from({ length: 25 }, () => {
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

      const paperA = PaperRepository.getPaper('shared-id-100', colTestA);
      const paperB = PaperRepository.getPaper('shared-id-100', colTestB);

      assert.ok(paperA);
      assert.ok(paperB);
      assert.strictEqual(paperA.status, 'seed');
      assert.strictEqual(paperB.status, 'recommended');

      const db = getDb();
      const countA = (db.prepare('SELECT COUNT(*) as c FROM papers WHERE id = ? AND collectionId = ?').get('shared-id-100', colTestA) as { c: number }).c;
      const countB = (db.prepare('SELECT COUNT(*) as c FROM papers WHERE id = ? AND collectionId = ?').get('shared-id-100', colTestB) as { c: number }).c;
      assert.strictEqual(countA, 1);
      assert.strictEqual(countB, 1);
    });
  });
});
