# Shopping Copilot

A chat assistant that finds products in the [DummyJSON](https://dummyjson.com/docs/products) catalog and shows them as cards inside the conversation. Take-home assignment.

## Setup and run

Requires **Node.js 22 or newer**.

```bash
npm ci
cp .env.example .env.local   # then put your OpenAI key in .env.local
npm run dev
```

Open http://localhost:3000.

**Without an API key:** `MOCK_LLM=1 npm run dev` starts the app with a scripted stand-in for the model. It answers queries that name a category ("show me laptops", "any smartphones?") and exercises the whole UI and storage path. It says nothing about answer quality.

Conversations are stored in `data/copilot.db` (SQLite, created on first use). Delete the `data/` folder to start clean.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | — | Required unless `MOCK_LLM=1` |
| `OPENAI_MODEL` | `gpt-6-luna` | Model id |
| `CATALOG_BASE_URL` | `https://dummyjson.com` | Catalog API |
| `DATABASE_PATH` | `data/copilot.db` | SQLite file |
| `MOCK_LLM` | — | `1` replaces the model with a scripted one |

### Commands

| Command | What it runs | Needs |
|---|---|---|
| `npm test` | Unit, integration and component tests (67) | nothing |
| `npm run e2e` | Two browser scenarios against a real server | `npx playwright install chromium` once |
| `npm run test:contract` | Checks the live DummyJSON API against the code's assumptions | network |
| `npm run check` | Types, lint and the three above | network, Playwright browser |
| `npm run eval` | 25 golden queries against the real model | API key |
| `npm run eval -- --repeat 3 --judge` | Same, three runs each, with the relevance judge | API key |
| `npm run eval:calibrate` | Relevance judge vs. hand labels | API key |
| `npm run mutate` | Applies deliberate defects and reports which suite notices | Playwright browser |
| `npm run trace -- "phones under 300"` | One query, printed step by step | API key |

### Where things are

```
src/lib/catalog/     DummyJSON client, search (API candidates + local refine), fixture emulation
src/lib/agent/       tools, instructions, the agent turn, the chat request handler, scripted model
src/lib/db/          SQLite store
src/app/             /api/chat, /api/conversations, /c/[id]
src/components/      chat, message parts, product cards, sidebar
tests/               unit, integration, components, contract
e2e/                 Playwright scenarios and the catalog stub
evals/               golden cases, checks, judge, calibration, pinned catalog snapshot
DECISIONS.md         decision log: what was chosen, rejected, tried and dropped, with numbers
```

## Architecture and framework choice

_To be written._

## Retrieval strategy

_To be written._

## Conversation and state

_To be written._

## Evaluation

_To be written._

## Known limitations

_To be written._
