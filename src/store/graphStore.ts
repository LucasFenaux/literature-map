import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Paper } from '@/lib/openalex';

export interface GraphNode extends Paper {
  x?: number;
  y?: number;
  val?: number; // size in graph
  status?: string;
  notes?: string;
  isHidden?: boolean;
}

export interface GraphLink {
  source: string | GraphNode;
  target: string | GraphNode;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

export interface Collection {
  id: string;
  name: string;
  createdAt: string;
}

export interface Tag {
  id: string;
  name: string;
  color: string;
  weight?: number;
  createdAt: string;
}


interface GraphState {
  collections: Collection[];
  activeCollectionId: string | null;
  exploreMode: boolean; // toggle for cross-collection citations
  searchQuery: string;
  relatedFilter: string;
  collectionFilter: string;
  edgeFilter: number;
  topNLimit: number;
  searchResults: Paper[];
  graphData: GraphData;
  selectedNode: GraphNode | null;
  focusedNodeId: string | null;
  bulkLoading: { type: string; current: number; total: number } | null;
  newlyAddedPapers: string[] | null;
  clearedNewPapers: string[];
  tags: Tag[];
  tagFilter: string[];
  
  setCollections: (collections: Collection[]) => void;
  setActiveCollectionId: (id: string | null) => void;
  setExploreMode: (mode: boolean) => void;
  setSearchQuery: (query: string) => void;
  setRelatedFilter: (query: string) => void;
  setCollectionFilter: (query: string) => void;
  setEdgeFilter: (filter: number) => void;
  setTopNLimit: (limit: number) => void;
  setSearchResults: (results: Paper[]) => void;
  syncSettings: () => Promise<void>;
  setGraphData: (data: GraphData) => void;
  setSelectedNode: (node: GraphNode | null) => void;
  setFocusedNodeId: (id: string | null) => void;
  clearNewlyAddedPapers: () => void;
  setTags: (tags: Tag[]) => void;
  setTagFilter: (filter: string[]) => void;
  toggleTagFilter: (tagId: string) => void;
  
