# AURA Tier 1 Redesign — Implementation Plan

## Context

A large product audit (710 numbered items, plus a "master implementation
prompt") proposed transforming AURA from a single dashboard page into a full
investigation platform: persistent app-shell navigation, global Ctrl+K
search, a design-token system, a DataTable component, entity dossiers, a
rebuilt knowledge graph with clustering/WebGL/path-finding, per-user
Investigations/Watchlists/Notes with authorship and autosave, a
"confidence vs risk" distinction with a claim-verification-state taxonomy,
entity-resolution confirm/reject workflows, a report builder, and full
accessibility/performance/security/testing passes.

Three research passes over this codebase found the live product is
architecturally incapable of hosting most of that as real, persisted,
multi-device, per-user functionality: the production site
(`adejare-ml.github.io`) is 100% static — a GitHub Actions cron runs
`run_pipeline.py`, writes to Google Sheets, exports flat JSON to
`backend/app/static/data/`, and pushes that static folder to `gh-pages`.
No server runs in production. A dormant FastAPI + Postgres + Celery stack
exists (with a `User` model, JWT primitives, and even a `Watchlist` table
with a `user_id` FK) but has no login endpoint, is never deployed by CI/CD,
and the live API routes don't talk to it. Confidence scores exist only as
hardcoded per-predicate constants on two unused Postgres columns that never
reach the frontend — only Risk is real, computed, and exported today. No
claim-state taxonomy exists anywhere. Entity resolution auto-merges on a
fuzzy-match threshold with no human-review step.

Given that, this plan covers **Tier 1 only** — a coherent, shippable first
milestone — with these decisions locked in:

1. **Investigations/Watchlists/Notes**: real but browser-local (localStorage
   only, single device, no login), every surface visibly labeled "saved on
   this device only." No backend/auth work.
2. **Confidence/claim-state**: not invented. Instead, a strong "why this risk
   level" evidence panel built from data that's already real — the 7
   red-flag rules and CAMA band classification already computed by
   `psc-core.js`, the existing `Verification Status` field (shown exactly
   as stored, not dressed up as more granular than it is), source, and
   extraction/publication timestamps.
3. **Deep-linking**: hash-based routes (`#/company/:slug`) — no changes to
   the GitHub Pages deploy pipeline.
4. **Scope**: router + nav shell, global search, a real DataTable component,
   entity dossier pages, a redesigned PSC register, a modest/honest graph
   extension, and a computed alerts view. Explicitly **not** in this plan:
   backend/auth changes, a real confidence score, a claim-verification
   taxonomy, entity-resolution review UI, a report builder beyond what
   exists, multi-user sync, graph clustering/WebGL/multi-hop pathfinding,
   true path-based URLs, or an accessibility/performance/security pass
   (that's a logical Tier 5 follow-on).

## Ground truth this plan relies on

- Whole app is one closure: `document.addEventListener("DOMContentLoaded", () => {...})`
  in `backend/app/static/js/app.js:1`, closing around line 2699. Every
  "module" today is a function declared inside that closure — nothing is
  shared across files except via `window.*` globals (`window.AuraPSC`,
  `window.openPSCDossier`, etc.).
- No build step. `index.html:556-563` loads plain `<script>` tags in a fixed
  order: `motion.js → backdrop.js → globe-data.js → globe.js → psc-core.js
  → report-markdown.js → app.js → psc-report.js`. New files must be added to
  this list in dependency order.
- CSP is the only defense (`index.html:12`):
  `script-src 'self' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com`,
  `connect-src 'self'`. Any new CDN dependency must come from jsdelivr or
  cdnjs, pinned with SRI like `chart.js`/`vis-network`/`lucide`
  (`index.html:24-33`). `connect-src 'self'` means all data fetches must
  stay same-origin — already true.
- **A real headless frontend test suite exists and runs in CI**
  (`.github/workflows/tests.yml:51-66`, `node tests/frontend/run.js`). It
  loads `psc-core.js`, `report-markdown.js`, `runner.js`,
  `psc-core.test.js` into a `vm.createContext` sandbox with **no DOM**
  (`tests/frontend/run.js:35-41`) — it only works because those modules are
  DOM-free `(function(global){...})(window)` IIFEs exposing pure functions
  on `window.Aura*`. Every new pure-logic piece of this plan (router
  matching, search scoring, table sort/paginate, key normalization) must be
  written the same way and tested the same way.
- `deploy_pages.yml` deploys `backend/app/static/` to `gh-pages` on **every
  push to `main`** that touches that path — no staging environment, no
  preview deploys. Every merged commit is a live production deploy.
- Deterministic node IDs in `graph.json` are `md5(name.strip().lower())[:12]`
  (`run_pipeline.py:553-556`), and the graph is **capped**: only
  `companies[:20]`, `agencies[:20]`, `people[:25]`, `psc_records[:20]`,
  `procurement[:20]` become nodes — 95 nodes today versus 975 companies /
  665 people in the full JSON. **Most dossier subjects will have no graph
  node.** Dossier routing must not depend on `graph.json` having every
  entity; name-based matching (already `psc-core.js`'s pattern) is
  sufficient and simpler than reimplementing MD5 client-side.
- `personKey`/`companyKey` exist in `psc-core.js:75-81` (`.trim().toLowerCase()`)
  but are **not exported** in `global.AuraPSC` (`psc-core.js:419-434`).
  Confirmed drift: `app.js:2129` and `app.js:2131` compare `.toLowerCase()`
  **without** `.trim()`, unlike the engine's own key functions. Fixed as
  part of Slice F.
- `localStorage` is already used exactly once, with the right defensive
  pattern to copy: `psc-report.js:81` (read) and `psc-report.js:105`
  (`try { ...setItem... } catch (e) {}`).
- Data files available at runtime: `latest.json` (60 articles),
  `companies.json` (975), `people.json` (665), `significant_control.json`
  (11 — the real register is tiny today), `procurement.json` (48),
  `reports.json` (113), `graph.json` (95 nodes / 51 edges),
  `report_latest.md`.

## Sequencing — incremental, never a big-bang rewrite

This ships on every push, so the plan is 8 independently deployable slices,
each leaving the site fully working. No slice depends on a slice that
hasn't shipped. Do **not** split `app.js` into modules as a standalone
first step — that's pure risk (2720 lines of behavior, no DOM tests to
verify against) with no user-visible payoff. Instead, extract only the code
each slice actually touches, at the moment it's touched, landing new
pure-logic pieces as fresh DOM-free modules that plug into
`tests/frontend/run.js` from day one.

| Slice | What ships | Depends on |
|---|---|---|
| A | Design tokens — spacing scale added to `:root` | — |
| B | Hash router (`js/router.js`) + nav shell, running *alongside* the existing anchor-scroll nav | A |
| C | Global search / Ctrl+K (`js/search.js`), hand-rolled fuzzy match, no new dependency by default | B |
| D | DataTable component (`js/datatable.js`) — sort, paginate, column visibility — built and tested standalone | A |
| E | Entity dossier pages (`js/entity-dossier.js`), person/company/agency, built from real JSON only | B, D |
| F | PSC register migrated onto DataTable; retires the raw-string table renderer at `app.js:1905`; fixes the `personKey`/`companyKey` export + trim() bug | D, E |
| G | Graph extension: BFS shortest-path highlight (`js/graph-path.js`); retires the duplicate hand-rolled SVG network renderer (`app.js:2003-2115`) in favor of a filtered view of the real vis.js graph | B |
| H | Alerts (computed, not stored) + browser-local Investigations/Watchlists/Notes, every surface labeled "saved on this device only" | E |

Each slice keeps the existing anchor sections and modal system **fully
functional** until the slice that explicitly retires them. E.g. the anchor
nav stays alive through Slice B; only in Slice F does the PSC nav link
repoint to `#/psc`, and even then the old anchor ID stays on the element so
old links still resolve.

## 1. Router + nav shell (Slice B)

- New file `js/router.js`, DOM-free core + thin DOM-binding shell, loaded
  after `psc-core.js`, before `app.js`.
- Route table (static array, testable in isolation):
  ```js
  [
    { pattern: "#/",               view: "home" },
    { pattern: "#/brief",          view: "brief" },
    { pattern: "#/feed",           view: "feed" },
    { pattern: "#/psc",            view: "psc-register" },
    { pattern: "#/network",        view: "graph" },
    { pattern: "#/alerts",         view: "alerts" },
    { pattern: "#/investigations", view: "investigations" },
    { pattern: "#/company/:slug",  view: "company-dossier" },
    { pattern: "#/person/:slug",   view: "person-dossier" },
    { pattern: "#/agency/:slug",   view: "agency-dossier" },
  ]
  ```
- Pure function `matchRoute(hash, table)` → `{view, params}` or `null` —
  tested headlessly in `tests/frontend/router.test.js`.
- Slug scheme: **not** the pipeline's md5 id. A shared `slugify(name)`
  (lowercase, trim, spaces→`-`, strip non-url-safe chars) exported from
  `js/entity-key.js`, resolved back to a record via case/whitespace-insensitive
  name match against `companies.json`/`people.json`/`significant_control.json`.
  Graph node correlation (md5) is a **best-effort cross-link only**: when a
  slug's name is also one of the ≤95 capped graph nodes, the dossier's
  "Network" tab deep-links to `#/network?focus=<slug>`; when it isn't, the
  tab is simply omitted.
- **Coexistence with anchor-scroll nav**: `nav.section-nav` keeps working
  for `#brief`/`#register`/`#workspace`/`#network` (no leading slash). The
  router adds a *parallel* `hashchange` listener that only intercepts
  `#/...`-pattern hashes.
- **View swapping**: two kinds of routes — *section-scroll* routes just
  `scrollIntoView` on the existing section (no content swap, no regression
  risk); *page-like* routes (`psc-register`, dossiers, `investigations`)
  dispatch to `renderView(view, params)`, which shows/hides top-level
  containers via `hidden` attribute toggling (same primitive already used
  for `.tab-content.hidden`), injecting into a new `<main data-route-outlet>`
  region that reuses existing `.workspace-panel`/`.glass` CSS.
- **Modal interplay**: the 4 existing modals stay modals in Tier 1 — not
  converted to routes (real focus-trap/escape wiring that would need
  re-verification). New dossier pages are pages, not modals; they supersede
  the `psc-dossier-modal`'s content for PSC subjects once Slice F cuts over.
- **Back/forward**: native, via `hashchange` — no manual `pushState`
  bookkeeping needed.
- **Fresh load of `#/company/123` on GitHub Pages**: this is *why* hash
  routing was chosen over path routing — GitHub Pages always serves
  `index.html` for any URL under the project path, so a hash route always
  resolves client-side; a real path segment 404s without a `404.html`
  SPA-fallback hack, which is out of scope. On load, the router waits for
  the already-in-flight `companies.json`/`people.json`/`significant_control.json`
  fetches to resolve (no new fetch needed) then resolves the slug.

## 2. Global search / Ctrl+K (Slice C)

- Indexes, all already-fetched by existing code paths (no new fetches):
  `latest.json` (articles), `companies.json`, `people.json`,
  `significant_control.json`, `procurement.json`. Index built lazily on
  first palette open, or eagerly once the underlying data resolves — cheap
  either way at ~2,000 total candidate records.
- **Hand-roll the fuzzy match, don't add a dependency.** Pure function
  `searchIndex(records, query)` in `js/search.js`: normalize, score exact
  prefix > whole-word > subsequence match, sort descending. Same complexity
  class as the existing `conceptScore` (`app.js:414-430`) already shipping
  in the feed's "entity trace" mode — reuse that scoring shape. Only fall
  back to a CDN library (e.g. Fuse.js via cdnjs, SRI-pinned) if the
  hand-rolled version demonstrably fails on real queries during
  implementation.
- Result groups (Articles, Companies, People, PSC Disclosures, Procurement),
  each capped with a "press Enter to see all" overflow.
- `Ctrl+K`/`Cmd+K` opens (codebase has zero `ctrlKey`/`metaKey` handling
  today — wholly new). `↑`/`↓` selects, `Enter` navigates via the router,
  `Escape` closes — registered into the *existing* topmost-modal escape
  chain (`app.js:1399-1405`) rather than a second competing handler.
  Focus-trap logic shared with modals via the extracted `js/overlay.js`
  utility (see Design System section).

## 3. DataTable component (Slice D)

- New `js/datatable.js`: pure compute half (`sortRows(rows, key, dir)`,
  `paginateRows(rows, page, pageSize)` — stable sort, localeCompare for
  strings, numeric compare via `AuraPSC.toPercent` where relevant) plus a
  thin render half.
- Column visibility state is in-memory only for Tier 1 (not persisted to
  localStorage) — kept separate from the Slice H persistence feature so
  "why is my column hidden" isn't a mystery months later.
- Pagination, not virtualization — record counts (max 975 companies, 11 PSC
  records today, 60 articles) don't justify virtualization's complexity.
- Real `<table>` markup, real CSS classes, sortable `<button>` headers with
  `aria-sort` — no inline `style="..."`.
- **Migration of `renderPSCTableRows` (`app.js:1905`) happens in Slice F,
  not D.** `getFilteredPSCData()` (`app.js:1765`) — which already does
  filter-chip + search narrowing and calls `AuraPSC.emptyStateFor` — is the
  seam: DataTable only ever receives its output, so filter/search/empty-state
  semantics are untouched.
- **Feed migration**: apply DataTable's sort/paginate logic (not its
  `<table>` markup) to the card-based feed (`renderNewsFeed`,
  `app.js:587-640`), which currently renders all matches with no pagination.
  The existing `#feed-sort` dropdown maps directly onto `sortRows`'s
  `columnKey` parameter.

## 4. Entity dossier pages (Slice E)

**Person dossier** (`#/person/:slug`, from `people.json` +
`significant_control.json`): header (name, most recent position/org/event/date);
"Also a PSC" panel via `AuraPSC.controlChain()` and `redFlagsFor` — supersedes
`openPSCDossier`'s modal content for PSC subjects; article mentions via
substring match (same approach as `matchArticleEntities`, `app.js:1203-1219`);
"Saved on this device" panel (Slice H). **Not built**: employment history,
org chart, any fabricated confidence.

**Company dossier** (`#/company/:slug`, from `companies.json` +
`significant_control.json` + `procurement.json`): header (Company, Industry,
Risk Level, Mention Count, Last Seen); beneficial owners panel (PSC rows
matching via the newly-exported `companyKey`); procurement panel; article
mentions; **conditional** Network tab (only when the entity has a graph
node, given the 20-node cap — omitted entirely otherwise, not shown broken).

**Agency dossier** (`#/agency/:slug`) — narrower, since agencies only appear
inline in `procurement.json` and as graph nodes today, with no dedicated
`agencies.json` export. Header (name only), procurement panel, article
mentions.

**One named, justified pipeline change**: `run_pipeline.py`'s
`export_static_json_database()` already calls `db.get_agencies()` for the
graph step but never writes it to its own JSON file the way
companies/people are. Recommend one line — `json.dump(agencies, ...)` —
alongside the existing dumps. This exports data already computed and
already in memory; no new query, no new model, no new logic. Flag to the
maintainer before implementing.

**Brief-requested tabs, mapped to reality:**

| Requested | Tier 1 reality |
|---|---|
| Overview | Real, from static JSON |
| Relationships/Network | Real, conditional on the graph cap |
| Notes | Maps to Slice H's browser-local notes, labeled "saved on this device" |
| Watchlist toggle | Maps to Slice H |
| Timeline/History | Real only where a `Timeline` array already exists on some PSC records; no general entity timeline |
| Confidence/Verification | Evidence panel: `Verification Status` shown verbatim, the red-flag list with rule text, article timestamps — never a manufactured score |
| Entity resolution (merge/split) | **Not built** — no candidate data exists |
| Report builder | **Not built** — existing `exportPSCComplianceReport` (`app.js:2351`) stays as-is |

## 5. PSC register redesign (Slice F)

- Register becomes route `#/psc`. The existing `<section id="register">`
  markup becomes the DataTable-driven page content; the id stays so old
  anchor links still land there.
- **All PSC domain logic continues to route through `window.AuraPSC.*`.**
  This slice touches only the rendering layer (`renderPSCTableRows`) and
  never reimplements `redFlagsFor`, `bandFor`, `controlChain`, `summarise`,
  or `emptyStateFor` — the single most important invariant of this slice,
  given the file's own changelog comments document the cost of the
  dashboard's last divergence from the engine.
- **Bundled bugfix**: export `personKey`/`companyKey` from
  `psc-core.js:419-434`'s `global.AuraPSC`. Replace `app.js:2129` and
  `app.js:2131`'s inline `.toLowerCase()` (no `.trim()`) comparisons with
  calls through the exported functions. Audit every other inline
  `Person Name`/`Company` comparison found during implementation. Add a
  direct test asserting the exported keys behave identically to the
  internal versions, so a future accidental un-export or divergence fails
  CI.
- Filter chips and the search box are preserved verbatim — only what
  happens to `getFilteredPSCData()`'s output changes.
- `window.openPSCDossier` is repointed to `location.hash = "#/person/" +
  slugify(name)` once the person dossier page exists. The old
  `psc-dossier-modal` markup is deleted only after end-to-end verification,
  not preemptively.

## 6. Graph extension — modest, honest (Slice G)

**In scope:**
- Shortest-path highlight between two selected nodes — pure client-side BFS
  over the already-loaded `graph.json`. New pure function `shortestPath(nodes,
  edges, fromId, toId)` in `js/graph-path.js` (DOM-free, tested), edges
  treated as undirected for traversal purposes. UI: a small "Path from ↔ to"
  affordance next to the existing zoom/fit/physics-toggle buttons; result
  reuses the existing `highlightNeighborhood`/`resetHighlight` styling
  (`app.js:1099-1111`).
- **Retiring `renderPSCNetworkGraph`** (`app.js:2003-2115`, the hand-rolled
  single-hop SVG): replaced with a filtered view of the main vis.js graph,
  fed a subset of nodes/edges computed via `AuraPSC.controlChain()`. Removes
  a whole duplicate rendering engine and duplicate hop-logic, and gives the
  PSC "Network Map" real pan/zoom/click for free. Caveat: `controlChain()`'s
  nodes aren't guaranteed to be in `graph.json` (same 20-node cap) — the
  filtered view must synthesize small ad hoc vis.js nodes directly from the
  PSC record when the real graph lacks that entity, so the replacement is
  strictly more capable than what it replaces.

**Explicitly out of scope**, restated so it can't drift back in:
- Clustering — nothing computes cluster membership anywhere today; real new
  engineering.
- WebGL — vis-network is canvas 2D; a renderer swap is a large undertaking
  with no functional requirement driving it here.
- Multi-hop/general path-finding beyond simple BFS shortest-path.

## 7. Alerts view (Slice H, part 1)

- Route `#/alerts`. Computed, not stored — derived at load time from
  `latest.json`'s `Risk Score`/`Category` (already powering
  `renderAlertsList`, `app.js:650-721`) plus `significant_control.json` rows
  run through `AuraPSC.redFlagsFor()`. Largely a repackaging of existing
  computation: give it a dedicated route instead of only the homepage band,
  merge in PSC red-flag-derived alerts (today only visible inside the PSC
  register/dossier), add dismiss/read.
