'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useGraphStore } from '@/store/graphStore';
import { Paper } from '@/lib/openalex';
import bibtexParse from 'bibtex-parse-js';
import BibtexImportModal from './BibtexImportModal';
import BibtexTextInputModal from './BibtexTextInputModal';
import { formatAuthors } from '@/lib/formatters';
import SearchInput, { saveToHistory } from '@/components/SearchInput';

export default function Sidebar() {
  const [loading, setLoading] = useState(false);
  const [previewPaper, setPreviewPaper] = useState<Paper | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showTagsModal, setShowTagsModal] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState('#888888');
  const [newTagWeight, setNewTagWeight] = useState(0);
  const [editingTag, setEditingTag] = useState<{ id: string, name: string, color: string, weight?: number } | null>(null);
  const [s2ApiKey, setS2ApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [s2RateLimit, setS2RateLimit] = useState(1);
  const [cacheFreshnessCitations, setCacheFreshnessCitations] = useState('7');
  const [cacheFreshnessReferences, setCacheFreshnessReferences] = useState('30');
  const [maxTopNLimit, setMaxTopNLimit] = useState('100');
  const [backupStatus, setBackupStatus] = useState('');
  const [isRestoring, setIsRestoring] = useState(false);
  const [s2Usage, setS2Usage] = useState<{ last24h: { api: number; cached: number }; last7d: { api: number; cached: number }; allTime: { api: number; cached: number } } | null>(null);
  
  // Background queue processor
  useEffect(() => {
    const processQueue = async () => {
      try {
        await fetch('/api/queue', { method: 'POST' });
      } catch (e) {
        console.error('Queue processing failed', e);
      }
    };
    
    // Process queue immediately on load, then every 30 seconds
    processQueue();
    const interval = setInterval(processQueue, 30000);
    return () => clearInterval(interval);
  }, []);
  
  const { 
    collections, 
    activeCollectionId, 
    setActiveCollectionId, 
    exploreMode, 
    setExploreMode, 
    searchQuery,
    setSearchQuery,
    searchResults,
    setSearchResults,
    createCollection, 
    addSeedPaper,
    loadCollectionGraph,
    tags,
    createTag,
    updateTag,
    deleteTag
  } = useGraphStore();

  const [isImportingBibtex, setIsImportingBibtex] = useState(false);
  const [showBibtexInput, setShowBibtexInput] = useState(false);
  const [parsedBibtexEntries, setParsedBibtexEntries] = useState<any[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!searchQuery) return;
    saveToHistory('sidebar-paper-search', searchQuery);
    setLoading(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(searchQuery)}`);
      const data = await res.json();
      setSearchResults(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error(error);
      setSearchResults([]);
    } finally {
      setLoading(false);
    }
  };

  const [queueStatus, setQueueStatus] = useState<{pending: number, failed: number} | null>(null);

  const fetchQueueStatus = async () => {
    try {
      const res = await fetch('/api/queue/status');
      const data = await res.json();
      setQueueStatus(data);
    } catch (e) {
      console.error(e);
    }
  };

  const openSettings = async () => {
    try {
      const res = await fetch('/api/settings');
      const data = await res.json();
      if (data.semanticScholarApiKey) setS2ApiKey(data.semanticScholarApiKey);
      if (data.semanticScholarRateLimit) setS2RateLimit(parseInt(data.semanticScholarRateLimit) || 1);
      if (data.cacheFreshnessCitations) setCacheFreshnessCitations(data.cacheFreshnessCitations);
      if (data.cacheFreshnessReferences) setCacheFreshnessReferences(data.cacheFreshnessReferences);
      if (data.maxTopNLimit) setMaxTopNLimit(data.maxTopNLimit);
    } catch (e) {
      console.error(e);
    }
    fetchQueueStatus();
    setShowSettings(true);
    // Fetch S2 usage
    fetch('/api/settings/s2-usage').then(r => r.json()).then(setS2Usage).catch(() => {});
  };

  const saveSettings = async () => {
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          semanticScholarApiKey: s2ApiKey,
          semanticScholarRateLimit: s2RateLimit.toString(),
          cacheFreshnessCitations,
          cacheFreshnessReferences,
          maxTopNLimit
        })
      });
      window.dispatchEvent(new Event('settingsUpdated'));
      setShowSettings(false);
    } catch (e) {
      console.error(e);
    }
  };

  const handleCreateCollection = async () => {
    const name = prompt('Enter a name for the new collection:');
    if (name) {
      await createCollection(name);
    }
  };

  const handleCollectionChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const id = e.target.value;
    setActiveCollectionId(id);
    if (id) loadCollectionGraph(id);
  };

  const handleImportBibtexClick = () => {
    if (!activeCollectionId) {
      alert('Please select or create a collection first.');
      return;
    }
    setShowBibtexInput(true);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      try {
        const parsed = bibtexParse.toJSON(text);
        setParsedBibtexEntries(parsed);
        setShowBibtexInput(false);
        setIsImportingBibtex(true);
      } catch (err) {
        console.error('Error parsing BibTeX', err);
        alert('Failed to parse BibTeX file.');
      }
      // Reset input so the same file can be selected again
      if (fileInputRef.current) fileInputRef.current.value = '';
    };
    reader.readAsText(file);
  };

  const [isCollapsed, setIsCollapsed] = useState(false);

  return (
    <div style={{
      position: 'absolute',
      left: isCollapsed ? '-340px' : '1rem',
      top: '1rem',
      bottom: '1rem',
      display: 'flex',
      alignItems: 'center',
      zIndex: 10,
      transition: 'left 0.3s ease',
    }}>
      <div className="glass-panel" style={{
        width: '340px',
        height: '100%',
        padding: '1.5rem',
        borderRadius: 'var(--radius-lg)',
        display: 'flex',
        flexDirection: 'column',
        gap: '1.5rem',
        overflow: 'hidden'
      }}>
      {/* Collections Header */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', borderBottom: '1px solid var(--border-strong)', paddingBottom: '1rem' }}>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Collections</h1>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <select 
            value={activeCollectionId || ''} 
            onChange={handleCollectionChange}
            style={{ width: '100%', padding: '0.5rem', borderRadius: 'var(--radius-sm)', background: 'var(--bg-surface)', color: 'var(--text-primary)', border: '1px solid var(--border-strong)' }}
          >
            <option value="" disabled>Select a collection...</option>
            {collections.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button 
              onClick={handleCreateCollection}
              style={{ flex: 1, padding: '0.5rem', borderRadius: 'var(--radius-sm)', background: 'var(--accent-secondary)', color: 'white', border: 'none', cursor: 'pointer' }}
              title="Create new collection"
            >
              + New
            </button>
            <button 
              onClick={handleImportBibtexClick}
              style={{ flex: 1, padding: '0.5rem', borderRadius: 'var(--radius-sm)', background: 'var(--bg-surface-hover)', color: 'var(--text-primary)', border: '1px solid var(--border-strong)', cursor: 'pointer' }}
              title="Import from .bib file"
            >
              Import .bib
            </button>
            <input 
              type="file" 
              accept=".bib" 
              style={{ display: 'none' }} 
              ref={fileInputRef} 
              onChange={handleFileChange} 
            />
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '0.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            <div 
              onClick={() => setExploreMode(!exploreMode)}
              style={{
                width: '36px', height: '20px', background: exploreMode ? 'var(--accent-primary)' : 'var(--bg-surface-hover)',
                borderRadius: '10px', position: 'relative', cursor: 'pointer', transition: 'background 0.3s ease',
                border: '1px solid var(--border-strong)'
              }}
            >
              <div style={{
                position: 'absolute', top: '2px', left: exploreMode ? '18px' : '2px',
                width: '14px', height: '14px', background: 'white', borderRadius: '50%',
                transition: 'left 0.3s cubic-bezier(0.4, 0.0, 0.2, 1)',
                boxShadow: '0 1px 3px rgba(0,0,0,0.3)'
              }} />
            </div>
            <label style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => setExploreMode(!exploreMode)}>Show Cross Edges</label>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button 
              onClick={() => setShowTagsModal(true)}
              style={{ padding: '0.3rem 0.6rem', fontSize: '0.8rem', borderRadius: 'var(--radius-sm)', background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', cursor: 'pointer' }}
            >
              Tags
            </button>
            <button 
              onClick={openSettings}
              style={{ padding: '0.3rem 0.6rem', fontSize: '0.8rem', borderRadius: 'var(--radius-sm)', background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', cursor: 'pointer' }}
            >
              Settings
            </button>
          </div>
        </div>
      </div>

      {/* Search Module */}
      <div style={{ opacity: activeCollectionId ? 1 : 0.5, pointerEvents: activeCollectionId ? 'auto' : 'none' }}>
        <h2 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem' }}>Add Papers</h2>
        <form onSubmit={handleSearch} style={{ display: 'flex', gap: '0.5rem' }}>
          <SearchInput
            value={searchQuery}
            onChange={(v) => {
              setSearchQuery(v);
              if (!v) setSearchResults([]);
            }}
            onSubmit={() => handleSearch()}
            placeholder="Search DOI, keyword, or author..."
            storageKey="sidebar-paper-search"
            style={{ flex: 1 }}
          />
          <button type="submit" disabled={loading} style={{ padding: '0.5rem 1rem', borderRadius: 'var(--radius-md)', background: 'var(--accent-primary)', color: 'white', border: 'none', cursor: 'pointer' }}>
            {loading ? '...' : 'Search'}
          </button>
        </form>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {(Array.isArray(searchResults) ? searchResults : []).map(paper => (
          <div key={paper.id} 
            onClick={() => setPreviewPaper(previewPaper?.id === paper.id ? null : paper)}
            style={{ 
              padding: '1rem', background: 'var(--bg-surface)', 
              borderRadius: 'var(--radius-md)', 
              border: previewPaper?.id === paper.id ? '2px solid var(--accent-primary)' : '1px solid var(--border-subtle)', 
              cursor: 'pointer' 
            }}
          >
            <h3 title={previewPaper?.id === paper.id ? undefined : paper.title} style={{ fontSize: '0.9rem', marginBottom: '0.25rem', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{paper.title}</h3>
            {paper.venue && (
              <p style={{ fontSize: '0.8rem', color: 'var(--text-primary)', marginBottom: '0.25rem', fontStyle: 'italic' }}>
                {paper.venue}
              </p>
            )}
            <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
              {paper.year} • {paper.citationCount} citations
            </p>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button 
                onClick={(e) => { e.stopPropagation(); setPreviewPaper(paper); }}
                style={{ flex: 1, padding: '0.4rem', borderRadius: 'var(--radius-sm)', background: 'var(--bg-surface-hover)', color: 'var(--accent-secondary)', border: '1px solid var(--border-strong)', cursor: 'pointer', fontSize: '0.8rem' }}
              >
                View Details
              </button>
              <button 
                onClick={(e) => { e.stopPropagation(); addSeedPaper(paper); }}
                style={{ flex: 1, padding: '0.4rem', borderRadius: 'var(--radius-sm)', background: 'var(--accent-primary)', color: '#fff', border: 'none', cursor: 'pointer', fontSize: '0.8rem' }}
              >
                Add 
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Preview Modal */}
      {previewPaper && (
        <div style={{
          position: 'fixed',
          top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 100,
          backdropFilter: 'blur(4px)'
        }}>
          <div className="glass-panel" style={{
            width: '90%',
            maxWidth: '600px',
            maxHeight: '90vh',
            padding: '2rem',
            borderRadius: 'var(--radius-lg)',
            display: 'flex',
            flexDirection: 'column',
            gap: '1rem',
            position: 'relative'
          }}>
            <button 
              onClick={() => setPreviewPaper(null)}
              style={{ position: 'absolute', top: '1.5rem', right: '1.5rem', background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: '1.5rem', lineHeight: 1 }}
            >
              &times;
            </button>
            <h2 style={{ fontSize: '1.25rem', fontWeight: 600, paddingRight: '2rem' }}>{previewPaper.title}</h2>
            
            {previewPaper.venue && (
              <p style={{ fontSize: '1rem', color: 'var(--accent-primary)', fontWeight: 500 }}>
                {previewPaper.venue}
              </p>
            )}
            
            <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
              {formatAuthors(previewPaper.authors)}
            </p>
            
            <p style={{ fontSize: '0.9rem', color: 'var(--text-tertiary)' }}>
              {previewPaper.year} • {previewPaper.citationCount} citations
            </p>
            
            <div style={{ flex: 1, overflowY: 'auto', marginTop: '1rem', marginBottom: '1rem', paddingRight: '1rem' }}>
              <h3 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>Abstract</h3>
              <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                {previewPaper.abstract || 'No abstract available.'}
              </p>
            </div>
            
            <div style={{ display: 'flex', gap: '1rem', marginTop: 'auto' }}>
              {previewPaper.url && (
                <a 
                  href={previewPaper.url} 
                  target="_blank" 
                  rel="noopener noreferrer" 
                  style={{ flex: 1, padding: '0.75rem', textAlign: 'center', borderRadius: 'var(--radius-md)', background: 'var(--bg-surface-hover)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)', textDecoration: 'none' }}
                >
                  View PDF / Source
                </a>
              )}
              <button 
                onClick={() => {
                  addSeedPaper(previewPaper);
                  setPreviewPaper(null);
                }}
                style={{ flex: 2, padding: '0.75rem', borderRadius: 'var(--radius-md)', background: 'var(--accent-primary)', color: 'white', border: 'none', cursor: 'pointer', fontWeight: 600 }}
              >
                Add to Collection
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tags Modal */}
      {showTagsModal && (
        <div style={{
          position: 'fixed',
          top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 100
        }} onClick={() => setShowTagsModal(false)}>
          <div style={{
            position: 'relative',
            background: 'var(--bg-surface)',
            padding: '2rem',
            borderRadius: 'var(--radius-lg)',
            border: '1px solid var(--border-strong)',
            width: '400px',
            maxWidth: '90vw',
            maxHeight: '90vh',
            display: 'flex',
            flexDirection: 'column',
            gap: '1rem'
          }} onClick={e => e.stopPropagation()}>
            <button 
              onClick={() => setShowTagsModal(false)}
              style={{ position: 'absolute', top: '1.5rem', right: '1.5rem', background: 'transparent', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: '1.5rem', lineHeight: 1 }}
            >
              &times;
            </button>
            <h2 style={{ fontSize: '1.2rem', margin: 0 }}>Manage Tags</h2>
            
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <input 
                type="color"
                value={editingTag ? editingTag.color : newTagColor}
                onChange={e => editingTag ? setEditingTag({...editingTag, color: e.target.value}) : setNewTagColor(e.target.value)}
                style={{ width: '32px', height: '32px', padding: '0', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
              />
              <input 
                type="text"
                placeholder={editingTag ? "Rename tag..." : "New tag name..."}
                value={editingTag ? editingTag.name : newTagName}
                onChange={e => editingTag ? setEditingTag({...editingTag, name: e.target.value}) : setNewTagName(e.target.value)}
                style={{ flex: 1, padding: '0.5rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-strong)', background: 'var(--bg-background)', color: 'var(--text-primary)' }}
              />
              <input 
                type="number"
                placeholder="Rank"
                title="Weight/Rank (higher appears first)"
                value={editingTag ? (editingTag.weight || 0) : newTagWeight}
                onChange={e => editingTag ? setEditingTag({...editingTag, weight: parseInt(e.target.value) || 0}) : setNewTagWeight(parseInt(e.target.value) || 0)}
                style={{ width: '60px', padding: '0.5rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-strong)', background: 'var(--bg-background)', color: 'var(--text-primary)' }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    if (editingTag) {
                      updateTag(editingTag.id, editingTag.name, editingTag.color, editingTag.weight);
                      setEditingTag(null);
                    } else if (newTagName.trim()) {
                      createTag(newTagName.trim(), newTagColor, newTagWeight);
                      setNewTagName('');
                      setNewTagWeight(0);
                    }
                  }
                }}
              />
              <button 
                onClick={() => {
                  if (editingTag) {
                    updateTag(editingTag.id, editingTag.name, editingTag.color, editingTag.weight);
                    setEditingTag(null);
                  } else if (newTagName.trim()) {
                    createTag(newTagName.trim(), newTagColor, newTagWeight);
                    setNewTagName('');
                    setNewTagWeight(0);
                  }
                }}
                disabled={editingTag ? !editingTag.name.trim() : !newTagName.trim()}
                style={{ padding: '0.5rem 1rem', borderRadius: 'var(--radius-md)', background: 'var(--accent-primary)', color: 'white', border: 'none', cursor: 'pointer', opacity: (editingTag ? !editingTag.name.trim() : !newTagName.trim()) ? 0.5 : 1 }}
              >
                {editingTag ? 'Save' : 'Add'}
              </button>
              {editingTag && (
                <button
                  onClick={() => setEditingTag(null)}
                  style={{ padding: '0.5rem', borderRadius: 'var(--radius-md)', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-strong)', cursor: 'pointer' }}
                >
                  Cancel
                </button>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', overflowY: 'auto', flex: 1 }}>
              {tags.map(tag => (
                <div key={tag.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.5rem', background: 'var(--bg-surface-hover)', borderRadius: 'var(--radius-md)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: tag.color }}></div>
                    <span style={{ fontSize: '0.9rem', color: 'var(--text-primary)' }}>{tag.name}</span>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', background: 'var(--bg-background)', padding: '0.1rem 0.3rem', borderRadius: '4px' }}>Rank: {tag.weight || 0}</span>
                  </div>
                  <div style={{ display: 'flex', gap: '0.25rem' }}>
                    <button 
                      onClick={() => setEditingTag(tag)}
                      style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', borderRadius: 'var(--radius-sm)', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-strong)', cursor: 'pointer' }}
                    >
                      Edit
                    </button>
                    <button 
                      onClick={() => {
                        if (confirm(`Delete tag "${tag.name}"? This will remove it from all papers.`)) {
                          deleteTag(tag.id);
                        }
                      }}
                      style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', borderRadius: 'var(--radius-sm)', background: 'transparent', color: '#ef4444', border: '1px solid #ef4444', cursor: 'pointer' }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
              {tags.length === 0 && (
                <p style={{ fontSize: '0.9rem', color: 'var(--text-tertiary)', textAlign: 'center', padding: '2rem 0' }}>No tags created yet.</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Settings Modal */}
      {showSettings && (
        <div style={{
          position: 'fixed',
          top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 100
        }} onClick={() => setShowSettings(false)}>
          <div style={{
            position: 'relative',
            background: 'var(--bg-surface)',
            padding: '2rem',
            borderRadius: 'var(--radius-lg)',
            border: '1px solid var(--border-strong)',
            width: '400px',
            maxWidth: '90vw',
            maxHeight: '90vh',
            overflowY: 'auto'
          }} onClick={e => e.stopPropagation()}>
            <button 
              onClick={() => setShowSettings(false)}
              style={{ position: 'absolute', top: '1rem', right: '1rem', background: 'transparent', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: '1.25rem', lineHeight: 1 }}
            >
              &times;
            </button>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h2 style={{ fontSize: '1.2rem', margin: 0 }}>Settings</h2>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button 
                  onClick={() => setShowSettings(false)}
                  style={{ padding: '0.4rem 0.75rem', borderRadius: 'var(--radius-sm)', background: 'transparent', color: 'var(--text-secondary)', border: 'none', cursor: 'pointer', fontSize: '0.8rem' }}
                >
                  Cancel
                </button>
                <button 
                  onClick={saveSettings}
                  style={{ padding: '0.4rem 0.75rem', borderRadius: 'var(--radius-sm)', background: 'var(--accent-primary)', color: '#fff', border: 'none', cursor: 'pointer', fontSize: '0.8rem' }}
                >
                  Save
                </button>
              </div>
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1rem' }}>
              <label style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>Semantic Scholar API Key</label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input 
                  type={showApiKey ? "text" : "password"} 
                  value={s2ApiKey}
                  onChange={e => setS2ApiKey(e.target.value)}
                  placeholder="Optional (improves rate limits)"
                  style={{ flex: 1, padding: '0.75rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-strong)', background: 'var(--bg-background)', color: 'var(--text-primary)' }}
                />
                <button 
                  onClick={() => setShowApiKey(!showApiKey)}
                  style={{ padding: '0 1rem', borderRadius: 'var(--radius-md)', background: 'var(--bg-surface-hover)', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', cursor: 'pointer' }}
                >
                  {showApiKey ? 'Hide' : 'View'}
                </button>
              </div>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                Provides fallback citation discovery. Get a free key at <a href="https://www.semanticscholar.org/product/api" target="_blank" rel="noreferrer" style={{ color: 'var(--accent-primary)' }}>semanticscholar.org</a>.
              </p>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1rem' }}>
              <label style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>Rate Limit (requests/sec)</label>
              <input 
                type="number" 
                min="1"
                value={s2RateLimit}
                onChange={e => setS2RateLimit(parseInt(e.target.value) || 1)}
                style={{ padding: '0.75rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-strong)', background: 'var(--bg-background)', color: 'var(--text-primary)' }}
              />
              <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                Limits how fast Bulk Expansion requests are sent. Defaults to 1.
              </p>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1rem' }}>
              <label style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>Cache Freshness (Citations)</label>
              <select 
                value={cacheFreshnessCitations}
                onChange={e => setCacheFreshnessCitations(e.target.value)}
                style={{ padding: '0.75rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-strong)', background: 'var(--bg-background)', color: 'var(--text-primary)' }}
              >
                <option value="0">No cache</option>
                <option value="1">1 day</option>
                <option value="7">1 week</option>
                <option value="30">1 month</option>
              </select>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                How long to cache citation lookups.
              </p>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1rem' }}>
              <label style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>Cache Freshness (References)</label>
              <select 
                value={cacheFreshnessReferences}
                onChange={e => setCacheFreshnessReferences(e.target.value)}
                style={{ padding: '0.75rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-strong)', background: 'var(--bg-background)', color: 'var(--text-primary)' }}
              >
                <option value="0">No cache</option>
                <option value="1">1 day</option>
                <option value="7">1 week</option>
                <option value="30">1 month</option>
                <option value="180">6 months</option>
              </select>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                How long to cache reference lookups. References rarely change for published papers.
              </p>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1rem', padding: '1rem', background: 'var(--bg-surface-hover)', borderRadius: 'var(--radius-md)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>S2 API Usage</label>
                <button
                  onClick={() => fetch('/api/settings/s2-usage').then(r => r.json()).then(setS2Usage).catch(() => {})}
                  style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', borderRadius: 'var(--radius-sm)', background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', cursor: 'pointer' }}
                >
                  Refresh
                </button>
              </div>
              {s2Usage ? (
                <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.25rem' }}>
                  <div style={{ flex: 1, textAlign: 'center' }}>
                    <div style={{ fontSize: '1.25rem', fontWeight: 600, color: 'var(--text-primary)' }}>{s2Usage.last24h.api}</div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)' }}>API (24h)</div>
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)', opacity: 0.7 }}>{s2Usage.last24h.cached} cached</div>
                  </div>
                  <div style={{ flex: 1, textAlign: 'center' }}>
                    <div style={{ fontSize: '1.25rem', fontWeight: 600, color: 'var(--text-primary)' }}>{s2Usage.last7d.api}</div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)' }}>API (7d)</div>
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)', opacity: 0.7 }}>{s2Usage.last7d.cached} cached</div>
                  </div>
                  <div style={{ flex: 1, textAlign: 'center' }}>
                    <div style={{ fontSize: '1.25rem', fontWeight: 600, color: 'var(--text-primary)' }}>{s2Usage.allTime.api}</div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)' }}>API (all time)</div>
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)', opacity: 0.7 }}>{s2Usage.allTime.cached} cached</div>
                  </div>
                </div>
              ) : (
                <p style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>Loading...</p>
              )}
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '1rem' }}>
              <label style={{ fontSize: '0.9rem', fontWeight: 'bold' }}>Global Related Papers Limit</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input
                  type="number"
                  min="5"
                  max="1000"
                  step="5"
                  value={maxTopNLimit}
                  onChange={e => setMaxTopNLimit(e.target.value)}
                  style={{
                    flex: 1, padding: '0.5rem',
                    background: 'var(--bg-panel)', border: '1px solid var(--border-strong)',
                    color: 'var(--text-primary)', borderRadius: 'var(--radius-md)'
                  }}
                />
                <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>papers</span>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1.5rem', padding: '1rem', background: 'var(--bg-surface-hover)', borderRadius: 'var(--radius-md)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>Background Queue Status</label>
                <button 
                  onClick={fetchQueueStatus}
                  style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', borderRadius: 'var(--radius-sm)', background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', cursor: 'pointer' }}
                >
                  Refresh
                </button>
              </div>
              {queueStatus ? (
                <div style={{ display: 'flex', gap: '1rem', marginTop: '0.5rem' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '1.25rem', fontWeight: 600, color: queueStatus.pending > 0 ? 'var(--status-seed)' : 'var(--text-primary)' }}>{queueStatus.pending}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>Pending</div>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '1.25rem', fontWeight: 600, color: queueStatus.failed > 0 ? '#ef4444' : 'var(--text-primary)' }}>{queueStatus.failed}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>Failed</div>
                  </div>
                </div>
              ) : (
                <p style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>Loading status...</p>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1.5rem', padding: '1rem', background: 'var(--bg-surface-hover)', borderRadius: 'var(--radius-md)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>Database Backup & Restore</label>
              </div>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                Automatic backups run every 12 hours. You can also trigger a manual backup. Backups are stored in your data volume.
              </p>

              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                <button 
                  onClick={async () => {
                    setBackupStatus('Backing up...');
                    try {
                      const res = await fetch('/api/settings/backup/manual', { method: 'POST' });
                      const data = await res.json();
                      if (data.success) {
                        setBackupStatus('Backup complete!');
                      } else {
                        setBackupStatus(`Error: ${data.error}`);
                      }
                    } catch (e: any) {
                      setBackupStatus(`Error: ${e.message}`);
                    }
                    setTimeout(() => setBackupStatus(''), 4000);
                  }}
                  style={{ flex: 1, padding: '0.5rem', borderRadius: 'var(--radius-md)', background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.8rem' }}
                >
                  Manual Backup Now
                </button>
                <button 
                  disabled={isRestoring}
                  onClick={async () => {
                    try {
                      const res = await fetch('/api/settings/backup/restore');
                      const data = await res.json();
                      if (data.path) {
                        if (confirm(`Are you sure you want to restore the database from ${data.path}? Your current database will be backed up as pre_restore_backup.db`)) {
                          setIsRestoring(true);
                          setBackupStatus('Restoring...');
                          const restoreRes = await fetch('/api/settings/backup/restore', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ backupPath: data.path })
                          });
                          const restoreData = await restoreRes.json();
                          if (restoreData.success) {
                            alert('Restore successful! The page will now reload.');
                            window.location.reload();
                          } else {
                            alert(`Restore failed: ${restoreData.error}`);
                            setBackupStatus('');
                            setIsRestoring(false);
                          }
                        }
                      } else if (data.error) {
                        alert(data.error);
                      }
                    } catch (e: any) {
                      alert(`Error picking file: ${e.message}`);
                    }
                  }}
                  style={{ flex: 1, padding: '0.5rem', borderRadius: 'var(--radius-md)', background: 'transparent', border: '1px solid #ef4444', color: '#ef4444', cursor: isRestoring ? 'not-allowed' : 'pointer', fontSize: '0.8rem', opacity: isRestoring ? 0.5 : 1 }}
                >
                  {isRestoring ? 'Restoring...' : 'Restore Database'}
                </button>
              </div>
              {backupStatus && <div style={{ fontSize: '0.75rem', color: 'var(--status-seed)' }}>{backupStatus}</div>}
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1.5rem', padding: '1rem', background: 'var(--bg-surface-hover)', borderRadius: 'var(--radius-md)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>API Cache Management</label>
              </div>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                Citation and reference lookups are cached to save bandwidth and API limits. You can invalidate the cache for papers in your current collection to force a fresh lookup.
              </p>
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                <button 
                  onClick={async () => {
                    if (!activeCollectionId) return alert('Please select a collection first');
                    try {
                      const res = await fetch(`/api/settings/cache?collectionId=${activeCollectionId}`, { method: 'DELETE' });
                      const data = await res.json();
                      alert(data.message || 'Cache cleared');
                    } catch (e) {
                      console.error(e);
                      alert('Failed to clear cache');
                    }
                  }}
                  style={{ flex: 1, padding: '0.5rem', borderRadius: 'var(--radius-md)', background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.8rem' }}
                >
                  Clear Collection Cache
                </button>
                <button 
                  onClick={async () => {
                    try {
                      const res = await fetch(`/api/settings/cache`, { method: 'DELETE' });
                      const data = await res.json();
                      alert(data.message || 'All cache cleared');
                    } catch (e) {
                      console.error(e);
                      alert('Failed to clear cache');
                    }
                  }}
                  style={{ flex: 1, padding: '0.5rem', borderRadius: 'var(--radius-md)', background: 'transparent', border: '1px solid #ef4444', color: '#ef4444', cursor: 'pointer', fontSize: '0.8rem' }}
                >
                  Clear All Cache
                </button>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '1rem', justifyContent: 'flex-end' }}>
              <button 
                onClick={() => setShowSettings(false)}
                style={{ padding: '0.5rem 1rem', borderRadius: 'var(--radius-sm)', background: 'transparent', color: 'var(--text-secondary)', border: 'none', cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button 
                onClick={saveSettings}
                style={{ padding: '0.5rem 1rem', borderRadius: 'var(--radius-sm)', background: 'var(--accent-primary)', color: '#fff', border: 'none', cursor: 'pointer' }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
      </div>

      <button
        onClick={() => setIsCollapsed(!isCollapsed)}
        className="glass-panel"
        style={{
           width: '30px', height: '60px', marginLeft: '0.5rem', 
           display: 'flex', alignItems: 'center', justifyContent: 'center',
           cursor: 'pointer', border: 'none', borderRadius: '0 8px 8px 0',
           color: 'var(--text-primary)', fontWeight: 'bold'
        }}
      >
        {isCollapsed ? '>' : '<'}
      </button>

      {showBibtexInput && (
        <BibtexTextInputModal 
          onImport={(entries) => {
            setParsedBibtexEntries(entries);
            setShowBibtexInput(false);
            setIsImportingBibtex(true);
          }}
          onUploadFile={() => {
            fileInputRef.current?.click();
          }}
          onClose={() => setShowBibtexInput(false)}
        />
      )}

      {isImportingBibtex && (
        <BibtexImportModal 
          entries={parsedBibtexEntries} 
          onClose={() => setIsImportingBibtex(false)} 
        />
      )}
    </div>
  );
}
