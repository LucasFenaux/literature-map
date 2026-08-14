import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';

const PDF_DIR = path.join(process.cwd(), 'data', 'pdfs');

export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const { id } = params;
    const s2Id = id.replace('s2:', '');
    const safeId = s2Id.replace(/[^a-zA-Z0-9_-]/g, '');
    const pdfPath = path.join(PDF_DIR, `${safeId}.pdf`);
    return NextResponse.json({ exists: fs.existsSync(pdfPath) });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const { id } = params;
    const s2Id = id.replace('s2:', '');
    const safeId = s2Id.replace(/[^a-zA-Z0-9_-]/g, '');
    const pdfPath = path.join(PDF_DIR, `${safeId}.pdf`);

    if (!fs.existsSync(PDF_DIR)) {
      fs.mkdirSync(PDF_DIR, { recursive: true });
    }

    if (fs.existsSync(pdfPath)) {
      const now = new Date();
      fs.utimesSync(pdfPath, now, now);
      return NextResponse.json({ success: true, cached: true });
    }

    const apiKey = process.env.SEMANTIC_SCHOLAR_API_KEY;
    const headers: HeadersInit = apiKey ? { 'x-api-key': apiKey } : {};

    let res;
    for (let i = 0; i < 4; i++) {
      res = await fetch(`https://api.semanticscholar.org/graph/v1/paper/${s2Id}?fields=openAccessPdf,externalIds`, { 
        headers,
        cache: 'no-store'
      });
      if (res.status === 429) {
        await new Promise(r => setTimeout(r, 2000 * Math.pow(2, i))); // 2s, 4s, 8s, 16s
        continue;
      }
      break;
    }
    
    if (!res || !res.ok) {
      return NextResponse.json({ error: `Semantic Scholar API returned ${res?.status || 500}. You might be heavily rate limited. Consider adding an API key in Settings.` }, { status: res?.status || 500 });
    }
    
    const data = await res.json();
    
    let pdfUrl = null;
    if (data.openAccessPdf && data.openAccessPdf.url) {
      pdfUrl = data.openAccessPdf.url;
    } else if (data.externalIds && data.externalIds.ArXiv) {
      pdfUrl = `https://arxiv.org/pdf/${data.externalIds.ArXiv}.pdf`;
    }

    if (!pdfUrl) {
      return NextResponse.json({ error: 'No open access PDF available.' }, { status: 404 });
    }
    const pdfRes = await fetch(pdfUrl, { 
      headers: { 'User-Agent': 'Mozilla/5.0' },
      cache: 'no-store'
    });
    
    if (!pdfRes.ok) {
      return NextResponse.json({ error: `Failed to download PDF from provider: ${pdfRes.status}` }, { status: 500 });
    }

    await pipeline(pdfRes.body as any, fs.createWriteStream(pdfPath));

    return NextResponse.json({ success: true, cached: false });
  } catch (error: any) {
    console.error('PDF fetch error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  try {
    const { id } = params;
    const s2Id = id.replace('s2:', '');
    const safeId = s2Id.replace(/[^a-zA-Z0-9_-]/g, '');
    const pdfPath = path.join(PDF_DIR, `${safeId}.pdf`);

    if (fs.existsSync(pdfPath)) {
      fs.unlinkSync(pdfPath);
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('PDF delete error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
