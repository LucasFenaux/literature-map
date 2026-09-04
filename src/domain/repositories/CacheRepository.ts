import db from '@/lib/db';

export class CacheRepository {
  static get(key: string): { data: string, timestamp: string } | null {
    const row = db.prepare('SELECT data, timestamp FROM api_cache WHERE key = ?').get(key) as any;
    if (!row) return null;
    return { data: row.data, timestamp: row.timestamp };
  }

  static getTimestamp(key: string): string | null {
    const row = db.prepare('SELECT timestamp FROM api_cache WHERE key = ?').get(key) as any;
    return row ? row.timestamp : null;
  }

  static set(key: string, data: string): void {
    db.prepare('INSERT OR REPLACE INTO api_cache (key, data, timestamp) VALUES (?, ?, CURRENT_TIMESTAMP)').run(key, data);
  }

  static deleteLike(pattern: string): number {
    return db.prepare(`DELETE FROM api_cache WHERE key LIKE ?`).run(pattern).changes;
  }

  static clearAll(): number {
    return db.prepare('DELETE FROM api_cache').run().changes;
  }
}
