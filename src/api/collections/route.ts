import { NextResponse } from 'next/server';
import { CollectionRepository } from '@/domain/repositories/CollectionRepository';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const collections = CollectionRepository.getAllCollections();
    return NextResponse.json(collections);
  } catch (error: any) {
    console.error('Collections GET error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { name } = body;
    
    if (!name) {
      return NextResponse.json({ error: 'Collection name is required' }, { status: 400 });
    }

    const id = CollectionRepository.createCollection(name);

    return NextResponse.json({ id, name });
  } catch (error: any) {
    console.error('Collections POST error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
