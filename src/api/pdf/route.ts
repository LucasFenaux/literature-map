import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import db from '@/lib/db';

const PDF_DIR = path.join(process.cwd(), 'data', 'pdfs');

export async function GET(request: Request) {
  try {
    if (!fs.existsSync(PDF_DIR)) {
      return NextResponse.json({ pdfs: [] });
    }

    const files = fs.readdirSync(PDF_DIR).filter(f => f.endsWith('.pdf'));
    const pdfs = [];

    const getPaperStmt = db.prepare('SELECT title FROM papers WHERE id = ? OR id = ?');

    for (const file of files) {
      const safeId = file.replace('.pdf', '');
      const s2Id = `s2:${safeId}`;
      const stat = fs.statSync(path.join(PDF_DIR, file));
      
      let title = 'Unknown Paper';
      try {
        const row = getPaperStmt.get(s2Id, safeId) as any;
        if (row && row.title) {
          title = row.title;
        }
      } catch (e) {
        // ignore
      }

      pdfs.push({
        id: s2Id,
        title,
        sizeBytes: stat.size,
        lastAccessed: stat.mtime.toISOString(),
      });
    }

    return NextResponse.json({ pdfs: pdfs.sort((a, b) => new Date(b.lastAccessed).getTime() - new Date(a.lastAccessed).getTime()) });
  } catch (error: any) {
    console.error('List PDFs error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    if (!fs.existsSync(PDF_DIR)) return NextResponse.json({ success: true });
    
    const files = fs.readdirSync(PDF_DIR).filter(f => f.endsWith('.pdf'));
    for (const file of files) {
      fs.unlinkSync(path.join(PDF_DIR, file));
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Clear PDFs error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
