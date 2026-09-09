import { QueueRepository } from '@/domain/repositories/QueueRepository';
import { PaperRepository } from '@/domain/repositories/PaperRepository';
import { CitationRepository } from '@/domain/repositories/CitationRepository';
import { getS2PaperByTitle, getS2Citations, getS2References } from '@/lib/semanticscholar';
import { getPaperDetails, getCitations, getWorksByIds } from '@/lib/openalex';

export class EnrichmentJobProcessor {
  static async processBatch(limit: number = 5): Promise<void> {
    const pendingItems = QueueRepository.getPendingItems(limit);

    if (pendingItems.length === 0) return;

    for (const item of pendingItems) {
      const { id, paperId, type } = item;
      try {
        let collectionId = item.collectionId;
        if (!collectionId) {
          const localPaper = PaperRepository.getPaperById(paperId);
          collectionId = localPaper?.collectionId;
        }

        if (!collectionId) {
          console.warn(`Queue item ${id} missing collectionId and cannot resolve from paper, marking failed`);
          QueueRepository.updateStatus(id, 'failed');
          continue;
        }

        let citations: any[] = [];
        let references: any[] = [];
        let paper: any = null;

        let targetS2Id = paperId.startsWith('s2:') ? paperId.replace('s2:', '') : null;

        if (!targetS2Id) {
          const localPaper = PaperRepository.getPaperById(paperId);
          let titleToSearch = localPaper?.title;

          if (!titleToSearch && !process.env.SEMANTIC_SCHOLAR_API_KEY) {
            paper = await getPaperDetails(paperId);
            if (paper && paper.title) {
              titleToSearch = paper.title;
            }
          }

          if (titleToSearch) {
            targetS2Id = await getS2PaperByTitle(titleToSearch);
          }
        }

        if (targetS2Id) {
          if (type === 'citations' || type === 'both') citations = await getS2Citations(targetS2Id);
          if (type === 'references' || type === 'both') references = await getS2References(targetS2Id);
        } else if (!process.env.SEMANTIC_SCHOLAR_API_KEY) {
          // If we couldn't resolve S2, use OpenAlex natively
          if (type === 'citations' || type === 'both') {
            citations = await getCitations(paperId, 20); 
          }
          if (type === 'references' || type === 'both') {
            if (!paper) paper = await getPaperDetails(paperId);
            const referenceIds = paper?.referencedWorks?.slice(0, 20) || [];
            if (referenceIds.length > 0) {
              references = await getWorksByIds(referenceIds);
            }
          }
        }

        // Persist citations under collectionId
        if (citations.length > 0) {
          PaperRepository.addPapers(citations, collectionId, 'recommended');
          const citationLinks = citations.map((p) => ({ source: p.id, target: paperId }));
          CitationRepository.addLinks(collectionId, citationLinks);
        }

        // Persist references under collectionId
        if (references.length > 0) {
          PaperRepository.addPapers(references, collectionId, 'recommended');
          const referenceLinks = references.map((p) => ({ source: paperId, target: p.id }));
          CitationRepository.addLinks(collectionId, referenceLinks);
        }

        // Persist any cross-citation links among fetched papers and collection papers
        try {
          const collectionPapers = PaperRepository.getPapersForCollection(collectionId);
          const collectionIds = new Set(collectionPapers.map((r: any) => r.id));
          const allNewPapers = [...citations, ...references];
          const crossLinks: { source: string; target: string }[] = [];

          for (const p of allNewPapers) {
            if (p.referencedWorks && Array.isArray(p.referencedWorks)) {
              for (const refId of p.referencedWorks) {
                if (collectionIds.has(refId) && refId !== p.id) {
                  crossLinks.push({ source: p.id, target: refId });
                }
              }
            }
          }

          if (crossLinks.length > 0) {
            CitationRepository.addLinks(collectionId, crossLinks);
          }
        } catch (crossErr) {
          console.error(`Failed to cache cross-edges for queue item ${id}:`, crossErr);
        }

        QueueRepository.updateStatus(id, 'completed');
        if (process.env.NODE_ENV !== 'test' && process.env.SQLITE_DB_PATH !== ':memory:') {
          await new Promise(r => setTimeout(r, 1000));
        }
      } catch (err: any) {
        if (err.message === 'RATE_LIMIT' || err.message === 'S2_RATE_LIMIT') {
          console.warn(`Queue item ${id} hit rate limit, deferring...`);
          break; // Stop processing further items in this tick to respect rate limit
        } else {
          console.error(`Queue item ${id} failed:`, err);
          QueueRepository.updateStatus(id, 'failed');
        }
      }
    }
  }
}
