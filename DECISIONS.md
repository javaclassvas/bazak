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

## Stage 4 findings (2026-11-24)

### D9. Storage layout
SQLite via `better-sqlite3`, no ORM. Two tables: `conversations(id, title, created_at, updated_at)` and `messages(conversation_id, id, role, parts JSON, seq, created_at)`. A message is stored as its `UIMessage` parts, i.e. exactly what the UI renders.
- **Rejected — an ORM (Prisma, Drizzle):** two tables and five statements do not justify a schema toolchain.
- **Rejected — `node:sqlite`:** no native dependency, but still experimental on Node 22.
- The conversation row is created in the same transaction as its first message, so opening "New chat" and leaving writes nothing.
- Saving a message is an upsert on `(conversation_id, id)`: a retried request or a late save cannot duplicate it.
- Title = first user message, collapsed to one line and cut to 60 characters. No extra model call.

### D10. The server owns the history
The browser sends `{ id, message, lastMessageId }`: one new user message and the id of the message it believes precedes it. The server loads history from SQLite and never accepts history from the client.
- Only `role: "user"` text messages are accepted. A request carrying an assistant message or tool output is rejected with 400, so a client cannot inject a fake tool result.
- `lastMessageId` must equal the last stored message id, otherwise **409 `out_of_sync`** and nothing is written. This one check covers: the database was cleared mid-conversation, the conversation continued in another tab, and history rows were lost. The UI offers "Reload conversation" or "Start a new chat with this message".
- The user message is saved **before** the model is called. If that write fails (disk full, read-only file) the answer is **507 `storage_failed`** and the model is not called.
- A retry re-sends a user message that is already the last stored one; the server recognises it by id and does not insert it twice. After a reload, a conversation ending in a user message shows "This message did not get a reply" with Retry.
- One reply per conversation at a time, tracked in process memory: a second request gets **409 `busy`**.

### F9. A disconnect stored a truncated reply — found by testing, fixed
The SDK guide's pattern for surviving a closed tab is `result.consumeStream()`. Tested by cutting a request after 1.5 s:
- **With `consumeStream()` only:** the stored reply was cut off after the search step, and our no-text fallback sentence was appended to it. The disconnect ended the UI stream early and `onEnd` saved what existed at that moment.
- **Fix:** the UI stream is split with `tee()`. One branch goes to the browser, the other is drained on the server. Cancelling the browser branch no longer ends the stream.
- **After the fix, same test:** the full reply (search, three cards, text) was in the database about 4 s after the disconnect; meanwhile the page showed "Finishing the previous reply…" and a second request got 409 `busy`.
- Not done: resumable streams. A reload mid-reply shows a waiting state and reloads until the reply is saved; it does not re-attach to the live stream.

### F10. Failure behaviour, as built
| Situation | Behaviour | Verified by |
|---|---|---|
| Browser storage cleared | Nothing lost; state is on the server, id in the URL | by design |
| Database cleared, or conversation continued elsewhere | 409 `out_of_sync`, nothing written | manual request |
| Forged assistant message / malformed body | 400, nothing written | manual request |
| Database file unreadable at startup | Renamed to `*.corrupt-<time>`, fresh database, notice in the sidebar | unit test |
| One message row with unreadable JSON | Row skipped, the rest loads, notice in the chat | unit test |
| Tab closed mid-reply | Reply completes and is saved | manual test (F9) |
| Disk full on the user message | 507, model not called | **not yet tested** |
| Disk full on the assistant message | Logged; the reply was seen but is missing after reload | **not yet tested** |

### F11. Next.js 16 keeps the previous route mounted but hidden
After client-side navigation the previous conversation's DOM is still present, hidden. It is not a visual defect, but selectors in e2e tests must target visible elements, and a conversation revisited without a reload shows its in-memory state. The `lastMessageId` check is what catches that state being stale.

## Stage 5 findings (2026-11-24)

### D11. History shows a snapshot of the cards
Decided: a stored conversation shows the cards as they were when shown, not re-read from the catalog.
- **Why:** a conversation is a record of what the user saw; it opens without calling the catalog; a product that has since disappeared needs no special case.
- **Rejected — re-hydrate on open:** fresher prices, but history stops being a record, opening a chat depends on the catalog being up, and removed products need their own UI.
- **Consequence:** a price in an old conversation can be stale. Freshness belongs at the moment of purchase, which this app does not have.

