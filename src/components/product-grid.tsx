'use client';

import { useState } from 'react';
import type { ProductCard as Card, ShowProductsOutput } from '@/lib/agent/tools';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

function Thumbnail({ src, alt }: { src: string | null; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div role="img" aria-label={`${alt} (no image)`} className="flex h-full w-full items-center justify-center text-xs text-zinc-400">
        No image
      </div>
    );
  }
  // Plain <img>: thumbnails come from the catalog CDN and need no optimisation pipeline here.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} className="h-full w-full object-contain" />;
}

export function ProductCard({ product }: { product: Card }) {
  const lowStock = product.availability && product.availability !== 'In Stock';
  return (
    <article data-testid="product-card" data-product-id={product.id} className="flex flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white">
      <div className="aspect-square bg-zinc-50 p-3">
        <Thumbnail src={product.thumbnail} alt={product.title} />
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-3">
        {product.brand && <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">{product.brand}</p>}
        <h3 className="text-sm font-semibold leading-snug text-zinc-900">{product.title}</h3>
        <p className="line-clamp-2 text-xs leading-relaxed text-zinc-600">{product.description}</p>
        {product.reason && <p className="text-xs italic text-emerald-800">{product.reason}</p>}
        <div className="mt-auto flex items-baseline justify-between pt-2">
          <span className="text-base font-semibold text-zinc-900">{usd.format(product.price)}</span>
          <span className="flex items-center gap-2 text-xs text-zinc-500">
            {product.rating != null && <span aria-label={`Rated ${product.rating.toFixed(1)} out of 5`}>★ {product.rating.toFixed(1)}</span>}
            {lowStock && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-900">{product.availability}</span>}
          </span>
        </div>
      </div>
    </article>
  );
}

const gridClass = 'grid grid-cols-2 gap-3 sm:grid-cols-3';

export function ProductGrid({ output }: { output: ShowProductsOutput }) {
  if (output.products.length === 0) {
    return (
      <p className="text-sm text-zinc-500">
        {output.error ? 'The catalog could not be reached, so there is nothing to show.' : 'None of the suggested products could be shown.'}
      </p>
    );
  }
  return (
    <section data-testid="product-group" aria-label={output.title ?? 'Products'} className="flex flex-col gap-2">
      {output.title && <h2 className="text-sm font-semibold text-zinc-800">{output.title}</h2>}
      <div className={gridClass}>
        {output.products.map((p) => (
          <ProductCard key={p.id} product={p} />
        ))}
      </div>
    </section>
  );
}

/** Placeholder while `show_products` is running: the layout does not jump when the cards arrive. */
export function ProductGridSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div data-testid="product-skeleton" aria-busy="true" aria-label="Loading products" className={gridClass}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
          <div className="aspect-square animate-pulse bg-zinc-100" />
          <div className="space-y-2 p-3">
            <div className="h-3 w-3/4 animate-pulse rounded bg-zinc-100" />
            <div className="h-3 w-full animate-pulse rounded bg-zinc-100" />
            <div className="h-4 w-1/3 animate-pulse rounded bg-zinc-100" />
          </div>
        </div>
      ))}
    </div>
  );
}
