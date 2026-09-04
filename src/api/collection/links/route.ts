import { NextResponse } from 'next/server';
import { CitationRepository } from '@/domain/repositories/CitationRepository';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const collectionId = searchParams.get('collectionId');
  
  if (!collectionId) {
    return NextResponse.json({ error: 'collectionId required' }, { status: 400 });
  }

  try {
    const links = CitationRepository.getLinksForCollection(collectionId);
    return NextResponse.json(links);
  } catch (error: any) {
    console.error('Database GET links error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
