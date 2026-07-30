'use client';

import { useState, useEffect, useRef, useLayoutEffect, useCallback, useMemo } from 'react';
import { useGraphStore, GraphNode } from '@/store/graphStore';
import { formatAuthors } from '@/lib/formatters';
import { matchesSearch } from '@/lib/search';
import SearchInput from '@/components/SearchInput';

function CitationModal({ node, onClose }: { node: GraphNode; onClose: () => void }) {
  const [copiedFormat, setCopiedFormat] = useState<string | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });

  const formattedAuthors = formatAuthors(node.authors);
  const year = node.publicationDate ? node.publicationDate.split('-')[0] : (node.year || 'n.d.');
  const title = node.title;
  const venue = node.venue || 'No Venue';

  // Basic BibTeX ID generation
  const firstAuthorLast = formattedAuthors.split(',')[0]?.split(' ')[0] || 'Unknown';
  const bibtexId = `${firstAuthorLast}${year}${title.split(' ')[0]}`.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

  const citations = {
    APA: `${formattedAuthors} (${year}). ${title}. ${venue}.`,
    MLA: `${formattedAuthors}. "${title}." ${venue}, ${year}.`,
    Chicago: `${formattedAuthors}. "${title}." ${venue} (${year}).`,
    Harvard: `${formattedAuthors}, ${year}. ${title}. ${venue}.`,
    BibTeX: `@article{${bibtexId},\n  title={${title}},\n  author={${formattedAuthors}},\n  journal={${venue}},\n  year={${year}}\n}`
  };

  const handleCopy = (format: string, text: string, e: React.MouseEvent) => {
    setMousePos({ x: e.clientX, y: e.clientY });
    navigator.clipboard.writeText(text);
    setCopiedFormat(format);
    setTimeout(() => setCopiedFormat(null), 1500);
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(0,0,0,0.5)',
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      zIndex: 200,
      backdropFilter: 'blur(4px)'
    }} onClick={onClose}>
      <div className="glass-panel" style={{
        background: 'var(--bg-surface)',
        padding: '2rem',
        borderRadius: 'var(--radius-lg)',
        border: '1px solid var(--border-strong)',
        width: '600px',
        maxWidth: '90vw',
        maxHeight: '90vh',
        overflowY: 'auto',
        position: 'relative'
      }} onClick={e => e.stopPropagation()}>
        <button 
          onClick={onClose}
          style={{ position: 'absolute', top: '1.5rem', right: '1.5rem', background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: '1.5rem', lineHeight: 1 }}
        >
          &times;
        </button>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1.5rem' }}>Cite Paper</h2>
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {Object.entries(citations).map(([format, text]) => (
            <div key={format}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
                <span style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{format}</span>
              </div>
              <div 
                onClick={(e) => handleCopy(format, text, e)}
                style={{
                  padding: '0.75rem', 
                  background: 'var(--bg-background)', 
                  border: '1px solid var(--border-subtle)', 
                  borderRadius: 'var(--radius-md)', 
                  fontSize: '0.8rem', 
                  color: 'var(--text-primary)',
                  cursor: 'pointer',
                  whiteSpace: format === 'BibTeX' ? 'pre-wrap' : 'normal',
                  fontFamily: format === 'BibTeX' ? 'monospace' : 'inherit'
                }}
                title="Click to copy"
              >
                {text}
              </div>
            </div>
          ))}
        </div>
        
        {copiedFormat && (
          <div style={{
            position: 'fixed',
            left: mousePos.x + 15,
            top: mousePos.y - 25,
            background: '#10b981',
            color: 'white',
            padding: '4px 8px',
            borderRadius: '6px',
            fontSize: '0.8rem',
            fontWeight: 600,
            pointerEvents: 'none',
            zIndex: 1000,
            boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
          }}>
            Copied!
          </div>
        )}
      </div>
    </div>
  );
}

