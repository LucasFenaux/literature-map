import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Force in-memory database and temporary directory before any db or repository import
process.env.SQLITE_DB_PATH = ':memory:';
process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'lit-review-graph-test-m2-' + Date.now());

import { getDb } from '../../src/lib/db.js';
import { PaperRepository } from '../../src/domain/repositories/PaperRepository.js';

describe('PaperRepository Batched Inserts & Database Suite (Milestone 2)', () => {
  const physicalDbPath = path.join(process.cwd(), 'data', 'papers.db');
  let initialMtime: number = 0;
  let initialSize: number = 0;
  const col1 = 'test-collection-m2-1';
  const col2 = 'test-collection-m2-2';

  before(() => {
    if (fs.existsSync(physicalDbPath)) {
      const stats = fs.statSync(physicalDbPath);
      initialMtime = stats.mtimeMs;
      initialSize = stats.size;
    }

    const db = getDb();
    // Prevent background smart backup from touching disk during tests
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('last_db_backup_time', Date.now().toString());

    // Insert test collections
    db.prepare('INSERT OR IGNORE INTO collections (id, name) VALUES (?, ?)').run(col1, 'Collection 1');
    db.prepare('INSERT OR IGNORE INTO collections (id, name) VALUES (?, ?)').run(col2, 'Collection 2');
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM papers WHERE collectionId IN (?, ?)').run(col1, col2);
  });

  after(() => {
    if (fs.existsSync(physicalDbPath)) {
      const stats = fs.statSync(physicalDbPath);
      assert.strictEqual(stats.mtimeMs, initialMtime, 'Physical DB mtime was modified!');
      assert.strictEqual(stats.size, initialSize, 'Physical DB size was modified!');
    }
  });

  describe('addPapers bulk insertion', () => {
    it('inserts a batch of papers in a single call with default recommended status', () => {
      const papers = Array.from({ length: 25 }, (_, i) => ({
        id: `paper-batch-${i}`,
        doi: `10.1000/batch-${i}`,
        title: `Batched Paper Title ${i}`,
        abstract: `Abstract for paper ${i}`,
        authors: [{ name: `Author ${i}A` }, { name: `Author ${i}B` }],
        year: 2020 + (i % 5),
        publicationDate: `202${i % 5}-01-15`,
        citationCount: i * 10,
        url: `https://example.com/paper-${i}`,
        venue: 'NeurIPS'
      }));

      PaperRepository.addPapers(papers, col1);

      const stored = PaperRepository.getPapersForCollection(col1);
      assert.strictEqual(stored.length, 25);

      const paper0 = PaperRepository.getPaper('paper-batch-0', col1);
      assert.ok(paper0);
      assert.strictEqual(paper0.id, 'paper-batch-0');
      assert.strictEqual(paper0.title, 'Batched Paper Title 0');
      assert.strictEqual(paper0.doi, '10.1000/batch-0');
      assert.strictEqual(paper0.abstract, 'Abstract for paper 0');
      assert.strictEqual(paper0.status, 'recommended');
      assert.strictEqual(paper0.citationCount, 0);
      assert.strictEqual(paper0.year, 2020);
      assert.strictEqual(paper0.venue, 'NeurIPS');
      assert.deepStrictEqual(paper0.authors, [{ name: 'Author 0A' }, { name: 'Author 0B' }]);
    });

    it('respects explicit status parameter (e.g. seed)', () => {
      const papers = [
        { id: 'paper-seed-1', title: 'Seed 1', authors: ['Author One'] },
        { id: 'paper-seed-2', title: 'Seed 2', authors: ['Author Two'] }
      ];

      PaperRepository.addPapers(papers, col1, 'seed');

      const p1 = PaperRepository.getPaper('paper-seed-1', col1);
      const p2 = PaperRepository.getPaper('paper-seed-2', col1);
      assert.strictEqual(p1.status, 'seed');
      assert.strictEqual(p2.status, 'seed');
    });

    it('handles empty or null arrays gracefully without throwing', () => {
      assert.doesNotThrow(() => {
        PaperRepository.addPapers([], col1);
      });
      assert.doesNotThrow(() => {
        PaperRepository.addPapers(null as unknown as [], col1);
      });
      assert.doesNotThrow(() => {
        PaperRepository.addPapers(undefined as unknown as [], col1);
      });
      const stored = PaperRepository.getPapersForCollection(col1);
      assert.strictEqual(stored.length, 0);
    });

    it('handles authors in various formats (array, string JSON, plain string)', () => {
      const papers = [
        { id: 'p-auth-arr', title: 'Array Authors', authors: ['Alice', 'Bob'] },
        { id: 'p-auth-json', title: 'JSON Authors', authors: JSON.stringify(['Charlie']) },
        { id: 'p-auth-plain', title: 'Plain String Author', authors: 'David' },
        { id: 'p-auth-none', title: 'No Authors' }
      ];

      PaperRepository.addPapers(papers, col1);

      const pArr = PaperRepository.getPaper('p-auth-arr', col1);
      assert.deepStrictEqual(pArr.authors, ['Alice', 'Bob']);

      const pJson = PaperRepository.getPaper('p-auth-json', col1);
      assert.deepStrictEqual(pJson.authors, ['Charlie']);

      const pPlain = PaperRepository.getPaper('p-auth-plain', col1);
      assert.deepStrictEqual(pPlain.authors, ['David']);

      const pNone = PaperRepository.getPaper('p-auth-none', col1);
      assert.deepStrictEqual(pNone.authors, []);
    });
  });

  describe('addPaper delegation', () => {
    it('delegates to addPapers with default seed status', () => {
      PaperRepository.addPaper({ id: 'single-seed', title: 'Single Seed Paper', authors: ['Researcher'] }, col1);

      const paper = PaperRepository.getPaper('single-seed', col1);
      assert.ok(paper);
      assert.strictEqual(paper.id, 'single-seed');
      assert.strictEqual(paper.status, 'seed');
      assert.strictEqual(paper.title, 'Single Seed Paper');
    });

    it('delegates to addPapers with explicit status', () => {
      PaperRepository.addPaper({ id: 'single-rec', title: 'Single Recommended', authors: ['Scholar'] }, col1, 'recommended');

      const paper = PaperRepository.getPaper('single-rec', col1);
      assert.ok(paper);
      assert.strictEqual(paper.status, 'recommended');
    });
  });

  describe('Duplicate handling via INSERT OR IGNORE', () => {
    it('gracefully ignores intra-batch duplicate paper IDs without constraint errors', () => {
      const papers = [
        { id: 'dup-intra', title: 'Original Version', venue: 'v1' },
        { id: 'dup-intra', title: 'Duplicate Version', venue: 'v2' },
        { id: 'dup-other', title: 'Other Paper' }
      ];

      assert.doesNotThrow(() => {
        PaperRepository.addPapers(papers, col1);
      });

      const stored = PaperRepository.getPapersForCollection(col1);
      assert.strictEqual(stored.length, 2);

      const paper = PaperRepository.getPaper('dup-intra', col1);
      assert.strictEqual(paper.title, 'Original Version');
      assert.strictEqual(paper.venue, 'v1');
    });

    it('does not overwrite existing seed papers when expanding with recommended status', () => {
      // First insert as seed
      PaperRepository.addPaper({ id: 'existing-paper', title: 'Foundational Work', authors: ['Pioneer'] }, col1, 'seed');

      const before = PaperRepository.getPaper('existing-paper', col1);
      assert.strictEqual(before.status, 'seed');

      // Now insert in batch with recommended status
      assert.doesNotThrow(() => {
        PaperRepository.addPapers([
          { id: 'existing-paper', title: 'Attempted Overwrite', authors: ['Nobody'] },
          { id: 'fresh-paper', title: 'Fresh Expansion Paper' }
        ], col1, 'recommended');
      });

      const afterExisting = PaperRepository.getPaper('existing-paper', col1);
      assert.strictEqual(afterExisting.status, 'seed');
      assert.strictEqual(afterExisting.title, 'Foundational Work');

      const afterFresh = PaperRepository.getPaper('fresh-paper', col1);
      assert.strictEqual(afterFresh.status, 'recommended');
    });
  });

  describe('Multi-collection isolation', () => {
    it('allows same paper ID in different collections (composite PK)', () => {
      PaperRepository.addPapers([{ id: 'cross-col-p', title: 'Shared Paper' }], col1, 'seed');
      PaperRepository.addPapers([{ id: 'cross-col-p', title: 'Shared Paper' }], col2, 'recommended');

      const inCol1 = PaperRepository.getPaper('cross-col-p', col1);
      const inCol2 = PaperRepository.getPaper('cross-col-p', col2);

      assert.ok(inCol1);
      assert.ok(inCol2);
      assert.strictEqual(inCol1.status, 'seed');
      assert.strictEqual(inCol2.status, 'recommended');
    });
  });

  describe('Transaction atomicity & rollback', () => {
    it('rolls back all insertions if an unhandled error occurs within transaction', () => {
      const db = getDb();
      // Test db.transaction behavior directly on repository pattern:
      // If a non-ignorable error occurs in the loop, all items in the batch are rolled back
      const buggyPapers: Array<{ id: string; title: string | null }> = [
        { id: 'rollback-p1', title: 'Rollback Paper 1' },
        { id: 'rollback-p2', title: null }, // Trigger NOT NULL constraint violation on title
      ];

      // Prepare a statement that will throw NOT NULL violation
      const insertStrict = db.prepare(`
        INSERT INTO papers (id, collectionId, title, status, localTags, notes)
        VALUES (?, ?, ?, 'recommended', '[]', '')
      `);

      const atomicTx = db.transaction((batch: Array<{ id: string; title: string | null }>) => {
        for (const p of batch) {
          insertStrict.run(p.id, col1, p.title);
        }
      });

      assert.throws(() => atomicTx(buggyPapers), /NOT NULL constraint failed/);

      // Verify that rollback-p1 was NOT committed
      const p1 = PaperRepository.getPaper('rollback-p1', col1);
      assert.strictEqual(p1, null);
    });
  });

  describe('Physical database safety', () => {
    it('keeps data/papers.db untouched throughout repository operations', () => {
      if (fs.existsSync(physicalDbPath)) {
        const stats = fs.statSync(physicalDbPath);
        assert.strictEqual(stats.mtimeMs, initialMtime);
        assert.strictEqual(stats.size, initialSize);
      }
    });
  });
});
