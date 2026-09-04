import { NextResponse } from 'next/server';
import { QueueRepository } from '@/domain/repositories/QueueRepository';

export async function GET() {
  try {
    const counts = QueueRepository.getStatusCounts();
    return NextResponse.json(counts);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
