import { NextResponse } from 'next/server';
import { TagRepository } from '@/domain/repositories/TagRepository';
import { PaperRepository } from '@/domain/repositories/PaperRepository';

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const resolvedParams = await params;
    const { id } = resolvedParams;
    const body = await request.json();
    const { name, color, weight } = body;
    
    if (!name) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    }

    const current = TagRepository.getTag(id);
    if (!current) {
      return NextResponse.json({ error: 'Tag not found' }, { status: 404 });
    }

    const updatedWeight = weight !== undefined ? weight : current.weight;
    const updatedColor = color || '#888888';
    
    TagRepository.updateTag(id, name, updatedColor, updatedWeight);

    return NextResponse.json({ message: 'Tag updated successfully', tag: { id, name, color: updatedColor, weight: updatedWeight } });
  } catch (error: any) {
    console.error('Database PUT tags error:', error);
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.message.includes('UNIQUE')) {
      return NextResponse.json({ error: 'A tag with this name already exists' }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const resolvedParams = await params;
    const { id } = resolvedParams;
    
    const changes = TagRepository.deleteTag(id);

    if (changes === 0) {
      return NextResponse.json({ error: 'Tag not found' }, { status: 404 });
    }

    PaperRepository.removeTagFromAll(id);

    return NextResponse.json({ message: 'Tag deleted successfully' });
  } catch (error: any) {
    console.error('Database DELETE tags error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
