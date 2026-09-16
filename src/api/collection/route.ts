import { NextResponse } from 'next/server';
import { PaperRepository } from '@/domain/repositories/PaperRepository';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const collectionId = searchParams.get('collectionId');
  if (!collectionId) return NextResponse.json({ error: 'collectionId required' }, { status: 400 });

  try {
    const papers = PaperRepository.getPapersForCollection(collectionId);
    return NextResponse.json(papers);
  } catch (error: unknown) {
    console.error('Database GET error:', error);
    const message = error instanceof Error ? error.message : 'Unknown database error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { id, status = 'seed', collectionId } = body;
    
    if (!id || !collectionId) {
      return NextResponse.json({ error: 'Paper ID and collectionId are required' }, { status: 400 });
    }

    const paper = body;
    
    if (!paper || !paper.title) {
      const existingStatus = PaperRepository.getPaperStatus(id, collectionId);
      if (existingStatus) {
        if (existingStatus !== status) {
          PaperRepository.updatePaperStatus(id, collectionId, status);
          return NextResponse.json({ success: true, message: 'Paper status updated' }, { status: 200 });
        }
        return NextResponse.json({ success: true, message: 'Paper already in collection' }, { status: 200 });
      }
      return NextResponse.json({ error: 'Full paper details are required' }, { status: 400 });
    }

    const result = PaperRepository.upsertPaper(paper, collectionId, status);

    if (result.action === 'inserted') {
      return NextResponse.json({ success: true, message: 'Paper added successfully', paper }, { status: 200 });
    } else if (result.action === 'updated') {
      return NextResponse.json({ success: true, message: 'Paper status updated' }, { status: 200 });
    } else {
      return NextResponse.json({ success: true, message: 'Paper already in collection' }, { status: 200 });
    }
  } catch (error: unknown) {
    const err = error as { code?: string; message?: string };
    if (
      err.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
      err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
      err.code === 'SQLITE_CONSTRAINT' ||
      (err.message && /UNIQUE constraint failed/i.test(err.message)) ||
      (err.message && /PRIMARY KEY constraint failed/i.test(err.message))
    ) {
      return NextResponse.json({ success: true, message: 'Paper already in collection' }, { status: 200 });
    }
    console.error('Database POST error:', error);
    const message = err.message || 'Unknown database error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
