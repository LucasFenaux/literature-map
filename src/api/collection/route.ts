import { NextResponse } from 'next/server';
import { PaperRepository } from '@/domain/repositories/PaperRepository';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const collectionId = searchParams.get('collectionId');
  if (!collectionId) return NextResponse.json({ error: 'collectionId required' }, { status: 400 });

  try {
    const papers = PaperRepository.getPapersForCollection(collectionId);
    return NextResponse.json(papers);
  } catch (error: any) {
    console.error('Database GET error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { id, status = 'seed', collectionId } = body;
    
    if (!id || !collectionId) {
      return NextResponse.json({ error: 'Paper ID and collectionId are required' }, { status: 400 });
    }

    const existingStatus = PaperRepository.getPaperStatus(id, collectionId);
    
    if (existingStatus) {
      if (existingStatus !== status) {
        PaperRepository.updatePaperStatus(id, collectionId, status);
        return NextResponse.json({ message: 'Paper status updated' }, { status: 200 });
      }
      return NextResponse.json({ message: 'Paper already in collection' }, { status: 200 });
    }

    const paper = body;
    
    if (!paper || !paper.title) {
      return NextResponse.json({ error: 'Full paper details are required' }, { status: 400 });
    }

    PaperRepository.addPaper(paper, collectionId, status);

    return NextResponse.json({ message: 'Paper added successfully', paper });
  } catch (error: any) {
    console.error('Database POST error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
