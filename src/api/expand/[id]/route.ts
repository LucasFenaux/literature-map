import { NextResponse } from 'next/server';
import { getPaperDetails, getCitations, getWorksByIds } from '@/lib/openalex';
import { getS2PaperByTitle, getS2Citations, getS2References } from '@/lib/semanticscholar';
import db from '@/lib/db';

const queueRetry = (paperId: string, type: string) => {
  try {
    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO retry_queue (id, paperId, type, status)
      VALUES (?, ?, ?, 'pending')
    `);
    insertStmt.run(`${paperId}-${type}`, paperId, type);
  } catch (err) {
    console.error('Failed to queue retry', err);
  }
};

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const resolvedParams = await params;
    const { id } = resolvedParams;
    const { searchParams } = new URL(request.url);
    const type = searchParams.get('type') || 'both'; // 'citations' | 'references' | 'both'

    let citations: any[] = [];
    let references: any[] = [];
    let paper: any = null;
    
    let targetS2Id = id.startsWith('s2:') ? id.replace('s2:', '') : null;
    
    // Prioritize Semantic Scholar if API key exists and we have an OpenAlex ID
    if (!targetS2Id && process.env.SEMANTIC_SCHOLAR_API_KEY) {
      const localPaper = db.prepare('SELECT title FROM papers WHERE id = ?').get(id) as any;
      let titleToSearch = localPaper?.title;

      if (titleToSearch) {
        try {
          targetS2Id = await getS2PaperByTitle(titleToSearch);
        } catch (e: any) {
          if (e.message === 'S2_RATE_LIMIT') queueRetry(id, type);
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
        if (e.message === 'S2_RATE_LIMIT') {
          queueRetry(id, type);
        } else {
          throw e;
        }
      }
    }
    
    // If we didn't use S2 (no ID found or no key), or S2 failed but we didn't throw, try OpenAlex natively
    if (!usedS2 && !process.env.SEMANTIC_SCHOLAR_API_KEY) {
      if (type === 'citations' || type === 'both') {
        citations = await getCitations(id, 200); 
      }
      
      if (type === 'references' || type === 'both') {
        if (!paper) paper = await getPaperDetails(id);
        const referenceIds = paper?.referencedWorks?.slice(0, 200) || [];
        if (referenceIds.length > 0) {
          references = await getWorksByIds(referenceIds);
        }
      }
      
      // Semantic Scholar Fallback Logic (if OpenAlex returned nothing and we didn't already try S2)
      if ((type === 'citations' || type === 'both') && citations.length === 0 && !targetS2Id) {
        const localPaper = db.prepare('SELECT title FROM papers WHERE id = ?').get(id) as any;
        let titleToSearch = localPaper?.title;
        if (!titleToSearch) {
          if (!paper) paper = await getPaperDetails(id);
          if (paper && paper.title) titleToSearch = paper.title;
        }

        if (titleToSearch) {
          try {
            const fallbackS2Id = await getS2PaperByTitle(titleToSearch);
            if (fallbackS2Id) citations = await getS2Citations(fallbackS2Id);
          } catch (e: any) {
            if (e.message === 'S2_RATE_LIMIT') queueRetry(id, 'citations');
          }
        }
      }

      if ((type === 'references' || type === 'both') && references.length === 0 && !targetS2Id) {
        const localPaper = db.prepare('SELECT title FROM papers WHERE id = ?').get(id) as any;
        let titleToSearch = localPaper?.title;
        if (!titleToSearch) {
          if (!paper) paper = await getPaperDetails(id);
          if (paper && paper.title) titleToSearch = paper.title;
        }

        if (titleToSearch) {
          try {
            const fallbackS2Id = await getS2PaperByTitle(titleToSearch);
            if (fallbackS2Id) references = await getS2References(fallbackS2Id);
          } catch (e: any) {
            if (e.message === 'S2_RATE_LIMIT') queueRetry(id, 'references');
          }
        }
      }
    }
    
    const collectionId = searchParams.get('collectionId');

    const savePapersAndLinks = (papers: any[], isCitation: boolean) => {
      if (!collectionId) return;
      
      const insertPaperStmt = db.prepare(`
        INSERT OR IGNORE INTO papers (id, collectionId, doi, title, abstract, authors, year, publicationDate, citationCount, url, venue, status, localTags, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'recommended', '[]', '')
      `);
      
      const insertLinkStmt = db.prepare(`
        INSERT OR IGNORE INTO citations (collectionId, sourceId, targetId)
        VALUES (?, ?, ?)
      `);

      db.transaction(() => {
        for (const p of papers) {
          insertPaperStmt.run(
            p.id,
            collectionId,
            p.doi || null,
            p.title || 'Unknown Title',
            p.abstract || '',
            JSON.stringify(p.authors || []),
            p.year || null,
            p.publicationDate || null,
            p.citationCount || 0,
            p.url || null,
            p.venue || null
          );
          
          const source = isCitation ? p.id : id;
          const target = isCitation ? id : p.id;
          insertLinkStmt.run(collectionId, source, target);
        }
      })();
    };

    if (citations.length > 0) savePapersAndLinks(citations, true);
    if (references.length > 0) savePapersAndLinks(references, false);

    // Cache cross-edges (new papers citing existing ones, or citing each other)
    if (collectionId) {
      try {
        const existingIdsObj = db.prepare('SELECT id FROM papers WHERE collectionId = ?').all(collectionId);
        const existingIds = new Set(existingIdsObj.map((r: any) => r.id));
        
        const allNewPapers = [...citations, ...references];
        const insertLinkStmt = db.prepare(`
          INSERT OR IGNORE INTO citations (collectionId, sourceId, targetId)
          VALUES (?, ?, ?)
        `);

        db.transaction(() => {
          for (const p of allNewPapers) {
            if (p.referencedWorks && p.referencedWorks.length > 0) {
              for (const refId of p.referencedWorks) {
                if (existingIds.has(refId)) {
                  insertLinkStmt.run(collectionId, p.id, refId);
                }
              }
            }
          }
        })();
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
