import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SECTIONS } from "./nav.ts";

const component = (name: string) => readFileSync(resolve(import.meta.dirname, `../components/${name}`), "utf-8");
/** The max-width of the media query whose block starts with `selector`. */
const breakpoint = (css: string, selector: string) => {
  const m = css.match(new RegExp(`@media \\(max-width: (\\d+)px\\) \\{\\s*${selector.replace(".", "\\.")} \\{`));
  return m ? Number(m[1]) : null;
};

// The header bar was measured in headless Chrome: with seven sections it fits
// from 1,101px (tighter from there to 1,279px), and below that the tab bar
// takes over. #169 and #171 each added a section without a new measurement,
// and together they pushed the Morning Brief button and the theme toggle off
// the bar between 901 and about 1,080px.
test("the header nav, the tab bar and the alerts toast switch at the measured width", () => {
  assert.equal(breakpoint(component("Header.astro"), ".nav"), 1100, "Header.astro hides .nav");
  assert.equal(breakpoint(component("TabBar.astro"), ".tabbar"), 1100, "TabBar.astro shows .tabbar");
  // The toast sits above the tab bar wherever the tab bar shows.
  assert.equal(breakpoint(component("AlertsInbox.astro"), ".toast"), 1100, "AlertsInbox.astro lifts .toast");
  assert.ok(SECTIONS.length <= 7, "measure the header bar again before adding an eighth section");
});
