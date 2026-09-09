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

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | M1: Verification Baseline | Vitest configuration, tsconfig paths, package.json scripts (typecheck, test), baseline tests | none | DONE |
| 2 | M2: Fix N+1 Database Inserts | PaperRepository.addPapers with db.transaction and INSERT OR IGNORE; update expand route; unit tests | M1 | DONE |
| 3 | M3: Fix Background Queue Data Loss | Add collectionId to retry_queue schema/migration, QueueRepository, expand route queueRetry, and EnrichmentJobProcessor persistence; unit tests | M1, M2 | PLANNED |
| 4 | M4: Final Verification & Audit | Run npm run typecheck, run npm run test, perform forensic audit and deliver victory report | M1, M2, M3 | PLANNED |

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