- Dismiss/read state: localStorage only, key `aura:alerts:dismissed`,
  stable alert IDs built from article ID + risk-tier hash, or PSC record's
  `personKey`+`companyKey`+flag id. Dismissed items filtered from the
  default view with an "N dismissed — show" toggle, never destructively
  removed.
- **Every occurrence of "Alerts" copy carries a persistent, visible
  sub-label**: "Dismiss state is saved only on this device/browser." No
  bell/push iconography implying server-side delivery.

## 8. Investigations / Watchlists / Notes — browser-local (Slice H, part 2)

Data shape, one namespaced localStorage key (`aura:local:v1`), versioned:

```js
{
  version: 1,
  watchlist: [{ entityType, slug, addedAt }],
  notes: [{ id, entityType, slug, body, createdAt, updatedAt }],
  investigations: [{ id, name, createdAt, updatedAt,
                      items: [{ entityType, slug, addedAt }] }]
}
```

- Single key (not per-feature), so quota usage is predictable and
  versioning is tractable at Tier 1's data volume.
- Read/write wrapped in try/catch modeled directly on `psc-report.js:81,105`
  — the only existing precedent.
- Slugs reuse the router's `slugify` scheme so a watchlist entry always
  round-trips to a dossier URL.
- **UI labeling is a review-blocking detail, not a nice-to-have**: every
  surface (watchlist star, notes panel, "New investigation" button) carries
  a persistent "Saved on this device only" caption on first render — no
  cloud/sync iconography anywhere.
