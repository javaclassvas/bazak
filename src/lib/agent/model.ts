import { openai } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import { createDemoModel } from './mock-model';

export class MissingApiKeyError extends Error {
  constructor() {
    super('OPENAI_API_KEY is not set. Copy .env.example to .env.local and add your key.');
    this.name = 'MissingApiKeyError';
  }
}

/** The one place that decides which model answers. `openai(id)` talks to the Responses API. */
export function getModel(): LanguageModel {
  // Scripted stand-in: lets the UI and persistence be exercised (and e2e-tested) without a key.
  if (process.env.MOCK_LLM === '1') return createDemoModel();
  if (!process.env.OPENAI_API_KEY) throw new MissingApiKeyError();
  return openai(process.env.OPENAI_MODEL ?? 'gpt-6-luna');
}
