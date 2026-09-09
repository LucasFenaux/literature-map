import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Guarantee in-memory DB and isolated temp directory before any imports
process.env.SQLITE_DB_PATH = ':memory:';
process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'lit-review-graph-adv-expand-' + Date.now());

import { getDb } from '../../src/lib/db.js';
import { PaperRepository } from '../../src/domain/repositories/PaperRepository.js';
import { CitationRepository } from '../../src/domain/repositories/CitationRepository.js';
import { GET } from '../../src/api/expand/[id]/route.js';

describe('Challenger M2_2: Adversarial Expand Route Integration Suite', () => {
  const physicalDbPath = path.join(process.cwd(), 'data', 'papers.db');
  let initialMtime = 0;
  let initialSize = 0;
  const colId = 'col-adv-expand-test';
  let originalFetch: typeof globalThis.fetch;

  before(() => {
    if (fs.existsSync(physicalDbPath)) {
      const stats = fs.statSync(physicalDbPath);
      initialMtime = stats.mtimeMs;
      initialSize = stats.size;
    }

    const db = getDb();
    // Disable background smart backup from touching disk
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
      'last_db_backup_time',
      Date.now().toString()
    );

    // Create test collection
    db.prepare('INSERT OR IGNORE INTO collections (id, name) VALUES (?, ?)').run(
      colId,
      'Adversarial Test Collection'
    );

    originalFetch = globalThis.fetch;
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM citations WHERE collectionId = ?').run(colId);
    db.prepare('DELETE FROM papers WHERE collectionId = ?').run(colId);
    db.prepare('DELETE FROM api_cache').run();
  });

  after(() => {
    globalThis.fetch = originalFetch;
    if (fs.existsSync(physicalDbPath)) {
      const stats = fs.statSync(physicalDbPath);
      assert.strictEqual(stats.mtimeMs, initialMtime, 'Physical DB mtime was modified!');
      assert.strictEqual(stats.size, initialSize, 'Physical DB size was modified!');
    }
  });

  describe('1. Collision Handling: Existing seed paper expanded as recommended', () => {
    it('ignores collision without 500 error and preserves seed status, notes, and localTags', async () => {
      // Setup existing seed papers in the collection
      PaperRepository.addPaper(
        {
          id: 'seed-root',
          title: 'Root Seed Paper',
          authors: ['Root Author'],
          abstract: 'Root Abstract',
          year: 2021
        },
        colId,
        'seed'
      );

      PaperRepository.addPaper(
        {
          id: 'seed-existing-collision',
          title: 'Existing Foundational Seed Paper',
          authors: ['Seed Author'],
          abstract: 'Important Foundational Abstract',
          year: 2019
        },
        colId,
        'seed'
      );

      // Add custom notes and localTags to seed-existing-collision to verify they are not wiped
      PaperRepository.updatePaper(
        'seed-existing-collision',
        colId,
        'seed',
        JSON.stringify(['key-reference', 'reviewed']),
        'Critical user notes that must never be overwritten'
      );

      const beforeExpand = PaperRepository.getPaper('seed-existing-collision', colId);
      assert.strictEqual(beforeExpand.status, 'seed');
      assert.strictEqual(beforeExpand.notes, 'Critical user notes that must never be overwritten');
      assert.deepStrictEqual(beforeExpand.localTags, ['key-reference', 'reviewed']);

      // Mock fetch: OpenAlex returns citations for seed-root containing seed-existing-collision plus a new paper
      globalThis.fetch = async (url: any) => {
        const urlStr = String(url);
        if (urlStr.includes('filter=cites:seed-root')) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  id: 'https://openalex.org/seed-existing-collision',
                  doi: '10.1000/seed-collision',
                  title: 'Overwritten Attempt Title',
                  publication_year: 2019,
                  cited_by_count: 50,
                  authorships: [{ author: { display_name: 'Seed Author', id: 'A1' } }],
                  abstract_inverted_index: { New: [0], Abstract: [1] },
                  referenced_works: []
                },
                {
                  id: 'https://openalex.org/new-citation-paper-1',
                  doi: '10.1000/new-cit-1',
                  title: 'Brand New Recommended Paper 1',
                  publication_year: 2023,
                  cited_by_count: 10,
                  authorships: [{ author: { display_name: 'New Author', id: 'A2' } }],
                  abstract_inverted_index: { Novel: [0], Finding: [1] },
                  referenced_works: []
                }
              ]
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      };

      // Execute expand route handler
      const req = new Request(
        `http://localhost:3000/api/expand/seed-root?collectionId=${colId}&type=citations`
      );
      const res = await GET(req, { params: Promise.resolve({ id: 'seed-root' }) });

      // Verification: Status must be 200 (not 500)
      assert.strictEqual(res.status, 200, 'Expand route must return HTTP 200 on collision');
      const body = await res.json();
      assert.ok(body.citations);
      assert.strictEqual(body.citations.length, 2);

      // Verification: seed-existing-collision must retain seed status, original notes, and localTags
      const afterExpandSeed = PaperRepository.getPaper('seed-existing-collision', colId);
      assert.strictEqual(afterExpandSeed.status, 'seed', 'Status must remain "seed" after expansion collision');
      assert.strictEqual(
        afterExpandSeed.title,
        'Existing Foundational Seed Paper',
        'Original title must be preserved'
      );
      assert.strictEqual(
        afterExpandSeed.notes,
        'Critical user notes that must never be overwritten',
        'User notes must not be overwritten'
      );
      assert.deepStrictEqual(
        afterExpandSeed.localTags,
        ['key-reference', 'reviewed'],
        'User localTags must not be overwritten'
      );

      // Verification: new-citation-paper-1 must be saved with status 'recommended'
      const afterExpandNew = PaperRepository.getPaper('new-citation-paper-1', colId);
      assert.ok(afterExpandNew, 'New citation paper must be saved');
      assert.strictEqual(afterExpandNew.status, 'recommended');
      assert.strictEqual(afterExpandNew.title, 'Brand New Recommended Paper 1');

      // Verification: Citations table must pair seed-existing-collision -> seed-root and new-citation-paper-1 -> seed-root
      const links = CitationRepository.getLinksForCollection(colId);
      const collisionLink = links.find(
        (l) => l.source === 'seed-existing-collision' && l.target === 'seed-root'
      );
      const newLink = links.find(
        (l) => l.source === 'new-citation-paper-1' && l.target === 'seed-root'
      );

      assert.ok(collisionLink, 'Citation link for collision paper must be recorded');
      assert.ok(newLink, 'Citation link for new paper must be recorded');
    });
  });

  describe('2. Pairing with CitationRepository: Directionality and Cross-Edges', () => {
    it('correctly creates citation edges (source: citation -> target: id) and reference edges (source: id -> target: reference)', async () => {
      PaperRepository.addPaper({ id: 'core-paper', title: 'Core Paper' }, colId, 'seed');

      globalThis.fetch = async (url: any) => {
        const urlStr = String(url);
        if (urlStr.includes('filter=cites:core-paper')) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  id: 'https://openalex.org/cit-a',
                  title: 'Citation A',
                  publication_year: 2024,
                  cited_by_count: 5,
                  authorships: [],
                  abstract_inverted_index: null,
                  referenced_works: []
                }
              ]
            }),
            { status: 200 }
          );
        }
        if (urlStr.includes('/works/core-paper')) {
          return new Response(
            JSON.stringify({
              id: 'https://openalex.org/core-paper',
              title: 'Core Paper',
              publication_year: 2020,
              cited_by_count: 50,
              authorships: [],
              abstract_inverted_index: null,
              referenced_works: ['https://openalex.org/ref-b']
            }),
            { status: 200 }
          );
        }
        if (urlStr.includes('openalex:ref-b')) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  id: 'https://openalex.org/ref-b',
                  title: 'Reference B',
                  publication_year: 2018,
                  cited_by_count: 100,
                  authorships: [],
                  abstract_inverted_index: null,
                  referenced_works: []
                }
              ]
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      };

      const req = new Request(
        `http://localhost:3000/api/expand/core-paper?collectionId=${colId}&type=both`
      );
      const res = await GET(req, { params: Promise.resolve({ id: 'core-paper' }) });
      assert.strictEqual(res.status, 200);

      const links = CitationRepository.getLinksForCollection(colId);

      // Citations: cit-a cites core-paper -> source: 'cit-a', target: 'core-paper'
      const citLink = links.find((l) => l.source === 'cit-a' && l.target === 'core-paper');
      assert.ok(citLink, 'Citation link direction must be citation -> seed');

      // References: core-paper references ref-b -> source: 'core-paper', target: 'ref-b'
      const refLink = links.find((l) => l.source === 'core-paper' && l.target === 'ref-b');
      assert.ok(refLink, 'Reference link direction must be seed -> reference');
    });

    it('correctly discovers and caches cross-edges between expanded papers', async () => {
      PaperRepository.addPaper({ id: 'pivot-paper', title: 'Pivot Paper' }, colId, 'seed');

      globalThis.fetch = async (url: any) => {
        const urlStr = String(url);
        if (urlStr.includes('filter=cites:pivot-paper')) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  id: 'https://openalex.org/cit-1',
                  title: 'Citation 1',
                  publication_year: 2023,
                  cited_by_count: 2,
                  authorships: [],
                  abstract_inverted_index: null,
                  // cit-1 also cites cit-2 (cross-edge!)
                  referenced_works: ['https://openalex.org/cit-2']
                },
                {
                  id: 'https://openalex.org/cit-2',
                  title: 'Citation 2',
                  publication_year: 2022,
                  cited_by_count: 8,
                  authorships: [],
                  abstract_inverted_index: null,
                  referenced_works: []
                }
              ]
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      };

      const req = new Request(
        `http://localhost:3000/api/expand/pivot-paper?collectionId=${colId}&type=citations`
      );
      const res = await GET(req, { params: Promise.resolve({ id: 'pivot-paper' }) });
      assert.strictEqual(res.status, 200);

      const links = CitationRepository.getLinksForCollection(colId);

      // Main expansion edges
      assert.ok(links.some((l) => l.source === 'cit-1' && l.target === 'pivot-paper'));
      assert.ok(links.some((l) => l.source === 'cit-2' && l.target === 'pivot-paper'));

      // Cross-edge: cit-1 -> cit-2
      assert.ok(
        links.some((l) => l.source === 'cit-1' && l.target === 'cit-2'),
        'Cross-edge between newly expanded papers must be cached'
      );
    });
  });

  describe('3. N+1 Loop Elimination Oracle: Transaction Batching Verification', () => {
    it('executes bulk inserts inside single db.transaction instead of N individual transactions', async () => {
      PaperRepository.addPaper({ id: 'batch-root', title: 'Batch Root' }, colId, 'seed');

      const batchCount = 40;
      const mockCitations = Array.from({ length: batchCount }, (_, i) => ({
        id: `https://openalex.org/perf-cit-${i}`,
        title: `Perf Citation Title ${i}`,
        publication_year: 2020 + (i % 4),
        cited_by_count: i,
        authorships: [{ author: { display_name: `Perf Author ${i}`, id: `PA${i}` } }],
        abstract_inverted_index: null,
        referenced_works: []
      }));

      globalThis.fetch = async (url: any) => {
        const urlStr = String(url);
        if (urlStr.includes('filter=cites:batch-root')) {
          return new Response(JSON.stringify({ results: mockCitations }), { status: 200 });
        }
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      };

      const db = getDb();
      let transactionInvocations = 0;
      const originalTransaction = db.transaction.bind(db);

      // Spy on db.transaction
      db.transaction = ((fn: any) => {
        const wrappedTx = originalTransaction(fn);
        return ((...args: any[]) => {
          transactionInvocations++;
          return wrappedTx(...args);
        }) as any;
      }) as any;

      try {
        const req = new Request(
          `http://localhost:3000/api/expand/batch-root?collectionId=${colId}&type=citations`
        );
        const res = await GET(req, { params: Promise.resolve({ id: 'batch-root' }) });
        assert.strictEqual(res.status, 200);

        // In the old N+1 code:
        // PaperRepository.addPaper was called 40 times -> 40 individual transactions (or autocommit statements)
        // CitationRepository.addLinks was called 1 time -> 1 transaction
        // Total transactions would be >= 41.
        //
        // With M2 batching:
        // PaperRepository.addPapers is called 1 time -> exactly 1 db.transaction execution for all 40 papers.
        // CitationRepository.addLinks is called 1 time -> exactly 1 db.transaction execution for all 40 links.
        // Cross-edge caching (if any) -> 0 or 1 transaction.
        // Total transactions must be <= 3, NOT 41!
        assert.ok(
          transactionInvocations <= 3,
          `Expected <= 3 batched transactions for ${batchCount} papers, but observed ${transactionInvocations}. N+1 loop has returned!`
        );

        // Verify all 40 papers and links were persisted
        const storedPapers = PaperRepository.getPapersForCollection(colId);
        // 40 citations + 1 batch-root = 41 papers
        assert.strictEqual(storedPapers.length, 41);

        const storedLinks = CitationRepository.getLinksForCollection(colId);
        assert.strictEqual(storedLinks.length, 40);
      } finally {
        db.transaction = originalTransaction;
      }
    });
  });

  describe('4. Adversarial Stress & Edge Cases', () => {
    it('handles intra-batch duplicate citations gracefully without constraint error or duplication', async () => {
      PaperRepository.addPaper({ id: 'dup-root', title: 'Duplicate Root' }, colId, 'seed');

      // Duplicate paper returned 3 times in citations array
      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            results: [
              {
                id: 'https://openalex.org/dup-cit',
                title: 'Duplicate Citation Paper',
                publication_year: 2022,
                cited_by_count: 15,
                authorships: [],
                abstract_inverted_index: null,
                referenced_works: []
              },
              {
                id: 'https://openalex.org/dup-cit',
                title: 'Duplicate Citation Paper Second Occurrence',
                publication_year: 2022,
                cited_by_count: 15,
                authorships: [],
                abstract_inverted_index: null,
                referenced_works: []
              },
              {
                id: 'https://openalex.org/unique-cit',
                title: 'Unique Citation Paper',
                publication_year: 2021,
                cited_by_count: 5,
                authorships: [],
                abstract_inverted_index: null,
                referenced_works: []
              }
            ]
          }),
          { status: 200 }
        );
      };

      const req = new Request(
        `http://localhost:3000/api/expand/dup-root?collectionId=${colId}&type=citations`
      );
      const res = await GET(req, { params: Promise.resolve({ id: 'dup-root' }) });
      assert.strictEqual(res.status, 200);

      // Verify no constraint error, exactly 1 row for dup-cit
      const dupPaper = PaperRepository.getPaper('dup-cit', colId);
      assert.ok(dupPaper);
      assert.strictEqual(dupPaper.title, 'Duplicate Citation Paper');

      const allPapers = PaperRepository.getPapersForCollection(colId);
      // dup-root, dup-cit, unique-cit = 3 papers total
      assert.strictEqual(allPapers.length, 3);

      const links = CitationRepository.getLinksForCollection(colId);
      // 2 unique links: dup-cit -> dup-root, unique-cit -> dup-root
      assert.strictEqual(links.length, 2);
    });

    it('handles paper occurring in both citations and references in same request', async () => {
      PaperRepository.addPaper({ id: 'mutual-root', title: 'Mutual Root' }, colId, 'seed');

      globalThis.fetch = async (url: any) => {
        const urlStr = String(url);
        if (urlStr.includes('filter=cites:mutual-root')) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  id: 'https://openalex.org/mutual-peer',
                  title: 'Peer Paper',
                  publication_year: 2022,
                  cited_by_count: 30,
                  authorships: [],
                  abstract_inverted_index: null,
                  referenced_works: []
                }
              ]
            }),
            { status: 200 }
          );
        }
        if (urlStr.includes('/works/mutual-root')) {
          return new Response(
            JSON.stringify({
              id: 'https://openalex.org/mutual-root',
              title: 'Mutual Root',
              publication_year: 2021,
              cited_by_count: 40,
              authorships: [],
              abstract_inverted_index: null,
              referenced_works: ['https://openalex.org/mutual-peer']
            }),
            { status: 200 }
          );
        }
        if (urlStr.includes('openalex:mutual-peer')) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  id: 'https://openalex.org/mutual-peer',
                  title: 'Peer Paper (from ref fetch)',
                  publication_year: 2022,
                  cited_by_count: 30,
                  authorships: [],
                  abstract_inverted_index: null,
                  referenced_works: []
                }
              ]
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      };

      const req = new Request(
        `http://localhost:3000/api/expand/mutual-root?collectionId=${colId}&type=both`
      );
      const res = await GET(req, { params: Promise.resolve({ id: 'mutual-root' }) });
      assert.strictEqual(res.status, 200);

      // Verify mutual-peer saved once
      const p = PaperRepository.getPaper('mutual-peer', colId);
      assert.ok(p);
      assert.strictEqual(p.status, 'recommended');

      // Verify two reciprocal links exist in citations table
      const links = CitationRepository.getLinksForCollection(colId);
      assert.strictEqual(links.length, 2);
      assert.ok(links.some((l) => l.source === 'mutual-peer' && l.target === 'mutual-root'));
      assert.ok(links.some((l) => l.source === 'mutual-root' && l.target === 'mutual-peer'));
    });

    it('does not crash or write to DB when collectionId is omitted', async () => {
      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            results: [
              {
                id: 'https://openalex.org/orphan-cit',
                title: 'Orphan Citation Paper',
                publication_year: 2024,
                cited_by_count: 1,
                authorships: [],
                abstract_inverted_index: null,
                referenced_works: []
              }
            ]
          }),
          { status: 200 }
        );
      };

      const req = new Request('http://localhost:3000/api/expand/orphan-root?type=citations');
      const res = await GET(req, { params: Promise.resolve({ id: 'orphan-root' }) });
      assert.strictEqual(res.status, 200);

      const body = await res.json();
      assert.strictEqual(body.citations.length, 1);

      // Verify nothing written to any collection in papers table
      const allPapers = PaperRepository.getPapersForCollection(colId);
      assert.strictEqual(allPapers.length, 0);
    });

    it('is fully idempotent under repeated calls', async () => {
      PaperRepository.addPaper({ id: 'idem-root', title: 'Idempotency Root' }, colId, 'seed');

      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            results: [
              {
                id: 'https://openalex.org/idem-cit',
                title: 'Idempotent Citation',
                publication_year: 2023,
                cited_by_count: 20,
                authorships: [],
                abstract_inverted_index: null,
                referenced_works: []
              }
            ]
          }),
          { status: 200 }
        );
      };

      // Call 1
      const req1 = new Request(
        `http://localhost:3000/api/expand/idem-root?collectionId=${colId}&type=citations`
      );
      const res1 = await GET(req1, { params: Promise.resolve({ id: 'idem-root' }) });
      assert.strictEqual(res1.status, 200);

      // Call 2 (identical repeated call)
      const req2 = new Request(
        `http://localhost:3000/api/expand/idem-root?collectionId=${colId}&type=citations`
      );
      const res2 = await GET(req2, { params: Promise.resolve({ id: 'idem-root' }) });
      assert.strictEqual(res2.status, 200);

      const papers = PaperRepository.getPapersForCollection(colId);
      assert.strictEqual(papers.length, 2);

      const links = CitationRepository.getLinksForCollection(colId);
      assert.strictEqual(links.length, 1);
    });
  });

  describe('5. Physical Database Safety Verification', () => {
    it('verifies data/papers.db was never modified in size or timestamp', () => {
      if (fs.existsSync(physicalDbPath)) {
        const stats = fs.statSync(physicalDbPath);
        assert.strictEqual(stats.mtimeMs, initialMtime, 'Physical DB mtime was modified!');
        assert.strictEqual(stats.size, initialSize, 'Physical DB size was modified!');
      }
    });
  });
});
