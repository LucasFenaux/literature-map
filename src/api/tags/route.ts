import { NextResponse } from 'next/server';
import { TagRepository } from '@/domain/repositories/TagRepository';

export async function GET() {
  try {
    const tags = TagRepository.getAllTags();
    return NextResponse.json(tags);
  } catch (error: any) {
    console.error('Database GET tags error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { name, color, weight } = body;
    
    if (!name) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    }

    const tag = TagRepository.createTag(name, color, weight);

    return NextResponse.json({ message: 'Tag created successfully', tag });
  } catch (error: any) {
    console.error('Database POST tags error:', error);
    // Handle unique constraint error
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.message.includes('UNIQUE')) {
      return NextResponse.json({ error: 'A tag with this name already exists' }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
