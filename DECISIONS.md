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
- **Decided (starting point):** `low`. Same latency as `none` within noise, and it leaves the model room to reason when a turn needs it. Final level is re-checked against eval pass rate in stage 6.

### F3. Replaying stored history
A second turn that rebuilds the conversation from JSON (as the database will) works with tool parts, and with reasoning parts both kept and stripped (tested at `high`, where reasoning parts are reliably produced). The Responses API did not reject replayed reasoning parts.
- **Decided:** do not keep them. Reasoning summaries are switched off at the provider (`reasoningSummary: null`); we neither show nor store them.

### F4. Things the traces surfaced
- "laptops under 1000" correctly returns nothing: the cheapest laptop in the catalog costs more. The assistant echoed the user's budget ("under $1,000") in its text. The planned eval invariant "every money amount in the text equals a shown product's price" must therefore allow amounts taken from the user's own message.
- The model asked to show "the second one again" re-used an id from the earlier turn's search results, which is the case the `show_products` allowlist has to permit (ids seen anywhere in this conversation, not only in the current turn).

## Stage 2 findings (2026-11-24)

### D5. Search is one path: API for candidates, then a pure `refine`
`fetchCandidates` picks one endpoint (`/products/category/{slug}`, `/products/search?q=`, or `/products`), always with `limit=0&select=…`. `refine` then applies price range, sort and slice locally.
- The API's own `sortBy`, `order`, `limit`, `skip` are deliberately unused: its `limit` would cut the list before our price filter runs.
- Category + text query is intersected locally with a single API call, because the API cannot combine them.
- A multi-word phrase that matches nothing is retried word by word (stopwords removed, at most 4 words, in parallel) and ranked by number of words matched. The model is told the match was partial.
- Categories are a committed constant, not fetched at runtime. The live-API contract test (stage 5) is what catches drift.

### D6. `show_products` allowlist
Only ids returned by a search in this conversation can be shown: the current request's results plus ids found in stored tool outputs of earlier turns. Ids from earlier turns are hydrated with `GET /products/{id}`. Unknown ids are dropped and reported back to the model. At most 8 cards, duplicates removed. A `reason` containing a price or percentage is discarded.
- The model receives only `{ shown, dropped }` for this tool (`toModelOutput`); the full cards go to the UI and the database.

### F5. Golden queries, first results
`npm run eval`: real model, real agent code, pinned catalog (`evals/fixture/catalog.json`, 194 products captured 2026-11-24). Ten cases; each has an oracle predicate over the fixture, and the checks are set relations: shown ⊆ oracle, and shown ≥ min(3, |oracle|). Assertions read the stored assistant message, i.e. what the UI would render.

| Run | Result |
|---|---|
| 1 × each | 10/10 |
| 3 × each | 30/30 on gating checks; the allowlist fired once |

- **The allowlist caught a real hallucinated id.** In one of three runs of "phones under $300" the model asked to show id 126, which the search had not returned. The server dropped it; the four cards shown were correct. `no dropped ids` is therefore a *warning*, not a gate: the guard is the product behaviour, and how often it fires is a metric.
- **Open:** whether a dropped id should stay a warning or fail the case.

### F6. First mutation: removing the price filter
Deleting the `maxPrice` filter from `refine`:
- **Unit tests: caught** (2 failures).
- **Live evals: NOT caught.** Both budget cases still passed, because the model sees candidate prices and filters them itself.

The model masks retrieval bugs. Evals alone would have shipped this regression; deterministic tests are what guard the retrieval layer. This goes into the README's "what slips through".

### F7. Prompt changes since stage 1
- Multi-intent: instructions now ask for parallel searches and one `show_products` call per intent. Result: two parallel searches and two titled groups (was sequential searches and one group).
- Ambiguous requests: current default is "a small spread of well-rated, affordable picks from two or three categories as separate groups, then one narrowing question". **Open — this is a product decision.**

## Stage 3 findings (2026-11-24)

### D7. Ambiguous requests: show, then ask
Decided: for a vague request the assistant shows a small spread of well-rated, affordable picks from two or three categories as separate groups, then asks one narrowing question.
- **Rejected — ask first, show nothing:** more precise from the second turn on, but the first answer is empty. In shopping an empty answer costs more than an imperfect one.
- Guarded by the `ambiguous` golden case: cards within a price cap, at least two groups, and a question in the text.

### D8. How a message is rendered
An assistant message is rendered part by part, in the order the parts streamed:
- `tool-search_products` → one quiet status line ("Searching smartphones under $300…" → "Searched … · 9 found"). Searches are not results; the line only explains the wait.
- `tool-show_products` → skeleton cards while the call runs, then a titled grid. The skeleton count comes from the number of ids the model asked for.
- text → plain paragraph.

So the order on screen is status → cards → text, and cards appear as soon as `show_products` returns, before the model writes its sentence.
- Card fields: thumbnail, brand (when present), title, two-line description, the model's reason, price, rating, and a stock badge only when the item is not "In Stock".
- **Not shown — discount.** The catalog has `discountPercentage`, but the API does not say whether `price` is before or after it. Showing a crossed-out price would be a claim we cannot back.
- Stream errors reach the browser as a fixed sentence; details go to the server log. The chat shows a Retry button.

### F8. Browser check
Run by hand against the live API on the dev server: "Phones under $300" (one group, six cards, all images loaded), "a flight to Tokyo" (no tool calls, no cards), "a dress and matching shoes" (two parallel searches, two titled groups). No console errors.
- **Interim:** this stage has no persistence. The browser still sends the whole history; stage 4 moves the source of truth to the server.
