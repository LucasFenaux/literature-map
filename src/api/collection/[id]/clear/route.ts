import { NextResponse } from 'next/server';
import { PaperRepository } from '@/domain/repositories/PaperRepository';

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const resolvedParams = await params;
    const { id } = resolvedParams; // this is the collectionId

    PaperRepository.clearNonSeedPapers(id);

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Clear Collection API error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