- **Storage unavailable handling**: feature-detect at module init (test
  write/read/remove); if it throws, the whole feature renders in a visible
  disabled state with an explanatory banner rather than silently no-oping.
  Every subsequent write stays wrapped defensively (quota can fill
  mid-session), surfaced as a dismissible toast, not a thrown error.
- **Non-goals, with reasoning**: no export/import (cheap to build, but
  multiplies the state-versioning surface beyond Tier 1's review budget —
  a good fast-follow, not part of this); no cross-device sync or login
  (explicit non-goal); no sharing/collaboration (needs a backend).

## Design system additions

| Component | Status | Action |
|---|---|---|
| Color/typography/radius/motion tokens | Exist | No change |
| Spacing scale | Was missing | Added in Slice A |
| Inline `style="..."` in generated HTML | Known debt | Convert only where a slice already rewrites that exact markup (PSC table → F, PSC dossier body → E); not a standalone cleanup pass |
| Modal | Exists, solid | **Extend, don't rebuild** — extract the focus-trap/return-focus logic (`app.js:1332-1392`) into `js/overlay.js`, used by the existing 4 modals (behavior-preserving refactor) and the new search palette |
| Drawer | — | **Not needed for Tier 1** — dossiers are full pages, not slide-overs |
| Toast | New, small | Needed for storage-full warnings and copy-confirmations (generalizing the existing ad hoc button-swap pattern at `app.js:2273-2279`) |
| Skeleton | New, small | Reduces layout shift on paginated loads; not load-bearing, can slip if time-constrained |
| EmptyState/ErrorState | Partially exists (PSC-specific) | **Generalize** `pscEmptyStateHTML` into `js/empty-state.js` consuming the same `{kind, action, ...}` shape `AuraPSC.emptyStateFor` already returns, reused by feed pagination and dossiers |
| ConfidenceBadge | — | **Explicitly not built** — no real confidence number exists to badge |

