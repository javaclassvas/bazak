// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Message } from '@/components/message';
import { ProductGrid } from '@/components/product-grid';
import type { CopilotUIMessage, ProductCard, ShowProductsOutput } from '@/lib/agent/tools';

afterEach(cleanup);

const card = (over: Partial<ProductCard> = {}): ProductCard => ({
  id: 1,
  title: 'Trail Runner',
  description: 'A light shoe for long days on rough ground.',
  category: 'mens-shoes',
  price: 89.5,
  discountPercentage: null,
  rating: 4.36,
  brand: 'Peak',
  availability: 'In Stock',
  thumbnail: 'https://cdn.example/trail.webp',
  reason: 'Good grip',
  ...over,
});
const output = (products: ProductCard[], over: Partial<ShowProductsOutput> = {}): ShowProductsOutput => ({ title: 'Shoes', products, dropped: [], ...over });

describe('product cards', () => {
  it('shows title, description, price and image from the tool output', () => {
    render(<ProductGrid output={output([card()])} />);
    const group = screen.getByRole('region', { name: 'Shoes' });
    const article = within(group).getByRole('article');
    expect(within(article).getByRole('heading', { name: 'Trail Runner' })).toBeTruthy();
    expect(within(article).getByText('A light shoe for long days on rough ground.')).toBeTruthy();
    expect(within(article).getByText('$89.50')).toBeTruthy();
    expect(within(article).getByText('Peak')).toBeTruthy();
    expect(within(article).getByText('Good grip')).toBeTruthy();
    expect(within(article).getByLabelText('Rated 4.4 out of 5')).toBeTruthy();
    expect((within(article).getByRole('img', { name: 'Trail Runner' }) as HTMLImageElement).src).toBe('https://cdn.example/trail.webp');
    expect(within(article).queryByText('In Stock')).toBeNull(); // only non-default stock is called out
  });

  it('falls back to a placeholder when the image fails to load', () => {
    render(<ProductGrid output={output([card()])} />);
    fireEvent.error(screen.getByRole('img', { name: 'Trail Runner' }));
    expect(screen.getByRole('img', { name: 'Trail Runner (no image)' }).textContent).toBe('No image');
  });

  it('renders a product with no brand, rating, image or reason, and flags low stock', () => {
    render(<ProductGrid output={output([card({ brand: null, rating: null, thumbnail: null, reason: null, availability: 'Low Stock' })])} />);
    const article = screen.getByRole('article');
    expect(within(article).getByRole('heading', { name: 'Trail Runner' })).toBeTruthy();
    expect(within(article).getByText('$89.50')).toBeTruthy();
    expect(within(article).getByText('Low Stock')).toBeTruthy();
    expect(within(article).getByText('No image')).toBeTruthy();
    expect(within(article).queryByText('Peak')).toBeNull();
  });

  it('says so when nothing could be shown', () => {
    render(<ProductGrid output={output([], { dropped: [7] })} />);
    expect(screen.getByText('None of the suggested products could be shown.')).toBeTruthy();
    cleanup();
    render(<ProductGrid output={output([], { error: 'catalog_unavailable' })} />);
    expect(screen.getByText(/catalog could not be reached/)).toBeTruthy();
  });
});

describe('assistant message parts', () => {
  const message = (parts: unknown[]): CopilotUIMessage => ({ id: 'a1', role: 'assistant', parts } as unknown as CopilotUIMessage);

  it('shows skeleton cards while show_products is running, sized to the request', () => {
    render(<Message message={message([{ type: 'tool-show_products', toolCallId: 't1', state: 'input-available', input: { items: [{ id: 1 }, { id: 2 }] } }])} />);
    const skeleton = screen.getByLabelText('Loading products');
    expect(skeleton.getAttribute('aria-busy')).toBe('true');
    expect(skeleton.children).toHaveLength(2);
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('renders status, cards and text in stream order, and hides searches as results', () => {
    render(
      <Message
        message={message([
          { type: 'step-start' },
          { type: 'tool-search_products', toolCallId: 's1', state: 'output-available', input: { category: 'mens-shoes', maxPrice: 100 }, output: { ok: true, total: 4, match: 'exact', products: [] } },
          { type: 'tool-show_products', toolCallId: 't1', state: 'output-available', input: { items: [{ id: 1 }] }, output: output([card()]) },
          { type: 'text', text: 'One pair that fits.' },
        ])}
      />,
    );
    const root = screen.getByTestId('assistant-message');
    expect([...root.children].map((el) => el.getAttribute('data-testid') ?? el.tagName)).toEqual(['search-status', 'product-group', 'P']);
    expect(screen.getByTestId('search-status').textContent).toBe('Searched mens shoes under $100 · 4 found');
    expect(screen.getAllByRole('article')).toHaveLength(1);
  });

  it('shows an error line when a tool call failed', () => {
    render(<Message message={message([{ type: 'tool-show_products', toolCallId: 't1', state: 'output-error', input: { items: [] }, errorText: 'boom' }])} />);
    expect(screen.getByText('These products could not be loaded.')).toBeTruthy();
  });
});
