const OPENALEX_API_URL = 'https://api.openalex.org';

export interface OpenAlexWork {
  id: string; // OpenAlex ID (e.g. 'https://openalex.org/W12345')
  doi: string | null;
  title: string;
  publication_year: number;
  cited_by_count: number;
  authorships: Array<{
    author: {
      display_name: string;
      id: string;
    }
  }>;
  abstract_inverted_index: Record<string, number[]> | null;
  primary_location?: {
    landing_page_url?: string;
    pdf_url?: string;
    source?: {
      display_name?: string;
    }
  };
  referenced_works: string[];
}

export interface Paper {
  id: string; // We'll just store the Wxxxx part
  doi: string | null;
  title: string;
  year: number;
  publicationDate: string | null;
  citationCount: number;
  authors: string[];
  abstract: string | null;
  url: string | null;
  venue: string | null;
  referencedWorks: string[]; // OpenAlex IDs
}

function parseAbstract(invertedIndex: Record<string, number[]> | null): string | null {
  if (!invertedIndex) return null;
  
  // Find max position
  let maxPos = 0;
  for (const positions of Object.values(invertedIndex)) {
    for (const pos of positions) {
      if (pos > maxPos) maxPos = pos;
    }
  }
  
  const words = new Array(maxPos + 1).fill('');
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const pos of positions) {
      words[pos] = word;
    }
  }
  return words.join(' ').trim();
}

function mapToPaper(work: OpenAlexWork): Paper {
  const shortId = work.id.replace('https://openalex.org/', '');
  return {
    id: shortId,
    doi: work.doi,
    title: work.title || 'Untitled',
    year: work.publication_year,
    publicationDate: (work as any).publication_date || null,
    citationCount: work.cited_by_count,
    authors: work.authorships?.map((a) => a.author.display_name) || [],
    abstract: parseAbstract(work.abstract_inverted_index),
    url: work.primary_location?.landing_page_url || work.primary_location?.pdf_url || work.doi || null,
    venue: work.primary_location?.source?.display_name || null,
    referencedWorks: (work.referenced_works || []).map((rw) => rw.replace('https://openalex.org/', ''))
  };
}

function deduplicatePapers(papers: Paper[]): Paper[] {
  const seen = new Set<string>();
  return papers.filter((paper) => {
    // We normalize the title to catch slight variations
    const normTitle = (paper.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    
    if (!normTitle || seen.has(normTitle)) return false;
    seen.add(normTitle);
    return true;
  });
}

import { HttpClient } from '@/domain/adapters/HttpClient';

async function fetchWithCache(url: string): Promise<any> {
  let cacheFreshnessDays = 7;
  if (process.env.CACHE_FRESHNESS_DAYS) {
    cacheFreshnessDays = parseInt(process.env.CACHE_FRESHNESS_DAYS, 10);
    if (isNaN(cacheFreshnessDays)) cacheFreshnessDays = 7;
  }
  const res = await HttpClient.fetchWithBackoff(url, {}, cacheFreshnessDays, 1);
  if (!res) return null;
  return res.json();
}

export async function searchPapers(query: string): Promise<Paper[]> {
  // If query looks like a DOI
  const isDoi = query.startsWith('10.') || query.includes('doi.org/');
  
  let url = `${OPENALEX_API_URL}/works`;
  
  if (isDoi) {
    const cleanDoi = query.replace('https://doi.org/', '');
    url += `?filter=doi:${encodeURIComponent(cleanDoi)}`;
  } else {
    url += `?search=${encodeURIComponent(query)}&per-page=10`;
  }
  
  const data = await fetchWithCache(url);
  if (!data) throw new Error('Failed to fetch from OpenAlex');
  const papers = (data.results || []).map(mapToPaper);
  return deduplicatePapers(papers);
}

export async function getPaperDetails(id: string): Promise<Paper | null> {
  // OpenAlex works ID e.g., W2741809807
  const url = `${OPENALEX_API_URL}/works/${id}`;
  const data = await fetchWithCache(url);
  if (!data) return null;
  return mapToPaper(data);
}

export async function getCitations(id: string, limit = 50): Promise<Paper[]> {
  const url = `${OPENALEX_API_URL}/works?filter=cites:${id}&per-page=${limit}&sort=cited_by_count:desc`;
  const data = await fetchWithCache(url);
  if (!data) throw new Error('Failed to fetch citations');
  const papers = (data.results || []).map(mapToPaper);
  return deduplicatePapers(papers);
}

export async function getWorksByIds(ids: string[]): Promise<Paper[]> {
  if (ids.length === 0) return [];
  // The IDs might be full URIs like https://openalex.org/Wxxxx
  const cleanIds = ids.map(id => id.replace('https://openalex.org/', ''));
  // The filter should be openalex:W1|W2|W3
  const filterStr = `openalex:${cleanIds.join('|')}`;
  const url = `${OPENALEX_API_URL}/works?filter=${filterStr}&per-page=50`;
  const data = await fetchWithCache(url);
  if (!data) throw new Error('Failed to fetch works by IDs');
  const papers = (data.results || []).map(mapToPaper);
  return deduplicatePapers(papers);
}
