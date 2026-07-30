import { NextResponse } from 'next/server';
import db from '@/lib/db';

const S2_API_URL = 'https://api.semanticscholar.org/graph/v1';
const S2_FIELDS = 'paperId,title,year,publicationDate,authors,abstract,venue,citationCount,url';
const OPENALEX_API_URL = 'https://api.openalex.org';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const resolvedParams = await params;
    const { id } = resolvedParams; // this is collectionId

    const papers = db.prepare('SELECT id, title FROM papers WHERE collectionId = ? AND status = ?').all(id, 'seed') as any[];

    if (papers.length === 0) {
      return NextResponse.json({ citations: { fresh: 0, total: 0 }, references: { fresh: 0, total: 0 } });
    }

    let cacheFreshnessCitations = 7;
    if (process.env.CACHE_FRESHNESS_CITATIONS_DAYS) {
      cacheFreshnessCitations = parseInt(process.env.CACHE_FRESHNESS_CITATIONS_DAYS, 10);
      if (isNaN(cacheFreshnessCitations)) cacheFreshnessCitations = 7;
    } else if (process.env.CACHE_FRESHNESS_DAYS) {
      cacheFreshnessCitations = parseInt(process.env.CACHE_FRESHNESS_DAYS, 10);
      if (isNaN(cacheFreshnessCitations)) cacheFreshnessCitations = 7;
    }

    let cacheFreshnessReferences = 30;
    if (process.env.CACHE_FRESHNESS_REFERENCES_DAYS) {
      cacheFreshnessReferences = parseInt(process.env.CACHE_FRESHNESS_REFERENCES_DAYS, 10);
      if (isNaN(cacheFreshnessReferences)) cacheFreshnessReferences = 30;
    } else if (process.env.CACHE_FRESHNESS_DAYS) {
      cacheFreshnessReferences = parseInt(process.env.CACHE_FRESHNESS_DAYS, 10);
      if (isNaN(cacheFreshnessReferences)) cacheFreshnessReferences = 30;
    }

    const CACHE_CITATIONS_TTL_MS = cacheFreshnessCitations * 24 * 60 * 60 * 1000;
    const CACHE_REFERENCES_TTL_MS = cacheFreshnessReferences * 24 * 60 * 60 * 1000;
    const now = Date.now();

    const checkCache = (url: string, ttl: number) => {
      const row = db.prepare('SELECT timestamp FROM api_cache WHERE key = ?').get(url) as any;
      if (row) {
        const ts = new Date(row.timestamp + 'Z').getTime();
        return (now - ts) < ttl;
      }
      return false;
    };

    let citationsFresh = 0;
    let referencesFresh = 0;

    for (const paper of papers) {
      let isCitationsFresh = false;
      let isReferencesFresh = false;

      let s2Id = paper.id.startsWith('s2:') ? paper.id.replace('s2:', '') : null;

      // If we don't have an s2Id but we have an API key, we try to fetch it by title.
      // That uses `getS2PaperByTitle` which hits `/paper/search?query=...&limit=1&fields=paperId`.
      if (!s2Id && process.env.SEMANTIC_SCHOLAR_API_KEY) {
        const titleUrl = `${S2_API_URL}/paper/search?query=${encodeURIComponent(paper.title)}&limit=1&fields=paperId`;
        const titleRow = db.prepare('SELECT data, timestamp FROM api_cache WHERE key = ?').get(titleUrl) as any;
        if (titleRow && (now - new Date(titleRow.timestamp + 'Z').getTime() < CACHE_CITATIONS_TTL_MS)) {
          try {
            const data = JSON.parse(titleRow.data);
            if (data && data.data && data.data.length > 0) {
              s2Id = data.data[0].paperId;
            }
          } catch(e) {}
        }
      }

      if (s2Id) {
         const citationFields = S2_FIELDS.split(',').map(f => `citingPaper.${f}`).join(',');
         const referenceFields = S2_FIELDS.split(',').map(f => `citedPaper.${f}`).join(',');
         isCitationsFresh = checkCache(`${S2_API_URL}/paper/${s2Id}/citations?limit=500&offset=0&fields=${citationFields}`, CACHE_CITATIONS_TTL_MS);
         isReferencesFresh = checkCache(`${S2_API_URL}/paper/${s2Id}/references?limit=500&offset=0&fields=${referenceFields}`, CACHE_REFERENCES_TTL_MS);
      } else {
         if (process.env.SEMANTIC_SCHOLAR_API_KEY) {
           // We enforce S2. If we couldn't get an s2Id, we at least did a title search which would be cached.
           const titleUrl = `${S2_API_URL}/paper/search?query=${encodeURIComponent(paper.title)}&limit=1&fields=paperId`;
           isCitationsFresh = checkCache(titleUrl, CACHE_CITATIONS_TTL_MS);
           isReferencesFresh = isCitationsFresh;
         } else {
           isCitationsFresh = checkCache(`${OPENALEX_API_URL}/works?filter=cites:${paper.id}&per-page=20&sort=cited_by_count:desc`, CACHE_CITATIONS_TTL_MS);
           isReferencesFresh = checkCache(`${OPENALEX_API_URL}/works/${paper.id}`, CACHE_REFERENCES_TTL_MS); 
         }
      }

      if (isCitationsFresh) citationsFresh++;
      if (isReferencesFresh) referencesFresh++;
    }

    return NextResponse.json({
      citations: { fresh: citationsFresh, total: papers.length },
      references: { fresh: referencesFresh, total: papers.length }
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
