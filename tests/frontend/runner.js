/**
 * Minimal browser test harness.
 *
 * The dashboard has no build step and no package.json, so a real runner would
 * mean adding a whole toolchain to a project that deliberately has none. This
 * is ~60 lines, runs in the same environment the code actually ships to, and
 * exposes results on window.__results for automated inspection.
 */
(function (global) {
    "use strict";

    var results = { passed: 0, failed: 0, failures: [], total: 0 };
    var current = "";

    function describe(name, fn) {
        current = name;
        try {
            fn();
        } catch (err) {
            record(false, "threw outside a test: " + err.message);
        }
        current = "";
    }

    function record(ok, label) {
        results.total++;
        if (ok) {
            results.passed++;
        } else {
            results.failed++;
            results.failures.push((current ? current + " › " : "") + label);
        }
    }

    function it(label, fn) {
        try {
            fn();
            record(true, label);
        } catch (err) {
            record(false, label + " — " + err.message);
        }
    }

    function eq(actual, expected, note) {
        var a = JSON.stringify(actual);
        var e = JSON.stringify(expected);
        if (a !== e) {
            throw new Error((note ? note + ": " : "") + "expected " + e + ", got " + a);
        }
    }

    function ok(value, note) {
        if (!value) throw new Error(note || "expected a truthy value, got " + JSON.stringify(value));
    }

    function notOk(value, note) {
        if (value) throw new Error(note || "expected a falsy value, got " + JSON.stringify(value));
    }

    function contains(haystack, needle, note) {
        if (String(haystack).indexOf(needle) === -1) {
            throw new Error((note ? note + ": " : "") + "expected to find " + JSON.stringify(needle)
                + " in " + JSON.stringify(String(haystack).slice(0, 400)));
        }
    }

    function excludes(haystack, needle, note) {
        if (String(haystack).indexOf(needle) !== -1) {
            throw new Error((note ? note + ": " : "") + "did not expect to find " + JSON.stringify(needle)
                + " in " + JSON.stringify(String(haystack).slice(0, 400)));
        }
    }

    function report() {
        global.__results = results;
        var el = global.document.getElementById("out");
        if (el) {
            el.textContent = results.failed === 0
                ? "PASS — " + results.passed + "/" + results.total
                : "FAIL — " + results.failed + " of " + results.total + "\n\n" + results.failures.join("\n");
            el.className = results.failed === 0 ? "pass" : "fail";
        }
        return results;
    }

    global.T = {
        describe: describe, it: it,
        eq: eq, ok: ok, notOk: notOk, contains: contains, excludes: excludes,
        report: report
    };
})(window);
