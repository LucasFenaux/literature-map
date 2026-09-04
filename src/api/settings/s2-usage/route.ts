import { NextResponse } from 'next/server';
import { LogRepository } from '@/domain/repositories/LogRepository';

export async function GET() {
  try {
    const stats = LogRepository.getUsageStats();
    return NextResponse.json(stats);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
