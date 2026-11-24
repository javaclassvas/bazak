import { openai } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';

export class MissingApiKeyError extends Error {
  constructor() {
    super('OPENAI_API_KEY is not set. Copy .env.example to .env.local and add your key.');
    this.name = 'MissingApiKeyError';
  }
}

/** The one place that decides which model answers. `openai(id)` talks to the Responses API. */
export function getModel(): LanguageModel {
  if (!process.env.OPENAI_API_KEY) throw new MissingApiKeyError();
  return openai(process.env.OPENAI_MODEL ?? 'gpt-6-luna');
}
