import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Force in-memory DB and isolated temp directory before any imports
(process.env as Record<string, string | undefined>).NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = ':memory:';
process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'lit-review-graph-adv-concurrency-' + Date.now());

import { getDb } from '../../src/lib/db.js';
import { PaperRepository } from '../../src/domain/repositories/PaperRepository.js';
import { CitationRepository } from '../../src/domain/repositories/CitationRepository.js';
import { POST, GET } from '../../src/api/collection/route.js';

describe('Milestone 6 (R2): Adversarial Concurrency & Race Condition Challenge Suite', () => {
  const physicalDbPath = path.join(process.cwd(), 'data', 'papers.db');
  let initialMtime = 0;
  let initialSize = 0;

  const testCollections = ['adv-col-1', 'adv-col-2', 'adv-col-3', 'adv-col-4', 'adv-col-5'];

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
    for (const colId of testCollections) {
      db.prepare('INSERT OR IGNORE INTO collections (id, name) VALUES (?, ?)').run(colId, `Adversarial Collection ${colId}`);
    }
  });

  beforeEach(() => {
    const db = getDb();
    const placeholders = testCollections.map(() => '?').join(',');
    db.prepare(`DELETE FROM citations WHERE collectionId IN (${placeholders})`).run(...testCollections);
    db.prepare(`DELETE FROM papers WHERE collectionId IN (${placeholders})`).run(...testCollections);
  });

  after(() => {
    if (fs.existsSync(physicalDbPath)) {
      const stats = fs.statSync(physicalDbPath);
      assert.strictEqual(stats.mtimeMs, initialMtime, 'Physical DB mtime was modified!');
      assert.strictEqual(stats.size, initialSize, 'Physical DB size was modified!');
    }
  });

  describe('1. Extreme Concurrency Burst (50 Simultaneous Requests for Same Paper)', () => {
    it('survives 50 simultaneous identical POST requests: exactly 1 inserted, 49 unchanged, 0 500s', async () => {
      const payload = {
        id: 'adv-concurrent-50',
        collectionId: testCollections[0],
        title: 'Transformers for Fast Language Understanding',
        status: 'seed',
        doi: '10.1000/182',
        abstract: 'High throughput transformer architectures...',
        authors: [{ name: 'Researcher Alpha' }, { name: 'Researcher Beta' }],
        year: 2024,
        venue: 'ICLR'
      };

      const promises = Array.from({ length: 50 }, () => {
        const req = new Request('http://localhost:3000/api/collection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        return POST(req);
      });

      const responses = await Promise.all(promises);

      // Verify no 500 errors; all responses are 200 OK
      let insertedCount = 0;
      let alreadyInColCount = 0;

      for (const res of responses) {
        assert.strictEqual(res.status, 200, `Expected status 200, got ${res.status}`);
        const data = await res.json();
        assert.strictEqual(data.success, true);
        if (data.message === 'Paper added successfully') {
          insertedCount++;
        } else if (data.message === 'Paper already in collection') {
          alreadyInColCount++;
        } else {
          assert.fail(`Unexpected message returned: ${data.message}`);
        }
      }

      // Exactly 1 request successfully performed insertion, the other 49 safely detected existing row
      assert.strictEqual(insertedCount, 1, 'Exactly one concurrent request should perform insertion');
      assert.strictEqual(alreadyInColCount, 49, 'Remaining 49 concurrent requests should report already in collection');

      // Verify SQLite row count
      const db = getDb();
      const count = (db.prepare('SELECT COUNT(*) as count FROM papers WHERE id = ? AND collectionId = ?')
        .get('adv-concurrent-50', testCollections[0]) as { count: number }).count;
      assert.strictEqual(count, 1, 'Exactly 1 row must exist in the database');

      // Verify stored paper data
      const paper = PaperRepository.getPaper('adv-concurrent-50', testCollections[0]);
      assert.ok(paper);
      assert.strictEqual(paper.id, 'adv-concurrent-50');
      assert.strictEqual(paper.status, 'seed');
      assert.strictEqual(paper.title, 'Transformers for Fast Language Understanding');
      assert.strictEqual(paper.authors.length, 2);
    });
  });

  describe('2. Mixed Status Race Conditions (50 Concurrent Requests: 25 seed vs 25 recommended)', () => {
    it('maintains status "seed" when 25 seed and 25 recommended requests arrive simultaneously on empty collection', async () => {
      const basePayload = {
        id: 'adv-mixed-50',
        collectionId: testCollections[0],
        title: 'Diffusion Models for Scientific Discovery',
        year: 2023,
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

      // Interleave requests to maximize race potential
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

      // Crucial: The final status in DB MUST be 'seed' because seed requests were part of the mix
      const paper = PaperRepository.getPaper('adv-mixed-50', testCollections[0]);
      assert.ok(paper);
      assert.strictEqual(paper.status, 'seed', 'Status must be upgraded to or kept at "seed", never "recommended"');

      const db = getDb();
      const count = (db.prepare('SELECT COUNT(*) as count FROM papers WHERE id = ? AND collectionId = ?')
        .get('adv-mixed-50', testCollections[0]) as { count: number }).count;
      assert.strictEqual(count, 1, 'Only one database row must exist');
    });

    it('upgrades pre-existing "recommended" paper to "seed" under 50 concurrent requests (25 seed, 25 rec)', async () => {
      // Pre-seed paper as recommended
      PaperRepository.addPaper({
        id: 'adv-upgrade-50',
        title: 'Pre-existing Recommended Paper',
        year: 2021
      }, testCollections[0], 'recommended');

      const initialPaper = PaperRepository.getPaper('adv-upgrade-50', testCollections[0]);
      assert.strictEqual(initialPaper.status, 'recommended');

      const promises = Array.from({ length: 50 }, (_, i) => {
        const status = i % 2 === 0 ? 'seed' : 'recommended';
        const req = new Request('http://localhost:3000/api/collection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: 'adv-upgrade-50',
            collectionId: testCollections[0],
            title: 'Pre-existing Recommended Paper',
            status
          })
        });
        return POST(req);
      });

      const responses = await Promise.all(promises);
      for (const res of responses) {
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.success, true);
      }

      const finalPaper = PaperRepository.getPaper('adv-upgrade-50', testCollections[0]);
      assert.strictEqual(finalPaper.status, 'seed', 'Must be upgraded to seed');
    });

    it('protects pre-existing "seed" and "collection" papers from demotion by 50 concurrent "recommended" requests', async () => {
      // Pre-seed papers
      PaperRepository.addPaper({ id: 'curated-seed', title: 'Curated Seed' }, testCollections[0], 'seed');
      
      const db = getDb();
      db.prepare(`INSERT INTO papers (id, collectionId, title, status, localTags, notes) VALUES (?, ?, ?, 'collection', '[]', '')`)
        .run('curated-col', testCollections[0], 'Curated Collection Paper');

      // 25 concurrent recommended requests targeting seed
      const seedTargetPromises = Array.from({ length: 25 }, () => {
        const req = new Request('http://localhost:3000/api/collection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: 'curated-seed',
            collectionId: testCollections[0],
            title: 'Curated Seed',
            status: 'recommended'
          })
        });
        return POST(req);
      });

      // 25 concurrent recommended requests targeting collection
      const colTargetPromises = Array.from({ length: 25 }, () => {
        const req = new Request('http://localhost:3000/api/collection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: 'curated-col',
            collectionId: testCollections[0],
            title: 'Curated Collection Paper',
            status: 'recommended'
          })
        });
        return POST(req);
      });

      const responses = await Promise.all([...seedTargetPromises, ...colTargetPromises]);
      for (const res of responses) {
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.success, true);
        assert.strictEqual(data.message, 'Paper already in collection');
      }

      // Assert neither was demoted
      assert.strictEqual(PaperRepository.getPaper('curated-seed', testCollections[0]).status, 'seed');
      assert.strictEqual(PaperRepository.getPaper('curated-col', testCollections[0]).status, 'collection');
    });
  });

  describe('3. Massive Burst Stress (100 Simultaneous Requests)', () => {
    it('handles 100 simultaneous requests without any SQLITE_BUSY or 500 errors', async () => {
      const payload = {
        id: 'adv-burst-100',
        collectionId: testCollections[0],
        title: 'Massive Burst Paper',
        status: 'seed',
        year: 2025
      };

      const promises = Array.from({ length: 100 }, () => {
        const req = new Request('http://localhost:3000/api/collection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        return POST(req);
      });

      const responses = await Promise.all(promises);
      for (const res of responses) {
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.success, true);
      }

      const db = getDb();
      const count = (db.prepare('SELECT COUNT(*) as count FROM papers WHERE id = ? AND collectionId = ?')
        .get('adv-burst-100', testCollections[0]) as { count: number }).count;
      assert.strictEqual(count, 1);
    });
  });

  describe('4. Citation Graph & Metadata Integrity Under Concurrent Re-inserts', () => {
    it('strictly preserves 20 citation links and custom tags/notes under 40 concurrent POST requests', async () => {
      const db = getDb();
      // Insert anchor paper with tags and notes
      db.prepare(`
        INSERT INTO papers (id, collectionId, title, status, localTags, notes)
        VALUES (?, ?, ?, 'seed', ?, ?)
      `).run('anchor-p', testCollections[0], 'Anchor Paper', JSON.stringify(['core-topic', 'must-read']), 'Detailed manual annotation');

      // Insert 20 connected papers
      const targetPapers = Array.from({ length: 20 }, (_, i) => ({
        id: `target-p-${i}`,
        title: `Target Paper ${i}`
      }));
      PaperRepository.addPapers(targetPapers, testCollections[0], 'recommended');

      // Add 20 citation edges
      const edges = targetPapers.map(t => ({ source: 'anchor-p', target: t.id }));
      CitationRepository.addLinks(testCollections[0], edges);

      const linksBefore = CitationRepository.getLinksForCollection(testCollections[0]);
      assert.strictEqual(linksBefore.length, 20);

      // Fire 40 concurrent POST requests for anchor-p with empty tags/notes to test overwriting/cascade
      const promises = Array.from({ length: 40 }, () => {
        const req = new Request('http://localhost:3000/api/collection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: 'anchor-p',
            collectionId: testCollections[0],
            title: 'Anchor Paper',
            status: 'seed'
          })
        });
        return POST(req);
      });

      const responses = await Promise.all(promises);
      for (const res of responses) {
        assert.strictEqual(res.status, 200);
      }

      // Verify all 20 citations survived
      const linksAfter = CitationRepository.getLinksForCollection(testCollections[0]);
      assert.strictEqual(linksAfter.length, 20, 'Zero citation edges should be lost');

      // Verify tags and notes were preserved
      const anchor = PaperRepository.getPaper('anchor-p', testCollections[0]);
      assert.deepStrictEqual(anchor.localTags, ['core-topic', 'must-read']);
      assert.strictEqual(anchor.notes, 'Detailed manual annotation');
    });
  });

  describe('5. Mixed Read/Write/Update Operations Under High Concurrency', () => {
    it('executes 20 full inserts, 20 status updates without title, and 20 GET requests simultaneously', async () => {
      // Pre-insert paper for the title-less updates
      PaperRepository.addPaper({ id: 'rw-paper', title: 'Read-Write Target' }, testCollections[0], 'recommended');

      // 20 full inserts/upserts
      const fullInsertPromises = Array.from({ length: 20 }, () => {
        const req = new Request('http://localhost:3000/api/collection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: 'rw-paper',
            collectionId: testCollections[0],
            title: 'Read-Write Target',
            status: 'seed'
          })
        });
        return POST(req);
      });

      // 20 status updates without title
      const statusUpdatePromises = Array.from({ length: 20 }, () => {
        const req = new Request('http://localhost:3000/api/collection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: 'rw-paper',
            collectionId: testCollections[0],
            status: 'seed'
          })
        });
        return POST(req);
      });

      // 20 GET requests
      const getPromises = Array.from({ length: 20 }, () => {
        const req = new Request(`http://localhost:3000/api/collection?collectionId=${testCollections[0]}`);
        return GET(req);
      });

      const allResults = await Promise.all([...fullInsertPromises, ...statusUpdatePromises, ...getPromises]);

      for (const res of allResults) {
        assert.strictEqual(res.status, 200);
      }

      const paper = PaperRepository.getPaper('rw-paper', testCollections[0]);
      assert.strictEqual(paper.status, 'seed');
    });
  });

  describe('6. Multi-Collection Cross-Isolation Burst', () => {
    it('simultaneously adds the same paper ID across 5 distinct collections (10 requests each = 50 total)', async () => {
      const promises: Promise<Response>[] = [];

      for (let i = 0; i < testCollections.length; i++) {
        const colId = testCollections[i];
        const status = i % 2 === 0 ? 'seed' : 'recommended';
        for (let r = 0; r < 10; r++) {
          const req = new Request('http://localhost:3000/api/collection', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: 'universal-paper-42',
              collectionId: colId,
              title: 'Universal Paper across Collections',
              status
            })
          });
          promises.push(POST(req));
        }
      }

      const responses = await Promise.all(promises);
      for (const res of responses) {
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.success, true);
      }

      // Verify each collection has exactly 1 row with its respective status
      const db = getDb();
      for (let i = 0; i < testCollections.length; i++) {
        const colId = testCollections[i];
        const expectedStatus = i % 2 === 0 ? 'seed' : 'recommended';
        const count = (db.prepare('SELECT COUNT(*) as c FROM papers WHERE id = ? AND collectionId = ?')
          .get('universal-paper-42', colId) as { c: number }).c;
        assert.strictEqual(count, 1, `Collection ${colId} should have exactly 1 row`);

        const paper = PaperRepository.getPaper('universal-paper-42', colId);
        assert.strictEqual(paper.status, expectedStatus);
      }
    });
  });

  describe('7. High Concurrency with 50 Distinct Unique Papers', () => {
    it('simultaneously inserts 50 distinct papers into the same collection without dropping any', async () => {
      const promises = Array.from({ length: 50 }, (_, i) => {
        const req = new Request('http://localhost:3000/api/collection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: `distinct-paper-${i}`,
            collectionId: testCollections[0],
            title: `Distinct Paper ${i}`,
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
        assert.strictEqual(data.message, 'Paper added successfully');
      }

      const db = getDb();
      const count = (db.prepare('SELECT COUNT(*) as c FROM papers WHERE collectionId = ?')
        .get(testCollections[0]) as { c: number }).c;
      assert.strictEqual(count, 50, 'All 50 distinct papers must be persisted');
    });
  });

  describe('8. Adversarial Payload Handling Under Concurrency', () => {
    it('handles special characters, unicode, and stringified JSON authors safely without SQLite syntax errors', async () => {
      const payloads = [
        {
          id: "special-sql-inject'; DROP TABLE papers; --",
          collectionId: testCollections[0],
          title: "SQL Injection Test: ' OR 1=1 --",
          status: 'seed',
          abstract: 'Testing SQL injection resilience',
          authors: '["Author One", "Author Two"]' // stringified JSON
        },
        {
          id: 'special-unicode-🚀-🧠',
          collectionId: testCollections[0],
          title: 'Unicode & Emoji Title: 🔬 Quantum Computing 🌌',
          status: 'seed',
          authors: [{ name: 'Dr. Schrödinger 🐈' }]
        },
        {
          id: 'special-large-payload',
          collectionId: testCollections[0],
          title: 'Large Abstract Paper',
          status: 'seed',
          abstract: 'A'.repeat(10000), // 10KB abstract
          authors: Array.from({ length: 20 }, (_, i) => ({ name: `Author ${i}` }))
        }
      ];

      // Send 10 concurrent requests for each adversarial payload (30 total)
      const promises: Promise<Response>[] = [];
      for (const p of payloads) {
        for (let i = 0; i < 10; i++) {
          const req = new Request('http://localhost:3000/api/collection', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(p)
          });
          promises.push(POST(req));
        }
      }

      const responses = await Promise.all(promises);
      for (const res of responses) {
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.success, true);
      }

      // Verify that database was not corrupted or dropped
      const db = getDb();
      const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='papers'").get();
      assert.ok(tableCheck, 'Papers table must exist intact');

      const p1 = PaperRepository.getPaper("special-sql-inject'; DROP TABLE papers; --", testCollections[0]);
      assert.ok(p1);
      assert.strictEqual(p1.title, "SQL Injection Test: ' OR 1=1 --");

      const p2 = PaperRepository.getPaper('special-unicode-🚀-🧠', testCollections[0]);
      assert.ok(p2);
      assert.strictEqual(p2.title, 'Unicode & Emoji Title: 🔬 Quantum Computing 🌌');

      const p3 = PaperRepository.getPaper('special-large-payload', testCollections[0]);
      assert.ok(p3);
      assert.strictEqual(p3.abstract.length, 10000);
    });
  });

  describe('9. Defensive Error Catching Simulation', () => {
    it('returns HTTP 200 for simulated PRIMARY KEY or UNIQUE constraint collisions', async () => {
      const originalUpsert = PaperRepository.upsertPaper;
      try {
        const errorCodes = [
          'SQLITE_CONSTRAINT_PRIMARYKEY',
          'SQLITE_CONSTRAINT_UNIQUE',
          'SQLITE_CONSTRAINT'
        ];

        for (const code of errorCodes) {
          PaperRepository.upsertPaper = () => {
            const err = new Error(`Simulated ${code}`) as Error & { code?: string };
            err.code = code;
            throw err;
          };

          const req = new Request('http://localhost:3000/api/collection', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: `sim-${code}`,
              collectionId: testCollections[0],
              title: `Simulated ${code}`,
              status: 'seed'
            })
          });

          const res = await POST(req);
          assert.strictEqual(res.status, 200, `Code ${code} must return 200`);
          const data = await res.json();
          assert.strictEqual(data.success, true);
          assert.strictEqual(data.message, 'Paper already in collection');
        }

        // Test regex fallback message
        PaperRepository.upsertPaper = () => {
          throw new Error('UNIQUE constraint failed: papers.id, papers.collectionId');
        };

        const reqRegex = new Request('http://localhost:3000/api/collection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: 'sim-regex',
            collectionId: testCollections[0],
            title: 'Simulated regex failure',
            status: 'seed'
          })
        });

        const resRegex = await POST(reqRegex);
        assert.strictEqual(resRegex.status, 200);
        const dataRegex = await resRegex.json();
        assert.strictEqual(dataRegex.success, true);
        assert.strictEqual(dataRegex.message, 'Paper already in collection');
      } finally {
        PaperRepository.upsertPaper = originalUpsert;
      }
    });

    it('returns HTTP 500 when genuine, non-constraint database errors occur', async () => {
      const originalUpsert = PaperRepository.upsertPaper;
      try {
        PaperRepository.upsertPaper = () => {
          throw new Error('SQLITE_CORRUPT: database disk image is malformed');
        };

        const req = new Request('http://localhost:3000/api/collection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: 'corrupt-test',
            collectionId: testCollections[0],
            title: 'Corrupt Test',
            status: 'seed'
          })
        });

        const res = await POST(req);
        assert.strictEqual(res.status, 500, 'Non-constraint error must return 500');
        const data = await res.json();
        assert.strictEqual(data.error, 'SQLITE_CORRUPT: database disk image is malformed');
      } finally {
        PaperRepository.upsertPaper = originalUpsert;
      }
    });
  });
});
