import { CacheRepository } from '@/domain/repositories/CacheRepository';

export class HttpClient {
  static async fetchWithBackoff(
    url: string,
    headers: HeadersInit,
    cacheFreshnessDays: number,
    retries = 4,
    cacheCallback?: (cached: boolean) => void,
    options?: RequestInit
  ): Promise<any> {
    const CACHE_TTL_MS = cacheFreshnessDays * 24 * 60 * 60 * 1000;
    
    // Check cache
    const cacheKey = options?.body ? `${url}#${options.body}` : url;
    try {
      const cached = CacheRepository.get(cacheKey);
      if (cached) {
        const ts = new Date(cached.timestamp + 'Z').getTime();
        if (Date.now() - ts < CACHE_TTL_MS) {
          if (cacheCallback) cacheCallback(true);
          const parsed = JSON.parse(cached.data);
          if (parsed.error === 404) return null;
          return { ok: true, status: 200, json: async () => parsed };
        }
      }
    } catch (e) {
      console.error('Cache read error', e);
    }
  
    let attempt = 0;
    const baseDelay = process.env.NODE_ENV === 'test' ? 10 : 1000;
    
    while (attempt < retries) {
      const fetchHeaders = options?.headers
        ? { ...headers, ...(options.headers as any) }
        : headers;
      const res = await fetch(url, { ...options, headers: fetchHeaders });
      if (res.status !== 429) {
        if (cacheCallback) cacheCallback(false);
        if (res.ok || res.status === 404 || res.status === 400) {
          const cloned = res.clone();
          const data = await cloned.text();
          try {
            CacheRepository.set(cacheKey, data);
          } catch (e) {
            console.error('Cache write error', e);
          }
        }
        if (res.status === 404) {
           return null;
        }
        return res;
      }
      attempt++;
      if (attempt >= retries) {
        throw new Error('RATE_LIMIT');
      }
      const jitter = process.env.NODE_ENV === 'test' ? Math.random() * 5 : Math.random() * 500;
      const delayMs = Math.min(baseDelay * Math.pow(2, attempt) + jitter, 5000);
      await new Promise(r => setTimeout(r, delayMs));
    }
    throw new Error('RATE_LIMIT');
  }
}
