/* Tests for the report markdown renderer -- the component that renders the
   site's primary product, previously covered only by a reachability check. */
(function () {
    "use strict";
    var MD = window.AuraReportMarkdown;

    T.describe("link rendering and sanitization", function () {
        T.it("renders http(s) links with noopener and the report-link class", function () {
            var html = MD.renderInline("[Punch](https://punchng.com/story)");
            T.contains(html, 'href="https://punchng.com/story"');
            T.contains(html, 'rel="noopener noreferrer"');
            T.contains(html, 'class="report-link"');
            T.contains(html, ">Punch</a>");
        });

        T.it("does not double-encode ampersands in query strings", function () {
            var html = MD.renderInline("[x](https://a.test/p?a=1&b=2)");
            T.contains(html, 'href="https://a.test/p?a=1&amp;b=2"');
            T.excludes(html, "&amp;amp;");
        });

        T.it("neutralizes javascript: and data: hrefs to #", function () {
            T.contains(MD.renderInline("[click](javascript:alert(1))"), 'href="#"');
            T.contains(MD.renderInline("[click](data:text/html,x)"), 'href="#"');
        });

        T.it("escapes markup inside link labels", function () {
            var html = MD.renderInline("[<b>bold</b>](https://a.test)");
            T.excludes(html, "<b>");
            T.contains(html, "&lt;b&gt;");
        });
    });

    T.describe("inline formatting", function () {
        T.it("escapes raw HTML in text", function () {
            var html = MD.parseMarkdown("<script>alert(1)</script>");
            T.excludes(html, "<script>");
            T.contains(html, "&lt;script&gt;");
        });

        T.it("renders bold, italics and code", function () {
            T.contains(MD.renderInline("**b**"), "<strong>b</strong>");
            T.contains(MD.renderInline("*i*"), "<em>i</em>");
            T.contains(MD.renderInline("`c`"), "<code>c</code>");
        });
    });

    T.describe("block structure", function () {
        T.it("demotes headings by the configured offset and generates ids", function () {
            var html = MD.parseMarkdown("# Key Developments", { headingOffset: 1 });
            T.contains(html, '<h2 id="sec-key-developments">');
            T.excludes(html, "<h1");
        });

        T.it("caps demotion at h6", function () {
            var html = MD.parseMarkdown("#### Deep", { headingOffset: 4 });
            T.contains(html, "<h6");
        });

        T.it("keeps indented sub-bullets as depth classes on one flat list", function () {
            var html = MD.parseMarkdown("* top\n  * nested");
            T.contains(html, '<li class="md-l0">top</li>');
            T.contains(html, '<li class="md-l1">nested</li>');
            // one list, valid markup
            T.eq(html.split("<ul>").length - 1, 1, "a single <ul>");
        });

        T.it("renders numbered lists as <ol>", function () {
            var html = MD.parseMarkdown("1. first\n2. second");
            T.contains(html, "<ol>");
            T.contains(html, "<li class=\"md-l0\">first</li>");
        });

        T.it("closes a list at a following heading instead of swallowing it", function () {
            var html = MD.parseMarkdown("* item\n\n### Next Section");
            T.contains(html, "</ul>");
            T.contains(html, "<h3");
            T.notOk(/<li[^>]*>[^<]*<h3/.test(html), "heading must not nest inside the list item");
        });

        T.it("renders dividers and blockquotes", function () {
            T.contains(MD.parseMarkdown("---"), '<hr class="report-divider">');
            T.contains(MD.parseMarkdown("> quoted"), "<blockquote>quoted</blockquote>");
        });

        T.it("returns empty string for empty input", function () {
            T.eq(MD.parseMarkdown(""), "");
            T.eq(MD.parseMarkdown(null), "");
        });
    });

    T.report();
})();
