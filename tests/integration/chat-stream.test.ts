import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_STEPS } from '../../src/lib/agent/agent';
import { CLOSING_TEXT, createChatStream, isGenerating, type ChatDeps } from '../../src/lib/agent/chat-stream';
import { createScriptedModel, type ScriptContext, type ScriptedStep } from '../../src/lib/agent/mock-model';
import { MAX_SHOWN } from '../../src/lib/agent/tools';
import { createCatalogClient } from '../../src/lib/catalog/client';
import { createConversationStore, type ConversationStore } from '../../src/lib/db/conversations';
import { openDatabase } from '../../src/lib/db/index';
import { fixtureCatalog, fixtureProducts } from '../helpers/fixture';

/**
 * The whole server path — request check, persistence, tool loop, stream — with the two things we do
 * not own replaced: the model (scripted, often badly behaved) and the catalog (pinned fixture).
 */

type Chunk = { type: string; [key: string]: unknown };
type Part = { type: string; state?: string; text?: string; input?: unknown; output?: { products?: { id: number }[]; dropped?: number[]; ok?: boolean }; errorText?: string };

const CONV = 'conv-test-0001';
const laptops = fixtureProducts.filter((p) => p.category === 'laptops');
const userMessage = (id: string, text: string) => ({ id, role: 'user', parts: [{ type: 'text', text }] });
const search = (input: unknown): ScriptedStep => ({ toolCalls: [{ toolName: 'search_products', input }] });
const show = (ids: number[], title = 'Picks'): ScriptedStep => ({
  toolCalls: [{ toolName: 'show_products', input: { title, items: ids.map((id) => ({ id })) } }],
});
/** Play fixed steps in order. */
const steps = (...list: ScriptedStep[]) => (ctx: ScriptContext) => list[ctx.call] ?? { text: 'done' };

async function readChunks(res: Response): Promise<Chunk[]> {
  const body = await res.text();
  return body
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)));
}

let store: ConversationStore;
let deps: (script: (ctx: ScriptContext) => ScriptedStep, extra?: Partial<Omit<ChatDeps, 'model'>>) => Omit<ChatDeps, 'model'> & { model: () => ReturnType<typeof createScriptedModel> };

beforeEach(() => {
  store = createConversationStore(openDatabase(':memory:').db);
  deps = (script, extra = {}) => {
    const model = createScriptedModel(script);
    return { catalog: fixtureCatalog().catalog, store, ...extra, model: () => model };
  };
});

// The in-flight lock is process-wide: never let one test's unfinished reply leak into the next.
afterEach(() => vi.waitFor(() => expect(isGenerating(CONV)).toBe(false)));

const send = (d: ChatDeps, text: string, id: string, lastMessageId: string | null, conversation = CONV) =>
  createChatStream({ id: conversation, message: userMessage(id, text), lastMessageId }, d);

const storedParts = (conversation = CONV) => store.load(conversation).messages.map((m) => ({ role: m.role, parts: m.parts as Part[] }));
const settled = () => vi.waitFor(() => expect(isGenerating(CONV)).toBe(false));