function PaperPopup({ node, onClose, isRightPanelCollapsed, panelWidth }: { node: GraphNode; onClose: () => void; isRightPanelCollapsed?: boolean; panelWidth?: number }) {
  const [notes, setNotes] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const [showCitation, setShowCitation] = useState(false);
  const { graphData, tags } = useGraphStore();
  const [localTags, setLocalTags] = useState<string[]>((node as any).localTags || []);
  const [hasMovedManually, setHasMovedManually] = useState(false);
  const pw = panelWidth || 360;
  const [pos, setPos] = useState({ x: typeof window !== 'undefined' ? Math.max(360, window.innerWidth - (isRightPanelCollapsed ? 446 : pw + 462)) : 300, y: 80 });
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);

  // Reset state when a NEW node is selected
  useEffect(() => { 
    setNotes((node as any).notes || ''); 
    setLocalTags((node as any).localTags || []);
    setHasMovedManually(false);
    if (typeof window !== 'undefined') {
      const currentPw = panelWidth || 360;
      setPos({ x: Math.max(360, window.innerWidth - (isRightPanelCollapsed ? 446 : currentPw + 462)), y: 80 });
    }
    // We intentionally omit isRightPanelCollapsed here so that toggling the panel
    // doesn't completely reset the popup's Y position or wipe the user's manual drag state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node, panelWidth]);

  // Track the panel sliding if the user hasn't manually ripped it away yet
  useEffect(() => {
    if (!hasMovedManually && typeof window !== 'undefined') {
      const currentPw = panelWidth || 360;
      setPos(prev => ({ ...prev, x: Math.max(360, window.innerWidth - (isRightPanelCollapsed ? 446 : currentPw + 462)) }));
    }
  }, [isRightPanelCollapsed, hasMovedManually, panelWidth]);

  const getDisplayCitationCount = (n: GraphNode) => {
    const loadedCount = graphData.links.filter(l =>
      (typeof l.target === 'object' ? (l.target as any).id : l.target) === n.id
    ).length;
    return Math.max(n.citationCount || 0, loadedCount);
  };

  const handleSaveTags = async (newTags: string[]) => {
    setLocalTags(newTags);
    const activeCollectionId = useGraphStore.getState().activeCollectionId;
    if (!activeCollectionId) return;
    try {
      await fetch(`/api/collection/${node.id}?collectionId=${activeCollectionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes, localTags: newTags })
      });
      const { graphData, selectedNode, setSelectedNode } = useGraphStore.getState();
      const targetNode = graphData.nodes.find(n => n.id === node.id);
      if (targetNode) {
         (targetNode as any).localTags = newTags;
      }
      if (selectedNode?.id === node.id) {
         const updatedSelectedNode = { ...selectedNode, localTags: newTags } as any;
         setSelectedNode(updatedSelectedNode);
      }
    } catch (error) {
      console.error('Failed to auto-save tags', error);
    }
  };

  const handleSaveNotes = async () => {
    const activeCollectionId = useGraphStore.getState().activeCollectionId;
    if (!activeCollectionId) return;
    
    setIsSaving(true);
    try {
      await fetch(`/api/collection/${node.id}?collectionId=${activeCollectionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes, localTags })
      });
      
      // Update local store in-place so we don't trigger a full graph/physics reload
      const { graphData, selectedNode, setSelectedNode } = useGraphStore.getState();
      const targetNode = graphData.nodes.find(n => n.id === node.id);
      if (targetNode) {
         (targetNode as any).notes = notes;
         (targetNode as any).localTags = localTags;
      }
      
      if (selectedNode?.id === node.id) {
         // Also update the selected node reference so the UI knows about the change
         const updatedSelectedNode = { ...selectedNode, notes, localTags } as any;
         setSelectedNode(updatedSelectedNode);
      }
      
      setShowSaved(true);
      setTimeout(() => setShowSaved(false), 2000);
      
    } catch (error) {
      console.error('Failed to save notes', error);
    } finally {
      setIsSaving(false);
    }
  };

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setHasMovedManually(true);
    dragRef.current = { startX: e.clientX, startY: e.clientY, originX: pos.x, originY: pos.y };

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      setPos({
        x: dragRef.current.originX + (ev.clientX - dragRef.current.startX),
        y: dragRef.current.originY + (ev.clientY - dragRef.current.startY)
      });
    };
    const onMouseUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, [pos]);

  return (
    <div className="glass-panel" style={{
      position: 'fixed',
      left: pos.x,
      top: pos.y,
      width: '400px',
      maxHeight: '80vh',
      padding: '1.5rem',
      borderRadius: 'var(--radius-lg)',
      display: 'flex',
      flexDirection: 'column',
      gap: '1rem',
      zIndex: 100,
      transition: dragRef.current ? 'none' : 'left 0.3s ease, top 0.3s ease',
    }}>
      {/* Explicit Drag Handle */}
      <div
        onMouseDown={onMouseDown}
        style={{
          cursor: 'grab',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          marginTop: '-1rem',
          marginBottom: '-0.5rem',
          paddingTop: '0.5rem',
          paddingBottom: '0.5rem',
          userSelect: 'none'
        }}
      >
        <div style={{ width: '36px', height: '4px', background: 'var(--text-tertiary)', borderRadius: '2px', opacity: 0.5 }} />
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.3, flex: 1, marginRight: '0.5rem', userSelect: 'text' }}>
          {node.title}
        </h2>
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: '1.5rem', lineHeight: 1, flexShrink: 0, marginTop: '-0.2rem' }}
        >
          &times;
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '1rem', paddingRight: '0.5rem' }}>
        <div>
          {node.venue && (
            <p style={{ fontSize: '0.9rem', color: 'var(--accent-primary)', marginBottom: '0.5rem', fontWeight: 500 }}>
              {node.venue}
            </p>
          )}
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            {formatAuthors(node.authors)}
          </p>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', marginTop: '0.25rem' }}>
            Published: {node.publicationDate ? new Date(node.publicationDate).toISOString().split('T')[0] : node.year} • {getDisplayCitationCount(node)} citations
          </p>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button onClick={() => setShowCitation(true)} style={{
            padding: '0.4rem 0.8rem', borderRadius: '20px', background: 'var(--bg-surface-hover)',
            color: 'var(--text-primary)', border: '1px solid var(--border-strong)', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 500
          }}>
            Cite
          </button>
          {node.url && (
            <a href={node.url} target="_blank" rel="noopener noreferrer" style={{
              padding: '0.4rem 0.8rem', borderRadius: '20px', background: 'var(--accent-primary)',
              color: '#fff', textDecoration: 'none', fontSize: '0.8rem', fontWeight: 500
            }}>
              Read Paper
            </a>
          )}
        </div>

        {node.status === 'seed' && (
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              onClick={() => useGraphStore.getState().expandNode(node.id, 'citations')}
              style={{
                flex: 1, padding: '0.4rem', borderRadius: 'var(--radius-md)',
                background: 'var(--bg-surface-hover)', color: 'var(--text-primary)', border: '1px solid var(--border-strong)',
                cursor: 'pointer', fontWeight: 500, fontSize: '0.75rem', transition: 'all 0.2s'
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--accent-primary)'; e.currentTarget.style.color = 'white'; e.currentTarget.style.borderColor = 'var(--accent-primary)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg-surface-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; e.currentTarget.style.borderColor = 'var(--border-strong)'; }}
            >
              Load Citations
            </button>
            <button
              onClick={() => useGraphStore.getState().expandNode(node.id, 'references')}
              style={{
                flex: 1, padding: '0.4rem', borderRadius: 'var(--radius-md)',
                background: 'var(--bg-surface-hover)', color: 'var(--text-primary)', border: '1px solid var(--border-strong)',
                cursor: 'pointer', fontWeight: 500, fontSize: '0.75rem', transition: 'all 0.2s'
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--accent-secondary)'; e.currentTarget.style.color = 'white'; e.currentTarget.style.borderColor = 'var(--accent-secondary)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg-surface-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; e.currentTarget.style.borderColor = 'var(--border-strong)'; }}
            >
              Load References
            </button>
          </div>
        )}

        {node.status !== 'seed' && (
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              onClick={() => useGraphStore.getState().addSeedPaper(node as any)}
              style={{
                flex: 1, padding: '0.6rem', borderRadius: 'var(--radius-md)',
                background: 'var(--accent-secondary)', color: '#fff', border: 'none',
                cursor: 'pointer', fontWeight: 500, fontSize: '0.75rem'
              }}
            >
              Add to Collection
            </button>
            <button
              onClick={() => useGraphStore.getState().removeNode(node.id)}
              style={{
                flex: 1, padding: '0.6rem', borderRadius: 'var(--radius-md)',
                background: 'transparent', color: '#ef4444', border: '1px solid #ef4444',
                cursor: 'pointer', fontWeight: 500, fontSize: '0.75rem'
              }}
            >
              Remove from Graph
            </button>
          </div>
        )}

        <div>
          <h3 style={{ fontSize: '0.9rem', marginBottom: '0.5rem', color: 'var(--text-primary)' }}>Abstract</h3>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            {node.abstract || 'No abstract available.'}
          </p>
        </div>

        <div>
          <h3 style={{ fontSize: '0.9rem', marginBottom: '0.5rem', color: 'var(--text-primary)' }}>Tags</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.5rem' }}>
            {localTags.map(tagId => {
              const tag = tags.find(t => t.id === tagId);
              if (!tag) return null;
              return (
                <div key={tag.id} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.2rem 0.5rem', background: tag.color + '40', border: `1px solid ${tag.color}`, borderRadius: '12px', fontSize: '0.75rem', color: 'var(--text-primary)' }}>
                  <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: tag.color }} />
                  {tag.name}
                  <button onClick={() => handleSaveTags(localTags.filter(id => id !== tag.id))} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '0 2px', fontSize: '0.8rem', lineHeight: 1 }}>&times;</button>
                </div>
              );
            })}
          </div>
          <select 
            onChange={e => {
              const val = e.target.value;
              if (val && !localTags.includes(val)) {
                handleSaveTags([...localTags, val]);
              }
              e.target.value = '';
            }}
            style={{ padding: '0.4rem', borderRadius: 'var(--radius-sm)', background: 'var(--bg-background)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)', fontSize: '0.8rem', width: '100%' }}
          >
            <option value="">+ Add Tag...</option>
            {tags.filter(t => !localTags.includes(t.id)).map(tag => (
              <option key={tag.id} value={tag.id}>{tag.name}</option>
            ))}
          </select>
        </div>

        <div>
          <h3 style={{ fontSize: '0.9rem', marginBottom: '0.5rem', color: 'var(--text-primary)' }}>Local Notes</h3>
          <div style={{ position: 'relative' }}>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                  e.preventDefault();
                  handleSaveNotes();
                }
              }}
              placeholder="Add your personal notes here... (Ctrl+S to save)"
              style={{
                width: '100%', minHeight: '150px', padding: '0.75rem',
                borderRadius: 'var(--radius-md)', border: '1px solid var(--border-strong)',
                background: 'var(--bg-surface)', color: 'var(--text-primary)',
                resize: 'vertical', outline: 'none', fontFamily: 'inherit', fontSize: '0.85rem'
              }}
            />
            {showSaved && (
              <div style={{
                position: 'absolute', top: '0.5rem', right: '0.5rem',
                background: 'rgba(16, 185, 129, 0.9)', color: 'white',
                padding: '0.2rem 0.6rem', borderRadius: '4px', fontSize: '0.7rem',
                fontWeight: 600, pointerEvents: 'none',
                opacity: showSaved ? 1 : 0, transition: 'opacity 0.3s'
              }}>
                Saved ✓
              </div>
            )}
          </div>
          <button
            onClick={handleSaveNotes}
            disabled={isSaving}
            style={{
              marginTop: '0.5rem', width: '100%', padding: '0.5rem',
              borderRadius: 'var(--radius-md)', background: isSaving ? 'var(--bg-surface)' : (showSaved ? '#10b981' : 'var(--accent-secondary)'),
              color: isSaving ? 'var(--text-secondary)' : '#fff', border: isSaving ? '1px solid var(--border-strong)' : 'none',
              cursor: isSaving ? 'not-allowed' : 'pointer', fontWeight: 500,
              transition: 'background 0.2s, color 0.2s'
            }}
          >
            {isSaving ? 'Saving...' : showSaved ? 'Saved!' : 'Save Notes'}
          </button>
        </div>
      </div>
      
      {showCitation && <CitationModal node={node} onClose={() => setShowCitation(false)} />}
    </div>
  );
}

