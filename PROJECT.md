# Project: literature-review-graph

## Architecture
- **Framework**: Next.js 16.2.10 (App Router, React 19.2.4) + Express 5.2.1 server
- **Language / Runtime**: TypeScript 5.9.3, Node.js 20, ESNext with `moduleResolution: "bundler"`
- **Database**: SQLite via `better-sqlite3: 12.11.1`, WAL journal mode, configured in `src/lib/db.ts`
- **Domain Layer**:
  - `src/domain/repositories/PaperRepository.ts`: CRUD for papers, collection associations, statuses
  - `src/domain/repositories/CitationRepository.ts`: Direct and cross-paper citation links
  - `src/domain/repositories/QueueRepository.ts`: Retry and background enrichment queue items
  - `src/domain/repositories/CollectionRepository.ts`: Collections management
  - `src/domain/services/EnrichmentJobProcessor.ts`: Background polling & API enrichment service
- **API Routes**:
  - `src/api/expand/[id]/route.ts`: Node expansion endpoint (citations & references)

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---|---|---|---|
| 1 | Test runner setup | Install vitest & vite-tsconfig-paths, configure vitest.config.mts with node env and better-sqlite3 external | M1 | Survey 1 (R1) |
| 2 | TypeScript verification | Add `typecheck: tsc --noEmit` script to package.json | M1 | Survey 1 (R1) |
| 3 | Test script setup | Add `test: vitest run` script to package.json, create baseline test | M1 | Survey 1 (R1) |
| 4 | Batched Paper Inserts | Implement `PaperRepository.addPapers(papers, collectionId, status)` using single `db.transaction` with `INSERT OR IGNORE` | M2 | Survey 3 (R3) |
| 5 | Expand Route Batching | Refactor `savePapersAndLinks` in `src/api/expand/[id]/route.ts` to call `PaperRepository.addPapers` | M2 | Survey 3 (R3) |
| 6 | Queue Schema Migration | Add `collectionId TEXT` column to `retry_queue` table and ALTER TABLE migration in `src/lib/db.ts` | M3 | Survey 2 (R2) |
| 7 | QueueRepository collectionId | Update `addQueueItem` to accept, persist, and deduplicate by `collectionId` | M3 | Survey 2 (R2) |
| 8 | Expand Route collectionId | Extract `collectionId` early in `src/api/expand/[id]/route.ts` and forward to `queueRetry` | M3 | Survey 2 (R2) |
| 9 | Enrichment Persistence | In `EnrichmentJobProcessor.processBatch`, persist fetched papers via `PaperRepository.addPapers` and links via `CitationRepository.addLinks` | M3 | Survey 2 (R2) |
| 10 | Final Verification | Verify `npm run typecheck` and `npm run test` pass cleanly; verify database isolation | M4 | Acceptance Criteria |
| 11 | HttpClient Options & Cache Key | Add optional `options?: RequestInit` to `HttpClient.fetchWithBackoff` with body-aware cache key (`${url}#${options.body}`) and fast test backoff | M5 | Survey 1 (R1) |
| 12 | Refactor rebuild-edges route | Replace raw `fetch` with `HttpClient.fetchWithBackoff` for S2 and OpenAlex in `rebuild-edges/route.ts` | M5 | Survey 1 (R1) |
| 13 | Rebuild-edges tests | Integration tests for 429 retry backoff, caching behavior, and edge generation | M5 | Survey 1 (R1) |
| 14 | Atomic Paper Upsert in PaperRepository | Add atomic `upsertPaper` / `addPaper` with `INSERT OR IGNORE` in single transaction | M6 | Survey 2 (R2) |
| 15 | Concurrency Safety in Collection Route | Update `src/api/collection/route.ts` to use atomic repository upsert and handle duplicate constraint conflicts safely | M6 | Survey 2 (R2) |
| 16 | Concurrency test suite | Integration tests with Promise.all verifying concurrent paper additions do not throw 500 | M6 | Survey 2 (R2) |
| 17 | Zustand graphStore addSeedPaper rollback | Snapshot nodes, optimistically add seed, catch API failure/!res.ok and roll back | M7 | Survey 3 (R3) |
| 18 | Zustand graphStore removeNode rollback | Snapshot state, optimistically remove node/links, catch API failure/!res.ok and roll back | M7 | Survey 3 (R3) |
| 19 | Zustand store rollback test suite | Unit tests verifying optimistic updates and automatic state rollback on simulated 500 | M7 | Survey 3 (R3) |
| 20 | Round 2 Final Verification & Audit | Run npm run typecheck and npm run test; run forensic audit | M8 | Acceptance Criteria |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | M1: Verification Baseline | Vitest configuration, tsconfig paths, package.json scripts (typecheck, test), baseline tests | none | DONE |
| 2 | M2: Fix N+1 Database Inserts | PaperRepository.addPapers with db.transaction and INSERT OR IGNORE; update expand route; unit tests | M1 | DONE |
| 3 | M3: Fix Background Queue Data Loss | Add collectionId to retry_queue schema/migration, QueueRepository, expand route queueRetry, and EnrichmentJobProcessor persistence; unit tests | M1, M2 | DONE |
| 4 | M4: Final Verification & Audit | Run npm run typecheck, run npm run test, perform forensic audit and deliver victory report | M1, M2, M3 | DONE |
| 5 | M5 (Round 2 M1): Refactor rebuild-edges | Extend HttpClient with options & cache key; refactor rebuild-edges route to use HttpClient; integration tests | none | DONE |
| 6 | M6 (Round 2 M2): Fix Paper Insertion Race Condition | Atomic upsert in PaperRepository, refactor collection POST route, concurrency tests | none | DONE |
| 7 | M7 (Round 2 M3): Safe Optimistic UI Updates | Snapshot & rollback in graphStore.ts for addSeedPaper and removeNode; unit tests | none | IN_PROGRESS |
| 8 | M8 (Round 2 M4): Final Verification & Audit | Run full test suite, typecheck, forensic audit, final reporting | M5, M6, M7 | PLANNED |

