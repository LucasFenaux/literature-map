import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';

// Force in-memory database and temporary data directory before any db import
process.env.SQLITE_DB_PATH = ':memory:';
process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'lit-review-graph-test-' + Date.now());

import { formatAuthorName, formatAuthors } from '../src/lib/formatters.js';
import { matchesSearch } from '../src/lib/search.js';
import { getDb } from '../src/lib/db.js';

describe('Baseline Verification Suite', () => {
  describe('formatAuthorName', () => {
    it('formats "First Last" into "Last F."', () => {
      assert.strictEqual(formatAuthorName('Alan Turing'), 'Turing A.');
      assert.strictEqual(formatAuthorName('Grace Brewster Murray Hopper'), 'Hopper G.');
    });

    it('formats "Last, First" into "Last F."', () => {
      assert.strictEqual(formatAuthorName('Turing, Alan'), 'Turing A.');
    });

    it('handles single names without initials', () => {
      assert.strictEqual(formatAuthorName('Plato'), 'Plato');
    });

    it('handles empty or whitespace strings', () => {
      assert.strictEqual(formatAuthorName(''), '');
      assert.strictEqual(formatAuthorName('   '), '');
    });
  });

  describe('formatAuthors', () => {
    it('formats array of author objects', () => {
      const authors = [{ name: 'Alan Turing' }, { name: 'Ada Lovelace' }];
      assert.strictEqual(formatAuthors(authors), 'Turing A., Lovelace A.');
    });

    it('formats array of author strings', () => {
      const authors = ['Alan Turing', 'Ada Lovelace'];
      assert.strictEqual(formatAuthors(authors), 'Turing A., Lovelace A.');
    });

    it('parses and formats JSON author string', () => {
      const json = JSON.stringify([{ name: 'Claude Shannon' }]);
      assert.strictEqual(formatAuthors(json), 'Shannon C.');
    });

    it('handles comma-separated string of multiple authors', () => {
      assert.strictEqual(formatAuthors('Alan Turing, Ada Lovelace'), 'Turing A., Lovelace A.');
    });

    it('handles single author string fallback', () => {
      assert.strictEqual(formatAuthors('Claude Shannon'), 'Shannon C.');
    });

    it('handles author with Last, First format in array', () => {
      assert.strictEqual(formatAuthors(['Shannon, Claude']), 'Shannon C.');
    });

    it('returns empty string for falsy/empty values', () => {
      assert.strictEqual(formatAuthors(''), '');
      assert.strictEqual(formatAuthors([]), '');
      assert.strictEqual(formatAuthors(null as any), '');
    });
  });

  describe('matchesSearch', () => {
    const fields = [
      'Attention Is All You Need',
      'Vaswani A., Shazeer N., Parmar N.',
      'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.'
    ];

    it('returns true for empty query', () => {
      assert.strictEqual(matchesSearch('', fields), true);
      assert.strictEqual(matchesSearch('   ', fields), true);
    });

    it('matches case-insensitively across fields', () => {
      assert.strictEqual(matchesSearch('attention', fields), true);
      assert.strictEqual(matchesSearch('VASWANI', fields), true);
      assert.strictEqual(matchesSearch('transduction models', fields), true);
    });

    it('requires all unquoted words to match (AND semantics)', () => {
      assert.strictEqual(matchesSearch('attention vaswani sequence', fields), true);
      assert.strictEqual(matchesSearch('attention missingword', fields), false);
    });

    it('matches exact quoted phrases', () => {
      assert.strictEqual(matchesSearch('"All You Need"', fields), true);
      assert.strictEqual(matchesSearch('"convolut neural"', fields), false);
    });
  });

  describe('Database Isolation Smoke Test', () => {
    it('initializes in-memory database with schema without modifying physical database', () => {
      const physicalDbPath = path.join(process.cwd(), 'data', 'papers.db');
      const beforeStats = fs.existsSync(physicalDbPath) ? fs.statSync(physicalDbPath) : null;

      // Prevent smart backup trigger during test by setting last_db_backup_time to current time
      const db = getDb();
      assert.ok(db, 'Database instance should be initialized');

      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('last_db_backup_time', Date.now().toString());

      // Check essential tables exist in in-memory database
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
      assert.ok(tables.includes('papers'), 'papers table should exist');
      assert.ok(tables.includes('collections'), 'collections table should exist');
      assert.ok(tables.includes('citations'), 'citations table should exist');
      assert.ok(tables.includes('retry_queue'), 'retry_queue table should exist');
      assert.ok(tables.includes('settings'), 'settings table should exist');

      // Smoke test insert and query collections
      db.prepare("INSERT INTO collections (id, name) VALUES ('test-col-1', 'Test Collection')").run();
      const col = db.prepare("SELECT * FROM collections WHERE id = 'test-col-1'").get() as any;
      assert.strictEqual(col.name, 'Test Collection');

      // Smoke test insert and query papers
      db.prepare(`
        INSERT INTO papers (id, collectionId, title, authors, year, status)
        VALUES ('paper-1', 'test-col-1', 'Deep Learning', 'Goodfellow I.', 2016, 'seed')
      `).run();
      const paper = db.prepare("SELECT * FROM papers WHERE id = 'paper-1' AND collectionId = 'test-col-1'").get() as any;
      assert.strictEqual(paper.title, 'Deep Learning');
      assert.strictEqual(paper.status, 'seed');

      // Verify physical database was completely untouched
      if (beforeStats) {
        const afterStats = fs.statSync(physicalDbPath);
        assert.strictEqual(afterStats.mtimeMs, beforeStats.mtimeMs, 'Physical data/papers.db mtime must be unchanged');
        assert.strictEqual(afterStats.size, beforeStats.size, 'Physical data/papers.db size must be unchanged');
      }
    });
  });
});
