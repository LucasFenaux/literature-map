import { Paper } from './openalex';

const S2_API_URL = 'https://api.semanticscholar.org/graph/v1';
const S2_FIELDS = 'paperId,title,year,publicationDate,authors,abstract,venue,citationCount,url';

function getHeaders(): HeadersInit {
  const apiKey = process.env.SEMANTIC_SCHOLAR_API_KEY;
  if (apiKey) {
    return { 'x-api-key': apiKey };
  }
  return {};
}

import { EnvConfigAdapter } from '@/domain/repositories/SettingsRepository';
import { LogRepository } from '@/domain/repositories/LogRepository';
import { HttpClient } from '@/domain/adapters/HttpClient';

export function logS2ApiCall(endpoint: string, cached: boolean) {
  LogRepository.logApiCall(endpoint, cached);
}

function mapS2ToPaper(s2Paper: any): Paper {
  return {
    id: `s2:${s2Paper.paperId}`,
    title: s2Paper.title || 'Untitled',
    abstract: s2Paper.abstract || '',
    authors: (s2Paper.authors || []).map((a: any) => a.name),
    year: s2Paper.year || new Date().getFullYear(),
    citationCount: s2Paper.citationCount || 0,
    url: s2Paper.url || '',
    venue: s2Paper.venue || '',
    publicationDate: s2Paper.publicationDate || null,
    doi: null,
    referencedWorks: (s2Paper.references || []).map((r: any) => `s2:${r.paperId}`).filter((id: string) => id !== 's2:undefined')
  };
}

async function s2Fetch(url: string): Promise<any> {
  let cacheFreshnessDays = 7;
  const envConfig = EnvConfigAdapter.getEnvConfig();
  if (url.includes('/references?')) {
    cacheFreshnessDays = parseInt(envConfig.cacheFreshnessReferences, 10);
  } else {
    cacheFreshnessDays = parseInt(envConfig.cacheFreshnessCitations, 10);
  }
  
  if (isNaN(cacheFreshnessDays)) cacheFreshnessDays = 7;

  return HttpClient.fetchWithBackoff(url, getHeaders(), cacheFreshnessDays, 4, (cached) => logS2ApiCall(url, cached));
}

export async function searchS2Papers(query: string, limit = 10): Promise<Paper[]> {
  const url = `${S2_API_URL}/paper/search?query=${encodeURIComponent(query)}&limit=${limit}&fields=${S2_FIELDS},references.paperId`;
  const res = await s2Fetch(url);
  
  if (!res.ok) {
    if (res.status === 429) throw new Error('Rate limit exceeded (429)');
    throw new Error(`Semantic Scholar API Error: ${res.status}`);
  }
  
  const data = await res.json();
  if (data && data.data) {
    return data.data.map(mapS2ToPaper);
  }
  return [];
}

export async function getS2PaperByTitle(title: string): Promise<string | null> {
  const url = `${S2_API_URL}/paper/search?query=${encodeURIComponent(title)}&limit=1&fields=paperId`;
  const res = await s2Fetch(url);
  
  if (!res.ok) return null;
  
  const data = await res.json();
  if (data && data.data && data.data.length > 0) {
    return data.data[0].paperId;
  }
  return null;
}

export async function getS2PaperMatch(query: string): Promise<Paper | null> {
  const url = `${S2_API_URL}/paper/search/match?query=${encodeURIComponent(query)}&fields=${S2_FIELDS}`;
  const res = await s2Fetch(url);
  
  if (!res.ok) {
    if (res.status === 429) throw new Error('Rate limit exceeded (429)');
    if (res.status === 400) return null; // 400 means no match found often
    throw new Error(`Semantic Scholar API Error: ${res.status}`);
  }
  
  const data = await res.json();
  if (data && data.data && data.data.length > 0) {
    return mapS2ToPaper(data.data[0]);
  }
  return null;
}

export async function getS2Citations(paperId: string, limit = 500, maxTotal = 2000, returnLimit = 2000): Promise<Paper[]> {
  let allCitations: any[] = [];
  let offset = 0;
  
  const citationFields = S2_FIELDS.split(',').map(f => `citingPaper.${f}`).join(',');
  
  while (allCitations.length < maxTotal) {
    const url = `${S2_API_URL}/paper/${paperId}/citations?limit=${limit}&offset=${offset}&fields=${citationFields}`;
    const res = await s2Fetch(url);
    
    if (!res.ok) break;
    
    const data = await res.json();
    if (!data || !data.data || data.data.length === 0) break;
    
    allCitations = allCitations.concat(data.data);
    
    if (data.next) {
      offset = data.next;
    } else if (data.data.length < limit) {
      break;
    } else {
      offset += limit;
    }
  }
  
  // Sort by citation count locally to pick the top ones
  allCitations.sort((a, b) => (b.citingPaper?.citationCount || 0) - (a.citingPaper?.citationCount || 0));
  allCitations = allCitations.slice(0, returnLimit);
  
  return allCitations
    .map((d: any) => d.citingPaper)
    .filter((p: any) => p && p.paperId)
    .map(mapS2ToPaper);
}

export async function getS2References(paperId: string, limit = 500, maxTotal = 2000, returnLimit = 500): Promise<Paper[]> {
  let allReferences: any[] = [];
  let offset = 0;
  
  const referenceFields = S2_FIELDS.split(',').map(f => `citedPaper.${f}`).join(',');
  
  while (allReferences.length < maxTotal) {
    const url = `${S2_API_URL}/paper/${paperId}/references?limit=${limit}&offset=${offset}&fields=${referenceFields}`;
    const res = await s2Fetch(url);
    
    if (!res.ok) break;
    
    const data = await res.json();
    if (!data || !data.data || data.data.length === 0) break;
    
    allReferences = allReferences.concat(data.data);
    
    if (data.next) {
      offset = data.next;
    } else if (data.data.length < limit) {
      break;
    } else {
      offset += limit;
    }
  }
  
  allReferences.sort((a, b) => (b.citedPaper?.citationCount || 0) - (a.citedPaper?.citationCount || 0));
  allReferences = allReferences.slice(0, returnLimit);
  
  return allReferences
    .map((d: any) => d.citedPaper)
    .filter((p: any) => p && p.paperId)
    .map(mapS2ToPaper);
}

export async function getS2PapersByDois(dois: string[]): Promise<Paper[]> {
  if (dois.length === 0) return [];
  
  const results: Paper[] = [];
  
  // S2 batch endpoint often times out when requesting references for many papers.
  // We use concurrent individual searches with a concurrency limit.
  const limit = 5; 
  let active = 0;
  let index = 0;
  
  return new Promise((resolve) => {
    const next = async () => {
      if (index >= dois.length && active === 0) {
        resolve(results);
        return;
      }
      while (active < limit && index < dois.length) {
        const i = index++;
        active++;
        const cleanDoi = dois[i].replace(/[{}]/g, '');
        const url = `${S2_API_URL}/paper/DOI:${cleanDoi}?fields=${S2_FIELDS}`;
        
        s2Fetch(url)
          .then(async res => {
            if (res.ok) {
              const data = await res.json();
              if (data && data.paperId) {
                results.push(mapS2ToPaper(data));
              }
            }
          })
          .catch(e => {
            console.error('Error fetching DOI in batch wrapper:', cleanDoi, e);
          })
          .finally(() => {
            active--;
            next();
          });
      }
    };
    next();
  });
}
