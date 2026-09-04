import db from '@/lib/db';
import fs from 'fs';
import path from 'path';

export class SettingsRepository {
  static getSetting(key: string): string | null {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any;
    return row ? row.value : null;
  }

  static setSetting(key: string, value: string): void {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  }
}

export class EnvConfigAdapter {
  static getEnvConfig() {
    const envPath = path.join(process.cwd(), '.env.local');
    let apiKey = '';
    let rateLimit = '1';
    let cacheFreshnessCitations = '7';
    let cacheFreshnessReferences = '30';
    let maxTopNLimit = '100';
    
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      const matchKey = content.match(/^SEMANTIC_SCHOLAR_API_KEY=(.*)$/m);
      if (matchKey) apiKey = matchKey[1].trim();
      
      const matchLimit = content.match(/^SEMANTIC_SCHOLAR_RATE_LIMIT=(.*)$/m);
      if (matchLimit) rateLimit = matchLimit[1].trim();

      const matchCacheCit = content.match(/^CACHE_FRESHNESS_CITATIONS_DAYS=(.*)$/m);
      if (matchCacheCit) cacheFreshnessCitations = matchCacheCit[1].trim();
      else if (content.match(/^CACHE_FRESHNESS_DAYS=(.*)$/m)) cacheFreshnessCitations = content.match(/^CACHE_FRESHNESS_DAYS=(.*)$/m)![1].trim();
      
      const matchCacheRef = content.match(/^CACHE_FRESHNESS_REFERENCES_DAYS=(.*)$/m);
      if (matchCacheRef) cacheFreshnessReferences = matchCacheRef[1].trim();
      else if (content.match(/^CACHE_FRESHNESS_DAYS=(.*)$/m)) cacheFreshnessReferences = content.match(/^CACHE_FRESHNESS_DAYS=(.*)$/m)![1].trim();

      const matchMaxTopNLimit = content.match(/^MAX_TOP_N_LIMIT=(.*)$/m);
      if (matchMaxTopNLimit) maxTopNLimit = matchMaxTopNLimit[1].trim();
    } else {
      if (process.env.SEMANTIC_SCHOLAR_API_KEY) apiKey = process.env.SEMANTIC_SCHOLAR_API_KEY;
      if (process.env.SEMANTIC_SCHOLAR_RATE_LIMIT) rateLimit = process.env.SEMANTIC_SCHOLAR_RATE_LIMIT;
      if (process.env.CACHE_FRESHNESS_CITATIONS_DAYS) cacheFreshnessCitations = process.env.CACHE_FRESHNESS_CITATIONS_DAYS;
      else if (process.env.CACHE_FRESHNESS_DAYS) cacheFreshnessCitations = process.env.CACHE_FRESHNESS_DAYS;
      
      if (process.env.CACHE_FRESHNESS_REFERENCES_DAYS) cacheFreshnessReferences = process.env.CACHE_FRESHNESS_REFERENCES_DAYS;
      else if (process.env.CACHE_FRESHNESS_DAYS) cacheFreshnessReferences = process.env.CACHE_FRESHNESS_DAYS;
      
      if (process.env.MAX_TOP_N_LIMIT) maxTopNLimit = process.env.MAX_TOP_N_LIMIT;
    }
    
    return {
      semanticScholarApiKey: apiKey,
      semanticScholarRateLimit: rateLimit,
      cacheFreshnessCitations,
      cacheFreshnessReferences,
      maxTopNLimit
    };
  }
}