## Interface Contracts

### PaperRepository
```typescript
static addPapers(
  papers: Array<{
    id: string;
    doi?: string;
    title: string;
    abstract?: string;
    authors?: any[];
    year?: number;
    publicationDate?: string;
    citationCount?: number;
    url?: string;
    venue?: string;
    [key: string]: any;
  }>,
  collectionId: string,
  status: string = 'recommended'
): void;

static addPaper(
  paper: any,
  collectionId: string,
  status: string = 'seed'
): void; // Delegates to addPapers([paper], collectionId, status)
```

### QueueRepository
```typescript
interface QueueItem {
  id: string;
  paperId: string;
  type: 'citations' | 'references' | 'both';
  status: 'pending' | 'processing' | 'completed' | 'failed';
  collectionId?: string;
  createdAt: string;
}

static addQueueItem(
  paperId: string,
  type: 'citations' | 'references' | 'both',
  collectionId?: string
): void;

static getPendingItems(limit: number): QueueItem[];
```

### Database Schema (retry_queue)
```sql
CREATE TABLE IF NOT EXISTS retry_queue (
  id TEXT PRIMARY KEY,
  paperId TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  collectionId TEXT,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
);
-- Migration:
-- ALTER TABLE retry_queue ADD COLUMN collectionId TEXT;
```

## Code Layout
- `package.json`: scripts and dependencies
- `vitest.config.mts`: Vitest runner configuration
- `tests/`: test files (`tests/baseline.test.ts`, `tests/domain/...`)
- `src/lib/db.ts`: SQLite database initialization and migrations
- `src/domain/repositories/PaperRepository.ts`: Paper database access & batched transactions
- `src/domain/repositories/QueueRepository.ts`: Retry queue repository with collectionId
- `src/domain/services/EnrichmentJobProcessor.ts`: Background job processing & persistence
- `src/api/expand/[id]/route.ts`: API route for paper expansion
- `src/domain/adapters/HttpClient.ts`: Rate-limited HTTP client with backoff and cache (M5)
- `src/api/collection/[id]/rebuild-edges/route.ts`: Rebuild citation edges route using HttpClient (M5)
- `src/api/collection/route.ts`: Collection paper addition endpoint with race-condition prevention (M6)
- `src/store/graphStore.ts`: Zustand store with safe optimistic updates and rollback (M7)
- `tests/integration/RebuildEdgesRoute.test.ts`: Integration tests for M5
- `tests/api/CollectionConcurrency.test.ts`: Concurrency tests for M6
- `tests/store/graphStoreRollback.test.ts`: Zustand rollback tests for M7
