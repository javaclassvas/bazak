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

Run on **2026-11-26** at commit `318685f`, model `gpt-6-luna`, reasoning effort `low`.

| Command | Result |
|---|---|
| `npm run check` | 67 fast tests (the count before the review fixes below; 75 now), 2 e2e scenarios and 13 live-API contract checks passed; types and lint clean |
| `npm run eval -- --repeat 3 --judge` | 75 of 75 runs passed (25 cases × 3). Median 3.0 s to the first cards, 4.1 s to the end of the reply |
| `npm run e2e:live` | 3 of 3 scenarios passed |

The relevance judge scored 244 shown cards: mean P(relevant) 0.85, 22 cards below 0.5. The judge is a warning, not a gate: on 32 hand-labelled pairs it agrees with the human 81% of the time, and every one of its errors is an under-score. Of the 22 flagged cards, 13 come from "a dress and matching shoes" and 6 from "What do you have from Apple?" — the two requests where calibration showed the judge under-scoring; all 22 passed the oracle checks.

After that run an independent review found four defects (Retry after a mid-turn model failure, a closing sentence that was stored but not streamed, `npm run check` failing on a fresh clone, a lost draft under React Strict Mode). They were fixed with tests, and `npm run check` was re-run on **2026-11-27** at commit `654179e` on a fresh clone: 75 fast tests, 2 e2e scenarios and 13 contract checks passed. Evals and the live browser run were not repeated after the fixes; the fixes do not touch the agent or its instructions.

Evals and the live browser run call a real model, so repeating them will not reproduce these numbers exactly. Earlier runs during development were 74/75, 73/75 and 75/75; the failures and what was done about each are in `DECISIONS.md` (F14).

## Architecture and framework choice

TypeScript end to end: Next.js 16 (App Router) with React on the client and the Vercel AI SDK 7 for the model loop. One language and one process serve the UI, the API and the SQLite file, which is all a local single-user app needs.

The SDK provides the stream protocol, the multi-step tool loop and typed tool parts in `useChat`. The parts the assignment is about are my own code: the two tools and the id allowlist, the search module, persistence, the request handler and the chat UI. A whole turn lives in one function (`runAgent`) that takes the model and the catalog as arguments, so the route, the CLI trace, the tests and the evals all run the same code.

Alternatives I rejected:

- **assistant-ui.** It ships a thread list and persistence adapters, which are exactly the parts this assignment asks me to reason about.
- **FastAPI + React with hand-rolled SSE.** Two runtimes and a hand-written stream protocol, with no gain for a task this size.

The SDK had a cost: its documented way to finish a reply after a disconnect stored a truncated message. A test found it; the stream is now split with `tee()` (DECISIONS F9).

## Retrieval strategy

The catalog API is weak: `/products/search` is a case-insensitive substring match on title and description, and there is no price or rating filter. "phone" returns 23 products including AirPods and a selfie stick; "cheap phone" returns nothing.

So retrieval has two steps. The model fills the arguments of `search_products` (text, one of the 24 category slugs, price range, sort, limit). The server then:

1. fetches candidates: `/products/category/{slug}` if a category is given, `/products/search?q=` for text only, `/products` otherwise, always with `limit=0`;
2. refines them locally in a pure function: price range, sort, slice (10 by default, 20 at most).

The API's own `sortBy`, `order`, `limit` and `skip` are not used: its `limit` would cut the list before the price filter runs. If a multi-word phrase matches nothing, each word is searched separately and the model is told the match was partial.

The model never writes a card. `search_products` returns candidates to the model only; `show_products` takes ids, accepts only ids a search returned in this conversation, and the server builds each card from catalog data. In one of three runs of "phones under $300" the model asked for an id the search had not returned; it was dropped and the four cards shown were correct.

- **Ambiguous** ("something cheap and cool"): show a small spread from two or three categories, then ask one question.
- **Off-catalog** ("a flight to Tokyo"): say the store does not carry it; no tool calls, no cards.
- **Multi-intent**: parallel searches, one titled group per thing.

Rejected: loading the whole catalog into memory or into the prompt. Both work at 194 products, but they skip the question of what to query and leave numeric filters to the model.

## Conversation and state

Conversations live in a SQLite file on the server, in two tables. A message is stored as the parts the UI renders, so history shows the cards as they were shown. The conversation id is in the URL.

The browser sends one new message and the id of the message it believes came before. The server loads the history itself and accepts only a user text message, so a client cannot forge tool results or prices. I rejected localStorage for that reason, and because quota, corruption and clearing would become my failure modes.

- **Storage full.** The user message is saved before the model is called. If that write fails the server answers 507 and does not call the model. If only the assistant message fails to save, the reply was already shown; it is missing after a reload and Retry is offered.
- **Corrupted.** An unreadable database file is renamed and a fresh one is created, with a notice. A single bad row is skipped and the rest loads.
- **Cleared mid-conversation.** If the tables are emptied, the next message's `lastMessageId` no longer matches: 409, nothing is written, and the UI offers a reload or a new chat. The same check catches a second tab. Deleting the `data/` folder under a running server is not detected (see limitations).

A tab closed mid-reply does not stop the turn: the server keeps reading the stream and stores the full reply.

## Evaluation

- **75 fast tests** (`npm test`): unit, integration and component tests with a scripted model and a catalog fixture. The scripted model misbehaves on purpose: shows ids it never searched, sends duplicates, searches forever.
- **2 browser scenarios** (`npm run e2e`) against a real server and real SQLite, with the scripted model.
- **13 contract checks** against the live catalog API, so I notice if the API stops matching my assumptions.
- **25 golden queries** (`npm run eval`) against the real model and a pinned catalog snapshot. Each case has an oracle over the catalog, and every turn is checked for invariants: cards equal catalog data, no price in the text that is not a shown price.
- **3 live browser scenarios** (`npm run e2e:live`) with the real model. Not part of the gate.

To see what each layer catches I planted ten defects and ran every suite against each (`npm run mutate`, DECISIONS F17). Deterministic tests caught the removed guards; the evals did not, because a well-behaved model never exercises a guard. The evals caught the prompt regressions; the deterministic tests cannot see a prompt change. Neither covers for the other.

What slips through:

- The relevance judge is a warning, not a gate. It agrees with my labels on 81% of 32 pairs, which is below the 84% that always answering "relevant" would score, and the figure is in-sample.
- Evals are 25 cases with one labeller and are not in the gate. Some oracles are soft.
- A price in the reply text is detected in evals, not prevented at runtime.
- The live browser run does not prove streaming; one integration test does.
- No load, latency-regression or accessibility tests.

## Known limitations

Today:

- About 3 s to the first cards and 4 s to the end of the reply. Two model steps before any card is the price of the two-tool design.
- Search quality is bounded by a substring API: no synonyms, no semantic match. Local filtering works only because the catalog is small enough to fetch with `limit=0`.
- "Those" in a follow-up can resolve to a product the model saw as a candidate but the user never saw as a card.
- An off-catalog refusal can mention goods the store does not have; nothing checks prose for product claims.
- A client can overwrite a stored user message by reusing its id. Tool results still cannot be forged.
- Deleting `data/` under a running server is not detected.
- Single process, single user, no auth; the one-reply-at-a-time lock is in memory.
- Prices in old conversations can be stale. A reload mid-reply waits rather than resuming the stream.

With another week:

- More labelled pairs and a judge validated on fresh labels, so it can become a gate.
- A real search backend behind the same tool contract, measured against the current path.
- Follow-ups restricted to products that were actually shown.
- A runtime guard on prices in the reply text.
- Resumable streams and a lock that survives more than one process.
