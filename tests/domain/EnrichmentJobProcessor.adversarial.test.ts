import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Enforce in-memory database and isolated scratch directory
process.env.SQLITE_DB_PATH = ':memory:';
process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'lit-review-graph-adv-m3-' + Date.now());

import { getDb } from '../../src/lib/db.js';
import { QueueRepository } from '../../src/domain/repositories/QueueRepository.js';
import { PaperRepository } from '../../src/domain/repositories/PaperRepository.js';
import { CitationRepository } from '../../src/domain/repositories/CitationRepository.js';
import { EnrichmentJobProcessor } from '../../src/domain/services/EnrichmentJobProcessor.js';

describe('EnrichmentJobProcessor & QueueRepository Adversarial Stress Suite (Milestone 3)', () => {
  const physicalDbPath = path.join(process.cwd(), 'data', 'papers.db');
  let initialMtime = 0;
  let initialSize = 0;

  const colAlpha = 'adv-col-alpha';
  const colBeta = 'adv-col-beta';
  const colGamma = 'adv-col-gamma';

  let originalFetch: typeof globalThis.fetch;

  before(() => {
    if (fs.existsSync(physicalDbPath)) {
      const stats = fs.statSync(physicalDbPath);
      initialMtime = stats.mtimeMs;
      initialSize = stats.size;
    }

    const db = getDb();
    // Guard against background smart backup touching disk
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
      'last_db_backup_time',
      Date.now().toString()
    );

    // Initialize test collections
    db.prepare('INSERT OR IGNORE INTO collections (id, name) VALUES (?, ?)').run(colAlpha, 'Collection Alpha');
    db.prepare('INSERT OR IGNORE INTO collections (id, name) VALUES (?, ?)').run(colBeta, 'Collection Beta');
    db.prepare('INSERT OR IGNORE INTO collections (id, name) VALUES (?, ?)').run(colGamma, 'Collection Gamma');

    originalFetch = globalThis.fetch;
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM retry_queue').run();
    db.prepare('DELETE FROM citations WHERE collectionId IN (?, ?, ?)').run(colAlpha, colBeta, colGamma);
    db.prepare('DELETE FROM papers WHERE collectionId IN (?, ?, ?)').run(colAlpha, colBeta, colGamma);
    db.prepare('DELETE FROM api_cache').run();
  });

  after(() => {
    globalThis.fetch = originalFetch;
    if (fs.existsSync(physicalDbPath)) {
      const stats = fs.statSync(physicalDbPath);
      assert.strictEqual(stats.mtimeMs, initialMtime, 'CRITICAL: Physical DB mtime was modified!');
      assert.strictEqual(stats.size, initialSize, 'CRITICAL: Physical DB size was modified!');
    }
  });

  describe('1. Multi-Collection Simultaneous Queueing & Strict Partitioning Oracle', () => {
    it('strictly partitions papers, citations, and references across simultaneous multi-collection batches', async () => {
      // 1. Seed papers across 3 distinct collections
      PaperRepository.addPaper({ id: 'alpha-root', title: 'Alpha Root Paper' }, colAlpha, 'seed');
      PaperRepository.addPaper({ id: 'beta-root', title: 'Beta Root Paper' }, colBeta, 'seed');
      PaperRepository.addPaper({ id: 'gamma-root', title: 'Gamma Root Paper' }, colGamma, 'seed');

      // 2. Queue jobs with different operations across the 3 collections
      QueueRepository.addQueueItem('alpha-root', 'citations', colAlpha);
      QueueRepository.addQueueItem('beta-root', 'references', colBeta);
      QueueRepository.addQueueItem('gamma-root', 'both', colGamma);

      // 3. Mock fetch returning isolated data for each root
      globalThis.fetch = async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes('api.semanticscholar.org')) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }

        // Alpha: Citations
        if (u.includes('filter=cites:alpha-root')) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  id: 'https://openalex.org/alpha-cit-1',
                  title: 'Alpha Citing Paper 1',
                  publication_year: 2024,
                  cited_by_count: 10,
                  authorships: [],
                  referenced_works: []
                },
                {
                  id: 'https://openalex.org/alpha-cit-2',
                  title: 'Alpha Citing Paper 2',
                  publication_year: 2023,
                  cited_by_count: 5,
                  authorships: [],
                  referenced_works: []
                }
              ]
            }),
            { status: 200 }
          );
        }

        // Beta: References
        if (u.includes('/works/beta-root')) {
          return new Response(
            JSON.stringify({
              id: 'https://openalex.org/beta-root',
              title: 'Beta Root Paper',
              publication_year: 2021,
              cited_by_count: 15,
              referenced_works: ['https://openalex.org/beta-ref-1', 'https://openalex.org/beta-ref-2']
            }),
            { status: 200 }
          );
        }
        if (u.includes('filter=openalex:') && u.includes('beta-ref-1')) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  id: 'https://openalex.org/beta-ref-1',
                  title: 'Beta Ref Paper 1',
                  publication_year: 2019,
                  cited_by_count: 50,
                  referenced_works: []
                },
                {
                  id: 'https://openalex.org/beta-ref-2',
                  title: 'Beta Ref Paper 2',
                  publication_year: 2018,
                  cited_by_count: 30,
                  referenced_works: []
                }
              ]
            }),
            { status: 200 }
          );
        }

        // Gamma: Both citations & references
        if (u.includes('filter=cites:gamma-root')) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  id: 'https://openalex.org/gamma-cit-1',
                  title: 'Gamma Cit Paper 1',
                  publication_year: 2025,
                  cited_by_count: 2,
                  referenced_works: []
                }
              ]
            }),
            { status: 200 }
          );
        }
        if (u.includes('/works/gamma-root')) {
          return new Response(
            JSON.stringify({
              id: 'https://openalex.org/gamma-root',
              title: 'Gamma Root Paper',
              publication_year: 2022,
              cited_by_count: 20,
              referenced_works: ['https://openalex.org/gamma-ref-1']
            }),
            { status: 200 }
          );
        }
        if (u.includes('filter=openalex:') && u.includes('gamma-ref-1')) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  id: 'https://openalex.org/gamma-ref-1',
                  title: 'Gamma Ref Paper 1',
                  publication_year: 2020,
                  cited_by_count: 40,
                  referenced_works: []
                }
              ]
            }),
            { status: 200 }
          );
        }

        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      };

      // 4. Process all 3 in a single batch
      await EnrichmentJobProcessor.processBatch(10);

      // Verify all queue items marked completed
      const counts = QueueRepository.getStatusCounts();
      assert.strictEqual(counts.pending, 0, 'All 3 items must be processed');
      assert.strictEqual(counts.failed, 0, 'No items should fail');

      // 5. Partition Verification: Papers
      const alphaPapers = PaperRepository.getPapersForCollection(colAlpha);
      const betaPapers = PaperRepository.getPapersForCollection(colBeta);
      const gammaPapers = PaperRepository.getPapersForCollection(colGamma);

      const alphaIds = new Set(alphaPapers.map((p) => p.id));
      const betaIds = new Set(betaPapers.map((p) => p.id));
      const gammaIds = new Set(gammaPapers.map((p) => p.id));

      // Alpha has only alpha papers
      assert.strictEqual(alphaPapers.length, 3);
      assert.ok(alphaIds.has('alpha-root'));
      assert.ok(alphaIds.has('alpha-cit-1'));
      assert.ok(alphaIds.has('alpha-cit-2'));
      assert.ok(!alphaIds.has('beta-ref-1'), 'Beta paper must not leak into Alpha');
      assert.ok(!alphaIds.has('gamma-cit-1'), 'Gamma paper must not leak into Alpha');

      // Beta has only beta papers
      assert.strictEqual(betaPapers.length, 3);
      assert.ok(betaIds.has('beta-root'));
      assert.ok(betaIds.has('beta-ref-1'));
      assert.ok(betaIds.has('beta-ref-2'));
      assert.ok(!betaIds.has('alpha-cit-1'), 'Alpha paper must not leak into Beta');

      // Gamma has only gamma papers
      assert.strictEqual(gammaPapers.length, 3);
      assert.ok(gammaIds.has('gamma-root'));
      assert.ok(gammaIds.has('gamma-cit-1'));
      assert.ok(gammaIds.has('gamma-ref-1'));

      // 6. Partition Verification: Citation Links
      const alphaLinks = CitationRepository.getLinksForCollection(colAlpha);
      const betaLinks = CitationRepository.getLinksForCollection(colBeta);
      const gammaLinks = CitationRepository.getLinksForCollection(colGamma);

      // Alpha links: citing -> root
      assert.strictEqual(alphaLinks.length, 2);
      assert.ok(alphaLinks.every((l) => l.target === 'alpha-root'));
      assert.ok(alphaLinks.some((l) => l.source === 'alpha-cit-1'));
      assert.ok(alphaLinks.some((l) => l.source === 'alpha-cit-2'));

      // Beta links: root -> referenced
      assert.strictEqual(betaLinks.length, 2);
      assert.ok(betaLinks.every((l) => l.source === 'beta-root'));
      assert.ok(betaLinks.some((l) => l.target === 'beta-ref-1'));
      assert.ok(betaLinks.some((l) => l.target === 'beta-ref-2'));

      // Gamma links: both incoming citation and outgoing reference
      assert.strictEqual(gammaLinks.length, 2);
      assert.ok(gammaLinks.some((l) => l.source === 'gamma-cit-1' && l.target === 'gamma-root'));
      assert.ok(gammaLinks.some((l) => l.source === 'gamma-root' && l.target === 'gamma-ref-1'));
    });

    it('handles identical paper ID across multiple collections with independent lifecycle', async () => {
      const sharedId = 'shared-multiverse-paper';

      // Seed same paper in both Alpha and Beta
      PaperRepository.addPaper({ id: sharedId, title: 'Shared Root Paper' }, colAlpha, 'seed');
      PaperRepository.addPaper({ id: sharedId, title: 'Shared Root Paper' }, colBeta, 'seed');

      QueueRepository.addQueueItem(sharedId, 'citations', colAlpha);
      QueueRepository.addQueueItem(sharedId, 'citations', colBeta);

      globalThis.fetch = async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes('filter=cites:' + sharedId)) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  id: 'https://openalex.org/shared-citing-leaf',
                  title: 'Shared Citing Leaf',
                  publication_year: 2023,
                  cited_by_count: 8,
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

      // Both collections have the leaf
      const leafAlpha = PaperRepository.getPaper('shared-citing-leaf', colAlpha);
      const leafBeta = PaperRepository.getPaper('shared-citing-leaf', colBeta);
      assert.ok(leafAlpha);
      assert.ok(leafBeta);

      // Now mutate status in Alpha
      PaperRepository.updatePaperStatus('shared-citing-leaf', colAlpha, 'starred');

      // Verify Beta status remains 'recommended' (no cross-collection state pollution)
      assert.strictEqual(PaperRepository.getPaper('shared-citing-leaf', colAlpha)?.status, 'starred');
      assert.strictEqual(PaperRepository.getPaper('shared-citing-leaf', colBeta)?.status, 'recommended');

      // Now delete from Alpha
      PaperRepository.deletePaper('shared-citing-leaf', colAlpha);
      assert.strictEqual(PaperRepository.getPaper('shared-citing-leaf', colAlpha), null);
      assert.ok(PaperRepository.getPaper('shared-citing-leaf', colBeta), 'Paper in Beta must survive Alpha deletion');
    });
  });

  describe('2. Queue Deduplication Matrix & Boundary Conditions', () => {
    it('survives an exact duplicate storm of 50 rapid enqueues for the same collection', () => {
      for (let i = 0; i < 50; i++) {
        QueueRepository.addQueueItem('storm-paper', 'both', colAlpha);
      }

      const pending = QueueRepository.getPendingItems(100);
      assert.strictEqual(pending.length, 1, '50 duplicate enqueues must result in exactly 1 pending item');
      assert.strictEqual(pending[0].paperId, 'storm-paper');
      assert.strictEqual(pending[0].collectionId, colAlpha);
    });

    it('correctly discriminates across the full Cartesian product of (paper, type, collectionId)', () => {
      const types: Array<'citations' | 'references' | 'both'> = ['citations', 'references', 'both'];
      const collections: Array<string | undefined> = [colAlpha, colBeta, undefined];

      // Enqueue 3 x 3 = 9 distinct variants
      for (const col of collections) {
        for (const typ of types) {
          QueueRepository.addQueueItem('matrix-paper', typ, col);
        }
      }

      // Re-enqueue all 9 variants (duplicates)
      for (const col of collections) {
        for (const typ of types) {
          QueueRepository.addQueueItem('matrix-paper', typ, col);
        }
      }

      const allPending = QueueRepository.getPendingItems(50);
      assert.strictEqual(allPending.length, 9, 'Exactly 9 distinct combinations must exist without duplication');

      // Check undefined collectionId items have null in SQLite
      const nullColItems = allPending.filter((i) => i.collectionId === null);
      assert.strictEqual(nullColItems.length, 3);
      assert.ok(nullColItems.some((i) => i.type === 'citations'));
      assert.ok(nullColItems.some((i) => i.type === 'references'));
      assert.ok(nullColItems.some((i) => i.type === 'both'));
    });

    it('permits re-queueing after terminal state transitions (completed and failed)', () => {
      QueueRepository.addQueueItem('lifecycle-paper', 'citations', colAlpha);
      let items = QueueRepository.getPendingItems(10);
      assert.strictEqual(items.length, 1);

      // Transition to completed
      QueueRepository.updateStatus(items[0].id, 'completed');
      assert.strictEqual(QueueRepository.getPendingItems(10).length, 0);

      // Enqueue again -> must be permitted
      QueueRepository.addQueueItem('lifecycle-paper', 'citations', colAlpha);
      items = QueueRepository.getPendingItems(10);
      assert.strictEqual(items.length, 1);

      // Transition to failed
      QueueRepository.updateStatus(items[0].id, 'failed');
      assert.strictEqual(QueueRepository.getPendingItems(10).length, 0);

      // Enqueue again -> must be permitted
      QueueRepository.addQueueItem('lifecycle-paper', 'citations', colAlpha);
      items = QueueRepository.getPendingItems(10);
      assert.strictEqual(items.length, 1);
      assert.strictEqual(items[0].status, 'pending');
    });
  });

  describe('3. Rate Limit Deferral & Partial Batch Preservation Oracle', () => {
    it('defers rate-limited item, halts batch processing, and leaves subsequent items pending', async () => {
      // 3 items in queue: item-1 succeeds, item-2 hits RATE_LIMIT, item-3 never attempted
      PaperRepository.addPaper({ id: 'batch-p1', title: 'Batch Paper 1' }, colAlpha, 'seed');
      PaperRepository.addPaper({ id: 'batch-p2', title: 'Batch Paper 2' }, colAlpha, 'seed');
      PaperRepository.addPaper({ id: 'batch-p3', title: 'Batch Paper 3' }, colAlpha, 'seed');

      QueueRepository.addQueueItem('batch-p1', 'citations', colAlpha);
      QueueRepository.addQueueItem('batch-p2', 'citations', colAlpha);
      QueueRepository.addQueueItem('batch-p3', 'citations', colAlpha);

      let p2CallCount = 0;
      globalThis.fetch = async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes('filter=cites:batch-p1')) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  id: 'https://openalex.org/res-p1',
                  title: 'Result P1',
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
        if (u.includes('filter=cites:batch-p2')) {
          p2CallCount++;
          throw new Error('RATE_LIMIT');
        }
        if (u.includes('filter=cites:batch-p3')) {
          throw new Error('Should NOT have been reached during rate limit backoff!');
        }
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      };

      // Run batch
      await EnrichmentJobProcessor.processBatch(10);

      assert.strictEqual(p2CallCount, 1);

      // Check statuses
      const pendingAfter = QueueRepository.getPendingItems(10);
      assert.strictEqual(pendingAfter.length, 2, 'Both item-2 (deferred) and item-3 (unattempted) must stay pending');
      assert.strictEqual(pendingAfter[0].paperId, 'batch-p2');
      assert.strictEqual(pendingAfter[1].paperId, 'batch-p3');

      const counts = QueueRepository.getStatusCounts();
      assert.strictEqual(counts.pending, 2);
      assert.strictEqual(counts.failed, 0, 'No item should be marked failed on RATE_LIMIT');

      // Item 1 papers must be persisted
      assert.ok(PaperRepository.getPaper('res-p1', colAlpha), 'Item 1 completed papers must be persisted');

      // Next tick: rate limit lifted, remaining items should succeed
      globalThis.fetch = async (url: string | URL | Request) => {
        const u = String(url);
        return new Response(
          JSON.stringify({
            results: [
              {
                id: 'https://openalex.org/recovered-paper',
                title: 'Recovered Paper',
                publication_year: 2024,
                cited_by_count: 2,
                authorships: [],
                referenced_works: []
              }
            ]
          }),
          { status: 200 }
        );
      };

      await EnrichmentJobProcessor.processBatch(10);

      const countsAfterRecovery = QueueRepository.getStatusCounts();
      assert.strictEqual(countsAfterRecovery.pending, 0, 'All items must now be completed after recovery');
      assert.strictEqual(countsAfterRecovery.failed, 0);
    });

    it('defers item on S2_RATE_LIMIT and does not mark as failed', async () => {
      PaperRepository.addPaper({ id: 's2-defer-root', title: 'S2 Defer Root' }, colBeta, 'seed');
      QueueRepository.addQueueItem('s2-defer-root', 'citations', colBeta);

      globalThis.fetch = async () => {
        throw new Error('S2_RATE_LIMIT');
      };

      await EnrichmentJobProcessor.processBatch(5);

      const counts = QueueRepository.getStatusCounts();
      assert.strictEqual(counts.pending, 1, 'S2 rate limit must defer item in pending state');
      assert.strictEqual(counts.failed, 0);
    });
  });

  describe('4. Missing Papers & Fault Isolation Oracle', () => {
    it('marks unresolvable orphan paper failed without aborting subsequent valid queue items', async () => {
      // 1. Ghost paper (no collectionId and not in db)
      QueueRepository.addQueueItem('ghost-unresolvable-paper', 'citations');

      // 2. Valid paper in ColAlpha
      PaperRepository.addPaper({ id: 'valid-peer', title: 'Valid Peer' }, colAlpha, 'seed');
      QueueRepository.addQueueItem('valid-peer', 'citations', colAlpha);

      globalThis.fetch = async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes('filter=cites:valid-peer')) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  id: 'https://openalex.org/valid-peer-cit',
                  title: 'Valid Peer Citation',
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

      await EnrichmentJobProcessor.processBatch(10);

      const counts = QueueRepository.getStatusCounts();
      assert.strictEqual(counts.pending, 0, 'No pending items should remain');
      assert.strictEqual(counts.failed, 1, 'Orphan ghost item must be marked failed');

      // Valid peer citations must have succeeded and persisted
      const saved = PaperRepository.getPaper('valid-peer-cit', colAlpha);
      assert.ok(saved, 'Subsequent valid item must be persisted despite earlier orphan failure');
      assert.strictEqual(saved.title, 'Valid Peer Citation');
    });

    it('isolates 500 error on one paper and allows next item in batch to succeed', async () => {
      PaperRepository.addPaper({ id: 'bad-500-paper', title: 'Bad 500' }, colAlpha, 'seed');
      PaperRepository.addPaper({ id: 'good-paper', title: 'Good Paper' }, colAlpha, 'seed');

      QueueRepository.addQueueItem('bad-500-paper', 'citations', colAlpha);
      QueueRepository.addQueueItem('good-paper', 'citations', colAlpha);

      globalThis.fetch = async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes('bad-500-paper')) {
          throw new Error('500 Server Error from upstream API');
        }
        if (u.includes('good-paper')) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  id: 'https://openalex.org/good-cit-result',
                  title: 'Good Result',
                  publication_year: 2024,
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

      await EnrichmentJobProcessor.processBatch(10);

      const counts = QueueRepository.getStatusCounts();
      assert.strictEqual(counts.pending, 0);
      assert.strictEqual(counts.failed, 1, 'Bad item marked failed');

      const goodResult = PaperRepository.getPaper('good-cit-result', colAlpha);
      assert.ok(goodResult, 'Good item succeeded despite prior 500 failure');
    });
  });

  describe('5. Cross-Edge Discovery & Directionality Oracle', () => {
    it('correctly maps directionality of citations vs references and discovers cross-edges', async () => {
      PaperRepository.addPaper({ id: 'existing-col-node', title: 'Existing Collection Node' }, colAlpha, 'seed');
      PaperRepository.addPaper({ id: 'focal-node', title: 'Focal Node' }, colAlpha, 'seed');

      QueueRepository.addQueueItem('focal-node', 'both', colAlpha);

      globalThis.fetch = async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes('filter=cites:focal-node')) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  id: 'https://openalex.org/focal-cit',
                  title: 'Focal Citation Paper',
                  publication_year: 2024,
                  cited_by_count: 4,
                  authorships: [],
                  // focal-cit ALSO cites existing-col-node!
                  referenced_works: ['https://openalex.org/existing-col-node']
                }
              ]
            }),
            { status: 200 }
          );
        }
        if (u.includes('/works/focal-node')) {
          return new Response(
            JSON.stringify({
              id: 'https://openalex.org/focal-node',
              title: 'Focal Node',
              publication_year: 2022,
              cited_by_count: 10,
              referenced_works: ['https://openalex.org/focal-ref']
            }),
            { status: 200 }
          );
        }
        if (u.includes('filter=openalex:') && u.includes('focal-ref')) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  id: 'https://openalex.org/focal-ref',
                  title: 'Focal Reference Paper',
                  publication_year: 2018,
                  cited_by_count: 50,
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

      const links = CitationRepository.getLinksForCollection(colAlpha);

      // Verify Citation direction: focal-cit -> focal-node
      assert.ok(
        links.some((l) => l.source === 'focal-cit' && l.target === 'focal-node'),
        'Citation direction must be citing -> cited'
      );

      // Verify Reference direction: focal-node -> focal-ref
      assert.ok(
        links.some((l) => l.source === 'focal-node' && l.target === 'focal-ref'),
        'Reference direction must be paper -> referenced'
      );

      // Verify Cross-Edge discovery: focal-cit -> existing-col-node
      assert.ok(
        links.some((l) => l.source === 'focal-cit' && l.target === 'existing-col-node'),
        'Cross-edge between new citation paper and pre-existing collection paper must be discovered'
      );
    });
  });

  describe('6. Physical Database Invariance Oracle', () => {
    it('guarantees data/papers.db was never touched or modified', () => {
      if (fs.existsSync(physicalDbPath)) {
        const stats = fs.statSync(physicalDbPath);
        assert.strictEqual(stats.mtimeMs, initialMtime, 'Physical DB mtime must remain unchanged');
        assert.strictEqual(stats.size, initialSize, 'Physical DB size must remain unchanged');
      }
    });
  });
});