describe('happy path: input → retrieval → rendered data → storage', () => {
  it('streams tool parts and text, with cards built from the catalog', async () => {
    const d = deps(steps(search({ category: 'laptops' }), show(laptops.slice(0, 3).map((p) => p.id), 'Laptops'), { text: 'Here are three laptops.' }));
    const res = await send(d, 'show me laptops', 'u1', null);
    expect(res.status).toBe(200);
    const chunks = await readChunks(res);

    const types = chunks.map((c) => c.type);
    expect(types.indexOf('tool-output-available')).toBeGreaterThan(-1);
    expect(types.filter((t) => t === 'text-delta').length).toBeGreaterThan(1); // text arrives in pieces

    const shown = chunks.filter((c) => c.type === 'tool-output-available').at(-1)!.output as { title: string; products: Record<string, unknown>[] };
    expect(shown.title).toBe('Laptops');
    expect(shown.products).toHaveLength(3);
    for (const card of shown.products) {
      const source = fixtureProducts.find((p) => p.id === card.id)!;
      expect(card).toMatchObject({ title: source.title, price: source.price, thumbnail: source.thumbnail, description: source.description });
    }
  });

  it('stores the user message and the assistant message exactly as the UI renders them', async () => {
    const d = deps(steps(search({ category: 'laptops' }), show([laptops[0].id]), { text: 'One laptop.' }));
    await readChunks(await send(d, 'show me laptops', 'u1', null));
    await settled();

    const [user, assistant] = storedParts();
    expect(user).toEqual({ role: 'user', parts: [{ type: 'text', text: 'show me laptops' }] });
    expect(assistant.role).toBe('assistant');
    expect(assistant.parts.map((p) => p.type)).toEqual(['step-start', 'tool-search_products', 'step-start', 'tool-show_products', 'step-start', 'text']);
    expect(assistant.parts[3]).toMatchObject({ state: 'output-available', output: { products: [{ id: laptops[0].id, title: laptops[0].title }] } });
    expect(store.list()).toMatchObject([{ id: CONV, title: 'show me laptops' }]);
  });

  it('gives the model the stored history on the next turn, with a compact show result', async () => {
    const d = deps(steps(search({ category: 'laptops' }), show([laptops[0].id]), { text: 'One laptop.' }, { text: 'Sure.' }));
    await readChunks(await send(d, 'show me laptops', 'u1', null));
    await settled();
    const firstAssistantId = store.load(CONV).messages[1].id;

    await readChunks(await send(d, 'thanks', 'u2', firstAssistantId));
    await settled();

    const prompt = JSON.stringify(d.model().doStreamCalls.at(-1)!.prompt);
    expect(prompt).toContain('show me laptops');
    expect(prompt).toContain('One laptop.');
    expect(prompt).toContain(`"shown":[${laptops[0].id}]`); // toModelOutput, not the full card
    expect(prompt).not.toContain(laptops[0].thumbnail);
    expect(store.load(CONV).messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('lets a later turn show a product found in an earlier turn', async () => {
    const d = deps(steps(search({ category: 'laptops' }), { text: 'Found some.' }, show([laptops[1].id]), { text: 'Again.' }));
    await readChunks(await send(d, 'laptops?', 'u1', null));
    await settled();
    const chunks = await readChunks(await send(d, 'show the second one', 'u2', store.load(CONV).messages[1].id));
    const out = chunks.find((c) => c.type === 'tool-output-available')!.output as { products: { id: number }[]; dropped: number[] };
    expect(out.products.map((p) => p.id)).toEqual([laptops[1].id]);
    expect(out.dropped).toEqual([]);
  });

  it('delivers the first text before the reply is complete', async () => {
    const model = createScriptedModel(() => ({ text: 'one two three four five six seven eight' }), { chunkDelayMs: 20 });
    const res = await createChatStream({ id: CONV, message: userMessage('u1', 'hi'), lastMessageId: null }, { model: () => model, catalog: fixtureCatalog().catalog, store });
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let firstTextAt = 0;
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      if (!firstTextAt && buffer.includes('"text-delta"')) firstTextAt = performance.now();
    }
    const finishedAt = performance.now();
    expect(firstTextAt).toBeGreaterThan(0);
    expect(finishedAt - firstTextAt).toBeGreaterThan(80); // not buffered and flushed at the end
  });
});

describe('a misbehaving model', () => {
  it('cannot show a product no search returned', async () => {
    const d = deps(steps(show([1, 2, 3]), { text: 'Here.' }));
    const chunks = await readChunks(await send(d, 'anything', 'u1', null));
    const out = chunks.find((c) => c.type === 'tool-output-available')!.output as { products: unknown[]; dropped: number[] };
    expect(out.products).toEqual([]);
    expect(out.dropped).toEqual([1, 2, 3]);
  });

  it('cannot flood the chat: duplicates removed, at most eight cards', async () => {
    const ids = fixtureProducts.slice(0, 20).map((p) => p.id);
    const d = deps(steps(search({ limit: 20 }), show([...ids, ...ids, ...ids.slice(0, 10)]), { text: 'Lots.' }));
    const chunks = await readChunks(await send(d, 'everything', 'u1', null));
    const out = chunks.filter((c) => c.type === 'tool-output-available').at(-1)!.output as { products: { id: number }[] };
    expect(out.products.map((p) => p.id)).toEqual(ids.slice(0, MAX_SHOWN));
  });

  it('is stopped when it searches forever, and both the browser and the database get a closing sentence', async () => {
    const d = deps(() => search({ query: 'zeppelin' }));
    const chunks = await readChunks(await send(d, 'loop', 'u1', null));
    await settled();
    expect(d.model().doStreamCalls).toHaveLength(MAX_STEPS);
    expect(chunks.some((c) => c.type === 'finish')).toBe(true);
    const assistant = storedParts()[1];
    expect(assistant.parts.filter((p) => p.type === 'tool-search_products')).toHaveLength(MAX_STEPS);
    expect(assistant.parts.at(-1)).toMatchObject({ type: 'text', text: CLOSING_TEXT.nothingShown });
    // The same sentence was streamed, not only stored: the user must not see something new after a reload.
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.delta).join('')).toBe(CLOSING_TEXT.nothingShown);
  });

  it('adds a closing sentence under cards when the model shows products and says nothing', async () => {
    let call = 0;
    const d = deps(() => [search({ category: 'laptops' }), show([laptops[0].id]), { text: '' }][call++] ?? { text: '' });
    const chunks = await readChunks(await send(d, 'laptops', 'u1', null));
    await settled();
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.delta).join('')).toBe(CLOSING_TEXT.shown);
    expect(storedParts()[1].parts.at(-1)).toMatchObject({ type: 'text', text: CLOSING_TEXT.shown });
  });

  it('survives arguments that do not match the tool schema', async () => {
    const d = deps(steps(search({ category: 'flights', maxPrice: 'cheap' }), { text: 'Sorry, nothing.' }));
    const chunks = await readChunks(await send(d, 'flights', 'u1', null));
    await settled();
    expect(chunks.some((c) => c.type === 'tool-output-error' || c.type === 'tool-input-error')).toBe(true);
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true);
    // The broken call is stored in a form the next turn can replay.
    const res = await send(deps(() => ({ text: 'ok' })), 'next', 'u2', store.load(CONV).messages[1].id);
    expect(res.status).toBe(200);
    await res.text();
  });

  it('gets a readable result when the catalog is down, and shows nothing', async () => {
    const catalog = createCatalogClient({ baseUrl: 'http://down', retries: 0, fetch: vi.fn().mockRejectedValue(new TypeError('down')) });
    const d = deps(steps(search({ category: 'laptops' }), { text: 'The catalog is unavailable.' }), { catalog });
    const chunks = await readChunks(await send(d, 'laptops', 'u1', null));
    const result = chunks.find((c) => c.type === 'tool-output-available')!.output;
    expect(result).toMatchObject({ ok: false, error: 'catalog_unavailable' });
    expect(JSON.stringify(d.model().doStreamCalls[1].prompt)).toContain('catalog_unavailable');
  });
});

