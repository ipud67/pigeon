/** @type {import('next').NextConfig} */

// This is the public GitHub Pages deploy mirror. GitHub Pages serves this project site
// under a repo subpath: https://ipud67.github.io/pigeon/ — so the static export must bake
// that prefix into every route + asset URL. Driven by an env var (PIGEON_BASE_PATH) so a
// plain local build (`npm run build`) stays root-relative while the Pages CI build sets
// PIGEON_BASE_PATH=/pigeon.
//
// Note: the primary app now targets Vercel (server-rendered, account-backed) for the real
// domain launch. This mirror config intentionally stays on the static-export path because
// GitHub Pages cannot serve a server-rendered app — it is a demo stopgap, independent of
// the Vercel build.
const basePath = process.env.PIGEON_BASE_PATH ?? '';

const nextConfig = {
  reactStrictMode: true,

  // Fully static, pre-rendered output (out/). The app already pre-renders every route
  // (force-static + generateStaticParams) and reads a baked JSON store, so there is no
  // request-time server work — this exports cleanly to flat HTML for Pages hosting.
  output: 'export',

  // Subpath hosting. basePath prefixes routes AND /_next/ assets; assetPrefix is set to the
  // same value (no double-prefixing — verified by a local subpath-mounted serve + the live
  // persona run).
  basePath,
  assetPrefix: basePath || undefined,

  // Pages has no Next image optimizer; serve images as-authored. (No next/image in use
  // today, but this keeps export safe if one is added.)
  images: { unoptimized: true },

  // Emit dir/index.html for every route so GitHub Pages resolves /route/ -> /route/index.html
  // without needing a server rewrite. Pairs with next/link trailing-slash behavior.
  trailingSlash: true,

  // The LLM + ingestion code uses the `openai` SDK only in the ingest script, never at
  // request time. Keep it out of the bundle trace.
  serverExternalPackages: ['openai', 'fast-xml-parser'],
};
export default nextConfig;
