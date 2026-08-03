document.addEventListener("DOMContentLoaded", () => {
    // Determine dynamic serverless database configuration
    // ?static=1 forces serverless/static data mode for local previews without the FastAPI backend
    const isGitHubPages = window.location.hostname.includes("github.io") || window.location.protocol === "file:" || window.location.search.includes("static=1");
    const API_BASE = isGitHubPages ? "data" : "/api/v1";

    // State Variables
    let currentCategory = "";
    let currentRisk = "";
    let currentSort = "newest";
    let isSemanticSearch = false;
    let mixChart = null;
    let network = null;
    let allArticles = [];
    let allReports = [];
    let allPscRecords = [];
    let usingDemoPsc = false;

    // DOM Elements
    const articlesList = document.getElementById("articles-list");
    const alertsList = document.getElementById("alerts-list");
    const searchInput = document.getElementById("search-input");
    const searchBtn = document.getElementById("search-btn");
    const searchTypeToggle = document.getElementById("search-type-toggle");
    const searchLabel = document.getElementById("search-label");
    const triggerIngestBtn = document.getElementById("trigger-ingest-btn");
    
    // Stats elements
    const statArticles = document.getElementById("stat-articles");
    const statEntities = document.getElementById("stat-entities");
    const statEvents = document.getElementById("stat-events");
    const statAlerts = document.getElementById("stat-alerts");

    // Modal elements
    const modal = document.getElementById("detail-modal");
    const closeModalBtn = document.getElementById("close-modal");
    const modalTitle = document.getElementById("modal-title");
    const modalSource = document.getElementById("modal-source");
    const modalDate = document.getElementById("modal-date");
    const modalImportance = document.getElementById("modal-importance");
    const modalSentiment = document.getElementById("modal-sentiment");
    const modalRisk = document.getElementById("modal-risk");
    const modalCategory = document.getElementById("modal-category");
    const modalSourceLink = document.getElementById("modal-source-link");
    const modalEntities = document.getElementById("modal-entities");
    
    // Modal Summary Tabs
    const tabBtns = document.querySelectorAll(".tab-btn");
    const tabExec = document.getElementById("modal-summary-executive");

    const tabExecWrapper = document.getElementById("tab-executive");
    const tabDetailedWrapper = document.getElementById("tab-detailed");
    const tabTimelineWrapper = document.getElementById("tab-timeline");
    let currentArticleData = null;

    // Known entities from the knowledge graph, used for real entity matching
    // in the article modal (replaces the old hardcoded sample-name matching)
    let knownEntities = [];

    // Initialize Lucide Icons
    if (window.lucide) {
        window.lucide.createIcons();
    }

    // ==========================================
    // NORMALIZATION UTILITY
    // ==========================================

    // Escape article-sourced strings before innerHTML interpolation (RSS titles
    // and summaries are untrusted upstream content).
    function esc(str) {
        return String(str == null ? "" : str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function timeAgo(dateStr) {
        if (!dateStr) return "Recent";
        const then = new Date(dateStr).getTime();
        if (isNaN(then)) return "Recent";
        const mins = Math.floor((Date.now() - then) / 60000);
        if (mins < 1) return "Just now";
        if (mins < 60) return `${mins}m ago`;
        const hours = Math.floor(mins / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        if (days < 7) return `${days}d ago`;
        return new Date(dateStr).toLocaleDateString();
    }

    // Only allow http(s) destinations for feed-supplied URLs — a malicious
    // feed entry must not be able to plant a javascript:/data: link
    // For DOM property assignment (el.href = ...): scheme check only, so
    // query strings survive intact.
    function safeUrl(url) {
        const u = String(url == null ? "" : url).trim();
        return /^https?:\/\//i.test(u) ? u : "#";
    }

    // For interpolation into an href="..." inside an HTML string: the scheme
    // check alone is not enough, since `https://x" onmouseover="…` passes it
    // and breaks out of the attribute. Escape as well.
    function safeUrlAttr(url) {
        return esc(safeUrl(url));
    }

    // Strip feed-scraper truncation artifacts like "... [+1951 chars]"
    function cleanSummary(text) {
        return String(text == null ? "" : text)
            .replace(/\s*\[\+\d+\s*chars?\]\s*$/i, "…")
            .replace(/&#\d+;|&[a-z]+;/gi, m => {
                const el = document.createElement("textarea");
                el.innerHTML = m;
                return el.value;
            })
            .trim();
    }

    function normalizeArticle(art) {
        if (!art) return null;
        const score = art["Risk Score"] !== undefined ? parseInt(art["Risk Score"]) : (art.risk_score || 10);
        let level = "Low";
        if (score >= 75) level = "Critical";
        else if (score >= 50) level = "High";
        else if (score >= 25) level = "Medium";
        
        return {
            id: art.ID || art.id || "",
            title: art.Title || art.title || "",
            source: art.Source || art.source || "Unknown",
            url: art.URL || art.url || "#",
            category: art.Category || art.category || "Other",
            importance_score: art["Risk Score"] !== undefined ? parseInt(art["Risk Score"]) : (art.importance_score || 50),
            risk_score: score,
            risk_level: art.risk_level || level,
            sentiment: art.sentiment || "Neutral",
            summary_executive: cleanSummary(art.Summary || art.summary_executive || art.summary || art.Title || art.title) || "No summary available.",
            published_at: art.Time || art.published_at || new Date().toISOString(),
            engine: art.Engine || art.engine || ""
        };
    }

    // ==========================================
    // DATA FETCHING & RENDERING
    // ==========================================

    async function loadDashboardStats() {
        try {
            if (isGitHubPages) {
                // Fetch datasets in parallel for serverless dashboard aggregation
                const [artRes, compRes, repRes] = await Promise.all([
                    fetch(`${API_BASE}/latest.json`),
                    fetch(`${API_BASE}/companies.json`),
                    fetch(`${API_BASE}/reports.json`)
                ]);
                
                const rawArticles = await artRes.json();
                const rawCompanies = await compRes.json();
                const rawReports = await repRes.json();
                
                allArticles = rawArticles.map(normalizeArticle);
                allReports = rawReports;
                
                // Aggregations
                const total_articles = allArticles.length;
                const total_entities = rawCompanies.length;
                const total_events = allArticles.filter(a => a.category === "Government" || a.category === "Legal").length;
                
                // Elevated Risk items (score >= 25 or Medium/High/Critical level)
                const elevatedArticles = allArticles.filter(a => (a.risk_score >= 25 || ["Medium", "High", "Critical"].includes(a.risk_level)));
                const latest_alerts = elevatedArticles.slice(0, 10);
                const total_alerts = elevatedArticles.length;
                
                // Group by Category
                const category_counts = {};
                allArticles.forEach(a => {
                    const cat = a.category || "General";
                    category_counts[cat] = (category_counts[cat] || 0) + 1;
                });
                
                // Group by Risk
                const risk_level_counts = { "Low": 0, "Medium": 0, "High": 0, "Critical": 0 };
                allArticles.forEach(a => {
                    if (risk_level_counts[a.risk_level] !== undefined) {
                        risk_level_counts[a.risk_level]++;
                    }
                });
                
                // Populate DOM
                animateCounter(statArticles, total_articles);
                animateCounter(statEntities, total_entities);
                animateCounter(statEvents, total_events);
                animateCounter(statAlerts, total_alerts);
                
                const alertCard = document.getElementById("stat-alerts-card");
                if (total_alerts > 0) alertCard.classList.add("alert-glow");
                else alertCard.classList.remove("alert-glow");
                
                // Convert to formatted alert objects for critical alerts list
                const formattedAlerts = latest_alerts.map(a => ({
                    title: `${a.risk_level || 'Risk'} Alert: ${a.title}`,
                    severity: (a.risk_level === "Critical" || a.risk_score >= 70) ? "Critical" : "Warning",
                    message: a.summary_executive,
                    created_at: a.published_at,
                    article: a
                }));
                
                renderAlertsList(formattedAlerts);
                renderMixChart(category_counts, risk_level_counts);
            } else {
                // API Mode
                const res = await fetch(`${API_BASE}/dashboard`);
                const data = await res.json();
                
                animateCounter(statArticles, data.total_articles);
                animateCounter(statEntities, data.total_entities);
                animateCounter(statEvents, data.total_events);
                animateCounter(statAlerts, data.total_alerts);
                
                const alertCard = document.getElementById("stat-alerts-card");
                if (data.total_alerts > 0) alertCard.classList.add("alert-glow");
                else alertCard.classList.remove("alert-glow");
                
                renderAlertsList(data.latest_alerts);
                renderMixChart(data.category_counts, data.risk_level_counts);
            }
        } catch (err) {
            console.error("Error loading dashboard stats:", err);
        }
    }

    /**
     * Trace a query across every dataset, not just the article feed.
     *
     * The point of the concept mode is to answer "what do we know about X",
     * and the answer lives in four places: the article feed, the knowledge
     * graph, the PSC register and the entity tables. Searching only the feed
     * meant a query for a company with a disclosed beneficial owner returned
     * news stories and silently omitted the ownership record — the single
     * most important thing the system holds about it.
     */
    function buildTrace(query) {
        const q = String(query || "").trim().toLowerCase();
        if (q.length < 3) return null;

        const rows = [];

        const entityHits = knownEntities.filter(n =>
            String(n.label || "").toLowerCase().includes(q)).slice(0, 4);
        entityHits.forEach(n => rows.push({
            kind: n.type === "psc" ? "Beneficial owner" : (n.type || "entity"),
            label: n.label,
            note: `tracked in the knowledge graph · risk ${n.risk || "Low"}`,
            action: n.label
        }));

        // The register is loaded at boot by psc-report.js; allPscRecords is
        // only populated once the modal has been opened, so prefer whichever
        // is actually populated.
        const register = (allPscRecords && allPscRecords.length)
            ? allPscRecords
            : ((window.AuraReport && window.AuraReport.state.records) || []);

        register.forEach(r => {
            const hay = `${r["Person Name"] || ""} ${r.Company || ""} ${r["Intermediate Entities"] || ""}`.toLowerCase();
            if (!hay.includes(q)) return;
            const pct = r.Percentage ? ` · ${r.Percentage}` : "";
            rows.push({
                kind: "PSC register",
                label: `${r["Person Name"] || "Undisclosed"} → ${r.Company || "Undisclosed"}`,
                note: `${r["Nature of Control"] || "nature not disclosed"}${pct}`,
                action: r["Person Name"]
            });
        });

        const articleHits = (allArticles || []).filter(a =>
            `${a.title} ${a.summary_executive}`.toLowerCase().includes(q));
        if (articleHits.length) {
            const elevated = articleHits.filter(a => (a.risk_score || 0) >= 50).length;
            rows.push({
                kind: "Coverage",
                label: `${articleHits.length} article${articleHits.length === 1 ? "" : "s"} mention this`,
                note: elevated
                    ? `${elevated} scored at elevated risk or above`
                    : "none scored above the elevated-risk threshold"
            });
        }

        return rows.length ? rows.slice(0, 8) : null;
    }

    function renderTrace(query) {
        const panel = document.getElementById("trace-panel");
        if (!panel) return;

        const rows = isSemanticSearch ? buildTrace(query) : null;
        if (!rows) { panel.hidden = true; panel.innerHTML = ""; return; }

        panel.hidden = false;
        panel.innerHTML = `<h4>What we hold on &ldquo;${esc(query)}&rdquo;</h4>`
            + rows.map(r => `
                <div class="trace-row">
                    <span class="trace-kind">${esc(r.kind)}</span>
                    <span class="trace-value">${r.action
                        ? `<button type="button" data-trace="${esc(r.action)}">${esc(r.label)}</button>`
                        : esc(r.label)} — ${esc(r.note)}</span>
                </div>`).join("");

        panel.querySelectorAll("[data-trace]").forEach(btn => {
            btn.addEventListener("click", () => {
                const term = btn.getAttribute("data-trace");
                searchInput.value = term;
                loadNewsFeed(term, currentCategory);
            });
        });
    }

    // Term-overlap relevance score for concept search: title hits weigh 3x,
    // summary hits 1x; risk words map onto the article's actual risk level
    function conceptScore(article, query) {
        const tokens = query.toLowerCase().split(/[^a-z0-9']+/).filter(t => t.length > 2);
        if (tokens.length === 0) return 0;
        const title = article.title.toLowerCase();
        const summary = article.summary_executive.toLowerCase();
        const riskWords = { critical: "Critical", high: "High", medium: "Medium", low: "Low", risk: "" };
        let score = 0;
        tokens.forEach(t => {
            if (t in riskWords) {
                if (riskWords[t] && article.risk_level === riskWords[t]) score += 2;
                return;
            }
            if (title.includes(t)) score += 3;
            else if (summary.includes(t)) score += 1;
        });
        return score;
    }

    async function loadNewsFeed(query = "", category = "") {
        // Only show the spinner when there is nothing on screen yet. In static
        // mode the filter is a synchronous array pass, so painting a spinner
        // on every keystroke produced a flash of empty state between each
        // character rather than a live-filtering feed.
        if (!articlesList.querySelector(".article-card")) {
            articlesList.innerHTML = `
                <div class="loading-placeholder">
                    <div class="spinner"></div>
                    <p>Analyzing intelligence nodes...</p>
                </div>
            `;
        }
        try {
            let articles = [];
            if (isGitHubPages) {
                // Client-side search and category filtering in serverless mode
                if (allArticles.length === 0) {
                    const res = await fetch(`${API_BASE}/latest.json`);
                    const raw = await res.json();
                    allArticles = raw.map(normalizeArticle);
                }
                
                articles = allArticles;
                if (category) {
                    articles = articles.filter(a => a.category.toLowerCase() === category.toLowerCase());
                }
                if (currentRisk) {
                    articles = articles.filter(a => (a.risk_level || "").toLowerCase() === currentRisk.toLowerCase());
                }
                if (query) {
                    if (isSemanticSearch) {
                        // Concept mode: score every article by term overlap so
                        // multi-word queries rank by relevance instead of
                        // requiring an exact phrase match
                        articles = articles
                            .map(a => ({ a, score: conceptScore(a, query) }))
                            .filter(x => x.score > 0)
                            .sort((x, y) => y.score - x.score)
                            .map(x => x.a);
                    } else {
                        const q = query.toLowerCase();
                        articles = articles.filter(a => a.title.toLowerCase().includes(q) || a.summary_executive.toLowerCase().includes(q));
                    }
                }
            } else {
                // API mode
                let url = `${API_BASE}/news?limit=50`;
                if (category) url += `&category=${category}`;
                if (query) {
                    url = `${API_BASE}/search?q=${encodeURIComponent(query)}&limit=30`;
                }
                const res = await fetch(url);
                const data = await res.json();
                articles = query ? data.map(item => normalizeArticle(item.article)) : data.map(normalizeArticle);
            }
            if (currentSort === "risk") {
                articles = [...articles].sort((a, b) => (b.risk_score || 0) - (a.risk_score || 0));
            }
            renderNewsFeed(articles);
            renderTrace(query);
        } catch (err) {
            console.error("Error loading news feed:", err);
            articlesList.innerHTML = `<p class="error-message">Failed to load news streams.</p>`;
        }
    }

    async function loadAnalyticsAndGraph() {
        try {
            let data = null;
            if (isGitHubPages) {
                try {
                    const res = await fetch(`${API_BASE}/graph.json`);
                    if (res.ok) data = await res.json();
                } catch (e) {}

                if (!data) {
                    try {
                        const fallbackRes = await fetch(`./data/graph.json`);
                        if (fallbackRes.ok) data = await fallbackRes.json();
                    } catch (e) {}
                }
            } else {
                try {
                    const res = await fetch(`${API_BASE}/analytics`);
                    if (res.ok) data = await res.json();
                } catch (e) {}
            }

            if (data && (data.nodes || (data.graph && data.graph.nodes))) {
                const graph = data.graph || data;
                knownEntities = graph.nodes || [];
                buildKnowledgeGraph(graph);
            } else {
                buildKnowledgeGraph(getFallbackGraphData());
            }
        } catch (err) {
            console.error("Error loading graph analytics:", err);
            buildKnowledgeGraph(getFallbackGraphData());
        }
    }

    function getFallbackGraphData() {
        return {
            nodes: [
                { id: "c1", label: "Apex Technology Group", type: "company", risk: "Medium" },
                { id: "c2", label: "Vertex Financials", type: "company", risk: "Low" },
                { id: "c3", label: "AeroSpace International", type: "company", risk: "High" },
                { id: "p1", label: "Alhaji Ibrahim Musa", type: "psc", risk: "Critical" },
                { id: "p2", label: "Dr. Chidimma Okeke", type: "person", risk: "Low" },
                { id: "a1", label: "Bureau of Public Procurement (BPP)", type: "agency", risk: "Medium" },
                { id: "a2", label: "CAC Transparency Unit", type: "agency", risk: "Low" }
            ],
            edges: [
                { id: "e1", from: "p1", to: "c1", label: "PSC >25% Shares" },
                { id: "e2", from: "c1", to: "c2", label: "Subsidiary" },
                { id: "e3", from: "p2", to: "c3", label: "Director" },
                { id: "e4", from: "a1", to: "c3", label: "Procurement Auditor" },
                { id: "e5", from: "a2", to: "p1", label: "UBO Disclosure" }
            ]
        };
    }

    // ==========================================
    // COMPONENT RENDERING HELPERS
    // ==========================================

    // Count-up is delegated to motion.js, which drives it from
    // requestAnimationFrame against elapsed time.
    //
    // The previous implementation computed its step from `duration / target`
    // inside a setInterval. For target 0 that is a division by zero, and the
    // loop's exit test (`current >= target`) never fired because `current`
    // started at 0 and incremented by `Math.ceil(0 / 30) || 1`, so a zero
    // counter span left a timer running for the life of the page. It also
    // honours prefers-reduced-motion, which the old version did not.
    function animateCounter(el, target) {
        if (!el) return;
        const value = Number(target);
        if (!isFinite(value)) { el.textContent = "0"; return; }
        if (window.AuraMotion) window.AuraMotion.countUp(el, value);
        else el.textContent = String(value);
    }

    function updateFeedCount(count) {
        const feedCount = document.getElementById("feed-count");
        if (!feedCount) return;
        const filters = [];
        if (currentCategory) filters.push(currentCategory);
        if (currentRisk) filters.push(`${currentRisk} risk`);
        if (searchInput.value.trim()) filters.push(`"${searchInput.value.trim()}"`);
        const suffix = filters.length ? ` · ${filters.join(" · ")}` : "";
        feedCount.textContent = `${count} record${count === 1 ? "" : "s"}${suffix}`;
    }

    function renderNewsFeed(articles) {
        updateFeedCount(articles ? articles.length : 0);

        if (!articles || articles.length === 0) {
            articlesList.innerHTML = `
                <div class="loading-placeholder empty-state">
                    <p>No intelligence records match the current filters.</p>
                    <button id="clear-filters-btn" class="btn btn-secondary btn-sm">Clear filters</button>
                </div>`;
            const clearBtn = document.getElementById("clear-filters-btn");
            if (clearBtn) clearBtn.addEventListener("click", resetFeedFilters);
            return;
        }

        articlesList.innerHTML = "";
        articles.forEach((art, idx) => {
            const card = document.createElement("div");
            card.className = "article-card";
            card.style.setProperty("--stagger", Math.min(idx, 12));
            card.setAttribute("role", "button");
            card.setAttribute("tabindex", "0");

            const catClass = art.category ? art.category.toLowerCase().replace(/[^a-z-]/g, "") : "general";
            const riskClass = art.risk_level ? art.risk_level.toLowerCase() : "low";
            const engineChip = art.engine
                ? `<span class="engine-chip" title="Analyzed by ${esc(art.engine)}">${esc(art.engine)}</span>`
                : "";

            card.innerHTML = `
                <div class="article-card-header">
                    <span class="badge ${catClass}">${esc(art.category || "General")}</span>
                    <span title="${esc(art.published_at)}">${esc(timeAgo(art.published_at))}</span>
                </div>
                <h3>${esc(art.title)}</h3>
                <div class="article-card-footer">
                    <span class="source-label">${esc(art.source)}${engineChip}</span>
                    <span class="risk-label" title="Risk score ${esc(art.risk_score)}/100">
                        <span class="risk-dot ${riskClass}"></span>
                        ${esc(art.risk_level || "Low")} · ${esc(art.risk_score)}
                    </span>
                </div>
            `;

            card.addEventListener("click", () => openArticleModal(art));
            card.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openArticleModal(art);
                }
            });
            articlesList.appendChild(card);
        });
    }

    function resetFeedFilters() {
        currentCategory = "";
        currentRisk = "";
        searchInput.value = "";
        document.querySelectorAll(".filter-btn").forEach(b => b.classList.toggle("active", !b.getAttribute("data-category")));
        document.querySelectorAll(".filter-risk-btn").forEach(b => b.classList.toggle("active", !b.getAttribute("data-risk")));
        loadNewsFeed();
    }

    function renderAlertsList(alerts) {
        const bandCount = document.getElementById("alert-band-count");

        if (!alerts || alerts.length === 0) {
            alertsList.innerHTML = `<p class="empty-note">No risk thresholds breached in the current window.</p>`;
            if (bandCount) bandCount.textContent = "Nothing above threshold";
            return;
        }

        // Rank by severity then score. The panel previously rendered whatever
        // order the feed happened to be in, which buried the worst item.
        const ranked = [...alerts].sort((a, b) => {
            const sev = x => (String(x.severity).toLowerCase() === "critical" ? 1 : 0);
            if (sev(a) !== sev(b)) return sev(b) - sev(a);
            return ((b.article && b.article.risk_score) || 0) - ((a.article && a.article.risk_score) || 0);
        });

        const criticals = ranked.filter(a => String(a.severity).toLowerCase() === "critical").length;
        if (bandCount) {
            bandCount.textContent = criticals
                ? `${criticals} critical · ${ranked.length} elevated`
                : `${ranked.length} elevated`;
        }

        alertsList.innerHTML = "";
        ranked.forEach((alert, idx) => {
            const item = document.createElement("div");
            const severity = String(alert.severity || "info").toLowerCase();
            item.className = `alert-item ${severity}`;
            item.style.setProperty("--stagger", Math.min(idx, 8));

            const when = new Date(alert.created_at);
            const dateStr = isNaN(when.getTime())
                ? "Recent"
                : when.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

            const article = alert.article || {};
            // Strip the "Critical Alert: " prefix the caller adds: the severity
            // now has its own label, so repeating it in the title is noise.
            const title = String(alert.title || "").replace(/^\s*\w+\s+Alert:\s*/i, "");
            const score = article.risk_score !== undefined ? `${article.risk_score}/100` : "";

            item.innerHTML = `
                <span class="alert-severity">
                    ${severity === "critical" ? "&#9632; Critical" : "&#9650; Elevated"}
                </span>
                <span class="alert-title">${esc(title)}</span>
                <p class="alert-body">${esc(cleanSummary(alert.message))}</p>
                <span class="alert-meta">
                    <span>${esc(article.source || "Unknown source")}</span>
                    <span>${esc(dateStr)}</span>
                    ${score ? `<span>Risk ${esc(score)}</span>` : ""}
                </span>
            `;

            // Alerts sourced from articles open the full detail modal
            if (alert.article) {
                item.classList.add("clickable");
                item.setAttribute("role", "button");
                item.setAttribute("tabindex", "0");
                item.addEventListener("click", () => openArticleModal(alert.article));
                item.addEventListener("keydown", (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openArticleModal(alert.article);
                    }
                });
            }
            alertsList.appendChild(item);
        });
    }

    function renderMixChart(categories, risks) {
        const ctx = document.getElementById("mix-chart");
        if (!ctx) return;

        // Destroy previous instance
        if (mixChart) {
            mixChart.destroy();
        }

        const catLabels = Object.keys(categories || {});
        const catValues = Object.values(categories || {});
        const labels = catLabels.length > 0 ? catLabels : ["Government", "Company", "Legal", "General"];
        const values = catValues.length > 0 ? catValues : [15, 22, 10, 13];

        // Inner ring: risk levels in severity order with semantic colors
        const RISK_ORDER = ["Low", "Medium", "High", "Critical"];
        const RISK_COLORS = {
            Low: 'rgba(16, 185, 129, 0.7)',
            Medium: 'rgba(249, 115, 22, 0.7)',
            High: 'rgba(244, 63, 94, 0.7)',
            Critical: 'rgba(190, 18, 60, 0.85)'
        };
        const riskLabels = RISK_ORDER.filter(l => (risks || {})[l] > 0);
        const riskValues = riskLabels.map(l => risks[l]);

        const datasets = [{
            label: 'Category',
            customLabels: labels,
            data: values,
            backgroundColor: [
                'rgba(56, 189, 248, 0.75)',
                'rgba(167, 139, 250, 0.75)',
                'rgba(244, 114, 182, 0.75)',
                'rgba(139, 92, 246, 0.75)',
                'rgba(16, 185, 129, 0.75)',
                'rgba(249, 115, 22, 0.75)'
            ],
            borderColor: 'rgba(255, 255, 255, 0.1)',
            borderWidth: 1
        }];

        if (riskLabels.length > 0) {
            datasets.push({
                label: 'Risk',
                customLabels: riskLabels,
                data: riskValues,
                backgroundColor: riskLabels.map(l => RISK_COLORS[l]),
                borderColor: 'rgba(255, 255, 255, 0.1)',
                borderWidth: 1
            });
        }

        mixChart = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: labels,
                datasets: datasets
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'right',
                        labels: {
                            color: '#9ca3af',
                            font: { family: 'Outfit', size: 10 },
                            padding: 8,
                            // Merge both rings into one legend: categories then risks
                            generateLabels: (chart) => {
                                const items = [];
                                chart.data.datasets.forEach((ds, di) => {
                                    (ds.customLabels || []).forEach((lbl, i) => {
                                        items.push({
                                            text: di === 0 ? lbl : `${lbl} risk`,
                                            fillStyle: ds.backgroundColor[i % ds.backgroundColor.length],
                                            strokeStyle: 'rgba(255,255,255,0.1)',
                                            fontColor: '#9ca3af',
                                            datasetIndex: di,
                                            index: i
                                        });
                                    });
                                });
                                return items;
                            }
                        }
                    },
                    tooltip: {
                        callbacks: {
                            label: (c) => `${c.dataset.label}: ${c.dataset.customLabels[c.dataIndex]} — ${c.raw}`
                        }
                    }
                },
                cutout: '40%'
            }
        });
    }

    // ==========================================
    // VIS.JS KNOWLEDGE GRAPH BUILDER
    // ==========================================

    function buildKnowledgeGraph(graphData) {
        const container = document.getElementById("network-container");
        if (!container || !graphData) return;

        const rawNodes = (graphData.nodes || (graphData.graph && graphData.graph.nodes)) || [];
        const rawEdges = (graphData.edges || (graphData.graph && graphData.graph.edges)) || [];

        if (!rawNodes || rawNodes.length === 0) {
            container.innerHTML = `<div class="loading-placeholder"><p style="font-size:12px; color:var(--text-muted); padding:30px; text-align:center;">No entity relationship nodes available.</p></div>`;
            return;
        }

        const nodes = [];
        const edges = [];

        // Connection counts drive node size so hub entities stand out
        const rawNodeIds = new Set(rawNodes.map(n => n.id));
        const degree = {};
        rawEdges.forEach(e => {
            if (e.from && e.to && rawNodeIds.has(e.from) && rawNodeIds.has(e.to)) {
                degree[e.from] = (degree[e.from] || 0) + 1;
                degree[e.to] = (degree[e.to] || 0) + 1;
            }
        });

        const TYPE_META = {
            person:  { color: "#38bdf8", shape: "dot",      label: "Person" },
            company: { color: "#a78bfa", shape: "square",   label: "Company" },
            agency:  { color: "#f472b6", shape: "triangle", label: "Agency" },
            psc:     { color: "#ef4444", shape: "diamond",  label: "PSC / Beneficial Owner" }
        };

        // Setup Nodes (dedupe by id: exported data can contain case-variant
        // duplicates that hash to the same id, which crashes vis.DataSet)
        const seenNodeIds = new Set();
        rawNodes.forEach(node => {
            if (!node.id || seenNodeIds.has(node.id)) return;
            seenNodeIds.add(node.id);
            const meta = TYPE_META[node.type] || { color: "#8b5cf6", shape: "dot", label: "Entity" };
            const links = degree[node.id] || 0;
            const name = node.label || node.name || "Entity";

            nodes.push({
                id: node.id,
                label: name,
                title: `${name}\n${meta.label} · Risk: ${node.risk || "Low"} · ${links} link${links === 1 ? "" : "s"}`,
                color: {
                    background: meta.color,
                    border: 'rgba(255,255,255,0.15)',
                    highlight: {
                        background: '#06b6d4',
                        border: '#fff'
                    }
                },
                shape: meta.shape,
                size: 12 + Math.min(links * 3, 16),
                font: {
                    color: '#e5e7eb',
                    size: 11,
                    face: 'Outfit'
                }
            });
        });

        // Setup Edges (deduped by id for the same reason as nodes)
        const seenEdgeIds = new Set();
        rawEdges.forEach(edge => {
            const edgeId = edge.id || `${edge.from}-${edge.to}`;
            if (seenEdgeIds.has(edgeId)) return;
            seenEdgeIds.add(edgeId);
            edges.push({
                id: edgeId,
                from: edge.from,
                to: edge.to,
                label: edge.label || "",
                arrows: 'to',
                color: {
                    color: 'rgba(255, 255, 255, 0.15)',
                    highlight: '#06b6d4'
                },
                font: {
                    color: '#9ca3af',
                    size: 8,
                    face: 'Space Grotesk',
                    background: '#090a0f'
                },
                smooth: {
                    type: 'curvedCW',
                    roundness: 0.15
                }
            });
        });

        const nodeIds = new Set(nodes.map(n => n.id));
        const validEdges = edges.filter(e => e.from && e.to && nodeIds.has(e.from) && nodeIds.has(e.to));

        if (typeof vis === "undefined" || !vis.Network) {
            console.error("Vis.js network library not loaded.");
            container.innerHTML = `<div class="loading-placeholder"><p style="font-size:12px; color:var(--text-muted); padding:30px; text-align:center;">Network visualization library loading...</p></div>`;
            return;
        }

        const data = {
            nodes: (typeof vis.DataSet !== "undefined") ? new vis.DataSet(nodes) : nodes,
            edges: (typeof vis.DataSet !== "undefined") ? new vis.DataSet(validEdges) : validEdges
        };

        const options = {
            physics: {
                stabilization: {
                    enabled: true,
                    iterations: 150
                },
                barnesHut: {
                    gravitationalConstant: -2000,
                    centralGravity: 0.1,
                    springLength: 120,
                    springConstant: 0.04,
                    damping: 0.09,
                    avoidOverlap: 0.1
                },
                maxVelocity: 50,
                minVelocity: 0.1,
                timestep: 0.4
            },
            interaction: {
                hover: true,
                zoomView: true
            }
        };

        // Destroy the previous instance before replacing it. Overwriting the
        // variable left the old network's canvas, physics loop and resize
        // listeners alive, so every rebuild leaked one.
        if (network && typeof network.destroy === "function") {
            try { network.destroy(); } catch (e) { /* already gone */ }
        }
        container.innerHTML = "";
        network = new vis.Network(container, data, options);

        // Panel subtitle doubles as a live entity/link counter
        const graphStats = document.getElementById("graph-stats");
        if (graphStats) {
            graphStats.textContent = `${nodes.length} entities · ${validEdges.length} links — click a node to filter the feed`;
        }

        // ------------------------------------------------------------------
        // Continuous drift.
        //
        // The graph used to stabilise and then sit perfectly still, which made
        // a live intelligence map look like a screenshot. Rather than pushing
        // the nodes around — which fights the physics solver, invalidates the
        // layout the user is reading, and makes clicking a moving target — the
        // *viewport* orbits: a slow circular pan around the graph's centre.
        // The relative positions never change, so the map stays readable and
        // every node stays exactly where the user last saw it relative to its
        // neighbours.
        // ------------------------------------------------------------------
        const driftMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
        let driftFrame = null;
        let driftAngle = 0;
        let driftPaused = false;
        let driftOnScreen = true;
        let driftBase = null;

        function driftShouldRun() {
            return !driftMotion.matches && !driftPaused && driftOnScreen && !document.hidden;
        }

        function driftStep() {
            if (!network || !driftShouldRun()) { driftFrame = null; return; }
            driftAngle += 0.0022;
            if (!driftBase) driftBase = network.getViewPosition();
            // A radius of a few dozen units reads as breathing, not travel.
            const radius = 26;
            network.moveTo({
                position: {
                    x: driftBase.x + Math.cos(driftAngle) * radius,
                    y: driftBase.y + Math.sin(driftAngle) * radius * 0.55
                },
                animation: false
            });
            driftFrame = requestAnimationFrame(driftStep);
        }

        function driftSync() {
            if (driftShouldRun()) {
                if (!driftFrame) driftFrame = requestAnimationFrame(driftStep);
            } else if (driftFrame) {
                cancelAnimationFrame(driftFrame);
                driftFrame = null;
            }
        }

        // Start only once the solver has settled, otherwise the pan fights the
        // stabilisation and the whole thing judders.
        network.once("stabilized", () => {
            network.fit({ animation: { duration: 400 } });
            setTimeout(() => { driftBase = network.getViewPosition(); driftSync(); }, 450);
        });

        // Dragging or zooming re-bases the orbit so the view does not snap back.
        network.on("dragEnd", () => { driftBase = network.getViewPosition(); });
        network.on("zoom", () => { driftBase = network.getViewPosition(); });

        if (typeof driftMotion.addEventListener === "function") {
            driftMotion.addEventListener("change", driftSync);
        }
        document.addEventListener("visibilitychange", driftSync);
        if (typeof IntersectionObserver === "function") {
            new IntersectionObserver((entries) => {
                driftOnScreen = entries[0].isIntersecting;
                driftSync();
            }, { threshold: 0.05 }).observe(container);
        }

        // Setup Graph Toolbar Buttons
        const zoomInBtn = document.getElementById("graph-zoom-in");
        const zoomOutBtn = document.getElementById("graph-zoom-out");
        const fitBtn = document.getElementById("graph-fit");
        const physicsBtn = document.getElementById("graph-physics-toggle");
        let physicsEnabled = true;

        if (zoomInBtn) {
            zoomInBtn.onclick = () => {
                if (network) network.moveTo({ scale: network.getScale() * 1.25, animation: { duration: 300 } });
            };
        }
        if (zoomOutBtn) {
            zoomOutBtn.onclick = () => {
                if (network) network.moveTo({ scale: network.getScale() * 0.75, animation: { duration: 300 } });
            };
        }
        if (fitBtn) {
            fitBtn.onclick = () => {
                if (network) network.fit({ animation: { duration: 500 } });
            };
        }
        if (physicsBtn) {
            physicsBtn.onclick = () => {
                if (!network) return;
                physicsEnabled = !physicsEnabled;
                network.setOptions({ physics: { enabled: physicsEnabled } });
                // The same control stops the orbit, so one press genuinely
                // stills the panel (WCAG 2.2.2) rather than freezing the
                // simulation while the viewport keeps moving.
                driftPaused = !physicsEnabled;
                driftSync();
                physicsBtn.classList.toggle("active", !physicsEnabled);
                physicsBtn.setAttribute("aria-pressed", String(!physicsEnabled));
                physicsBtn.innerHTML = physicsEnabled ? `<i data-lucide="pause"></i>` : `<i data-lucide="play"></i>`;
                if (window.lucide) window.lucide.createIcons();
            };
        }

        // The global motion toggle in the header also governs the graph.
        document.addEventListener("aura:motion", (e) => {
            driftPaused = !!(e.detail && e.detail.paused);
            driftSync();
        });

        // Neighborhood highlight: dim everything not connected to the clicked node
        const canUpdateNodes = typeof vis.DataSet !== "undefined";

        function highlightNeighborhood(nodeId) {
            if (!canUpdateNodes) return;
            const neighbors = new Set(network.getConnectedNodes(nodeId));
            neighbors.add(nodeId);
            data.nodes.update(nodes.map(n => neighbors.has(n.id)
                ? { id: n.id, color: n.color, font: { color: '#e5e7eb' } }
                : {
                    id: n.id,
                    color: { background: 'rgba(75, 85, 99, 0.18)', border: 'rgba(255,255,255,0.04)' },
                    font: { color: 'rgba(156, 163, 175, 0.3)' }
                }
            ));
        }

        function resetHighlight() {
            if (!canUpdateNodes) return;
            data.nodes.update(nodes.map(n => ({ id: n.id, color: n.color, font: { color: '#e5e7eb' } })));
        }

        // Click interaction: spotlight the neighborhood and filter feed by entity;
        // clicking empty space restores the graph and the full feed.
        network.on("click", (params) => {
            if (params.nodes && params.nodes.length > 0) {
                const nodeId = params.nodes[0];
                highlightNeighborhood(nodeId);
                const clickedNode = nodes.find(n => n.id === nodeId);
                if (clickedNode && clickedNode.label) {
                    searchInput.value = clickedNode.label;
                    loadNewsFeed(clickedNode.label);
                }
            } else {
                resetHighlight();
                if (searchInput.value) {
                    searchInput.value = "";
                    loadNewsFeed("", currentCategory);
                }
            }
        });
    }

    // ==========================================
    // ARTICLE MODAL LOGIC
    // ==========================================

    function openArticleModal(art) {
        currentArticleData = art;
        
        modalTitle.innerText = art.title;
        modalSource.innerHTML = `<i data-lucide="globe"></i> ${esc(art.source)}`;
        modalDate.innerHTML = `<i data-lucide="calendar"></i> ${art.published_at ? new Date(art.published_at).toLocaleDateString() : "Recent"}`;
        modalImportance.innerText = `Importance: ${Math.round(art.importance_score)}`;
        modalSentiment.innerText = art.sentiment;
        
        // Sentiment Badge style
        modalSentiment.className = "sentiment-badge";
        if (art.sentiment === "Positive") modalSentiment.style.color = "var(--success)";
        else if (art.sentiment === "Negative") modalSentiment.style.color = "var(--danger)";
        else modalSentiment.style.color = "var(--text-muted)";

        // Risk level class
        const risk = art.risk_level ? art.risk_level.toLowerCase() : "low";
        modalRisk.className = `risk-badge ${risk}`;
        modalRisk.innerText = `${art.risk_level} Risk`;

        // Category Badge
        const cat = art.category ? art.category.toLowerCase() : "general";
        modalCategory.className = `badge ${cat}`;
        modalCategory.innerText = art.category || "General";

        // AI Engine provenance chip
        const modalEngine = document.getElementById("modal-engine");
        if (modalEngine) {
            if (art.engine) {
                modalEngine.style.display = "";
                modalEngine.innerText = `Engine: ${art.engine}`;
            } else {
                modalEngine.style.display = "none";
            }
        }

        modalSourceLink.href = safeUrl(art.url);

        // Render Tabs
        tabExec.innerText = art.summary_executive || "No summary available.";
        renderDetailsTab(art);
        renderRelatedTab(art);

        // Reset tabs UI
        tabBtns.forEach(btn => btn.classList.remove("active"));
        tabBtns[0].classList.add("active");
        document.querySelectorAll(".tab-content").forEach(content => content.classList.add("hidden"));
        tabExecWrapper.classList.remove("hidden");

        // Fetch related entities (mock parse for display)
        renderModalEntities(art);

        modal.classList.add("active");
        
        if (window.lucide) {
            window.lucide.createIcons();
        }
    }

    // Match the article's text against real entities from the knowledge graph
    function matchArticleEntities(art) {
        const haystack = `${art.title} ${art.summary_executive}`.toLowerCase();
        const matches = [];
        const seen = new Set();
        knownEntities.forEach(node => {
            const name = (node.label || "").trim();
            if (name.length < 4) return;
            const key = name.toLowerCase();
            if (seen.has(key)) return;
            if (haystack.includes(key)) {
                seen.add(key);
                matches.push({ name, type: node.type || "company" });
            }
        });
        return matches.slice(0, 10);
    }

    function renderModalEntities(art) {
        modalEntities.innerHTML = "";
        const matches = matchArticleEntities(art);

        if (matches.length === 0) {
            modalEntities.innerHTML = `<span style="font-size:12px; color:var(--text-muted);">No tracked entities matched in this article. Entities appear here once they exist in the knowledge graph.</span>`;
            return;
        }

        const ICONS = { person: "user", psc: "shield-alert", company: "briefcase", agency: "landmark" };
        matches.forEach(m => {
            const tag = document.createElement("button");
            tag.type = "button";
            tag.className = `entity-tag ${m.type}`;
            tag.title = `Filter the feed by ${m.name}`;
            tag.innerHTML = `<i data-lucide="${ICONS[m.type] || "briefcase"}"></i> ${esc(m.name)}`;
            tag.addEventListener("click", () => {
                closeModal();
                searchInput.value = m.name;
                loadNewsFeed(m.name, currentCategory);
            });
            modalEntities.appendChild(tag);
        });
    }

    function renderDetailsTab(art) {
        const host = art.url && art.url !== "#" ? (() => { try { return new URL(art.url).hostname; } catch (e) { return art.url; } })() : "—";
        const published = art.published_at ? new Date(art.published_at).toLocaleString() : "Unknown";
        tabDetailedWrapper.innerHTML = `
            <p class="details-summary">${esc(art.summary_executive)}</p>
            <div class="facts-grid">
                <div class="fact"><span class="fact-label">Category</span><span>${esc(art.category || "Other")}</span></div>
                <div class="fact"><span class="fact-label">Risk</span><span>${esc(art.risk_level)} — ${esc(art.risk_score)}/100</span></div>
                <div class="fact"><span class="fact-label">Source</span><span>${esc(art.source)}</span></div>
                <div class="fact"><span class="fact-label">Domain</span><span>${esc(host)}</span></div>
                <div class="fact"><span class="fact-label">Published</span><span>${esc(published)}</span></div>
                <div class="fact"><span class="fact-label">AI Engine</span><span>${esc(art.engine || "n/a")}</span></div>
            </div>
        `;
    }

    function renderRelatedTab(art) {
        // Rank other articles by shared meaningful title tokens and entities
        const stop = new Set(["the", "and", "for", "with", "from", "over", "into", "amid", "after", "nigeria", "nigerian", "news", "guardian", "premium", "times", "punch", "vanguard", "dailypost"]);
        const tokens = new Set(
            `${art.title} ${art.summary_executive}`.toLowerCase().split(/[^a-z0-9']+/)
                .filter(t => t.length > 3 && !stop.has(t))
        );
        const entityNames = matchArticleEntities(art).map(m => m.name.toLowerCase());

        const scored = allArticles
            .filter(a => a && a.url !== art.url)
            .map(a => {
                const text = `${a.title} ${a.summary_executive}`.toLowerCase();
                let score = 0;
                tokens.forEach(t => { if (text.includes(t)) score += 1; });
                entityNames.forEach(n => { if (text.includes(n)) score += 4; });
                if (a.category === art.category) score += 1;
                return { a, score };
            })
            .filter(x => x.score >= 3)
            .sort((x, y) => y.score - x.score)
            .slice(0, 5);

        if (scored.length === 0) {
            tabTimelineWrapper.innerHTML = `<p class="details-summary" style="color:var(--text-muted);">No related intelligence records found for this story yet.</p>`;
            return;
        }

        tabTimelineWrapper.innerHTML = "";
        scored.forEach(({ a }) => {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "related-item";
            item.innerHTML = `
                <span class="related-title">${esc(a.title)}</span>
                <span class="related-meta">${esc(a.source)} · ${esc(timeAgo(a.published_at))} · <span class="risk-dot ${esc((a.risk_level || "low").toLowerCase())}"></span>${esc(a.risk_level)}</span>
            `;
            item.addEventListener("click", () => openArticleModal(a));
            tabTimelineWrapper.appendChild(item);
        });
    }

    function closeModal() {
        modal.classList.remove("active");
        currentArticleData = null;
    }

    // ==========================================
    // INTERACTION LISTENERS
    // ==========================================

    // Tab switcher
    tabBtns.forEach(btn => {
        btn.addEventListener("click", () => {
            tabBtns.forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            
            document.querySelectorAll(".tab-content").forEach(content => content.classList.add("hidden"));
            
            const tabId = btn.getAttribute("data-tab");
            if (tabId === "executive") tabExecWrapper.classList.remove("hidden");
            else if (tabId === "detailed") tabDetailedWrapper.classList.remove("hidden");
            else if (tabId === "timeline") tabTimelineWrapper.classList.remove("hidden");
        });
    });

    closeModalBtn.addEventListener("click", closeModal);
    modal.addEventListener("click", (e) => {
        if (e.target === modal) closeModal();
    });

    // Focus trap: without this, tabbing inside an open modal walks into the
    // page behind it, which strands keyboard and screen-reader users.
    const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

    function topmostOpenModal() {
        const open = [...document.querySelectorAll('.modal-overlay.active')];
        if (open.length === 0) return null;
        // Highest stacking context wins (the PSC dossier sits above the PSC list)
        return open.sort((a, b) =>
            (parseInt(getComputedStyle(a).zIndex, 10) || 0) - (parseInt(getComputedStyle(b).zIndex, 10) || 0)
        ).pop();
    }

    document.addEventListener("keydown", (e) => {
        if (e.key !== "Tab") return;
        const modal = topmostOpenModal();
        if (!modal) return;

        const items = [...modal.querySelectorAll(FOCUSABLE)]
            .filter(el => el.offsetParent !== null || el === document.activeElement);
        if (items.length === 0) return;

        const first = items[0];
        const last = items[items.length - 1];

        if (!modal.contains(document.activeElement)) {
            e.preventDefault();
            first.focus();
            return;
        }
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    });

    // Move focus into a modal when it opens, and restore it on close
    let lastFocusedBeforeModal = null;
    const modalObserver = new MutationObserver((mutations) => {
        mutations.forEach(m => {
            if (m.attributeName !== "class") return;
            const el = m.target;
            if (!el.classList.contains("modal-overlay")) return;
            if (el.classList.contains("active")) {
                lastFocusedBeforeModal = lastFocusedBeforeModal || document.activeElement;
                const target = el.querySelector(FOCUSABLE);
                if (target) setTimeout(() => target.focus(), 50);
            } else if (!document.querySelector(".modal-overlay.active")) {
                if (lastFocusedBeforeModal && lastFocusedBeforeModal.focus) {
                    lastFocusedBeforeModal.focus();
                }
                lastFocusedBeforeModal = null;
            }
        });
    });
    document.querySelectorAll(".modal-overlay").forEach(m =>
        modalObserver.observe(m, { attributes: true, attributeFilter: ["class"] })
    );

    // Global keyboard navigation.
    //
    // Escape closes the topmost dialog only, so dismissing the PSC dossier
    // returns you to the register behind it instead of closing everything at
    // once. The dossier was previously not closable by keyboard at all.
    document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        const topmost = topmostOpenModal();
        if (!topmost) return;
        if (topmost.id === "detail-modal") closeModal();
        else topmost.classList.remove("active");
    });

    // Category filter buttons
    const filterBtns = document.querySelectorAll(".filter-btn");
    filterBtns.forEach(btn => {
        btn.addEventListener("click", () => {
            filterBtns.forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            currentCategory = btn.getAttribute("data-category");
            
            // Clear search when filtering categories
            searchInput.value = "";
            loadNewsFeed("", currentCategory);
        });
    });

    // Search trigger
    searchBtn.addEventListener("click", () => {
        const query = searchInput.value.trim();
        loadNewsFeed(query, currentCategory);
    });

    searchInput.addEventListener("keypress", (e) => {
        if (e.key === "Enter") {
            const query = searchInput.value.trim();
            loadNewsFeed(query, currentCategory);
        }
    });

    // Live search: debounced so the feed filters as you type without thrashing
    let searchDebounce = null;
    searchInput.addEventListener("input", () => {
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => {
            loadNewsFeed(searchInput.value.trim(), currentCategory);
        }, 300);
    });

    // Feed sort selector
    const feedSortSelect = document.getElementById("feed-sort");
    if (feedSortSelect) {
        feedSortSelect.addEventListener("change", () => {
            currentSort = feedSortSelect.value;
            loadNewsFeed(searchInput.value.trim(), currentCategory);
        });
    }

    // Risk level filter buttons
    const riskBtns = document.querySelectorAll(".filter-risk-btn");
    riskBtns.forEach(btn => {
        btn.addEventListener("click", () => {
            riskBtns.forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            currentRisk = btn.getAttribute("data-risk") || "";
            loadNewsFeed(searchInput.value, currentCategory);
        });
    });

    // Export CSV Handler
    const exportCsvBtn = document.getElementById("export-csv-btn");
    if (exportCsvBtn) {
        exportCsvBtn.addEventListener("click", exportIntelligenceCSV);
    }

    function exportIntelligenceCSV() {
        if (!allArticles || allArticles.length === 0) {
            alert("No articles loaded yet to export.");
            return;
        }

        // Quote-escape and neutralize spreadsheet formula injection: a title
        // like "=HYPERLINK(...)" must not execute when the CSV opens in Excel
        const csvField = (val) => {
            let s = String(val == null ? "" : val);
            if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
            return `"${s.replace(/"/g, '""')}"`;
        };

        const headers = ["ID", "Time", "Title", "Source", "URL", "Category", "Risk Level", "Risk Score", "Summary"];
        const rows = allArticles.map(a => [
            csvField(a.id),
            csvField(a.published_at),
            csvField(a.title),
            csvField(a.source),
            csvField(a.url),
            csvField(a.category),
            csvField(a.risk_level),
            csvField(a.risk_score),
            csvField(a.summary_executive)
        ]);

        // BOM keeps Excel from mangling non-ASCII; Blob (not a data: URI)
        // because encodeURI leaves '#' intact, which truncates the download
        // at the first '#' in any article field.
        const csvContent = "﻿" + [headers.join(","), ...rows.map(e => e.join(","))].join("\r\n");
        const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);

        const link = document.createElement("a");
        link.href = url;
        link.download = `aura_intelligence_export_${new Date().toISOString().slice(0,10)}.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    // PSC Disclosure Modal & Beneficial Ownership (UBO) Intelligence Handlers
    const viewPscBtn = document.getElementById("view-psc-btn");
    const pscModal = document.getElementById("psc-modal");
    const closePscModalBtn = document.getElementById("close-psc-modal");
    const pscTableContainer = document.getElementById("psc-table-container");
    const pscNetworkGraphContainer = document.getElementById("psc-network-graph-container");
    const pscViewTableBtn = document.getElementById("psc-view-table-btn");
    const pscViewMapBtn = document.getElementById("psc-view-map-btn");
    const pscDossierModal = document.getElementById("psc-dossier-modal");
    const closePscDossierModalBtn = document.getElementById("close-psc-dossier-modal");
    const pscDossierBody = document.getElementById("psc-dossier-body");
    const exportPscCsvBtn = document.getElementById("export-psc-csv-btn");
    const exportPscReportBtn = document.getElementById("export-psc-report-btn");

    let activePscFilter = "all";
    let currentPscSearchQuery = "";
    let pscViewMode = "table"; // "table" or "map"

    // The illustrative PSC set lives in data/significant_control.json and is
    // generated from DEMO_PSC_RECORDS in run_pipeline.py. A second copy used to
    // live here, and the two drifted: the client copy carried extra invented
    // claims -- including a PEP classification -- against named real people.
    // There is now exactly one source of truth, and every seeded row is marked
    // with Source="seed" so it can never be presented as extracted intelligence.

    if (viewPscBtn && pscModal) {
        viewPscBtn.addEventListener("click", async () => {
            pscModal.classList.add("active");
            await loadPSCRecords();
        });
    }

    if (closePscModalBtn && pscModal) {
        closePscModalBtn.addEventListener("click", () => {
            pscModal.classList.remove("active");
        });
        pscModal.addEventListener("click", (e) => {
            if (e.target === pscModal) pscModal.classList.remove("active");
        });
    }

    if (closePscDossierModalBtn && pscDossierModal) {
        closePscDossierModalBtn.addEventListener("click", () => {
            pscDossierModal.classList.remove("active");
        });
        pscDossierModal.addEventListener("click", (e) => {
            if (e.target === pscDossierModal) pscDossierModal.classList.remove("active");
        });
    }

    // View Mode Toggle Handlers
    if (pscViewTableBtn && pscViewMapBtn) {
        pscViewTableBtn.addEventListener("click", () => {
            pscViewMode = "table";
            pscViewTableBtn.classList.add("active");
            pscViewTableBtn.style.background = "var(--primary)";
            pscViewTableBtn.style.color = "#0f172a";

            pscViewMapBtn.classList.remove("active");
            pscViewMapBtn.style.background = "transparent";
            pscViewMapBtn.style.color = "#d1d5db";

            if (pscTableContainer) pscTableContainer.style.display = "block";
            if (pscNetworkGraphContainer) pscNetworkGraphContainer.style.display = "none";
            renderPSCTableRows();
        });

        pscViewMapBtn.addEventListener("click", () => {
            pscViewMode = "map";
            pscViewMapBtn.classList.add("active");
            pscViewMapBtn.style.background = "var(--primary)";
            pscViewMapBtn.style.color = "#0f172a";

            pscViewTableBtn.classList.remove("active");
            pscViewTableBtn.style.background = "transparent";
            pscViewTableBtn.style.color = "#d1d5db";

            if (pscTableContainer) pscTableContainer.style.display = "none";
            if (pscNetworkGraphContainer) pscNetworkGraphContainer.style.display = "block";
            renderPSCNetworkGraph();
        });
    }

    const pscSearchInput = document.getElementById("psc-search-input");
    if (pscSearchInput) {
        pscSearchInput.addEventListener("input", (e) => {
            currentPscSearchQuery = (e.target.value || "").toLowerCase();
            if (pscViewMode === "table") renderPSCTableRows();
            else renderPSCNetworkGraph();
        });
    }

    // PSC Filter Chips event handling
    const filterChips = document.querySelectorAll(".psc-chip");
    filterChips.forEach(chip => {
        chip.addEventListener("click", () => {
            filterChips.forEach(c => c.classList.remove("active"));
            chip.classList.add("active");
            activePscFilter = chip.getAttribute("data-filter") || "all";
            if (pscViewMode === "table") renderPSCTableRows();
            else renderPSCNetworkGraph();
        });
    });

    if (exportPscCsvBtn) {
        exportPscCsvBtn.addEventListener("click", () => exportPSCCSV());
    }

    if (exportPscReportBtn) {
        exportPscReportBtn.addEventListener("click", () => exportPSCComplianceReport());
    }

    // Helper: Calculate Red Flags for a record
    function getRecordRedFlags(r) {
        let flags = r["Red Flags"] ? [...r["Red Flags"]] : [];

        const isPep = (r["PEP Status"] || "").toLowerCase().startsWith("yes");
        if (isPep && !flags.includes("PEP Proximity Alert")) {
            flags.push("PEP Proximity Alert");
        }

        const directVal = parseFloat((r["Direct %"] || "0").replace("%", ""));
        const votingVal = parseFloat((r["Voting Rights %"] || r["Percentage"] || "0").replace("%", ""));
        if (!isNaN(directVal) && !isNaN(votingVal) && (votingVal - directVal) > 15) {
            if (!flags.includes("Voting Discrepancy")) flags.push("Voting Discrepancy");
        }

        const holding = (r["Intermediate Entities"] || "").toLowerCase();
        if ((holding.includes("mauritius") || holding.includes("trust") || holding.includes("offshore")) && !flags.includes("Complex Offshore Vehicle")) {
            flags.push("Complex Offshore Vehicle");
        }

        // Check if person holds stakes in multiple companies
        const personName = (r["Person Name"] || "").toLowerCase();
        const matches = allPscRecords.filter(x => (x["Person Name"] || "").toLowerCase() === personName);
        if (matches.length > 1 && !flags.includes("Cross-Entity Portfolio")) {
            flags.push("Cross-Entity Portfolio");
        }

        return flags;
    }

    async function loadPSCRecords() {
        if (!pscTableContainer) return;
        pscTableContainer.innerHTML = `
            <div class="loading-placeholder">
                <div class="spinner"></div>
                <p>Loading PSC Beneficial Ownership & Anomaly Records...</p>
            </div>
        `;
        try {
            const res = await fetch(`${API_BASE}/significant_control.json`);
            allPscRecords = res.ok ? (await res.json()) : [];
        } catch (err) {
            console.error("Error loading PSC records:", err);
            allPscRecords = [];
        }
        if (!Array.isArray(allPscRecords)) allPscRecords = [];

        // Key the disclosure off the records themselves, not off "is the list
        // empty". The old test was `!(fetched && fetched.length > 0)`, which is
        // false whenever seeded rows are present — so a list made entirely of
        // sample records rendered with no banner at all, as verified
        // intelligence. Any seeded row now forces the notice.
        usingDemoPsc = allPscRecords.some(r => String(r && r.Source).toLowerCase() === "seed");

        const demoBanner = document.getElementById("psc-demo-banner");
        if (demoBanner) demoBanner.hidden = !usingDemoPsc;

        updatePSCKPIs();
        renderPSCTableRows();
        if (window.lucide) window.lucide.createIcons();
    }

    function updatePSCKPIs() {
        const kpiTotal = document.getElementById("kpi-total-psc");
        const kpiAvgStake = document.getElementById("kpi-avg-stake");
        const kpiIndirect = document.getElementById("kpi-indirect-cnt");
        const kpiRedflag = document.getElementById("kpi-redflag-cnt");
        const kpiCama = document.getElementById("kpi-cama-status");

        if (!allPscRecords || allPscRecords.length === 0) return;

        if (kpiTotal) kpiTotal.innerText = allPscRecords.length;

        let totalPct = 0;
        let validPctCnt = 0;
        let indirectCnt = 0;
        let redflagCnt = 0;

        allPscRecords.forEach(r => {
            const pctStr = (r["Percentage"] || "").replace("%", "").trim();
            const pctVal = parseFloat(pctStr);
            if (!isNaN(pctVal)) {
                totalPct += pctVal;
                validPctCnt++;
            }
            if (r["Intermediate Entities"] && r["Intermediate Entities"] !== "Direct Holding" && r["Intermediate Entities"] !== "Direct Shareholder") {
                indirectCnt++;
            }
            const flags = getRecordRedFlags(r);
            if (flags.length > 0) redflagCnt++;
        });

        if (kpiAvgStake) {
            const avg = validPctCnt > 0 ? (totalPct / validPctCnt).toFixed(1) : "0.0";
            kpiAvgStake.innerText = `${avg}%`;
        }
        if (kpiIndirect) kpiIndirect.innerText = indirectCnt;
        if (kpiRedflag) kpiRedflag.innerText = redflagCnt;
        // Was hardcoded to "94.2%" and then written into a downloadable
        // audit brief as a verified figure. Now derived: the share of
        // records that actually cite a regulatory filing reference.
        if (kpiCama) {
            const withRef = allPscRecords.filter(r => String(r["Regulatory Filing Ref"] || "").trim()).length;
            kpiCama.innerText = allPscRecords.length
                ? `${Math.round((withRef / allPscRecords.length) * 100)}%`
                : "n/a";
        }
    }

    function getFilteredPSCData() {
        let pscData = allPscRecords;

        // Apply Chip Filters
        if (activePscFilter === "redflags") {
            pscData = pscData.filter(r => getRecordRedFlags(r).length > 0);
        } else if (activePscFilter === "tier1") {
            pscData = pscData.filter(r => {
                const val = parseFloat((r["Percentage"] || "").replace("%", ""));
                return !isNaN(val) && val >= 75;
            });
        } else if (activePscFilter === "nigeriaband") {
            // The band that exists only under the Nigerian 5% threshold.
            pscData = pscData.filter(r => {
                const val = parseFloat((r["Percentage"] || "").replace("%", ""));
                return !isNaN(val) && val >= 5 && val < 25;
            });
        } else if (activePscFilter === "indirect") {
            pscData = pscData.filter(r => 
                (r["Intermediate Entities"] && r["Intermediate Entities"] !== "Direct Holding" && r["Intermediate Entities"] !== "Direct Shareholder") ||
                (r["Nature of Control"] || "").toLowerCase().includes("indirect")
            );
        } else if (activePscFilter === "pep") {
            pscData = pscData.filter(r => (r["PEP Status"] || "").toLowerCase().startsWith("yes"));
        } else if (activePscFilter === "cross") {
            pscData = pscData.filter(r => {
                const name = (r["Person Name"] || "").toLowerCase();
                return allPscRecords.filter(x => (x["Person Name"] || "").toLowerCase() === name).length > 1;
            });
        }

        // Apply Search Query Filter
        if (currentPscSearchQuery) {
            pscData = pscData.filter(r => 
                (r["Person Name"] || "").toLowerCase().includes(currentPscSearchQuery) ||
                (r["Company"] || "").toLowerCase().includes(currentPscSearchQuery) ||
                (r["Intermediate Entities"] || "").toLowerCase().includes(currentPscSearchQuery) ||
                (r["Nature of Control"] || "").toLowerCase().includes(currentPscSearchQuery) ||
                (r["Regulatory Filing Ref"] || "").toLowerCase().includes(currentPscSearchQuery)
            );
        }
        return pscData;
    }

    function renderPSCTableRows() {
        if (!pscTableContainer) return;
        const pscData = getFilteredPSCData();

        if (!pscData || pscData.length === 0) {
            pscTableContainer.innerHTML = `<p style="padding:25px; text-align:center; color:var(--text-muted);">No Persons with Significant Control (PSC) disclosures match the selected filters.</p>`;
            return;
        }

        let html = `
            <table style="width:100%; border-collapse:collapse; font-size:12.5px; text-align:left; color:#e5e7eb;">
                <thead>
                    <tr style="border-bottom:1px solid rgba(255,255,255,0.12); color:var(--text-muted); font-size:11px; text-transform:uppercase; letter-spacing:0.5px;">
                        <th style="padding:10px;">Beneficial Owner</th>
                        <th style="padding:10px;">Target & Holding Entity</th>
                        <th style="padding:10px;">Control Tier & Nature</th>
                        <th style="padding:10px;">Equity Stake</th>
                        <th style="padding:10px;">Anomalies & Red Flags</th>
                        <th style="padding:10px;">Filing Ref</th>
                        <th style="padding:10px; text-align:right;">Action</th>
                    </tr>
                </thead>
                <tbody>
        `;

        pscData.forEach(r => {
            const flags = getRecordRedFlags(r);
            const isPep = (r["PEP Status"] || "").toLowerCase().startsWith("yes");
            const holdingEntity = r["Intermediate Entities"] || "Direct Shareholder";
            const tierText = r["Control Tier"] ? r["Control Tier"].split(":")[0] : "Tier 2";

            html += `
                <tr class="psc-table-row" data-psc-index="${allPscRecords.indexOf(r)}" tabindex="0" role="button">
                    <td style="padding:12px 10px;">
                        <div style="font-weight:700; color:#38bdf8; font-size:13.5px;">${esc(r["Person Name"] || "N/A")}</div>
                        <div style="font-size:11px; color:var(--text-muted); display:flex; align-items:center; gap:4px; margin-top:2px;">
                            ${isPep ? '<span style="color:#ef4444; font-weight:700;">• PEP Flagged</span>' : ''}
                            <span>${esc(r["Board Role"] || "Significant Shareholder")}</span>
                        </div>
                    </td>
                    <td style="padding:12px 10px;">
                        <div style="font-weight:600; color:#a78bfa;">${esc(r["Company"] || "N/A")}</div>
                        <div style="font-size:11px; color:#9ca3af; margin-top:2px;">
                            ${holdingEntity !== "Direct Shareholder" && holdingEntity !== "Direct Holding" ? `<i data-lucide="corner-down-right" style="width:10px; height:10px; display:inline;"></i> ${esc(holdingEntity)}` : '<span style="color:#6b7280;">Direct Shareholder</span>'}
                        </div>
                    </td>
                    <td style="padding:12px 10px; max-width:180px;">
                        <span style="font-size:10px; background:rgba(56,189,248,0.15); color:#38bdf8; padding:2px 6px; border-radius:3px; font-weight:700; display:inline-block; margin-bottom:3px;">${esc(tierText)}</span>
                        <div style="font-size:11.5px; color:#d1d5db; line-height:1.3;">${esc(r["Nature of Control"] || "N/A")}</div>
                    </td>
                    <td style="padding:12px 10px;">
                        <div style="font-weight:700; color:#f472b6; font-size:14px;">${esc(r["Percentage"] || "N/A")}</div>
                        <div style="font-size:10px; color:var(--text-muted);">
                            ${r["Direct %"] ? `Dir: ${esc(r["Direct %"])}` : ''} ${r["Indirect %"] ? `| Ind: ${esc(r["Indirect %"])}` : ''}
                        </div>
                    </td>
                    <td style="padding:12px 10px;">
                        ${flags.length > 0 ? flags.map(f => `<span class="badge" style="background:rgba(239,68,68,0.18); color:#ef4444; border:1px solid rgba(239,68,68,0.3); font-size:10px; padding:2px 6px; margin:2px 2px 2px 0; display:inline-block;">🚩 ${esc(f)}</span>`).join('') : '<span style="color:#10b981; font-size:11px;">✓ Clean Disclosure</span>'}
                    </td>
                    <td style="padding:12px 10px;">
                        <code style="font-size:11px; background:rgba(0,0,0,0.3); padding:2px 6px; border-radius:3px; color:#38bdf8;">${r["Regulatory Filing Ref"] ? esc(r["Regulatory Filing Ref"]) : "<span style=\"color:var(--text-muted);\">Not disclosed</span>"}</code>
                    </td>
                    <td style="padding:12px 10px; text-align:right;">
                        <button class="btn btn-secondary psc-dossier-btn" data-psc-index="${allPscRecords.indexOf(r)}" style="padding:4px 10px; font-size:11px; display:inline-flex; align-items:center; gap:4px;">
                            <i data-lucide="eye" style="width:12px; height:12px;"></i> Dossier
                        </button>
                    </td>
                </tr>
            `;
        });
        html += `</tbody></table>`;
        pscTableContainer.innerHTML = html;

        // Bound via listeners, not inline onclick: inline handlers are blocked
        // by the CSP, and a name interpolated into an onclick string lets an
        // apostrophe break out of the JS literal. Rows are keyed by index so
        // that a person who is a PSC of two companies opens the right record.
        pscTableContainer.querySelectorAll("[data-psc-index]").forEach(el => {
            const open = (e) => {
                e.stopPropagation();
                window.openPSCDossier(parseInt(el.getAttribute("data-psc-index"), 10));
            };
            el.addEventListener("click", open);
            if (el.tagName === "TR") {
                el.addEventListener("keydown", (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        open(e);
                    }
                });
            }
        });

        if (window.lucide) window.lucide.createIcons();
    }

    // Render SVG Interactive UBO Network Map
    function renderPSCNetworkGraph() {
        if (!pscNetworkGraphContainer) return;
        const pscData = getFilteredPSCData();

        if (!pscData || pscData.length === 0) {
            pscNetworkGraphContainer.innerHTML = `<p style="padding:30px; text-align:center; color:var(--text-muted);">No Beneficial Ownership nodes match current map filters.</p>`;
            return;
        }

        let svgHtml = `
            <svg width="100%" height="100%" viewBox="0 0 1000 460" xmlns="http://www.w3.org/2000/svg" style="background:transparent;">
                <defs>
                    <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                        <polygon points="0 0, 8 3, 0 6" fill="#38bdf8" />
                    </marker>
                    <marker id="arrowhead-red" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                        <polygon points="0 0, 8 3, 0 6" fill="#ef4444" />
                    </marker>
                </defs>
        `;

        const personsMap = new Map();
        const holdingsMap = new Map();
        const companiesMap = new Map();

        pscData.forEach(r => {
            const pName = r["Person Name"] || "Unknown";
            const cName = r["Company"] || "Unknown Company";
            const hName = (r["Intermediate Entities"] && r["Intermediate Entities"] !== "Direct Shareholder" && r["Intermediate Entities"] !== "Direct Holding") ? r["Intermediate Entities"] : "Direct";

            if (!personsMap.has(pName)) personsMap.set(pName, { name: pName, records: [] });
            personsMap.get(pName).records.push(r);

            if (hName !== "Direct" && !holdingsMap.has(hName)) holdingsMap.set(hName, { name: hName });
            if (!companiesMap.has(cName)) companiesMap.set(cName, { name: cName });
        });

        const pArray = Array.from(personsMap.values());
        const hArray = Array.from(holdingsMap.values());
        const cArray = Array.from(companiesMap.values());

        const xP = 140;
        const xH = 500;
        const xC = 850;

        pscData.forEach(r => {
            const pIndex = pArray.findIndex(p => p.name === r["Person Name"]);
            const hName = (r["Intermediate Entities"] && r["Intermediate Entities"] !== "Direct Shareholder" && r["Intermediate Entities"] !== "Direct Holding") ? r["Intermediate Entities"] : "Direct";
            const hIndex = hArray.findIndex(h => h.name === hName);
            const cIndex = cArray.findIndex(c => c.name === r["Company"]);

            const yP = 60 + pIndex * (380 / Math.max(1, pArray.length - 1));
            const flags = getRecordRedFlags(r);
            const isRed = flags.length > 0;

            if (hIndex >= 0) {
                const yH = 70 + hIndex * (360 / Math.max(1, hArray.length - 1));
                const yC = 60 + cIndex * (380 / Math.max(1, cArray.length - 1));

                svgHtml += `<line x1="${xP+40}" y1="${yP}" x2="${xH-60}" y2="${yH}" stroke="${isRed ? '#ef4444' : '#38bdf8'}" stroke-width="1.8" stroke-dasharray="${isRed ? '4,4' : 'none'}" marker-end="${isRed ? 'url(#arrowhead-red)' : 'url(#arrowhead)'}" opacity="0.8"/>`;
                svgHtml += `<text x="${(xP+xH)/2}" y="${(yP+yH)/2 - 5}" font-size="10" fill="#9ca3af" text-anchor="middle">${esc(r["Percentage"] || "")}</text>`;

                svgHtml += `<line x1="${xH+60}" y1="${yH}" x2="${xC-60}" y2="${yC}" stroke="#a78bfa" stroke-width="1.8" marker-end="url(#arrowhead)" opacity="0.8"/>`;
            } else {
                const yC = 60 + cIndex * (380 / Math.max(1, cArray.length - 1));
                svgHtml += `<line x1="${xP+40}" y1="${yP}" x2="${xC-60}" y2="${yC}" stroke="${isRed ? '#ef4444' : '#38bdf8'}" stroke-width="1.8" marker-end="${isRed ? 'url(#arrowhead-red)' : 'url(#arrowhead)'}" opacity="0.8"/>`;
                svgHtml += `<text x="${(xP+xC)/2}" y="${(yP+yC)/2 - 5}" font-size="10" fill="#9ca3af" text-anchor="middle">Direct ${esc(r["Percentage"] || "")}</text>`;
            }
        });

        pArray.forEach((p, idx) => {
            const y = 60 + idx * (380 / Math.max(1, pArray.length - 1));
            const record = p.records[0];
            const flags = getRecordRedFlags(record);
            const isRed = flags.length > 0;

            svgHtml += `
                <g style="cursor:pointer;" data-psc-name="${esc(p.name)}">
                    <circle cx="${xP}" cy="${y}" r="22" fill="${isRed ? 'rgba(239,68,68,0.25)' : 'rgba(56,189,248,0.25)'}" stroke="${isRed ? '#ef4444' : '#38bdf8'}" stroke-width="2"/>
                    <text x="${xP}" y="${y+4}" font-size="12" fill="#fff" font-weight="bold" text-anchor="middle">${esc(p.name.charAt(0))}</text>
                    <text x="${xP}" y="${y+36}" font-size="11" fill="#38bdf8" font-weight="600" text-anchor="middle">${esc(p.name)}</text>
                </g>
            `;
        });

        hArray.forEach((h, idx) => {
            const y = 70 + idx * (360 / Math.max(1, hArray.length - 1));
            svgHtml += `
                <g>
                    <rect x="${xH-60}" y="${y-16}" width="120" height="32" rx="6" fill="rgba(167,139,250,0.2)" stroke="#a78bfa" stroke-width="1.5"/>
                    <text x="${xH}" y="${y+4}" font-size="10.5" fill="#e0e7ff" font-weight="600" text-anchor="middle">${esc(h.name.length > 18 ? h.name.slice(0, 16) + '...' : h.name)}</text>
                </g>
            `;
        });

        cArray.forEach((c, idx) => {
            const y = 60 + idx * (380 / Math.max(1, cArray.length - 1));
            svgHtml += `
                <g>
                    <rect x="${xC-65}" y="${y-18}" width="130" height="36" rx="8" fill="rgba(244,114,182,0.2)" stroke="#f472b6" stroke-width="1.5"/>
                    <text x="${xC}" y="${y+4}" font-size="11" fill="#fbcfe8" font-weight="bold" text-anchor="middle">${esc(c.name.length > 18 ? c.name.slice(0, 16) + '...' : c.name)}</text>
                </g>
            `;
        });

        svgHtml += `</svg>`;
        pscNetworkGraphContainer.innerHTML = svgHtml;

        pscNetworkGraphContainer.querySelectorAll("[data-psc-name]").forEach(el => {
            el.addEventListener("click", () => window.openPSCDossier(el.getAttribute("data-psc-name")));
        });
    }

    // Interactive PSC Beneficial Ownership Dossier Drawer with Timeline & Portfolio Links
    // Accepts either a record index (from the table, exact — a person can be a
    // PSC of several companies) or a person name (from the network map, which
    // aggregates by person).
    window.openPSCDossier = function(ref) {
        if (!pscDossierModal || !pscDossierBody) return;

        let record = null;
        let records = [];
        if (typeof ref === "number" && !isNaN(ref)) {
            record = allPscRecords[ref] || null;
            const name = record ? (record["Person Name"] || "") : "";
            records = allPscRecords.filter(r => (r["Person Name"] || "").toLowerCase() === name.toLowerCase());
        } else {
            records = allPscRecords.filter(r => (r["Person Name"] || "").toLowerCase() === String(ref || "").toLowerCase());
            record = records[0] || null;
        }
        if (!record) return;

        const flags = getRecordRedFlags(record);
        const isPep = (record["PEP Status"] || "").toLowerCase().startsWith("yes");
        const holdingEntity = record["Intermediate Entities"] || "Direct Shareholder";

        document.getElementById("dossier-title").innerText = `Beneficial Ownership Dossier: ${record["Person Name"]}`;

        let html = `
            <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:18px; margin-bottom:18px;">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:15px;">
                    <div>
                        <span style="font-size:10.5px; text-transform:uppercase; letter-spacing:0.8px; color:var(--primary); font-weight:700;">Ultimate Beneficial Owner (UBO) Profile</span>
                        <h2 style="margin:4px 0 0 0; font-size:20px; font-weight:700; color:#f9fafb;">${esc(record["Person Name"])}</h2>
                        <div style="font-size:13px; color:#a78bfa; margin-top:3px; font-weight:600;">${esc(record["Board Role"] || "Significant Shareholder")} — ${esc(record["Company"])}</div>
                    </div>
                    <div style="text-align:right;">
                        <span class="badge" style="background:${isPep ? 'rgba(239,68,68,0.25); color:#ef4444;' : 'rgba(16,185,129,0.2); color:#10b981;'} padding:4px 10px; font-size:11px; font-weight:700;">
                            ${isPep ? 'PEP Flagged (Enhanced Oversight)' : 'CAM 2020 Statutory Disclosure'}
                        </span>
                        <div style="font-size:11px; color:var(--text-muted); margin-top:4px;">Risk Level: <strong style="color:#f59e0b;">${esc(record["Risk Level"] || "Elevated")}</strong></div>
                    </div>
                </div>
            </div>
        `;

        if (flags.length > 0) {
            html += `
                <div style="background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.3); border-radius:8px; padding:12px 16px; margin-bottom:18px;">
                    <div style="font-weight:700; color:#ef4444; font-size:12px; margin-bottom:4px; display:flex; align-items:center; gap:6px;">
                        <span>🚩 Active Compliance Anomalies & Red Flags Detected (${flags.length})</span>
                    </div>
                    <div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:6px;">
                        ${flags.map(f => `<span style="font-size:11px; background:rgba(239,68,68,0.2); color:#fca5a5; padding:3px 8px; border-radius:4px; font-weight:600;">• ${esc(f)}</span>`).join('')}
                    </div>
                </div>
            `;
        }

        if (records.length > 1) {
            html += `
                <div style="background:rgba(56,189,248,0.08); border:1px solid rgba(56,189,248,0.2); border-radius:8px; padding:14px; margin-bottom:18px;">
                    <h4 style="margin:0 0 8px 0; font-size:12px; color:#38bdf8; text-transform:uppercase; letter-spacing:0.5px;">Multi-Entity Corporate Portfolio (${records.length} Enterprises)</h4>
                    <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap:10px;">
                        ${records.map(r => `
                            <div style="background:rgba(0,0,0,0.3); padding:10px; border-radius:6px; border:1px solid rgba(255,255,255,0.08);">
                                <div style="font-weight:700; color:#f3f4f6; font-size:12px;">${esc(r["Company"])}</div>
                                <div style="font-size:11px; color:#f472b6; font-weight:700; margin-top:2px;">Controlling Stake: ${esc(r["Percentage"])}</div>
                                <div style="font-size:10px; color:#9ca3af; margin-top:2px;">Role: ${esc(r["Board Role"] || "Shareholder")}</div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
        }

        html += `
            <div style="margin-bottom:20px;">
                <h4 style="margin:0 0 8px 0; font-size:12px; text-transform:uppercase; color:var(--text-muted); letter-spacing:0.5px;">Control Lineage & Entity Chain</h4>
                <div class="lineage-flow">
                    <div class="lineage-node">
                        <div class="node-title">${esc(record["Person Name"])}</div>
                        <div class="node-sub">Natural Person / UBO</div>
                    </div>
                    <div class="lineage-arrow">
                        ➔ ${esc(record["Percentage"] || "Control")} ➔
                    </div>
                    <div class="lineage-node" style="border-color:rgba(167,139,250,0.4); background:rgba(167,139,250,0.08);">
                        <div class="node-title" style="color:#a78bfa;">${esc(holdingEntity)}</div>
                        <div class="node-sub">Intermediate Vehicle</div>
                    </div>
                    <div class="lineage-arrow">
                        ➔ Operating Equity ➔
                    </div>
                    <div class="lineage-node" style="border-color:rgba(56,189,248,0.4); background:rgba(56,189,248,0.08);">
                        <div class="node-title" style="color:#38bdf8;">${esc(record["Company"])}</div>
                        <div class="node-sub">Target Counterparty</div>
                    </div>
                </div>
            </div>

            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px; margin-bottom:20px;">
                <div style="background:rgba(0,0,0,0.2); border:1px solid rgba(255,255,255,0.06); padding:12px; border-radius:8px;">
                    <span style="font-size:11px; color:var(--text-muted); display:block; margin-bottom:4px;">Direct vs Indirect Equity Split</span>
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <span style="font-size:12.5px; color:#d1d5db;">Direct: <strong>${esc(record["Direct %"] || "N/A")}</strong></span>
                        <span style="font-size:12.5px; color:#d1d5db;">Indirect: <strong>${esc(record["Indirect %"] || "N/A")}</strong></span>
                        <span style="font-size:12.5px; color:#f472b6;">Voting: <strong>${esc(record["Voting Rights %"] || record["Percentage"])}</strong></span>
                    </div>
                </div>
                <div style="background:rgba(0,0,0,0.2); border:1px solid rgba(255,255,255,0.06); padding:12px; border-radius:8px;">
                    <span style="font-size:11px; color:var(--text-muted); display:block; margin-bottom:4px;">Regulatory Filing Reference</span>
                    <div style="font-size:13px; font-weight:700; color:#38bdf8;">${record["Regulatory Filing Ref"] ? esc(record["Regulatory Filing Ref"]) : "Not disclosed"}</div>
                    <div style="font-size:10px; color:#9ca3af;">Filing date: ${record["Date"] ? esc(record["Date"]) : "not disclosed"} | ${record["Verification Status"] ? esc(record["Verification Status"]) : "unverified"}</div>
                </div>
            </div>
        `;

        if (record["Timeline"] && record["Timeline"].length > 0) {
            html += `
                <div style="background:rgba(0,0,0,0.25); border:1px solid rgba(255,255,255,0.06); padding:14px; border-radius:8px; margin-bottom:20px;">
                    <h4 style="margin:0 0 10px 0; font-size:12px; text-transform:uppercase; color:var(--text-muted); letter-spacing:0.5px;">Chronological Ownership Evolution Timeline</h4>
                    <div style="border-left:2px solid var(--primary); padding-left:12px; margin-left:6px;">
                        ${record["Timeline"].map(t => `
                            <div style="margin-bottom:10px; position:relative;">
                                <div style="font-size:10.5px; color:#38bdf8; font-weight:700;">${esc(t.date)}</div>
                                <div style="font-size:11.5px; color:#d1d5db; margin-top:2px;">${esc(t.event)}</div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
        }

        html += `
            <div style="background:rgba(0,0,0,0.25); border:1px solid rgba(255,255,255,0.06); padding:14px; border-radius:8px; margin-bottom:20px;">
                <h4 style="margin:0 0 6px 0; font-size:12.5px; color:#f3f4f6;">Control Rights & Governance Notes</h4>
                <p style="margin:0; font-size:12px; color:#9ca3af; line-height:1.5;">
                    ${esc(record["Notes"] || record["Nature of Control"] || "Tracked beneficial owner maintaining significant control rights and voting influence over board decisions and equity structure.")}
                </p>
            </div>

            <!-- Actions -->
            <div style="display:flex; justify-content:flex-end; gap:10px;">
                <button class="btn btn-secondary" id="dossier-copy-json">
                    <i data-lucide="copy" style="width:14px; height:14px;"></i> Copy JSON
                </button>
                <button class="btn btn-primary" id="dossier-print">
                    <i data-lucide="printer" style="width:14px; height:14px;"></i> Print / Save PDF
                </button>
            </div>
        `;

        pscDossierBody.innerHTML = html;

        const copyBtn = document.getElementById("dossier-copy-json");
        if (copyBtn) {
            copyBtn.addEventListener("click", () => {
                navigator.clipboard.writeText(JSON.stringify(record, null, 2)).then(() => {
                    const original = copyBtn.innerHTML;
                    copyBtn.innerHTML = `<i data-lucide="check" style="width:14px; height:14px;"></i> Copied`;
                    if (window.lucide) window.lucide.createIcons();
                    setTimeout(() => {
                        copyBtn.innerHTML = original;
                        if (window.lucide) window.lucide.createIcons();
                    }, 2000);
                });
            });
        }
        const printBtn = document.getElementById("dossier-print");
        if (printBtn) printBtn.addEventListener("click", () => window.print());

        pscDossierModal.classList.add("active");
        if (window.lucide) window.lucide.createIcons();
    };

    // Export PSC CSV File
    //
    // Built from a Blob rather than a data: URI. encodeURI leaves "#" intact,
    // so any record containing one truncated the download at that character —
    // the main intelligence export was already fixed for this, but the PSC
    // export, which matters more, still had the bug. Fields beginning with
    // =, +, - or @ are prefixed so a spreadsheet treats them as text.
    function exportPSCCSV() {
        if (!allPscRecords || allPscRecords.length === 0) return;

        const headers = ["Person Name", "Company", "Nature of Control", "Percentage", "Share Band",
            "Direct %", "Indirect %", "Voting Rights %", "Intermediate Entities", "Board Role",
            "PEP Status", "Risk Level", "Regulatory Filing Ref", "Date", "Source"];

        const csvField = (val) => {
            let s = String(val == null ? "" : val);
            if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
            return `"${s.replace(/"/g, '""')}"`;
        };

        const rows = allPscRecords.map(r => headers.map(h => csvField(r[h])).join(","));

        // A demo export must never leave the app looking like a compliance
        // artefact, so the warning travels with the file and the filename.
        const notice = usingDemoPsc
            ? `"NOT FOR COMPLIANCE USE - contains illustrative seed records"\r\n`
            : "";
        const csvContent = "﻿" + notice + headers.map(csvField).join(",") + "\r\n" + rows.join("\r\n");

        const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${usingDemoPsc ? "DEMO_" : ""}PSC_CAMA2020_Beneficial_Ownership_${new Date().toISOString().slice(0,10)}.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    // Export PSC Compliance Report
    function exportPSCComplianceReport() {
        if (!allPscRecords || allPscRecords.length === 0) return;

        let reportMd = `# Persons with Significant Control (PSC) & CAMA 2020 UBO Audit Brief\n`;
        // A brief built from seed rows must say so on its face. Without this
        // the demo data left the app as an authoritative-looking document.
        if (usingDemoPsc) {
            reportMd += `\n> **NOT FOR COMPLIANCE USE.** This brief contains illustrative seed records, `;
            reportMd += `not intelligence extracted from reporting.\n\n`;
        }
        reportMd += `**Generated on:** ${new Date().toISOString().slice(0, 19).replace('T', ' ')} (UTC+1)\n`;
        reportMd += `**Regulatory Framework:** Companies and Allied Matters Act (CAMA 2020) & FATF Beneficial Ownership Transparency Standards\n\n`;

        reportMd += `## Executive Summary & Risk Indicators\n`;
        reportMd += `- **Total Registered Beneficial Owners:** ${allPscRecords.length}\n`;
        reportMd += `- **Average Controlling Equity:** ${document.getElementById("kpi-avg-stake")?.innerText || '56.1%'}\n`;
        reportMd += `- **Indirect Holding Entities Tracked:** ${document.getElementById("kpi-indirect-cnt")?.innerText || '7'}\n`;
        reportMd += `- **Red Flag Anomalies Detected:** ${document.getElementById("kpi-redflag-cnt")?.innerText || '4'}\n`;
        reportMd += `- **Records citing a regulatory filing reference:** ${document.getElementById("kpi-cama-status")?.innerText || "n/a"}\n\n`;

        reportMd += `---\n\n## Disclosed Beneficial Ownership Lineages & Anomaly Matrix\n\n`;

        allPscRecords.forEach((r, idx) => {
            const flags = getRecordRedFlags(r);
            reportMd += `### ${idx + 1}. ${r["Person Name"]} — ${r["Company"]}\n`;
            reportMd += `- **Control Classification:** ${r["Control Tier"] || "Tier 2"}\n`;
            reportMd += `- **Primary Role:** ${r["Board Role"] || "Significant Shareholder"}\n`;
            reportMd += `- **Total Controlling Stake:** ${r["Percentage"]} (Direct: ${r["Direct %"] || 'N/A'}, Indirect: ${r["Indirect %"] || 'N/A'})\n`;
            reportMd += `- **Intermediate Holding Entity:** ${r["Intermediate Entities"] || "Direct Ownership"}\n`;
            reportMd += `- **Nature of Control:** ${r["Nature of Control"]}\n`;
            reportMd += `- **PEP Status:** ${r["PEP Status"]}\n`;
            reportMd += `- **Risk Level:** ${r["Risk Level"]}\n`;
            reportMd += `- **Anomalies / Red Flags:** ${flags.length > 0 ? flags.join(', ') : 'Clean Disclosure'}\n`;
            reportMd += `- **CAC / SEC regulatory ref:** ${r["Regulatory Filing Ref"] ? "`" + r["Regulatory Filing Ref"] + "`" : "not disclosed"} (date: ${r["Date"] || "not disclosed"})\n`;
            reportMd += `- **Audit Notes:** ${r["Notes"] || "Verified disclosure"}\n\n`;
        });

        reportMd += `---\n*Report generated by Corporate News & Regulatory Intelligence System.*`;

        const reportMdContent = document.getElementById("report-md-content");
        const reportsModal = document.getElementById("reports-modal");
        if (reportMdContent && reportsModal) {
            reportMdContent.innerHTML = `<div class="parsed-report-md">${parseMarkdown(reportMd)}</div>`;
            pscModal.classList.remove("active");
            reportsModal.classList.add("active");
        } else {
            const blob = new Blob([reportMd], { type: "text/markdown" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `PSC_CAM2020_Compliance_Audit_${new Date().toISOString().slice(0,10)}.md`;
            a.click();
            URL.revokeObjectURL(url);
        }
    }

    // Ingest trigger
    triggerIngestBtn.addEventListener("click", async () => {
        triggerIngestBtn.disabled = true;
        const icon = triggerIngestBtn.querySelector("i");
        if (icon) icon.classList.add("spin");
        
        // Add a pulsing effect to the button itself
        triggerIngestBtn.style.animation = "activePulse 1.5s infinite";

        if (isGitHubPages) {
            // Simulated delay for loading effect
            await new Promise(r => setTimeout(r, 800));
            
            triggerIngestBtn.style.animation = "";
            triggerIngestBtn.disabled = false;
            if (icon) icon.classList.remove("spin");
            
            // Show custom informational modal for GitHub Pages
            alert("Cloud Deployment Detected!\n\nBecause this dashboard is hosted serverlessly on GitHub Pages, the intelligence scrapers run securely on a fixed cloud schedule (8 AM, 2 PM, 7 PM).\n\nTo trigger an immediate data ingestion manually, please visit your GitHub Repository -> Actions Tab -> Run Workflow.");
            window.open("https://github.com/Adejare-ml/News-Intelligence-System/actions", "_blank");
        } else {
            try {
                const res = await fetch(`${API_BASE}/news/trigger-ingest`, { method: "POST" });
                const data = await res.json();
                
                alert("Local background news collection enqueued successfully. Wait a few moments then refresh!");
                
                // Reload stats and feed after 3 seconds
                setTimeout(() => {
                    loadDashboardStats();
                    loadNewsFeed("", currentCategory);
                    loadAnalyticsAndGraph();
                    
                    triggerIngestBtn.style.animation = "";
                    triggerIngestBtn.disabled = false;
                    if (icon) icon.classList.remove("spin");
                }, 3000);
            } catch (err) {
                console.error("Failed to trigger ingestion:", err);
                alert("Failed to connect to local ingestion server.");
                triggerIngestBtn.style.animation = "";
                triggerIngestBtn.disabled = false;
                if (icon) icon.classList.remove("spin");
            }
        }
    });

    // Search Toggle
    searchTypeToggle.addEventListener("change", (e) => {
        isSemanticSearch = e.target.checked;
        if (isSemanticSearch) {
            // Called "Semantic Similarity (AI)" before. It is a weighted
            // term-overlap score with no model behind it, and claiming
            // otherwise on a transparency product is the wrong trade.
            searchLabel.innerText = "Entity trace";
            searchLabel.style.color = "var(--secondary)";
            searchInput.placeholder = "Trace an entity across articles, owners and the register…";
        } else {
            searchLabel.innerText = "Keyword match";
            searchLabel.style.color = "var(--text-muted)";
            searchInput.placeholder = "Search keyword, entity or concept…";
        }
        // Re-run the active query under the newly selected mode
        if (searchInput.value.trim()) {
            loadNewsFeed(searchInput.value.trim(), currentCategory);
        }
    });

    // ==========================================
    // DAILY PSC INTELLIGENCE REPORTS READER
    // ==========================================

    const reportsModal = document.getElementById("reports-modal");
    const viewReportsBtn = document.getElementById("view-reports-btn");
    const closeReportsModalBtn = document.getElementById("close-reports-modal");
    const reportsArchiveList = document.getElementById("reports-archive-list");
    const reportMdContent = document.getElementById("report-md-content");
    const compileReportBtn = document.getElementById("compile-report-btn");

    const copyReportBtn = document.getElementById("copy-report-btn");
    if (copyReportBtn) {
        copyReportBtn.addEventListener("click", () => {
            const contentText = reportMdContent.innerText || reportMdContent.textContent;
            if (!contentText) return;
            navigator.clipboard.writeText(contentText).then(() => {
                const orig = copyReportBtn.innerHTML;
                copyReportBtn.innerHTML = `<i data-lucide="check"></i> Copied!`;
                if (window.lucide) window.lucide.createIcons();
                setTimeout(() => {
                    copyReportBtn.innerHTML = orig;
                    if (window.lucide) window.lucide.createIcons();
                }, 2000);
            });
        });
    }

    // Report markdown rendering lives in js/report-markdown.js so it can be
    // unit-tested without booting the whole dashboard. See tests/frontend/.
    const parseMarkdown = window.AuraReportMarkdown.parseMarkdown;
    const renderInline = window.AuraReportMarkdown.renderInline;

    async function loadReportContent(filename = "latest") {
        reportMdContent.innerHTML = `
            <div class="loading-placeholder">
                <div class="spinner"></div>
                <p>Retrieving report nodes...</p>
            </div>
        `;
        try {
            if (isGitHubPages) {
                if (filename === "latest") {
                    const res = await fetch(`${API_BASE}/report_latest.md`);
                    if (!res.ok) throw new Error("Latest report file not found.");
                    const content = await res.text();
                    reportMdContent.innerHTML = parseMarkdown(content);
                } else {
                    // filename here is either the Generated timestamp ID or filename string
                    const match = allReports.find(r => r.Generated === filename || r.filename === filename || (r.Date && filename.includes((r.Date||"").replace(/-/g, ""))));
                    const reportText = match ? (match.Content || match[""] || match.content) : null;
                    
                    if (reportText && reportText.trim()) {
                        reportMdContent.innerHTML = parseMarkdown(reportText);
                    } else {
                        // Fallback 1: try fetching archived file by date formatted name
                        let fetchSuccess = false;
                        try {
                            const dateClean = (filename || "").replace(/[^0-9]/g, "");
                            if (dateClean.length >= 8) {
                                const archRes = await fetch(`${API_BASE}/archives/report_${dateClean.slice(0,8)}.md`);
                                if (archRes.ok) {
                                    const text = await archRes.text();
                                    reportMdContent.innerHTML = parseMarkdown(text);
                                    fetchSuccess = true;
                                }
                            }
                        } catch (e) {}

                        if (!fetchSuccess) {
                            // Deliberately NOT falling back to report_latest.md.
                            //
                            // 71 of the 72 archive rows carry an empty Content
                            // column, and only 15 archive files exist, so the
                            // old fallback silently rendered *today's* brief
                            // under a historical date. On an intelligence
                            // product, showing the wrong document with no
                            // indication is worse than showing none.
                            reportMdContent.innerHTML = `
                                <div class="empty-note">
                                    <p><strong>This edition is not available.</strong></p>
                                    <p>Its text was not captured when it was generated. Editions
                                    published from this point on are archived in full.</p>
                                </div>`;
                        }
                    }
                }
            } else {
                const url = filename === "latest" ? `${API_BASE}/reports/latest` : `${API_BASE}/reports/${filename}`;
                const res = await fetch(url);
                if (!res.ok) throw new Error("Could not load report content.");
                const data = await res.json();
                reportMdContent.innerHTML = parseMarkdown(data.content);
            }
        } catch (err) {
            console.error("Error loading report content:", err);
            reportMdContent.innerHTML = `<p class="error-message">Failed to load report document content.</p>`;
        }
    }

    async function loadReportsList() {
        reportsArchiveList.innerHTML = `<div class="spinner" style="margin:20px auto;"></div>`;
        try {
            let files = [];
            if (isGitHubPages) {
                if (allReports.length === 0) {
                    const res = await fetch(`${API_BASE}/reports.json`);
                    allReports = await res.json();
                }
                
                // Map the sheets daily reports rows to standard list structure
                files = allReports.map(r => {
                    const generatedStr = r.Generated || `${r.Date} 12:00`;
                    const dateFormatted = (r.Date || "").replace(/-/g, "");
                    const timeFormatted = generatedStr.split(" ")[1] ? generatedStr.split(" ")[1].replace(/:/g, "") : "120000";
                    return {
                        filename: r.Generated || `report_${dateFormatted}.md`, // Pass the exact Generated ID
                        display_name: `report_${dateFormatted}_${timeFormatted}.md`,
                        created_at: generatedStr
                    };
                });
                // Sort newest first
                files.sort((a,b) => b.created_at.localeCompare(a.created_at));
            } else {
                const res = await fetch(`${API_BASE}/reports`);
                files = await res.json();
            }
            
            reportsArchiveList.innerHTML = "";
            
            // Add a special item for the "Latest Live Report"
            const latestItem = document.createElement("div");
            latestItem.className = "report-archive-item active";
            latestItem.innerHTML = `
                <span class="date">Latest Generated</span>
                <span class="title">report_latest.md</span>
            `;
            latestItem.addEventListener("click", () => {
                document.querySelectorAll(".report-archive-item").forEach(item => item.classList.remove("active"));
                latestItem.classList.add("active");
                loadReportContent("latest");
            });
            reportsArchiveList.appendChild(latestItem);

            // Add other historic files
            files.forEach(f => {
                const item = document.createElement("div");
                item.className = "report-archive-item";
                item.innerHTML = `
                    <span class="date">${f.created_at}</span>
                    <span class="title">${f.display_name || f.filename}</span>
                `;
                item.addEventListener("click", () => {
                    document.querySelectorAll(".report-archive-item").forEach(item => item.classList.remove("active"));
                    item.classList.add("active");
                    loadReportContent(f.filename);
                });
                reportsArchiveList.appendChild(item);
            });
        } catch (err) {
            console.error("Error loading reports list:", err);
            reportsArchiveList.innerHTML = `<p style="font-size:12px; color:var(--text-muted); padding:10px;">Archive loading failed.</p>`;
        }
    }

    function openReportsModal() {
        reportsModal.classList.add("active");
        loadReportsList();
        loadReportContent("latest");
        if (window.lucide) {
            window.lucide.createIcons();
        }
    }

    function closeReportsModal() {
        reportsModal.classList.remove("active");
    }

    // Event Bindings
    viewReportsBtn.addEventListener("click", openReportsModal);
    closeReportsModalBtn.addEventListener("click", closeReportsModal);
    reportsModal.addEventListener("click", (e) => {
        if (e.target === reportsModal) closeReportsModal();
    });

    compileReportBtn.addEventListener("click", async () => {
        if (isGitHubPages) {
            alert("Report compilation in production runs automatically 3x daily via GitHub Actions. If you need manual compilation, run the pipeline command locally or trigger it from your GitHub Repository Actions tab.");
            return;
        }
        
        compileReportBtn.disabled = true;
        const icon = compileReportBtn.querySelector("i");
        if (icon) icon.classList.add("spin");
        
        try {
            const res = await fetch(`${API_BASE}/reports/trigger`, { method: "POST" });
            const data = await res.json();
            alert(`Report compilation success: report_latest.md has been regenerated!`);
            loadReportsList();
            loadReportContent("latest");
        } catch (err) {
            console.error("Failed to compile report:", err);
            alert("Report compile failed.");
        } finally {
            compileReportBtn.disabled = false;
            if (icon) icon.classList.remove("spin");
        }
    });

    // ==========================================
    // TEST SURFACE
    // ==========================================

    // Everything above lives inside a DOMContentLoaded closure, so none of it
    // is reachable from a test page. These are pure functions with no secrets
    // attached; exposing them is what lets tests/frontend/ assert on the
    // report parser directly instead of scraping rendered HTML.
    window.__auraInternals = {
        parseMarkdown: parseMarkdown,
        renderInline: renderInline,
        normalizeArticle: normalizeArticle,
        conceptScore: conceptScore,
        safeUrl: safeUrl,
        esc: esc
    };

    // ==========================================
    // INITIALIZATION
    // ==========================================

    // Initial Load
    loadDashboardStats();
    loadNewsFeed();
    loadAnalyticsAndGraph();
});
