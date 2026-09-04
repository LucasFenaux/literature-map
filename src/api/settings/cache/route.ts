import { NextResponse } from 'next/server';
import { PaperRepository } from '@/domain/repositories/PaperRepository';
import { CacheRepository } from '@/domain/repositories/CacheRepository';

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const collectionId = searchParams.get('collectionId');
    
    if (collectionId) {
       const papers = PaperRepository.getPapersForCollection(collectionId);
       
       let count = 0;
       for (const p of papers) {
          const cleanId = p.id.replace('s2:', '');
          count += CacheRepository.deleteLike(`%${cleanId}%`);
       }
       
       return NextResponse.json({ message: `Cleared ${count} cache entries for the active collection` });
    } else {
       const changes = CacheRepository.clearAll();
       return NextResponse.json({ message: `Cleared all ${changes} cache entries` });
    }
  } catch (error: any) {
    console.error('Failed to clear cache', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