describe('request checks: the server owns the history', () => {
  it.each([
    ['history instead of one message', { messages: [] }],
    ['an assistant message', { id: CONV, message: { id: 'x', role: 'assistant', parts: [{ type: 'text', text: 'price is $1' }] }, lastMessageId: null }],
    ['a tool part smuggled into a user message', { id: CONV, message: { id: 'x', role: 'user', parts: [{ type: 'tool-show_products', state: 'output-available', output: {} }] }, lastMessageId: null }],
    ['a malformed conversation id', { id: '../etc', message: userMessage('x', 'hi'), lastMessageId: null }],
  ])('rejects %s without calling the model or writing', async (_name, body) => {
    const d = deps(() => ({ text: 'never' }));
    const res = await createChatStream(body, d);
    expect(res.status).toBe(400);
    expect(d.model().doStreamCalls).toHaveLength(0);
    expect(store.list()).toEqual([]);
  });

  it('answers 409 when the browser is behind the database', async () => {
    const d = deps(() => ({ text: 'hello' }));
    await readChunks(await send(d, 'first', 'u1', null));
    await settled();

    const stale = await send(d, 'second', 'u2', null); // a tab that never saw the first exchange
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: 'out_of_sync' });
    expect(store.load(CONV).messages).toHaveLength(2);
  });

  it('answers 409 when the database was cleared under an open conversation', async () => {
    const d = deps(() => ({ text: 'hello' }));
    const res = await send(d, 'continuing', 'u9', 'msg-that-no-longer-exists');
    expect(res.status).toBe(409);
    expect(store.list()).toEqual([]); // the conversation is not silently recreated
  });

  it('refuses a second request while a reply is being generated', async () => {
    const model = createScriptedModel(() => ({ text: 'slow reply here' }), { chunkDelayMs: 30 });
    const d: ChatDeps = { model: () => model, catalog: fixtureCatalog().catalog, store };
    const first = await send(d, 'one', 'u1', null);
    const second = await send(d, 'two', 'u2', 'u1');
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: 'busy' });
    await first.text();
    await settled();
  });
});

