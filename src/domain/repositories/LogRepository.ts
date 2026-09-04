import db from '@/lib/db';

export class LogRepository {
  static logApiCall(endpoint: string, cached: boolean): void {
    try {
      db.prepare('INSERT INTO s2_api_log (endpoint, cached) VALUES (?, ?)').run(endpoint, cached ? 1 : 0);
    } catch (e) {
    }
  }

  static getStats(): { cached: number, missed: number, recent: any[] } {
    try {
      const cached = db.prepare('SELECT count(*) as count FROM s2_api_log WHERE cached = 1').get() as any;
      const missed = db.prepare('SELECT count(*) as count FROM s2_api_log WHERE cached = 0').get() as any;
      const recent = db.prepare('SELECT endpoint, timestamp, cached FROM s2_api_log ORDER BY timestamp DESC LIMIT 20').all();
      return { cached: cached.count, missed: missed.count, recent };
    } catch (e) {
      return { cached: 0, missed: 0, recent: [] };
    }
  }

  static getUsageStats(): any {
    try {
      const now = new Date();
      const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
      const since7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

      const total24h = (db.prepare('SELECT COUNT(*) as count FROM s2_api_log WHERE cached = 0 AND timestamp >= ?').get(since24h) as any)?.count || 0;
      const cached24h = (db.prepare('SELECT COUNT(*) as count FROM s2_api_log WHERE cached = 1 AND timestamp >= ?').get(since24h) as any)?.count || 0;
      const total7d = (db.prepare('SELECT COUNT(*) as count FROM s2_api_log WHERE cached = 0 AND timestamp >= ?').get(since7d) as any)?.count || 0;
      const cached7d = (db.prepare('SELECT COUNT(*) as count FROM s2_api_log WHERE cached = 1 AND timestamp >= ?').get(since7d) as any)?.count || 0;
      const totalAllTime = (db.prepare('SELECT COUNT(*) as count FROM s2_api_log WHERE cached = 0').get() as any)?.count || 0;
      const cachedAllTime = (db.prepare('SELECT COUNT(*) as count FROM s2_api_log WHERE cached = 1').get() as any)?.count || 0;

      return {
        last24h: { api: total24h, cached: cached24h },
        last7d: { api: total7d, cached: cached7d },
        allTime: { api: totalAllTime, cached: cachedAllTime }
      };
    } catch (err: any) {
      return { last24h: {api:0, cached:0}, last7d: {api:0, cached:0}, allTime: {api:0, cached:0} };
    }
  }
}
