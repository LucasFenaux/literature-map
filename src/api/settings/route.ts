import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET() {
  try {
    const envPath = path.join(process.cwd(), '.env.local');
    let apiKey = '';
    let rateLimit = '1';
    let cacheFreshnessCitations = '7';
    let cacheFreshnessReferences = '30';
    let maxTopNLimit = '100';
    
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      const matchKey = content.match(/^SEMANTIC_SCHOLAR_API_KEY=(.*)$/m);
      if (matchKey) apiKey = matchKey[1].trim();
      
      const matchLimit = content.match(/^SEMANTIC_SCHOLAR_RATE_LIMIT=(.*)$/m);
      if (matchLimit) rateLimit = matchLimit[1].trim();

      const matchCacheCit = content.match(/^CACHE_FRESHNESS_CITATIONS_DAYS=(.*)$/m);
      if (matchCacheCit) cacheFreshnessCitations = matchCacheCit[1].trim();
      else if (content.match(/^CACHE_FRESHNESS_DAYS=(.*)$/m)) cacheFreshnessCitations = content.match(/^CACHE_FRESHNESS_DAYS=(.*)$/m)![1].trim();
      
      const matchCacheRef = content.match(/^CACHE_FRESHNESS_REFERENCES_DAYS=(.*)$/m);
      if (matchCacheRef) cacheFreshnessReferences = matchCacheRef[1].trim();
      else if (content.match(/^CACHE_FRESHNESS_DAYS=(.*)$/m)) cacheFreshnessReferences = content.match(/^CACHE_FRESHNESS_DAYS=(.*)$/m)![1].trim();

      const matchMaxTopNLimit = content.match(/^MAX_TOP_N_LIMIT=(.*)$/m);
      if (matchMaxTopNLimit) maxTopNLimit = matchMaxTopNLimit[1].trim();
    } else {
      if (process.env.SEMANTIC_SCHOLAR_API_KEY) apiKey = process.env.SEMANTIC_SCHOLAR_API_KEY;
      if (process.env.SEMANTIC_SCHOLAR_RATE_LIMIT) rateLimit = process.env.SEMANTIC_SCHOLAR_RATE_LIMIT;
      if (process.env.CACHE_FRESHNESS_CITATIONS_DAYS) cacheFreshnessCitations = process.env.CACHE_FRESHNESS_CITATIONS_DAYS;
      else if (process.env.CACHE_FRESHNESS_DAYS) cacheFreshnessCitations = process.env.CACHE_FRESHNESS_DAYS;
      
      if (process.env.CACHE_FRESHNESS_REFERENCES_DAYS) cacheFreshnessReferences = process.env.CACHE_FRESHNESS_REFERENCES_DAYS;
      else if (process.env.CACHE_FRESHNESS_DAYS) cacheFreshnessReferences = process.env.CACHE_FRESHNESS_DAYS;
      
      if (process.env.MAX_TOP_N_LIMIT) maxTopNLimit = process.env.MAX_TOP_N_LIMIT;
    }
    
    return NextResponse.json({ 
      semanticScholarApiKey: apiKey,
      semanticScholarRateLimit: rateLimit,
      cacheFreshnessCitations,
      cacheFreshnessReferences,
      maxTopNLimit
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { semanticScholarApiKey, semanticScholarRateLimit, cacheFreshnessCitations, cacheFreshnessReferences, maxTopNLimit } = await request.json();
    const envPath = path.join(process.cwd(), '.env.local');
    
    let envContent = '';
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    }
    
    // Replace or add the key
    if (envContent.match(/^SEMANTIC_SCHOLAR_API_KEY=.*$/m)) {
      envContent = envContent.replace(/^SEMANTIC_SCHOLAR_API_KEY=.*$/m, `SEMANTIC_SCHOLAR_API_KEY=${semanticScholarApiKey}`);
    } else {
      envContent += `\nSEMANTIC_SCHOLAR_API_KEY=${semanticScholarApiKey}\n`;
    }
    
    // Replace or add rate limit
    if (envContent.match(/^SEMANTIC_SCHOLAR_RATE_LIMIT=.*$/m)) {
      envContent = envContent.replace(/^SEMANTIC_SCHOLAR_RATE_LIMIT=.*$/m, `SEMANTIC_SCHOLAR_RATE_LIMIT=${semanticScholarRateLimit}`);
    } else {
      envContent += `\nSEMANTIC_SCHOLAR_RATE_LIMIT=${semanticScholarRateLimit}\n`;
    }

    // Replace or add cache freshness citations
    if (cacheFreshnessCitations !== undefined) {
      if (envContent.match(/^CACHE_FRESHNESS_CITATIONS_DAYS=.*$/m)) {
        envContent = envContent.replace(/^CACHE_FRESHNESS_CITATIONS_DAYS=.*$/m, `CACHE_FRESHNESS_CITATIONS_DAYS=${cacheFreshnessCitations}`);
      } else {
        envContent += `\nCACHE_FRESHNESS_CITATIONS_DAYS=${cacheFreshnessCitations}\n`;
      }
    }
    
    // Replace or add cache freshness references
    if (cacheFreshnessReferences !== undefined) {
      if (envContent.match(/^CACHE_FRESHNESS_REFERENCES_DAYS=.*$/m)) {
        envContent = envContent.replace(/^CACHE_FRESHNESS_REFERENCES_DAYS=.*$/m, `CACHE_FRESHNESS_REFERENCES_DAYS=${cacheFreshnessReferences}`);
      } else {
        envContent += `\nCACHE_FRESHNESS_REFERENCES_DAYS=${cacheFreshnessReferences}\n`;
      }
    }
    
    // Replace or add max top n limit
    if (maxTopNLimit !== undefined) {
      if (envContent.match(/^MAX_TOP_N_LIMIT=.*$/m)) {
        envContent = envContent.replace(/^MAX_TOP_N_LIMIT=.*$/m, `MAX_TOP_N_LIMIT=${maxTopNLimit}`);
      } else {
        envContent += `\nMAX_TOP_N_LIMIT=${maxTopNLimit}\n`;
      }
    }
    
    // Clean up empty lines
    envContent = envContent.replace(/^\s*[\r\n]/gm, '\n').trim() + '\n';
    
    fs.writeFileSync(envPath, envContent, 'utf8');
    
    // Assigning to process.env works for the current runtime tick in Node
    process.env.SEMANTIC_SCHOLAR_API_KEY = semanticScholarApiKey;
    process.env.SEMANTIC_SCHOLAR_RATE_LIMIT = semanticScholarRateLimit;
    if (cacheFreshnessCitations !== undefined) process.env.CACHE_FRESHNESS_CITATIONS_DAYS = cacheFreshnessCitations;
    if (cacheFreshnessReferences !== undefined) process.env.CACHE_FRESHNESS_REFERENCES_DAYS = cacheFreshnessReferences;
    if (maxTopNLimit !== undefined) process.env.MAX_TOP_N_LIMIT = maxTopNLimit;
    
    return NextResponse.json({ message: 'Settings saved successfully' });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
