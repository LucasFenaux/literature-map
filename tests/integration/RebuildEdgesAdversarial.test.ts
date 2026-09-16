import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Guarantee in-memory DB and isolated temp directory before any imports
(process.env as any).NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = ':memory:';
process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'lit-review-graph-adv-rebuild-' + Date.now());

import { getDb } from '../../src/lib/db.js';
import { PaperRepository } from '../../src/domain/repositories/PaperRepository.js';
import { CitationRepository } from '../../src/domain/repositories/CitationRepository.js';
import { CacheRepository } from '../../src/domain/repositories/CacheRepository.js';
import { HttpClient } from '../../src/domain/adapters/HttpClient.js';
import { EnvConfigAdapter } from '../../src/domain/repositories/SettingsRepository.js';
import { POST } from '../../src/api/collection/[id]/rebuild-edges/route.js';

describe('Milestone 5 (R1): Challenger Adversarial Stress Test Suite', () => {
  const physicalDbPath = path.join(process.cwd(), 'data', 'papers.db');
  let initialMtime = 0;
  let initialSize = 0;

  const colA = 'col-adv-a';
  const colB = 'col-adv-b';
  let originalFetch: typeof globalThis.fetch;

  before(() => {
    if (fs.existsSync(physicalDbPath)) {
      const stats = fs.statSync(physicalDbPath);
      initialMtime = stats.mtimeMs;
      initialSize = stats.size;
    }

    const db = getDb();
    // Inhibit background backup from touching disk
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
      'last_db_backup_time',
      Date.now().toString()
    );

    // Create test collections
    db.prepare('INSERT OR IGNORE INTO collections (id, name) VALUES (?, ?)').run(colA, 'Adversarial Collection A');
    db.prepare('INSERT OR IGNORE INTO collections (id, name) VALUES (?, ?)').run(colB, 'Adversarial Collection B');

    originalFetch = globalThis.fetch;
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM citations WHERE collectionId IN (?, ?)').run(colA, colB);
    db.prepare('DELETE FROM papers WHERE collectionId IN (?, ?)').run(colA, colB);
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

  describe('Adversarial Dimension 1: Severe Rate-Limiting & 429 Behaviors', () => {
    it('handles 429 response containing Retry-After header gracefully and recovers on retry', async () => {
      let callCount = 0;
      globalThis.fetch = async (url: any) => {
        callCount++;
        if (callCount === 1) {
          // Return 429 with standard Retry-After header
          return new Response('Rate limited', {
            status: 429,
            headers: {
              'Retry-After': '1',
              'Content-Type': 'text/plain'
            }
          });
        }
        return new Response(JSON.stringify({ ok: true, attempt: callCount }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      };

      const res = await HttpClient.fetchWithBackoff('https://example.com/api/retry-after-test', {}, 1, 3);
      assert.ok(res);
      assert.strictEqual(res.ok, true);
      const data = await res.json();
      assert.strictEqual(data.attempt, 2);
      assert.strictEqual(callCount, 2);
    });

    it('handles 429 response with malformed/unconventional Retry-After header without throwing TypeError', async () => {
      let callCount = 0;
      globalThis.fetch = async () => {
        callCount++;
        if (callCount <= 2) {
          return new Response('Rate limited', {
            status: 429,
            headers: {
              'Retry-After': 'invalid-date-string-or-unexpected-tokens'
            }
          });
        }
        return new Response(JSON.stringify({ recovered: true }), { status: 200 });
      };

      const res = await HttpClient.fetchWithBackoff('https://example.com/api/weird-retry-after', {}, 1, 4);
      assert.ok(res);
      assert.strictEqual(res.ok, true);
      assert.strictEqual(callCount, 3);
    });

    it('isolates S2 rate limit failure: when S2 hits 429 exhaustion, OpenAlex still executes and persists edges', async () => {
      // Setup both S2 and OpenAlex papers
      PaperRepository.addPaper({ id: 's2:s2-exhaust-1', title: 'S2 Exhaust 1' }, colA, 'seed');
      PaperRepository.addPaper({ id: 's2:s2-exhaust-2', title: 'S2 Exhaust 2' }, colA, 'seed');
      PaperRepository.addPaper({ id: 'W-adv-1', title: 'OpenAlex 1' }, colA, 'seed');
      PaperRepository.addPaper({ id: 'W-adv-2', title: 'OpenAlex 2' }, colA, 'seed');

      let s2Calls = 0;
      let oaCalls = 0;

      globalThis.fetch = async (url: any) => {
        const urlStr = String(url);
        if (urlStr.includes('/paper/batch')) {
          s2Calls++;
          // Always return 429 for S2
          return new Response('S2 Rate limit', { status: 429 });
        }
        if (urlStr.includes('openalex.org/works')) {
          oaCalls++;
          // OpenAlex succeeds
          return new Response(
            JSON.stringify({
              results: [
                {
                  id: 'https://openalex.org/W-adv-1',
                  referenced_works: ['https://openalex.org/W-adv-2']
                }
              ]
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response('[]', { status: 200 });
      };

      const req = new Request(`http://localhost:3000/api/collection/${colA}/rebuild-edges`, { method: 'POST' });
      const res = await POST(req, { params: Promise.resolve({ id: colA }) });

      assert.strictEqual(res.status, 200);
      const json = await res.json();
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.addedEdges, 1, 'OpenAlex edge should have been saved despite S2 rate-limiting');

      // S2 should have attempted 4 times before giving up
      assert.strictEqual(s2Calls, 4);
      // OpenAlex should have executed and succeeded
      assert.strictEqual(oaCalls, 1);

      // Verify DB citations
      const links = CitationRepository.getLinksForCollection(colA);
      assert.strictEqual(links.length, 1);
      assert.strictEqual(links[0].source, 'W-adv-1');
      assert.strictEqual(links[0].target, 'W-adv-2');
    });

    it('retains edges from earlier successful batches when a subsequent batch encounters 429 exhaustion', async () => {
      // Create 501 S2 papers -> 2 batches (500 + 1)
      const papers = [];
      for (let i = 0; i < 501; i++) {
        papers.push({
          id: `s2:batch-paper-${i}`,
          title: `Paper ${i}`
        });
      }
      PaperRepository.addPapers(papers, colA, 'seed');

      let batchCount = 0;
      globalThis.fetch = async (url: any, init?: any) => {
        const body = JSON.parse(init?.body || '{}');
        batchCount++;
        if (body.ids.length === 500) {
          // Batch 1: returns edge between paper-0 and paper-1
          return new Response(
            JSON.stringify([
              { paperId: 'batch-paper-0', references: [{ paperId: 'batch-paper-1' }] }
            ]),
            { status: 200 }
          );
        } else {
          // Batch 2: persistent 429
          return new Response('Rate limited', { status: 429 });
        }
      };

      const req = new Request(`http://localhost:3000/api/collection/${colA}/rebuild-edges`, { method: 'POST' });
      const res = await POST(req, { params: Promise.resolve({ id: colA }) });

      assert.strictEqual(res.status, 200);
      const json = await res.json();
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.addedEdges, 1, 'Batch 1 edge must be preserved and inserted');

      const links = CitationRepository.getLinksForCollection(colA);
      assert.strictEqual(links.length, 1);
      assert.strictEqual(links[0].source, 's2:batch-paper-0');
      assert.strictEqual(links[0].target, 's2:batch-paper-1');
    });

    it('never writes 429 responses into api_cache', async () => {
      let callCount = 0;
      globalThis.fetch = async () => {
        callCount++;
        return new Response('Rate limited', { status: 429 });
      };

      await assert.rejects(
        async () => {
          await HttpClient.fetchWithBackoff('https://example.com/api/test-cache-429', {}, 1, 2);
        },
        { message: 'RATE_LIMIT' }
      );

      const db = getDb();
      const row = db.prepare("SELECT * FROM api_cache WHERE key LIKE '%test-cache-429%'").get();
      assert.strictEqual(row, undefined, 'api_cache must not store 429 responses');
    });
  });

  describe('Adversarial Dimension 2: Cache Key Collisions & Cache Integrity', () => {
    it('guarantees different POST bodies targeting the same endpoint URL never collide in api_cache', async () => {
      const endpoint = 'https://api.semanticscholar.org/graph/v1/paper/batch?fields=paperId';
      const body1 = JSON.stringify({ ids: ['id-alpha', 'id-beta'] });
      const body2 = JSON.stringify({ ids: ['id-gamma', 'id-delta'] });

      let networkCalls = 0;
      globalThis.fetch = async (url: any, init?: any) => {
        networkCalls++;
        if (init?.body === body1) {
          return new Response(JSON.stringify([{ paperId: 'id-alpha', title: 'Alpha' }]), { status: 200 });
        } else if (init?.body === body2) {
          return new Response(JSON.stringify([{ paperId: 'id-gamma', title: 'Gamma' }]), { status: 200 });
        }
        return new Response('{}', { status: 404 });
      };

      // Request 1
      const res1 = await HttpClient.fetchWithBackoff(endpoint, {}, 1, 2, undefined, { method: 'POST', body: body1 });
      const data1 = await res1.json();
      assert.strictEqual(data1[0].title, 'Alpha');

      // Request 2 (different body)
      const res2 = await HttpClient.fetchWithBackoff(endpoint, {}, 1, 2, undefined, { method: 'POST', body: body2 });
      const data2 = await res2.json();
      assert.strictEqual(data2[0].title, 'Gamma');

      assert.strictEqual(networkCalls, 2, 'Both distinct bodies must hit the network on first request');

      // Check DB api_cache keys
      const db = getDb();
      const row1 = db.prepare('SELECT key, data FROM api_cache WHERE key = ?').get(`${endpoint}#${body1}`) as any;
      const row2 = db.prepare('SELECT key, data FROM api_cache WHERE key = ?').get(`${endpoint}#${body2}`) as any;
      assert.ok(row1, 'Row 1 exists with body1 in key');
      assert.ok(row2, 'Row 2 exists with body2 in key');
      assert.notStrictEqual(row1.key, row2.key);
      assert.notStrictEqual(row1.data, row2.data);

      // Now verify cached reads return respective distinct data without network call
      const resCached1 = await HttpClient.fetchWithBackoff(endpoint, {}, 1, 2, undefined, { method: 'POST', body: body1 });
      const resCached2 = await HttpClient.fetchWithBackoff(endpoint, {}, 1, 2, undefined, { method: 'POST', body: body2 });
      assert.strictEqual((await resCached1.json())[0].title, 'Alpha');
      assert.strictEqual((await resCached2.json())[0].title, 'Gamma');
      assert.strictEqual(networkCalls, 2, 'No further network calls should have occurred on cache hits');
    });

    it('isolates GET request from POST request to the identical URL', async () => {
      const url = 'https://example.com/api/dual-method';
      const postBody = JSON.stringify({ action: 'create' });

      globalThis.fetch = async (targetUrl: any, init?: any) => {
        if (init?.method === 'POST') {
          return new Response(JSON.stringify({ type: 'POST_RESPONSE' }), { status: 200 });
        }
        return new Response(JSON.stringify({ type: 'GET_RESPONSE' }), { status: 200 });
      };

      // GET request
      const getRes = await HttpClient.fetchWithBackoff(url, {}, 1, 2);
      const getData = await getRes.json();
      assert.strictEqual(getData.type, 'GET_RESPONSE');

      // POST request
      const postRes = await HttpClient.fetchWithBackoff(url, {}, 1, 2, undefined, { method: 'POST', body: postBody });
      const postData = await postRes.json();
      assert.strictEqual(postData.type, 'POST_RESPONSE');

      // Verify cache entries
      const db = getDb();
      const getCache = db.prepare('SELECT data FROM api_cache WHERE key = ?').get(url) as any;
      const postCache = db.prepare('SELECT data FROM api_cache WHERE key = ?').get(`${url}#${postBody}`) as any;

      assert.ok(getCache);
      assert.ok(postCache);
      assert.strictEqual(JSON.parse(getCache.data).type, 'GET_RESPONSE');
      assert.strictEqual(JSON.parse(postCache.data).type, 'POST_RESPONSE');
    });

    it('never writes 500 server errors to api_cache', async () => {
      const errUrl = 'https://example.com/api/internal-error';
      globalThis.fetch = async () => {
        return new Response(JSON.stringify({ error: 'Internal Server Error' }), { status: 500 });
      };

      const res = await HttpClient.fetchWithBackoff(errUrl, {}, 1, 2);
      assert.strictEqual(res.status, 500);

      const db = getDb();
      const row = db.prepare('SELECT * FROM api_cache WHERE key = ?').get(errUrl);
      assert.strictEqual(row, undefined, '500 response must never be saved in cache');
    });

    it('correctly filters cached cross-references when different collections share overlapping papers', async () => {
      // Collection A has papers [p1, p2]
      PaperRepository.addPaper({ id: 's2:overlap-1', title: 'Overlap 1' }, colA, 'seed');
      PaperRepository.addPaper({ id: 's2:overlap-2', title: 'Overlap 2' }, colA, 'seed');

      // Collection B has papers [p1, p3]
      PaperRepository.addPaper({ id: 's2:overlap-1', title: 'Overlap 1' }, colB, 'seed');
      PaperRepository.addPaper({ id: 's2:overlap-3', title: 'Overlap 3' }, colB, 'seed');

      let fetchCount = 0;
      globalThis.fetch = async (url: any, init?: any) => {
        fetchCount++;
        // Return paper 1 citing paper 2 AND paper 3
        return new Response(
          JSON.stringify([
            {
              paperId: 'overlap-1',
              references: [{ paperId: 'overlap-2' }, { paperId: 'overlap-3' }]
            },
            {
              paperId: 'overlap-2',
              references: []
            },
            {
              paperId: 'overlap-3',
              references: []
            }
          ]),
          { status: 200 }
        );
      };

      // Run Collection A
      const reqA = new Request(`http://localhost:3000/api/collection/${colA}/rebuild-edges`, { method: 'POST' });
      const resA = await POST(reqA, { params: Promise.resolve({ id: colA }) });
      const jsonA = await resA.json();
      assert.strictEqual(jsonA.addedEdges, 1);

      // Collection A only contains p1 and p2 -> only edge overlap-1 -> overlap-2
      const linksA = CitationRepository.getLinksForCollection(colA);
      assert.strictEqual(linksA.length, 1);
      assert.strictEqual(linksA[0].source, 's2:overlap-1');
      assert.strictEqual(linksA[0].target, 's2:overlap-2');

      // Run Collection B
      const reqB = new Request(`http://localhost:3000/api/collection/${colB}/rebuild-edges`, { method: 'POST' });
      const resB = await POST(reqB, { params: Promise.resolve({ id: colB }) });
      const jsonB = await resB.json();
      assert.strictEqual(jsonB.addedEdges, 1);

      // Collection B only contains p1 and p3 -> only edge overlap-1 -> overlap-3
      const linksB = CitationRepository.getLinksForCollection(colB);
      assert.strictEqual(linksB.length, 1);
      assert.strictEqual(linksB[0].source, 's2:overlap-1');
      assert.strictEqual(linksB[0].target, 's2:overlap-3');
    });
  });

  describe('Adversarial Dimension 3: Static Analysis & Code Conformance', () => {
    it('verifies zero raw fetch calls exist in rebuild-edges/route.ts', () => {
      const routeFilePath = path.join(process.cwd(), 'src', 'api', 'collection', '[id]', 'rebuild-edges', 'route.ts');
      assert.ok(fs.existsSync(routeFilePath), 'rebuild-edges route.ts must exist');

      const content = fs.readFileSync(routeFilePath, 'utf8');
      const lines = content.split('\n');

      const rawFetchLines: { lineNum: number; line: string }[] = [];
      lines.forEach((line, index) => {
        // Look for fetch( but exclude HttpClient.fetchWithBackoff and comments/strings
        if (/\bfetch\(/.test(line) && !line.includes('HttpClient.fetchWithBackoff')) {
          rawFetchLines.push({ lineNum: index + 1, line: line.trim() });
        }
      });

      assert.strictEqual(
        rawFetchLines.length,
        0,
        `Found unexpected raw fetch calls in route.ts: ${JSON.stringify(rawFetchLines)}`
      );
    });

    it('honors cacheFreshnessReferences from EnvConfigAdapter in rebuild-edges route', async () => {
      const expectedFreshness = parseInt(EnvConfigAdapter.getEnvConfig().cacheFreshnessReferences, 10);

      PaperRepository.addPaper({ id: 's2:custom-freshness-1', title: 'Custom Freshness 1' }, colA, 'seed');
      PaperRepository.addPaper({ id: 's2:custom-freshness-2', title: 'Custom Freshness 2' }, colA, 'seed');

      let interceptedFreshnessDays: number | null = null;
      const originalFetchWithBackoff = HttpClient.fetchWithBackoff;
      HttpClient.fetchWithBackoff = async (...args: any[]) => {
        interceptedFreshnessDays = args[2];
        return originalFetchWithBackoff.apply(HttpClient, args as any);
      };

      try {
        globalThis.fetch = async () => new Response(JSON.stringify([]), { status: 200 });
        const req = new Request(`http://localhost:3000/api/collection/${colA}/rebuild-edges`, { method: 'POST' });
        await POST(req, { params: Promise.resolve({ id: colA }) });

        assert.strictEqual(interceptedFreshnessDays, expectedFreshness, 'Route must use freshness resolved by EnvConfigAdapter');
      } finally {
        HttpClient.fetchWithBackoff = originalFetchWithBackoff;
      }
    });
  });

  describe('Adversarial Dimension 4: Payload Edge Cases & Resilience', () => {
    it('handles benign variations in S2 payloads (null items, missing references) gracefully', async () => {
      PaperRepository.addPaper({ id: 's2:benign-1', title: 'Benign 1' }, colA, 'seed');
      PaperRepository.addPaper({ id: 's2:benign-2', title: 'Benign 2' }, colA, 'seed');

      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify([
            null, // null top-level item handled by (!item || !item.paperId)
            { paperId: null }, // null paperId handled by (!item.paperId)
            { paperId: 'benign-1', references: null }, // null references handled by (item.references && Array.isArray)
            { paperId: 'benign-1', references: [] }, // empty references
            { paperId: 'benign-1', references: [{ paperId: 'benign-2' }] } // valid reference
          ]),
          { status: 200 }
        );
      };

      const req = new Request(`http://localhost:3000/api/collection/${colA}/rebuild-edges`, { method: 'POST' });
      const res = await POST(req, { params: Promise.resolve({ id: colA }) });

      assert.strictEqual(res.status, 200);
      const json = await res.json();
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.addedEdges, 1, 'Should extract valid edge despite benign payload variations');

      const links = CitationRepository.getLinksForCollection(colA);
      assert.strictEqual(links.length, 1);
      assert.strictEqual(links[0].source, 's2:benign-1');
      assert.strictEqual(links[0].target, 's2:benign-2');
    });

    it('catches unexpected batch errors without crashing the endpoint with 500', async () => {
      PaperRepository.addPaper({ id: 's2:err-1', title: 'Err 1' }, colA, 'seed');

      globalThis.fetch = async () => {
        // Return item with references containing null to trigger catch block
        return new Response(
          JSON.stringify([
            { paperId: 'err-1', references: [null] }
          ]),
          { status: 200 }
        );
      };

      const req = new Request(`http://localhost:3000/api/collection/${colA}/rebuild-edges`, { method: 'POST' });
      const res = await POST(req, { params: Promise.resolve({ id: colA }) });

      // Route catches error in batch try/catch and does not crash endpoint with 500
      assert.strictEqual(res.status, 200);
      const json = await res.json();
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.addedEdges, 0);
    });

    it('handles benign variations in OpenAlex payloads gracefully', async () => {
      PaperRepository.addPaper({ id: 'W-oa-1', title: 'OA 1' }, colA, 'seed');
      PaperRepository.addPaper({ id: 'W-oa-2', title: 'OA 2' }, colA, 'seed');

      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            results: [
              { id: 'https://openalex.org/W-oa-1', referenced_works: null },
              { id: 'https://openalex.org/W-oa-1', referenced_works: [] },
              { id: 'https://openalex.org/W-oa-1', referenced_works: ['https://openalex.org/W-oa-2'] }
            ]
          }),
          { status: 200 }
        );
      };

      const req = new Request(`http://localhost:3000/api/collection/${colA}/rebuild-edges`, { method: 'POST' });
      const res = await POST(req, { params: Promise.resolve({ id: colA }) });

      assert.strictEqual(res.status, 200);
      const json = await res.json();
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.addedEdges, 1);
    });

    it('handles self-referential citations without throwing database errors', async () => {
      PaperRepository.addPaper({ id: 's2:self-ref', title: 'Self Ref Paper' }, colA, 'seed');

      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify([
            { paperId: 'self-ref', references: [{ paperId: 'self-ref' }] }
          ]),
          { status: 200 }
        );
      };

      const req = new Request(`http://localhost:3000/api/collection/${colA}/rebuild-edges`, { method: 'POST' });
      const res = await POST(req, { params: Promise.resolve({ id: colA }) });

      assert.strictEqual(res.status, 200);
      const json = await res.json();
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.addedEdges, 1);

      const links = CitationRepository.getLinksForCollection(colA);
      assert.strictEqual(links.length, 1);
      assert.strictEqual(links[0].source, 's2:self-ref');
      assert.strictEqual(links[0].target, 's2:self-ref');
    });
  });
});
