import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// In-memory localStorage polyfill for Node.js environment to support Zustand persist middleware
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
  // Ignore if property is non-configurable
}

import { useGraphStore, GraphNode, GraphLink } from '../../src/store/graphStore.js';
import { Paper } from '../../src/lib/openalex.js';

describe('Milestone 7 (R3): Zustand Store Safe Optimistic Updates & Rollback Suite', () => {
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

    // Reset store state before each test
    useGraphStore.setState({
      activeCollectionId: 'test-collection-m7',
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

  const createMockPaper = (id: string, title: string): Paper => ({
    id,
    title,
    doi: `10.1000/${id}`,
    year: 2024,
    publicationDate: '2024-01-01',
    citationCount: 42,
    authors: ['Author A', 'Author B'],
    abstract: 'Sample abstract for ' + title,
    url: `https://doi.org/10.1000/${id}`,
    venue: 'Test Venue',
    referencedWorks: [],
  });

  const createMockNode = (id: string, status: string = 'seed'): GraphNode => ({
    id,
    title: `Paper ${id}`,
    doi: `10.1000/${id}`,
    year: 2024,
    publicationDate: '2024-01-01',
    citationCount: 10,
    authors: [`Author ${id}`],
    abstract: null,
    url: null,
    venue: null,
    referencedWorks: [],
    status,
    val: 20,
  });

  describe('addSeedPaper', () => {

    it('optimistically adds a new paper as seed and persists on HTTP 200', async () => {
      let fetchCalled = false;
      let sentPayload: Record<string, unknown> | null = null;

      globalThis.fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
        fetchCalled = true;
        sentPayload = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ message: 'Success' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const paper = createMockPaper('paper-1', 'Transformers in Vision');
      await useGraphStore.getState().addSeedPaper(paper);

      const state = useGraphStore.getState();
      assert.strictEqual(fetchCalled, true, 'Fetch should have been called');
      assert.ok(sentPayload);
      const payload = sentPayload as Record<string, unknown>;
      assert.strictEqual(payload.id, 'paper-1');
      assert.strictEqual(payload.status, 'seed');
      assert.strictEqual(payload.collectionId, 'test-collection-m7');

      assert.strictEqual(state.graphData.nodes.length, 1);
      assert.strictEqual(state.graphData.nodes[0].id, 'paper-1');
      assert.strictEqual(state.graphData.nodes[0].status, 'seed');
      assert.strictEqual(loggedErrors.length, 0, 'No errors should be logged on success');
    });

    it('optimistically upgrades existing recommended paper to seed on HTTP 200', async () => {
      const existingPaper: GraphNode = {
        ...createMockPaper('paper-existing', 'Existing Recommended'),
        status: 'recommended',
      };

      useGraphStore.setState({
        graphData: { nodes: [existingPaper], links: [] },
        edgeFilter: 1,
      });

      globalThis.fetch = async () => {
        return new Response(JSON.stringify({ message: 'Upgraded' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      await useGraphStore.getState().addSeedPaper(existingPaper);

      const state = useGraphStore.getState();
      assert.strictEqual(state.graphData.nodes.length, 1);
      assert.strictEqual(state.graphData.nodes[0].id, 'paper-existing');
      assert.strictEqual(state.graphData.nodes[0].status, 'seed');
    });

    it('rolls back optimistic new paper addition on backend HTTP 500 error', async () => {
      const initialNode: GraphNode = {
        ...createMockPaper('paper-init', 'Initial Seed'),
        status: 'seed',
      };

      useGraphStore.setState({
        graphData: { nodes: [initialNode], links: [] },
        edgeFilter: 2,
      });

      globalThis.fetch = async () => {
        return new Response(JSON.stringify({ error: 'Database constraint failed' }), {
          status: 500,
          statusText: 'Internal Server Error',
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const failingPaper = createMockPaper('paper-fail', 'Will Fail');
      await useGraphStore.getState().addSeedPaper(failingPaper);

      const state = useGraphStore.getState();
      assert.strictEqual(state.graphData.nodes.length, 1, 'Failed paper must be rolled back');
      assert.strictEqual(state.graphData.nodes[0].id, 'paper-init');
      assert.strictEqual(state.graphData.nodes[0].status, 'seed');
      assert.strictEqual(state.edgeFilter, 2, 'Edge filter must be restored to previous value');
      assert.strictEqual(loggedErrors.length, 1, 'Error must be logged to console.error');
    });

    it('rolls back upgraded paper status on backend HTTP 500 error', async () => {
      const recommendedNode: GraphNode = {
        ...createMockPaper('paper-rec', 'Recommended Paper'),
        status: 'recommended',
      };

      useGraphStore.setState({
        graphData: { nodes: [recommendedNode], links: [] },
        edgeFilter: 1,
      });

      globalThis.fetch = async () => {
        return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
          status: 500,
          statusText: 'Internal Server Error',
        });
      };

      await useGraphStore.getState().addSeedPaper(recommendedNode);

      const state = useGraphStore.getState();
      assert.strictEqual(state.graphData.nodes.length, 1);
      assert.strictEqual(state.graphData.nodes[0].id, 'paper-rec');
      assert.strictEqual(state.graphData.nodes[0].status, 'recommended', 'Status must roll back to recommended');
      assert.strictEqual(loggedErrors.length, 1);
    });

    it('rolls back optimistic addition on network exception / fetch rejection', async () => {
      const initialNode: GraphNode = {
        ...createMockPaper('paper-steady', 'Steady Paper'),
        status: 'seed',
      };

      useGraphStore.setState({
        graphData: { nodes: [initialNode], links: [] },
      });

      globalThis.fetch = async () => {
        throw new TypeError('fetch failed: ECONNREFUSED');
      };

      const offlinePaper = createMockPaper('paper-offline', 'Offline Paper');
      await useGraphStore.getState().addSeedPaper(offlinePaper);

      const state = useGraphStore.getState();
      assert.strictEqual(state.graphData.nodes.length, 1);
      assert.strictEqual(state.graphData.nodes[0].id, 'paper-steady');
      assert.strictEqual(state.graphData.nodes.some(n => n.id === 'paper-offline'), false);
      assert.strictEqual(loggedErrors.length, 1);
    });

    it('updates and rolls back selectedNode if the added paper was currently selected', async () => {
      const recommendedNode: GraphNode = {
        ...createMockPaper('paper-sel', 'Selected Recommended'),
        status: 'recommended',
      };

      useGraphStore.setState({
        graphData: { nodes: [recommendedNode], links: [] },
        selectedNode: recommendedNode,
      });

      globalThis.fetch = async () => {
        return new Response(JSON.stringify({ error: '500 Server Crash' }), {
          status: 500,
          statusText: 'Internal Server Error',
        });
      };

      await useGraphStore.getState().addSeedPaper(recommendedNode);

      const state = useGraphStore.getState();
      assert.strictEqual(state.selectedNode?.id, 'paper-sel');
      assert.strictEqual(state.selectedNode?.status, 'recommended', 'Selected node status must roll back to recommended');
    });

    it('does nothing and skips network call if paper is already seed in graph', async () => {
      const seedNode: GraphNode = {
        ...createMockPaper('paper-already-seed', 'Already Seed'),
        status: 'seed',
      };

      useGraphStore.setState({
        graphData: { nodes: [seedNode], links: [] },
      });

      let fetchCalled = false;
      globalThis.fetch = async () => {
        fetchCalled = true;
        return new Response('{}', { status: 200 });
      };

      await useGraphStore.getState().addSeedPaper(seedNode);

      assert.strictEqual(fetchCalled, false, 'Fetch must not be called when paper is already seed');
      assert.strictEqual(useGraphStore.getState().graphData.nodes.length, 1);
      assert.strictEqual(useGraphStore.getState().graphData.nodes[0].status, 'seed');
    });

    it('does nothing if activeCollectionId is null', async () => {
      useGraphStore.setState({ activeCollectionId: null });

      let fetchCalled = false;
      globalThis.fetch = async () => {
        fetchCalled = true;
        return new Response('{}', { status: 200 });
      };

      const paper = createMockPaper('paper-no-col', 'No Collection');
      await useGraphStore.getState().addSeedPaper(paper);

      assert.strictEqual(fetchCalled, false);
      assert.strictEqual(useGraphStore.getState().graphData.nodes.length, 0);
    });
  });

  describe('removeNode', () => {
    it('optimistically removes node and connected links, persisting on HTTP 200', async () => {
      const nodeA = createMockNode('node-A', 'seed');
      const nodeB = createMockNode('node-B', 'recommended');
      const nodeC = createMockNode('node-C', 'recommended');
      const linkAB: GraphLink = { source: 'node-A', target: 'node-B' };
      const linkBC: GraphLink = { source: 'node-B', target: 'node-C' };

      useGraphStore.setState({
        graphData: { nodes: [nodeA, nodeB, nodeC], links: [linkAB, linkBC] },
        selectedNode: nodeA,
        focusedNodeId: 'node-A',
        edgeFilter: 1,
      });

      let fetchCalled = false;
      let deletedEndpoint = '';

      globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
        fetchCalled = true;
        deletedEndpoint = url.toString();
        assert.strictEqual(init?.method, 'DELETE');
        return new Response(JSON.stringify({ message: 'Deleted' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      await useGraphStore.getState().removeNode('node-A');

      const state = useGraphStore.getState();
      assert.strictEqual(fetchCalled, true);
      assert.ok(deletedEndpoint.includes('/api/collection/node-A?collectionId=test-collection-m7'));
      assert.strictEqual(state.graphData.nodes.length, 2);
      assert.strictEqual(state.graphData.nodes.some(n => n.id === 'node-A'), false);
      assert.strictEqual(state.graphData.links.length, 1, 'Only linkBC should remain');
      assert.strictEqual(state.graphData.links[0], linkBC);
      assert.strictEqual(state.selectedNode, null, 'Selected node should be cleared');
      assert.strictEqual(state.focusedNodeId, null, 'Focused node ID should be cleared');
      assert.strictEqual(loggedErrors.length, 0);
    });

    it('handles link objects with object source/target references correctly', async () => {
      const nodeA = createMockNode('node-A', 'seed');
      const nodeB = createMockNode('node-B', 'recommended');
      const linkObj: GraphLink = { source: nodeA, target: nodeB };

      useGraphStore.setState({
        graphData: { nodes: [nodeA, nodeB], links: [linkObj] },
      });

      globalThis.fetch = async () => {
        return new Response(JSON.stringify({ message: 'Deleted' }), { status: 200 });
      };

      await useGraphStore.getState().removeNode('node-A');

      const state = useGraphStore.getState();
      assert.strictEqual(state.graphData.nodes.length, 1);
      assert.strictEqual(state.graphData.nodes[0].id, 'node-B');
      assert.strictEqual(state.graphData.links.length, 0);
    });

    it('rolls back node, links, selectedNode, focusedNodeId, and edgeFilter on backend HTTP 500 error', async () => {
      const nodeA = createMockNode('node-A', 'seed');
      const nodeB = createMockNode('node-B', 'recommended');
      const linkAB: GraphLink = { source: 'node-A', target: 'node-B' };

      useGraphStore.setState({
        graphData: { nodes: [nodeA, nodeB], links: [linkAB] },
        selectedNode: nodeA,
        focusedNodeId: 'node-A',
        edgeFilter: 3,
      });

      globalThis.fetch = async () => {
        return new Response(JSON.stringify({ error: 'Failed to delete paper' }), {
          status: 500,
          statusText: 'Internal Server Error',
          headers: { 'Content-Type': 'application/json' },
        });
      };

      await useGraphStore.getState().removeNode('node-A');

      const state = useGraphStore.getState();
      assert.strictEqual(state.graphData.nodes.length, 2, 'Both nodes must be restored on rollback');
      assert.ok(state.graphData.nodes.some(n => n.id === 'node-A'), 'node-A must be restored');
      assert.ok(state.graphData.nodes.some(n => n.id === 'node-B'), 'node-B must be restored');
      assert.strictEqual(state.graphData.links.length, 1, 'Link must be restored on rollback');
      assert.strictEqual(state.selectedNode?.id, 'node-A', 'Selected node must be restored');
      assert.strictEqual(state.focusedNodeId, 'node-A', 'Focused node ID must be restored');
      assert.strictEqual(state.edgeFilter, 3, 'Edge filter must be restored');
      assert.strictEqual(loggedErrors.length, 1, 'Error must be logged');
    });

    it('rolls back node removal on network exception / connection failure', async () => {
      const nodeA = createMockNode('node-A', 'seed');
      const nodeB = createMockNode('node-B', 'seed');

      useGraphStore.setState({
        graphData: { nodes: [nodeA, nodeB], links: [] },
        selectedNode: nodeA,
        focusedNodeId: 'node-A',
      });

      globalThis.fetch = async () => {
        throw new Error('Network socket disconnected');
      };

      await useGraphStore.getState().removeNode('node-A');

      const state = useGraphStore.getState();
      assert.strictEqual(state.graphData.nodes.length, 2);
      assert.ok(state.graphData.nodes.some(n => n.id === 'node-A'));
      assert.strictEqual(state.selectedNode?.id, 'node-A');
      assert.strictEqual(state.focusedNodeId, 'node-A');
      assert.strictEqual(loggedErrors.length, 1);
    });

    it('preserves unrelated selectedNode when removing a different node and rolling back', async () => {
      const nodeA = createMockNode('node-A', 'seed');
      const nodeB = createMockNode('node-B', 'seed');

      useGraphStore.setState({
        graphData: { nodes: [nodeA, nodeB], links: [] },
        selectedNode: nodeB,
        focusedNodeId: 'node-B',
      });

      globalThis.fetch = async () => {
        return new Response('{"error":"fail"}', { status: 500, statusText: 'Error' });
      };

      await useGraphStore.getState().removeNode('node-A');

      const state = useGraphStore.getState();
      assert.strictEqual(state.graphData.nodes.length, 2);
      assert.strictEqual(state.selectedNode?.id, 'node-B', 'Selected node B must remain selected');
      assert.strictEqual(state.focusedNodeId, 'node-B', 'Focused node B must remain focused');
    });

    it('does nothing if activeCollectionId is null', async () => {
      const nodeA = createMockNode('node-A');
      useGraphStore.setState({
        activeCollectionId: null,
        graphData: { nodes: [nodeA], links: [] },
      });

      let fetchCalled = false;
      globalThis.fetch = async () => {
        fetchCalled = true;
        return new Response('{}', { status: 200 });
      };

      await useGraphStore.getState().removeNode('node-A');

      assert.strictEqual(fetchCalled, false);
      assert.strictEqual(useGraphStore.getState().graphData.nodes.length, 1);
    });
  });

  describe('Deep Cloning and State Isolation Verification', () => {
    it('ensures node object references are cloned so calculateSizes mutations do not corrupt rollback snapshot', async () => {
      // Create seed and recommended nodes with mutual links
      const seedNode: GraphNode = {
        id: 'seed-1',
        title: 'Seed One',
        status: 'seed',
        doi: null,
        year: 2024,
        publicationDate: null,
        citationCount: 0,
        authors: [],
        abstract: null,
        url: null,
        venue: null,
        referencedWorks: [],
        val: 24,
      };
      const recNode: GraphNode = {
        id: 'rec-1',
        title: 'Rec One',
        status: 'recommended',
        doi: null,
        year: 2024,
        publicationDate: null,
        citationCount: 0,
        authors: [],
        abstract: null,
        url: null,
        venue: null,
        referencedWorks: [],
        val: 12,
      };
      const link: GraphLink = { source: 'seed-1', target: 'rec-1' };

      useGraphStore.setState({
        graphData: { nodes: [seedNode, recNode], links: [link] },
      });

      // Capture the original values before removeNode
      const originalRecVal = recNode.val;

      // Fail the DELETE
      globalThis.fetch = async () => {
        return new Response('{"error":"server error"}', { status: 500, statusText: 'Error' });
      };

      await useGraphStore.getState().removeNode('seed-1');

      // State is rolled back
      const state = useGraphStore.getState();
      const restoredRec = state.graphData.nodes.find(n => n.id === 'rec-1');
      assert.ok(restoredRec, 'rec-1 must be restored');
      assert.strictEqual(restoredRec.val, originalRecVal, 'rec-1 val must match pre-call val without mutation');

      // The snapshot node objects must not be the exact same object reference as newNodes that got mutated
      const restoredSeed = state.graphData.nodes.find(n => n.id === 'seed-1');
      assert.ok(restoredSeed, 'seed-1 must be restored');
    });

    it('allows successful operations following a rolled back failure', async () => {
      // First operation: fails and rolls back
      globalThis.fetch = async () => {
        return new Response('{"error":"500"}', { status: 500, statusText: 'Internal Server Error' });
      };

      const failingNode: Paper = {
        id: 'fail-paper',
        title: 'Will Fail',
        doi: null,
        year: 2024,
        publicationDate: null,
        citationCount: 0,
        authors: [],
        abstract: null,
        url: null,
        venue: null,
        referencedWorks: [],
      };

      await useGraphStore.getState().addSeedPaper(failingNode);
      assert.strictEqual(useGraphStore.getState().graphData.nodes.length, 0);

      // Second operation: succeeds
      globalThis.fetch = async () => {
        return new Response('{"message":"ok"}', { status: 200 });
      };

      const successNode: Paper = {
        id: 'success-paper',
        title: 'Will Succeed',
        doi: null,
        year: 2024,
        publicationDate: null,
        citationCount: 0,
        authors: [],
        abstract: null,
        url: null,
        venue: null,
        referencedWorks: [],
      };

      await useGraphStore.getState().addSeedPaper(successNode);
      const state = useGraphStore.getState();
      assert.strictEqual(state.graphData.nodes.length, 1);
      assert.strictEqual(state.graphData.nodes[0].id, 'success-paper');
    });

    it('rolls back multi-node and multi-link topology on simulated 500 error during removeNode', async () => {
      // 5 nodes, 4 links in star topology around center node
      const center = createMockNode('center-node', 'seed');
      const leaf1 = createMockNode('leaf-1', 'recommended');
      const leaf2 = createMockNode('leaf-2', 'recommended');
      const leaf3 = createMockNode('leaf-3', 'recommended');
      const leaf4 = createMockNode('leaf-4', 'recommended');

      const links: GraphLink[] = [
        { source: 'center-node', target: 'leaf-1' },
        { source: 'center-node', target: 'leaf-2' },
        { source: 'center-node', target: 'leaf-3' },
        { source: 'leaf-3', target: 'leaf-4' },
      ];

      useGraphStore.setState({
        graphData: { nodes: [center, leaf1, leaf2, leaf3, leaf4], links },
        selectedNode: center,
        focusedNodeId: 'center-node',
        edgeFilter: 1,
      });

      globalThis.fetch = async () => {
        return new Response(JSON.stringify({ error: 'DB locked' }), {
          status: 500,
          statusText: 'Internal Server Error',
        });
      };

      await useGraphStore.getState().removeNode('center-node');

      const state = useGraphStore.getState();
      assert.strictEqual(state.graphData.nodes.length, 5, 'All 5 nodes must be restored');
      assert.strictEqual(state.graphData.links.length, 4, 'All 4 links must be restored');
      assert.strictEqual(state.selectedNode?.id, 'center-node');
      assert.strictEqual(state.focusedNodeId, 'center-node');
    });

    it('rolls back on various non-2xx status codes (400, 404, 502, 503)', async () => {
      const errorStatuses = [400, 404, 502, 503];

      for (const status of errorStatuses) {
        const node = createMockNode(`node-status-${status}`, 'seed');
        useGraphStore.setState({
          graphData: { nodes: [node], links: [] },
          selectedNode: node,
        });

        globalThis.fetch = async () => {
          return new Response('{}', { status, statusText: `HTTP ${status}` });
        };

        // Test removeNode rollback
        await useGraphStore.getState().removeNode(`node-status-${status}`);
        assert.strictEqual(
          useGraphStore.getState().graphData.nodes.length,
          1,
          `removeNode must roll back on HTTP ${status}`
        );

        // Test addSeedPaper rollback
        const newPaper: Paper = {
          id: `new-paper-${status}`,
          title: `Paper ${status}`,
          doi: null,
          year: 2024,
          publicationDate: null,
          citationCount: 0,
          authors: [],
          abstract: null,
          url: null,
          venue: null,
          referencedWorks: [],
        };
        await useGraphStore.getState().addSeedPaper(newPaper);
        assert.strictEqual(
          useGraphStore.getState().graphData.nodes.some(n => n.id === `new-paper-${status}`),
          false,
          `addSeedPaper must roll back on HTTP ${status}`
        );
      }
    });

    it('safely handles non-existent node deletion and rolls back if DELETE fails', async () => {
      const node = createMockNode('node-present', 'seed');
      useGraphStore.setState({
        graphData: { nodes: [node], links: [] },
        selectedNode: node,
        focusedNodeId: 'node-present',
      });

      globalThis.fetch = async () => {
        return new Response('{"error":"Not Found"}', { status: 404, statusText: 'Not Found' });
      };

      await useGraphStore.getState().removeNode('node-non-existent');

      const state = useGraphStore.getState();
      assert.strictEqual(state.graphData.nodes.length, 1);
      assert.strictEqual(state.graphData.nodes[0].id, 'node-present');
      assert.strictEqual(state.selectedNode?.id, 'node-present');
      assert.strictEqual(state.focusedNodeId, 'node-present');
      assert.strictEqual(loggedErrors.length, 1);
    });

    it('safely handles non-Error exception (e.g. string throw) during network request', async () => {
      const node = createMockNode('node-throw', 'seed');
      useGraphStore.setState({
        graphData: { nodes: [node], links: [] },
        selectedNode: node,
      });

      globalThis.fetch = async () => {
        throw 'Fatal network abort';
      };

      await useGraphStore.getState().removeNode('node-throw');

      const state = useGraphStore.getState();
      assert.strictEqual(state.graphData.nodes.length, 1);
      assert.strictEqual(state.graphData.nodes[0].id, 'node-throw');
      assert.strictEqual(state.selectedNode?.id, 'node-throw');
      assert.strictEqual(loggedErrors.length, 1);
    });
  });
});
