import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The e2e suite runs its own dev server next to `npm run dev`; it needs its own build directory.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
