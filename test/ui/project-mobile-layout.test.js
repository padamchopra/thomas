"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");
const cssSource = () => fs.readFileSync(path.join(repoRoot, "ui/src/styles.css"), "utf8");

test("project detail stacks into a readable single-column layout on phones", () => {
  const css = cssSource();
  assert.match(css, /@media \(max-width: 720px\) \{[\s\S]*\.project-detail-grid,[\s\S]*\.agent-profile-grid\s*\{[\s\S]*grid-template-columns:\s*1fr/);
  assert.match(css, /@media \(max-width: 720px\) \{[\s\S]*\.project-summary-strip\s*\{[\s\S]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 720px\) \{[\s\S]*\.project-detail-layout \.data-panel/);
});

test("phone layout exposes the sidebar from a mobile menu button", () => {
  const css = cssSource();
  const source = fs.readFileSync(path.join(repoRoot, "ui/src/main.jsx"), "utf8");
  assert.match(source, /const \[mobileSidebarOpen, setMobileSidebarOpen\] = useState\(false\)/);
  assert.match(source, /className="mobile-sidebar-toggle"[\s\S]*aria-label="Open navigation"/);
  assert.match(source, /className=\{mobileSidebarOpen \? "side-pane mobile-open" : "side-pane"\}/);
  assert.match(source, /className="mobile-sidebar-backdrop"/);
  assert.match(css, /\.mobile-sidebar-toggle\s*\{[\s\S]*display:\s*none/);
  assert.match(css, /@media \(max-width: 720px\) \{[\s\S]*\.mobile-sidebar-toggle\s*\{[\s\S]*display:\s*inline-flex/);
  assert.match(css, /@media \(max-width: 720px\) \{[\s\S]*\.side-pane\s*\{[\s\S]*position:\s*fixed/);
  assert.match(css, /@media \(max-width: 720px\) \{[\s\S]*\.side-pane\.mobile-open\s*\{[\s\S]*transform:\s*translateX\(0\)/);
  assert.match(css, /@media \(max-width: 720px\) \{[\s\S]*\.content-stage\s*\{[\s\S]*padding:\s*16px 16px calc\(80px \+ env\(safe-area-inset-bottom, 0px\)\)/);
});
