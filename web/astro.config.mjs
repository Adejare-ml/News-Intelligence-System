// @ts-check
import { defineConfig } from "astro/config";

// Cloudflare Pages serves from the domain root. The GitHub Pages mirror lives
// under /News-Intelligence-System/, so its deploy job sets AURA_BASE.
const base = process.env.AURA_BASE || "/";
const site = process.env.AURA_SITE || "https://auranews.pages.dev";

export default defineConfig({
  site,
  base,
  trailingSlash: "ignore",
  build: { format: "directory" },
  prefetch: { prefetchAll: true, defaultStrategy: "hover" },
  devToolbar: { enabled: false },
});
