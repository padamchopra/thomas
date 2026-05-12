"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");
const mainSource = () => fs.readFileSync(path.join(repoRoot, "ui/src/main.jsx"), "utf8");
const cssSource = () => fs.readFileSync(path.join(repoRoot, "ui/src/styles.css"), "utf8");

test("inbox view is a ticket-level triage workspace without dashboard summaries", () => {
  const source = mainSource();
  const css = cssSource();
  const inboxSource = source.slice(source.indexOf("function InboxView("), source.indexOf("function InboxQueuePanel"));
  assert.match(inboxSource, /className="inbox-workspace"/);
  assert.match(inboxSource, /className="inbox-triage-list"/);
  assert.match(inboxSource, /<InboxQueuePanel title="Human Review"/);
  assert.match(inboxSource, /<InboxQueuePanel title="PR Review"/);
  assert.match(inboxSource, /<InboxQueuePanel title="Blocked"/);
  assert.match(inboxSource, /<InboxQueuePanel title="Unassigned"/);
  assert.doesNotMatch(inboxSource, /inbox-summary-grid/);
  assert.doesNotMatch(inboxSource, /InboxSummaryCard/);
  assert.doesNotMatch(inboxSource, /Project Inbox/);
  assert.doesNotMatch(inboxSource, /Review Split/);
  assert.doesNotMatch(inboxSource, /split-columns/);
  assert.doesNotMatch(source, /function InboxSummaryCard/);
  assert.match(source, /function InboxQueuePanel/);
  assert.match(css, /\.inbox-triage-list\s*\{[\s\S]*display:\s*grid/);
  assert.match(css, /\.inbox-queue-panel \.section-titlebar::before/);
  assert.doesNotMatch(css, /\.inbox-summary-grid/);
  assert.doesNotMatch(css, /\.inbox-layout/);
});