  fetchCollections: () => Promise<void>;
  loadCollectionGraph: (collectionId: string) => Promise<void>;
  createCollection: (name: string) => Promise<void>;
  addSeedPaper: (paper: Paper) => Promise<void>;
  removeNode: (id: string) => Promise<void>;
  clearRelatedNodes: () => Promise<void>;
  expandNode: (id: string, type?: 'citations' | 'references' | 'both') => Promise<void>;
  bulkExpand: (type: 'citations' | 'references') => Promise<void>;
  rebuildEdges: () => Promise<void>;
  fetchTags: () => Promise<void>;
  createTag: (name: string, color?: string, weight?: number) => Promise<void>;
  updateTag: (id: string, name: string, color: string, weight?: number) => Promise<void>;
  deleteTag: (id: string) => Promise<void>;
}

let lastProcessedNodes: GraphNode[] | null = null;
let lastProcessedLinks: GraphLink[] | null = null;
let cachedNodeDegrees: Map<string, number> | null = null;
let cachedSeedEdgeCounts: Map<string, number> | null = null;

const calculateSizes = (nodes: GraphNode[], links: GraphLink[], topNLimit: number = 100, cachedThreshold?: number) => {
  let nodeDegrees: Map<string, number>;
  let seedEdgeCounts: Map<string, number>;

  // Cache hit: graph structure hasn't changed!
  if (nodes === lastProcessedNodes && links === lastProcessedLinks && cachedNodeDegrees && cachedSeedEdgeCounts) {
    nodeDegrees = cachedNodeDegrees;
    seedEdgeCounts = cachedSeedEdgeCounts;
  } else {
    // Cache miss: compute from scratch
    nodeDegrees = new Map<string, number>();
    seedEdgeCounts = new Map<string, number>();
    const seedNodeIds = new Set(nodes.filter(n => n.status === 'seed' || n.status === 'collection').map(n => n.id));

    links.forEach(l => {
      const s = typeof l.source === 'string' ? l.source : (l.source as any).id;
      const t = typeof l.target === 'string' ? l.target : (l.target as any).id;
      
      nodeDegrees.set(s, (nodeDegrees.get(s) || 0) + 1);
      nodeDegrees.set(t, (nodeDegrees.get(t) || 0) + 1);

      const sIsSeed = seedNodeIds.has(s);
      const tIsSeed = seedNodeIds.has(t);

      if (sIsSeed && !tIsSeed) {
        seedEdgeCounts.set(t, (seedEdgeCounts.get(t) || 0) + 1);
      } else if (tIsSeed && !sIsSeed) {
        seedEdgeCounts.set(s, (seedEdgeCounts.get(s) || 0) + 1);
      } else if (sIsSeed && tIsSeed) {
        seedEdgeCounts.set(s, (seedEdgeCounts.get(s) || 0) + 1);
        seedEdgeCounts.set(t, (seedEdgeCounts.get(t) || 0) + 1);
      }
    });

    lastProcessedNodes = nodes;
    lastProcessedLinks = links;
    cachedNodeDegrees = nodeDegrees;
    cachedSeedEdgeCounts = seedEdgeCounts;
  }

  let threshold = 1;
  const validNodeIds = new Set<string>();
  
  if (cachedThreshold !== undefined) {
    threshold = cachedThreshold;
    for (const n of nodes) {
      if (n.status !== 'seed' && n.status !== 'collection') {
        if ((seedEdgeCounts.get(n.id) || 0) >= threshold) {
          validNodeIds.add(n.id);
        }
      }
    }
  } else {
    const counts: number[] = [];
    for (const n of nodes) {
      if (n.status !== 'seed' && n.status !== 'collection') {
        const c = seedEdgeCounts.get(n.id) || 0;
        if (c > 0) counts.push(c);
      }
    }
    
    counts.sort((a, b) => b - a);
    
    if (counts.length <= topNLimit) {
      threshold = 1;
    } else {
      threshold = counts[topNLimit] + 1;
    }
    
    for (const n of nodes) {
      if (n.status !== 'seed' && n.status !== 'collection') {
        if ((seedEdgeCounts.get(n.id) || 0) >= threshold) {
          validNodeIds.add(n.id);
        }
      }
    }
  }

  nodes.forEach(n => {
    let isHidden = false;
    if (n.status !== 'seed' && n.status !== 'collection') {
       if (!validNodeIds.has(n.id)) {
         isHidden = true;
       }
    }
    
    n.isHidden = isHidden;
    (n as any).seedEdgeCount = seedEdgeCounts.get(n.id) || 0;
    (n as any).nodeDegree = nodeDegrees.get(n.id) || 0;
    n.val = ((n.status === 'seed' || n.status === 'collection') ? 20 : 10) + ((n as any).nodeDegree) * 2;
  });
  return { nodes, threshold };
};

export const useGraphStore = create<GraphState>()(
  persist(
    (set, get) => ({
      collections: [],
      activeCollectionId: null,
      exploreMode: false,
      searchQuery: '',
      relatedFilter: '',
      collectionFilter: '',
      edgeFilter: 1,
      topNLimit: 20,
      searchResults: [],
      graphData: { nodes: [], links: [] },
      selectedNode: null,
      focusedNodeId: null,
      bulkLoading: null,
      newlyAddedPapers: null,
      clearedNewPapers: [],
      tags: [],
      tagFilter: [],
      
      setCollections: (collections) => set({ collections }),
      setActiveCollectionId: (id) => set({ activeCollectionId: id, selectedNode: null, focusedNodeId: null, clearedNewPapers: [], newlyAddedPapers: null }),
      setExploreMode: (mode) => set({ exploreMode: mode }),
      setSearchQuery: (query) => set({ searchQuery: query }),
      setRelatedFilter: (query) => set({ relatedFilter: query }),
      setCollectionFilter: (query) => set({ collectionFilter: query }),
      setEdgeFilter: (edgeFilter) => {
        const { graphData, topNLimit, edgeFilter: currentFilter } = get();
        if (edgeFilter === currentFilter) return;
        const { threshold } = calculateSizes(graphData.nodes, graphData.links, topNLimit);
        set({ edgeFilter: Math.max(edgeFilter, threshold) });
      },
      setTopNLimit: (topNLimit) => {
        const { graphData, edgeFilter } = get();
        const { nodes: sizedNodes, threshold } = calculateSizes(graphData.nodes, graphData.links, topNLimit);
        set({ topNLimit, edgeFilter: Math.max(edgeFilter, threshold), graphData: { ...graphData, nodes: sizedNodes } });
      },
      syncSettings: async () => {
        try {
          const res = await fetch('/api/settings');
          const data = await res.json();
          if (data.maxTopNLimit) {
            const limit = parseInt(data.maxTopNLimit);
            get().setTopNLimit(limit);
          }
        } catch (e) {
          console.error(e);
        }
      },
      setSearchResults: (results) => set({ searchResults: results }),
      setGraphData: (data) => set({ graphData: data }),
      setSelectedNode: (node) => set({ selectedNode: node }),
      setFocusedNodeId: (id) => set({ focusedNodeId: id }),
      clearNewlyAddedPapers: () => set((state) => ({ 
        clearedNewPapers: [...state.clearedNewPapers, ...(state.newlyAddedPapers || [])],
        newlyAddedPapers: null 
      })),
      setTags: (tags) => set({ tags }),
      setTagFilter: (filter) => set({ tagFilter: filter }),
      toggleTagFilter: (tagId) => set((state) => ({
        tagFilter: state.tagFilter.includes(tagId)
          ? state.tagFilter.filter(id => id !== tagId)
          : [...state.tagFilter, tagId]
      })),
  
      clearRelatedNodes: async () => {
        const { activeCollectionId, graphData, selectedNode } = get();
        if (!activeCollectionId) return;

        try {
          await fetch(`/api/collection/${activeCollectionId}/clear`, {
            method: 'DELETE'
          });
        } catch (err) {
          console.error('Failed to clear related nodes from database', err);
        }

        const newNodes = graphData.nodes.filter(n => n.status === 'seed');
        const seedIds = new Set(newNodes.map(n => n.id));
        const newLinks = graphData.links.filter(l => {
          const sourceId = typeof l.source === 'string' ? l.source : (l.source as any).id;
          const targetId = typeof l.target === 'string' ? l.target : (l.target as any).id;
          return seedIds.has(sourceId) && seedIds.has(targetId);
        });
        const { nodes: sizedNodes, threshold } = calculateSizes(newNodes, newLinks, get().topNLimit || 20);
        set({ 
          graphData: { nodes: sizedNodes, links: newLinks }, 
          edgeFilter: Math.max(get().edgeFilter, threshold),
          selectedNode: selectedNode?.status !== 'seed' ? null : selectedNode
        });
      },

  fetchCollections: async () => {
    try {
      const res = await fetch('/api/collections');
      const data = await res.json();
      set({ collections: data });
    } catch (err) {
      console.error('Failed to fetch collections', err);
    }
  },

  fetchTags: async () => {
    try {
      const res = await fetch('/api/tags');
      const tags = await res.json();
      set({ tags });
    } catch (err) {
      console.error('Failed to fetch tags', err);
    }
  },

  createTag: async (name, color, weight = 0) => {
    try {
      const res = await fetch('/api/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color, weight })
      });
      const data = await res.json();
      if (data.tag) {
        set((state) => {
          const newTags = [...state.tags, data.tag].sort((a, b) => {
            const wA = a.weight ?? 0;
            const wB = b.weight ?? 0;
            if (wB !== wA) return wB - wA;
            return a.name.localeCompare(b.name);
          });
          return { tags: newTags };
        });
      }
    } catch (err) {
      console.error('Failed to create tag', err);
    }
  },

  updateTag: async (id, name, color, weight = 0) => {
    try {
      const res = await fetch(`/api/tags/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color, weight })
      });
      const data = await res.json();
      if (data.tag) {
        set((state) => {
          const newTags = state.tags.map(t => t.id === id ? { ...t, ...data.tag } : t).sort((a, b) => {
            const wA = a.weight ?? 0;
            const wB = b.weight ?? 0;
            if (wB !== wA) return wB - wA;
            return a.name.localeCompare(b.name);
          });
          return { tags: newTags };
        });
      }
    } catch (err) {
      console.error('Failed to update tag', err);
    }
  },

  deleteTag: async (id) => {
    try {
      await fetch(`/api/tags/${id}`, { method: 'DELETE' });
      set((state) => ({ 
        tags: state.tags.filter(t => t.id !== id),
        tagFilter: state.tagFilter.filter(tid => tid !== id)
      }));
    } catch (err) {
      console.error('Failed to delete tag', err);
    }
  },
  
  createCollection: async (name: string) => {
    try {
      const res = await fetch('/api/collections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      const newCollection = await res.json();
      set((state) => ({ collections: [newCollection, ...state.collections] }));
      get().setActiveCollectionId(newCollection.id);
      get().setGraphData({ nodes: [], links: [] });
    } catch (err) {
      console.error('Failed to create collection', err);
    }
  },

  loadCollectionGraph: async (collectionId: string) => {
    try {
      const [res, linksRes] = await Promise.all([
        fetch(`/api/collection?collectionId=${collectionId}`),
        fetch(`/api/collection/links?collectionId=${collectionId}`)
      ]);
      
      const papers = await res.json();
      const links = await linksRes.json();
      
      const { nodes: sizedNodes, threshold } = calculateSizes(papers, links, get().topNLimit || 20);
      
      set({ 
        graphData: { nodes: sizedNodes, links }, 
        activeCollectionId: collectionId, 
        edgeFilter: Math.max(get().edgeFilter, threshold), 
        clearedNewPapers: [], 
        newlyAddedPapers: null 
      });
    } catch (err) {
      console.error('Failed to load collection graph', err);
    }
  },

  addSeedPaper: async (paper) => {
    const { graphData, activeCollectionId, edgeFilter, selectedNode } = get();
    if (!activeCollectionId) return;

    const existingNodeIndex = graphData.nodes.findIndex(n => n.id === paper.id);
    if (existingNodeIndex >= 0 && graphData.nodes[existingNodeIndex].status === 'seed') {
      return;
    }

    // Record previous status for targeted delta rollback
    const previousStatus = existingNodeIndex >= 0 ? graphData.nodes[existingNodeIndex].status : null;
    const previousEdgeFilter = edgeFilter;

    // Apply optimistic UI update with fully cloned node objects
    const newNodes: GraphNode[] = graphData.nodes.map(n => ({ ...n }));
    if (existingNodeIndex >= 0) {
      newNodes[existingNodeIndex] = { ...newNodes[existingNodeIndex], status: 'seed' };
    } else {
      newNodes.push({ ...paper, status: 'seed' } as GraphNode);
    }

    const { nodes: sizedNodes, threshold } = calculateSizes(newNodes, graphData.links, get().topNLimit || 20);
    const optimisticEdgeFilter = Math.max(edgeFilter, threshold);

    let optimisticSelectedNode = selectedNode;
    if (selectedNode?.id === paper.id) {
      optimisticSelectedNode = sizedNodes.find(n => n.id === paper.id) || { ...selectedNode, status: 'seed' };
    } else if (selectedNode) {
      optimisticSelectedNode = sizedNodes.find(n => n.id === selectedNode.id) || selectedNode;
    }

    set({
      graphData: {
        nodes: sizedNodes,
        links: graphData.links,
      },
      edgeFilter: optimisticEdgeFilter,
      selectedNode: optimisticSelectedNode,
    });

    try {
      const res = await fetch('/api/collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...paper, status: 'seed', collectionId: activeCollectionId })
      });

      if (!res.ok) {
        throw new Error(`Failed to add seed paper: ${res.status} ${res.statusText}`);
      }
      // We deliberately do not call loadCollectionGraph here,
      // because we already optimistically updated the UI graphData above.
      // Calling loadCollectionGraph replaces the entire nodes array and forces
      // React Force Graph to freeze the main thread resetting the entire physics simulation.
    } catch (error) {
      console.error('Failed to add seed to DB', error);

      // Delta Rollback: inspect current store state to avoid clobbering concurrent operations
      const current = get();

      let rolledBackNodes: GraphNode[];
      if (previousStatus === null) {
        // Paper was newly added; remove ONLY this paper
        rolledBackNodes = current.graphData.nodes
          .filter(n => n.id !== paper.id)
          .map(n => ({ ...n }));
      } else {
        // Paper existed before; revert ONLY this paper's status back to previousStatus
        rolledBackNodes = current.graphData.nodes.map(n =>
          n.id === paper.id ? { ...n, status: previousStatus } : { ...n }
        );
      }

      const { nodes: sizedNodes, threshold } = calculateSizes(
        rolledBackNodes,
        current.graphData.links,
        current.topNLimit || 20
      );

      // Safely update selectedNode without leaking stale references or clobbering concurrent selections
      let rolledBackSelectedNode = current.selectedNode;
      if (current.selectedNode?.id === paper.id) {
        if (previousStatus === null) {
          rolledBackSelectedNode = null;
        } else {
          rolledBackSelectedNode = sizedNodes.find(n => n.id === paper.id) || null;
        }
      } else if (current.selectedNode) {
        rolledBackSelectedNode = sizedNodes.find(n => n.id === current.selectedNode!.id) || current.selectedNode;
      }

      const edgeFilterToRestore = (current.edgeFilter === optimisticEdgeFilter)
        ? previousEdgeFilter
        : current.edgeFilter;

      set({
        graphData: {
          nodes: sizedNodes,
          links: current.graphData.links,
        },
        edgeFilter: Math.max(edgeFilterToRestore, threshold),
        selectedNode: rolledBackSelectedNode,
      });
    }
  },

  removeNode: async (id: string) => {
    const { activeCollectionId, graphData, selectedNode, edgeFilter, focusedNodeId } = get();
    if (!activeCollectionId) return;

    // Record removed node and incident links for targeted delta rollback
    const nodeToRemove = graphData.nodes.find(n => n.id === id);
    const removedNode = nodeToRemove ? { ...nodeToRemove } : null;
    const removedLinks = graphData.links.filter(l => {
      const sourceId = typeof l.source === 'string' ? l.source : (l.source as any).id;
      const targetId = typeof l.target === 'string' ? l.target : (l.target as any).id;
      return sourceId === id || targetId === id;
    });

    const previousEdgeFilter = edgeFilter;
    const previousSelectedNode = selectedNode ? { ...selectedNode } : null;
    const previousFocusedNodeId = focusedNodeId;

    // Optimistically filter out node and any connected links with cloned node objects
    const newNodes = graphData.nodes
      .filter(n => n.id !== id)
      .map(n => ({ ...n }));
    const newLinks = graphData.links.filter(l => {
      const sourceId = typeof l.source === 'string' ? l.source : (l.source as any).id;
      const targetId = typeof l.target === 'string' ? l.target : (l.target as any).id;
      return sourceId !== id && targetId !== id;
    });

    const { nodes: sizedNodes, threshold } = calculateSizes(newNodes, newLinks, get().topNLimit || 20);
    const optimisticEdgeFilter = Math.max(edgeFilter, threshold);

    let optimisticSelectedNode = selectedNode?.id === id ? null : selectedNode;
    if (optimisticSelectedNode) {
      optimisticSelectedNode = sizedNodes.find(n => n.id === optimisticSelectedNode!.id) || optimisticSelectedNode;
    }

    set({ 
      graphData: { nodes: sizedNodes, links: newLinks },
      edgeFilter: optimisticEdgeFilter,
      selectedNode: optimisticSelectedNode,
      focusedNodeId: focusedNodeId === id ? null : focusedNodeId
    });

    try {
      const res = await fetch(`/api/collection/${id}?collectionId=${activeCollectionId}`, {
        method: 'DELETE'
      });

      if (!res.ok) {
        throw new Error(`Failed to remove node from database: ${res.status} ${res.statusText}`);
      }
    } catch (err) {
      console.error('Failed to remove node from database', err);

      // Delta Rollback: inspect current store state to avoid clobbering concurrent operations
      const current = get();

      // Re-insert removed node if not present in current graph
      let rolledBackNodes: GraphNode[] = current.graphData.nodes.map(n => ({ ...n }));
      if (removedNode && !rolledBackNodes.some(n => n.id === id)) {
        rolledBackNodes.push({ ...removedNode });
      }

      // Re-insert incident links if both endpoint nodes exist in rolledBackNodes
      let rolledBackLinks = [...current.graphData.links];
      if (removedLinks.length > 0) {
        const existingLinkKeys = new Set(rolledBackLinks.map(l => {
          const s = typeof l.source === 'string' ? l.source : (l.source as any).id;
          const t = typeof l.target === 'string' ? l.target : (l.target as any).id;
          return `${s}|${t}`;
        }));

        for (const l of removedLinks) {
          const s = typeof l.source === 'string' ? l.source : (l.source as any).id;
          const t = typeof l.target === 'string' ? l.target : (l.target as any).id;
          const sExists = rolledBackNodes.some(n => n.id === s);
          const tExists = rolledBackNodes.some(n => n.id === t);
          if (sExists && tExists && !existingLinkKeys.has(`${s}|${t}`)) {
            rolledBackLinks.push({ source: s, target: t });
            existingLinkKeys.add(`${s}|${t}`);
          }
        }
      }

      const { nodes: sizedNodes, threshold } = calculateSizes(
        rolledBackNodes,
        rolledBackLinks,
        current.topNLimit || 20
      );

      // Safely restore selectedNode if it was cleared and matches id
      let rolledBackSelectedNode = current.selectedNode;
      if (current.selectedNode === null) {
        if (previousSelectedNode && previousSelectedNode.id === id) {
          rolledBackSelectedNode = sizedNodes.find(n => n.id === id) || { ...previousSelectedNode };
        }
      } else {
        rolledBackSelectedNode = sizedNodes.find(n => n.id === current.selectedNode!.id) || current.selectedNode;
      }

      // Safely restore focusedNodeId if it was cleared and matches id
      let rolledBackFocusedNodeId = current.focusedNodeId;
      if (current.focusedNodeId === null && previousFocusedNodeId === id) {
        rolledBackFocusedNodeId = previousFocusedNodeId;
      }

      const edgeFilterToRestore = (current.edgeFilter === optimisticEdgeFilter)
        ? previousEdgeFilter
        : current.edgeFilter;

      set({ 
        graphData: { nodes: sizedNodes, links: rolledBackLinks },
        edgeFilter: Math.max(edgeFilterToRestore, threshold),
        selectedNode: rolledBackSelectedNode,
        focusedNodeId: rolledBackFocusedNodeId
      });
    }
  },
  
  expandNode: async (id: string, type = 'both') => {
    const { activeCollectionId, graphData } = get();
    if (!activeCollectionId) return;

    try {
      const res = await fetch(`/api/expand/${id}?type=${type}&collectionId=${activeCollectionId}`);
      const data = await res.json();
      
      const newNodes = [...graphData.nodes];
      const newLinks = [...graphData.links];
      
      const existingNodeIds = new Set(newNodes.map(n => n.id));
      const existingNodeTitles = new Map(newNodes.filter(n => n.title).map(n => [n.title.toLowerCase(), n.id]));
      const existingLinks = new Set(newLinks.map(l => {
        const s = l.source && typeof l.source === 'object' ? (l.source as any).id : l.source;
        const t = l.target && typeof l.target === 'object' ? (l.target as any).id : l.target;
        return `${s}|${t}`;
      }));

      const addNodesAndLinks = (papers: Paper[], isCitation: boolean) => {
        papers.forEach(p => {
          let targetNodeId = p.id;
          
          if (existingNodeIds.has(p.id)) {
            // exists
          } else if (p.title && existingNodeTitles.has(p.title.toLowerCase())) {
            targetNodeId = existingNodeTitles.get(p.title.toLowerCase())!;
          } else {
            newNodes.push({ ...p, status: 'recommended' } as any);
            existingNodeIds.add(p.id);
            if (p.title) existingNodeTitles.set(p.title.toLowerCase(), p.id);
          }

          const source = isCitation ? targetNodeId : id;
          const target = isCitation ? id : targetNodeId;
          const linkKey = `${source}|${target}`;
          
          if (!existingLinks.has(linkKey)) {
            newLinks.push({ source, target });
            existingLinks.add(linkKey);
          }
        });
      };
      
      if (data.citations) addNodesAndLinks(data.citations, true);
      if (data.references) addNodesAndLinks(data.references, false);
      
      if (newNodes.length > graphData.nodes.length || newLinks.length > graphData.links.length) {
        const isBulk = get().bulkLoading !== null;
        const cachedThreshold = isBulk ? get().edgeFilter : undefined;
        const { nodes: sizedNodes, threshold } = calculateSizes(newNodes, newLinks, get().topNLimit || 20, cachedThreshold);
        set({ graphData: { nodes: sizedNodes, links: newLinks }, edgeFilter: Math.max(get().edgeFilter, threshold) });
      }
    } catch (err) {
      console.error('Failed to expand node', err);
    }
  },

  bulkExpand: async (type: 'citations' | 'references') => {
    const { graphData, expandNode, newlyAddedPapers } = get();
    const existingNewlyAdded = newlyAddedPapers || [];
    const initialNodes = new Set(graphData.nodes.map(n => n.id));
    
    const nodesToExpand = graphData.nodes
      .filter(n => n.status === 'seed' || n.status === 'collection')
      .map(n => n.id);
    
    set({ bulkLoading: { type, current: 0, total: nodesToExpand.length } });
    
    let delay = 1000;
    try {
      const res = await fetch('/api/settings');
      const settings = await res.json();
      if (settings.semanticScholarRateLimit) {
        const rateLimit = parseInt(settings.semanticScholarRateLimit);
        if (rateLimit > 0) {
          delay = 1000 / rateLimit;
        }
      }
    } catch (e) {
      console.error('Failed to get rate limit settings', e);
    }
    
    let newlyAdded: string[] = [...existingNewlyAdded];

    for (let i = 0; i < nodesToExpand.length; i++) {
      set({ bulkLoading: { type, current: i + 1, total: nodesToExpand.length } });
      await expandNode(nodesToExpand[i], type);
      
      const currentNodes = get().graphData.nodes;
      const cleared = get().clearedNewPapers || [];
      const currentNew = currentNodes.map(n => n.id).filter(id => !initialNodes.has(id) && !cleared.includes(id));
      const combinedNew = Array.from(new Set([...existingNewlyAdded, ...currentNew]));

      if (combinedNew.length > newlyAdded.length) {
        newlyAdded = combinedNew;
        set({ newlyAddedPapers: newlyAdded });
      }

      await new Promise(r => setTimeout(r, delay));
    }
    
    set({ 
      bulkLoading: null,
      newlyAddedPapers: newlyAdded.length > 0 ? newlyAdded : null
    });

    const { graphData: finalGraphData, topNLimit } = get();
    const { nodes: sizedNodes, threshold } = calculateSizes(finalGraphData.nodes, finalGraphData.links, topNLimit || 20);
    set({ graphData: { nodes: sizedNodes, links: finalGraphData.links }, edgeFilter: Math.max(get().edgeFilter, threshold) });
  },

  rebuildEdges: async () => {
    const { activeCollectionId, loadCollectionGraph } = get();
    if (!activeCollectionId) return;

    try {
      const res = await fetch(`/api/collection/${activeCollectionId}/rebuild-edges`, {
        method: 'POST'
      });
      if (res.ok) {
        // Refresh collection to load the new edges
        await loadCollectionGraph(activeCollectionId);
      }
    } catch (err) {
      console.error('Failed to rebuild edges', err);
    }
  }
}),
{
    name: 'graph-store',
    partialize: (state) => ({ 
      activeCollectionId: state.activeCollectionId,
      exploreMode: state.exploreMode,
      searchQuery: state.searchQuery,
      searchResults: state.searchResults,
      relatedFilter: state.relatedFilter,
      collectionFilter: state.collectionFilter,
      edgeFilter: state.edgeFilter,
      topNLimit: state.topNLimit,
      newlyAddedPapers: state.newlyAddedPapers,
      tagFilter: state.tagFilter
    }),
  }
));
