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

Conversations are stored in `data/copilot.db` (SQLite, created on first use). To start clean, stop the server and then delete the `data/` folder. Deleting it under a running server is not detected: the process keeps writing to the removed file and everything is gone after a restart.

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
| `npm test` | Unit, integration and component tests (75) | nothing |
| `npm run e2e` | Two browser scenarios against a real server | `npx playwright install chromium` once |
| `npm run test:contract` | Checks the live DummyJSON API against the code's assumptions | network |
| `npm run check` | Types, lint and the three above | network, Playwright browser |
| `npm run e2e:live` | Three browser scenarios with the real model and the live catalog | API key, Playwright browser |
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

## Latest verification run

Run on **2026-11-26** at commit `8393ce8`, model `gpt-6-luna`, reasoning effort `low`.

| Command | Result |
|---|---|
| `npm run check` | 67 fast tests, 2 e2e scenarios and 13 live-API contract checks passed; types and lint clean |
| `npm run eval -- --repeat 3 --judge` | 75 of 75 runs passed (25 cases × 3). Median 3.0 s to the first cards, 4.1 s to the end of the reply |
| `npm run e2e:live` | 3 of 3 scenarios passed |

The relevance judge scored 244 shown cards: mean P(relevant) 0.85, 22 cards below 0.5. The judge is a warning, not a gate: on 32 hand-labelled pairs it agrees with the human 81% of the time, and every one of its errors is an under-score. Of the 22 flagged cards, 13 come from "a dress and matching shoes" and 6 from "What do you have from Apple?" — the two requests where calibration showed the judge under-scoring; all 22 passed the oracle checks.

After that run an independent review found four defects (Retry after a mid-turn model failure, a closing sentence that was stored but not streamed, `npm run check` failing on a fresh clone, a lost draft under React Strict Mode). They were fixed with tests, and `npm run check` was re-run on **2026-11-27** at commit `b4cd5c3` on a fresh clone: 75 fast tests, 2 e2e scenarios and 13 contract checks passed. Evals and the live browser run were not repeated after the fixes; the fixes do not touch the agent or its instructions.

Evals and the live browser run call a real model, so repeating them will not reproduce these numbers exactly. Earlier runs during development were 74/75, 73/75 and 75/75; the failures and what was done about each are in `DECISIONS.md` (F14).

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
