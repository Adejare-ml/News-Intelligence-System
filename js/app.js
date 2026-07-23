document.addEventListener("DOMContentLoaded", () => {
    // Determine dynamic serverless database configuration
    const isGitHubPages = window.location.hostname.includes("github.io") || window.location.protocol === "file:";
    const API_BASE = isGitHubPages ? "data" : "/api/v1";

    // State Variables
    let currentCategory = "";
    let currentRisk = "";
    let isSemanticSearch = false;
    let mixChart = null;
    let network = null;
    let allArticles = [];
    let allReports = [];

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
    const tabDetailed = document.getElementById("modal-summary-detailed");
    const tabTimeline = document.getElementById("modal-summary-timeline");

    const tabExecWrapper = document.getElementById("tab-executive");
    const tabDetailedWrapper = document.getElementById("tab-detailed");
    const tabTimelineWrapper = document.getElementById("tab-timeline");
    let currentArticleData = null;

    // Initialize Lucide Icons
    if (window.lucide) {
        window.lucide.createIcons();
    }

    // ==========================================
    // NORMALIZATION UTILITY
    // ==========================================

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
            summary_executive: art.Summary || art.summary_executive || art.summary || art.Title || art.title || "No summary available.",
            summary_detailed: art.summary_detailed || art.Summary || art.summary_executive || art.Title || art.title || "No detailed summary available.",
            summary_timeline: art.summary_timeline || art.Summary || art.summary_executive || "No timeline summary available.",
            published_at: art.Time || art.published_at || new Date().toISOString()
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
                const total_events = allArticles.filter(a => a.category === "Government").length;
                
                const latest_alerts = allArticles.filter(a => ["High", "Critical"].includes(a.risk_level)).slice(0, 10);
                const total_alerts = allArticles.filter(a => ["High", "Critical"].includes(a.risk_level)).length;
                
                // Group by Category
                const category_counts = {};
                allArticles.forEach(a => {
                    category_counts[a.category] = (category_counts[a.category] || 0) + 1;
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
                
                // Convert to matches format for alerts list
                const formattedAlerts = latest_alerts.map(a => ({
                    title: `Risk Alert: ${a.title}`,
                    severity: a.risk_level === "Critical" ? "Critical" : "Warning",
                    message: a.summary_executive,
                    created_at: a.published_at
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
                    const q = query.toLowerCase();
                    articles = articles.filter(a => a.title.toLowerCase().includes(q) || a.summary_executive.toLowerCase().includes(q));
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
            renderNewsFeed(articles);
        } catch (err) {
            console.error("Error loading news feed:", err);
            articlesList.innerHTML = `<p class="error-message">Failed to load news streams.</p>`;
        }
    }

    async function loadAnalyticsAndGraph() {
        try {
            const url = isGitHubPages ? `${API_BASE}/graph.json` : `${API_BASE}/analytics`;
            const res = await fetch(url);
            const data = await res.json();
            buildKnowledgeGraph(data.graph || data);
        } catch (err) {
            console.error("Error loading graph analytics:", err);
        }
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

    function renderNewsFeed(articles) {
        if (!articles || articles.length === 0) {
            articlesList.innerHTML = `<div class="loading-placeholder"><p>No intelligence records found.</p></div>`;
            return;
        }

        articlesList.innerHTML = "";
        articles.forEach(art => {
            const card = document.createElement("div");
            card.className = "article-card";
            
            const pubDate = art.published_at ? new Date(art.published_at).toLocaleDateString() : "Recent";
            const catClass = art.category ? art.category.toLowerCase() : "general";
            const riskClass = art.risk_level ? art.risk_level.toLowerCase() : "low";

            card.innerHTML = `
                <div class="article-card-header">
                    <span class="badge ${catClass}">${art.category || "General"}</span>
                    <span>${pubDate}</span>
                </div>
                <h4>${art.title}</h4>
                <div class="article-card-footer">
                    <span>${art.source}</span>
                    <span>
                        <span class="risk-dot ${riskClass}"></span>
                        Risk: ${art.risk_level || "Low"}
                    </span>
                </div>
            `;

            card.addEventListener("click", () => openArticleModal(art));
            articlesList.appendChild(card);
        });
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

            item.innerHTML = `
                <div class="alert-item-header">
                    <span>${alert.title}</span>
                    <span style="font-size:10px; color:var(--text-muted);">${dateStr}</span>
                </div>
                <p style="margin-top:2px;">${alert.message}</p>
            `;
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

        const labels = Object.keys(categories);
        const values = Object.values(categories);

        mixChart = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: labels,
                datasets: [{
                    data: values,
                    backgroundColor: [
                        'rgba(139, 92, 246, 0.65)',
                        'rgba(6, 182, 212, 0.65)',
                        'rgba(244, 63, 94, 0.65)',
                        'rgba(16, 185, 129, 0.65)'
                    ],
                    borderColor: 'rgba(255, 255, 255, 0.08)',
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'right',
                        labels: {
                            color: '#9ca3af',
                            font: { family: 'Outfit', size: 10 }
                        }
                    }
                },
                cutout: '60%'
            }
        });
    }

    // ==========================================
    // VIS.JS KNOWLEDGE GRAPH BUILDER
    // ==========================================

    function buildKnowledgeGraph(graphData) {
        const container = document.getElementById("network-container");
        if (!container || !graphData) return;

        const nodes = [];
        const edges = [];
        
        // Setup Nodes
        graphData.nodes.forEach(node => {
            let color = "#8b5cf6"; // Default primary
            let shape = "dot";
            
            if (node.type === "person") {
                color = "#38bdf8"; // Light Blue
                shape = "dot";
            } else if (node.type === "company") {
                color = "#a78bfa"; // Violet
                shape = "square";
            } else if (node.type === "agency") {
                color = "#f472b6"; // Pink
                shape = "triangle";
            } else if (node.type === "psc") {
                color = "#ef4444"; // Red for PSC / Beneficial Owner
                shape = "diamond";
            }

            nodes.push({
                id: node.id,
                label: node.label,
                color: {
                    background: color,
                    border: 'rgba(255,255,255,0.15)',
                    highlight: {
                        background: '#06b6d4',
                        border: '#fff'
                    }
                },
                shape: shape,
                size: 16,
                font: {
                    color: '#e5e7eb',
                    size: 11,
                    face: 'Outfit'
                }
            });
        });

        // Setup Edges
        graphData.edges.forEach(edge => {
            edges.push({
                id: edge.id,
                from: edge.from,
                to: edge.to,
                label: edge.label,
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

        const data = {
            nodes: new vis.DataSet(nodes),
            edges: new vis.DataSet(edges)
        };

        const options = {
            physics: {
                stabilization: false,
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

        network = new vis.Network(container, data, options);
        
        // Add a gentle orbiting camera effect
        let angle = 0;
        setInterval(() => {
            if (network) {
                angle += 0.002;
                network.moveTo({
                    position: { x: Math.cos(angle) * 30, y: Math.sin(angle) * 30 },
                    scale: network.getScale(), // Keep user's zoom level
                    animation: { duration: 50, easingFunction: "linear" }
                });
            }
        }, 50);

        // Click interaction: filter feed by clicked entity!
        network.on("click", (params) => {
            if (params.nodes.length > 0) {
                const nodeId = params.nodes[0];
                const clickedNode = data.nodes.get(nodeId);
                if (clickedNode) {
                    searchInput.value = clickedNode.label;
                    loadNewsFeed(clickedNode.label);
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

        modalSourceLink.href = art.url;

        // Render Tabs
        tabExec.innerText = art.summary_executive || "No summary available.";
        tabDetailed.innerText = art.summary_detailed || "No detailed summary available.";
        tabTimeline.innerText = art.summary_timeline || "No timeline summary available.";

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

    function renderModalEntities(art) {
        modalEntities.innerHTML = "";
        
        // Standard entity extraction representation in UI
        const categories = ["person", "company", "agency"];
        const samples = {
            "person": ["Jane Doe", "Sarah Jenkins", "Robert Chen", "Alice Vance", "Michael Nduka"],
            "company": ["Apex Technology Group", "Vertex Financials", "Nova Energy Corp", "BioSphere Healthcare", "Summit Holdings"],
            "agency": ["Public Service Commission", "Federal Trade Commission", "Department of Justice", "Securities and Exchange Commission"]
        };

        // Populate matches in text
        let found = false;
        categories.forEach(type => {
            samples[type].forEach(name => {
                if (art.cleaned_text && art.cleaned_text.includes(name)) {
                    found = true;
                    const tag = document.createElement("div");
                    tag.className = `entity-tag ${type}`;
                    
                    let icon = "user";
                    if (type === "company") icon = "briefcase";
                    else if (type === "agency") icon = "landmark";
                    
                    tag.innerHTML = `<i data-lucide="${icon}"></i> ${name}`;
                    modalEntities.appendChild(tag);
                }
            });
        });

        if (!found) {
            modalEntities.innerHTML = `<span style="font-size:12px; color:var(--text-muted);">No key entities resolved in text.</span>`;
        }
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
            if (!res.ok) throw new Error("PSC data file not found.");
            const pscData = await res.json();
            
            if (!pscData || pscData.length === 0) {
                pscTableContainer.innerHTML = `<p style="padding:15px; color:var(--text-muted);">No Persons with Significant Control (PSC) entries recorded yet.</p>`;
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
                    <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
                        <td style="padding:10px; font-weight:600; color:#38bdf8;">${r["Person Name"] || "N/A"}</td>
                        <td style="padding:10px; color:#a78bfa;">${r["Company"] || "N/A"}</td>
                        <td style="padding:10px;">${r["Nature of Control"] || "N/A"}</td>
                        <td style="padding:10px; color:#f472b6;">${r["Percentage"] || "N/A"}</td>
                        <td style="padding:10px;"><span class="badge" style="background:rgba(239,68,68,0.2); color:#ef4444;">${r["Change Type"] || "Disclosed"}</span></td>
                        <td style="padding:10px; color:var(--text-muted);">${r["Date"] || ""}</td>
                    </tr>
                `;
            });
            html += `</tbody></table>`;
            pscTableContainer.innerHTML = html;
        } catch (err) {
            console.error("Error loading PSC records:", err);
            pscTableContainer.innerHTML = `<p style="padding:15px; color:var(--text-muted);">Failed to load PSC records.</p>`;
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
            searchLabel.innerText = "Semantic Similarity (AI)";
            searchLabel.style.color = "var(--primary)";
            searchInput.placeholder = "Enter concept (e.g. 'high risk mergers')...";
        } else {
            searchLabel.innerText = "Standard Keyword";
            searchLabel.style.color = "var(--text-muted)";
            searchInput.placeholder = "Search keyword or semantic query...";
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

    function parseMarkdown(md) {
        if (!md) return "";
        let html = md;
        
        // Escape HTML
        html = html.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        
        // Headers
        html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');
        html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
        html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
        
        // Dividers
        html = html.replace(/^---$/gim, '<hr class="report-divider">');
        
        // Bold & Italics
        html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
        
        // Bullet list items (matches "- Item")
        html = html.replace(/^\- (.*$)/gim, '<li>$1</li>');
        
        // Wrap adjacent list items in a ul (basic heuristic)
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
                    // filename here is actually the Generated timestamp ID
                    const match = allReports.find(r => r.Generated === filename);
                    if (match && match.Content) {
                        reportMdContent.innerHTML = parseMarkdown(match.Content);
                    } else {
                        // Fallback: try fetching file directly
                        const res = await fetch(`${API_BASE}/${filename}`);
                        if (!res.ok) throw new Error("Report not logged in archives.");
                        const content = await res.text();
                        reportMdContent.innerHTML = parseMarkdown(content);
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
