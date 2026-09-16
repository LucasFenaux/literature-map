# Literature Review Graph

An interactive, force-directed graph application for exploring, visualizing, and organizing academic citation networks. Discover related literature, trace citation paths across research topics, maintain personal notes, and export formatted citations.

---

## Getting Started

Choose the installation method that fits your workflow:

### Option 1: PhD Toolbox (Recommended)
Download and manage Literature Review Graph directly through the **[PhD Toolbox](https://github.com/LucasFenaux/phd-toolbox)** suite alongside other academic workflow tools.

### Option 2: Pre-built Binaries
Standalone executables for macOS, Linux, and Windows are available on the **[Releases](https://github.com/LucasFenaux/literature-review-graph/releases)** page. Download the binary for your operating system and run it directly—no Node.js or build tools required.

### Option 3: Run from Source
Requires **Node.js 18+** and **npm**:

```bash
# Clone repository
git clone https://github.com/LucasFenaux/literature-review-graph.git
cd literature-review-graph

# Install dependencies
npm install

# Start development server
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## Configuration & API Keys

### Semantic Scholar API Key (Heavily Recommended)
While the app works out-of-the-box via OpenAlex, **most features function best with Semantic Scholar**. Supplying a free **[Semantic Scholar API key](https://www.semanticscholar.org/product/api)** is heavily recommended. It unlocks significantly higher rate limits, faster bulk expansions, and broader citation coverage, which are crucial for building comprehensive paper graphs.

To configure your key, choose either:
- **In-App Settings (Easiest)**: Open the app, click **Settings** (gear icon) in the left sidebar, paste your API key, and click **Save**. This persists in your local database across restarts.
- **Environment Variable**: Add your key to `.env.local` in the project root:
  ```env
  SEMANTIC_SCHOLAR_API_KEY=your_key_here
  SEMANTIC_SCHOLAR_RATE_LIMIT=1
  ```

### Out-of-the-Box (Zero Configuration Fallback)
If no API key is provided, the application will still function immediately upon launch. Paper search, metadata retrieval, and basic citation/reference expansion will fall back to being powered entirely by the free and open **[OpenAlex API](https://openalex.org)**.

---

## Key Features

- **Interactive Force-Directed Graph**: Visualizes citation connections with `react-force-graph-2d` and `d3-force`. Seed papers and discovered related papers are color-coded for quick navigation.
- **Paper Search & DOI Lookup**: Search papers by keywords, title, author, or exact DOI using live OpenAlex queries.
- **Citation & Reference Expansion**: Expand individual papers or bulk-expand your entire collection to discover citing works and referenced literature.
- **Graph Filtering & Focus Mode**: Filter out peripheral nodes with the connection threshold slider, or focus on a specific paper and its immediate citation neighborhood.
- **Paper Details & Notes**: View abstracts, venues, and publication years. Write personal markdown notes that are saved locally per-paper.
- **Citation Export**: One-click copy for citations in BibTeX, APA, MLA, Chicago, and Harvard formats.
- **Local SQLite Storage & Backups**: All collections, graph nodes, and notes are stored locally in SQLite (`data/papers.db`). Includes automated 12-hour rolling backups and manual backup/restore from the Settings panel.

---

## Workflow Guide

1. **Create a Collection**: Click **+ New** in the sidebar to create a dedicated workspace for a research topic.
2. **Add Seed Papers**: Search for key foundational papers by title, author, or DOI and add them as seeds.
3. **Expand the Network**: Open any seed paper card and click **Load Citations** or **Load References**, or use **Bulk Load** to expand all seeds at once.
4. **Refine & Focus**: Use the minimum connection slider to hide weakly-connected papers, or select **Focus** on a node to isolate its cluster.
5. **Annotate & Cite**: Take notes on papers as you read them, view paper links/PDFs, and copy BibTeX citations into your reference manager.

---

## Development & Scripts

| Command | Description |
|---|---|
| `npm run dev` | Run Next.js frontend and Express backend concurrently |
| `npm run build` | Build the Next.js production bundle |
| `npm run start` | Start the production server |
| `npm run typecheck` | Run TypeScript compiler checks (`tsc --noEmit`) |
| `npm test` | Run test suite with Node's native test runner via `tsx` |
| `npm run build:exe` | Bundle standalone executables using `esbuild` and `pkg` |

---

## Tech Stack

- **Frontend**: [Next.js 16](https://nextjs.org) (App Router), [React 19](https://react.dev), [Zustand](https://github.com/pmndrs/zustand)
- **Visualization**: [react-force-graph-2d](https://github.com/vasturiano/react-force-graph), [d3-force](https://github.com/d3/d3-force)
- **Backend & Database**: Express, SQLite via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (stored in `data/papers.db`)
- **Data Providers**: [OpenAlex API](https://openalex.org) (fallback/search, no auth required), [Semantic Scholar API](https://www.semanticscholar.org/product/api) (primary for expansion, key heavily recommended)

---

## License

MIT License. See [LICENSE](LICENSE) for details.
