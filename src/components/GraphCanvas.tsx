'use client';

import dynamic from 'next/dynamic';
import { useCallback, useRef, useState, useEffect, useMemo } from 'react';
import { useGraphStore, GraphNode } from '@/store/graphStore';
import { formatAuthors, formatAuthorName } from '@/lib/formatters';
import { matchesSearch } from '@/lib/search';

import { forceX, forceY, forceCollide, forceManyBody } from 'd3-force';

// Dynamically import to disable SSR as react-force-graph uses canvas/window
const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false });

export default function GraphCanvas() {
  const fgRef = useRef<any>(null);
  const { graphData, setSelectedNode, selectedNode, relatedFilter, collectionFilter, edgeFilter, topNLimit, focusedNodeId, setFocusedNodeId, exploreMode, tagFilter } = useGraphStore();
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  useEffect(() => {
    // Basic responsive handling
    const updateDimensions = () => {
      setDimensions({
        width: window.innerWidth,
        height: window.innerHeight,
      });
    };
    window.addEventListener('resize', updateDimensions);
    updateDimensions();
    return () => window.removeEventListener('resize', updateDimensions);
  }, []);

  const visibleNodeIds = useMemo(() => {
    let nodes = graphData.nodes;
    let links = graphData.links;

    // Calculate edge counts for all nodes in the current collection graph
    // We now ONLY count edges if the other end of the connection is a collection/seed paper.
    const edgeCounts = new Map<string, number>();
    const nodeIds = new Set(nodes.map(n => n.id));
    const collectionIds = new Set(
      nodes.filter(n => n.status === 'seed' || n.status === 'collection').map(n => n.id)
    );
    
    links.forEach(l => {
      const sourceId = typeof l.source === 'object' ? (l.source as any).id : l.source;
      const targetId = typeof l.target === 'object' ? (l.target as any).id : l.target;
      
      if (nodeIds.has(sourceId) && nodeIds.has(targetId)) {
        if (collectionIds.has(targetId)) {
          edgeCounts.set(sourceId, (edgeCounts.get(sourceId) || 0) + 1);
        }
        if (collectionIds.has(sourceId)) {
          edgeCounts.set(targetId, (edgeCounts.get(targetId) || 0) + 1);
        }
      }
    });

    // Attach edgeCount to nodes and apply edgeFilter
    nodes.forEach((n: any) => {
      n.edgeCount = edgeCounts.get(n.id) || 0;
    });
    
    let visibleIds = new Set(nodes.map(n => n.id));

    // Hidden nodes (abstracted papers)
    for (const node of nodes) {
       if ((node as any).isHidden) {
          visibleIds.delete(node.id);
       }
    }

    // Edge Filter
    for (const node of nodes) {
       if (node.status !== 'seed' && (node as any).edgeCount < edgeFilter) {
          visibleIds.delete(node.id);
       }
    }

    if (focusedNodeId) {
      const connectedIds = new Set<string>();
      connectedIds.add(focusedNodeId);
      links.forEach(l => {
        const sourceId = typeof l.source === 'object' ? (l.source as any).id : l.source;
        const targetId = typeof l.target === 'object' ? (l.target as any).id : l.target;
        if (sourceId === focusedNodeId) connectedIds.add(targetId);
        if (targetId === focusedNodeId) connectedIds.add(sourceId);
      });
      for (const id of visibleIds) {
         if (!connectedIds.has(id)) {
            visibleIds.delete(id);
         }
      }
    }

    if (collectionFilter) {
      for (const n of nodes) {
        if (!visibleIds.has(n.id) || n.status !== 'seed') continue;
        const rawAuthorsStr = Array.isArray(n.authors) ? n.authors.join(', ') : (n.authors || '');
        const formattedAuthorsStr = formatAuthors(n.authors);
        const matches = matchesSearch(collectionFilter, [n.title, rawAuthorsStr, formattedAuthorsStr, n.abstract || '']);
        if (!matches) {
           visibleIds.delete(n.id);
        }
      }
    }

    if (relatedFilter) {
      for (const n of nodes) {
        if (!visibleIds.has(n.id) || n.status === 'seed') continue;
        const rawAuthorsStr = Array.isArray(n.authors) ? n.authors.join(', ') : (n.authors || '');
        const formattedAuthorsStr = formatAuthors(n.authors);
        const matches = matchesSearch(relatedFilter, [n.title, rawAuthorsStr, formattedAuthorsStr, n.abstract || '']);
        if (!matches) {
           visibleIds.delete(n.id);
        }
      }
    }
    if (tagFilter && tagFilter.length > 0) {
      for (const n of nodes) {
        if (!visibleIds.has(n.id)) continue;
        const nodeTags = (n as any).localTags || [];
        if (!tagFilter.every(tid => nodeTags.includes(tid))) {
          visibleIds.delete(n.id);
        }
      }
    }
    
    return visibleIds;
  }, [graphData, relatedFilter, collectionFilter, edgeFilter, focusedNodeId, tagFilter]);

  const scaleData = useMemo(() => {
    if (graphData.nodes.length === 0) return null;
    
    const getTimestamp = (n: any) => {
      let t = 0;
      if (n.publicationDate) {
        t = new Date(n.publicationDate).getTime();
      }
      if (!t || isNaN(t)) t = new Date(`${n.year || 2024}-01-01`).getTime();
      return t;
    };

    const timestamps = graphData.nodes.map(getTimestamp);
    const uniqueTimestamps = Array.from(new Set(timestamps)).sort((a, b) => a - b);
    
    // Logarithmic decay for older outliers (no compression for newer papers)
    const sorted = [...timestamps].sort((a, b) => a - b);
    const q1 = sorted[Math.floor(sorted.length * 0.25)];
    const q3 = sorted[Math.floor(sorted.length * 0.75)];
    const iqr = q3 - q1;
    
    // Use 1.5× IQR fence, with a minimum padding of 2 years
    const twoYears = 2 * 365 * 24 * 60 * 60 * 1000;
    const lowerFence = Math.min(q1, q1 - Math.max(1.5 * iqr, twoYears));
    
    const getMappedTime = (time: number) => {
      if (time >= lowerFence) return time; // Linear for newer papers
      const d = lowerFence - time;
      // Compress the older dates logarithmically
      return lowerFence - twoYears * Math.log(1 + d / twoYears);
    };
    
    let minMapped = getMappedTime(sorted[0]);
    let maxMapped = sorted[sorted.length - 1];
    
    if (minMapped === maxMapped) {
      const oneYear = 365 * 24 * 60 * 60 * 1000;
      minMapped -= oneYear;
      maxMapped += oneYear;
    }
    
    // Add a small padding (5% of range) to give breathing room on edges
    const rangePadding = (maxMapped - minMapped) * 0.05;
    minMapped -= rangePadding;
    maxMapped += rangePadding;

    const paperYearsSet = new Set<number>();
    graphData.nodes.forEach(n => {
      paperYearsSet.add(new Date(getTimestamp(n)).getUTCFullYear());
    });
    const activeYears = Array.from(paperYearsSet).sort((a, b) => a - b);

    return { getTimestamp, getMappedTime, minMapped, maxMapped, activeYears, uniqueTimestamps };
  }, [graphData.nodes]);

  const maxMetrics = useMemo(() => {
    let maxCitations = 1;
    let maxEdges = 1;
    let maxSeedEdges = 1;
    const nodeIds = new Set(graphData.nodes.map(n => n.id));
    
    graphData.nodes.forEach(n => {
       if (n.citationCount && n.citationCount > maxCitations) maxCitations = n.citationCount;
    });
    
    const counts = new Map<string, number>();
    const collectionIds = new Set(
      graphData.nodes.filter(n => n.status === 'seed' || n.status === 'collection').map(n => n.id)
    );
    
    graphData.links.forEach(l => {
       const sid = typeof l.source === 'object' ? l.source.id : l.source;
       const tid = typeof l.target === 'object' ? l.target.id : l.target;
       if (nodeIds.has(sid) && nodeIds.has(tid)) {
         if (collectionIds.has(tid)) counts.set(sid, (counts.get(sid) || 0) + 1);
         if (collectionIds.has(sid)) counts.set(tid, (counts.get(tid) || 0) + 1);
       }
    });
    
    for (const [id, count] of counts.entries()) {
       const node = graphData.nodes.find(n => n.id === id);
       if (node) {
          if (node.status === 'seed' || node.status === 'collection') {
             if (count > maxSeedEdges) maxSeedEdges = count;
          } else {
             if (count > maxEdges) maxEdges = count;
          }
       }
    }
    
    return { maxEdges, maxSeedEdges, maxCitations };
  }, [graphData.nodes, graphData.links]);

  const getNodeSizeFactor = useCallback((node: any) => {
     let isCollectionNode = node.status === 'seed' || node.status === 'collection';
     
     const edges = node.edgeCount || 0;
     const citations = node.citationCount || 0;
     
     // Base size is 2.0 for collection nodes, 1.0 for related papers
     const baseSize = isCollectionNode ? 2.0 : 1.0;
     
     // The maximum possible size relative to the base size
     const MAX_FACTOR = isCollectionNode ? 6.0 : 4.5;
     
     // Normalize edges depending on the type of node so seeds scale against seeds
     const maxEdgesForType = isCollectionNode ? maxMetrics.maxSeedEdges : maxMetrics.maxEdges;
     const edgeRatio = Math.min(1.0, edges / maxEdgesForType);
     
     // Use an exponential (cubic) curve for the edge ratio. 
     const expEdgeRatio = Math.pow(edgeRatio, 3);
     
     // Keep logarithmic for citations as citations can scale into the thousands
     const citationRatio = Math.log10(citations + 1) / Math.log10(maxMetrics.maxCitations + 1);
     
     // Combine the exponential edge ratio and citation ratio
     let combinedRatio = Math.min(1.0, expEdgeRatio + (citationRatio * 0.2));
     
     // Bounded exponential scaling
     let factor = baseSize + (combinedRatio * (MAX_FACTOR - baseSize));
     
     return factor;
   }, [maxMetrics]);

  useEffect(() => {
    if (fgRef.current && scaleData) {
      const { getTimestamp, getMappedTime, minMapped, maxMapped, uniqueTimestamps } = scaleData;
      const width = Math.max(dimensions.width, 1000);
      // Widen the timeline to give our new massive nodes room to breathe
      const graphWidth = width * 3.0;
      
      const timeToX = (time: number) => {
        const mapped = getMappedTime(time);
        const normalized = (mapped - minMapped) / (maxMapped - minMapped);
        return (normalized - 0.5) * graphWidth;
      };
      
      const nodeMap = new Map(graphData.nodes.map(n => [n.id, n]));
      
      // Keep the physics engine active for Y-axis clustering!
      // We only fix the X-axis (time), and let D3 naturally cluster connected nodes on the Y-axis.
      if (fgRef.current) {
        // Adjust charge to prevent too much overlap and push nodes apart
        const chargeForce = fgRef.current.d3Force('charge');
        if (chargeForce) {
          chargeForce.strength(-1500); // Massive repelling force to spread the graph wide
        }
        
        // Add tensile strength to edges so connected nodes stay tightly bound despite the strong repulsion
        const linkForce = fgRef.current.d3Force('link');
        if (linkForce) {
          linkForce.distance((link: any) => {
            const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
            const targetId = typeof link.target === 'object' ? link.target.id : link.target;
            const sourceObj = nodeMap.get(sourceId);
            const targetObj = nodeMap.get(targetId);
            
            const r1 = sourceObj ? 20 * getNodeSizeFactor(sourceObj) : 20;
            const r2 = targetObj ? 20 * getNodeSizeFactor(targetObj) : 20;
            const minDistance = r1 + r2 + 30; // 30px padding between the edges of the nodes
            
            const isSourceCollection = sourceObj?.status === 'seed' || sourceObj?.status === 'collection';
            const isTargetCollection = targetObj?.status === 'seed' || targetObj?.status === 'collection';
            
            if (isSourceCollection && isTargetCollection) return Math.max(minDistance, 40); // Tier 1: Very tight
            if (isSourceCollection || isTargetCollection) return Math.max(minDistance, 80); // Tier 2: Medium
            return Math.max(minDistance, 120); // Tier 3: Loose
          });
          
          linkForce.strength((link: any) => {
            const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
            const targetId = typeof link.target === 'object' ? link.target.id : link.target;
            const sourceObj = nodeMap.get(sourceId);
            const targetObj = nodeMap.get(targetId);
            
            const isSourceCollection = sourceObj?.status === 'seed' || sourceObj?.status === 'collection';
            const isTargetCollection = targetObj?.status === 'seed' || targetObj?.status === 'collection';
            
            if (isSourceCollection && isTargetCollection) return 1.5; // Tier 1: Very strong pull
            if (isSourceCollection || isTargetCollection) return 0.8; // Tier 2: Medium pull
            return 0.1; // Tier 3: Weakest pull
          });
        }
        
        // Revert back to strict fx locking, no forceX used
        
        // Add a collision force so nodes don't overlap
        fgRef.current.d3Force('collide', forceCollide().radius((n: any) => {
          const factor = getNodeSizeFactor(n);
          // Collision radius must exactly match the drawn radius (20 * factor) + a larger gap
          return (20 * factor) + 50; // +50 for a massive clear gap between clusters
        }).iterations(3));
        
        // Add a gentle gravitational pull towards the center (Y=0) so clusters don't float away infinitely
        fgRef.current.d3Force('y', forceY(0).strength(0.05));
      }
      
      const nodesWithX = graphData.nodes.map((node: any) => ({
         node,
         targetX: timeToX(getTimestamp(node))
      }));
      
      // Sort nodes by time to apply a barycenter heuristic for initial Y placement
      nodesWithX.sort((a, b) => a.targetX - b.targetX);
      
      let nextYOffset = 0;
      
      nodesWithX.forEach(({ node, targetX }, index) => {
         node.targetX = targetX;
         node.fx = targetX;
         // Un-fix Y so physics engine can cluster them, unless user manually dragged it
         if (node.fy !== undefined && !node.userFixedY) {
             delete node.fy;
         }
         
         // Only initialize Y if it hasn't been set yet
         if (node.y === undefined) {
             // Find all edges to nodes that ALREADY have a Y coordinate
             const connectedYs: number[] = [];
             graphData.links.forEach((link: any) => {
                 const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
                 const targetId = typeof link.target === 'object' ? link.target.id : link.target;
                 
                 if (sourceId === node.id) {
                     const targetObj = nodeMap.get(targetId);
                     if (targetObj && targetObj.y !== undefined) connectedYs.push(targetObj.y);
                 } else if (targetId === node.id) {
                     const sourceObj = nodeMap.get(sourceId);
                     if (sourceObj && sourceObj.y !== undefined) connectedYs.push(sourceObj.y);
                 }
             });
             
             if (connectedYs.length > 0) {
                 // Average the Y position of connected nodes to minimize crossings
                 const avgY = connectedYs.reduce((sum, y) => sum + y, 0) / connectedYs.length;
                 // Add a tiny deterministic stagger to prevent perfect overlap
                 node.y = avgY + ((index % 2 === 0 ? 1 : -1) * 10);
             } else {
                 // No connections yet, place in an alternating pattern near center
                 node.y = nextYOffset;
                 nextYOffset = nextYOffset >= 0 ? -nextYOffset - 30 : -nextYOffset + 30;
             }
         }
      });

      // We need to reheat the simulation because we're using physics for Y-axis
      fgRef.current.d3ReheatSimulation();
    }
  }, [scaleData, graphData.links, dimensions.width, dimensions.height]);

  const handleNodeClick = useCallback(
    (node: GraphNode) => {
      setSelectedNode(node);
      if (fgRef.current) {
        fgRef.current.centerAt(node.x, node.y, 1000);
      }
    },
    [setSelectedNode]
  );
  
  const drawAxis = useCallback((ctx: CanvasRenderingContext2D, globalScale: number) => {
    if (!fgRef.current || !scaleData) return;
    
    const { getMappedTime, minMapped, maxMapped, activeYears } = scaleData;
    const center = fgRef.current.centerAt();
    if (!center) return;
    
    const viewBottomY = center.y + (dimensions.height / 2) / globalScale;
    const viewLeftX = center.x - (dimensions.width / 2) / globalScale;
    const viewRightX = center.x + (dimensions.width / 2) / globalScale;
    
    const graphWidth = Math.max(dimensions.width, 1000) * 3.0;
    
    ctx.beginPath();
    ctx.moveTo(viewLeftX, viewBottomY - 40 / globalScale);
    ctx.lineTo(viewRightX, viewBottomY - 40 / globalScale);
    ctx.strokeStyle = 'rgba(255, 255, 255, 1)'; 
    ctx.lineWidth = 2 / globalScale; 
    ctx.stroke();
    
    let lastDrawnX = -Infinity;
    
    activeYears.forEach(year => {
      const time = Date.UTC(year, 0, 1);
      const mapped = getMappedTime(time);
      const normalized = (mapped - minMapped) / (maxMapped - minMapped);
      const graphX = (normalized - 0.5) * graphWidth;
      
      // Draw year tick
      if (graphX > viewLeftX && graphX < viewRightX) {
        if (graphX > lastDrawnX + 40 / globalScale) {
          ctx.beginPath();
          ctx.moveTo(graphX, viewBottomY - 40 / globalScale);
          ctx.lineTo(graphX, viewBottomY - 30 / globalScale);
          ctx.strokeStyle = 'rgba(255, 255, 255, 1)';
          ctx.lineWidth = 2 / globalScale;
          ctx.stroke();
          
          ctx.fillStyle = 'rgba(255, 255, 255, 1)';
          ctx.font = `600 ${12 / globalScale}px Inter, sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillText(year.toString(), graphX, viewBottomY - 15 / globalScale);
          lastDrawnX = graphX;
        }
      }
      
      // Draw months if spaced out enough
      const nextYearTime = Date.UTC(year + 1, 0, 1);
      const nextYearMapped = getMappedTime(nextYearTime);
      const nextYearNormalized = (nextYearMapped - minMapped) / (maxMapped - minMapped);
      const nextYearX = (nextYearNormalized - 0.5) * graphWidth;
      
      const pxPerMonth = (nextYearX - graphX) * globalScale / 12;
      
      if (pxPerMonth > 30) {
        for (let month = 1; month < 12; month++) {
          const mTime = Date.UTC(year, month, 1);
          const mMapped = getMappedTime(mTime);
          const mNorm = (mMapped - minMapped) / (maxMapped - minMapped);
          const mX = (mNorm - 0.5) * graphWidth;
          
          if (mX > viewLeftX && mX < viewRightX) {
             ctx.beginPath();
             ctx.moveTo(mX, viewBottomY - 40 / globalScale);
             ctx.lineTo(mX, viewBottomY - 35 / globalScale);
             ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
             ctx.lineWidth = 1 / globalScale;
             ctx.stroke();
             
             if (pxPerMonth > 45) {
                ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
                ctx.font = `400 ${10 / globalScale}px Inter, sans-serif`;
                ctx.textAlign = 'center';
                ctx.fillText((month + 1).toString(), mX, viewBottomY - 22 / globalScale);
             }
          }
        }
      }
    });
  }, [dimensions.width, dimensions.height, scaleData]);
  useEffect(() => {
    if (fgRef.current) {
      // Minor zoom change to force re-evaluation of linkVisibility
      const z = fgRef.current.zoom();
      fgRef.current.zoom(z + 0.00001);
      setTimeout(() => {
        if (fgRef.current) fgRef.current.zoom(z);
      }, 0);
    }
  }, [exploreMode]);

  const simulationGraphData = useMemo(() => {
    const simNodes = graphData.nodes.filter(n => !(n as any).isHidden);
    const simNodeIds = new Set(simNodes.map(n => n.id));
    const simLinks = graphData.links.filter(l => {
        const sourceId = typeof l.source === 'object' ? (l.source as any).id : l.source;
        const targetId = typeof l.target === 'object' ? (l.target as any).id : l.target;
        return simNodeIds.has(sourceId) && simNodeIds.has(targetId);
    });
    return { nodes: simNodes, links: simLinks };
  }, [graphData.nodes, graphData.links, topNLimit]);

  const nodeMap = useMemo(() => new Map<string, any>(graphData.nodes.map(n => [n.id, n])), [graphData.nodes]);

  return (
    <div style={{ width: '100vw', height: '100vh', background: 'var(--bg-base)' }}>
      <ForceGraph2D
        ref={fgRef}
        graphData={simulationGraphData}
        nodeVisibility={(node: any) => visibleNodeIds.has(node.id)}
        linkVisibility={(link: any) => {
          const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
          const targetId = typeof link.target === 'object' ? link.target.id : link.target;
          if (!visibleNodeIds.has(sourceId) || !visibleNodeIds.has(targetId)) return false;

          if (!exploreMode) {
            const sourceObj = typeof link.source === 'object' ? link.source : nodeMap.get(link.source);
            const targetObj = typeof link.target === 'object' ? link.target : nodeMap.get(link.target);
            const isSourceCollection = sourceObj?.status === 'seed' || sourceObj?.status === 'collection';
            const isTargetCollection = targetObj?.status === 'seed' || targetObj?.status === 'collection';
            
            if (!isSourceCollection && !isTargetCollection) {
              return false;
            }
          }

          return true;
        }}
        onNodeDrag={(node: any) => {
           const isCore = node.status === 'seed' || node.status === 'collection';
           if (!isCore) {
               // If not a core node, unfix Y so the physics engine pulls it back
               delete node.fy;
           }
           // We do NOT lock X-axis here, so the node visually follows the mouse!
           // This prevents the mouse from slipping off the hit area and cancelling the drag.
        }}
        onNodeDragEnd={(node: any) => {
           node.x = node.targetX;
           node.fx = node.targetX;
           
           const isCore = node.status === 'seed' || node.status === 'collection';
           if (isCore) {
               // Permanently fix Y for core nodes
               node.fy = node.y;
               node.userFixedY = true;
           } else {
               // Let non-core nodes snap back to their clustered position
               delete node.fy;
               node.userFixedY = false;
           }
        }}
        width={dimensions.width}
        height={dimensions.height}
        nodeLabel="title"
        onRenderFramePre={(ctx, globalScale) => {
          const titleOpacity = Math.min(1, Math.max(0, (globalScale - 0.6) * 2));
          if (titleOpacity > 0) {
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = `rgba(148, 163, 184, ${titleOpacity})`;
            
            graphData.nodes.forEach((node: any) => {
              if (!visibleNodeIds.has(node.id)) return;
              if (node.x === undefined || node.y === undefined) return;
              
              const sizeFactor = getNodeSizeFactor(node);
              const radius = 20 * sizeFactor;
              const titleFontSize = (8 + 3 * sizeFactor) / globalScale;
              ctx.font = `500 ${titleFontSize}px Inter, sans-serif`;
              
              let title = node.title || 'Unknown Paper';
              if (title.length > 40) title = title.substring(0, 37) + '...';
              
              ctx.fillText(title, node.x, node.y + radius + (12 * sizeFactor) / globalScale);
            });
          }
        }}
        nodeCanvasObjectMode={() => 'replace'}
        nodeCanvasObject={(node: any, ctx, globalScale) => {
          const sizeFactor = getNodeSizeFactor(node);
          
          // Radius in graph coordinates (perfectly matches collision force logic)
          // No dynamic zoom-based inflation, so they never overlap regardless of zoom level!
          const radius = 20 * sizeFactor;
          
          ctx.beginPath();
          ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI, false);
          
          // Determine original inner color
          if (node.status === 'seed') {
            ctx.fillStyle = '#f59e0b';
          } else if (node.status === 'collection') {
            ctx.fillStyle = '#10b981';
          } else {
            ctx.fillStyle = '#3b82f6';
          }
          
          // Add glow effect if selected
          if (selectedNode && node.id === selectedNode.id) {
            ctx.shadowColor = '#ec4899';
            ctx.shadowBlur = 10 / globalScale;
          } else {
            ctx.shadowBlur = 0;
          }
          
          // Fill inner circle
          ctx.fill();
          
          // Draw pink perimeter border if selected
          if (selectedNode && node.id === selectedNode.id) {
            ctx.lineWidth = 4 / globalScale;
            ctx.strokeStyle = '#ec4899';
            ctx.stroke();
          } else if (useGraphStore.getState().newlyAddedPapers?.includes(node.id)) {
            ctx.lineWidth = 3 / globalScale;
            ctx.strokeStyle = '#10b981';
            ctx.stroke();
          }
          
          ctx.shadowBlur = 0;
          
          let lastName = '';
          if (node.authors) {
            let firstAuthorName = '';
            let authorsList: any[] = [];
            if (Array.isArray(node.authors)) {
              authorsList = node.authors;
            } else if (typeof node.authors === 'string') {
              try { authorsList = JSON.parse(node.authors); } catch(e) {
                firstAuthorName = node.authors.split(',')[0].trim();
              }
            }
            if (!firstAuthorName && authorsList.length > 0 && authorsList[0]) {
              const entry = authorsList[0];
              firstAuthorName = typeof entry === 'string' ? entry : (entry.name || '');
            }
            if (firstAuthorName) {
              lastName = formatAuthorName(firstAuthorName);
            }
          }
          if (lastName) {
             let fontSize = radius * 0.6;
             if (fontSize * globalScale > 16) fontSize = 16 / globalScale;
             
             if (fontSize * globalScale >= 4) {
               ctx.font = `800 ${fontSize}px Inter, sans-serif`;
               ctx.textAlign = 'center';
               ctx.textBaseline = 'middle';
               ctx.fillStyle = '#ffffff'; 
               
               if (lastName.length > 10) lastName = lastName.slice(0, 8) + '..';
               ctx.fillText(lastName, node.x, node.y);
             }
          }
        }}
        nodePointerAreaPaint={(node: any, color: string, ctx: any, globalScale: number) => {
          const sizeFactor = getNodeSizeFactor(node);
          const radius = 20 * sizeFactor; // Raise cap to 300 so highly connected nodes can actually grow
          
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI, false);
          ctx.fill();
        }}
        linkColor={(link: any) => {
          const sourceObj = typeof link.source === 'object' ? link.source : nodeMap.get(link.source);
          const targetObj = typeof link.target === 'object' ? link.target : nodeMap.get(link.target);
          
          if (selectedNode) {
            if (sourceObj?.id === selectedNode.id) return '#ec4899'; // Pink – selected paper references the other
            if (targetObj?.id === selectedNode.id) return '#34d399'; // Green – the other paper cites the selected
            return '#1e293b'; // Fade out others when something is selected
          }
          
          const isSourceCollection = sourceObj?.status === 'seed' || sourceObj?.status === 'collection';
          const isTargetCollection = targetObj?.status === 'seed' || targetObj?.status === 'collection';

          if (isSourceCollection && isTargetCollection) {
            return 'rgba(250, 204, 21, 0.9)'; // Bright Gold for Tier 1 (Collection <-> Collection)
          }
          
          if (sourceObj?.status === 'seed' || targetObj?.status === 'seed') {
            return 'rgba(245, 158, 11, 0.6)'; // Tier 2: Orange if attached to a seed
          }
          if (sourceObj?.status === 'collection' || targetObj?.status === 'collection') {
            return 'rgba(16, 185, 129, 0.6)'; // Tier 2: Green if attached to a collection paper
          }
          
          return '#3d4451'; // Tier 3: Default thin slate gray
        }}
        linkWidth={(link: any) => {
          const sourceObj = typeof link.source === 'object' ? link.source : nodeMap.get(link.source);
          const targetObj = typeof link.target === 'object' ? link.target : nodeMap.get(link.target);
          
          if (selectedNode) {
            if (sourceObj?.id === selectedNode.id || targetObj?.id === selectedNode.id) return 2.5;
            return 0.5; // Thin out other lines
          }
          
          const isSourceCollection = sourceObj?.status === 'seed' || sourceObj?.status === 'collection';
          const isTargetCollection = targetObj?.status === 'seed' || targetObj?.status === 'collection';

          if (isSourceCollection && isTargetCollection) {
            return 3.5; // Tier 1: Thickest
          }
          
          if (isSourceCollection || isTargetCollection) {
            return 1.8; // Tier 2: Middle
          }
          
          return 0.8; // Tier 3: Thin
        }}
        onNodeClick={(node: any) => handleNodeClick(node as GraphNode)}
        onNodeRightClick={(node: any) => {
          if (focusedNodeId === node.id) {
            setFocusedNodeId(null);
          } else {
            setFocusedNodeId(node.id);
          }
        }}
        enableNodeDrag={true}
        enableZoomInteraction={true}
        onRenderFramePost={(ctx: any, globalScale: any) => {
          drawAxis(ctx, globalScale);
        }}
      />
      
      {focusedNodeId && (
        <button
          onClick={() => setFocusedNodeId(null)}
          className="glass-panel"
          style={{
            position: 'absolute',
            top: '1rem',
            left: '50%',
            transform: 'translateX(-50%)',
            padding: '0.75rem 1.5rem',
            borderRadius: 'var(--radius-full)',
            background: 'var(--accent-primary)',
            color: '#fff',
            fontWeight: 600,
            border: 'none',
            cursor: 'pointer',
            zIndex: 50,
            boxShadow: '0 4px 12px rgba(236, 72, 153, 0.3)'
          }}
        >
          Undo Focus
        </button>
      )}
    </div>
  );
}
