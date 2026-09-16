import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Guarantee in-memory DB and isolated temp directory before any imports
(process.env as any).NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = ':memory:';
process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'lit-review-graph-challenger2-' + Date.now());

import { getDb } from '../../src/lib/db.js';
import { PaperRepository } from '../../src/domain/repositories/PaperRepository.js';
import { CitationRepository } from '../../src/domain/repositories/CitationRepository.js';
import { CacheRepository } from '../../src/domain/repositories/CacheRepository.js';
import { HttpClient } from '../../src/domain/adapters/HttpClient.js';
import { POST } from '../../src/api/collection/[id]/rebuild-edges/route.js';

describe('Milestone 5 (R1): Challenger 2 Adversarial Verification Suite', () => {
  const physicalDbPath = path.join(process.cwd(), 'data', 'papers.db');
  const physicalWalPath = path.join(process.cwd(), 'data', 'papers.db-wal');
  let initialDbMtime = 0;
  let initialDbSize = 0;
  let initialWalMtime = 0;
  let initialWalSize = 0;

  const colTest = 'col-challenger2-test';
  const colTest2 = 'col-challenger2-test-2';
  let originalFetch: typeof globalThis.fetch;

  before(() => {
    // Record physical database stats
    if (fs.existsSync(physicalDbPath)) {
      const stats = fs.statSync(physicalDbPath);
      initialDbMtime = stats.mtimeMs;
      initialDbSize = stats.size;
    }
    if (fs.existsSync(physicalWalPath)) {
      const stats = fs.statSync(physicalWalPath);
      initialWalMtime = stats.mtimeMs;
      initialWalSize = stats.size;
    }

    const db = getDb();
    // Inhibit background backup from touching disk during tests
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
      'last_db_backup_time',
      Date.now().toString()
    );

    // Create test collections
    db.prepare('INSERT OR IGNORE INTO collections (id, name) VALUES (?, ?)').run(colTest, 'Challenger 2 Collection');
    db.prepare('INSERT OR IGNORE INTO collections (id, name) VALUES (?, ?)').run(colTest2, 'Challenger 2 Secondary Collection');

    originalFetch = globalThis.fetch;
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM citations WHERE collectionId IN (?, ?)').run(colTest, colTest2);
    db.prepare('DELETE FROM papers WHERE collectionId IN (?, ?)').run(colTest, colTest2);
    db.prepare('DELETE FROM api_cache').run();
    db.prepare('DELETE FROM s2_api_log').run();
    db.prepare("DELETE FROM settings WHERE key = 'cacheFreshnessReferences'").run();
  });

  after(() => {
    globalThis.fetch = originalFetch;
    // Strict physical DB integrity verification
    if (fs.existsSync(physicalDbPath)) {
      const stats = fs.statSync(physicalDbPath);
      assert.strictEqual(stats.mtimeMs, initialDbMtime, 'Physical DB file mtime was altered during tests!');
      assert.strictEqual(stats.size, initialDbSize, 'Physical DB file size was altered during tests!');
    }
    if (fs.existsSync(physicalWalPath)) {
      const stats = fs.statSync(physicalWalPath);
      assert.strictEqual(stats.mtimeMs, initialWalMtime, 'Physical WAL file mtime was altered during tests!');
      assert.strictEqual(stats.size, initialWalSize, 'Physical WAL file size was altered during tests!');
    }
  });

  describe('1. Edge Reconstruction: Circular Citations, Self-Citations, and Missing References', () => {
    it('correctly reconstructs 2-node circular citations without infinite loops (S2)', async () => {
      // Paper A cites Paper B, and Paper B cites Paper A
      PaperRepository.addPaper({ id: 's2:circ-a', title: 'Circular Paper A' }, colTest, 'seed');
      PaperRepository.addPaper({ id: 's2:circ-b', title: 'Circular Paper B' }, colTest, 'seed');

      globalThis.fetch = async (url: any) => {
        return new Response(
          JSON.stringify([
            { paperId: 'circ-a', references: [{ paperId: 'circ-b' }] },
            { paperId: 'circ-b', references: [{ paperId: 'circ-a' }] }
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };

      const req = new Request(`http://localhost:3000/api/collection/${colTest}/rebuild-edges`, { method: 'POST' });
      const res = await POST(req, { params: Promise.resolve({ id: colTest }) });

      assert.strictEqual(res.status, 200);
      const json = await res.json();
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.addedEdges, 2, 'Must reconstruct both directional edges in 2-node cycle');

      const links = CitationRepository.getLinksForCollection(colTest);
      assert.strictEqual(links.length, 2);
      assert.ok(links.some(l => l.source === 's2:circ-a' && l.target === 's2:circ-b'));
      assert.ok(links.some(l => l.source === 's2:circ-b' && l.target === 's2:circ-a'));
    });

    it('correctly reconstructs 3-node circular citations (OpenAlex: A -> B -> C -> A)', async () => {
      PaperRepository.addPaper({ id: 'W-cyc-1', title: 'Cycle Paper 1' }, colTest, 'seed');
      PaperRepository.addPaper({ id: 'W-cyc-2', title: 'Cycle Paper 2' }, colTest, 'seed');
      PaperRepository.addPaper({ id: 'W-cyc-3', title: 'Cycle Paper 3' }, colTest, 'seed');

      globalThis.fetch = async (url: any) => {
        return new Response(
          JSON.stringify({
            results: [
              { id: 'https://openalex.org/W-cyc-1', referenced_works: ['https://openalex.org/W-cyc-2'] },
              { id: 'https://openalex.org/W-cyc-2', referenced_works: ['https://openalex.org/W-cyc-3'] },
              { id: 'https://openalex.org/W-cyc-3', referenced_works: ['https://openalex.org/W-cyc-1'] }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };

      const req = new Request(`http://localhost:3000/api/collection/${colTest}/rebuild-edges`, { method: 'POST' });
      const res = await POST(req, { params: Promise.resolve({ id: colTest }) });

      assert.strictEqual(res.status, 200);
      const json = await res.json();
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.addedEdges, 3, 'Must reconstruct all 3 edges in a 3-cycle');

      const links = CitationRepository.getLinksForCollection(colTest);
      assert.strictEqual(links.length, 3);
      assert.ok(links.some(l => l.source === 'W-cyc-1' && l.target === 'W-cyc-2'));
      assert.ok(links.some(l => l.source === 'W-cyc-2' && l.target === 'W-cyc-3'));
      assert.ok(links.some(l => l.source === 'W-cyc-3' && l.target === 'W-cyc-1'));
    });

    it('handles self-citations (paper cites itself) safely and idempotently (S2 and OpenAlex)', async () => {
      PaperRepository.addPaper({ id: 's2:self-cite', title: 'Self Cite S2' }, colTest, 'seed');
      PaperRepository.addPaper({ id: 'W-self-cite', title: 'Self Cite OA' }, colTest, 'seed');

      globalThis.fetch = async (url: any) => {
        const urlStr = String(url);
        if (urlStr.includes('/paper/batch')) {
          return new Response(
            JSON.stringify([
              { paperId: 'self-cite', references: [{ paperId: 'self-cite' }] }
            ]),
            { status: 200 }
          );
        }
        if (urlStr.includes('openalex.org/works')) {
          return new Response(
            JSON.stringify({
              results: [
                { id: 'https://openalex.org/W-self-cite', referenced_works: ['https://openalex.org/W-self-cite'] }
              ]
            }),
            { status: 200 }
          );
        }
        return new Response('[]', { status: 200 });
      };

      // First run: Adds 2 self-citation edges
      const req1 = new Request(`http://localhost:3000/api/collection/${colTest}/rebuild-edges`, { method: 'POST' });
      const res1 = await POST(req1, { params: Promise.resolve({ id: colTest }) });
      assert.strictEqual(res1.status, 200);
      const json1 = await res1.json();
      assert.strictEqual(json1.addedEdges, 2);

      const links1 = CitationRepository.getLinksForCollection(colTest);
      assert.strictEqual(links1.length, 2);
      assert.ok(links1.some(l => l.source === 's2:self-cite' && l.target === 's2:self-cite'));
      assert.ok(links1.some(l => l.source === 'W-self-cite' && l.target === 'W-self-cite'));

      // Second run: Idempotent execution must not violate SQLite primary key constraints
      const req2 = new Request(`http://localhost:3000/api/collection/${colTest}/rebuild-edges`, { method: 'POST' });
      const res2 = await POST(req2, { params: Promise.resolve({ id: colTest }) });
      assert.strictEqual(res2.status, 200);
      const links2 = CitationRepository.getLinksForCollection(colTest);
      assert.strictEqual(links2.length, 2, 'Database must retain exactly 2 self-citation edges without duplicate crash');
    });

    it('handles papers with missing, null, or empty references without error', async () => {
      // Paper 1: references is null
      PaperRepository.addPaper({ id: 's2:null-refs', title: 'Null References' }, colTest, 'seed');
      // Paper 2: references is empty array
      PaperRepository.addPaper({ id: 's2:empty-refs', title: 'Empty References' }, colTest, 'seed');
      // Paper 3: references omitted completely
      PaperRepository.addPaper({ id: 's2:no-refs-field', title: 'No References Field' }, colTest, 'seed');
      // Paper 4: references only point to papers outside the collection
      PaperRepository.addPaper({ id: 's2:external-refs', title: 'External Only' }, colTest, 'seed');

      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify([
            { paperId: 'null-refs', references: null },
            { paperId: 'empty-refs', references: [] },
            { paperId: 'no-refs-field' },
            { paperId: 'external-refs', references: [{ paperId: 'completely-unrelated-paper-id' }] }
          ]),
          { status: 200 }
        );
      };

      const req = new Request(`http://localhost:3000/api/collection/${colTest}/rebuild-edges`, { method: 'POST' });
      const res = await POST(req, { params: Promise.resolve({ id: colTest }) });

      assert.strictEqual(res.status, 200);
      const json = await res.json();
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.addedEdges, 0, 'No edges should be added when all references are missing or external');

      const links = CitationRepository.getLinksForCollection(colTest);
      assert.strictEqual(links.length, 0);
    });

    it('filters out references with blank or null paperId and preserves valid references in the same paper', async () => {
      PaperRepository.addPaper({ id: 's2:mixed-refs-source', title: 'Mixed Source' }, colTest, 'seed');
      PaperRepository.addPaper({ id: 's2:mixed-refs-target', title: 'Mixed Target' }, colTest, 'seed');

      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify([
            {
              paperId: 'mixed-refs-source',
              references: [
                { paperId: '' }, // empty string
                { paperId: null }, // null paperId
                {}, // no paperId field
                { paperId: 'mixed-refs-target' } // valid target in collection
              ]
            }
          ]),
          { status: 200 }
        );
      };

      const req = new Request(`http://localhost:3000/api/collection/${colTest}/rebuild-edges`, { method: 'POST' });
      const res = await POST(req, { params: Promise.resolve({ id: colTest }) });

      assert.strictEqual(res.status, 200);
      const json = await res.json();
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.addedEdges, 1);

      const links = CitationRepository.getLinksForCollection(colTest);
      assert.strictEqual(links.length, 1);
      assert.strictEqual(links[0].source, 's2:mixed-refs-source');
      assert.strictEqual(links[0].target, 's2:mixed-refs-target');
    });
  });

  describe('2. Cache Expiration Behavior: Stale vs Fresh Cache', () => {
    it('serves from cache when cache entry is fresh (within cacheFreshnessDays TTL)', async () => {
      const testUrl = 'https://example.com/api/fresh-cache-test';
      let networkCalls = 0;
      globalThis.fetch = async () => {
        networkCalls++;
        return new Response(JSON.stringify({ value: 'network-fresh' }), { status: 200 });
      };

      // Populate cache with an entry from 1 hour ago
      const db = getDb();
      db.prepare(`
        INSERT INTO api_cache (key, data, timestamp)
        VALUES (?, ?, datetime('now', '-1 hour'))
      `).run(testUrl, JSON.stringify({ value: 'cached-fresh-value' }));

      // Fetch with cacheFreshnessDays = 30 (entry is 1 hour old < 30 days -> fresh)
      let reportedCached: boolean | null = null;
      const res = await HttpClient.fetchWithBackoff(
        testUrl,
        {},
        30,
        2,
        (cached) => { reportedCached = cached; }
      );

      assert.ok(res);
      assert.strictEqual(res.ok, true);
      assert.strictEqual(reportedCached, true, 'Must report cached = true');
      assert.strictEqual(networkCalls, 0, 'Fresh cache must not trigger network fetch');
      const data = await res.json();
      assert.strictEqual(data.value, 'cached-fresh-value');
    });

    it('bypasses cache and refetches from network when cache entry is stale (exceeds TTL)', async () => {
      const testUrl = 'https://example.com/api/stale-cache-test';
      let networkCalls = 0;
      globalThis.fetch = async () => {
        networkCalls++;
        return new Response(JSON.stringify({ value: 'refetched-fresh-data' }), { status: 200 });
      };

      // Seed a stale cache entry from 35 days ago (TTL is 30 days)
      const db = getDb();
      db.prepare(`
        INSERT INTO api_cache (key, data, timestamp)
        VALUES (?, ?, datetime('now', '-35 days'))
      `).run(testUrl, JSON.stringify({ value: 'old-stale-value' }));

      let reportedCached: boolean | null = null;
      const res = await HttpClient.fetchWithBackoff(
        testUrl,
        {},
        30, // 30 days TTL
        2,
        (cached) => { reportedCached = cached; }
      );

      assert.ok(res);
      assert.strictEqual(res.ok, true);
      assert.strictEqual(reportedCached, false, 'Stale cache must report cached = false');
      assert.strictEqual(networkCalls, 1, 'Stale cache must trigger network fetch');
      const data = await res.json();
      assert.strictEqual(data.value, 'refetched-fresh-data');

      // Verify that api_cache was updated with new data and a fresh timestamp
      const updatedRow = db.prepare('SELECT data, timestamp FROM api_cache WHERE key = ?').get(testUrl) as any;
      assert.ok(updatedRow);
      assert.strictEqual(JSON.parse(updatedRow.data).value, 'refetched-fresh-data');
      
      // Subsequent call should now hit the newly refreshed cache
      networkCalls = 0;
      const res2 = await HttpClient.fetchWithBackoff(testUrl, {}, 30, 2);
      assert.strictEqual(networkCalls, 0, 'Subsequent call must hit refreshed cache');
    });

    it('respects cacheFreshnessReferences setting from EnvConfig in rebuild-edges route (stale at >7 days vs fresh at <7 days)', async () => {
      PaperRepository.addPaper({ id: 's2:ttl-src', title: 'TTL Source' }, colTest, 'seed');
      PaperRepository.addPaper({ id: 's2:ttl-tgt', title: 'TTL Target' }, colTest, 'seed');

      const endpoint = 'https://api.semanticscholar.org/graph/v1/paper/batch?fields=paperId,references.paperId';
      const body = JSON.stringify({ ids: ['ttl-src', 'ttl-tgt'] });
      const cacheKey = `${endpoint}#${body}`;

      // Insert an 8-day-old cache entry (older than 7-day configured TTL in .env.local -> stale)
      const db = getDb();
      db.prepare(`
        INSERT INTO api_cache (key, data, timestamp)
        VALUES (?, ?, datetime('now', '-8 days'))
      `).run(cacheKey, JSON.stringify([{ paperId: 'ttl-src', references: [] }]));

      let fetchCount = 0;
      globalThis.fetch = async () => {
        fetchCount++;
        return new Response(
          JSON.stringify([
            { paperId: 'ttl-src', references: [{ paperId: 'ttl-tgt' }] }
          ]),
          { status: 200 }
        );
      };

      const req = new Request(`http://localhost:3000/api/collection/${colTest}/rebuild-edges`, { method: 'POST' });
      const res = await POST(req, { params: Promise.resolve({ id: colTest }) });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(fetchCount, 1, 'Should refetch because 8-day-old cache exceeds configured 7-day TTL');
      
      const json = await res.json();
      assert.strictEqual(json.addedEdges, 1, 'New edge from fresh fetch must be recognized');

      // Now run again immediately: should hit the fresh cache (0 additional network fetches)
      fetchCount = 0;
      const req2 = new Request(`http://localhost:3000/api/collection/${colTest}/rebuild-edges`, { method: 'POST' });
      await POST(req2, { params: Promise.resolve({ id: colTest }) });
      assert.strictEqual(fetchCount, 0, 'Immediate re-run must hit fresh cache');
    });

    it('treats corrupted or unparseable timestamps as stale cache without crashing', async () => {
      const testUrl = 'https://example.com/api/corrupt-ts-test';
      let networkCalls = 0;
      globalThis.fetch = async () => {
        networkCalls++;
        return new Response(JSON.stringify({ recovered: true }), { status: 200 });
      };

      const db = getDb();
      db.prepare(`
        INSERT INTO api_cache (key, data, timestamp)
        VALUES (?, ?, 'NOT-A-VALID-DATE')
      `).run(testUrl, JSON.stringify({ old: true }));

      const res = await HttpClient.fetchWithBackoff(testUrl, {}, 30, 2);
      assert.ok(res);
      assert.strictEqual(res.ok, true);
      assert.strictEqual(networkCalls, 1, 'Corrupted timestamp must fall through to network fetch');
      const data = await res.json();
      assert.strictEqual(data.recovered, true);
    });

    it('immediately bypasses cache when cacheFreshnessDays is 0', async () => {
      const testUrl = 'https://example.com/api/zero-ttl-test';
      let networkCalls = 0;
      globalThis.fetch = async () => {
        networkCalls++;
        return new Response(JSON.stringify({ call: networkCalls }), { status: 200 });
      };

      // First call (cacheFreshnessDays = 0)
      const res1 = await HttpClient.fetchWithBackoff(testUrl, {}, 0, 2);
      const data1 = await res1.json();
      assert.strictEqual(data1.call, 1);
      assert.strictEqual(networkCalls, 1);

      // Second call (cacheFreshnessDays = 0) -> must not serve cache
      const res2 = await HttpClient.fetchWithBackoff(testUrl, {}, 0, 2);
      const data2 = await res2.json();
      assert.strictEqual(data2.call, 2);
      assert.strictEqual(networkCalls, 2, 'TTL=0 must never serve from cache');
    });
  });

  describe('3. Database Safety: Physical SQLite DB Integrity Verification', () => {
    it('confirms physical data/papers.db and WAL files are unaccessed and unmodified', () => {
      if (fs.existsSync(physicalDbPath)) {
        const stats = fs.statSync(physicalDbPath);
        assert.strictEqual(stats.mtimeMs, initialDbMtime, 'Physical data/papers.db mtime altered during test suite');
        assert.strictEqual(stats.size, initialDbSize, 'Physical data/papers.db size altered during test suite');
      }
      if (fs.existsSync(physicalWalPath)) {
        const stats = fs.statSync(physicalWalPath);
        assert.strictEqual(stats.mtimeMs, initialWalMtime, 'Physical WAL file mtime altered during test suite');
        assert.strictEqual(stats.size, initialWalSize, 'Physical WAL file size altered during test suite');
      }
    });
  });
});
