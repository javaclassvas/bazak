// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Chat } from '@/components/chat';
import { CLOSING_TEXT, createChatStream, isGenerating } from '@/lib/agent/chat-stream';
import { createScriptedModel, type ScriptedStep } from '@/lib/agent/mock-model';
import { createConversationStore, type ConversationStore } from '@/lib/db/conversations';
import { openDatabase } from '@/lib/db/index';
import { fixtureCatalog, fixtureProducts } from '../helpers/fixture';

/**
 * The real <Chat> component talking to the real request handler, in one process.
 * `fetch('/api/chat')` is routed straight into `createChatStream` with a scripted model, the pinned
 * catalog and an in-memory database. This is the layer where the browser's idea of a conversation and
 * the server's can disagree, which neither the server tests nor the component tests can see alone.
 */

vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; children: React.ReactNode; prefetch?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const CONV = 'conv-flow-0001';
const laptop = fixtureProducts.find((p) => p.category === 'laptops')!;
const search: ScriptedStep = { toolCalls: [{ toolName: 'search_products', input: { category: 'laptops' } }] };
const show: ScriptedStep = { toolCalls: [{ toolName: 'show_products', input: { title: 'Laptops', items: [{ id: laptop.id }] } }] };

let store: ConversationStore;
let requests: { messageId: string; lastMessageId: string | null }[];

function serveWith(script: ScriptedStep[]) {
  let call = 0;
  const model = createScriptedModel(() => script[call++] ?? { text: 'done' });
  const catalog = fixtureCatalog().catalog;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/chat')) {
      const body = JSON.parse(String(init?.body));
      requests.push({ messageId: body.message?.id, lastMessageId: body.lastMessageId });
      return createChatStream(body, { model: () => model, catalog, store });
    }
    return Response.json({ conversations: store.list() });
  });
}

const settled = () => waitFor(() => expect(isGenerating(CONV)).toBe(false));

async function send(text: string) {
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
}

beforeEach(() => {
  store = createConversationStore(openDatabase(':memory:').db);
  requests = [];
  Element.prototype.scrollIntoView = () => {};
  sessionStorage.clear();
});

afterEach(async () => {
  await settled();
  cleanup();
  vi.unstubAllGlobals();
});

describe('chat component against the real request handler', () => {
  it('shows cards and text for a normal reply, and the database holds the same reply', async () => {
    serveWith([search, show, { text: 'One laptop for you.' }]);
    render(<Chat id={CONV} initialMessages={[]} />);
    await send('show me laptops');

    expect(await screen.findByText('One laptop for you.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: laptop.title })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    await settled();
    expect(store.load(CONV).messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('Retry works after the model fails part-way through a turn', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    // First attempt: the search succeeds, then the provider fails. Second attempt succeeds.
    serveWith([search, { error: new Error('429 rate limited') }, search, show, { text: 'Second attempt worked.' }]);
    render(<Chat id={CONV} initialMessages={[]} />);
    await send('show me laptops');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('did not finish');
    await settled();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Second attempt worked.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: laptop.title })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/changed somewhere else/)).toBeNull();

    // The retry re-sent the same user message against the same predecessor, and was accepted.
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    await settled();
    expect(store.load(CONV).messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    log.mockRestore();
  });

  it('shows the closing sentence live when the model runs out of steps, not only after a reload', async () => {
    serveWith(Array.from({ length: 20 }, (): ScriptedStep => ({ toolCalls: [{ toolName: 'search_products', input: { query: 'zeppelin' } }] })));
    render(<Chat id={CONV} initialMessages={[]} />);
    await send('find a zeppelin');

    expect(await screen.findByText(CLOSING_TEXT.nothingShown)).toBeTruthy();
    await settled();
    const stored = store.load(CONV).messages[1].parts as { type: string; text?: string }[];
    expect(stored.at(-1)).toMatchObject({ type: 'text', text: CLOSING_TEXT.nothingShown });
  });

  it('tells the user the conversation moved on when the database is ahead of the page', async () => {
    serveWith([{ text: 'never reached' }]);
    store.saveMessage(CONV, { id: 'u-other', role: 'user', parts: [{ type: 'text', text: 'from another tab' }] }, 'from another tab');
    store.saveMessage(CONV, { id: 'a-other', role: 'assistant', parts: [{ type: 'text', text: 'reply' }] });
    render(<Chat id={CONV} initialMessages={[]} />);
    await send('hello');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('changed somewhere else');
    expect(screen.getByRole('button', { name: 'Reload conversation' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Start a new chat with this message' })).toBeTruthy();
    expect(store.load(CONV).messages).toHaveLength(2); // nothing written
  });
});

describe('carrying a message over into a new chat', () => {
  it('saves the unsent message when the user chooses to start a new chat', async () => {
    serveWith([{ text: 'never reached' }]);
    store.saveMessage(CONV, { id: 'u-other', role: 'user', parts: [{ type: 'text', text: 'x' }] }, 'x');
    render(<Chat id={CONV} initialMessages={[]} />);
    await send('my important question');
    fireEvent.click(await screen.findByRole('link', { name: 'Start a new chat with this message' }));
    expect(sessionStorage.getItem('copilot:draft')).toBe('my important question');
  });

  it('restores it into the input of the new chat, including under React Strict Mode', async () => {
    serveWith([]);
    sessionStorage.setItem('copilot:draft', 'my important question');
    // Strict Mode runs effects twice in development, which is how `npm run dev` runs the app.
    render(
      <StrictMode>
        <Chat id="conv-flow-0002" initialMessages={[]} />
      </StrictMode>,
    );
    await waitFor(() => expect((screen.getByLabelText('Message') as HTMLInputElement).value).toBe('my important question'));
    expect(sessionStorage.getItem('copilot:draft')).toBeNull(); // consumed once applied
  });
});
