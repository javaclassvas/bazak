import type { Db } from './index';

export type StoredMessage = { id: string; role: 'user' | 'assistant'; parts: unknown[] };
export type ConversationSummary = { id: string; title: string; updatedAt: number };

export type LoadedConversation = {
  messages: StoredMessage[];
  /** Rows whose JSON could not be read. They are left in place and skipped. */
  unreadable: number;
};

const TITLE_LENGTH = 60;

export function titleFrom(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return 'New chat';
  return clean.length > TITLE_LENGTH ? `${clean.slice(0, TITLE_LENGTH - 1)}…` : clean;
}

export type ConversationStore = ReturnType<typeof createConversationStore>;

export function createConversationStore(db: Db, now: () => number = Date.now) {
  const selectList = db.prepare('SELECT id, title, updated_at AS updatedAt FROM conversations ORDER BY updated_at DESC, id LIMIT ?');
  const selectMessages = db.prepare('SELECT id, role, parts FROM messages WHERE conversation_id = ? ORDER BY seq');
  const selectConversation = db.prepare('SELECT id FROM conversations WHERE id = ?');
  const insertConversation = db.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)');
  const touchConversation = db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?');
  const nextSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE conversation_id = ?');
  // Upsert: saving the same message twice (a retried request, a late onEnd) must not duplicate it.
  const upsertMessage = db.prepare(`
    INSERT INTO messages (conversation_id, id, role, parts, seq, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (conversation_id, id) DO UPDATE SET parts = excluded.parts, role = excluded.role
  `);

  const save = db.transaction((conversationId: string, message: StoredMessage, title: string) => {
    const t = now();
    if (!selectConversation.get(conversationId)) insertConversation.run(conversationId, title, t, t);
    else touchConversation.run(t, conversationId);
    const { seq } = nextSeq.get(conversationId) as { seq: number };
    upsertMessage.run(conversationId, message.id, message.role, JSON.stringify(message.parts), seq, t);
  });

  return {
    list(limit = 100): ConversationSummary[] {
      return selectList.all(limit) as ConversationSummary[];
    },

    load(conversationId: string): LoadedConversation {
      const rows = selectMessages.all(conversationId) as { id: string; role: string; parts: string }[];
      const messages: StoredMessage[] = [];
      let unreadable = 0;
      for (const row of rows) {
        try {
          const parts = JSON.parse(row.parts);
          if (!Array.isArray(parts) || (row.role !== 'user' && row.role !== 'assistant')) throw new Error('bad row');
          messages.push({ id: row.id, role: row.role, parts });
        } catch {
          unreadable += 1;
        }
      }
      return { messages, unreadable };
    },

    /**
     * Save one message, creating the conversation on its first message.
     * The conversation row and the message are written in one transaction: a conversation never exists
     * without its first message, so an abandoned "new chat" leaves nothing behind.
     */
    saveMessage(conversationId: string, message: StoredMessage, titleIfNew = 'New chat'): void {
      save(conversationId, message, titleIfNew);
    },
  };
}
