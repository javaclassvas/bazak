import { createConversationStore, type ConversationStore } from './conversations';
import { getDatabase } from './index';

const globalForStore = globalThis as unknown as { __copilotStore?: ConversationStore };

/** The process-wide store over the on-disk database. Tests build their own with `createConversationStore`. */
export function getStore(): ConversationStore {
  globalForStore.__copilotStore ??= createConversationStore(getDatabase().db);
  return globalForStore.__copilotStore;
}

/** True when the database file was unreadable at startup and a fresh one replaced it. */
export const historyWasReset = () => Boolean(getDatabase().recoveredFrom);