function BulkActionsPanel() {
  const { bulkLoading, activeCollectionId, graphData } = useGraphStore();
  const [rebuilding, setRebuilding] = useState(false);
  const [cacheStatus, setCacheStatus] = useState<{ citations: { fresh: number, total: number }, references: { fresh: number, total: number } } | null>(null);

  useEffect(() => {
    if (!activeCollectionId) return;
    const fetchStatus = async () => {
      try {
        const res = await fetch(`/api/collection/${activeCollectionId}/cache-status`);
        const data = await res.json();
        setCacheStatus(data);
      } catch (e) {}
    };
    fetchStatus();
    window.addEventListener('settingsUpdated', fetchStatus);
    return () => window.removeEventListener('settingsUpdated', fetchStatus);
  }, [activeCollectionId, bulkLoading, graphData.nodes.length]);

  const isBusy = !!bulkLoading;

  const citationsLoading = bulkLoading?.type === 'citations';
  const referencesLoading = bulkLoading?.type === 'references';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '0.5rem' }}>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button
          disabled={isBusy}
          onClick={() => useGraphStore.getState().bulkExpand('citations')}
          style={{
            flex: 1, padding: '0.5rem', borderRadius: 'var(--radius-md)',
            background: citationsLoading ? 'var(--bg-surface-hover)' : (cacheStatus && cacheStatus.citations.fresh < cacheStatus.citations.total ? '#f59e0b' : 'var(--accent-primary)'),
            color: citationsLoading ? 'var(--text-primary)' : '#fff',
            border: citationsLoading ? '1px solid var(--accent-primary)' : 'none',
            cursor: isBusy ? 'not-allowed' : 'pointer', fontWeight: 500, fontSize: '0.75rem',
            opacity: (isBusy && !citationsLoading) ? 0.5 : 1,
            transition: 'all 0.2s'
          }}
          title={cacheStatus && cacheStatus.citations.fresh < cacheStatus.citations.total ? 'Some papers are not cached or the cache is stale. This will consume API rate limits.' : 'All papers are cached.'}
        >
          {citationsLoading
            ? `Loading Citations (${bulkLoading!.current}/${bulkLoading!.total})`
            : `Bulk Load Citations ${cacheStatus ? `(${cacheStatus.citations.fresh}/${cacheStatus.citations.total} cached)` : ''}`}
        </button>
        <button
          disabled={isBusy}
          onClick={() => useGraphStore.getState().bulkExpand('references')}
          style={{
            flex: 1, padding: '0.5rem', borderRadius: 'var(--radius-md)',
            background: referencesLoading ? 'var(--bg-surface-hover)' : (cacheStatus && cacheStatus.references.fresh < cacheStatus.references.total ? '#f59e0b' : 'var(--accent-secondary)'),
            color: referencesLoading ? 'var(--text-primary)' : '#fff',
            border: referencesLoading ? '1px solid var(--accent-secondary)' : 'none',
            cursor: isBusy ? 'not-allowed' : 'pointer', fontWeight: 500, fontSize: '0.75rem',
            opacity: (isBusy && !referencesLoading) ? 0.5 : 1,
            transition: 'all 0.2s'
          }}
          title={cacheStatus && cacheStatus.references.fresh < cacheStatus.references.total ? 'Some papers are not cached or the cache is stale. This will consume API rate limits.' : 'All papers are cached.'}
        >
          {referencesLoading
            ? `Loading Refs (${bulkLoading!.current}/${bulkLoading!.total})`
            : `Bulk Load References ${cacheStatus ? `(${cacheStatus.references.fresh}/${cacheStatus.references.total} cached)` : ''}`}
        </button>
      </div>

      {isBusy && (
        <div style={{
          width: '100%', height: '3px', background: 'var(--bg-surface-hover)',
          borderRadius: '2px', overflow: 'hidden'
        }}>
          <div style={{
            height: '100%',
            width: `${(bulkLoading!.current / bulkLoading!.total) * 100}%`,
            background: citationsLoading ? 'var(--accent-primary)' : 'var(--accent-secondary)',
            borderRadius: '2px',
            transition: 'width 0.3s ease'
          }} />
        </div>
      )}

      <button
        disabled={isBusy || rebuilding}
        onClick={async () => {
          setRebuilding(true);
          await useGraphStore.getState().rebuildEdges();
          setRebuilding(false);
        }}
        style={{
          width: '100%', padding: '0.5rem', borderRadius: 'var(--radius-md)',
          background: 'transparent', color: isBusy ? 'var(--text-tertiary)' : 'var(--text-secondary)',
          border: `1px solid ${isBusy ? 'var(--border-subtle)' : 'var(--border-strong)'}`,
          cursor: (isBusy || rebuilding) ? 'not-allowed' : 'pointer', fontWeight: 500, fontSize: '0.75rem',
          opacity: isBusy ? 0.5 : 1,
          transition: 'all 0.2s'
        }}
        title={isBusy ? 'Wait for bulk loading to complete first' : ''}
      >
        {rebuilding ? 'Rebuilding...' : isBusy ? 'Rebuild Cross-Edges (wait for loading)' : 'Rebuild Cross-Edges'}
      </button>
    </div>
  );
}

