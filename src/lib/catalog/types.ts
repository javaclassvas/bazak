import { z } from 'zod';

/** The 24 category slugs of the DummyJSON catalog. `tests/contract` checks this against the live API. */
export const CATEGORIES = [
  'beauty', 'fragrances', 'furniture', 'groceries', 'home-decoration',
  'kitchen-accessories', 'laptops', 'mens-shirts', 'mens-shoes', 'mens-watches',
  'mobile-accessories', 'motorcycle', 'skin-care', 'smartphones',
  'sports-accessories', 'sunglasses', 'tablets', 'tops', 'vehicle', 'womens-bags',
  'womens-dresses', 'womens-jewellery', 'womens-shoes', 'womens-watches',
] as const;

export type Category = (typeof CATEGORIES)[number];

/** Fields we ask the API for (`select=`). Everything a card or the model needs, nothing else. */
export const PRODUCT_FIELDS = [
  'id', 'title', 'description', 'category', 'price', 'discountPercentage',
  'rating', 'stock', 'tags', 'brand', 'availabilityStatus', 'thumbnail',
] as const;

export const productSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  description: z.string(),
  category: z.string(),
  price: z.number(),
  discountPercentage: z.number().optional(),
  rating: z.number().optional(),
  stock: z.number().optional(),
  tags: z.array(z.string()).optional(),
  brand: z.string().optional(), // 92 of 194 products have no brand
  availabilityStatus: z.string().optional(),
  thumbnail: z.string().optional(),
});

export type Product = z.infer<typeof productSchema>;

export const productListSchema = z.object({ products: z.array(productSchema) });