### D12. Test layers and what each one owns
| Layer | Command | Replaced | Owns |
|---|---|---|---|
| Unit (38) | `npm test` | catalog → fixture | endpoint routing, price/sort/limit, word fallback, allowlist, reason filter, SQLite store, corrupt file and row |
| Integration (21) | `npm test` | model → scripted, catalog → fixture | the whole server path: request checks, persistence, tool loop, stream, failures |
| Components (7) | `npm test` | — (jsdom) | a tool output becomes the right DOM: fields, missing data, broken image, skeleton, order of parts |
| E2E (2) | `npm run e2e` | model → `MOCK_LLM=1`, catalog → local stub | a real browser on the real server and real SQLite: send, cards, reload, new chat, list, resume, stale tab |
| Contract (13) | `npm run test:contract` | nothing | the live API still behaves as the code and the fixture assume |
| Evals (10 cases) | `npm run eval` | catalog → fixture | the real model's behaviour |

`npm test` needs neither network nor key and runs in about a second.

- The integration model is scripted to misbehave: shows ids it never searched, sends duplicates and 30 ids, searches forever, passes arguments that break the schema. The point of these tests is that the server holds its guarantees whatever the model does.
- The contract test compares the emulated API with the live one query by query. Without it, every test that runs on the fixture would only prove agreement with our own emulation.
- **The seam that no test crosses:** the real model and the real browser never meet in one run. Evals assert on the stored assistant message; e2e renders stored messages from a scripted model. What joins them is one shared schema for the `show_products` output.

### F12. Mutations run so far
| Change | Caught by |
|---|---|
| Price filter removed from `refine` | unit (2 failures). **Not** by live evals: the model filters by itself |
| Server-side stream drain removed | integration (1 failure) |
| `lastMessageId` check removed | integration (1 failure) |

### F13. Things the tests surfaced
- **Test isolation:** the in-flight lock is process-wide. One test leaving a reply unfinished made the next one pass for the wrong reason (it got `busy` instead of reaching the code under test). Fixed by waiting for the lock after every test.
- **`busy` is reachable by a real user:** in the two-tab e2e scenario the cards appear before the reply ends, and sending from the other tab at that moment answers 409 `busy`. The chat shows "A reply is still being generated" with Retry.
- Both disk-full paths are now covered by integration tests (user message → 507 and no model call; assistant message → reply still streams, loss is logged).
- `MOCK_LLM=1` also serves as a way to click through the app without an API key.

## Stage 6 findings (2026-11-24)

### D13. What gates a submission
`npm run check`: type-check, lint, the fast suite, e2e, and the live-API contract test.
- **Evals are not in the gate.** They are non-deterministic and spend API budget. They are run on purpose and their results are published, not used as a pass/fail condition.

### F14. Full eval: 25 cases × 3 runs
Cases cover direct, budget, ranking, off-catalog (incl. a plausible missing category and a mixed request), ambiguous, multi-intent (2 and 3 things), multi-turn, small talk, Russian, a typo, a prompt-injection attempt and a dead catalog.

| Run | Effort | Runs passed | Median to cards | Median total |
|---|---|---|---|---|
| A (before prompt fix) | low | 74/75 | 2878 ms | 4060 ms |
| B (after prompt fix) | low | 73/75 | 3018 ms | 4061 ms |
| C (after prompt fix) | none | 75/75 | 3710 ms | 5214 ms |

Failures, each seen once in three runs of its case:
- **Run A, "wireless earphones": the text said "I found these wireless earphones:" and no cards were shown.** The model searched, then answered without calling `show_products`. A real defect: the reply promises something the UI does not contain. Fix: an instruction to call `show_products` before writing and never to announce results that are not shown. Not seen again in runs B and C (6 runs of that case) — which is weak evidence, not proof.
- **Run B, "something cheap and cool": one group instead of two or more.** A deviation from D7, one run in three.
- **Run B, "cheaper ones": two phones shown, check wanted three.** The model picked a $200 ceiling, which leaves two phones. The answer was right and the check was wrong; `minShown` for that case is now 1. An eval that fails correct answers teaches you to ignore it.

Not a single run produced an ungrounded price in text, a card that differs from the catalog, cards for an off-catalog request, or a product named while the catalog was down.

- **Effort: these runs do not separate `none` from `low`.** 75/75 vs 73/75 with one of the two failures being a check bug; `none` was slower here and faster in stage 1. With this sample size both differences are noise. **Open:** final effort level. No evidence to move off `low`.