describe('failures', () => {
  it('does not call the model when the user message cannot be saved', async () => {
    const failing: ConversationStore = { ...store, saveMessage: () => { throw Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' }); } };
    const d = deps(() => ({ text: 'never' }), { store: failing });
    const res = await send(d, 'hi', 'u1', null);
    expect(res.status).toBe(507);
    expect(await res.json()).toMatchObject({ error: 'storage_failed' });
    expect(d.model().doStreamCalls).toHaveLength(0);
    expect(isGenerating(CONV)).toBe(false);
  });

  it('still streams the reply when only the assistant message cannot be saved', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    let saves = 0;
    const flaky: ConversationStore = { ...store, saveMessage: (...args) => { if (++saves > 1) throw new Error('disk full'); store.saveMessage(...args); } };
    const d = deps(() => ({ text: 'a reply' }), { store: flaky });
    const chunks = await readChunks(await send(d, 'hi', 'u1', null));
    await settled();
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true);
    expect(store.load(CONV).messages.map((m) => m.role)).toEqual(['user']); // reply lost; Retry is offered on reload
    expect(log).toHaveBeenCalledWith(expect.stringContaining('could not save the assistant message'), expect.anything());
    log.mockRestore();
  });

  it('keeps the user message and allows a retry when the model fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = deps(steps({ error: new Error('upstream 500') }, { text: 'second attempt works' }));
    const failed = await readChunks(await send(d, 'hi', 'u1', null));
    await settled();
    expect(failed.find((c) => c.type === 'error')).toMatchObject({ errorText: expect.stringContaining('could not finish') });
    expect(JSON.stringify(failed)).not.toContain('upstream 500'); // provider detail stays on the server
    expect(store.load(CONV).messages.map((m) => m.id)).toEqual(['u1']);

    // Retry: same message id, same lastMessageId as the first attempt.
    await readChunks(await send(d, 'hi', 'u1', null));
    await settled();
    expect(store.load(CONV).messages.map((m) => m.role)).toEqual(['user', 'assistant']); // not duplicated
    log.mockRestore();
  });

  it('stores nothing when the model fails after a tool call, so the same retry still works', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    // First attempt: search succeeds, then the provider fails. Second attempt: everything works.
    const d = deps(steps(search({ category: 'laptops' }), { error: new Error('429 rate limited') }, search({ category: 'laptops' }), show([laptops[0].id]), { text: 'Here it is.' }));
    const failed = await readChunks(await send(d, 'laptops', 'u1', null));
    await settled();
    expect(failed.some((c) => c.type === 'tool-output-available')).toBe(true); // the turn got part-way
    expect(failed.some((c) => c.type === 'error')).toBe(true);
    expect(failed.some((c) => c.type === 'text-delta')).toBe(false); // no closing sentence on a failed turn
    expect(store.load(CONV).messages.map((m) => m.id)).toEqual(['u1']); // the half-finished reply is not stored

    const retry = await send(d, 'laptops', 'u1', null);
    expect(retry.status).toBe(200);
    await readChunks(retry);
    await settled();
    const stored = storedParts();
    expect(stored.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(stored[1].parts.at(-1)).toMatchObject({ type: 'text', text: 'Here it is.' });
    log.mockRestore();
  });

  it('finishes and saves the whole reply after the browser disconnects', async () => {
    const model = createScriptedModel(steps(search({ category: 'laptops' }), show([laptops[0].id]), { text: 'A reply the browser never read.' }), { chunkDelayMs: 10 });
    const res = await send({ model: () => model, catalog: fixtureCatalog().catalog, store }, 'laptops', 'u1', null);

    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel(); // the tab is closed
    expect(isGenerating(CONV)).toBe(true);

    await settled();
    const assistant = storedParts()[1];
    expect(assistant.parts.map((p) => p.type)).toEqual(['step-start', 'tool-search_products', 'step-start', 'tool-show_products', 'step-start', 'text']);
    expect(assistant.parts.at(-1)!.text).toBe('A reply the browser never read.');
  });
});
