# Decision log

Working log of design decisions: what was chosen, what was rejected, what was tried and dropped.
Numbers are from single runs unless stated otherwise — treat them as indicative, not as benchmarks.

## Decided

### D1. Framework: Next.js App Router + Vercel AI SDK, hand-written UI
- **Why:** one TypeScript runtime; the SDK handles the streaming protocol and the tool loop, which are not what this assignment is about; chat UI, conversation list and persistence stay in our own code, where the interesting decisions are.
- **Rejected — assistant-ui:** ships the thread list and persistence adapters ready-made. Those are exactly the parts the assignment asks us to reason about.
- **Rejected — FastAPI + React with hand-rolled SSE:** two runtimes and a hand-written stream protocol for no gain in this task.
- **Open:** which two alternatives to name in the README, and whether to spike one of them for first-hand evidence.

### D2. Persistence: SQLite on the server, conversation id in the URL
- **Why:** the server is the single source of truth; a reply is saved even if the tab closes mid-stream; clearing browser storage loses nothing.
- **Rejected — localStorage / IndexedDB:** quota, corrupted entries and user-cleared storage become our failure modes. Client-held history would also let a client forge tool results (fake prices) that the model then trusts.

### D3. Two tools: `search_products` (candidates, model-only) and `show_products` (ids only)
- **Why:** the server builds the cards from API data, so the model cannot invent a price, title or image; exploratory searches never appear as widgets.
- **Rejected — render everything the search returns:** the API search is a literal substring match (`phone` returns AirPods and selfie sticks), so its noise would land in the UI.
- **Rejected — rerank with the Decisions API at runtime:** one more network round trip before the cards appear. Kept for evals instead.
- **Cost:** one extra model step. Measured below.

### D4. Search execution: the API returns candidates per query, refinement is local
- **Why:** the API has no price filter, and its `limit` would apply before ours, so price range, sort and slice run locally over the candidate set. Candidate generation stays on the API because that is the part that has to scale with a real merchant catalog.
- **Rejected — snapshot the whole catalog (194 items) and search in memory:** simpler and faster at this size, but it sidesteps the question of what to query, and a live merchant catalog cannot be downloaded wholesale.
- **Rejected — put the whole catalog in the prompt (~65 KB):** no retrieval step to audit, and exact numeric filters would be left to the model.

## Stage 1 findings (2026-11-24)

### F1. SDK 7 API, verified against the installed package
`ai@7.0.181`, `@ai-sdk/openai@4.0.122`. Confirmed by type-check and by running `scripts/trace.ts`:
`streamText` with `instructions`, `stopWhen: isStepCount(n)`, `toUIMessageStream({ stream: result.stream, originalMessages, onEnd })`, `validateUIMessages`, `convertToModelMessages` (async), `providerOptions.openai.reasoningEffort`. `openai('gpt-6-luna')` goes through the Responses API. The package ships its docs in `node_modules/ai/docs`.

### F2. Reasoning effort vs latency (one run per cell, ms)

| Query | Effort | First tool call | Cards visible | First text | Total | Reasoning tokens |
|---|---|---|---|---|---|---|
| phones under 300 | none | 1142 | 3786 | 4595 | 5507 | 0 |
| | low | 1845 | 4487 | 5124 | 5731 | 0 |
| | medium | 1713 | 6581 | 7778 | 8735 | 75 |
| something cheap and cool | none | 1163 | 4028 | 4920 | 5723 | 0 |
| | low | 1047 | 3167 | 3872 | 4649 | 0 |
| | medium | 2444 | 5049 | 6090 | 6762 | 43 |
| a flight to Tokyo | none | — | — | 2147 | 3128 | 0 |
| | low | — | — | 1549 | 2087 | 21 |
| | medium | — | — | 1567 | 2149 | 29 |
| a dress and matching shoes | none | 1217 | 5524 | 6294 | 7076 | 0 |
| | low | 901 | 4536 | 5330 | 6096 | 0 |
| | medium | 2602 | 7604 | 9738 | 10518 | 105 |

- `none` and `low` are indistinguishable within noise; `low` usually spends zero reasoning tokens on tool turns. `medium` adds roughly 2–3 s before the cards.
- Off-catalog ("a flight to Tokyo") was handled with no tool call at every level.
- All levels chose `category` over free-text `query` when a category fit.
- **Multi-intent:** at `none`/`low` the two searches ran in separate steps (4 steps); at `medium` they ran in parallel (3 steps). At every level both intents ended up in a single `show_products` group. Both are prompt issues to address in stage 2.
- **Open:** effort level. Final choice should come from eval pass rate vs latency in stage 6; this table only sets the starting point.

### F3. Replaying stored history
A second turn that rebuilds the conversation from JSON (as the database will) works with tool parts, and with reasoning parts both kept and stripped (tested at `high`, where reasoning parts are reliably produced). The Responses API did not reject replayed reasoning parts.
- **Open:** keep or strip reasoning parts before saving. Keeping them is not required for correctness; stripping keeps stored history and replayed input smaller.

### F4. Things the traces surfaced
- "laptops under 1000" correctly returns nothing: the cheapest laptop in the catalog costs more. The assistant echoed the user's budget ("under $1,000") in its text. The planned eval invariant "every money amount in the text equals a shown product's price" must therefore allow amounts taken from the user's own message.
- The model asked to show "the second one again" re-used an id from the earlier turn's search results, which is the case the `show_products` allowlist has to permit (ids seen anywhere in this conversation, not only in the current turn).
