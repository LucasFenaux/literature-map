import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Force in-memory DB and isolated temp directory before any imports
process.env.SQLITE_DB_PATH = ':memory:';
process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'lit-review-graph-bkg-adv-' + Date.now());

import { getDb } from '../../src/lib/db.js';
import { PaperRepository } from '../../src/domain/repositories/PaperRepository.js';
import { CitationRepository } from '../../src/domain/repositories/CitationRepository.js';
import { QueueRepository } from '../../src/domain/repositories/QueueRepository.js';
import { EnrichmentJobProcessor } from '../../src/domain/services/EnrichmentJobProcessor.js';
import { GET } from '../../src/api/expand/[id]/route.js';

describe('Challenger M3_2: Adversarial Background Queue End-to-End Suite', () => {
  const physicalDbPath = path.join(process.cwd(), 'data', 'papers.db');
  let initialMtime = 0;
  let initialSize = 0;

  const colPrimary = 'col-adv-primary';
  const colSecondary = 'col-adv-secondary';
  const colIsolated = 'col-adv-isolated';

  let originalFetch: typeof globalThis.fetch;
  let originalEnvS2Key: string | undefined;

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

    // Seed test collections
    db.prepare('INSERT OR IGNORE INTO collections (id, name) VALUES (?, ?)').run(colPrimary, 'Primary Collection');
    db.prepare('INSERT OR IGNORE INTO collections (id, name) VALUES (?, ?)').run(colSecondary, 'Secondary Collection');
    db.prepare('INSERT OR IGNORE INTO collections (id, name) VALUES (?, ?)').run(colIsolated, 'Isolated Collection');

    originalFetch = globalThis.fetch;
    originalEnvS2Key = process.env.SEMANTIC_SCHOLAR_API_KEY;
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM retry_queue').run();
    db.prepare('DELETE FROM citations WHERE collectionId IN (?, ?, ?)').run(colPrimary, colSecondary, colIsolated);
    db.prepare('DELETE FROM papers WHERE collectionId IN (?, ?, ?)').run(colPrimary, colSecondary, colIsolated);
    db.prepare('DELETE FROM api_cache').run();
    delete process.env.SEMANTIC_SCHOLAR_API_KEY;
  });

  after(() => {
    globalThis.fetch = originalFetch;
    if (originalEnvS2Key !== undefined) {
      process.env.SEMANTIC_SCHOLAR_API_KEY = originalEnvS2Key;
    } else {
      delete process.env.SEMANTIC_SCHOLAR_API_KEY;
    }

    if (fs.existsSync(physicalDbPath)) {
      const stats = fs.statSync(physicalDbPath);
      assert.strictEqual(stats.mtimeMs, initialMtime, 'Physical DB mtime was modified!');
      assert.strictEqual(stats.size, initialSize, 'Physical DB size was modified!');
    }
  });

  describe('1. E2E Expand Route Rate-Limit -> Queue Retry -> Background Persistence', () => {
    it('handles S2 direct citations expand rate-limit, queues retry with collectionId, and persists to DB on background run', async () => {
      process.env.SEMANTIC_SCHOLAR_API_KEY = 'mock-s2-key';

      // 1. Setup seed paper in primary collection
      const seedId = 's2:adv-e2e-seed-cit';
      PaperRepository.addPaper(
        {
          id: seedId,
          title: 'Foundation of Graph Neural Networks',
          year: 2021
        },
        colPrimary,
        'seed'
      );

      // 2. Mock fetch to simulate RATE_LIMIT during S2 expand route call
      globalThis.fetch = async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes('api.semanticscholar.org')) {
          throw new Error('RATE_LIMIT');
        }
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      };

      // 3. Invoke expand route via GET request
      const req = new Request(`http://localhost:3000/api/expand/${seedId}?type=citations&collectionId=${colPrimary}`);
      const res = await GET(req, { params: Promise.resolve({ id: seedId }) });

      // Route should catch RATE_LIMIT and return JSON response without throwing 500
      assert.strictEqual(res.status, 200);
      const json = await res.json();
      assert.deepStrictEqual(json.citations, []);

      // 4. Assert retry_queue contains item with pending status and correct collectionId
      const pendingItems = QueueRepository.getPendingItems(10);
      assert.strictEqual(pendingItems.length, 1);
      assert.strictEqual(pendingItems[0].paperId, seedId);
      assert.strictEqual(pendingItems[0].type, 'citations');
      assert.strictEqual(pendingItems[0].collectionId, colPrimary);
      assert.strictEqual(pendingItems[0].status, 'pending');

      // 5. Simulate backoff/cooldown expiration: API now succeeds and returns citing papers
      globalThis.fetch = async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes('/citations?')) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  citingPaper: {
                    paperId: 'adv-cit-1',
                    title: 'Deep GNN Applications in Biology',
                    year: 2023,
                    citationCount: 14,
                    authors: [{ name: 'Dr. Bio' }],
                    references: []
                  }
                },
                {
                  citingPaper: {
                    paperId: 'adv-cit-2',
                    title: 'GNN Scalability Analysis',
                    year: 2024,
                    citationCount: 8,
                    authors: [{ name: 'Dr. Scale' }],
                    references: []
                  }
                }
              ]
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      };

      // 6. Run background EnrichmentJobProcessor
      await EnrichmentJobProcessor.processBatch(5);

      // 7. Verify queue item transitioned to completed
      const queueStatus = QueueRepository.getStatusCounts();
      assert.strictEqual(queueStatus.pending, 0);

      const db = getDb();
      const completedItem = db.prepare('SELECT * FROM retry_queue WHERE paperId = ?').get(seedId) as any;
      assert.strictEqual(completedItem.status, 'completed');

      // 8. Empirically verify papers persisted into SQLite papers table with collectionId and recommended status
      const p1 = PaperRepository.getPaper('s2:adv-cit-1', colPrimary);
      const p2 = PaperRepository.getPaper('s2:adv-cit-2', colPrimary);
      assert.ok(p1, 's2:adv-cit-1 must exist in SQLite papers table under colPrimary');
      assert.ok(p2, 's2:adv-cit-2 must exist in SQLite papers table under colPrimary');
      assert.strictEqual(p1.status, 'recommended');
      assert.strictEqual(p2.status, 'recommended');
      assert.strictEqual(p1.title, 'Deep GNN Applications in Biology');
      assert.strictEqual(p2.title, 'GNN Scalability Analysis');

      // 9. Empirically verify citation links persisted into SQLite citations table under collectionId
      const links = CitationRepository.getLinksForCollection(colPrimary);
      assert.strictEqual(links.length, 2);
      assert.ok(links.some((l) => l.source === 's2:adv-cit-1' && l.target === seedId));
      assert.ok(links.some((l) => l.source === 's2:adv-cit-2' && l.target === seedId));
    });

    it('handles references expand rate-limit with S2 search, queues retry, and persists references under collectionId', async () => {
      process.env.SEMANTIC_SCHOLAR_API_KEY = 'mock-s2-key';

      const seedId = 'adv-e2e-seed-ref';
      PaperRepository.addPaper(
        {
          id: seedId,
          title: 'Quantum Computing Foundations',
          year: 2020
        },
        colPrimary,
        'seed'
      );

      // Simulate rate limit during expand S2 search by title
      globalThis.fetch = async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes('api.semanticscholar.org')) {
          throw new Error('RATE_LIMIT');
        }
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      };

      const req = new Request(`http://localhost:3000/api/expand/${seedId}?type=references&collectionId=${colPrimary}`);
      const res = await GET(req, { params: Promise.resolve({ id: seedId }) });
      assert.strictEqual(res.status, 200);

      // Verify item queued
      const pending = QueueRepository.getPendingItems(5);
      assert.strictEqual(pending.length, 1);
      assert.strictEqual(pending[0].paperId, seedId);
      assert.strictEqual(pending[0].type, 'references');
      assert.strictEqual(pending[0].collectionId, colPrimary);

      // Simulate API recovery — S2 returns paper search and references
      globalThis.fetch = async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes('/paper/search?')) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  paperId: 's2-resolved-quantum',
                  title: 'Quantum Computing Foundations'
                }
              ]
            }),
            { status: 200 }
          );
        }
        if (urlStr.includes('/references?')) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  citedPaper: {
                    paperId: 'adv-ref-1',
                    title: 'Original Qubit Model 1995',
                    year: 1995,
                    citationCount: 500,
                    authors: [{ name: 'Q. Physicist' }],
                    references: []
                  }
                },
                {
                  citedPaper: {
                    paperId: 'adv-ref-2',
                    title: 'Shor Algorithm Paper 1994',
                    year: 1994,
                    citationCount: 1200,
                    authors: [{ name: 'P. Shor' }],
                    references: []
                  }
                }
              ]
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      };

      await EnrichmentJobProcessor.processBatch(5);

      const queueStatus = QueueRepository.getStatusCounts();
      assert.strictEqual(queueStatus.pending, 0);

      // Assert references persisted into SQLite papers
      const r1 = PaperRepository.getPaper('s2:adv-ref-1', colPrimary);
      const r2 = PaperRepository.getPaper('s2:adv-ref-2', colPrimary);
      assert.ok(r1);
      assert.ok(r2);
      assert.strictEqual(r1.status, 'recommended');
      assert.strictEqual(r2.status, 'recommended');

      // Assert references citation links: source is seedId, target is referenced work
      const links = CitationRepository.getLinksForCollection(colPrimary);
      assert.strictEqual(links.length, 2);
      assert.ok(links.some((l) => l.source === seedId && l.target === 's2:adv-ref-1'));
      assert.ok(links.some((l) => l.source === seedId && l.target === 's2:adv-ref-2'));
    });

    it('handles S2 fallback rate-limit when OpenAlex returns 0 citations, queuing retry with collectionId', async () => {
      // Without API key: OpenAlex returns 0 citations, triggering S2 fallback search by title
      const seedId = 'adv-e2e-seed-fallback';
      PaperRepository.addPaper(
        {
          id: seedId,
          title: 'Uncommon Graph Theory Monograph',
          year: 2018
        },
        colPrimary,
        'seed'
      );

      globalThis.fetch = async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes('api.openalex.org')) {
          // OpenAlex returns empty results
          return new Response(JSON.stringify({ results: [] }), { status: 200 });
        }
        if (urlStr.includes('api.semanticscholar.org')) {
          // S2 fallback hits rate limit
          throw new Error('S2_RATE_LIMIT');
        }
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      };

      const req = new Request(`http://localhost:3000/api/expand/${seedId}?type=citations&collectionId=${colPrimary}`);
      const res = await GET(req, { params: Promise.resolve({ id: seedId }) });
      assert.strictEqual(res.status, 200);

      const pending = QueueRepository.getPendingItems(5);
      assert.strictEqual(pending.length, 1);
      assert.strictEqual(pending[0].paperId, seedId);
      assert.strictEqual(pending[0].type, 'citations');
      assert.strictEqual(pending[0].collectionId, colPrimary);
    });

    it('handles native OpenAlex citations expand rate-limit, queues retry with collectionId, and persists to DB on background run', async () => {
      delete process.env.SEMANTIC_SCHOLAR_API_KEY;

      const seedId = 'openalex-e2e-seed-cit';
      PaperRepository.addPaper(
        {
          id: seedId,
          title: 'Native OpenAlex Seed Citations',
          year: 2021
        },
        colPrimary,
        'seed'
      );

      // Simulate rate limit during OpenAlex getCitations
      globalThis.fetch = async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes('api.openalex.org')) {
          throw new Error('RATE_LIMIT');
        }
        if (urlStr.includes('api.semanticscholar.org')) {
          throw new Error('RATE_LIMIT');
        }
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      };

      const req = new Request(`http://localhost:3000/api/expand/${seedId}?type=citations&collectionId=${colPrimary}`);
      const res = await GET(req, { params: Promise.resolve({ id: seedId }) });

      // Route should catch OpenAlex RATE_LIMIT and return HTTP 200 with empty citations
      assert.strictEqual(res.status, 200);
      const json = await res.json();
      assert.deepStrictEqual(json.citations, []);

      // Verify retry item was queued with correct collectionId
      const pending = QueueRepository.getPendingItems(5);
      assert.strictEqual(pending.length, 1);
      assert.strictEqual(pending[0].paperId, seedId);
      assert.strictEqual(pending[0].type, 'citations');
      assert.strictEqual(pending[0].collectionId, colPrimary);

      // Now API recovers and returns citing paper
      globalThis.fetch = async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes('api.semanticscholar.org')) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        if (urlStr.includes('cites:' + seedId)) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  id: 'https://openalex.org/openalex-cit-persisted',
                  title: 'Persisted OpenAlex Citation',
                  publication_year: 2023,
                  cited_by_count: 7,
                  authorships: [],
                  referenced_works: []
                }
              ]
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      };

      await EnrichmentJobProcessor.processBatch(5);

      const queueStatus = QueueRepository.getStatusCounts();
      assert.strictEqual(queueStatus.pending, 0);

      const savedPaper = PaperRepository.getPaper('openalex-cit-persisted', colPrimary);
      assert.ok(savedPaper, 'Citing paper must be persisted in colPrimary');
      assert.strictEqual(savedPaper.status, 'recommended');

      const links = CitationRepository.getLinksForCollection(colPrimary);
      assert.ok(links.some((l) => l.source === 'openalex-cit-persisted' && l.target === seedId));
    });

    it('handles native OpenAlex references expand rate-limit, queues retry with collectionId, and persists to DB on background run', async () => {
      delete process.env.SEMANTIC_SCHOLAR_API_KEY;

      const seedId = 'openalex-e2e-seed-ref';
      PaperRepository.addPaper(
        {
          id: seedId,
          title: 'Native OpenAlex Seed References',
          year: 2021
        },
        colPrimary,
        'seed'
      );

      // Simulate rate limit during OpenAlex getPaperDetails / getWorksByIds
      globalThis.fetch = async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes('api.openalex.org')) {
          throw new Error('RATE_LIMIT');
        }
        if (urlStr.includes('api.semanticscholar.org')) {
          throw new Error('RATE_LIMIT');
        }
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      };

      const req = new Request(`http://localhost:3000/api/expand/${seedId}?type=references&collectionId=${colPrimary}`);
      const res = await GET(req, { params: Promise.resolve({ id: seedId }) });

      // Route should catch OpenAlex RATE_LIMIT and return HTTP 200 with empty references
      assert.strictEqual(res.status, 200);
      const json = await res.json();
      assert.deepStrictEqual(json.references, []);

      // Verify retry item was queued with correct collectionId
      const pending = QueueRepository.getPendingItems(5);
      assert.strictEqual(pending.length, 1);
      assert.strictEqual(pending[0].paperId, seedId);
      assert.strictEqual(pending[0].type, 'references');
      assert.strictEqual(pending[0].collectionId, colPrimary);

      // Now API recovers and returns reference papers
      globalThis.fetch = async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes('api.semanticscholar.org')) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        if (urlStr.includes('/works/' + seedId)) {
          return new Response(
            JSON.stringify({
              id: 'https://openalex.org/' + seedId,
              title: 'Native OpenAlex Seed References',
              publication_year: 2021,
              cited_by_count: 10,
              authorships: [],
              referenced_works: ['https://openalex.org/openalex-ref-persisted']
            }),
            { status: 200 }
          );
        }
        if (urlStr.includes('filter=openalex:')) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  id: 'https://openalex.org/openalex-ref-persisted',
                  title: 'Persisted OpenAlex Reference',
                  publication_year: 2019,
                  cited_by_count: 42,
                  authorships: [],
                  referenced_works: []
                }
              ]
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      };

      await EnrichmentJobProcessor.processBatch(5);

      const queueStatus = QueueRepository.getStatusCounts();
      assert.strictEqual(queueStatus.pending, 0);

      const savedPaper = PaperRepository.getPaper('openalex-ref-persisted', colPrimary);
      assert.ok(savedPaper, 'Reference paper must be persisted in colPrimary');
      assert.strictEqual(savedPaper.status, 'recommended');

      const links = CitationRepository.getLinksForCollection(colPrimary);
      assert.ok(links.some((l) => l.source === seedId && l.target === 'openalex-ref-persisted'));
    });

    it('persists cross-edges between newly fetched papers and existing collection papers', async () => {
      const seedId = 'adv-e2e-seed-both';
      PaperRepository.addPaper(
        {
          id: seedId,
          title: 'Transformer Architecture Survey',
          year: 2022
        },
        colPrimary,
        'seed'
      );

      // Queue retry for 'both'
      QueueRepository.addQueueItem(seedId, 'both', colPrimary);

      // Mock responses where cit-1 references ref-1 (a cross-edge!)
      globalThis.fetch = async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes('api.semanticscholar.org')) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        if (urlStr.includes('cites:' + seedId)) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  id: 'https://openalex.org/trans-cit-1',
                  title: 'Transformer in Vision',
                  publication_year: 2023,
                  cited_by_count: 50,
                  authorships: [],
                  referenced_works: ['https://openalex.org/trans-ref-1']
                }
              ]
            }),
            { status: 200 }
          );
        }
        if (urlStr.includes('/works/' + seedId)) {
          return new Response(
            JSON.stringify({
              id: 'https://openalex.org/' + seedId,
              title: 'Transformer Architecture Survey',
              publication_year: 2022,
              cited_by_count: 100,
              authorships: [],
              referenced_works: ['https://openalex.org/trans-ref-1']
            }),
            { status: 200 }
          );
        }
        if (urlStr.includes('filter=openalex:')) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  id: 'https://openalex.org/trans-ref-1',
                  title: 'Attention is All You Need',
                  publication_year: 2017,
                  cited_by_count: 80000,
                  authorships: [],
                  referenced_works: []
                }
              ]
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      };

      await EnrichmentJobProcessor.processBatch(5);

      const links = CitationRepository.getLinksForCollection(colPrimary);
      // Expected links:
      // 1. trans-cit-1 -> seedId (citation)
      // 2. seedId -> trans-ref-1 (reference)
      // 3. trans-cit-1 -> trans-ref-1 (cross-edge!)
      assert.ok(links.some((l) => l.source === 'trans-cit-1' && l.target === seedId));
      assert.ok(links.some((l) => l.source === seedId && l.target === 'trans-ref-1'));
      assert.ok(
        links.some((l) => l.source === 'trans-cit-1' && l.target === 'trans-ref-1'),
        'Cross-edge between expanded papers must be saved'
      );
    });
  });

  describe('2. Legacy Queue Item Fallback Resolution & Error Resilience', () => {
    it('resolves collectionId from seed paper in SQLite when queue item collectionId is NULL', async () => {
      // Pre-existing paper in colPrimary
      const legacySeedId = 'legacy-paper-fallback';
      PaperRepository.addPaper(
        {
          id: legacySeedId,
          title: 'Legacy Graph Theory Foundation',
          year: 2015
        },
        colPrimary,
        'seed'
      );

      // Direct SQL insertion simulating pre-M3 database state (collectionId IS NULL)
      const db = getDb();
      db.prepare(
        'INSERT INTO retry_queue (id, paperId, type, status, collectionId) VALUES (?, ?, ?, ?, NULL)'
      ).run('legacy-queue-id-1', legacySeedId, 'citations', 'pending');

      // Verify it was saved as NULL
      const row = db.prepare('SELECT * FROM retry_queue WHERE id = ?').get('legacy-queue-id-1') as any;
      assert.strictEqual(row.collectionId, null);

      globalThis.fetch = async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes('api.semanticscholar.org')) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        if (urlStr.includes('cites:' + legacySeedId)) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  id: 'https://openalex.org/legacy-cit-res',
                  title: 'Graph Theory Continued',
                  publication_year: 2018,
                  cited_by_count: 5,
                  authorships: [],
                  referenced_works: []
                }
              ]
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      };

      await EnrichmentJobProcessor.processBatch(5);

      // Item should be completed
      const updatedRow = db.prepare('SELECT * FROM retry_queue WHERE id = ?').get('legacy-queue-id-1') as any;
      assert.strictEqual(updatedRow.status, 'completed');

      // Paper and link should be saved under recovered colPrimary
      const savedPaper = PaperRepository.getPaper('legacy-cit-res', colPrimary);
      assert.ok(savedPaper, 'Fetched paper must be saved in recovered colPrimary');
      assert.strictEqual(savedPaper.status, 'recommended');

      const links = CitationRepository.getLinksForCollection(colPrimary);
      assert.ok(links.some((l) => l.source === 'legacy-cit-res' && l.target === legacySeedId));
    });

    it('gracefully marks orphan queue items as failed without crashing the batch or halting subsequent items', async () => {
      const db = getDb();

      // Seed paper for valid subsequent item
      PaperRepository.addPaper({ id: 'valid-subsequent-seed', title: 'Subsequent Paper' }, colPrimary, 'seed');

      // Item 1: Orphan legacy item with NULL collectionId and nonexistent paperId
      db.prepare(
        "INSERT INTO retry_queue (id, paperId, type, status, collectionId, createdAt) VALUES (?, ?, ?, ?, NULL, datetime('now', '-10 seconds'))"
      ).run('orphan-item-1', 'non-existent-paper-ghost', 'citations', 'pending');

      // Item 2: Valid item queued after orphan
      QueueRepository.addQueueItem('valid-subsequent-seed', 'citations', colPrimary);

      globalThis.fetch = async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes('api.semanticscholar.org')) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        if (urlStr.includes('cites:valid-subsequent-seed')) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  id: 'https://openalex.org/subsequent-cit-1',
                  title: 'Subsequent Citation Paper',
                  publication_year: 2023,
                  cited_by_count: 2,
                  authorships: [],
                  referenced_works: []
                }
              ]
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      };

      // Run processor — should process both items without crashing
      await EnrichmentJobProcessor.processBatch(10);

      const orphanRow = db.prepare('SELECT * FROM retry_queue WHERE id = ?').get('orphan-item-1') as any;
      assert.strictEqual(orphanRow.status, 'failed', 'Orphan item must be marked failed');

      // Valid item must have succeeded
      const counts = QueueRepository.getStatusCounts();
      assert.strictEqual(counts.pending, 0);
      assert.strictEqual(counts.failed, 1);

      const validPaper = PaperRepository.getPaper('subsequent-cit-1', colPrimary);
      assert.ok(validPaper, 'Subsequent item must be processed successfully despite preceding orphan');
    });
  });

  describe('3. Multi-Collection Isolation & Queue Deduplication', () => {
    it('allows identical paperId to be queued independently across distinct collections without crosstalk', async () => {
      process.env.SEMANTIC_SCHOLAR_API_KEY = 'mock-s2-key';
      const sharedId = 's2:shared-multicoll-paper';
      PaperRepository.addPaper({ id: sharedId, title: 'Shared Classical Mechanics' }, colPrimary, 'seed');
      PaperRepository.addPaper({ id: sharedId, title: 'Shared Classical Mechanics' }, colSecondary, 'seed');

      // Expand route called for primary collection -> hits rate limit
      globalThis.fetch = async () => {
        throw new Error('RATE_LIMIT');
      };

      const req1 = new Request(`http://localhost:3000/api/expand/${sharedId}?type=citations&collectionId=${colPrimary}`);
      await GET(req1, { params: Promise.resolve({ id: sharedId }) });

      // Expand route called for secondary collection -> hits rate limit
      const req2 = new Request(`http://localhost:3000/api/expand/${sharedId}?type=citations&collectionId=${colSecondary}`);
      await GET(req2, { params: Promise.resolve({ id: sharedId }) });

      // Check retry_queue: MUST contain two pending items, one for each collection!
      const pending = QueueRepository.getPendingItems(10);
      assert.strictEqual(pending.length, 2, 'Both collections must have their own queue item');

      const itemCol1 = pending.find((i) => i.collectionId === colPrimary);
      const itemCol2 = pending.find((i) => i.collectionId === colSecondary);
      assert.ok(itemCol1);
      assert.ok(itemCol2);
      assert.strictEqual(itemCol1.paperId, sharedId);
      assert.strictEqual(itemCol2.paperId, sharedId);

      // Now API recovers
      globalThis.fetch = async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes('/citations?')) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  citingPaper: {
                    paperId: 'shared-citing-paper',
                    title: 'Relativistic Corrections to Classical Mechanics',
                    year: 2024,
                    citationCount: 20,
                    authors: [{ name: 'A. Einstein' }],
                    references: []
                  }
                }
              ]
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      };

      await EnrichmentJobProcessor.processBatch(10);

      // Both collections must have the citing paper persisted
      const pCol1 = PaperRepository.getPaper('s2:shared-citing-paper', colPrimary);
      const pCol2 = PaperRepository.getPaper('s2:shared-citing-paper', colSecondary);
      assert.ok(pCol1, 'Paper must be persisted in colPrimary');
      assert.ok(pCol2, 'Paper must be persisted in colSecondary');

      // Isolated collection colIsolated must NOT have any papers or links
      const pIsolated = PaperRepository.getPapersForCollection(colIsolated);
      const linksIsolated = CitationRepository.getLinksForCollection(colIsolated);
      assert.strictEqual(pIsolated.length, 0, 'Unrelated collection must have zero papers');
      assert.strictEqual(linksIsolated.length, 0, 'Unrelated collection must have zero links');
    });
  });

  describe('4. Batch Halting and Resumption under Active Rate Limiting', () => {
    it('halts processing remaining batch items when RATE_LIMIT is caught, leaving items pending for next tick', async () => {
      // 3 seed papers in colPrimary
      PaperRepository.addPaper({ id: 'batch-item-1', title: 'Batch Seed 1' }, colPrimary, 'seed');
      PaperRepository.addPaper({ id: 'batch-item-2', title: 'Batch Seed 2' }, colPrimary, 'seed');
      PaperRepository.addPaper({ id: 'batch-item-3', title: 'Batch Seed 3' }, colPrimary, 'seed');

      QueueRepository.addQueueItem('batch-item-1', 'citations', colPrimary);
      QueueRepository.addQueueItem('batch-item-2', 'citations', colPrimary);
      QueueRepository.addQueueItem('batch-item-3', 'citations', colPrimary);

      // Mock fetch: item 1 succeeds, item 2 throws RATE_LIMIT
      globalThis.fetch = async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes('api.semanticscholar.org')) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        if (urlStr.includes('cites:batch-item-1')) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  id: 'https://openalex.org/batch-res-1',
                  title: 'Batch Result 1',
                  publication_year: 2023,
                  cited_by_count: 1,
                  authorships: [],
                  referenced_works: []
                }
              ]
            }),
            { status: 200 }
          );
        }
        if (urlStr.includes('cites:batch-item-2')) {
          throw new Error('RATE_LIMIT');
        }
        if (urlStr.includes('cites:batch-item-3')) {
          throw new Error('Should not be reached during this tick!');
        }
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      };

      await EnrichmentJobProcessor.processBatch(5);

      const db = getDb();
      const i1 = db.prepare('SELECT * FROM retry_queue WHERE paperId = ?').get('batch-item-1') as any;
      const i2 = db.prepare('SELECT * FROM retry_queue WHERE paperId = ?').get('batch-item-2') as any;
      const i3 = db.prepare('SELECT * FROM retry_queue WHERE paperId = ?').get('batch-item-3') as any;

      assert.strictEqual(i1.status, 'completed', 'Item 1 should have completed');
      assert.strictEqual(i2.status, 'pending', 'Item 2 should remain pending (deferred on rate limit)');
      assert.strictEqual(i3.status, 'pending', 'Item 3 should remain pending (unreached due to batch break)');

      // Paper 1 must be saved
      assert.ok(PaperRepository.getPaper('batch-res-1', colPrimary));

      // Now rate limit clears completely
      globalThis.fetch = async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes('api.semanticscholar.org')) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        if (urlStr.includes('cites:batch-item-2')) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  id: 'https://openalex.org/batch-res-2',
                  title: 'Batch Result 2',
                  publication_year: 2023,
                  cited_by_count: 2,
                  authorships: [],
                  referenced_works: []
                }
              ]
            }),
            { status: 200 }
          );
        }
        if (urlStr.includes('cites:batch-item-3')) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  id: 'https://openalex.org/batch-res-3',
                  title: 'Batch Result 3',
                  publication_year: 2024,
                  cited_by_count: 3,
                  authorships: [],
                  referenced_works: []
                }
              ]
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      };

      // Process second batch
      await EnrichmentJobProcessor.processBatch(5);

      const counts = QueueRepository.getStatusCounts();
      assert.strictEqual(counts.pending, 0);
      assert.strictEqual(counts.failed, 0);

      assert.ok(PaperRepository.getPaper('batch-res-2', colPrimary));
      assert.ok(PaperRepository.getPaper('batch-res-3', colPrimary));
    });
  });

  describe('5. Physical Database Safety Verification', () => {
    it('guarantees production data/papers.db was never touched or modified', () => {
      if (fs.existsSync(physicalDbPath)) {
        const stats = fs.statSync(physicalDbPath);
        assert.strictEqual(stats.mtimeMs, initialMtime);
        assert.strictEqual(stats.size, initialSize);
      }
    });
  });
});
