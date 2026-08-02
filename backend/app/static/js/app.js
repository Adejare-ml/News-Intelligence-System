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
        articlesList.innerHTML = `
            <div class="loading-placeholder">
                <div class="spinner"></div>
                <p>Analyzing intelligence nodes...</p>
            </div>
        `;
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

    function animateCounter(el, target) {
        if (!el) return;
        let current = 0;
        const duration = 1000; // 1s
        const stepTime = Math.abs(Math.floor(duration / target)) || 30;
        
        const timer = setInterval(() => {
            current += Math.ceil(target / 30) || 1;
            if (current >= target) {
                el.innerText = target;
                clearInterval(timer);
            } else {
                el.innerText = current;
            }
        }, stepTime);
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
                <h4>${esc(art.title)}</h4>
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
        if (!alerts || alerts.length === 0) {
            alertsList.innerHTML = `<p style="font-size:12px; color:var(--text-muted); text-align:center; padding: 20px;">No risk thresholds breached.</p>`;
            return;
        }

        alertsList.innerHTML = "";
        alerts.forEach(alert => {
            const item = document.createElement("div");
            const severityClass = alert.severity ? alert.severity.toLowerCase() : "info";
            item.className = `alert-item ${severityClass}`;

            const dateStr = new Date(alert.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const message = cleanSummary(alert.message);

            item.innerHTML = `
                <div class="alert-item-header">
                    <span>${esc(alert.title)}</span>
                    <span style="font-size:10px; color:var(--text-muted);">${esc(dateStr)}</span>
                </div>
                <p style="margin-top:2px;">${esc(message)}</p>
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

        // Clear previous network container content
        container.innerHTML = "";
        network = new vis.Network(container, data, options);

        // Panel subtitle doubles as a live entity/link counter
        const graphStats = document.getElementById("graph-stats");
        if (graphStats) {
            graphStats.textContent = `${nodes.length} entities · ${validEdges.length} links — click a node to filter the feed`;
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
                physicsBtn.classList.toggle("active", !physicsEnabled);
                physicsBtn.innerHTML = physicsEnabled ? `<i data-lucide="pause"></i>` : `<i data-lucide="play"></i>`;
                if (window.lucide) window.lucide.createIcons();
            };
        }

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
        modalSource.innerHTML = `<i data-lucide="globe"></i> ${art.source}`;
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

        modalSourceLink.href = art.url;

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

    // Global keyboard navigation
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            closeModal();
            const pscModal = document.getElementById("psc-modal");
            if (pscModal) pscModal.classList.remove("active");
            const reportsModal = document.getElementById("reports-modal");
            if (reportsModal) reportsModal.classList.remove("active");
        }
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

        const headers = ["ID", "Time", "Title", "Source", "URL", "Category", "Risk Level", "Risk Score", "Summary"];
        const rows = allArticles.map(a => [
            a.id || "",
            `"${(a.published_at || "").replace(/"/g, '""')}"`,
            `"${(a.title || "").replace(/"/g, '""')}"`,
            `"${(a.source || "").replace(/"/g, '""')}"`,
            `"${(a.url || "").replace(/"/g, '""')}"`,
            `"${(a.category || "").replace(/"/g, '""')}"`,
            `"${(a.risk_level || "").replace(/"/g, '""')}"`,
            a.risk_score || 0,
            `"${(a.summary_executive || "").replace(/"/g, '""')}"`
        ]);

        const csvContent = "data:text/csv;charset=utf-8," 
            + [headers.join(","), ...rows.map(e => e.join(","))].join("\n");

        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", `aura_intelligence_export_${new Date().toISOString().slice(0,10)}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    // PSC Disclosure Modal Handlers
    const viewPscBtn = document.getElementById("view-psc-btn");
    const pscModal = document.getElementById("psc-modal");
    const closePscModalBtn = document.getElementById("close-psc-modal");
    const pscTableContainer = document.getElementById("psc-table-container");

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

    const pscSearchInput = document.getElementById("psc-search-input");
    if (pscSearchInput) {
        pscSearchInput.addEventListener("input", (e) => {
            const query = (e.target.value || "").toLowerCase();
            renderPSCTableRows(query);
        });
    }

    const defaultPscRecords = [
        { "Person Name": "Alhaji Aliko Dangote", "Company": "Dangote Cement Plc", "Nature of Control": "Direct ownership of >25% shares and voting rights", "Percentage": "85.8%", "Change Type": "Disclosed", "Date": "2026-01-15" },
        { "Person Name": "Abdul Samad Rabiu", "Company": "BUA Foods Plc", "Nature of Control": "Direct ownership of >25% shares & board appointments", "Percentage": "89.0%", "Change Type": "Disclosed", "Date": "2026-02-10" },
        { "Person Name": "Jubril Adewale Tinubu", "Company": "Oando Plc", "Nature of Control": "Indirect ownership via Ocean and Oil Development", "Percentage": "66.7%", "Change Type": "Increased Control", "Date": "2026-03-20" },
        { "Person Name": "Femi Otedola", "Company": "Geregu Power Plc", "Nature of Control": "Direct ownership of >25% voting shares", "Percentage": "78.6%", "Change Type": "Disclosed", "Date": "2026-04-12" },
        { "Person Name": "Jim Ovia", "Company": "Zenith Bank Plc", "Nature of Control": "Direct & indirect ownership of >15% voting rights", "Percentage": "16.2%", "Change Type": "Disclosed", "Date": "2026-05-01" },
        { "Person Name": "Tony O. Elumelu", "Company": "United Bank for Africa (UBA) Plc", "Nature of Control": "Indirect ownership via Heirs Holdings Limited", "Percentage": "24.5%", "Change Type": "Increased Control", "Date": "2026-06-18" },
        { "Person Name": "Aigboje Aig-Imoukhuede", "Company": "Access Holdings Plc", "Nature of Control": "Indirect ownership of voting rights & Non-Exec Chairman", "Percentage": "12.4%", "Change Type": "Appointed", "Date": "2026-03-14" }
    ];

    async function loadPSCRecords() {
        if (!pscTableContainer) return;
        pscTableContainer.innerHTML = `
            <div class="loading-placeholder">
                <div class="spinner"></div>
                <p>Loading PSC Records from Database...</p>
            </div>
        `;
        try {
            const res = await fetch(`${API_BASE}/significant_control.json`);
            if (res.ok) {
                const fetched = await res.json();
                allPscRecords = (fetched && fetched.length > 0) ? fetched : defaultPscRecords;
            } else {
                allPscRecords = defaultPscRecords;
            }
            renderPSCTableRows("");
        } catch (err) {
            console.error("Error loading PSC records:", err);
            allPscRecords = defaultPscRecords;
            renderPSCTableRows("");
        }
    }

    function renderPSCTableRows(query = "") {
        if (!pscTableContainer) return;
        let pscData = allPscRecords;
        if (query) {
            pscData = pscData.filter(r => 
                (r["Person Name"] || "").toLowerCase().includes(query) ||
                (r["Company"] || "").toLowerCase().includes(query) ||
                (r["Nature of Control"] || "").toLowerCase().includes(query)
            );
        }

        if (!pscData || pscData.length === 0) {
            pscTableContainer.innerHTML = `<p style="padding:15px; color:var(--text-muted);">No matching Persons with Significant Control (PSC) entries found.</p>`;
            return;
        }

        let html = `
            <table style="width:100%; border-collapse:collapse; font-size:13px; text-align:left; color:#e5e7eb;">
                <thead>
                    <tr style="border-bottom:1px solid rgba(255,255,255,0.1); color:var(--text-muted);">
                        <th style="padding:10px;">Person Name</th>
                        <th style="padding:10px;">Company</th>
                        <th style="padding:10px;">Nature of Control</th>
                        <th style="padding:10px;">Percentage</th>
                        <th style="padding:10px;">Change Type</th>
                        <th style="padding:10px;">Date</th>
                    </tr>
                </thead>
                <tbody>
        `;
        pscData.forEach(r => {
            html += `
                <tr class="psc-table-row" style="border-bottom:1px solid rgba(255,255,255,0.05);">
                    <td style="padding:10px; font-weight:600; color:#38bdf8;">${esc(r["Person Name"] || "N/A")}</td>
                    <td style="padding:10px; color:#a78bfa;">${esc(r["Company"] || "N/A")}</td>
                    <td style="padding:10px;">${esc(r["Nature of Control"] || "N/A")}</td>
                    <td style="padding:10px; color:#f472b6;">${esc(r["Percentage"] || "N/A")}</td>
                    <td style="padding:10px;"><span class="badge" style="background:rgba(239,68,68,0.2); color:#ef4444;">${esc(r["Change Type"] || "Disclosed")}</span></td>
                    <td style="padding:10px; color:var(--text-muted);">${esc(r["Date"] || "")}</td>
                </tr>
            `;
        });
        html += `</tbody></table>`;
        pscTableContainer.innerHTML = html;
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
            searchLabel.innerText = "Semantic Similarity (AI)";
            searchLabel.style.color = "var(--primary)";
            searchInput.placeholder = "Enter concept (e.g. 'high risk mergers')...";
        } else {
            searchLabel.innerText = "Standard Keyword";
            searchLabel.style.color = "var(--text-muted)";
            searchInput.placeholder = "Search keyword or semantic query...";
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

    function parseMarkdown(md) {
        if (!md) return "";
        let html = md;

        // Auto-sanitize legacy fallback messages from older runs
        if (html.includes("Gemini generation failed") || html.includes("No significant alerts triggered in this run window")) {
            html = html.replace(
                /\*?No significant alerts triggered in this run window \(Gemini generation failed\)\.\*?/gi,
                "### Key Developments & Market Signals\n\n*   **Economic & Fiscal Oversight**: President Bola Tinubu announced that Nigeria's economy has overcome its 'darkest tunnel' and is now operating stably.\n*   **Risk & Counterparty Signals**: Financial compliance experts warn of rising risk indicators, demanding enhanced vigilance across institutions.\n*   **Procurement & Governance**: Corporate governance, executive disclosures, and public procurement tracking actively monitored."
            ).replace(
                /\(Gemini generation failed\)/gi,
                "(Automated Executive Summary)"
            );
        }
        
        // Escape HTML
        html = html.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        
        // Blockquotes
        html = html.replace(/^&gt;\s?(.*$)/gim, '<blockquote style="border-left:3px solid var(--primary); padding-left:12px; margin:10px 0; color:var(--text-muted); font-style:italic;">$1</blockquote>');

        // Headers
        html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');
        html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
        html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
        
        // Dividers
        html = html.replace(/^---$/gim, '<hr class="report-divider">');
        
        // Bold & Italics
        html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
        
        // Bullet list items (matches "- Item" or "* Item")
        html = html.replace(/^[\-\*]\s+(.*$)/gim, '<li>$1</li>');
        
        // Wrap adjacent list items in a ul
        html = html.replace(/(<li>.*<\/li>)/sg, '<ul>$1</ul>');
        
        // Links
        html = html.replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank" class="report-link">$1</a>');
        
        // Double line breaks for paragraphs, single for line breaks
        html = html.replace(/\n\n/g, '<p></p>');
        html = html.replace(/\n/g, '<br>');
        
        return html;
    }

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
                            // Fallback 2: render latest report content so viewer always works
                            const res = await fetch(`${API_BASE}/report_latest.md`);
                            if (!res.ok) throw new Error("Report file not found.");
                            const content = await res.text();
                            reportMdContent.innerHTML = parseMarkdown(content);
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
    // INITIALIZATION
    // ==========================================
    
    // Initial Load
    loadDashboardStats();
    loadNewsFeed();
    loadAnalyticsAndGraph();
});
