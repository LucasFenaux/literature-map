import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Force in-memory DB and isolated temp directory before any imports
(process.env as any).NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = ':memory:';
process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'lit-review-graph-rebuild-edges-' + Date.now());

import { getDb } from '../../src/lib/db.js';
import { PaperRepository } from '../../src/domain/repositories/PaperRepository.js';
import { CitationRepository } from '../../src/domain/repositories/CitationRepository.js';
import { CacheRepository } from '../../src/domain/repositories/CacheRepository.js';
import { HttpClient } from '../../src/domain/adapters/HttpClient.js';
import { POST } from '../../src/api/collection/[id]/rebuild-edges/route.js';

describe('Milestone 5 (R1): Rebuild Edges Route & HttpClient Integration Suite', () => {
  const physicalDbPath = path.join(process.cwd(), 'data', 'papers.db');
  let initialMtime = 0;
  let initialSize = 0;

  const colId = 'col-rebuild-edges-test';
  const colId2 = 'col-rebuild-edges-test-2';
  let originalFetch: typeof globalThis.fetch;

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
    db.prepare('INSERT OR IGNORE INTO collections (id, name) VALUES (?, ?)').run(colId, 'Rebuild Edges Main Collection');
    db.prepare('INSERT OR IGNORE INTO collections (id, name) VALUES (?, ?)').run(colId2, 'Rebuild Edges Second Collection');

    originalFetch = globalThis.fetch;
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM citations WHERE collectionId IN (?, ?)').run(colId, colId2);
    db.prepare('DELETE FROM papers WHERE collectionId IN (?, ?)').run(colId, colId2);
    db.prepare('DELETE FROM api_cache').run();
    db.prepare('DELETE FROM s2_api_log').run();
  });

  after(() => {
    globalThis.fetch = originalFetch;
    if (fs.existsSync(physicalDbPath)) {
      const stats = fs.statSync(physicalDbPath);
      assert.strictEqual(stats.mtimeMs, initialMtime, 'Physical DB mtime was modified!');
      assert.strictEqual(stats.size, initialSize, 'Physical DB size was modified!');
    }
  });

  describe('1. 429 Rate Limit Retry Backoff', () => {
    it('retries on 429 from Semantic Scholar (S2) and successfully recovers on second attempt', async () => {
      // Setup papers in collection
      PaperRepository.addPaper({ id: 's2:paper-source', title: 'Source Paper' }, colId, 'seed');
      PaperRepository.addPaper({ id: 's2:paper-target', title: 'Target Paper' }, colId, 'seed');

      let s2CallCount = 0;
      globalThis.fetch = async (url: any, init?: any) => {
        const urlStr = String(url);
        if (urlStr.includes('/paper/batch')) {
          s2CallCount++;
          if (s2CallCount === 1) {
            // First attempt: return 429 Too Many Requests
            return new Response('Too Many Requests', { status: 429 });
          }
          // Second attempt: return successful batch references
          return new Response(
            JSON.stringify([
              {
                paperId: 'paper-source',
                references: [{ paperId: 'paper-target' }, { paperId: 'paper-external' }]
              }
            ]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(JSON.stringify([]), { status: 200 });
      };

      const req = new Request(`http://localhost:3000/api/collection/${colId}/rebuild-edges`, {
        method: 'POST'
      });
      const res = await POST(req, { params: Promise.resolve({ id: colId }) });

      assert.strictEqual(res.status, 200);
      const json = await res.json();
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.addedEdges, 1);

      // Verify fetch was called exactly twice (1 rate limit failure + 1 successful retry)
      assert.strictEqual(s2CallCount, 2, 'Should have retried after receiving 429');

      // Verify edge was correctly inserted in the database
      const links = CitationRepository.getLinksForCollection(colId);
      assert.strictEqual(links.length, 1);
      assert.strictEqual(links[0].source, 's2:paper-source');
      assert.strictEqual(links[0].target, 's2:paper-target');
    });

    it('retries on 429 from OpenAlex and successfully recovers on second attempt', async () => {
      PaperRepository.addPaper({ id: 'W100', title: 'OpenAlex Source' }, colId, 'seed');
      PaperRepository.addPaper({ id: 'W200', title: 'OpenAlex Target' }, colId, 'seed');

      let oaCallCount = 0;
      globalThis.fetch = async (url: any) => {
        const urlStr = String(url);
        if (urlStr.includes('openalex.org/works')) {
          oaCallCount++;
          if (oaCallCount === 1) {
            return new Response('Rate limit reached', { status: 429 });
          }
          return new Response(
            JSON.stringify({
              results: [
                {
                  id: 'https://openalex.org/W100',
                  referenced_works: ['https://openalex.org/W200', 'https://openalex.org/W999']
                }
              ]
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      };

      const req = new Request(`http://localhost:3000/api/collection/${colId}/rebuild-edges`, {
        method: 'POST'
      });
      const res = await POST(req, { params: Promise.resolve({ id: colId }) });

      assert.strictEqual(res.status, 200);
      const json = await res.json();
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.addedEdges, 1);

      assert.strictEqual(oaCallCount, 2, 'OpenAlex fetch should have retried after 429');

      const links = CitationRepository.getLinksForCollection(colId);
      assert.strictEqual(links.length, 1);
      assert.strictEqual(links[0].source, 'W100');
      assert.strictEqual(links[0].target, 'W200');
    });

    it('exhausts retries gracefully when external service consistently returns 429', async () => {
      PaperRepository.addPaper({ id: 's2:p-exhaust', title: 'Exhaust Paper' }, colId, 'seed');

      let attempts = 0;
      globalThis.fetch = async () => {
        attempts++;
        return new Response('Rate limited forever', { status: 429 });
      };

      const req = new Request(`http://localhost:3000/api/collection/${colId}/rebuild-edges`, {
        method: 'POST'
      });
      const res = await POST(req, { params: Promise.resolve({ id: colId }) });

      // Route should catch the RATE_LIMIT error without crashing
      assert.strictEqual(res.status, 200);
      const json = await res.json();
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.addedEdges, 0);

      // Default retries is 4
      assert.strictEqual(attempts, 4, 'Should attempt 4 times before exhausting');
    });
  });

  describe('2. Caching & Cache-Hit Verification', () => {
    it('caches S2 batch results with body-aware key and avoids network call on second run', async () => {
      PaperRepository.addPaper({ id: 's2:cached-src', title: 'Cached Source' }, colId, 'seed');
      PaperRepository.addPaper({ id: 's2:cached-tgt', title: 'Cached Target' }, colId, 'seed');

      let networkCalls = 0;
      globalThis.fetch = async (url: any, init?: any) => {
        networkCalls++;
        return new Response(
          JSON.stringify([
            {
              paperId: 'cached-src',
              references: [{ paperId: 'cached-tgt' }]
            }
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };

      // Call 1: Fresh network request
      const req1 = new Request(`http://localhost:3000/api/collection/${colId}/rebuild-edges`, { method: 'POST' });
      const res1 = await POST(req1, { params: Promise.resolve({ id: colId }) });
      assert.strictEqual(res1.status, 200);
      const json1 = await res1.json();
      assert.strictEqual(json1.addedEdges, 1);
      assert.strictEqual(networkCalls, 1, 'First run should trigger 1 network call');

      // Verify cache entry exists in api_cache table with request body in cache key
      const db = getDb();
      const expectedKey = 'https://api.semanticscholar.org/graph/v1/paper/batch?fields=paperId,references.paperId#{"ids":["cached-src","cached-tgt"]}';
      const cacheRow = db.prepare('SELECT key, data FROM api_cache WHERE key = ?').get(expectedKey) as any;
      assert.ok(cacheRow, 'api_cache should have a record with the body in the key');

      // Verify s2_api_log logged cached = 0 for first run
      const logRowsFirst = db.prepare('SELECT endpoint, cached FROM s2_api_log ORDER BY id ASC').all() as any[];
      assert.strictEqual(logRowsFirst.length, 1);
      assert.strictEqual(logRowsFirst[0].cached, 0, 'First run should be logged with cached = 0');

      // Clear citations table to prove second run rebuilds edges solely from cache
      db.prepare('DELETE FROM citations WHERE collectionId = ?').run(colId);
      assert.strictEqual(CitationRepository.getLinksForCollection(colId).length, 0);

      // Call 2: Should hit cache, 0 new network calls
      const req2 = new Request(`http://localhost:3000/api/collection/${colId}/rebuild-edges`, { method: 'POST' });
      const res2 = await POST(req2, { params: Promise.resolve({ id: colId }) });
      assert.strictEqual(res2.status, 200);
      const json2 = await res2.json();
      assert.strictEqual(json2.addedEdges, 1);
      assert.strictEqual(networkCalls, 1, 'Second run must use cache and make ZERO additional network calls');

      // Verify edge was restored in DB from cache
      const linksAfterCache = CitationRepository.getLinksForCollection(colId);
      assert.strictEqual(linksAfterCache.length, 1);
      assert.strictEqual(linksAfterCache[0].source, 's2:cached-src');
      assert.strictEqual(linksAfterCache[0].target, 's2:cached-tgt');

      // Verify s2_api_log logged cached = 1 for second run
      const logRowsSecond = db.prepare('SELECT endpoint, cached FROM s2_api_log ORDER BY id ASC').all() as any[];
      assert.strictEqual(logRowsSecond.length, 2);
      assert.strictEqual(logRowsSecond[1].cached, 1, 'Second run should be logged with cached = 1');
    });

    it('caches OpenAlex results and avoids network call on second run', async () => {
      PaperRepository.addPaper({ id: 'W-cache-1', title: 'OpenAlex 1' }, colId, 'seed');
      PaperRepository.addPaper({ id: 'W-cache-2', title: 'OpenAlex 2' }, colId, 'seed');

      let oaNetworkCalls = 0;
      globalThis.fetch = async (url: any) => {
        oaNetworkCalls++;
        return new Response(
          JSON.stringify({
            results: [
              {
                id: 'https://openalex.org/W-cache-1',
                referenced_works: ['https://openalex.org/W-cache-2']
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };

      // Call 1: Network call
      const req1 = new Request(`http://localhost:3000/api/collection/${colId}/rebuild-edges`, { method: 'POST' });
      await POST(req1, { params: Promise.resolve({ id: colId }) });
      assert.strictEqual(oaNetworkCalls, 1);

      // Clear citations
      const db = getDb();
      db.prepare('DELETE FROM citations WHERE collectionId = ?').run(colId);

      // Call 2: Cache hit
      const req2 = new Request(`http://localhost:3000/api/collection/${colId}/rebuild-edges`, { method: 'POST' });
      const res2 = await POST(req2, { params: Promise.resolve({ id: colId }) });
      const json2 = await res2.json();

      assert.strictEqual(oaNetworkCalls, 1, 'Second run must use cache without network fetch');
      assert.strictEqual(json2.addedEdges, 1);
      const links = CitationRepository.getLinksForCollection(colId);
      assert.strictEqual(links.length, 1);
      assert.strictEqual(links[0].source, 'W-cache-1');
      assert.strictEqual(links[0].target, 'W-cache-2');
    });

    it('differentiates different POST request bodies in cache without collision', async () => {
      // Collection 1 with papers [pA, pB]
      PaperRepository.addPaper({ id: 's2:pA', title: 'Paper A' }, colId, 'seed');
      PaperRepository.addPaper({ id: 's2:pB', title: 'Paper B' }, colId, 'seed');

      // Collection 2 with papers [pC, pD]
      PaperRepository.addPaper({ id: 's2:pC', title: 'Paper C' }, colId2, 'seed');
      PaperRepository.addPaper({ id: 's2:pD', title: 'Paper D' }, colId2, 'seed');

      let fetchCount = 0;
      globalThis.fetch = async (url: any, init?: any) => {
        fetchCount++;
        const body = JSON.parse(init?.body || '{}');
        const ids = body.ids || [];
        if (ids.includes('pA')) {
          return new Response(JSON.stringify([{ paperId: 'pA', references: [{ paperId: 'pB' }] }]), { status: 200 });
        } else {
          return new Response(JSON.stringify([{ paperId: 'pC', references: [{ paperId: 'pD' }] }]), { status: 200 });
        }
      };

      // Run collection 1
      const req1 = new Request(`http://localhost:3000/api/collection/${colId}/rebuild-edges`, { method: 'POST' });
      await POST(req1, { params: Promise.resolve({ id: colId }) });
      assert.strictEqual(fetchCount, 1);

      // Run collection 2 (different body -> must NOT hit collection 1's cache)
      const req2 = new Request(`http://localhost:3000/api/collection/${colId2}/rebuild-edges`, { method: 'POST' });
      await POST(req2, { params: Promise.resolve({ id: colId2 }) });
      assert.strictEqual(fetchCount, 2, 'Different POST body must result in a new fetch call');

      // Verify both collections have their distinct links
      const links1 = CitationRepository.getLinksForCollection(colId);
      assert.strictEqual(links1.length, 1);
      assert.strictEqual(links1[0].source, 's2:pA');
      assert.strictEqual(links1[0].target, 's2:pB');

      const links2 = CitationRepository.getLinksForCollection(colId2);
      assert.strictEqual(links2.length, 1);
      assert.strictEqual(links2[0].source, 's2:pC');
      assert.strictEqual(links2[0].target, 's2:pD');
    });
  });

  describe('3. Edge Rebuilding & Filtering Correctness', () => {
    it('correctly handles mixed collections containing both S2 and OpenAlex papers', async () => {
      // S2 papers
      PaperRepository.addPaper({ id: 's2:s2-1', title: 'S2 Paper 1' }, colId, 'seed');
      PaperRepository.addPaper({ id: 's2:s2-2', title: 'S2 Paper 2' }, colId, 'seed');

      // OpenAlex papers
      PaperRepository.addPaper({ id: 'oa-1', title: 'OA Paper 1' }, colId, 'seed');
      PaperRepository.addPaper({ id: 'oa-2', title: 'OA Paper 2' }, colId, 'seed');

      globalThis.fetch = async (url: any, init?: any) => {
        const urlStr = String(url);
        if (urlStr.includes('/paper/batch')) {
          return new Response(
            JSON.stringify([
              { paperId: 's2-1', references: [{ paperId: 's2-2' }] }
            ]),
            { status: 200 }
          );
        }
        if (urlStr.includes('openalex.org/works')) {
          return new Response(
            JSON.stringify({
              results: [
                { id: 'https://openalex.org/oa-1', referenced_works: ['https://openalex.org/oa-2'] }
              ]
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify([]), { status: 200 });
      };

      const req = new Request(`http://localhost:3000/api/collection/${colId}/rebuild-edges`, { method: 'POST' });
      const res = await POST(req, { params: Promise.resolve({ id: colId }) });
      const json = await res.json();

      assert.strictEqual(json.success, true);
      assert.strictEqual(json.addedEdges, 2);

      const links = CitationRepository.getLinksForCollection(colId);
      assert.strictEqual(links.length, 2);
      assert.ok(links.some(l => l.source === 's2:s2-1' && l.target === 's2:s2-2'));
      assert.ok(links.some(l => l.source === 'oa-1' && l.target === 'oa-2'));
    });

    it('filters out references not belonging to the collection', async () => {
      PaperRepository.addPaper({ id: 's2:in-col-1', title: 'In Collection 1' }, colId, 'seed');
      PaperRepository.addPaper({ id: 's2:in-col-2', title: 'In Collection 2' }, colId, 'seed');

      globalThis.fetch = async (url: any) => {
        return new Response(
          JSON.stringify([
            {
              paperId: 'in-col-1',
              references: [
                { paperId: 'in-col-2' }, // In collection -> keep
                { paperId: 'external-not-in-col' } // Not in collection -> filter out
              ]
            }
          ]),
          { status: 200 }
        );
      };

      const req = new Request(`http://localhost:3000/api/collection/${colId}/rebuild-edges`, { method: 'POST' });
      const res = await POST(req, { params: Promise.resolve({ id: colId }) });
      const json = await res.json();

      assert.strictEqual(json.addedEdges, 1);
      const links = CitationRepository.getLinksForCollection(colId);
      assert.strictEqual(links.length, 1);
      assert.strictEqual(links[0].source, 's2:in-col-1');
      assert.strictEqual(links[0].target, 's2:in-col-2');
    });

    it('returns addedEdges: 0 without making network calls for empty collections', async () => {
      let fetchCalled = false;
      globalThis.fetch = async () => {
        fetchCalled = true;
        return new Response('[]', { status: 200 });
      };

      const req = new Request(`http://localhost:3000/api/collection/${colId}/rebuild-edges`, { method: 'POST' });
      const res = await POST(req, { params: Promise.resolve({ id: colId }) });
      const json = await res.json();

      assert.strictEqual(res.status, 200);
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.addedEdges, 0);
      assert.strictEqual(fetchCalled, false, 'No fetch calls should be made when collection has no papers');
    });

    it('is fully idempotent: repeated rebuild-edges calls do not duplicate citations in database', async () => {
      PaperRepository.addPaper({ id: 's2:idem-1', title: 'Idempotent 1' }, colId, 'seed');
      PaperRepository.addPaper({ id: 's2:idem-2', title: 'Idempotent 2' }, colId, 'seed');

      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify([{ paperId: 'idem-1', references: [{ paperId: 'idem-2' }] }]),
          { status: 200 }
        );
      };

      // Call 1
      const req1 = new Request(`http://localhost:3000/api/collection/${colId}/rebuild-edges`, { method: 'POST' });
      await POST(req1, { params: Promise.resolve({ id: colId }) });
      const links1 = CitationRepository.getLinksForCollection(colId);
      assert.strictEqual(links1.length, 1);

      // Call 2
      const req2 = new Request(`http://localhost:3000/api/collection/${colId}/rebuild-edges`, { method: 'POST' });
      await POST(req2, { params: Promise.resolve({ id: colId }) });
      const links2 = CitationRepository.getLinksForCollection(colId);
      assert.strictEqual(links2.length, 1, 'Links should not duplicate on multiple executions');
    });
  });

  describe('4. HttpClient Backward Compatibility & Options Support', () => {
    it('maintains 100% backward compatibility with 4 and 5 parameter callers', async () => {
      let callCount = 0;
      globalThis.fetch = async (url: any) => {
        callCount++;
        return new Response(JSON.stringify({ result: 'ok' }), { status: 200 });
      };

      // Call with 4 params (like openalex.ts)
      const res1 = await HttpClient.fetchWithBackoff('https://example.com/api/test-4-params', {}, 1, 2);
      assert.ok(res1);
      assert.strictEqual(res1.ok, true);
      const data1 = await res1.json();
      assert.strictEqual(data1.result, 'ok');
      assert.strictEqual(callCount, 1);

      // Second call should be served from cache
      let callbackCachedVal = false;
      const res2 = await HttpClient.fetchWithBackoff(
        'https://example.com/api/test-4-params',
        {},
        1,
        2,
        (cached) => { callbackCachedVal = cached; }
      );
      assert.ok(res2);
      assert.strictEqual(res2.ok, true);
      assert.strictEqual(callbackCachedVal, true, 'Second call should report cached = true');
      assert.strictEqual(callCount, 1, 'Second call should not hit network');
    });

    it('passes method, body, and custom headers through options correctly', async () => {
      let capturedInit: any = null;
      globalThis.fetch = async (url: any, init?: any) => {
        capturedInit = init;
        return new Response(JSON.stringify({ created: true }), { status: 201 });
      };

      const testUrl = 'https://example.com/api/custom-options';
      const body = JSON.stringify({ key: 'value' });
      const res = await HttpClient.fetchWithBackoff(
        testUrl,
        { 'x-base-header': 'base' },
        1,
        2,
        undefined,
        {
          method: 'POST',
          body,
          headers: { 'x-custom-header': 'custom' }
        }
      );

      assert.ok(res);
      assert.strictEqual(capturedInit.method, 'POST');
      assert.strictEqual(capturedInit.body, body);
      assert.strictEqual(capturedInit.headers['x-base-header'], 'base');
      assert.strictEqual(capturedInit.headers['x-custom-header'], 'custom');

      // Verify cache was keyed by url#body
      const cached = CacheRepository.get(`${testUrl}#${body}`);
      assert.ok(cached, 'Cache should exist under composite key');
    });

    it('executes retries swiftly in test environment via fast baseDelay', async () => {
      let attempts = 0;
      globalThis.fetch = async () => {
        attempts++;
        if (attempts < 3) return new Response('Rate limited', { status: 429 });
        return new Response(JSON.stringify({ done: true }), { status: 200 });
      };

      const start = Date.now();
      const res = await HttpClient.fetchWithBackoff('https://example.com/api/fast-backoff', {}, 1, 4);
      const elapsed = Date.now() - start;

      assert.ok(res);
      assert.strictEqual(res.ok, true);
      assert.strictEqual(attempts, 3);
      // In test mode (baseDelay = 10ms), 2 retries should take well under 250ms (instead of 3+ seconds)
      assert.ok(elapsed < 250, `Expected elapsed time < 250ms, but was ${elapsed}ms`);
    });
  });
});
