'use client';

import type { CopilotUIMessage } from '@/lib/agent/tools';
import { ProductGrid, ProductGridSkeleton } from './product-grid';

type Part = CopilotUIMessage['parts'][number];
type SearchPart = Extract<Part, { type: 'tool-search_products' }>;
type ShowPart = Extract<Part, { type: 'tool-show_products' }>;

/** What a search was about, in a few words, from its arguments. */
function describeSearch(input: SearchPart['input']): string {
  if (!input) return 'the catalog';
  const bits = [input.query && `“${input.query}”`, input.category?.replace(/-/g, ' ')].filter(Boolean);
  const price =
    input.maxPrice != null && input.minPrice != null
      ? ` $${input.minPrice}–$${input.maxPrice}`
      : input.maxPrice != null
        ? ` under $${input.maxPrice}`
        : input.minPrice != null
          ? ` over $${input.minPrice}`
          : '';
  return `${bits.join(' in ') || 'the catalog'}${price}`;
}

/** Searches are not results. They show as one quiet status line so the wait is explained. */
function SearchStatus({ part }: { part: SearchPart }) {
  const what = describeSearch(part.input);
  let text: string;
  if (part.state === 'output-available') {
    text = part.output.ok ? `Searched ${what} · ${part.output.total} found` : 'The catalog is unavailable right now';
  } else if (part.state === 'output-error') {
    text = `Search failed for ${what}`;
  } else {
    text = `Searching ${what}…`;
  }
  return (
    <p data-testid="search-status" className="text-xs text-zinc-400">
      {text}
    </p>
  );
}

function ShownProducts({ part }: { part: ShowPart }) {
  if (part.state === 'output-available') return <ProductGrid output={part.output} />;
  if (part.state === 'output-error') return <p className="text-sm text-red-700">These products could not be loaded.</p>;
  return <ProductGridSkeleton count={Math.min(part.input?.items?.length ?? 3, 6)} />;
}

export function Message({ message }: { message: CopilotUIMessage }) {
  if (message.role === 'user') {
    const text = message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    return (
      <div data-testid="user-message" className="ml-auto max-w-[80%] whitespace-pre-wrap rounded-2xl bg-zinc-900 px-4 py-2.5 text-sm text-white">
        {text}
      </div>
    );
  }

  return (
    <div data-testid="assistant-message" className="flex flex-col gap-3">
      {message.parts.map((part, i) => {
        switch (part.type) {
          case 'text':
            return part.text.trim() ? (
              <p key={i} className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-800">
                {part.text}
              </p>
            ) : null;
          case 'tool-search_products':
            return <SearchStatus key={part.toolCallId} part={part} />;
          case 'tool-show_products':
            return <ShownProducts key={part.toolCallId} part={part} />;
          default:
            return null; // step boundaries and anything we do not render
        }
      })}
    </div>
  );
}
