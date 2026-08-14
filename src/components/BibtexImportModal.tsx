import React, { useEffect, useState, useRef } from 'react';
import { useGraphStore } from '@/store/graphStore';
import { Paper } from '@/lib/openalex';

interface BibtexImportModalProps {
  entries: any[];
  onClose: () => void;
}

export default function BibtexImportModal({ entries, onClose }: BibtexImportModalProps) {
  const { activeCollectionId, loadCollectionGraph, graphData, addSeedPaper } = useGraphStore();
  const [withDoi, setWithDoi] = useState<any[]>([]);
  const [withoutDoi, setWithoutDoi] = useState<any[]>([]);
  
  const [processingDoi, setProcessingDoi] = useState(false);
  const [doiProgress, setDoiProgress] = useState(0);
  
  const [currentIndex, setCurrentIndex] = useState(0);
  const [searchResults, setSearchResults] = useState<Paper[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  
  const prefetchCache = useRef<Record<number, { papers: Paper[], error?: string } | Promise<{ papers: Paper[], error?: string }>>>({});
  const [hasFinished, setHasFinished] = useState(false);

  const initRef = useRef(false);

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    const dois: any[] = [];
    const nonDois: any[] = [];

    entries.forEach(entry => {
      const doi = entry.entryTags.DOI || entry.entryTags.doi;
      const title = (entry.entryTags.TITLE || entry.entryTags.title || '').replace(/[{}]/g, '').toLowerCase().trim();

      const alreadyExists = graphData.nodes.some((node: any) => {
        if (doi && node.doi && node.doi.toLowerCase() === doi.toLowerCase()) return true;
        if (title && node.title && node.title.toLowerCase().trim() === title) return true;
        return false;
      });

      if (alreadyExists) return;

      if (doi) {
        dois.push({ ...entry, extractedDoi: doi });
      } else {
        nonDois.push(entry);
      }
    });

    setWithDoi(dois);
    setWithoutDoi(nonDois);

    const processAuto = async () => {
      setProcessingDoi(true);
      try {
        const cleanDois = dois.map(d => d.extractedDoi.replace(/[{}]/g, ''));
        const res = await fetch('/api/search/batch-dois', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dois: cleanDois })
        });
        
        const papers = await res.json();
        
        if (Array.isArray(papers) && papers.length > 0) {
          for (let i = 0; i < papers.length; i++) {
            setDoiProgress(i + 1);
            await fetch('/api/collection', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ...papers[i], status: 'seed', collectionId: activeCollectionId })
            });
            if (activeCollectionId) {
              await loadCollectionGraph(activeCollectionId);
            }
          }
        }
      } catch (e) {
        console.error('Error in batch DOI processing', e);
      }
      setProcessingDoi(false);

      if (nonDois.length === 0) {
        finishImport();
      } else {
        searchCurrentNonDoi(nonDois, 0);
      }
    };

    if (dois.length > 0) {
      processAuto();
    } else if (nonDois.length > 0) {
      searchCurrentNonDoi(nonDois, 0);
    } else {
      finishImport();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  const fetchPaperResults = async (entry: any): Promise<{ papers: Paper[], error?: string }> => {
    const title = entry.entryTags.TITLE || entry.entryTags.title || '';
    if (!title) return { papers: [] };

    try {
      // Clean up title
      const cleanTitle = title.replace(/[{}]/g, '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
      
      const authorRaw = entry.entryTags.AUTHOR || entry.entryTags.author || '';
      let firstAuthorLastName = '';
      if (authorRaw) {
        const firstAuthor = authorRaw.split(' and ')[0].replace(/[{}]/g, '').trim();
        if (firstAuthor.includes(',')) {
          firstAuthorLastName = firstAuthor.split(',')[0].trim();
        } else {
          const parts = firstAuthor.split(' ');
          firstAuthorLastName = parts[parts.length - 1].trim();
        }
      }

      const queryTerm = firstAuthorLastName ? `${cleanTitle} ${firstAuthorLastName}` : cleanTitle;
      
      let papers: Paper[] = [];
      let matchError = null;

      // 1. Match endpoint
      const matchRes = await fetch(`/api/search/match?q=${encodeURIComponent(queryTerm)}`);
      const matchData = await matchRes.json();
      if (matchData.error) {
        matchError = matchData.error;
      } else {
        papers = Array.isArray(matchData) ? matchData : [];
      }

      // 2. Fuzzy fallback
      if (papers.length === 0) {
        const res = await fetch(`/api/search?q=${encodeURIComponent(queryTerm)}`);
        const data = await res.json();
        if (data.error) matchError = data.error;
        else papers = Array.isArray(data) ? data : [];
      }

      // 3. Title-only fallback
      if (papers.length === 0 && firstAuthorLastName) {
        const fallbackRes = await fetch(`/api/search?q=${encodeURIComponent(cleanTitle)}`);
        const fallbackData = await fallbackRes.json();
        if (fallbackData.error) matchError = fallbackData.error;
        else papers = Array.isArray(fallbackData) ? fallbackData : [];
      }
      
      return { papers: papers.slice(0, 10), error: papers.length === 0 ? matchError : undefined };
    } catch (e: any) {
      console.error('Error searching for paper', e);
      return { papers: [], error: e.message || 'Unknown network error' };
    }
  };

  const prefetchBackground = async (list: any[], startIndex: number) => {
    // Prefetch next 10 papers
    for (let i = 1; i <= 10; i++) {
      const idx = startIndex + i;
      if (idx < list.length && !prefetchCache.current[idx]) {
        // Set to a pending promise immediately so we don't fetch again
        const promise = fetchPaperResults(list[idx]);
        prefetchCache.current[idx] = promise;
        promise.then(res => {
          prefetchCache.current[idx] = res;
        }).catch(e => {
          prefetchCache.current[idx] = { papers: [], error: e.message };
        });
      }
    }
  };

  const searchCurrentNonDoi = async (list: any[], index: number) => {
    if (index >= list.length) {
      finishImport();
      return;
    }
    
    setIsSearching(true);
    setSearchResults([]);
    setSearchError(null);
    setIsExpanded(false);
    
    const entry = list[index];
    if (!entry.entryTags.TITLE && !entry.entryTags.title) {
      setIsSearching(false);
      nextNonDoiIndex(index + 1, list);
      return;
    }

    let currentPapers = [];
    let currentError = null;

    if (prefetchCache.current[index]) {
      // It might be a promise or a resolved result
      const cached = await prefetchCache.current[index];
      currentPapers = cached.papers;
      currentError = cached.error || null;
    } else {
      const promise = fetchPaperResults(entry);
      prefetchCache.current[index] = promise;
      const res = await promise;
      prefetchCache.current[index] = res;
      currentPapers = res.papers;
      currentError = res.error || null;
      prefetchCache.current[index] = res;
    }

    // Auto-retry for rate limits by moving to the back of the queue
    if (currentError && currentError.includes('429') && !entry._retriedFor429 && index < list.length - 1) {
      entry._retriedFor429 = true;
      setWithoutDoi(prev => [...prev, entry]);
      setIsSearching(false);
      nextNonDoiIndex(index + 1, [...list, entry]);
      return;
    }

    setSearchResults(currentPapers);
    setSearchError(currentError);
    
    setIsSearching(false);
    
    // Kick off prefetching for upcoming papers
    prefetchBackground(list, index);
  };

  const finishImport = async () => {
    if (activeCollectionId) {
      await loadCollectionGraph(activeCollectionId);
    }
    setHasFinished(true);
  };

  const handleSelect = async (paper: Paper) => {
    try {
      await addSeedPaper(paper);
    } catch (e) {
      console.error('Failed to add paper', e);
    }
    nextNonDoiIndex(currentIndex + 1, withoutDoi);
  };

  const handleSkip = () => {
    nextNonDoi();
  };

  const nextNonDoi = () => {
    nextNonDoiIndex(currentIndex + 1, withoutDoi);
  };

  const nextNonDoiIndex = (nextIdx: number, list: any[]) => {
    setCurrentIndex(nextIdx);
    if (nextIdx < list.length) {
      searchCurrentNonDoi(list, nextIdx);
    } else {
      finishImport();
    }
  };

  if (hasFinished) {
    return (
      <div style={modalOverlayStyle}>
        <div style={modalContentStyle}>
          <h2>Import Complete</h2>
          <p>Successfully processed {entries.length} BibTeX entries.</p>
          <button onClick={onClose} style={buttonStyle}>Close</button>
        </div>
      </div>
    );
  }

  if (processingDoi) {
    return (
      <div style={modalOverlayStyle}>
        <div style={modalContentStyle}>
          <h2>Importing from BibTeX...</h2>
          <p>Auto-resolving papers with DOIs: {doiProgress} / {withDoi.length}</p>
        </div>
      </div>
    );
  }

  const currentEntry = withoutDoi[currentIndex];

  return (
    <div style={modalOverlayStyle}>
      <div style={modalContentStyle}>
        <h2>Resolve Ambiguous Papers</h2>
        <p>Paper {currentIndex + 1} of {withoutDoi.length} without a DOI.</p>
        
        {currentEntry && (
          <div style={{ background: 'var(--bg-surface-hover)', padding: '1rem', borderRadius: 'var(--radius-md)', margin: '1rem 0' }}>
            <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '1rem' }}>
              {(currentEntry.entryTags.TITLE || currentEntry.entryTags.title || 'Unknown Title').replace(/[{}]/g, '')}
            </h3>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              Authors: {currentEntry.entryTags.AUTHOR || currentEntry.entryTags.author || 'Unknown'} <br/>
              Year: {currentEntry.entryTags.YEAR || currentEntry.entryTags.year || 'Unknown'}
            </div>
          </div>
        )}

        {isSearching ? (
          <div style={{ margin: '2rem 0', textAlign: 'center' }}>Searching Semantic Scholar...</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxHeight: '400px', overflowY: 'auto' }}>
            {searchResults.length === 0 ? (
              <p style={{ color: 'var(--text-secondary)' }}>
                No results found for this paper. {searchError ? `(Reason: ${searchError})` : ''}
              </p>
            ) : (
              <>
                {searchResults.slice(0, isExpanded ? 10 : 3).map((paper) => (
                  <div 
                    key={paper.id} 
                    style={{ 
                      border: '1px solid var(--border-strong)', 
                      padding: '0.75rem', 
                      borderRadius: 'var(--radius-sm)',
                      cursor: 'pointer',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.25rem'
                    }}
                    onClick={() => handleSelect(paper)}
                    onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-surface-hover)'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    <div style={{ fontWeight: 500 }}>{paper.title}</div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                      {paper.authors.join(', ')} • {paper.year} • {paper.citationCount} citations
                    </div>
                  </div>
                ))}
                {!isExpanded && searchResults.length > 3 && (
                  <button 
                    onClick={() => setIsExpanded(true)}
                    style={{ ...buttonSecondaryStyle, width: '100%' }}
                  >
                    Show more options
                  </button>
                )}
              </>
            )}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1.5rem', gap: '0.5rem' }}>
          <button onClick={handleSkip} style={buttonSecondaryStyle}>Skip Paper</button>
          <button onClick={onClose} style={buttonSecondaryStyle}>Cancel Import</button>
        </div>
      </div>
    </div>
  );
}

const modalOverlayStyle: React.CSSProperties = {
  position: 'fixed',
  top: 0, left: 0, right: 0, bottom: 0,
  backgroundColor: 'rgba(0, 0, 0, 0.5)',
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
  zIndex: 9999
};

const modalContentStyle: React.CSSProperties = {
  background: 'var(--bg-surface)',
  color: 'var(--text-primary)',
  padding: '2rem',
  borderRadius: 'var(--radius-lg)',
  width: '500px',
  maxWidth: '90vw',
  boxShadow: '0 10px 25px rgba(0,0,0,0.5)',
  border: '1px solid var(--border-strong)',
  display: 'flex',
  flexDirection: 'column'
};

const buttonStyle: React.CSSProperties = {
  padding: '0.5rem 1rem',
  background: 'var(--accent-primary)',
  color: 'white',
  border: 'none',
  borderRadius: 'var(--radius-sm)',
  cursor: 'pointer',
  marginTop: '1.5rem',
  alignSelf: 'flex-end'
};

const buttonSecondaryStyle: React.CSSProperties = {
  padding: '0.5rem 1rem',
  background: 'transparent',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-strong)',
  borderRadius: 'var(--radius-sm)',
  cursor: 'pointer'
};
