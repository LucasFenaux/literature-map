import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Force in-memory database and temporary directory before any db or repository import
process.env.SQLITE_DB_PATH = ':memory:';
process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'lit-review-graph-enrichment-m3-' + Date.now());

import { getDb } from '../../src/lib/db.js';
import { QueueRepository } from '../../src/domain/repositories/QueueRepository.js';
import { PaperRepository } from '../../src/domain/repositories/PaperRepository.js';
import { CitationRepository } from '../../src/domain/repositories/CitationRepository.js';
import { EnrichmentJobProcessor } from '../../src/domain/services/EnrichmentJobProcessor.js';

describe('EnrichmentJobProcessor & QueueRepository Suite (Milestone 3)', () => {
  const physicalDbPath = path.join(process.cwd(), 'data', 'papers.db');
  let initialMtime = 0;
  let initialSize = 0;
  const col1 = 'test-collection-m3-1';
  const col2 = 'test-collection-m3-2';
  let originalFetch: typeof globalThis.fetch;

  before(() => {
    if (fs.existsSync(physicalDbPath)) {
      const stats = fs.statSync(physicalDbPath);
      initialMtime = stats.mtimeMs;
      initialSize = stats.size;
    }

    const db = getDb();
    // Prevent background smart backup from touching disk during tests
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
      'last_db_backup_time',
      Date.now().toString()
    );

    // Insert test collections
    db.prepare('INSERT OR IGNORE INTO collections (id, name) VALUES (?, ?)').run(col1, 'Collection M3 1');
    db.prepare('INSERT OR IGNORE INTO collections (id, name) VALUES (?, ?)').run(col2, 'Collection M3 2');

    originalFetch = globalThis.fetch;
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM retry_queue').run();
    db.prepare('DELETE FROM citations WHERE collectionId IN (?, ?)').run(col1, col2);
    db.prepare('DELETE FROM papers WHERE collectionId IN (?, ?)').run(col1, col2);
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

  describe('QueueRepository: collectionId Support and Deduplication', () => {
    it('stores and retrieves collectionId on queue items', () => {
      QueueRepository.addQueueItem('paper-q1', 'citations', col1);

      const pending = QueueRepository.getPendingItems(10);
      assert.strictEqual(pending.length, 1);
      assert.strictEqual(pending[0].paperId, 'paper-q1');
      assert.strictEqual(pending[0].type, 'citations');
      assert.strictEqual(pending[0].status, 'pending');
      assert.strictEqual(pending[0].collectionId, col1);
      assert.ok(pending[0].id);
      assert.ok(pending[0].createdAt);
    });

    it('stores null/undefined collectionId when omitted for backward compatibility', () => {
      QueueRepository.addQueueItem('paper-legacy', 'both');

      const pending = QueueRepository.getPendingItems(10);
      assert.strictEqual(pending.length, 1);
      assert.strictEqual(pending[0].paperId, 'paper-legacy');
      // In SQLite, omitted collectionId stores NULL
      assert.strictEqual(pending[0].collectionId, null);
    });

    it('deduplicates pending items for the same paper, type, and collectionId', () => {
      QueueRepository.addQueueItem('paper-dup', 'both', col1);
      QueueRepository.addQueueItem('paper-dup', 'both', col1);
      QueueRepository.addQueueItem('paper-dup', 'both', col1);

      const pending = QueueRepository.getPendingItems(10);
      assert.strictEqual(pending.length, 1);
      assert.strictEqual(pending[0].paperId, 'paper-dup');
      assert.strictEqual(pending[0].collectionId, col1);
    });

    it('allows same paper and type queued for different collections', () => {
      QueueRepository.addQueueItem('paper-multi', 'citations', col1);
      QueueRepository.addQueueItem('paper-multi', 'citations', col2);

      const pending = QueueRepository.getPendingItems(10);
      assert.strictEqual(pending.length, 2);

      const itemCol1 = pending.find((i) => i.collectionId === col1);
      const itemCol2 = pending.find((i) => i.collectionId === col2);
      assert.ok(itemCol1);
      assert.ok(itemCol2);
      assert.strictEqual(itemCol1.paperId, 'paper-multi');
      assert.strictEqual(itemCol2.paperId, 'paper-multi');
    });

    it('allows re-enqueueing after previous item is completed or failed', () => {
      QueueRepository.addQueueItem('paper-requeue', 'references', col1);
      let pending = QueueRepository.getPendingItems(10);
      assert.strictEqual(pending.length, 1);

      // Mark completed
      QueueRepository.updateStatus(pending[0].id, 'completed');
      pending = QueueRepository.getPendingItems(10);
      assert.strictEqual(pending.length, 0);

      // Should now allow adding again
      QueueRepository.addQueueItem('paper-requeue', 'references', col1);
      pending = QueueRepository.getPendingItems(10);
      assert.strictEqual(pending.length, 1);
      assert.strictEqual(pending[0].paperId, 'paper-requeue');
      assert.strictEqual(pending[0].status, 'pending');
    });

    it('deduplicates pending items with NULL collectionId', () => {
      QueueRepository.addQueueItem('paper-null-dup', 'citations');
      QueueRepository.addQueueItem('paper-null-dup', 'citations');

      const pending = QueueRepository.getPendingItems(10);
      assert.strictEqual(pending.length, 1);
    });
  });

  describe('EnrichmentJobProcessor: Background Citations Fetch & Persistence', () => {
    it('persists fetched citations and citation links under correct collectionId', async () => {
      // Seed paper in col1
      PaperRepository.addPaper({ id: 'seed-c1', title: 'Seed Citation Test' }, col1, 'seed');
      QueueRepository.addQueueItem('seed-c1', 'citations', col1);

      // Mock OpenAlex citations response
      globalThis.fetch = async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes('api.semanticscholar.org')) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        if (urlStr.includes('filter=cites:seed-c1')) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  id: 'https://openalex.org/cit-p1',
                  title: 'Citing Paper 1',
                  publication_year: 2024,
                  cited_by_count: 12,
                  authorships: [{ author: { display_name: 'Author A', id: 'A1' } }],
                  abstract_inverted_index: null,
                  referenced_works: []
                },
                {
                  id: 'https://openalex.org/cit-p2',
                  title: 'Citing Paper 2',
                  publication_year: 2023,
                  cited_by_count: 7,
                  authorships: [{ author: { display_name: 'Author B', id: 'A2' } }],
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

      await EnrichmentJobProcessor.processBatch(5);

      // Queue status check
      const counts = QueueRepository.getStatusCounts();
      assert.strictEqual(counts.pending, 0);

      // Papers persistence check
      const p1 = PaperRepository.getPaper('cit-p1', col1);
      const p2 = PaperRepository.getPaper('cit-p2', col1);
      assert.ok(p1, 'cit-p1 must be persisted in col1');
      assert.ok(p2, 'cit-p2 must be persisted in col1');
      assert.strictEqual(p1.status, 'recommended');
      assert.strictEqual(p2.status, 'recommended');
      assert.strictEqual(p1.title, 'Citing Paper 1');
      assert.strictEqual(p2.title, 'Citing Paper 2');

      // Citation links direction check (citing paper -> seed paper)
      const links = CitationRepository.getLinksForCollection(col1);
      assert.strictEqual(links.length, 2);
      assert.ok(links.some((l) => l.source === 'cit-p1' && l.target === 'seed-c1'));
      assert.ok(links.some((l) => l.source === 'cit-p2' && l.target === 'seed-c1'));
    });
  });

  describe('EnrichmentJobProcessor: Background References Fetch & Persistence', () => {
    it('persists fetched references and reference links under correct collectionId', async () => {
      // Seed paper in col1
      PaperRepository.addPaper({ id: 'seed-r1', title: 'Seed Reference Test' }, col1, 'seed');
      QueueRepository.addQueueItem('seed-r1', 'references', col1);

      // Mock OpenAlex works and references responses
      globalThis.fetch = async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes('api.semanticscholar.org')) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        if (urlStr.includes('/works/seed-r1')) {
          return new Response(
            JSON.stringify({
              id: 'https://openalex.org/seed-r1',
              title: 'Seed Reference Test',
              publication_year: 2022,
              cited_by_count: 50,
              authorships: [],
              abstract_inverted_index: null,
              referenced_works: ['https://openalex.org/ref-p1', 'https://openalex.org/ref-p2']
            }),
            { status: 200 }
          );
        }
        if (urlStr.includes('filter=openalex:')) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  id: 'https://openalex.org/ref-p1',
                  title: 'Referenced Paper 1',
                  publication_year: 2019,
                  cited_by_count: 80,
                  authorships: [{ author: { display_name: 'Ref Author 1', id: 'RA1' } }],
                  abstract_inverted_index: null,
                  referenced_works: []
                },
                {
                  id: 'https://openalex.org/ref-p2',
                  title: 'Referenced Paper 2',
                  publication_year: 2020,
                  cited_by_count: 45,
                  authorships: [{ author: { display_name: 'Ref Author 2', id: 'RA2' } }],
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

      await EnrichmentJobProcessor.processBatch(5);

      // Queue status check
      const counts = QueueRepository.getStatusCounts();
      assert.strictEqual(counts.pending, 0);

      // Papers persistence check
      const r1 = PaperRepository.getPaper('ref-p1', col1);
      const r2 = PaperRepository.getPaper('ref-p2', col1);
      assert.ok(r1, 'ref-p1 must be persisted in col1');
      assert.ok(r2, 'ref-p2 must be persisted in col1');
      assert.strictEqual(r1.status, 'recommended');
      assert.strictEqual(r2.status, 'recommended');
      assert.strictEqual(r1.title, 'Referenced Paper 1');
      assert.strictEqual(r2.title, 'Referenced Paper 2');

      // Reference links direction check (seed paper -> referenced paper)
      const links = CitationRepository.getLinksForCollection(col1);
      assert.strictEqual(links.length, 2);
      assert.ok(links.some((l) => l.source === 'seed-r1' && l.target === 'ref-p1'));
      assert.ok(links.some((l) => l.source === 'seed-r1' && l.target === 'ref-p2'));
    });
  });

  describe('EnrichmentJobProcessor: Both Citations & References with Cross-Edges', () => {
    it('persists citations, references, and caches cross-edges between expanded papers', async () => {
      PaperRepository.addPaper({ id: 'seed-b1', title: 'Seed Both Test' }, col1, 'seed');
      QueueRepository.addQueueItem('seed-b1', 'both', col1);

      globalThis.fetch = async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes('api.semanticscholar.org')) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        if (urlStr.includes('filter=cites:seed-b1')) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  id: 'https://openalex.org/cross-cit-1',
                  title: 'Cross Citing Paper 1',
                  publication_year: 2024,
                  cited_by_count: 10,
                  authorships: [],
                  abstract_inverted_index: null,
                  // cross-cit-1 cites cross-ref-1!
                  referenced_works: ['https://openalex.org/cross-ref-1']
                }
              ]
            }),
            { status: 200 }
          );
        }
        if (urlStr.includes('/works/seed-b1')) {
          return new Response(
            JSON.stringify({
              id: 'https://openalex.org/seed-b1',
              title: 'Seed Both Test',
              publication_year: 2021,
              cited_by_count: 30,
              authorships: [],
              abstract_inverted_index: null,
              referenced_works: ['https://openalex.org/cross-ref-1']
            }),
            { status: 200 }
          );
        }
        if (urlStr.includes('filter=openalex:')) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  id: 'https://openalex.org/cross-ref-1',
                  title: 'Cross Referenced Paper 1',
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

      await EnrichmentJobProcessor.processBatch(5);

      const cit = PaperRepository.getPaper('cross-cit-1', col1);
      const ref = PaperRepository.getPaper('cross-ref-1', col1);
      assert.ok(cit);
      assert.ok(ref);

      const links = CitationRepository.getLinksForCollection(col1);
      // Expected links:
      // 1. cross-cit-1 -> seed-b1 (citation)
      // 2. seed-b1 -> cross-ref-1 (reference)
      // 3. cross-cit-1 -> cross-ref-1 (cross-edge!)
      assert.ok(links.some((l) => l.source === 'cross-cit-1' && l.target === 'seed-b1'));
      assert.ok(links.some((l) => l.source === 'seed-b1' && l.target === 'cross-ref-1'));
      assert.ok(
        links.some((l) => l.source === 'cross-cit-1' && l.target === 'cross-ref-1'),
        'Cross-edge between expanded citation and reference must be persisted'
      );
    });
  });

  describe('EnrichmentJobProcessor: Semantic Scholar Direct ID Pathway', () => {
    it('persists papers when paperId uses s2: prefix directly', async () => {
      PaperRepository.addPaper({ id: 's2:s2seed1', title: 'S2 Seed Paper' }, col1, 'seed');
      QueueRepository.addQueueItem('s2:s2seed1', 'citations', col1);

      globalThis.fetch = async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes('/citations?')) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  citingPaper: {
                    paperId: 's2citing1',
                    title: 'S2 Citing Paper',
                    year: 2024,
                    citationCount: 15,
                    authors: [{ name: 'S2 Author' }],
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

      const counts = QueueRepository.getStatusCounts();
      assert.strictEqual(counts.pending, 0);

      const citingPaper = PaperRepository.getPaper('s2:s2citing1', col1);
      assert.ok(citingPaper, 'S2 citing paper must be saved under col1');
      assert.strictEqual(citingPaper.title, 'S2 Citing Paper');
      assert.strictEqual(citingPaper.status, 'recommended');

      const links = CitationRepository.getLinksForCollection(col1);
      assert.ok(links.some((l) => l.source === 's2:s2citing1' && l.target === 's2:s2seed1'));
    });
  });

  describe('EnrichmentJobProcessor: Legacy and Fallback Handling', () => {
    it('resolves collectionId from PaperRepository for legacy items missing collectionId', async () => {
      // Seed paper exists in col1
      PaperRepository.addPaper({ id: 'legacy-seed', title: 'Legacy Paper' }, col1, 'seed');

      // Enqueue without collectionId (legacy queue item simulation)
      QueueRepository.addQueueItem('legacy-seed', 'citations');

      const pendingBefore = QueueRepository.getPendingItems(5);
      assert.strictEqual(pendingBefore.length, 1);
      assert.strictEqual(pendingBefore[0].collectionId, null);

      globalThis.fetch = async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes('api.semanticscholar.org')) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        if (urlStr.includes('filter=cites:legacy-seed')) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  id: 'https://openalex.org/legacy-cit-1',
                  title: 'Legacy Cit 1',
                  publication_year: 2023,
                  cited_by_count: 3,
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

      await EnrichmentJobProcessor.processBatch(5);

      // Verify item completed
      const counts = QueueRepository.getStatusCounts();
      assert.strictEqual(counts.pending, 0);

      // Verify paper was saved under recovered col1
      const saved = PaperRepository.getPaper('legacy-cit-1', col1);
      assert.ok(saved, 'Paper must be persisted to recovered col1');
      assert.strictEqual(saved.status, 'recommended');

      const links = CitationRepository.getLinksForCollection(col1);
      assert.ok(links.some((l) => l.source === 'legacy-cit-1' && l.target === 'legacy-seed'));
    });

    it('marks item failed when collectionId is missing and paper not found in any collection', async () => {
      // Non-existent paper queued with no collectionId
      QueueRepository.addQueueItem('orphan-ghost-paper', 'citations');

      await EnrichmentJobProcessor.processBatch(5);

      const counts = QueueRepository.getStatusCounts();
      assert.strictEqual(counts.pending, 0);
      assert.strictEqual(counts.failed, 1, 'Orphan queue item must be marked failed');

      // Verify nothing corrupted in papers table
      const col1Papers = PaperRepository.getPapersForCollection(col1);
      assert.strictEqual(col1Papers.length, 0);
    });
  });

  describe('EnrichmentJobProcessor: Rate Limit and Error Resilience', () => {
    it('defers item and halts batch processing when RATE_LIMIT occurs', async () => {
      PaperRepository.addPaper({ id: 'rl-seed', title: 'Rate Limit Seed' }, col1, 'seed');
      QueueRepository.addQueueItem('rl-seed', 'citations', col1);

      // Mock fetch throwing RATE_LIMIT
      globalThis.fetch = async () => {
        throw new Error('RATE_LIMIT');
      };

      await EnrichmentJobProcessor.processBatch(5);

      // The item should still be pending (deferred, not failed)
      const counts = QueueRepository.getStatusCounts();
      assert.strictEqual(counts.pending, 1, 'Rate-limited item must remain pending');
      assert.strictEqual(counts.failed, 0, 'Rate-limited item must not be marked failed');
    });

    it('defers item and halts batch processing when S2_RATE_LIMIT occurs', async () => {
      PaperRepository.addPaper({ id: 's2-rl-seed', title: 'S2 Rate Limit Seed' }, col1, 'seed');
      QueueRepository.addQueueItem('s2-rl-seed', 'citations', col1);

      // Mock fetch throwing S2_RATE_LIMIT
      globalThis.fetch = async () => {
        throw new Error('S2_RATE_LIMIT');
      };

      await EnrichmentJobProcessor.processBatch(5);

      // The item should still be pending (deferred, not failed)
      const counts = QueueRepository.getStatusCounts();
      assert.strictEqual(counts.pending, 1, 'S2 Rate-limited item must remain pending');
      assert.strictEqual(counts.failed, 0, 'S2 Rate-limited item must not be marked failed');
    });

    it('marks item failed when unexpected error occurs without crashing the loop', async () => {
      PaperRepository.addPaper({ id: 'err-seed', title: 'Error Seed' }, col1, 'seed');
      QueueRepository.addQueueItem('err-seed', 'citations', col1);

      globalThis.fetch = async () => {
        throw new Error('Fatal socket network failure');
      };

      await EnrichmentJobProcessor.processBatch(5);

      const counts = QueueRepository.getStatusCounts();
      assert.strictEqual(counts.pending, 0);
      assert.strictEqual(counts.failed, 1, 'Item with fatal error must be marked failed');
    });
  });

  describe('EnrichmentJobProcessor: Multi-Collection Isolation', () => {
    it('isolates persisted papers and links strictly to their respective collections', async () => {
      PaperRepository.addPaper({ id: 'iso-seed', title: 'Isolated Seed' }, col1, 'seed');
      PaperRepository.addPaper({ id: 'iso-seed', title: 'Isolated Seed' }, col2, 'seed');

      QueueRepository.addQueueItem('iso-seed', 'citations', col1);
      QueueRepository.addQueueItem('iso-seed', 'citations', col2);

      globalThis.fetch = async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes('api.semanticscholar.org')) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        if (urlStr.includes('filter=cites:iso-seed')) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  id: 'https://openalex.org/iso-cit-shared',
                  title: 'Shared Citation Paper',
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
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      };

      await EnrichmentJobProcessor.processBatch(10);

      // Both collections should have iso-cit-shared
      const inCol1 = PaperRepository.getPaper('iso-cit-shared', col1);
      const inCol2 = PaperRepository.getPaper('iso-cit-shared', col2);
      assert.ok(inCol1);
      assert.ok(inCol2);
      assert.strictEqual(inCol1.status, 'recommended');
      assert.strictEqual(inCol2.status, 'recommended');

      // Citation links in both collections
      const linksCol1 = CitationRepository.getLinksForCollection(col1);
      const linksCol2 = CitationRepository.getLinksForCollection(col2);
      assert.ok(linksCol1.some((l) => l.source === 'iso-cit-shared' && l.target === 'iso-seed'));
      assert.ok(linksCol2.some((l) => l.source === 'iso-cit-shared' && l.target === 'iso-seed'));
    });
  });

  describe('Physical database safety', () => {
    it('verifies data/papers.db was never modified in size or timestamp', () => {
      if (fs.existsSync(physicalDbPath)) {
        const stats = fs.statSync(physicalDbPath);
        assert.strictEqual(stats.mtimeMs, initialMtime);
        assert.strictEqual(stats.size, initialSize);
      }
    });
  });
});
