#!/usr/bin/env node
/**
 * Headless entry point for the frontend suite, so CI can run it.
 *
 * index.html stays the debugging surface -- it shows the same results in a
 * browser, in the environment the code actually ships to. This file exists
 * because a test page nobody opens is not a test suite: 39 assertions ran only
 * when someone remembered to load the page by hand.
 *
 * No browser and no dependencies. Every module under test is a DOM-free
 * `(function (global) {...})(window)` IIFE, so a bare VM context with a `window`
 * that points at itself is a faithful enough host. The only DOM call in the
 * whole chain is runner.js's `document.getElementById("out")`, which already
 * tolerates a null return, so a one-method stub covers it.
 *
 * Exits 1 on any failure, which is what makes the CI job meaningful.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const JS_DIR = path.join(__dirname, "..", "..", "backend", "app", "static", "js");

// Same order as index.html loads them: modules first, then the harness, then
// the tests that consume both. Keep the two lists in step.
const FILES = [
    path.join(JS_DIR, "psc-core.js"),
    path.join(JS_DIR, "report-markdown.js"),
    path.join(__dirname, "runner.js"),
    path.join(__dirname, "psc-core.test.js")
];

const sandbox = {
    console: console,
    // runner.js reports into #out when it exists; headless, it never does.
    document: { getElementById: () => null }
};
sandbox.window = sandbox;
vm.createContext(sandbox);

for (const file of FILES) {
    if (!fs.existsSync(file)) {
        console.error(`missing file under test: ${file}`);
        process.exit(1);
    }
    try {
        vm.runInContext(fs.readFileSync(file, "utf8"), sandbox, { filename: file });
    } catch (err) {
        console.error(`failed to evaluate ${path.basename(file)}: ${err.message}`);
        process.exit(1);
    }
}

const results = sandbox.__results;

// A suite that silently runs nothing must not read as a pass -- that is the
// failure mode a green check is least likely to survive.
if (!results || typeof results.total !== "number" || results.total === 0) {
    console.error("FAIL — the harness reported no results; did a test file fail to load?");
    process.exit(1);
}

if (results.failed > 0) {
    console.error(`FAIL — ${results.failed} of ${results.total}`);
    results.failures.forEach(f => console.error(`  • ${f}`));
    process.exit(1);
}

console.log(`PASS — ${results.passed}/${results.total}`);
