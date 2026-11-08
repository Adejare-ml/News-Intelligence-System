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
  prefetch: { prefetchAll: true, defaultStrategy: "hover" },
  devToolbar: { enabled: false },
  // Vite inlines scripts under 4KB by default. Cloudflare serves a strict
  // CSP (script-src 'self', see public/_headers), so every script must be
  // its own file. CSS is different: style-src allows 'unsafe-inline', so
  // stylesheets under 4KB go into the page (one request fewer each) while
  // scripts, fonts and images stay files.
  build: { format: "directory", inlineStylesheets: "auto" },
  vite: { build: { assetsInlineLimit: (file) => file.endsWith(".css") ? undefined : false } },
});
