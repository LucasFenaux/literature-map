import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Force in-memory database and isolated temp directory
process.env.SQLITE_DB_PATH = ':memory:';
process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'lit-review-graph-adversarial-' + Date.now());

import { getDb } from '../../src/lib/db.js';
import { PaperRepository } from '../../src/domain/repositories/PaperRepository.js';

describe('PaperRepository Adversarial & Stress Testing Suite', () => {
  const physicalDbPath = path.join(process.cwd(), 'data', 'papers.db');
  let initialMtime: number = 0;
  let initialSize: number = 0;
  const colTest = 'adv-test-col';
  const colAlt = 'adv-alt-col';

  before(() => {
    if (fs.existsSync(physicalDbPath)) {
      const stats = fs.statSync(physicalDbPath);
      initialMtime = stats.mtimeMs;
      initialSize = stats.size;
    }

    const db = getDb();
    // Guard against background backup touching disk
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
      'last_db_backup_time',
      Date.now().toString()
    );

    // Create test collections
    db.prepare('INSERT OR IGNORE INTO collections (id, name) VALUES (?, ?)').run(colTest, 'Adversarial Test Col');
    db.prepare('INSERT OR IGNORE INTO collections (id, name) VALUES (?, ?)').run(colAlt, 'Adversarial Alt Col');
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM papers WHERE collectionId IN (?, ?)').run(colTest, colAlt);
  });

  after(() => {
    if (fs.existsSync(physicalDbPath)) {
      const stats = fs.statSync(physicalDbPath);
      assert.strictEqual(stats.mtimeMs, initialMtime, 'CRITICAL: Physical DB mtime was modified!');
      assert.strictEqual(stats.size, initialSize, 'CRITICAL: Physical DB size was modified!');
    }
  });

  describe('1. Large Batch Stress Test (500+ papers)', () => {
    it('successfully inserts 500 papers in a single transaction', () => {
      const BATCH_SIZE = 500;
      const papers = Array.from({ length: BATCH_SIZE }, (_, i) => ({
        id: `stress-paper-500-${i}`,
        doi: `10.1000/stress500-${i}`,
        title: `Stress Paper Title ${i} - High Volume Verification`,
        abstract: `Abstract for paper ${i}. `.repeat(10),
        authors: [{ name: `Author ${i}` }, { name: `Co-Author ${i}` }],
        year: 2000 + (i % 25),
        publicationDate: `2020-05-${String((i % 28) + 1).padStart(2, '0')}`,
        citationCount: i * 7,
        url: `https://example.org/papers/${i}`,
        venue: `International Journal of Science ${i % 10}`
      }));

      const start = performance.now();
      PaperRepository.addPapers(papers, colTest, 'recommended');
      const elapsed = performance.now() - start;

      const stored = PaperRepository.getPapersForCollection(colTest);
      assert.strictEqual(stored.length, BATCH_SIZE, 'Expected all 500 papers to be inserted');

      // Spot check first, middle, last
      const first = PaperRepository.getPaper('stress-paper-500-0', colTest);
      assert.ok(first);
      assert.strictEqual(first.title, 'Stress Paper Title 0 - High Volume Verification');
      assert.strictEqual(first.citationCount, 0);
      assert.deepStrictEqual(first.authors, [{ name: 'Author 0' }, { name: 'Co-Author 0' }]);

      const mid = PaperRepository.getPaper(`stress-paper-500-250`, colTest);
      assert.ok(mid);
      assert.strictEqual(mid.year, 2000);
      assert.strictEqual(mid.citationCount, 1750);

      const last = PaperRepository.getPaper(`stress-paper-500-${BATCH_SIZE - 1}`, colTest);
      assert.ok(last);
      assert.strictEqual(last.id, `stress-paper-500-${BATCH_SIZE - 1}`);

      // Performance sanity check: 500 in-memory inserts in a single transaction should take < 500ms
      assert.ok(elapsed < 500, `500 inserts took ${elapsed}ms, expected < 500ms`);
    });

    it('successfully inserts 2000 papers in a single transaction efficiently', () => {
      const BATCH_SIZE = 2000;
      const papers = Array.from({ length: BATCH_SIZE }, (_, i) => ({
        id: `mega-paper-${i}`,
        title: `Mega Paper ${i}`,
        authors: [`Author ${i}`],
        year: 2024
      }));

      const start = performance.now();
      PaperRepository.addPapers(papers, colTest, 'recommended');
      const elapsed = performance.now() - start;

      const db = getDb();
      const count = db.prepare('SELECT COUNT(*) as count FROM papers WHERE collectionId = ?').get(colTest) as { count: number };
      assert.strictEqual(count.count, BATCH_SIZE);

      // Performance sanity check: 2000 inserts in single transaction should be < 1000ms
      assert.ok(elapsed < 1000, `2000 inserts took ${elapsed}ms, expected < 1000ms`);
    });

    it('successfully inserts 5000 papers in a single transaction in well under 2 seconds', () => {
      const BATCH_SIZE = 5000;
      const papers = Array.from({ length: BATCH_SIZE }, (_, i) => ({
        id: `ultra-paper-${i}`,
        title: `Ultra Paper ${i}`,
        authors: [`Author ${i}`],
        year: 2024
      }));

      const start = performance.now();
      PaperRepository.addPapers(papers, colTest, 'recommended');
      const elapsed = performance.now() - start;

      const db = getDb();
      const count = db.prepare('SELECT COUNT(*) as count FROM papers WHERE collectionId = ?').get(colTest) as { count: number };
      assert.strictEqual(count.count, BATCH_SIZE);
      assert.ok(elapsed < 2000, `5000 inserts took ${elapsed}ms, expected < 2000ms`);
    });
  });

  describe('2. Duplicate Handling', () => {
    it('handles identical duplicates within the same batch (first write wins, no error)', () => {
      const duplicateBatch = [
        { id: 'dup-1', title: 'First Version of dup-1', venue: 'Venue A' },
        { id: 'dup-1', title: 'Second Version of dup-1', venue: 'Venue B' },
        { id: 'dup-1', title: 'Third Version of dup-1', venue: 'Venue C' },
        { id: 'dup-2', title: 'First Version of dup-2' },
        { id: 'dup-2', title: 'Second Version of dup-2' }
      ];

      assert.doesNotThrow(() => {
        PaperRepository.addPapers(duplicateBatch, colTest);
      });

      const stored = PaperRepository.getPapersForCollection(colTest);
      assert.strictEqual(stored.length, 2);

      const p1 = PaperRepository.getPaper('dup-1', colTest);
      assert.strictEqual(p1.title, 'First Version of dup-1');
      assert.strictEqual(p1.venue, 'Venue A');

      const p2 = PaperRepository.getPaper('dup-2', colTest);
      assert.strictEqual(p2.title, 'First Version of dup-2');
    });

    it('handles 100 duplicate entries of the same paper ID in a batch', () => {
      const massiveDuplicates = Array.from({ length: 100 }, (_, i) => ({
        id: 'same-id-always',
        title: `Title ${i}`
      }));

      assert.doesNotThrow(() => {
        PaperRepository.addPapers(massiveDuplicates, colTest);
      });

      const stored = PaperRepository.getPapersForCollection(colTest);
      assert.strictEqual(stored.length, 1);
      assert.strictEqual(stored[0].title, 'Title 0');
    });

    it('preserves existing seed papers, tags, and notes when re-inserted in recommended batch', () => {
      // Create seed paper
      PaperRepository.addPaper({
        id: 'protected-seed',
        title: 'Original Title',
        authors: ['Important Scientist']
      }, colTest, 'seed');

      // Add custom tag and notes
      PaperRepository.updatePaper(
        'protected-seed',
        colTest,
        'seed',
        JSON.stringify(['important-tag']),
        'Critical user notes that must not be erased'
      );

      // Verify before
      const before = PaperRepository.getPaper('protected-seed', colTest);
      assert.strictEqual(before.status, 'seed');
      assert.deepStrictEqual(before.localTags, ['important-tag']);
      assert.strictEqual(before.notes, 'Critical user notes that must not be erased');

      // Attempt to overwrite via addPapers with recommended status
      PaperRepository.addPapers([
        { id: 'protected-seed', title: 'Overwritten Title', authors: ['Imposter'] },
        { id: 'brand-new-paper', title: 'Brand New Paper', authors: ['New Author'] }
      ], colTest, 'recommended');

      // Verify seed paper was not modified or overwritten
      const after = PaperRepository.getPaper('protected-seed', colTest);
      assert.strictEqual(after.status, 'seed');
      assert.strictEqual(after.title, 'Original Title');
      assert.deepStrictEqual(after.authors, ['Important Scientist']);
      assert.deepStrictEqual(after.localTags, ['important-tag']);
      assert.strictEqual(after.notes, 'Critical user notes that must not be erased');

      // Verify new paper was inserted
      const newPaper = PaperRepository.getPaper('brand-new-paper', colTest);
      assert.ok(newPaper);
      assert.strictEqual(newPaper.status, 'recommended');
    });
  });

  describe('3. Transaction Rollback & Atomicity', () => {
    it('rolls back all previous inserts in batch if circular reference in authors causes TypeError', () => {
      const circularAuthor: any = { name: 'Dr. Paradox' };
      circularAuthor.self = circularAuthor;

      const batch: any[] = [
        { id: 'circ-p1', title: 'Paper 1' },
        { id: 'circ-p2', title: 'Paper 2' },
        { id: 'circ-p3', title: 'Paper 3', authors: [circularAuthor] },
        { id: 'circ-p4', title: 'Paper 4' }
      ];

      assert.throws(
        () => PaperRepository.addPapers(batch, colTest),
        /Converting circular structure to JSON/
      );

      // Verify ZERO papers were committed
      const stored = PaperRepository.getPapersForCollection(colTest);
      assert.strictEqual(stored.length, 0, 'Circular JSON error must cause rollback of all papers in batch');
    });

    it('rolls back all previous inserts in batch if a runtime error occurs during iteration', () => {
      // Construct a batch where the 5th element throws on property access
      const batch: any[] = [
        { id: 'rb-p1', title: 'Rollback Paper 1' },
        { id: 'rb-p2', title: 'Rollback Paper 2' },
        { id: 'rb-p3', title: 'Rollback Paper 3' },
        { id: 'rb-p4', title: 'Rollback Paper 4' },
        {
          get id() {
            throw new Error('Explosion on 5th paper');
          },
          title: 'Poison Pill'
        },
        { id: 'rb-p6', title: 'Rollback Paper 6' }
      ];

      assert.throws(
        () => PaperRepository.addPapers(batch, colTest),
        /Explosion on 5th paper/
      );

      // Verify ZERO papers were committed
      const stored = PaperRepository.getPapersForCollection(colTest);
      assert.strictEqual(stored.length, 0, 'No papers should be saved after a rollback');
      assert.strictEqual(PaperRepository.getPaper('rb-p1', colTest), null);
      assert.strictEqual(PaperRepository.getPaper('rb-p4', colTest), null);
    });

    it('rolls back all previous inserts in batch if an unsupported type is bound (e.g. Symbol or undefined id)', () => {
      const batch: any[] = [
        { id: 'valid-before-error-1', title: 'Valid 1' },
        { id: 'valid-before-error-2', title: 'Valid 2' },
        { id: Symbol('unsupported-id'), title: 'Invalid Symbol ID' },
        { id: 'valid-after-error', title: 'Valid 3' }
      ];

      assert.throws(
        () => PaperRepository.addPapers(batch, colTest),
        (err: any) => err instanceof TypeError || (err.message && /unsupported type|Symbol/i.test(err.message))
      );

      // Verify that valid-before-error-1 and valid-before-error-2 are rolled back
      const stored = PaperRepository.getPapersForCollection(colTest);
      assert.strictEqual(stored.length, 0, 'Previous inserts in transaction must be rolled back');
      assert.strictEqual(PaperRepository.getPaper('valid-before-error-1', colTest), null);
    });

    it('rolls back if null is passed as an element in the papers array', () => {
      const batch: any[] = [
        { id: 'valid-p1', title: 'Valid 1' },
        null,
        { id: 'valid-p2', title: 'Valid 2' }
      ];

      assert.throws(() => {
        PaperRepository.addPapers(batch, colTest);
      }, TypeError);

      assert.strictEqual(PaperRepository.getPapersForCollection(colTest).length, 0);
    });
  });

  describe('4. Edge Cases and Input Sanitization', () => {
    it('handles empty, null, and undefined input arrays without error', () => {
      assert.doesNotThrow(() => PaperRepository.addPapers([], colTest));
      assert.doesNotThrow(() => PaperRepository.addPapers(null as any, colTest));
      assert.doesNotThrow(() => PaperRepository.addPapers(undefined as any, colTest));
      assert.strictEqual(PaperRepository.getPapersForCollection(colTest).length, 0);
    });

    it('handles SQL injection attempts in string fields safely', () => {
      const sqlInjectionBatch = [
        {
          id: "sqli-1'; DROP TABLE papers; --",
          title: "'); DROP TABLE collections; --",
          abstract: "Robert'); DROP TABLE papers;--",
          doi: "10.1000/'; DELETE FROM papers; --",
          url: "http://malicious.com/'; UPDATE papers SET status='hacked'; --",
          venue: "' UNION SELECT * FROM sqlite_master; --"
        },
        {
          id: "sqli-2",
          title: "Normal Title",
          status: "'; DELETE FROM papers; --"
        }
      ];

      assert.doesNotThrow(() => {
        PaperRepository.addPapers(sqlInjectionBatch, colTest);
      });

      // Verify tables still exist
      const db = getDb();
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
      assert.ok(tables.includes('papers'), 'papers table must not be dropped');
      assert.ok(tables.includes('collections'), 'collections table must not be dropped');

      // Verify the record was inserted with exact literal string
      const injected = PaperRepository.getPaper("sqli-1'; DROP TABLE papers; --", colTest);
      assert.ok(injected);
      assert.strictEqual(injected.title, "'); DROP TABLE collections; --");
      assert.strictEqual(injected.abstract, "Robert'); DROP TABLE papers;--");
      assert.strictEqual(injected.doi, "10.1000/'; DELETE FROM papers; --");
      assert.strictEqual(injected.url, "http://malicious.com/'; UPDATE papers SET status='hacked'; --");
      assert.strictEqual(injected.venue, "' UNION SELECT * FROM sqlite_master; --");
    });

    it('handles extremely long text fields (100KB abstract, 10KB title)', () => {
      const largeTitle = 'T'.repeat(10000);
      const largeAbstract = 'A'.repeat(100000);
      const largeUrl = 'https://example.com/' + 'u'.repeat(5000);

      const paper = {
        id: 'large-text-paper',
        title: largeTitle,
        abstract: largeAbstract,
        url: largeUrl
      };

      assert.doesNotThrow(() => {
        PaperRepository.addPapers([paper], colTest);
      });

      const retrieved = PaperRepository.getPaper('large-text-paper', colTest);
      assert.ok(retrieved);
      assert.strictEqual(retrieved.title, largeTitle);
      assert.strictEqual(retrieved.abstract, largeAbstract);
      assert.strictEqual(retrieved.url, largeUrl);
    });

    it('handles Unicode, Emojis, and special characters', () => {
      const unicodePaper = {
        id: 'unicode-📄-1234',
        title: 'Quantum ⚛️ Computing & 机器学习: 漢字, العربية, עברית, ελληνικά',
        abstract: 'Testing emoji 🧬🔬💊 and control chars \t \r and symbols €$¥£',
        authors: ['José Müller', '李小龙', 'محمد']
      };

      assert.doesNotThrow(() => {
        PaperRepository.addPapers([unicodePaper], colTest);
      });

      const retrieved = PaperRepository.getPaper('unicode-📄-1234', colTest);
      assert.ok(retrieved);
      assert.strictEqual(retrieved.title, unicodePaper.title);
      assert.strictEqual(retrieved.abstract, unicodePaper.abstract);
      assert.deepStrictEqual(retrieved.authors, unicodePaper.authors);
    });

    it('handles malformed and varied author field types', () => {
      const testCases = [
        { id: 'auth-arr-str', title: 'T1', authors: ['Alice', 'Bob'] },
        { id: 'auth-arr-obj', title: 'T2', authors: [{ name: 'Alice' }, { name: 'Bob' }] },
        { id: 'auth-valid-json', title: 'T3', authors: '["Charlie", "David"]' },
        { id: 'auth-invalid-json', title: 'T4', authors: 'Not A JSON String' },
        { id: 'auth-empty-str', title: 'T5', authors: '' },
        { id: 'auth-number', title: 'T6', authors: 42 },
        { id: 'auth-bool', title: 'T7', authors: true },
        { id: 'auth-null', title: 'T8', authors: null },
        { id: 'auth-undefined', title: 'T9' },
        { id: 'auth-obj-not-arr', title: 'T10', authors: { name: 'SingleObj' } }
      ];

      assert.doesNotThrow(() => {
        PaperRepository.addPapers(testCases, colTest);
      });

      assert.deepStrictEqual(PaperRepository.getPaper('auth-arr-str', colTest).authors, ['Alice', 'Bob']);
      assert.deepStrictEqual(PaperRepository.getPaper('auth-arr-obj', colTest).authors, [{ name: 'Alice' }, { name: 'Bob' }]);
      assert.deepStrictEqual(PaperRepository.getPaper('auth-valid-json', colTest).authors, ['Charlie', 'David']);
      assert.deepStrictEqual(PaperRepository.getPaper('auth-invalid-json', colTest).authors, ['Not A JSON String']);
      assert.deepStrictEqual(PaperRepository.getPaper('auth-empty-str', colTest).authors, ['']);
      assert.deepStrictEqual(PaperRepository.getPaper('auth-number', colTest).authors, []);
      assert.deepStrictEqual(PaperRepository.getPaper('auth-bool', colTest).authors, []);
      assert.deepStrictEqual(PaperRepository.getPaper('auth-null', colTest).authors, []);
      assert.deepStrictEqual(PaperRepository.getPaper('auth-undefined', colTest).authors, []);
      assert.deepStrictEqual(PaperRepository.getPaper('auth-obj-not-arr', colTest).authors, []);
    });

    it('handles missing or edge-case numerical fields (year, citationCount)', () => {
      const currentYear = new Date().getFullYear();
      const numTestCases = [
        { id: 'num-defaults', title: 'Defaults' },
        { id: 'num-zero-year', title: 'Zero Year', year: 0, citationCount: 0 },
        { id: 'num-negative-year', title: 'Negative Year', year: -500, citationCount: -10 },
        { id: 'num-float-year', title: 'Float Year', year: 2023.7, citationCount: 15.5 },
        { id: 'num-large', title: 'Max Int', year: 2024, citationCount: Number.MAX_SAFE_INTEGER }
      ];

      assert.doesNotThrow(() => {
        PaperRepository.addPapers(numTestCases, colTest);
      });

      const def = PaperRepository.getPaper('num-defaults', colTest);
      assert.strictEqual(def.year, currentYear);
      assert.strictEqual(def.citationCount, 0);

      // year || currentYear evaluates 0 to currentYear because 0 is falsy in JS
      const zero = PaperRepository.getPaper('num-zero-year', colTest);
      assert.strictEqual(zero.year, currentYear);
      assert.strictEqual(zero.citationCount, 0);

      const neg = PaperRepository.getPaper('num-negative-year', colTest);
      assert.strictEqual(neg.year, -500);
      assert.strictEqual(neg.citationCount, -10);

      const max = PaperRepository.getPaper('num-large', colTest);
      assert.strictEqual(max.citationCount, Number.MAX_SAFE_INTEGER);
    });

    it('handles missing title by defaulting to empty string without violating NOT NULL constraint', () => {
      const noTitle = [
        { id: 'no-title-1', title: undefined as any },
        { id: 'no-title-2', title: '' },
        { id: 'no-title-3', title: null as any }
      ];

      assert.doesNotThrow(() => {
        PaperRepository.addPapers(noTitle, colTest);
      });

      const p1 = PaperRepository.getPaper('no-title-1', colTest);
      assert.strictEqual(p1.title, '');
      const p2 = PaperRepository.getPaper('no-title-2', colTest);
      assert.strictEqual(p2.title, '');
      const p3 = PaperRepository.getPaper('no-title-3', colTest);
      assert.strictEqual(p3.title, '');
    });
  });

  describe('5. Physical Database Isolation Integrity', () => {
    it('confirms data/papers.db was never opened, written to, or altered', () => {
      if (fs.existsSync(physicalDbPath)) {
        const stats = fs.statSync(physicalDbPath);
        assert.strictEqual(stats.mtimeMs, initialMtime, 'File modification time must match pre-test timestamp');
        assert.strictEqual(stats.size, initialSize, 'File size must match pre-test byte count');
      }
    });
  });
});
