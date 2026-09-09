import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

// Force in-memory database
process.env.SQLITE_DB_PATH = ':memory:';

import { getDb } from '../src/lib/db.js';

describe('Adversarial Database Isolation & Stress Suite', () => {
  const physicalDbPath = path.join(process.cwd(), 'data', 'papers.db');
  let initialMtime: number = 0;
  let initialSize: number = 0;

  before(() => {
    if (fs.existsSync(physicalDbPath)) {
      const stats = fs.statSync(physicalDbPath);
      initialMtime = stats.mtimeMs;
      initialSize = stats.size;
    }
  });

  after(() => {
    if (fs.existsSync(physicalDbPath)) {
      const stats = fs.statSync(physicalDbPath);
      assert.strictEqual(stats.mtimeMs, initialMtime, 'Physical DB mtime altered!');
      assert.strictEqual(stats.size, initialSize, 'Physical DB size altered!');
    }
  });

  it('verifies in-memory database handles high-throughput transactions without touching physical file', () => {
    const db = getDb();

    // Prevent smart backup trigger during test
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('last_db_backup_time', Date.now().toString());

    // Insert 500 papers in a single transaction
    const insertTx = db.transaction((count: number) => {
      db.prepare("INSERT INTO collections (id, name) VALUES ('stress-col', 'Stress Test')").run();
      const insertPaper = db.prepare(`
        INSERT INTO papers (id, collectionId, title, authors, year, status)
        VALUES (?, 'stress-col', ?, 'Author A.', 2024, 'recommended')
      `);
      for (let i = 0; i < count; i++) {
        insertPaper.run(`stress-paper-${i}`, `Paper Title ${i}`);
      }
    });

    insertTx(500);

    const count = db.prepare("SELECT count(*) as count FROM papers WHERE collectionId = 'stress-col'").get() as { count: number };
    assert.strictEqual(count.count, 500);

    // Verify physical db is untouched immediately
    if (fs.existsSync(physicalDbPath)) {
      const stats = fs.statSync(physicalDbPath);
      assert.strictEqual(stats.mtimeMs, initialMtime, 'Physical DB touched during bulk inserts');
      assert.strictEqual(stats.size, initialSize, 'Physical DB size modified during bulk inserts');
    }
  });

  it('verifies rollback isolation does not leave lingering corrupt state', () => {
    const db = getDb();
    const failingTx = db.transaction(() => {
      db.prepare("INSERT INTO collections (id, name) VALUES ('rollback-col', 'Rollback')").run();
      throw new Error('Simulated failure during transaction');
    });

    assert.throws(() => failingTx(), /Simulated failure/);

    const col = db.prepare("SELECT * FROM collections WHERE id = 'rollback-col'").get();
    assert.strictEqual(col, undefined);
  });
});