### F15. The relevance judge needed a second version before it measured anything
Judge: Decisions API, one Boolean question per shown card, answer is P(relevant) (`evals/judge.ts`). Reported as a warning, never as a gate.
- **V1 scored each card against the whole request.** A laptop shown for "a laptop, a men's watch and sunglasses" got 0.34–0.49; a perfume shown for "exactly two fragrances" got 0.03; the top-rated skin-care product got 0.38 for "which has the best rating". 41 of 247 cards fell below 0.5 while the oracle checks passed.
- **V2** tells the judge it is looking at one card of several, that matching one of several requested things is enough, and that constraints on the set (count, cheapest, best) are not its job. On the 32 calibration pairs V1 called 11 relevant and V2 calls 21; pairs the judge is unsure about (0.2–0.8) dropped from 17 to 9.
- **V2 is still questionable** in places I would not sign off on myself: "matching shoes" for a dress score 0.06–0.30, and an Apple HomePod scores 0.23 for "What do you have from Apple?".
- **Open — calibration.** `evals/calibration/pairs.json` has 32 request–product pairs with `"relevant": null`. Once they are labelled by hand, `npm run eval:calibrate` reports agreement and lists every disagreement. Until then the judge's numbers are unvalidated and must not be quoted as quality.
- The judge is the same model family as the system it judges. Agreement with human labels is the only thing that makes it evidence.

### F16. Judge calibration against human labels
32 request–product pairs labelled by hand (27 relevant, 5 not), without sight of the judge's answers. `npm run eval:calibrate`.

| Judge | Agreement | Says "not relevant", human disagrees | Says "relevant", human disagrees |
|---|---|---|---|
| V1 | 50% (16/32) | 16 | 0 |
| V2 | 81% (26/32) | 6 | 0 |

- The judge rejected all five pairs the human rejected (over-budget phone, charger for a phone request, sunglasses outside the price range, the fruit for a lipstick request, a tablet for a laptop request).
- All six V2 errors are under-scoring. Three are shoes for "a dress and matching shoes" (0.06, 0.07, 0.30): a consistent blind spot on the second half of a compound request. The other three sit near the threshold or are arguable (0.45, 0.44, 0.23).
- **Decided: the judge stays a warning, not a gate.** It is wrong one time in five.
- **Not done on purpose: a V3 tuned on these pairs.** Fixing the instructions against the same 32 pairs and then measuring on them would be fitting to the test set. A V3 needs fresh labels.
- One of the "deliberately wrong" pairs I wrote (AirPods for "wireless earphones") was labelled relevant, correctly. The judge agreed with the human, not with me.
- Limits: 32 pairs, one labeller, only 5 negatives.

## Stage 7 findings (2026-11-24)

### F17. Mutation table
`npm run mutate -- --evals`: one deliberate defect at a time, every suite run against it. Evals were run once per mutation, so a "missed" in that column is one sample of a non-deterministic check.

| Defect | Fast suite | E2E | Live evals |
|---|---|---|---|
| `show_products` accepts any id (allowlist removed) | **caught** | missed | missed |
| `maxPrice` ignored | **caught** | missed | missed |
| `category` is a free string, not an enum | **caught** (after a test was added) | missed | missed |
| Card price rounded instead of copied | **caught** | **caught** | **caught** |
| Prompt no longer forbids prices in text | missed | missed | **caught** (`ambiguous`, `injection-price-in-text`) |
| Prompt has no off-catalog rule | missed | missed | **caught** (`budget-miss`, `off-catalog`, `off-catalog-plausible`) |
| Reply buffered, not streamed | **caught** | missed | n/a |
| Server stops reading on disconnect | **caught** | missed | n/a |
| `lastMessageId` not checked | **caught** | **caught** | n/a |
| Server accepts assistant messages from the browser | **caught** | missed | n/a |

What the table says:
- **Guards are tested by deterministic tests, behaviour by evals, and neither covers for the other.** Evals missed the removed allowlist and the removed price filter: a well-behaved model does not exercise a guard, so removing it changes nothing you can observe. Unit and integration tests cannot see a prompt change at all.
- **E2E catches little that the fast suite does not.** With a scripted model it proves wiring (browser ↔ server ↔ database), not logic. It earns its place on the reload/list/resume path, which nothing else runs in a browser.
- **The category enum had no test.** The mutation survived every suite; a made-up slug gets HTTP 200 and an empty list from the API, which reads as "nothing in stock". A unit test now pins the schema.
- **`n/a` is a real gap, not a formality:** evals call the agent directly, so nothing about HTTP, streaming to a browser, or persistence is exercised with the real model.
