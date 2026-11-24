import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createConversationStore, titleFrom } from '../../src/lib/db/conversations';
import { openDatabase } from '../../src/lib/db/index';

const user = (id: string, text: string) => ({ id, role: 'user' as const, parts: [{ type: 'text', text }] });
const assistant = (id: string, text: string) => ({ id, role: 'assistant' as const, parts: [{ type: 'text', text }] });

function memoryStore() {
  let clock = 1000;
  const { db } = openDatabase(':memory:');
  return { db, store: createConversationStore(db, () => clock++) };
}

describe('conversation store', () => {
  it('creates the conversation with its first message and keeps message order', () => {
    const { store } = memoryStore();
    expect(store.list()).toEqual([]);
    store.saveMessage('conv-0001', user('u1', 'phones under 300'), 'phones under 300');
    store.saveMessage('conv-0001', assistant('a1', 'Here you go'));
    store.saveMessage('conv-0001', user('u2', 'cheaper'));

    expect(store.list()).toMatchObject([{ id: 'conv-0001', title: 'phones under 300' }]);
    expect(store.load('conv-0001').messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2']);
  });

  it('lists the most recently active conversation first', () => {
    const { store } = memoryStore();
    store.saveMessage('conv-0001', user('u1', 'first'), 'first');
    store.saveMessage('conv-0002', user('u1', 'second'), 'second');
    store.saveMessage('conv-0001', assistant('a1', 'reply'));
    expect(store.list().map((c) => c.id)).toEqual(['conv-0001', 'conv-0002']);
  });

  it('saving the same message twice updates it instead of duplicating', () => {
    const { store } = memoryStore();
    store.saveMessage('conv-0001', user('u1', 'hi'), 'hi');
    store.saveMessage('conv-0001', assistant('a1', 'draft'));
    store.saveMessage('conv-0001', assistant('a1', 'final'));
    const { messages } = store.load('conv-0001');
    expect(messages).toHaveLength(2);
    expect(messages[1].parts).toEqual([{ type: 'text', text: 'final' }]);
  });

  it('keeps conversations apart and returns nothing for an unknown id', () => {
    const { store } = memoryStore();
    store.saveMessage('conv-0001', user('u1', 'a'), 'a');
    store.saveMessage('conv-0002', user('u1', 'b'), 'b');
    expect(store.load('conv-0002').messages).toHaveLength(1);
    expect(store.load('missing-id')).toEqual({ messages: [], unreadable: 0 });
  });

  it('skips a row with unreadable JSON and still loads the rest', () => {
    const { db, store } = memoryStore();
    store.saveMessage('conv-0001', user('u1', 'one'), 'one');
    store.saveMessage('conv-0001', assistant('a1', 'two'));
    store.saveMessage('conv-0001', user('u2', 'three'));
    db.prepare("UPDATE messages SET parts = '{not json' WHERE id = 'a1'").run();

    const loaded = store.load('conv-0001');
    expect(loaded.unreadable).toBe(1);
    expect(loaded.messages.map((m) => m.id)).toEqual(['u1', 'u2']);
  });

  it('derives a short single-line title', () => {
    expect(titleFrom('  hello\n  world ')).toBe('hello world');
    expect(titleFrom('x'.repeat(200))).toHaveLength(60);
    expect(titleFrom('   ')).toBe('New chat');
  });
});

describe('opening the database file', () => {
  it('persists across reopen', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'copilot-')), 'chat.db');
    const first = openDatabase(file);
    createConversationStore(first.db).saveMessage('conv-0001', user('u1', 'hi'), 'hi');
    first.db.close();

    const second = openDatabase(file);
    expect(second.recoveredFrom).toBeUndefined();
    expect(createConversationStore(second.db).load('conv-0001').messages).toHaveLength(1);
  });

  it('moves an unreadable file aside and starts empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'copilot-'));
    const file = join(dir, 'chat.db');
    writeFileSync(file, 'this is not a sqlite database, just some bytes long enough to be read as a header');

    const { db, recoveredFrom } = openDatabase(file);
    expect(recoveredFrom).toMatch(/chat\.db\.corrupt-\d+$/);
    expect(readdirSync(dir).some((f) => f.startsWith('chat.db.corrupt-'))).toBe(true);
    expect(createConversationStore(db).list()).toEqual([]);
  });
});
