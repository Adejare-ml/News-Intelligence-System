/**
 * Report markdown rendering.
 *
 * Split out of app.js so it can be exercised by tests/frontend/ without a DOM.
 * Everything in app.js runs inside a DOMContentLoaded closure that assumes the
 * dashboard elements exist, which made the report parser -- the component that
 * renders this site's primary product -- the least testable code in the
 * project despite being the most important.
 */
(function (global) {
    "use strict";

    function esc(str) {
        return String(str == null ? "" : str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    // Only http(s) destinations survive. Report text is LLM-generated from
    // untrusted news content, so a javascript:/data: href here would be a
    // prompt-injection -> stored-XSS chain.
    function safeUrl(url) {
        var u = String(url == null ? "" : url).trim();
        return /^https?:\/\//i.test(u) ? u : "#";
    }

    function safeUrlAttr(url) {
        return esc(safeUrl(url));
    }

// Inline markdown: code, bold, italics and links, for a single line.
//
// Links are pulled out into placeholders *before* escaping. Escaping first
// and then matching would feed an already-escaped URL to safeUrlAttr and
// double-encode every "&" in a query string.
function renderInline(text) {
    const links = [];
    let work = String(text).replace(/\[([^\]]*)\]\(([^)\s]*)\)/g, (m, label, url) => {
        links.push({ label: label, url: url });
        return "L" + (links.length - 1) + "";
    });

    work = work.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    work = work.replace(/`([^`]+)`/g, '<code>$1</code>');
    work = work.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // Italics need a boundary check, otherwise a lone "*" left over from a
    // list marker pairs with the next one and italicises whole paragraphs.
    work = work.replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<em>$2</em>');

    return work.replace(/L(\d+)/g, (m, i) => {
        const link = links[Number(i)];
        const label = String(link.label)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        return `<a href="${safeUrlAttr(link.url)}" target="_blank" rel="noopener noreferrer" class="report-link">${label}</a>`;
    });
}

/**
 * Render report markdown.
 *
 * Line-based rather than a stack of global regexes. The previous version
 * wrapped lists with /(<li>.*<\/li>)/sg — dotAll plus a greedy .* matches
 * from the first <li> in the document to the last, so every section
 * heading and divider between them ended up nested inside a single
 * bullet list. It also required list markers at column 0, so the indented
 * sub-bullets the model actually emits rendered as literal "* " text.
 *
 * Headings carry generated ids so the report gets a table of contents and
 * shareable deep links.
 */
function parseMarkdown(md, options) {
    if (!md) return "";

    // headingOffset demotes every heading by N levels. The brief is embedded
    // in a page that already carries an <h1> and an <h2> above it, so
    // rendering the report's own "# Title" as a second <h1> would break the
    // document's heading order for screen-reader users.
    const offset = (options && options.headingOffset) || 0;

    const lines = String(md).replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let listTag = null;

    function closeList() {
        if (listTag) { out.push(`</${listTag}>`); listTag = null; }
    }
    function openList(tag) {
        if (listTag === tag) return;
        closeList();
        out.push(`<${tag}>`);
        listTag = tag;
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].replace(/\s+$/, "");

        if (!line.trim()) { closeList(); continue; }

        const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
        const numbered = line.match(/^(\s*)\d+[.)]\s+(.*)$/);
        const item = bullet || numbered;
        if (item) {
            openList(bullet ? "ul" : "ol");
            // Depth is expressed with a class on a flat list rather than a
            // nested <ul>, which keeps the markup valid without tracking an
            // open-<li> stack.
            const indent = item[1].replace(/\t/g, "  ").length;
            const depth = Math.min(Math.floor(indent / 2), 2);
            out.push(`<li class="md-l${depth}">${renderInline(item[2])}</li>`);
            continue;
        }

        closeList();

        const heading = line.match(/^(#{1,4})\s+(.*)$/);
        if (heading) {
            const level = Math.min(6, heading[1].length + offset);
            const text = heading[2];
            const id = "sec-" + text.toLowerCase()
                .replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 60);
            out.push(`<h${level} id="${esc(id)}">${renderInline(text)}</h${level}>`);
            continue;
        }

        if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
            out.push('<hr class="report-divider">');
            continue;
        }

        const quote = line.match(/^>\s?(.*)$/);
        if (quote) {
            out.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
            continue;
        }

        out.push(`<p>${renderInline(line)}</p>`);
    }

    closeList();
    return out.join("\n");
}

    global.AuraReportMarkdown = {
        parseMarkdown: parseMarkdown,
        renderInline: renderInline
    };
})(window);
