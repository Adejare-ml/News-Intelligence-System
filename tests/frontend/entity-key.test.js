/* Tests for the shared entity-name slug/key scheme. */
(function () {
    "use strict";
    var K = window.AuraEntityKey;

    T.describe("nameKey normalization", function () {
        T.it("lower-cases, trims and single-spaces", function () {
            T.eq(K.nameKey("  First   HoldCo  "), "first holdco");
        });

        T.it("treats non-breaking spaces as spaces", function () {
            T.eq(K.nameKey("First\u00a0HoldCo"), "first holdco");
        });

        T.it("returns empty string for null/undefined/blank", function () {
            T.eq(K.nameKey(null), "");
            T.eq(K.nameKey(undefined), "");
            T.eq(K.nameKey("   "), "");
        });
    });

    T.describe("slugify", function () {
        T.it("produces url-safe hyphenated slugs", function () {
            T.eq(K.slugify("First HoldCo Plc."), "first-holdco-plc");
            T.eq(K.slugify("Femi Otedola"), "femi-otedola");
        });

        T.it("is case- and whitespace-insensitive", function () {
            T.eq(K.slugify("  FEMI   otedola "), "femi-otedola");
        });

        T.it("folds diacritics to ascii", function () {
            T.eq(K.slugify("Café Sociéte"), "cafe-societe");
        });

        T.it("reads ampersand as 'and' so both spellings collide", function () {
            T.eq(K.slugify("A & B Holdings"), K.slugify("A and B Holdings"));
        });

        T.it("collapses punctuation runs into single hyphens, no edge hyphens", function () {
            T.eq(K.slugify("N.N.P.C. (Ltd)"), "n-n-p-c-ltd");
            T.eq(K.slugify("--weird--"), "weird");
        });

        T.it("is idempotent", function () {
            var once = K.slugify("Kaduna Electricity Distribution Company");
            T.eq(K.slugify(once), once);
        });

        T.it("returns empty string when nothing survives", function () {
            T.eq(K.slugify("???"), "");
            T.eq(K.slugify(""), "");
        });
    });

    T.describe("matchesSlug", function () {
        T.it("matches a messy stored name against its clean slug", function () {
            T.ok(K.matchesSlug("  First HoldCo Plc. ", "first-holdco-plc"));
        });

        T.it("never matches on an empty name", function () {
            T.notOk(K.matchesSlug("", ""));
            T.notOk(K.matchesSlug("   ", ""));
        });

        T.it("rejects a different entity", function () {
            T.notOk(K.matchesSlug("Geregu Power Plc", "first-holdco-plc"));
        });
    });

    T.report();
})();
