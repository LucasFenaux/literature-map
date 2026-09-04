import { NextResponse } from 'next/server';
import { EnrichmentJobProcessor } from '@/domain/services/EnrichmentJobProcessor';

export async function POST(request: Request) {
  try {
    await EnrichmentJobProcessor.processBatch(5);
    return NextResponse.json({ message: `Processed queue batch` });
  } catch (error: any) {
    console.error('Queue API error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