## File/module structure

No build step is introduced. The project's own CI comment treats
"no dependencies, no browser" as load-bearing for the test story, and
`deploy_pages.yml` has no build stage — adding a bundler means a new CI job,
a new deploy failure mode, and a new local/prod sync concern, for under
200KB of unminified JS total. Not justified by Tier 1's scope.

New files, all plain `(function(global){...})(window)` IIFEs matching the
`psc-core.js`/`report-markdown.js` convention, added to `index.html`'s
script list in dependency order:

```
motion.js, backdrop.js, globe-data.js, globe.js        (existing, unchanged)
psc-core.js               (existing; + personKey/companyKey export, Slice F)
entity-key.js              NEW — slugify(), shared name normalization (B/E)
report-markdown.js        (existing, unchanged)
router.js                   NEW — route table + matchRoute + hashchange (B)
overlay.js                  NEW — extracted focus-trap utility (C, refactor)
datatable.js                 NEW — sortRows/paginateRows + render (D)
empty-state.js               NEW — generalized empty/error state (D/E)
toast.js                     NEW — small toast primitive (H)
search.js                     NEW — index + palette (C)
graph-path.js                 NEW — BFS shortest path (G)
app.js                     (existing; shrinks slightly per-slice)
entity-dossier.js              NEW — dossier route handlers (E)
psc-ui.js                       NEW — PSC-register-page glue, mirrors how
                                       psc-report.js sits alongside psc-core.js (F)
psc-report.js              (existing, unchanged)
```