function CompendiumNoteItem({ node }: { node: GraphNode }) {
  const [notes, setNotes] = useState(node.notes || '');
  const [isSaving, setIsSaving] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const { activeCollectionId } = useGraphStore();

  const handleSaveNotes = async () => {
    if (!activeCollectionId) return;
    
    setIsSaving(true);
    try {
      await fetch(`/api/collection/${node.id}?collectionId=${activeCollectionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes })
      });
      
      const { graphData, selectedNode, setSelectedNode } = useGraphStore.getState();
      const targetNode = graphData.nodes.find(n => n.id === node.id);
      if (targetNode) {
         (targetNode as any).notes = notes;
      }
      
      if (selectedNode?.id === node.id) {
         const updatedSelectedNode = { ...selectedNode, notes } as any;
         setSelectedNode(updatedSelectedNode);
      }
      
      setShowSaved(true);
      setTimeout(() => setShowSaved(false), 2000);
      
    } catch (error) {
      console.error('Failed to save notes', error);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div style={{ padding: '1rem', background: 'var(--bg-background)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' }}>
      <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.25rem' }}>{node.title}</h3>
      <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>{formatAuthors(node.authors)} • {node.publicationDate ? node.publicationDate.split('-')[0] : (node.year || 'n.d.')}</p>
      
      <div style={{ position: 'relative' }}>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
              e.preventDefault();
              handleSaveNotes();
            }
          }}
          placeholder="Add your personal notes here... (Ctrl+S to save)"
          style={{
            width: '100%', minHeight: '150px', padding: '0.75rem',
            borderRadius: 'var(--radius-md)', border: '1px solid var(--border-strong)',
            background: 'var(--bg-surface)', color: 'var(--text-primary)',
            resize: 'vertical', outline: 'none', fontFamily: 'inherit', fontSize: '0.85rem'
          }}
        />
        {showSaved && (
          <div style={{
            position: 'absolute', top: '0.5rem', right: '0.5rem',
            background: 'rgba(16, 185, 129, 0.9)', color: 'white',
            padding: '0.2rem 0.6rem', borderRadius: '4px', fontSize: '0.7rem',
            fontWeight: 600, pointerEvents: 'none',
            opacity: showSaved ? 1 : 0, transition: 'opacity 0.3s'
          }}>
            Saved ✓
          </div>
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
        <button
          onClick={handleSaveNotes}
          disabled={isSaving || notes === node.notes}
          style={{
            padding: '0.4rem 1rem',
            borderRadius: 'var(--radius-sm)', background: isSaving ? 'var(--bg-surface)' : (showSaved ? '#10b981' : 'var(--accent-secondary)'),
            color: isSaving ? 'var(--text-secondary)' : '#fff', border: isSaving ? '1px solid var(--border-strong)' : 'none',
            cursor: isSaving || notes === node.notes ? 'not-allowed' : 'pointer', fontWeight: 500,
            transition: 'background 0.2s, color 0.2s', fontSize: '0.8rem',
            opacity: notes === node.notes && !showSaved ? 0.5 : 1
          }}
        >
          {isSaving ? 'Saving...' : showSaved ? 'Saved!' : 'Save Edits'}
        </button>
      </div>
    </div>
  );
}

function NotesCompendiumModal({ nodes, onClose }: { nodes: GraphNode[]; onClose: () => void }) {
  const nodesWithNotes = nodes.filter(n => (n.notes && n.notes.trim().length > 0) || ((n as any).localTags && (n as any).localTags.length > 0));
  const { tags } = useGraphStore();

  const downloadText = () => {
    const lines = nodesWithNotes.map(n => {
      const year = n.publicationDate ? n.publicationDate.split('-')[0] : (n.year || 'n.d.');
      const tagNames = ((n as any).localTags || []).map((tid: string) => tags.find(t => t.id === tid)?.name).filter(Boolean).join(', ');
      return `Title: ${n.title}\nAuthors: ${formatAuthors(n.authors)}\nYear: ${year}\nTags: ${tagNames}\nNotes:\n${n.notes || ''}\n\n----------------------------------------\n`;
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'Notes_Compendium.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadCSV = () => {
    const escapeCsv = (str: string) => `"${str.replace(/"/g, '""')}"`;
    const rows = nodesWithNotes.map(n => {
      const year = n.publicationDate ? n.publicationDate.split('-')[0] : (n.year || 'n.d.');
      const tagNames = ((n as any).localTags || []).map((tid: string) => tags.find(t => t.id === tid)?.name).filter(Boolean).join(', ');
      return `${escapeCsv(n.title)},${escapeCsv(formatAuthors(n.authors))},${year},${escapeCsv(tagNames)},${escapeCsv(n.notes || '')}`;
    });
    const header = 'Title,Authors,Year,Tags,Notes\n';
    const blob = new Blob([header + rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'Notes_Compendium.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center',
      zIndex: 200, backdropFilter: 'blur(4px)'
    }} onClick={onClose}>
      <div className="glass-panel" style={{
        background: 'var(--bg-surface)', padding: '2rem', borderRadius: 'var(--radius-lg)',
        border: '1px solid var(--border-strong)', width: '800px', maxWidth: '90vw', maxHeight: '90vh',
        overflowY: 'auto', position: 'relative', display: 'flex', flexDirection: 'column'
      }} onClick={e => e.stopPropagation()}>
        <button onClick={onClose} style={{ position: 'absolute', top: '1.5rem', right: '1.5rem', background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: '1.5rem', lineHeight: 1 }}>&times;</button>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Notes Compendium</h2>
          <div style={{ display: 'flex', gap: '0.5rem', paddingRight: '2rem' }}>
            <button onClick={downloadText} disabled={nodesWithNotes.length === 0} style={{ padding: '0.5rem 1rem', borderRadius: 'var(--radius-md)', background: 'var(--bg-surface-hover)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)', cursor: nodesWithNotes.length === 0 ? 'not-allowed' : 'pointer', fontSize: '0.8rem' }}>Download TXT</button>
            <button onClick={downloadCSV} disabled={nodesWithNotes.length === 0} style={{ padding: '0.5rem 1rem', borderRadius: 'var(--radius-md)', background: 'var(--accent-primary)', border: 'none', color: 'white', cursor: nodesWithNotes.length === 0 ? 'not-allowed' : 'pointer', fontSize: '0.8rem' }}>Download CSV</button>
          </div>
        </div>
        
        {nodesWithNotes.length === 0 ? (
          <p style={{ color: 'var(--text-secondary)' }}>No notes or tags found in this collection.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            {nodesWithNotes.map(n => (
              <CompendiumNoteItem key={n.id} node={n} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function DetailPanel() {
  const { selectedNode, setSelectedNode, activeCollectionId, graphData, relatedFilter, setRelatedFilter, collectionFilter, setCollectionFilter, edgeFilter, setEdgeFilter, syncSettings, focusedNodeId, newlyAddedPapers, clearNewlyAddedPapers, tags, tagFilter, toggleTagFilter } = useGraphStore();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [splitRatio, setSplitRatio] = useState(50);
  const [showNotesCompendium, setShowNotesCompendium] = useState(false);
  const [panelWidth, setPanelWidth] = useState(360);
  const [viewMode, setViewMode] = useState<'collection' | 'related' | 'split'>('collection');
  const [showTools, setShowTools] = useState(false);

  useEffect(() => {
    syncSettings();
    window.addEventListener('settingsUpdated', syncSettings);
    return () => window.removeEventListener('settingsUpdated', syncSettings);
  }, []);
  const [showHiddenPapers, setShowHiddenPapers] = useState(false);

  const scrollPositionRef = useRef<number>(0);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const collectionHeaderRef = useRef<HTMLDivElement>(null);
  const relatedHeaderRef = useRef<HTMLDivElement>(null);
  const isDraggingSplit = useRef(false);
  const isDraggingResize = useRef(false);

  const onMouseDownResize = (e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingResize.current = true;
    
    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!isDraggingResize.current) return;
      const newWidth = window.innerWidth - moveEvent.clientX - 16;
      setPanelWidth(Math.max(320, Math.min(newWidth, 700)));
    };
    
    const onMouseUp = () => {
      isDraggingResize.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  const onMouseDownSplit = (e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingSplit.current = true;
    
    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!isDraggingSplit.current || !containerRef.current) return;
      
      const rect = containerRef.current.getBoundingClientRect();
      const y = moveEvent.clientY - rect.top;
      let newRatio = (y / rect.height) * 100;
      
      let minRatio = 15;
      let maxRatio = 85;

      if (collectionHeaderRef.current) {
        // Add a small buffer (e.g. 10px) to ensure no clipping
        const minH = collectionHeaderRef.current.getBoundingClientRect().height + 10;
        minRatio = (minH / rect.height) * 100;
      }
      
      if (relatedHeaderRef.current) {
        // Leave room for the related header plus the 1.5rem divider itself
        const minH = relatedHeaderRef.current.getBoundingClientRect().height + 30;
        maxRatio = 100 - ((minH / rect.height) * 100);
      }
      
      newRatio = Math.max(minRatio, Math.min(newRatio, maxRatio));
      setSplitRatio(newRatio);
    };
    
    const onMouseUp = () => {
      isDraggingSplit.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  useLayoutEffect(() => {
    if (!selectedNode && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollPositionRef.current;
    }
  }, [selectedNode]);

  const getDisplayCitationCount = (node: GraphNode) => {
    return node.citationCount || 0;
  };


  let visibleIds: Set<string> | null = null;
  if (focusedNodeId) {
    visibleIds = new Set<string>();
    visibleIds.add(focusedNodeId);
    graphData.links.forEach(l => {
      const sId = typeof l.source === 'object' ? (l.source as any).id : l.source;
      const tId = typeof l.target === 'object' ? (l.target as any).id : l.target;
      if (sId === focusedNodeId) visibleIds!.add(tId);
      if (tId === focusedNodeId) visibleIds!.add(sId);
    });
  }

  const allCollectionNodes = graphData.nodes.filter(n => n.status === 'seed' && (!visibleIds || visibleIds.has(n.id)));
  const collectionNodes = allCollectionNodes.filter(n => {
    if (tagFilter.length > 0) {
      const nodeTags = (n as any).localTags || [];
      if (!tagFilter.every(tid => nodeTags.includes(tid))) return false;
    }
    if (!collectionFilter) return true;
    const authorsStr = Array.isArray(n.authors) ? n.authors.join(', ') : (n.authors || '');
    return matchesSearch(collectionFilter, [n.title, authorsStr, n.abstract || '']);
  });

  const allRelatedNodes = graphData.nodes.filter(n => n.status !== 'seed' && (!visibleIds || visibleIds.has(n.id)));
  
  const filteredRelatedNodes = allRelatedNodes.filter(n => {
    if (!showHiddenPapers && n.isHidden) return false;
    
    if (tagFilter.length > 0) {
      const nodeTags = (n as any).localTags || [];
      if (!tagFilter.every(tid => nodeTags.includes(tid))) return false;
    }
    if (!relatedFilter) return true;
    const authorsStr = Array.isArray(n.authors) ? n.authors.join(', ') : (n.authors || '');
    return matchesSearch(relatedFilter, [n.title, authorsStr, n.abstract || '']);
  }).sort((a, b) => {
    const aIsNew = newlyAddedPapers?.includes(a.id);
    const bIsNew = newlyAddedPapers?.includes(b.id);
    if (aIsNew && !bIsNew) return -1;
    if (!aIsNew && bIsNew) return 1;
    return 0;
  });

  const maxEdges = useMemo(() => {
    const counts = new Map<string, number>();
    const nodeMap = new Map<string, any>(graphData.nodes.map(n => [n.id, n]));
    const collectionIds = new Set(
      graphData.nodes.filter(n => n.status === 'seed' || n.status === 'collection').map(n => n.id)
    );
    
    graphData.links.forEach(l => {
      const sourceId = typeof l.source === 'object' ? (l.source as any).id : l.source;
      const targetId = typeof l.target === 'object' ? (l.target as any).id : l.target;
      
      if (nodeMap.has(sourceId) && nodeMap.has(targetId)) {
        if (collectionIds.has(targetId)) {
          counts.set(sourceId, (counts.get(sourceId) || 0) + 1);
        }
        if (collectionIds.has(sourceId)) {
          counts.set(targetId, (counts.get(targetId) || 0) + 1);
        }
      }
    });

    let max = 1;
    for (const [id, count] of counts.entries()) {
      const node = nodeMap.get(id);
      // The edge filter is only applied to NON-SEED nodes,
      // so the max value on the slider should reflect the max of non-seed nodes.
      if (node && node.status !== 'seed') {
        if (count > max) max = count;
      }
    }
    return max;
  }, [graphData.nodes, graphData.links]);
  const useLogScale = maxEdges > 20;
  
  const stepToValue = (step: number) => {
    if (!useLogScale) return step;
    if (step === 0) return 1;
    return Math.round(Math.pow(maxEdges, step / 100));
  };

  // Clamp edgeFilter to maxEdges in case it was set higher than the current maxEdges
  // (e.g. if the user deleted the most connected paper)
  useEffect(() => {
    if (edgeFilter > maxEdges) {
      setEdgeFilter(maxEdges);
    }
  }, [maxEdges, edgeFilter, setEdgeFilter]);
  
  const valueToStep = (val: number) => {
    if (!useLogScale) return val;
    if (val <= 1) return 0;
    return Math.round(100 * Math.log(val) / Math.log(maxEdges));
  };

  const renderToolsDrawer = () => {
    if (!showTools) return null;
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', gap: '0.75rem',
        padding: '0.75rem', background: 'var(--bg-background)',
        borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)',
        marginTop: '0.25rem'
      }}>
        {tags.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Filter by Tags</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
              {tags.map(tag => {
                const isActive = tagFilter.includes(tag.id);
                return (
                  <button 
                    key={tag.id}
                    onClick={() => toggleTagFilter(tag.id)}
                    style={{
                      padding: '0.2rem 0.5rem',
                      background: isActive ? tag.color : 'transparent',
                      color: isActive ? '#fff' : 'var(--text-primary)',
                      border: `1px solid ${tag.color}`,
                      borderRadius: '12px',
                      fontSize: '0.75rem',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                      display: 'flex', alignItems: 'center', gap: '0.25rem'
                    }}
                  >
                    {!isActive && <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: tag.color }} />}
                    {tag.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {allCollectionNodes.length > 0 && (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Bulk Actions</label>
              <BulkActionsPanel />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Minimum Connections</label>
                <span style={{ fontSize: '0.8rem', fontWeight: 'bold', color: 'var(--accent-primary)' }}>{edgeFilter}</span>
              </div>
              <input
                type="range"
                min={useLogScale ? 0 : 1}
                max={useLogScale ? 100 : maxEdges}
                step="1"
                value={valueToStep(edgeFilter)}
                onChange={(e) => setEdgeFilter(stepToValue(parseInt(e.target.value)))}
                style={{ width: '100%', cursor: 'pointer' }}
              />
            </div>
          </>
        )}
      </div>
    );
  };

  if (!activeCollectionId) return null;

  return (
    <>
      {newlyAddedPapers && (
        <div className="glass-panel" style={{
          position: 'fixed',
          top: '1.5rem',
          right: isCollapsed ? '50px' : `${panelWidth + 30}px`,
          padding: '1rem 1.5rem',
          borderRadius: 'var(--radius-lg)',
          background: 'var(--bg-surface)',
          border: '2px solid var(--status-seed)',
          zIndex: 200,
          display: 'flex',
          alignItems: 'center',
          gap: '1rem',
          boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
          transition: 'right 0.3s ease'
        }}>
          <div>
            <h3 style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--status-seed)', margin: 0 }}>
              {newlyAddedPapers.length} New Paper{newlyAddedPapers.length !== 1 ? 's' : ''} Found!
            </h3>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: '0.25rem 0 0 0' }}>
              Highlighted in the graph and list.
            </p>
          </div>
          <button
            onClick={clearNewlyAddedPapers}
            style={{
              background: 'var(--bg-surface-hover)',
              border: '1px solid var(--border-strong)',
              borderRadius: '50%',
              width: '28px', height: '28px',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', color: 'var(--text-primary)'
            }}
          >
            &times;
          </button>
        </div>
      )}
      {showNotesCompendium && <NotesCompendiumModal nodes={allCollectionNodes} onClose={() => setShowNotesCompendium(false)} />}
      
      {/* Sidebar — wrapper for toggle animation */}
      <div style={{
        position: 'absolute',
        right: isCollapsed ? `${-panelWidth}px` : '1rem',
        top: '1rem',
        bottom: '1rem',
        display: 'flex',
        alignItems: 'center',
        zIndex: 10,
        transition: 'right 0.3s ease',
      }}>
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="glass-panel"
          style={{
             width: '30px', height: '60px', marginRight: '0.5rem', 
             display: 'flex', alignItems: 'center', justifyContent: 'center',
             cursor: 'pointer', border: 'none', borderRadius: '8px 0 0 8px',
             color: 'var(--text-primary)', fontWeight: 'bold'
          }}
        >
          {isCollapsed ? '<' : '>'}
        </button>
        
        <div className="glass-panel" ref={containerRef} style={{
          width: `${panelWidth}px`,
          height: '100%',
          padding: '1.5rem',
          borderRadius: 'var(--radius-lg)',
          display: 'flex',
          flexDirection: 'column',
          gap: 0,
          overflow: 'hidden',
          position: 'relative'
        }}>
          {/* Resize Drag Handle */}
          <div
            onMouseDown={onMouseDownResize}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: '8px',
              cursor: 'col-resize',
              zIndex: 20,
              background: 'transparent'
            }}
            title="Drag to resize sidebar"
          />

          {/* Top Navigation Bar */}
          <div style={{ flexShrink: 0, display: 'flex', gap: '0.25rem', background: 'var(--bg-surface-hover)', padding: '0.25rem', borderRadius: 'var(--radius-md)', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '0.75rem', marginBottom: '0.75rem', width: '100%' }}>
            <button
              onClick={() => setViewMode('collection')}
              style={{
                flex: 1, padding: '0.4rem 0.5rem', borderRadius: 'var(--radius-sm)',
                background: viewMode === 'collection' ? 'var(--bg-surface)' : 'transparent',
                color: viewMode === 'collection' ? 'var(--text-primary)' : 'var(--text-secondary)',
                border: viewMode === 'collection' ? '1px solid var(--border-strong)' : 'none',
                fontWeight: viewMode === 'collection' ? 600 : 400,
                cursor: 'pointer', fontSize: '0.8rem',
                boxShadow: viewMode === 'collection' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                transition: 'all 0.2s', whiteSpace: 'nowrap'
              }}
            >
              📚 Collection ({collectionNodes.length})
            </button>
            <button
              onClick={() => setViewMode('related')}
              style={{
                flex: 1, padding: '0.4rem 0.5rem', borderRadius: 'var(--radius-sm)',
                background: viewMode === 'related' ? 'var(--bg-surface)' : 'transparent',
                color: viewMode === 'related' ? 'var(--text-primary)' : 'var(--text-secondary)',
                border: viewMode === 'related' ? '1px solid var(--border-strong)' : 'none',
                fontWeight: viewMode === 'related' ? 600 : 400,
                cursor: 'pointer', fontSize: '0.8rem',
                boxShadow: viewMode === 'related' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                transition: 'all 0.2s', whiteSpace: 'nowrap'
              }}
            >
              🔗 Related ({allRelatedNodes.length})
            </button>
            <button
              onClick={() => setViewMode('split')}
              title="Split side-by-side view"
              style={{
                padding: '0.4rem 0.65rem', borderRadius: 'var(--radius-sm)',
                background: viewMode === 'split' ? 'var(--bg-surface)' : 'transparent',
                color: viewMode === 'split' ? 'var(--text-primary)' : 'var(--text-secondary)',
                border: viewMode === 'split' ? '1px solid var(--border-strong)' : 'none',
                fontWeight: viewMode === 'split' ? 600 : 400,
                cursor: 'pointer', fontSize: '0.8rem',
                boxShadow: viewMode === 'split' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                transition: 'all 0.2s'
              }}
            >
              🔀
            </button>
          </div>

          {/* Collection Section */}
          {(viewMode === 'collection' || viewMode === 'split') && (
            <div style={{ display: 'flex', flexDirection: 'column', height: viewMode === 'split' ? `${splitRatio}%` : '100%', minHeight: 0 }}>
              <div ref={collectionHeaderRef} style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <h2 style={{ fontSize: '1.2rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                      Collection Papers
                    </h2>
                    <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                      {collectionNodes.length} papers in this collection
                    </p>
                  </div>
                  <button
                    onClick={() => setShowNotesCompendium(true)}
                    style={{
                      padding: '0.3rem 0.6rem', fontSize: '0.75rem', borderRadius: 'var(--radius-sm)',
                      background: 'var(--bg-surface-hover)', border: '1px solid var(--border-strong)',
                      color: 'var(--text-primary)', cursor: 'pointer', whiteSpace: 'nowrap'
                    }}
                  >
                    Notes Compendium
                  </button>
                </div>

                {allCollectionNodes.length > 0 && (
                  <>
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <SearchInput
                          value={collectionFilter}
                          onChange={(v) => setCollectionFilter(v)}
                          placeholder="Search collection papers..."
                          storageKey="detail-collection-filter"
                          style={{ width: '100%' }}
                        />
                      </div>
                      <button
                        onClick={() => setShowTools(!showTools)}
                        title="Toggle Filters & Bulk Actions"
                        style={{
                          padding: '0.4rem 0.65rem', borderRadius: 'var(--radius-md)',
                          background: showTools || edgeFilter > 1 || tagFilter.length > 0 ? 'var(--accent-primary)' : 'var(--bg-surface-hover)',
                          color: showTools || edgeFilter > 1 || tagFilter.length > 0 ? 'white' : 'var(--text-primary)',
                          border: '1px solid var(--border-strong)',
                          cursor: 'pointer', fontSize: '0.75rem', fontWeight: 500,
                          display: 'flex', alignItems: 'center', gap: '0.25rem', whiteSpace: 'nowrap',
                          transition: 'all 0.2s', height: '36px', flexShrink: 0
                        }}
                      >
                        ⚙️ Tools {(edgeFilter > 1 || tagFilter.length > 0) && '•'}
                      </button>
                    </div>

                    {/* Collapsible Tools & Filters Drawer */}
                    {renderToolsDrawer()}
                  </>
                )}
              </div>

              <div
                ref={scrollContainerRef}
                onScroll={(e) => { scrollPositionRef.current = e.currentTarget.scrollTop; }}
                style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.75rem', paddingRight: 0 }}
              >
                {collectionNodes.map(node => (
                  <div key={node.id}
                    onClick={() => setSelectedNode(selectedNode?.id === node.id ? null : node)}
                    style={{
                      padding: '0.75rem', background: 'var(--bg-surface)',
                      borderRadius: 'var(--radius-md)', 
                      border: selectedNode?.id === node.id ? '2px solid var(--accent-primary)' : '1px solid var(--border-subtle)',
                      cursor: 'pointer'
                    }}
                  >
                    <h3 title={selectedNode?.id === node.id ? undefined : node.title} style={{ fontSize: '0.9rem', marginBottom: '0.25rem', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{node.title}</h3>
                    {((node as any).localTags && (node as any).localTags.length > 0) && (
                      <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap', marginTop: '0.25rem' }}>
                        {((node as any).localTags as string[])
                           .map(tid => tags.find(t => t.id === tid))
                           .filter(Boolean)
                           .map(t => (
                             <span key={t!.id} style={{ fontSize: '0.65rem', padding: '0.1rem 0.3rem', borderRadius: '4px', background: t!.color + '40', color: 'var(--text-primary)', border: `1px solid ${t!.color}` }}>{t!.name}</span>
                           ))
                        }
                      </div>
                    )}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.5rem' }}>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                        {node.year} • {getDisplayCitationCount(node)} citations
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (window.confirm("Are you sure you want to remove this paper from your collection?")) {
                            useGraphStore.getState().removeNode(node.id);
                          }
                        }}
                        style={{
                          padding: '0.25rem 0.5rem', background: 'transparent',
                          color: '#ef4444', border: '1px solid #ef4444',
                          borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: '0.75rem'
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
                {allCollectionNodes.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '2rem 0', color: 'var(--text-tertiary)', fontSize: '0.9rem' }}>
                    No papers added yet. Search on the left to add some!
                  </div>
                ) : collectionNodes.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '2rem 0', color: 'var(--text-tertiary)', fontSize: '0.9rem' }}>
                    No collection papers match your search.
                  </div>
                ) : null}
              </div>
            </div>
          )}

          {/* Draggable Divider */}
          {viewMode === 'split' && (
            <div
              onMouseDown={onMouseDownSplit}
              style={{
                height: '1.5rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'row-resize',
                margin: '0 -1.5rem',
                background: 'transparent',
                position: 'relative',
                zIndex: 10,
                flexShrink: 0
              }}
            >
              <div style={{ width: '40px', height: '4px', background: 'var(--border-strong)', borderRadius: '2px' }} />
            </div>
          )}

          {/* Related Section */}
          {(viewMode === 'related' || viewMode === 'split') && (
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: viewMode === 'split' ? 'auto' : '100%', minHeight: 0 }}>
              <div ref={relatedHeaderRef} style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
                  <div>
                    <h2 style={{ fontSize: '1.2rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                      Related Papers
                    </h2>
                    <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                      {allRelatedNodes.length} citations and references
                    </p>
                  </div>
                  {allRelatedNodes.length > 0 && (
                    <button
                      onClick={() => useGraphStore.getState().clearRelatedNodes()}
                      style={{
                        padding: '0.25rem 0.5rem', background: 'transparent',
                        color: 'var(--text-secondary)', border: '1px solid var(--border-strong)',
                        borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: '0.75rem'
                      }}
                    >
                      Clear Graph
                    </button>
                  )}
                </div>

                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <SearchInput
                      value={relatedFilter}
                      onChange={(v) => setRelatedFilter(v)}
                      placeholder="Search title, author, or abstract..."
                      storageKey="detail-related-filter"
                      style={{ width: '100%' }}
                    />
                  </div>
                  <button
                    onClick={() => setShowTools(!showTools)}
                    title="Toggle Filters & Bulk Actions"
                    style={{
                      padding: '0.4rem 0.65rem', borderRadius: 'var(--radius-md)',
                      background: showTools || edgeFilter > 1 || tagFilter.length > 0 ? 'var(--accent-primary)' : 'var(--bg-surface-hover)',
                      color: showTools || edgeFilter > 1 || tagFilter.length > 0 ? 'white' : 'var(--text-primary)',
                      border: '1px solid var(--border-strong)',
                      cursor: 'pointer', fontSize: '0.75rem', fontWeight: 500,
                      display: 'flex', alignItems: 'center', gap: '0.25rem', whiteSpace: 'nowrap',
                      transition: 'all 0.2s', height: '36px', flexShrink: 0
                    }}
                  >
                    ⚙️ Tools {(edgeFilter > 1 || tagFilter.length > 0) && '•'}
                  </button>
                </div>

                {/* Collapsible Tools & Filters Drawer */}
                {renderToolsDrawer()}

                {/* Toggle for Hidden Papers */}
                {allRelatedNodes.filter(n => n.isHidden).length > 0 && (
                  <label style={{
                    display: 'flex', alignItems: 'center', gap: '0.5rem',
                    fontSize: '0.75rem', color: 'var(--text-secondary)',
                    cursor: 'pointer', padding: '0.25rem 0 0 0'
                  }}>
                    <input 
                      type="checkbox" 
                      checked={showHiddenPapers}
                      onChange={(e) => setShowHiddenPapers(e.target.checked)}
                      style={{ cursor: 'pointer' }}
                    />
                    Show {allRelatedNodes.filter(n => n.isHidden).length} hidden papers (from abstract nodes)
                  </label>
                )}
              </div>

              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.75rem', paddingRight: 0 }}>
                {allRelatedNodes.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '1rem 0', color: 'var(--text-tertiary)', fontSize: '0.85rem' }}>
                    No related papers. Click a paper to load its citations/references.
                  </div>
                ) : filteredRelatedNodes.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '1rem 0', color: 'var(--text-tertiary)', fontSize: '0.85rem' }}>
                    No related papers match your search.
                  </div>
                ) : (
                  filteredRelatedNodes.map(node => (
                    <div key={node.id}
                      onClick={() => setSelectedNode(selectedNode?.id === node.id ? null : node)}
                      style={{
                        padding: '0.75rem', background: 'var(--bg-surface)',
                        borderRadius: 'var(--radius-md)', 
                        border: selectedNode?.id === node.id 
                          ? '2px solid var(--accent-primary)' 
                          : (newlyAddedPapers?.includes(node.id) ? '2px solid var(--status-seed)' : '1px solid var(--border-subtle)'),
                        cursor: 'pointer', opacity: 0.8
                      }}
                    >
                      <h3 title={selectedNode?.id === node.id ? undefined : node.title} style={{ fontSize: '0.9rem', marginBottom: '0.25rem', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{node.title}</h3>
                      {((node as any).localTags && (node as any).localTags.length > 0) && (
                        <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap', marginTop: '0.25rem' }}>
                          {((node as any).localTags as string[])
                             .map(tid => tags.find(t => t.id === tid))
                             .filter(Boolean)
                             .map(t => (
                               <span key={t!.id} style={{ fontSize: '0.65rem', padding: '0.1rem 0.3rem', borderRadius: '4px', background: t!.color + '40', color: 'var(--text-primary)', border: `1px solid ${t!.color}` }}>{t!.name}</span>
                             ))
                          }
                        </div>
                      )}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.5rem' }}>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                          {node.year} • {getDisplayCitationCount(node)} citations
                        </span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            useGraphStore.getState().addSeedPaper(node as any);
                          }}
                          style={{
                            padding: '0.25rem 0.5rem', background: 'var(--accent-primary)',
                            color: 'white', border: 'none',
                            borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: '0.75rem'
                          }}
                        >
                          Add
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
    </div>

      {/* Floating draggable popup — only when a node is selected */}
      {selectedNode && (
        <PaperPopup node={selectedNode} onClose={() => setSelectedNode(null)} isRightPanelCollapsed={isCollapsed} panelWidth={panelWidth} />
      )}
    </>
  );
}
