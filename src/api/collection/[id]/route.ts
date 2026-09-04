import { NextResponse } from 'next/server';
import { PaperRepository } from '@/domain/repositories/PaperRepository';

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const resolvedParams = await params;
    const { id } = resolvedParams;
    const { searchParams } = new URL(request.url);
    const collectionId = searchParams.get('collectionId');
    if (!collectionId) return NextResponse.json({ error: 'collectionId required' }, { status: 400 });

    const body = await request.json();
    const { status, localTags, notes } = body;
    
    const current = PaperRepository.getPaper(id, collectionId);
    
    if (!current) {
      return NextResponse.json({ error: 'Paper not found in collection' }, { status: 404 });
    }

    const newStatus = status !== undefined ? status : current.status;
    const newTags = localTags !== undefined ? JSON.stringify(localTags) : JSON.stringify(current.localTags);
    const newNotes = notes !== undefined ? notes : current.notes;

    PaperRepository.updatePaper(id, collectionId, newStatus, newTags, newNotes);

    return NextResponse.json({ message: 'Paper updated successfully' });
  } catch (error: any) {
    console.error('Database PUT error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const resolvedParams = await params;
    const { id } = resolvedParams;
    const { searchParams } = new URL(request.url);
    const collectionId = searchParams.get('collectionId');
    if (!collectionId) return NextResponse.json({ error: 'collectionId required' }, { status: 400 });
    
    PaperRepository.deletePaper(id, collectionId);

    return NextResponse.json({ message: 'Paper deleted successfully' });
  } catch (error: any) {
    console.error('Database DELETE error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