Each new file gets a matching `tests/frontend/<name>.test.js` for its pure
half, added to `tests/frontend/run.js`'s `FILES` array. `app.js` is not
rewritten wholesale — per-slice, only the specific function(s) that slice
replaces are deleted, and new modules reach `app.js`'s remaining state via
small exported accessors (e.g. `window.AuraApp = { getArticles: () =>
allArticles, getPscRecords: () => allPscRecords }`), added incrementally,
one accessor per slice, only as needed.

## Verification plan

**Existing automated coverage** (must stay green after every slice):
`tests/frontend/run.js` + `psc-core.test.js`, wired into CI
(`.github/workflows/tests.yml:51-66`) — covers CAMA bands, all red-flag
rules, control-chain shape, portfolio summary, cross-entity counting,
empty-state attribution, and the report-markdown parser. Since every slice
is instructed to route through `AuraPSC.*` rather than reimplement it, a
break here means a slice violated that invariant. `pytest -q` covers the
one pipeline export change (Slice E).

**New automated coverage**: every pure-logic module gets a same-style
`.test.js`, extending the existing headless suite — no jsdom, no second
test runner.

**Manual QA required before every merge** (DOM-wiring code has no automated
coverage — the suite is deliberately DOM-free), run against the local
static preview (`?static=1` forces static-JSON mode):

