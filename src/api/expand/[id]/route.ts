import { NextResponse } from 'next/server';
import { getPaperDetails, getCitations, getWorksByIds } from '@/lib/openalex';
import { getS2PaperByTitle, getS2Citations, getS2References } from '@/lib/semanticscholar';
import { PaperRepository } from '@/domain/repositories/PaperRepository';
import { QueueRepository } from '@/domain/repositories/QueueRepository';
import { CitationRepository } from '@/domain/repositories/CitationRepository';

const queueRetry = (paperId: string, type: 'citations' | 'references' | 'both', collectionId?: string) => {
  try {
    QueueRepository.addQueueItem(paperId, type, collectionId);
  } catch (err) {
    console.error('Failed to queue retry', err);
  }
};

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const resolvedParams = await params;
    const { id } = resolvedParams;
    const { searchParams } = new URL(request.url);
    const type = (searchParams.get('type') || 'both') as 'citations' | 'references' | 'both';
    const collectionId = searchParams.get('collectionId') || undefined;

    let citations: any[] = [];
    let references: any[] = [];
    let paper: any = null;
    
    let targetS2Id = id.startsWith('s2:') ? id.replace('s2:', '') : null;
    
    // Prioritize Semantic Scholar if API key exists and we have an OpenAlex ID
    if (!targetS2Id && process.env.SEMANTIC_SCHOLAR_API_KEY) {
      const localPaper = PaperRepository.getPaperById(id);
      let titleToSearch = localPaper?.title;

      if (titleToSearch) {
        try {
          targetS2Id = await getS2PaperByTitle(titleToSearch);
        } catch (e: any) {
          if (e.message === 'S2_RATE_LIMIT' || e.message === 'RATE_LIMIT') queueRetry(id, type, collectionId);
        }
      }
    }

    // Try fetching with Semantic Scholar first if we have a targetS2Id
    let usedS2 = false;
    if (targetS2Id) {
      try {
        if (type === 'citations' || type === 'both') citations = await getS2Citations(targetS2Id);
        if (type === 'references' || type === 'both') references = await getS2References(targetS2Id);
        usedS2 = true;
      } catch (e: any) {
        if (e.message === 'S2_RATE_LIMIT' || e.message === 'RATE_LIMIT') {
          queueRetry(id, type, collectionId);
        } else {
          throw e;
        }
      }
    }
    
    // If we didn't use S2 (no ID found or no key), or S2 failed but we didn't throw, try OpenAlex natively
    if (!usedS2 && !process.env.SEMANTIC_SCHOLAR_API_KEY) {
      if (type === 'citations' || type === 'both') {
        try {
          citations = await getCitations(id, 200); 
        } catch (e: any) {
          if (e.message === 'RATE_LIMIT' || e.message === 'S2_RATE_LIMIT') {
            queueRetry(id, 'citations', collectionId);
          } else {
            throw e;
          }
        }
      }
      
      if (type === 'references' || type === 'both') {
        try {
          if (!paper) paper = await getPaperDetails(id);
          const referenceIds = paper?.referencedWorks?.slice(0, 200) || [];
          if (referenceIds.length > 0) {
            references = await getWorksByIds(referenceIds);
          }
        } catch (e: any) {
          if (e.message === 'RATE_LIMIT' || e.message === 'S2_RATE_LIMIT') {
            queueRetry(id, 'references', collectionId);
          } else {
            throw e;
          }
        }
      }
      
      // Semantic Scholar Fallback Logic (if OpenAlex returned nothing and we didn't already try S2)
      if ((type === 'citations' || type === 'both') && citations.length === 0 && !targetS2Id) {
        const localPaper = PaperRepository.getPaperById(id);
        let titleToSearch = localPaper?.title;
        if (!titleToSearch) {
          try {
            if (!paper) paper = await getPaperDetails(id);
          } catch (e: any) {
            if (e.message === 'S2_RATE_LIMIT' || e.message === 'RATE_LIMIT') {
              queueRetry(id, 'citations', collectionId);
            }
          }
          if (paper && paper.title) titleToSearch = paper.title;
        }

        if (titleToSearch) {
          try {
            const fallbackS2Id = await getS2PaperByTitle(titleToSearch);
            if (fallbackS2Id) citations = await getS2Citations(fallbackS2Id);
          } catch (e: any) {
            if (e.message === 'S2_RATE_LIMIT' || e.message === 'RATE_LIMIT') queueRetry(id, 'citations', collectionId);
          }
        }
      }

      if ((type === 'references' || type === 'both') && references.length === 0 && !targetS2Id) {
        const localPaper = PaperRepository.getPaperById(id);
        let titleToSearch = localPaper?.title;
        if (!titleToSearch) {
          try {
            if (!paper) paper = await getPaperDetails(id);
          } catch (e: any) {
            if (e.message === 'S2_RATE_LIMIT' || e.message === 'RATE_LIMIT') {
              queueRetry(id, 'references', collectionId);
            }
          }
          if (paper && paper.title) titleToSearch = paper.title;
        }

        if (titleToSearch) {
          try {
            const fallbackS2Id = await getS2PaperByTitle(titleToSearch);
            if (fallbackS2Id) references = await getS2References(fallbackS2Id);
          } catch (e: any) {
            if (e.message === 'S2_RATE_LIMIT' || e.message === 'RATE_LIMIT') queueRetry(id, 'references', collectionId);
          }
        }
      }
    }

    const savePapersAndLinks = (papers: any[], isCitation: boolean) => {
      if (!collectionId) return;
      
      PaperRepository.addPapers(papers, collectionId, 'recommended');

      const newLinks = [];

      for (const p of papers) {
        const source = isCitation ? p.id : id;
        const target = isCitation ? id : p.id;
        newLinks.push({ source, target });
      }
      CitationRepository.addLinks(collectionId, newLinks);
    };

    if (citations.length > 0) savePapersAndLinks(citations, true);
    if (references.length > 0) savePapersAndLinks(references, false);

    // Cache cross-edges (new papers citing existing ones, or citing each other)
    if (collectionId) {
      try {
        const existingPapersObj = PaperRepository.getPapersForCollection(collectionId);
        const existingIds = new Set(existingPapersObj.map((r: any) => r.id));
        
        const allNewPapers = [...citations, ...references];
        const crossLinks = [];

        for (const p of allNewPapers) {
          if (p.referencedWorks && p.referencedWorks.length > 0) {
            for (const refId of p.referencedWorks) {
              if (existingIds.has(refId)) {
                crossLinks.push({ source: p.id, target: refId });
              }
            }
          }
        }
        CitationRepository.addLinks(collectionId, crossLinks);
      } catch (err) {
        console.error('Failed to cache cross-edges', err);
      }
    }

    return NextResponse.json({
      citations,
      references
    });
  } catch (error: any) {
    console.error('Expand API error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
