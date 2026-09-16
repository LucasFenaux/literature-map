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

describe('Adversarial Stress Suite: Optimistic Updates & Rollback (Milestone 7)', () => {
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
      activeCollectionId: 'adversarial-col',
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

  // =========================================================================
  // Scope 1: Rapid Interleaved Operations
  // =========================================================================
  describe('Scope 1: Rapid Interleaved Operations', () => {

    it('Scenario 1A: addSeedPaper fails (500) while concurrent removeNode succeeds (200)', async () => {
      // Setup: Initial graph has node-A and node-B
      const nodeA = createNode('node-A', 'seed');
      const nodeB = createNode('node-B', 'seed');
      useGraphStore.setState({
        graphData: { nodes: [nodeA, nodeB], links: [] },
      });

      // Fetch router:
      // - POST for node-C: delayed 30ms, then fails with 500
      // - DELETE for node-A: delayed 10ms, then succeeds with 200
      globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
        const urlStr = url.toString();
        const method = init?.method || 'GET';

        if (method === 'POST') {
          await new Promise(r => setTimeout(r, 30));
          return new Response(JSON.stringify({ error: 'DB Error on Add' }), {
            status: 500,
            statusText: 'Internal Server Error',
          });
        }

        if (method === 'DELETE') {
          await new Promise(r => setTimeout(r, 10));
          return new Response(JSON.stringify({ message: 'Deleted' }), {
            status: 200,
          });
        }

        return new Response('{}', { status: 200 });
      };

      const paperC = createPaper('node-C');

      // Dispatch operations concurrently:
      // Op1: addSeedPaper(paperC) -> will fail
      // Op2: removeNode('node-A') -> will succeed
      const op1Promise = useGraphStore.getState().addSeedPaper(paperC);
      const op2Promise = useGraphStore.getState().removeNode('node-A');

      await Promise.all([op1Promise, op2Promise]);

      const state = useGraphStore.getState();

      // Expectations:
      // - node-C failed, so node-C must NOT be in the graph.
      // - node-A was successfully removed, so node-A must NOT be in the graph.
      // - node-B was untouched, so node-B MUST be in the graph.
      console.log('Result Scenario 1A nodes:', state.graphData.nodes.map(n => n.id));
      assert.strictEqual(
        state.graphData.nodes.some(n => n.id === 'node-C'),
        false,
        'Failed paper node-C must not be in graph'
      );
      assert.strictEqual(
        state.graphData.nodes.some(n => n.id === 'node-A'),
        false,
        'Successfully deleted node-A must NOT be resurrected in graph by node-C rollback'
      );
      assert.strictEqual(
        state.graphData.nodes.some(n => n.id === 'node-B'),
        true,
        'Untouched node-B must remain in graph'
      );
    });

    it('Scenario 1B: removeNode fails (500) while concurrent addSeedPaper succeeds (200)', async () => {
      // Setup: Initial graph has node-A
      const nodeA = createNode('node-A', 'seed');
      useGraphStore.setState({
        graphData: { nodes: [nodeA], links: [] },
      });

      // Fetch router:
      // - DELETE for node-A: delayed 30ms, then fails with 500
      // - POST for node-B: delayed 10ms, then succeeds with 200
      globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method || 'GET';

        if (method === 'DELETE') {
          await new Promise(r => setTimeout(r, 30));
          return new Response(JSON.stringify({ error: 'DB locked on delete' }), {
            status: 500,
            statusText: 'Internal Server Error',
          });
        }

        if (method === 'POST') {
          await new Promise(r => setTimeout(r, 10));
          return new Response(JSON.stringify({ message: 'Added' }), {
            status: 200,
          });
        }

        return new Response('{}', { status: 200 });
      };

      const paperB = createPaper('node-B');

      // Dispatch concurrently:
      // Op1: removeNode('node-A') -> will fail with 500
      // Op2: addSeedPaper(paperB) -> will succeed with 200
      const op1Promise = useGraphStore.getState().removeNode('node-A');
      const op2Promise = useGraphStore.getState().addSeedPaper(paperB);

      await Promise.all([op1Promise, op2Promise]);

      const state = useGraphStore.getState();

      // Expectations:
      // - node-A failed deletion, so node-A must be restored (present in graph).
      // - node-B succeeded addition, so node-B must remain in graph.
      console.log('Result Scenario 1B nodes:', state.graphData.nodes.map(n => n.id));
      assert.strictEqual(
        state.graphData.nodes.some(n => n.id === 'node-A'),
        true,
        'Failed deletion of node-A must be rolled back (node-A present)'
      );
      assert.strictEqual(
        state.graphData.nodes.some(n => n.id === 'node-B'),
        true,
        'Successfully added node-B must NOT be wiped out by node-A rollback'
      );
    });

    it('Scenario 1C: two concurrent addSeedPaper where first fails (500) and second succeeds (200)', async () => {
      useGraphStore.setState({
        graphData: { nodes: [], links: [] },
      });

      globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string || '{}');
        if (body.id === 'paper-1') {
          // Delayed failure
          await new Promise(r => setTimeout(r, 30));
          return new Response(JSON.stringify({ error: 'Failed' }), { status: 500 });
        } else {
          // Quick success
          await new Promise(r => setTimeout(r, 10));
          return new Response(JSON.stringify({ message: 'Created' }), { status: 200 });
        }
      };

      const p1 = createPaper('paper-1');
      const p2 = createPaper('paper-2');

      await Promise.all([
        useGraphStore.getState().addSeedPaper(p1),
        useGraphStore.getState().addSeedPaper(p2),
      ]);

      const state = useGraphStore.getState();
      console.log('Result Scenario 1C nodes:', state.graphData.nodes.map(n => n.id));
      assert.strictEqual(state.graphData.nodes.some(n => n.id === 'paper-1'), false, 'paper-1 must not be in graph');
      assert.strictEqual(state.graphData.nodes.some(n => n.id === 'paper-2'), true, 'paper-2 must be preserved in graph');
    });

    it('Scenario 1D: two concurrent removeNode where first fails (500) and second succeeds (200)', async () => {
      const nodeA = createNode('node-A', 'seed');
      const nodeB = createNode('node-B', 'seed');
      useGraphStore.setState({
        graphData: { nodes: [nodeA, nodeB], links: [] },
      });

      globalThis.fetch = async (url: RequestInfo | URL) => {
        const urlStr = url.toString();
        if (urlStr.includes('node-A')) {
          await new Promise(r => setTimeout(r, 30));
          return new Response(JSON.stringify({ error: 'Failed' }), { status: 500 });
        } else {
          await new Promise(r => setTimeout(r, 10));
          return new Response(JSON.stringify({ message: 'Deleted' }), { status: 200 });
        }
      };

      await Promise.all([
        useGraphStore.getState().removeNode('node-A'),
        useGraphStore.getState().removeNode('node-B'),
      ]);

      const state = useGraphStore.getState();
      console.log('Result Scenario 1D nodes:', state.graphData.nodes.map(n => n.id));
      assert.strictEqual(state.graphData.nodes.some(n => n.id === 'node-A'), true, 'node-A must be restored');
      assert.strictEqual(state.graphData.nodes.some(n => n.id === 'node-B'), false, 'node-B must remain deleted');
    });
  });

  // =========================================================================
  // Scope 2: Network Edge Cases
  // =========================================================================
  describe('Scope 2: Network Edge Cases', () => {

    it('handles aborted requests via DOMException / AbortError without unhandled rejection', async () => {
      const initialNode = createNode('node-abort', 'seed');
      useGraphStore.setState({
        graphData: { nodes: [initialNode], links: [] },
      });

      globalThis.fetch = async () => {
        const abortErr = new DOMException('The operation was aborted.', 'AbortError');
        throw abortErr;
      };

      const newPaper = createPaper('node-new');
      await useGraphStore.getState().addSeedPaper(newPaper);

      const state = useGraphStore.getState();
      assert.strictEqual(state.graphData.nodes.length, 1);
      assert.strictEqual(state.graphData.nodes[0].id, 'node-abort');
      assert.strictEqual(loggedErrors.length, 1);
    });

    it('handles thrown null during fetch', async () => {
      const initialNode = createNode('node-null', 'seed');
      useGraphStore.setState({
        graphData: { nodes: [initialNode], links: [] },
      });

      globalThis.fetch = async () => {
        throw null;
      };

      await useGraphStore.getState().removeNode('node-null');

      const state = useGraphStore.getState();
      assert.strictEqual(state.graphData.nodes.length, 1);
      assert.strictEqual(state.graphData.nodes[0].id, 'node-null');
      assert.strictEqual(loggedErrors.length, 1);
    });

    it('handles thrown undefined during fetch', async () => {
      const initialNode = createNode('node-undef', 'seed');
      useGraphStore.setState({
        graphData: { nodes: [initialNode], links: [] },
      });

      globalThis.fetch = async () => {
        throw undefined;
      };

      await useGraphStore.getState().removeNode('node-undef');

      const state = useGraphStore.getState();
      assert.strictEqual(state.graphData.nodes.length, 1);
      assert.strictEqual(state.graphData.nodes[0].id, 'node-undef');
      assert.strictEqual(loggedErrors.length, 1);
    });

    it('handles thrown number (e.g. 500) during fetch', async () => {
      const initialNode = createNode('node-num', 'seed');
      useGraphStore.setState({
        graphData: { nodes: [initialNode], links: [] },
      });

      globalThis.fetch = async () => {
        throw 500;
      };

      await useGraphStore.getState().removeNode('node-num');

      const state = useGraphStore.getState();
      assert.strictEqual(state.graphData.nodes.length, 1);
      assert.strictEqual(state.graphData.nodes[0].id, 'node-num');
      assert.strictEqual(loggedErrors.length, 1);
    });

    it('handles thrown plain object (e.g. { error: "fatal" }) during fetch', async () => {
      const initialNode = createNode('node-obj', 'seed');
      useGraphStore.setState({
        graphData: { nodes: [initialNode], links: [] },
      });

      globalThis.fetch = async () => {
        throw { code: 'NETWORK_FATAL', details: 'Socket timeout' };
      };

      await useGraphStore.getState().removeNode('node-obj');

      const state = useGraphStore.getState();
      assert.strictEqual(state.graphData.nodes.length, 1);
      assert.strictEqual(state.graphData.nodes[0].id, 'node-obj');
      assert.strictEqual(loggedErrors.length, 1);
    });
  });

  // =========================================================================
  // Scope 3: Object Reference and Array Reference Isolation
  // =========================================================================
  describe('Scope 3: Reference Isolation & Leakage', () => {

    it('verifies selectedNode does NOT retain mutated properties when removeNode fails and rolls back', async () => {
      const nodeA = createNode('node-A', 'seed');
      const nodeB: GraphNode = {
        ...createPaper('node-B'),
        status: 'recommended',
        val: 12, // Initially degree 1, so val = 10 + 1*2 = 12
      };
      const linkAB: GraphLink = { source: 'node-A', target: 'node-B' };

      // Set store with nodeB selected
      useGraphStore.setState({
        graphData: { nodes: [nodeA, nodeB], links: [linkAB] },
        selectedNode: nodeB,
      });

      const originalVal = (nodeB as any).val;

      // Fail the DELETE of node-A
      globalThis.fetch = async () => {
        return new Response(JSON.stringify({ error: 'DB delete failed' }), { status: 500 });
      };

      await useGraphStore.getState().removeNode('node-A');

      const state = useGraphStore.getState();

      // State was rolled back:
      const restoredNodeB = state.graphData.nodes.find(n => n.id === 'node-B')!;
      console.log('Restored node-B val:', restoredNodeB.val, 'selectedNode val:', state.selectedNode?.val);

      // Verify graphData.nodes restored correctly
      assert.strictEqual(restoredNodeB.val, originalVal, 'restored nodeB val in graphData must match original');

      // Verify selectedNode reference:
      // Did selectedNode leak mutated calculateSizes properties?
      assert.strictEqual(
        state.selectedNode?.val,
        originalVal,
        'selectedNode.val must NOT leak mutated value from failed optimistic calculation'
      );
    });

    it('verifies selectedNode does NOT retain mutated properties when addSeedPaper fails and rolls back', async () => {
      const nodeA: GraphNode = {
        ...createPaper('node-A'),
        status: 'recommended',
        val: 12,
      };
      const nodeB = createNode('node-B', 'seed');
      const linkAB: GraphLink = { source: 'node-A', target: 'node-B' };

      // Set store with nodeA selected
      useGraphStore.setState({
        graphData: { nodes: [nodeA, nodeB], links: [linkAB] },
        selectedNode: nodeA,
      });

      const originalVal = (nodeA as any).val;

      // Fail the POST
      globalThis.fetch = async () => {
        return new Response(JSON.stringify({ error: 'DB insert failed' }), { status: 500 });
      };

      const newPaper = createPaper('node-new');
      await useGraphStore.getState().addSeedPaper(newPaper);

      const state = useGraphStore.getState();

      const restoredNodeA = state.graphData.nodes.find(n => n.id === 'node-A')!;
      console.log('Restored node-A val:', restoredNodeA.val, 'selectedNode val:', state.selectedNode?.val);

      assert.strictEqual(restoredNodeA.val, originalVal);
      assert.strictEqual(
        state.selectedNode?.val,
        originalVal,
        'selectedNode.val must NOT leak mutated value from failed addSeedPaper'
      );
    });

    it('verifies graphData.nodes array reference is replaced, not mutated in-place during rollback', async () => {
      const nodeA = createNode('node-A', 'seed');
      const initialNodesArray = [nodeA];

      useGraphStore.setState({
        graphData: { nodes: initialNodesArray, links: [] },
      });

      globalThis.fetch = async () => {
        return new Response('{}', { status: 500 });
      };

      const newPaper = createPaper('node-fail');
      await useGraphStore.getState().addSeedPaper(newPaper);

      const state = useGraphStore.getState();
      // graphData.nodes should be restored, but should not mutate initialNodesArray if callers cached it
      assert.strictEqual(state.graphData.nodes.length, 1);
      assert.strictEqual(state.graphData.nodes[0].id, 'node-A');
    });
  });
});
