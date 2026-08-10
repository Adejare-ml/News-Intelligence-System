/**
 * PSC domain logic: Nigerian disclosure bands, red-flag rules and control chains.
 *
 * Pure functions over plain record objects, with no DOM access, so the rules
 * that decide whether a person is flagged can be tested directly instead of
 * being inferred from rendered HTML.
 *
 * Jurisdiction note, and the single most important thing in this file:
 * **Nigeria's PSC threshold is 5%, not 25%.** CAMA 2020 s.868, read with the
 * CAC Persons with Significant Control Regulations 2022, makes anyone holding
 * at least 5% of shares or voting rights — or with the right to appoint a
 * majority of directors, or who otherwise exercises significant influence or
 * control — a Person with Significant Control. The 25% figure used by the UK
 * PSC register and the FATF standard does not apply here. A 6% holder is a
 * statutory PSC in Lagos and invisible to a UK-calibrated tool, so the 5–25%
 * band is a first-class category rather than a rounding error.
 */
(function (global) {
    "use strict";

    var BANDS = [
        { id: "BAND_75_100", floor: 75, label: "75–100%", short: "75+", tone: "critical" },
        { id: "BAND_50_75", floor: 50, label: "50–75%", short: "50–75", tone: "high" },
        { id: "BAND_25_50", floor: 25, label: "25–50%", short: "25–50", tone: "elevated" },
        { id: "BAND_5_25", floor: 5, label: "5–25%", short: "5–25", tone: "nigeria" },
        { id: "BELOW_THRESHOLD", floor: 0, label: "Below 5%", short: "<5", tone: "muted" }
    ];

    var BAND_BY_ID = {};
    BANDS.forEach(function (b) { BAND_BY_ID[b.id] = b; });

    /** Parse "28.5%", " 28.5 ", 28.5 → 28.5. Returns null when not disclosed. */
    function toPercent(value) {
        if (value === null || value === undefined) return null;
        var text = String(value).replace("%", "").trim();
        if (!text) return null;
        var num = Number(text);
        return isFinite(num) ? num : null;
    }

    /** Map a percentage onto a CAMA band, or null when nothing was disclosed. */
    function classifyBand(value) {
        var pct = toPercent(value);
        if (pct === null) return null;
        for (var i = 0; i < BANDS.length; i++) {
            if (pct >= BANDS[i].floor) return BANDS[i];
        }
        return BAND_BY_ID.BELOW_THRESHOLD;
    }

    function bandFor(record) {
        // Trust a stored band when present, but fall back to computing it so
        // records written before the field existed still classify.
        var stored = record && record["Share Band"];
        if (stored && BAND_BY_ID[stored]) return BAND_BY_ID[stored];
        return classifyBand(record && record.Percentage);
    }

    // Jurisdictions that recur in concealment typologies. Matched as substrings
    // against the intermediate-entity text, which is how the vehicle's domicile
    // usually surfaces in reporting — e.g. "Tengen Holdings (Mauritius) Limited".
    var SECRECY_JURISDICTIONS = [
        "mauritius", "cayman", "british virgin", "bvi", "jersey", "guernsey",
        "isle of man", "panama", "seychelles", "bahamas", "bermuda", "belize",
        "liechtenstein", "gibraltar", "delaware", "luxembourg", "cyprus",
        "marshall islands", "samoa", "curacao", "offshore"
    ];

    var NOMINEE_MARKERS = ["nominee", "nominees", "trustee", "trust ", "proxy", "custodian"];

    function textOf(record, key) {
        return String((record && record[key]) || "").toLowerCase();
    }

    function personKey(record) {
        return String((record && record["Person Name"]) || "").trim().toLowerCase();
    }

    function companyKey(record) {
        return String((record && record.Company) || "").trim().toLowerCase();
    }

    function isDirectHolding(text) {
        var t = String(text || "").trim().toLowerCase();
        return !t || t === "direct holding" || t === "direct shareholder" || t === "direct" || t === "n/a";
    }

    /**
     * Red-flag rules, derived from the FATF–Egmont concealment typologies and
     * Open Ownership's published red-flag queries, restricted to what is
     * actually computable from the fields this pipeline collects.
     *
     * Each rule returns null or {id, severity, title, detail}. Severity is
     * "high" | "medium" so the UI can rank rather than dump an undifferentiated
     * pile of badges.
     */
    var RULES = [
        {
            id: "R1_SUB_THRESHOLD",
            run: function (record, ctx) {
                var pct = toPercent(record.Percentage);
                if (pct === null || pct >= 5 || pct < 3.5) return null;
                // Only meaningful when more than one holder sits just under the
                // line: a single 4.7% holding is unremarkable, several is a
                // pattern consistent with structuring around CAMA's 5%.
                var peers = ctx.byCompany[companyKey(record)] || [];
                var parked = peers.filter(function (r) {
                    var p = toPercent(r.Percentage);
                    return p !== null && p >= 3.5 && p < 5;
                });
                if (parked.length < 2) return null;
                return {
                    severity: "high",
                    title: "Sub-threshold structuring",
                    detail: parked.length + " holders in this company sit between 3.5% and 5%, just under the "
                        + "CAMA 2020 s.868 disclosure threshold."
                };
            }
        },
        {
            id: "R3_VOTING_MISMATCH",
            run: function (record) {
                var shares = toPercent(record["Direct %"]);
                var indirect = toPercent(record["Indirect %"]);
                var equity = shares === null && indirect === null
                    ? toPercent(record.Percentage)
                    : (shares || 0) + (indirect || 0);
                var voting = toPercent(record["Voting Rights %"]);
                if (equity === null || voting === null) return null;
                var gap = voting - equity;
                if (gap < 20) return null;
                return {
                    severity: "high",
                    title: "Voting rights exceed equity",
                    detail: "Voting rights of " + voting.toFixed(1) + "% against an equity interest of "
                        + equity.toFixed(1) + "% — a " + gap.toFixed(1) + " point gap, meaning control "
                        + "materially exceeds ownership."
                };
            }
        },
        {
            id: "R7_SECRECY_VEHICLE",
            run: function (record) {
                var vehicle = textOf(record, "Intermediate Entities");
                if (isDirectHolding(vehicle)) return null;
                for (var i = 0; i < SECRECY_JURISDICTIONS.length; i++) {
                    if (vehicle.indexOf(SECRECY_JURISDICTIONS[i]) !== -1) {
                        return {
                            severity: "high",
                            title: "Secrecy-jurisdiction vehicle",
                            detail: "Control is held through an entity connected to "
                                + SECRECY_JURISDICTIONS[i] + ", a jurisdiction commonly used to obscure "
                                + "beneficial ownership."
                        };
                    }
                }
                return null;
            }
        },
        {
            id: "R4_NOMINEE",
            run: function (record) {
                var haystack = textOf(record, "Intermediate Entities") + " " + textOf(record, "Previous Holder");
                for (var i = 0; i < NOMINEE_MARKERS.length; i++) {
                    if (haystack.indexOf(NOMINEE_MARKERS[i]) !== -1) {
                        return {
                            severity: "medium",
                            title: "Nominee or trust arrangement",
                            detail: "A nominee, trustee or custodian appears in the control chain, which can "
                                + "stand between the register and the real owner."
                        };
                    }
                }
                return null;
            }
        },
        {
            id: "R9_PEP",
            run: function (record) {
                if (!textOf(record, "PEP Status").indexOf) return null;
                if (textOf(record, "PEP Status").indexOf("yes") !== 0) return null;
                return {
                    severity: "high",
                    title: "Politically exposed person",
                    detail: "The holder is recorded as politically exposed, which calls for enhanced due "
                        + "diligence on the source of funds and on any related public contracts."
                };
            }
        },
        {
            id: "R8_RAPID_CHANGE",
            run: function (record) {
                var change = textOf(record, "Change Type");
                if (change.indexOf("increas") === -1 && change.indexOf("acquir") === -1) return null;
                if (!String(record["Previous Holder"] || "").trim()) return null;
                return {
                    severity: "medium",
                    title: "Recent change of control",
                    detail: "Control increased and transferred from " + record["Previous Holder"]
                        + ", so the register reflects a recent restructuring."
                };
            }
        },
        {
            id: "R12_CROSS_ENTITY",
            run: function (record, ctx) {
                var holdings = ctx.byPerson[personKey(record)] || [];
                if (holdings.length < 2) return null;
                return {
                    severity: "medium",
                    title: "Cross-entity portfolio",
                    detail: "Holds significant control in " + holdings.length + " tracked companies, so "
                        + "influence is understated by any single row."
                };
            }
        },
        {
            id: "R6_UNKNOWN_OWNER",
            run: function (record) {
                var pct = toPercent(record.Percentage);
                var nature = String(record["Nature of Control"] || "").trim();
                if (pct !== null || nature) return null;
                return {
                    severity: "medium",
                    title: "Interest not quantified",
                    detail: "Neither a percentage nor a nature of control was disclosed for this holder."
                };
            }
        }
    ];

    /** Index records once so per-record rules do not rescan the whole table. */
    function buildContext(records) {
        var byPerson = {};
        var byCompany = {};
        (records || []).forEach(function (r) {
            var p = personKey(r);
            var c = companyKey(r);
            if (p) (byPerson[p] = byPerson[p] || []).push(r);
            if (c) (byCompany[c] = byCompany[c] || []).push(r);
        });
        return { byPerson: byPerson, byCompany: byCompany };
    }

    /**
     * Evaluate every rule against one record.
     * `context` comes from buildContext(); it is built once per render rather
     * than per row, which is what made the previous implementation O(n^2).
     */
    function redFlagsFor(record, context) {
        if (!record) return [];
        var ctx = context || buildContext([record]);
        var flags = [];
        for (var i = 0; i < RULES.length; i++) {
            var hit = null;
            try {
                hit = RULES[i].run(record, ctx);
            } catch (err) {
                hit = null;
            }
            if (hit) {
                hit.id = RULES[i].id;
                flags.push(hit);
            }
        }
        // High severity first, so the badge row leads with the worst finding.
        flags.sort(function (a, b) {
            if (a.severity === b.severity) return 0;
            return a.severity === "high" ? -1 : 1;
        });
        return flags;
    }

    /** Attach flags to every record in one pass. */
    function annotate(records) {
        var list = records || [];
        var ctx = buildContext(list);
        return list.map(function (r) {
            return { record: r, band: bandFor(r), flags: redFlagsFor(r, ctx) };
        });
    }

    /**
     * The chain of control from the natural person to the operating company.
     * Returns 2 steps for a direct holding and 3 when a vehicle sits between,
     * which is what the lineage diagram renders.
     */
    function controlChain(record) {
        if (!record) return [];
        var chain = [{
            kind: "person",
            title: String(record["Person Name"] || "Undisclosed holder"),
            subtitle: String(record["Board Role"] || "Natural person")
        }];

        var vehicle = record["Intermediate Entities"];
        if (!isDirectHolding(vehicle)) {
            chain.push({ kind: "vehicle", title: String(vehicle), subtitle: "Intermediate vehicle" });
        }

        chain.push({
            kind: "company",
            title: String(record.Company || "Undisclosed company"),
            subtitle: "Operating company"
        });
        return chain;
    }

    /**
     * Portfolio-level figures for the KPI strip.
     *
     * Everything here is derived. An earlier version displayed a hardcoded
     * "CAMA 2020 Compliance: 94.2%" that was never computed from anything and
     * was then written into a downloadable audit brief; `disclosureRate` is the
     * honest replacement — the share of records carrying a filing reference.
     */
    function summarise(records) {
        var list = records || [];
        var annotated = annotate(list);

        var percentages = [];
        var indirect = 0;
        var flagged = 0;
        var highSeverity = 0;
        var withFilingRef = 0;
        var nigeriaBand = 0;
        var seeded = 0;

        annotated.forEach(function (item) {
            var pct = toPercent(item.record.Percentage);
            if (pct !== null) percentages.push(pct);
            if (!isDirectHolding(item.record["Intermediate Entities"])) indirect++;
            if (item.flags.length) flagged++;
            if (item.flags.some(function (f) { return f.severity === "high"; })) highSeverity++;
            if (String(item.record["Regulatory Filing Ref"] || "").trim()) withFilingRef++;
            if (item.band && item.band.id === "BAND_5_25") nigeriaBand++;
            if (String(item.record.Source || "").toLowerCase() === "seed") seeded++;
        });

        var mean = percentages.length
            ? percentages.reduce(function (a, b) { return a + b; }, 0) / percentages.length
            : null;

        return {
            total: list.length,
            annotated: annotated,
            meanStake: mean,
            indirectCount: indirect,
            flaggedCount: flagged,
            highSeverityCount: highSeverity,
            nigeriaBandCount: nigeriaBand,
            // Share of records with a regulatory filing reference recorded.
            disclosureRate: list.length ? withFilingRef / list.length : null,
            seededCount: seeded,
            isDemo: seeded > 0
        };
    }

    /**
     * Why a PSC view has nothing to show.
     *
     * An empty list is ambiguous: the register may have failed to load, or
     * loaded and be genuinely empty, or hold records that the active filter
     * excluded. Those are three different claims about beneficial ownership,
     * and collapsing them into one message let a failed fetch read as "no one
     * holds significant control" — the most misleading thing this tool can
     * say. The decision lives here, with the other rules, so it can be tested
     * directly rather than inferred from rendered HTML.
     *
     * Returns {kind, action, ...}: kind is "load-error" | "register-empty" |
     * "filtered-out", action is the affordance that resolves it.
     */
    function emptyStateFor(input) {
        var s = input || {};
        if (s.loadState === "error") {
            return { kind: "load-error", action: "retry", reason: s.error || "" };
        }
        var total = s.totalRecords || 0;
        if (!total) {
            return { kind: "register-empty", action: null };
        }
        return {
            kind: "filtered-out",
            action: "clear",
            total: total,
            // Only name a filter that is actually narrowing the view. "all"
            // plus a search should blame the search alone.
            filterLabel: s.filterId && s.filterId !== "all" ? (s.filterLabel || "") : "",
            query: s.query || ""
        };
    }

    global.AuraPSC = {
        emptyStateFor: emptyStateFor,
        BANDS: BANDS,
        BAND_BY_ID: BAND_BY_ID,
        SECRECY_JURISDICTIONS: SECRECY_JURISDICTIONS,
        toPercent: toPercent,
        classifyBand: classifyBand,
        bandFor: bandFor,
        buildContext: buildContext,
        redFlagsFor: redFlagsFor,
        annotate: annotate,
        controlChain: controlChain,
        summarise: summarise,
        isDirectHolding: isDirectHolding
    };
})(window);