1. Every slice: zero console errors on load; Ctrl+K/search doesn't
   intercept existing search boxes.
2. Feed regression: category/risk filters, `#feed-sort`, entity-trace
   toggle, article modal open/close/focus-return.
3. PSC regression: each filter chip's row count matches baseline; all
   three empty-state kinds render correctly; CSV export still downloads
   correctly with its injection guard intact.
4. Graph regression: zoom/fit/physics-toggle; click-to-select and
   neighborhood highlight; reduced-motion suppression; new path-finder
   doesn't fire on a normal click.
5. Router: every legacy anchor still scrolls correctly; every `#/...`
   route loads via both in-app nav and a hard refresh on that exact URL
   (the GitHub Pages fresh-load case); back/forward works; an unknown hash
   falls back to home without crashing.
6. Investigations/Watchlists/Notes: add/remove/edit; "saved on this
   device" labeling visible everywhere; storage-disabled and
   quota-exceeded paths show the banner/toast, not a crash.
7. CSP/CDN: if a CDN dependency is added (e.g. Fuse.js fallback), confirm
   SRI hash, confirm CSP allow-list is updated in the same commit, confirm
   no console CSP violations.

**Sign-off gate**: `node tests/frontend/run.js` and `pytest -q` both pass
(already CI-blocking); the relevant manual checklist items for whatever
that slice touches.

## Critical files

- `backend/app/static/js/app.js`
- `backend/app/static/js/psc-core.js`
- `backend/app/static/index.html`
- `tests/frontend/run.js`
- `run_pipeline.py`
