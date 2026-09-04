import { NextResponse } from 'next/server';
import { logS2ApiCall } from '@/lib/semanticscholar';
import { PaperRepository } from '@/domain/repositories/PaperRepository';
import { CitationRepository } from '@/domain/repositories/CitationRepository';

const S2_API_URL = 'https://api.semanticscholar.org/graph/v1';
const OPENALEX_API_URL = 'https://api.openalex.org';

function getS2Headers(): HeadersInit {
  const apiKey = process.env.SEMANTIC_SCHOLAR_API_KEY;
  if (apiKey) {
    return { 'x-api-key': apiKey, 'Content-Type': 'application/json' };
  }
  return { 'Content-Type': 'application/json' };
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const resolvedParams = await params;
    const collectionId = resolvedParams.id;
    
    // 1. Get all papers in the collection
    const existingPapers = PaperRepository.getPapersForCollection(collectionId);
    
    if (!existingPapers || existingPapers.length === 0) {
      return NextResponse.json({ success: true, addedEdges: 0 });
    }

    const existingIdsSet = new Set(existingPapers.map((p: any) => p.id));
    
    const s2Ids: string[] = [];
    const oaIds: string[] = [];
    
    for (const p of existingPapers) {
      if (p.id.startsWith('s2:')) {
        s2Ids.push(p.id.replace('s2:', ''));
      } else {
        oaIds.push(p.id);
      }
    }

    const newEdges: { source: string, target: string }[] = [];

    // 2. Fetch references for S2 IDs in batches of 500
    if (s2Ids.length > 0) {
      const BATCH_SIZE = 500;
      for (let i = 0; i < s2Ids.length; i += BATCH_SIZE) {
        const batch = s2Ids.slice(i, i + BATCH_SIZE);
        try {
          const res = await fetch(`${S2_API_URL}/paper/batch?fields=paperId,references.paperId`, {
            method: 'POST',
            headers: getS2Headers(),
            body: JSON.stringify({ ids: batch })
          });
          
          if (res.ok) {
            logS2ApiCall(`batch:paper/batch?fields=paperId,references.paperId`, false);
            const data = await res.json();
            for (const item of data) {
              if (!item || !item.paperId) continue;
              const sourceId = `s2:${item.paperId}`;
              if (item.references && Array.isArray(item.references)) {
                for (const ref of item.references) {
                  if (!ref.paperId) continue;
                  const targetId = `s2:${ref.paperId}`;
                  if (existingIdsSet.has(targetId)) {
                    newEdges.push({ source: sourceId, target: targetId });
                  }
                }
              }
            }
          }
        } catch (err) {
          console.error('Failed to fetch S2 batch', err);
        }
      }
    }

    // 3. Fetch references for OpenAlex IDs in batches of 50
    if (oaIds.length > 0) {
      const BATCH_SIZE = 50;
      for (let i = 0; i < oaIds.length; i += BATCH_SIZE) {
        const batch = oaIds.slice(i, i + BATCH_SIZE);
        const filterStr = batch.join('|');
        try {
          const res = await fetch(`${OPENALEX_API_URL}/works?filter=openalex_id:${filterStr}&per-page=50&select=id,referenced_works`);
          if (res.ok) {
            const data = await res.json();
            if (data.results && Array.isArray(data.results)) {
              for (const work of data.results) {
                const sourceId = work.id.replace('https://openalex.org/', '');
                if (work.referenced_works && Array.isArray(work.referenced_works)) {
                  for (const rw of work.referenced_works) {
                    const targetId = rw.replace('https://openalex.org/', '');
                    if (existingIdsSet.has(targetId)) {
                      newEdges.push({ source: sourceId, target: targetId });
                    }
                  }
                }
              }
            }
          }
        } catch (err) {
          console.error('Failed to fetch OpenAlex batch', err);
        }
      }
    }

    // 4. Insert all found edges into the database
    if (newEdges.length > 0) {
      CitationRepository.addLinks(collectionId, newEdges);
      return NextResponse.json({ success: true, addedEdges: newEdges.length });
    }

    return NextResponse.json({ success: true, addedEdges: 0 });

  } catch (err: any) {
    console.error('Error rebuilding edges:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
