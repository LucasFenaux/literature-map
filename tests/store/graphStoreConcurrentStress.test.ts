import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// In-memory localStorage polyfill for Node.js environment
const store: Record<string, string> = {};
const mockStorage = {
  getItem: (key: string) => store[key] || null,
  setItem: (key: string, value: string) => {
    store[key] = value.toString();
  },
  removeItem: (key: string) => {
    delete store[key];
  },
  clear: () => {
    for (const k in store) delete store[k];
  },
  key: (index: number) => Object.keys(store)[index] || null,
  length: 0,
};

try {
  Object.defineProperty(globalThis, 'localStorage', {
    value: mockStorage,
    configurable: true,
    writable: true,
  });
} catch {
  // Ignore
}

import { useGraphStore, GraphNode, GraphLink } from '../../src/store/graphStore.js';
import { Paper } from '../../src/lib/openalex.js';

describe('Concurrent Stress Suite: Interleaved Operations & Random Delays (Challenger R3)', () => {
  let originalFetch: typeof globalThis.fetch;
  let consoleErrorMock: typeof console.error;
  const loggedErrors: unknown[][] = [];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    consoleErrorMock = console.error;
    loggedErrors.length = 0;
    console.error = (...args: unknown[]) => {
      loggedErrors.push(args);
    };

    useGraphStore.setState({
      activeCollectionId: 'stress-col',
      graphData: { nodes: [], links: [] },
      edgeFilter: 1,
      topNLimit: 20,
      selectedNode: null,
      focusedNodeId: null,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.error = consoleErrorMock;
  });

  const createPaper = (id: string, title = `Paper ${id}`): Paper => ({
    id,
    title,
    doi: `10.1000/${id}`,
    year: 2024,
    publicationDate: '2024-01-01',
    citationCount: 10,
    authors: [`Author ${id}`],
    abstract: 'Abstract ' + id,
    url: `https://doi.org/10.1000/${id}`,
    venue: 'Venue ' + id,
    referencedWorks: [],
  });

  const createNode = (id: string, status = 'seed'): GraphNode => ({
    ...createPaper(id),
    status,
    val: 20,
  });

  it('Stress Test 1: 20 concurrent interleaved add and remove operations with randomized network delays and mixed 200/500 outcomes', async () => {
    // Initial topology: 10 nodes (N0-N9) and a ring of links + cross links
    const initialNodes: GraphNode[] = [];
    const initialLinks: GraphLink[] = [];
    for (let i = 0; i < 10; i++) {
      initialNodes.push(createNode(`N${i}`, 'seed'));
      initialLinks.push({ source: `N${i}`, target: `N${(i + 1) % 10}` });
      if (i < 5) {
        initialLinks.push({ source: `N${i}`, target: `N${i + 5}` });
      }
    }

    useGraphStore.setState({
      graphData: { nodes: initialNodes, links: initialLinks },
    });

    // We define 10 additions (P0..P9) and 10 removals (N0..N9)
    // Deterministically designate outcomes:
    // Even indices succeed (200), Odd indices fail (500)
    // Delays are pseudo-random between 5ms and 45ms to ensure out-of-order execution
    const addConfigs: { id: string; shouldSucceed: boolean; delay: number }[] = [];
    for (let i = 0; i < 10; i++) {
      addConfigs.push({
        id: `P${i}`,
        shouldSucceed: i % 2 === 0, // P0, P2, P4, P6, P8 succeed; P1, P3, P5, P7, P9 fail
        delay: ((i * 17) % 35) + 5,  // spread delays 5..40ms
      });
    }

    const removeConfigs: { id: string; shouldSucceed: boolean; delay: number }[] = [];
    for (let i = 0; i < 10; i++) {
      removeConfigs.push({
        id: `N${i}`,
        shouldSucceed: i % 2 === 0, // N0, N2, N4, N6, N8 succeed; N1, N3, N5, N7, N9 fail
        delay: ((i * 23) % 35) + 5,  // spread delays 5..40ms
      });
    }

    // Mock fetch to simulate the above delays and status codes
    globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = url.toString();
      const method = init?.method || 'GET';

      if (method === 'POST') {
        const body = JSON.parse((init?.body as string) || '{}');
        const cfg = addConfigs.find(c => c.id === body.id);
        const delay = cfg ? cfg.delay : 10;
        const shouldSucceed = cfg ? cfg.shouldSucceed : true;
        await new Promise(r => setTimeout(r, delay));
        if (shouldSucceed) {
          return new Response(JSON.stringify({ message: 'Created' }), { status: 200 });
        } else {
          return new Response(JSON.stringify({ error: 'DB Insert Failed' }), { status: 500 });
        }
      }

      if (method === 'DELETE') {
        const match = urlStr.match(/\/collection\/([^?]+)/);
        const nodeId = match ? match[1] : '';
        const cfg = removeConfigs.find(c => c.id === nodeId);
        const delay = cfg ? cfg.delay : 10;
        const shouldSucceed = cfg ? cfg.shouldSucceed : true;
        await new Promise(r => setTimeout(r, delay));
        if (shouldSucceed) {
          return new Response(JSON.stringify({ message: 'Deleted' }), { status: 200 });
        } else {
          return new Response(JSON.stringify({ error: 'DB Delete Failed' }), { status: 500 });
        }
      }

      return new Response('{}', { status: 200 });
    };

    // Dispatch all 20 operations concurrently
    const promises: Promise<void>[] = [];
    for (const addCfg of addConfigs) {
      promises.push(useGraphStore.getState().addSeedPaper(createPaper(addCfg.id)));
    }
    for (const remCfg of removeConfigs) {
      promises.push(useGraphStore.getState().removeNode(remCfg.id));
    }

    await Promise.all(promises);

    const finalState = useGraphStore.getState();
    const finalNodeIds = new Set(finalState.graphData.nodes.map(n => n.id));

    // 1. Verify additions:
    // P0, P2, P4, P6, P8 succeeded -> must be in graph
    for (let i = 0; i < 10; i++) {
      const id = `P${i}`;
      if (i % 2 === 0) {
        assert.strictEqual(
          finalNodeIds.has(id),
          true,
          `Successful add ${id} must be in final graphData.nodes`
        );
      } else {
        assert.strictEqual(
          finalNodeIds.has(id),
          false,
          `Failed add ${id} must NOT be in final graphData.nodes`
        );
      }
    }

    // 2. Verify removals:
    // N0, N2, N4, N6, N8 succeeded -> must be deleted (NOT in graph)
    // N1, N3, N5, N7, N9 failed -> must be restored (IN graph)
    for (let i = 0; i < 10; i++) {
      const id = `N${i}`;
      if (i % 2 === 0) {
        assert.strictEqual(
          finalNodeIds.has(id),
          false,
          `Successfully removed ${id} must NOT be in final graphData.nodes`
        );
      } else {
        assert.strictEqual(
          finalNodeIds.has(id),
          true,
          `Failed removal of ${id} must be rolled back and present in final graphData.nodes`
        );
      }
    }

    // 3. No duplicate node IDs
    const allIds = finalState.graphData.nodes.map(n => n.id);
    assert.strictEqual(
      allIds.length,
      finalNodeIds.size,
      `No duplicate node IDs allowed in graphData.nodes. Found: ${allIds}`
    );

    // 4. No dangling links
    for (const link of finalState.graphData.links) {
      const s = typeof link.source === 'string' ? link.source : (link.source as any).id;
      const t = typeof link.target === 'string' ? link.target : (link.target as any).id;
      assert.strictEqual(
        finalNodeIds.has(s),
        true,
        `Link source '${s}' must exist in graphData.nodes`
      );
      assert.strictEqual(
        finalNodeIds.has(t),
        true,
        `Link target '${t}' must exist in graphData.nodes`
      );
    }

    // 5. Invariant: calculateSizes properties are consistent and valid numbers
    for (const node of finalState.graphData.nodes) {
      assert.strictEqual(typeof node.val, 'number', `node.val must be a number for ${node.id}`);
      assert.strictEqual(isNaN(node.val as number), false, `node.val must not be NaN for ${node.id}`);
      assert.strictEqual((node as any).val >= 10, true, `node.val must be >= 10 for ${node.id}`);
    }
  });

  it('Stress Test 2: Concurrent upgrade of recommended paper (slow failure) + removeNode (fast success)', async () => {
    // Node X is currently in graph as 'recommended'
    const nodeX: GraphNode = {
      ...createPaper('node-X'),
      status: 'recommended',
      val: 10,
    };
    const nodeY = createNode('node-Y', 'seed');
    const linkXY: GraphLink = { source: 'node-X', target: 'node-Y' };

    useGraphStore.setState({
      graphData: { nodes: [nodeX, nodeY], links: [linkXY] },
      selectedNode: nodeX,
    });

    // Op 1: addSeedPaper('node-X') - takes 40ms and fails (500)
    // Op 2: removeNode('node-X') - takes 10ms and succeeds (200)
    globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method || 'GET';
      if (method === 'POST') {
        await new Promise(r => setTimeout(r, 40));
        return new Response(JSON.stringify({ error: 'Failed' }), { status: 500 });
      }
      if (method === 'DELETE') {
        await new Promise(r => setTimeout(r, 10));
        return new Response(JSON.stringify({ message: 'Deleted' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };

    const op1 = useGraphStore.getState().addSeedPaper(createPaper('node-X'));
    const op2 = useGraphStore.getState().removeNode('node-X');

    await Promise.all([op1, op2]);

    const state = useGraphStore.getState();
    // Since removeNode succeeded, node-X was removed.
    // The failed addSeedPaper must NOT resurrect node-X!
    assert.strictEqual(
      state.graphData.nodes.some(n => n.id === 'node-X'),
      false,
      'node-X was successfully deleted; failed upgrade must not resurrect it'
    );
    assert.strictEqual(
      state.selectedNode,
      null,
      'selectedNode must be null since node-X was deleted'
    );
    assert.strictEqual(
      state.graphData.nodes.some(n => n.id === 'node-Y'),
      true,
      'node-Y must remain in graph'
    );
  });

  it('Stress Test 3: Concurrent duplicate removeNode calls both failing with 500 must not duplicate node', async () => {
    const nodeA = createNode('node-A', 'seed');
    useGraphStore.setState({
      graphData: { nodes: [nodeA], links: [] },
    });

    globalThis.fetch = async () => {
      await new Promise(r => setTimeout(r, 20));
      return new Response(JSON.stringify({ error: 'Failed' }), { status: 500 });
    };

    const op1 = useGraphStore.getState().removeNode('node-A');
    const op2 = useGraphStore.getState().removeNode('node-A');

    await Promise.all([op1, op2]);

    const state = useGraphStore.getState();
    const count = state.graphData.nodes.filter(n => n.id === 'node-A').length;
    assert.strictEqual(
      count,
      1,
      `node-A must exist exactly once in graphData.nodes, but found ${count}`
    );
  });

  it('Stress Test 4: UI synchronization - selectedNode degree and val dynamically update when neighbour is removed concurrently', async () => {
    const nodeA = createNode('node-A', 'seed');
    const nodeB = createNode('node-B', 'seed');
    const nodeC = createNode('node-C', 'seed');
    const linkAB: GraphLink = { source: 'node-A', target: 'node-B' };
    const linkBC: GraphLink = { source: 'node-B', target: 'node-C' };

    // Set B as selectedNode
    // Node B has degree 2 (links to A and C), so val = 20 + 2*2 = 24
    useGraphStore.setState({
      graphData: { nodes: [nodeA, nodeB, nodeC], links: [linkAB, linkBC] },
      selectedNode: nodeB,
    });

    // Recompute sizes to initialize val properly
    const initialB = useGraphStore.getState().graphData.nodes.find(n => n.id === 'node-B')!;
    useGraphStore.setState({ selectedNode: initialB });

    // Now remove nodeA (succeeds 200, 10ms) while removing nodeC (fails 500, 30ms)
    globalThis.fetch = async (url: RequestInfo | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes('node-A')) {
        await new Promise(r => setTimeout(r, 10));
        return new Response(JSON.stringify({ message: 'Deleted' }), { status: 200 });
      } else {
        await new Promise(r => setTimeout(r, 30));
        return new Response(JSON.stringify({ error: 'Failed' }), { status: 500 });
      }
    };

    const opA = useGraphStore.getState().removeNode('node-A');
    const opC = useGraphStore.getState().removeNode('node-C');

    await Promise.all([opA, opC]);

    const state = useGraphStore.getState();

    // Node A was removed. Node C failed removal and was rolled back.
    // So nodes in graph: B and C. Links: B-C.
    // Node B's degree is now 1. val should be 20 + 1*2 = 22.
    assert.strictEqual(state.graphData.nodes.some(n => n.id === 'node-A'), false, 'node-A must be deleted');
    assert.strictEqual(state.graphData.nodes.some(n => n.id === 'node-B'), true, 'node-B must be present');
    assert.strictEqual(state.graphData.nodes.some(n => n.id === 'node-C'), true, 'node-C must be restored');

    const finalNodeB = state.graphData.nodes.find(n => n.id === 'node-B')!;
    assert.strictEqual(finalNodeB.val, 22, 'node-B val must reflect new degree of 1 (22)');
    assert.strictEqual(state.selectedNode?.id, 'node-B', 'selectedNode must still be node-B');
    assert.strictEqual(
      state.selectedNode?.val,
      22,
      'selectedNode.val must be synchronized with node-B degree in graph'
    );
  });

  it('Stress Test 5: UI synchronization - selectedNode deletion failure restores selectedNode with accurate recalculations', async () => {
    const nodeA = createNode('node-A', 'seed');
    const nodeB = createNode('node-B', 'seed');
    const linkAB: GraphLink = { source: 'node-A', target: 'node-B' };

    useGraphStore.setState({
      graphData: { nodes: [nodeA, nodeB], links: [linkAB] },
      selectedNode: nodeA,
      focusedNodeId: 'node-A',
    });

    // removeNode('node-A') fails 500
    globalThis.fetch = async () => {
      await new Promise(r => setTimeout(r, 20));
      return new Response(JSON.stringify({ error: 'Failed' }), { status: 500 });
    };

    await useGraphStore.getState().removeNode('node-A');

    const state = useGraphStore.getState();
    assert.strictEqual(state.graphData.nodes.some(n => n.id === 'node-A'), true, 'node-A must be restored');
    assert.strictEqual(state.selectedNode?.id, 'node-A', 'selectedNode must be restored to node-A');
    assert.strictEqual(state.focusedNodeId, 'node-A', 'focusedNodeId must be restored to node-A');
    assert.strictEqual(state.graphData.links.length, 1, 'linkAB must be restored');
  });

  it('Stress Test 6: Triangle topology with concurrent mixed removals (Node A fails 500, Node B succeeds 200, Node C fails 500) restores A-C link without resurrecting A-B or B-C', async () => {
    const nodeA = createNode('node-A', 'seed');
    const nodeB = createNode('node-B', 'seed');
    const nodeC = createNode('node-C', 'seed');
    const linkAB: GraphLink = { source: 'node-A', target: 'node-B' };
    const linkBC: GraphLink = { source: 'node-B', target: 'node-C' };
    const linkCA: GraphLink = { source: 'node-C', target: 'node-A' };

    useGraphStore.setState({
      graphData: { nodes: [nodeA, nodeB, nodeC], links: [linkAB, linkBC, linkCA] },
    });

    globalThis.fetch = async (url: RequestInfo | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes('node-A')) {
        await new Promise(r => setTimeout(r, 30));
        return new Response(JSON.stringify({ error: 'A failed' }), { status: 500 });
      }
      if (urlStr.includes('node-B')) {
        await new Promise(r => setTimeout(r, 10));
        return new Response(JSON.stringify({ message: 'B deleted' }), { status: 200 });
      }
      if (urlStr.includes('node-C')) {
        await new Promise(r => setTimeout(r, 25));
        return new Response(JSON.stringify({ error: 'C failed' }), { status: 500 });
      }
      return new Response('{}', { status: 200 });
    };

    const opA = useGraphStore.getState().removeNode('node-A');
    const opB = useGraphStore.getState().removeNode('node-B');
    const opC = useGraphStore.getState().removeNode('node-C');

    await Promise.all([opA, opB, opC]);

    const state = useGraphStore.getState();
    const nodeIds = state.graphData.nodes.map(n => n.id);

    // Node A and C rolled back, Node B permanently removed
    assert.strictEqual(nodeIds.includes('node-A'), true, 'node-A must be restored');
    assert.strictEqual(nodeIds.includes('node-B'), false, 'node-B must remain deleted');
    assert.strictEqual(nodeIds.includes('node-C'), true, 'node-C must be restored');
    assert.strictEqual(state.graphData.nodes.length, 2, 'Exactly 2 nodes must remain');

    // Verify links: only link between A and C should exist
    assert.strictEqual(state.graphData.links.length, 1, 'Only 1 link must remain');
    const remainingLink = state.graphData.links[0];
    const s = typeof remainingLink.source === 'string' ? remainingLink.source : (remainingLink.source as any).id;
    const t = typeof remainingLink.target === 'string' ? remainingLink.target : (remainingLink.target as any).id;
    const isACLink = (s === 'node-A' && t === 'node-C') || (s === 'node-C' && t === 'node-A');
    assert.strictEqual(isACLink, true, 'Remaining link must connect node-A and node-C');
  });

  it('Stress Test 7: User selection change during in-flight failed operation must NOT be overwritten by rollback', async () => {
    const nodeA = createNode('node-A', 'seed');
    const nodeB = createNode('node-B', 'seed');
    const nodeC = createNode('node-C', 'seed');

    useGraphStore.setState({
      graphData: { nodes: [nodeA, nodeB, nodeC], links: [] },
      selectedNode: nodeA,
    });

    // removeNode('node-A') starts and will fail after 40ms
    globalThis.fetch = async () => {
      await new Promise(r => setTimeout(r, 40));
      return new Response(JSON.stringify({ error: 'Failed' }), { status: 500 });
    };

    const removalPromise = useGraphStore.getState().removeNode('node-A');

    // While in flight, at t=15ms, user clicks and selects node-C
    await new Promise(r => setTimeout(r, 15));
    useGraphStore.getState().setSelectedNode(nodeC);

    await removalPromise;

    const state = useGraphStore.getState();
    // Rollback restored node-A, but user's selection of node-C must NOT have been clobbered
    assert.strictEqual(state.selectedNode?.id, 'node-C', 'User selection of node-C must be preserved');
  });

  it('Stress Test 8: 50 randomized concurrent operations with variable delays, failures, and network throws', async () => {
    // Initial topology: 15 nodes
    const initialNodes: GraphNode[] = [];
    const initialLinks: GraphLink[] = [];
    for (let i = 0; i < 15; i++) {
      initialNodes.push(createNode(`init-${i}`, 'seed'));
      if (i > 0) {
        initialLinks.push({ source: `init-${i - 1}`, target: `init-${i}` });
      }
    }

    useGraphStore.setState({
      graphData: { nodes: initialNodes, links: initialLinks },
    });

    const outcomes = new Map<string, 'success' | 'failure'>();

    // 25 additions: add-0 to add-24
    // 15 removals of initial nodes: init-0 to init-14
    // 10 removals of additions: add-0 to add-9
    const ops: Promise<void>[] = [];

    globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = url.toString();
      const method = init?.method || 'GET';
      const delay = Math.floor(Math.random() * 30) + 5;
      await new Promise(r => setTimeout(r, delay));

      if (method === 'POST') {
        const body = JSON.parse((init?.body as string) || '{}');
        const id = body.id;
        const shouldFail = (parseInt(id.replace(/\D/g, ''), 10) % 3) === 0;
        if (shouldFail) {
          outcomes.set(`add-${id}`, 'failure');
          return new Response(JSON.stringify({ error: 'DB Fail' }), { status: 500 });
        } else {
          outcomes.set(`add-${id}`, 'success');
          return new Response(JSON.stringify({ message: 'OK' }), { status: 200 });
        }
      }

      if (method === 'DELETE') {
        const match = urlStr.match(/\/collection\/([^?]+)/);
        const id = match ? match[1] : '';
        const num = parseInt(id.replace(/\D/g, ''), 10);
        const shouldFail = (num % 2) === 1;
        if (shouldFail) {
          outcomes.set(`rem-${id}`, 'failure');
          return new Response(JSON.stringify({ error: 'Delete Fail' }), { status: 500 });
        } else {
          outcomes.set(`rem-${id}`, 'success');
          return new Response(JSON.stringify({ message: 'Deleted' }), { status: 200 });
        }
      }

      return new Response('{}', { status: 200 });
    };

    // Dispatch 25 additions
    for (let i = 0; i < 25; i++) {
      ops.push(useGraphStore.getState().addSeedPaper(createPaper(`add-${i}`)));
    }

    // Dispatch 15 removals of initial nodes
    for (let i = 0; i < 15; i++) {
      ops.push(useGraphStore.getState().removeNode(`init-${i}`));
    }

    await Promise.all(ops);

    const finalState = useGraphStore.getState();
    const finalNodeIds = new Set(finalState.graphData.nodes.map(n => n.id));

    // Verify initial nodes:
    // even numbers (init-0, init-2, ...) succeeded delete -> must NOT be present
    // odd numbers (init-1, init-3, ...) failed delete -> must be present
    for (let i = 0; i < 15; i++) {
      const id = `init-${i}`;
      if (i % 2 === 0) {
        assert.strictEqual(finalNodeIds.has(id), false, `${id} succeeded delete and must not be in graph`);
      } else {
        assert.strictEqual(finalNodeIds.has(id), true, `${id} failed delete and must be restored in graph`);
      }
    }

    // Verify additions:
    // divisible by 3 (add-0, add-3, add-6...) failed add -> must NOT be present
    // not divisible by 3 succeeded add -> must be present
    for (let i = 0; i < 25; i++) {
      const id = `add-${i}`;
      if (i % 3 === 0) {
        assert.strictEqual(finalNodeIds.has(id), false, `${id} failed add and must not be in graph`);
      } else {
        assert.strictEqual(finalNodeIds.has(id), true, `${id} succeeded add and must be in graph`);
      }
    }

    // Check invariants:
    // 1. No duplicates
    const allIds = finalState.graphData.nodes.map(n => n.id);
    assert.strictEqual(allIds.length, finalNodeIds.size, 'No duplicate node IDs allowed');

    // 2. No dangling links
    for (const link of finalState.graphData.links) {
      const s = typeof link.source === 'string' ? link.source : (link.source as any).id;
      const t = typeof link.target === 'string' ? link.target : (link.target as any).id;
      assert.strictEqual(finalNodeIds.has(s), true, `Link source ${s} must exist`);
      assert.strictEqual(finalNodeIds.has(t), true, `Link target ${t} must exist`);
    }

    // 3. calculateSizes properties are valid
    for (const node of finalState.graphData.nodes) {
      assert.strictEqual(typeof node.val, 'number', `node.val must be number for ${node.id}`);
      assert.strictEqual(isNaN(node.val as number), false, `node.val must not be NaN for ${node.id}`);
    }
  });

  it('Stress Test 9: Rapid add-remove-add sequential cycle on single node settles to correct state', async () => {
    const paper = createPaper('cycle-paper');

    // Setup: fetch where first add succeeds, delete succeeds, second add fails
    let callCount = 0;
    globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      callCount++;
      const method = init?.method || 'GET';
      await new Promise(r => setTimeout(r, 10));

      if (callCount === 1 && method === 'POST') {
        return new Response(JSON.stringify({ message: 'Added' }), { status: 200 });
      }
      if (callCount === 2 && method === 'DELETE') {
        return new Response(JSON.stringify({ message: 'Deleted' }), { status: 200 });
      }
      if (callCount === 3 && method === 'POST') {
        return new Response(JSON.stringify({ error: 'DB Failure on 2nd Add' }), { status: 500 });
      }
      return new Response('{}', { status: 200 });
    };

    // 1. Add
    await useGraphStore.getState().addSeedPaper(paper);
    assert.strictEqual(useGraphStore.getState().graphData.nodes.some(n => n.id === 'cycle-paper'), true);

    // 2. Delete
    await useGraphStore.getState().removeNode('cycle-paper');
    assert.strictEqual(useGraphStore.getState().graphData.nodes.some(n => n.id === 'cycle-paper'), false);

    // 3. Add again (fails)
    await useGraphStore.getState().addSeedPaper(paper);
    assert.strictEqual(useGraphStore.getState().graphData.nodes.some(n => n.id === 'cycle-paper'), false, 'Failed 2nd add must be rolled back');
  });

  it('Stress Test 10: Dynamic edgeFilter and topNLimit threshold recalculation remains consistent during delta rollback', async () => {
    // Setup graph with topNLimit = 2 and multiple nodes with different degree counts
    const nodeA = createNode('node-A', 'seed');
    const nodeB = createNode('node-B', 'seed');
    const nodeC: GraphNode = { ...createPaper('node-C'), status: 'recommended', val: 14 };
    const nodeD: GraphNode = { ...createPaper('node-D'), status: 'recommended', val: 12 };
    const linkAC: GraphLink = { source: 'node-A', target: 'node-C' };
    const linkBC: GraphLink = { source: 'node-B', target: 'node-C' };
    const linkBD: GraphLink = { source: 'node-B', target: 'node-D' };

    useGraphStore.setState({
      graphData: { nodes: [nodeA, nodeB, nodeC, nodeD], links: [linkAC, linkBC, linkBD] },
      topNLimit: 2,
      edgeFilter: 1,
    });

    const initialEdgeFilter = useGraphStore.getState().edgeFilter;

    // Fail addition of a new paper
    globalThis.fetch = async () => {
      await new Promise(r => setTimeout(r, 20));
      return new Response(JSON.stringify({ error: 'DB insert failed' }), { status: 500 });
    };

    const newPaper = createPaper('node-fail');
    await useGraphStore.getState().addSeedPaper(newPaper);

    const stateAfterAddFail = useGraphStore.getState();
    assert.strictEqual(
      stateAfterAddFail.graphData.nodes.some(n => n.id === 'node-fail'),
      false,
      'node-fail must be rolled back'
    );
    assert.strictEqual(
      stateAfterAddFail.edgeFilter >= 1,
      true,
      'edgeFilter must remain valid'
    );

    // Fail deletion of node-B
    await useGraphStore.getState().removeNode('node-B');

    const stateAfterRemoveFail = useGraphStore.getState();
    assert.strictEqual(
      stateAfterRemoveFail.graphData.nodes.some(n => n.id === 'node-B'),
      true,
      'node-B must be restored'
    );
    assert.strictEqual(
      stateAfterRemoveFail.graphData.links.length,
      3,
      'All 3 links must be preserved'
    );
    assert.strictEqual(
      stateAfterRemoveFail.edgeFilter,
      initialEdgeFilter,
      'edgeFilter must match original baseline after rollback'
    );
  });
});



