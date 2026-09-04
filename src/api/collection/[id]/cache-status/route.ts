import { NextResponse } from 'next/server';
import { PaperRepository } from '@/domain/repositories/PaperRepository';
import { CacheRepository } from '@/domain/repositories/CacheRepository';
import { EnvConfigAdapter } from '@/domain/repositories/SettingsRepository';

const S2_API_URL = 'https://api.semanticscholar.org/graph/v1';
const S2_FIELDS = 'paperId,title,year,publicationDate,authors,abstract,venue,citationCount,url';
const OPENALEX_API_URL = 'https://api.openalex.org';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const resolvedParams = await params;
    const { id } = resolvedParams; // this is collectionId

    const papers = PaperRepository.getPapersForCollection(id).filter((p: any) => p.status === 'seed');

    if (papers.length === 0) {
      return NextResponse.json({ citations: { fresh: 0, total: 0 }, references: { fresh: 0, total: 0 } });
    }

    const envConfig = EnvConfigAdapter.getEnvConfig();
    let cacheFreshnessCitations = parseInt(envConfig.cacheFreshnessCitations, 10);
    if (isNaN(cacheFreshnessCitations)) cacheFreshnessCitations = 7;

    let cacheFreshnessReferences = parseInt(envConfig.cacheFreshnessReferences, 10);
    if (isNaN(cacheFreshnessReferences)) cacheFreshnessReferences = 30;

    const CACHE_CITATIONS_TTL_MS = cacheFreshnessCitations * 24 * 60 * 60 * 1000;
    const CACHE_REFERENCES_TTL_MS = cacheFreshnessReferences * 24 * 60 * 60 * 1000;
    const now = Date.now();

    const checkCache = (url: string, ttl: number) => {
      const timestamp = CacheRepository.getTimestamp(url);
      if (timestamp) {
        const ts = new Date(timestamp + 'Z').getTime();
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

      if (!s2Id && envConfig.semanticScholarApiKey) {
        const titleUrl = `${S2_API_URL}/paper/search?query=${encodeURIComponent(paper.title)}&limit=1&fields=paperId`;
        const cached = CacheRepository.get(titleUrl);
        if (cached && (now - new Date(cached.timestamp + 'Z').getTime() < CACHE_CITATIONS_TTL_MS)) {
          try {
            const data = JSON.parse(cached.data);
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
         if (envConfig.semanticScholarApiKey) {
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
