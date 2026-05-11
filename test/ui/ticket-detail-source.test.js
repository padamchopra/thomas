"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");
const mainSource = () => fs.readFileSync(path.join(repoRoot, "ui/src/main.jsx"), "utf8");
const cssSource = () => fs.readFileSync(path.join(repoRoot, "ui/src/styles.css"), "utf8");

test("ticket details merge live run activity into the conversation tab", () => {
  const source = mainSource();
  assert.doesNotMatch(source, /onClick=\{\(\) => setDetailTab\("activity"\)\}>Activity<\/button>/);
  assert.doesNotMatch(source, /detailTab === "activity" &&/);
  assert.match(source, /const ticketRuns = \(state\.runs \|\| \[\]\)[\s\S]*\.filter\(\(run\) => run\.ticketId === ticket\.id/);
  assert.match(source, /detailTab === "conversation"[\s\S]*<ConversationTimeline comments=\{orderedComments\} runs=\{ticketRuns\}/);
  assert.doesNotMatch(source, /detailTab === "conversation"[\s\S]*<LiveActivity run=\{ticketRun\}/);
});

test("conversation timeline sorts comments and live activity together by timestamp", () => {
  const source = mainSource();
  assert.match(source, /function buildConversationTimelineItems\(comments, runs\)/);
  assert.match(source, /stableCommentTimelineId\(comment\)/);
  assert.match(source, /stableRunEventTimelineId\(run, event, index, eventIdCounts\)/);
  assert.doesNotMatch(source, /run\?\.events \|\| \[\]\)\.slice\(-30\)/);
  assert.match(source, /\.sort\(\(a, b\) => dateValue\(a\.createdAt\) - dateValue\(b\.createdAt\)\)/);
  assert.match(source, /function groupConversationTimelineItems\(items\)/);
});

test("conversation timeline dedupes run events with stable keys", () => {
  const source = mainSource();
  assert.match(source, /const seenEvents = new Set\(\)/);
  assert.match(source, /runEventDedupeKey\(run, event, id\)/);
  assert.match(source, /countEventIds\(run, events\)/);
  assert.match(source, /return `event-\$\{scopedId\}`/);
  assert.match(source, /return `event-\$\{scopedId\}:\$\{index \+ 1\}`/);
  assert.doesNotMatch(source, /activeCollapsedGroup\.id = `collapsed-\$\{activeCollapsedGroup\.events\[0\]\.id\}-\$\{item\.id\}`/);
});

test("live activity collapses tool, output, stderr, and thinking rows by default", () => {
  const source = mainSource();
  const css = cssSource();
  assert.match(source, /isExpandedLiveEventKind\(event\.kind\)/);
  assert.match(source, /function isExpandedLiveEventKind\(kind\)/);
  assert.match(source, /kind === "assistant"/);
  assert.doesNotMatch(source, /kind === "assistant" \|\| kind === "finished"/);
  assert.match(css, /\.live-event-collapsed[\s\S]*grid-template-columns/);
  assert.match(css, /\.live-event-collapsed p[\s\S]*display:\s*none/);
});

test("conversation timeline skips low-signal run activity instead of rendering collapsed groups", () => {
  const source = mainSource();
  assert.match(source, /if \(!isConversationLiveEventKind\(item\.event\.kind\)\) continue;/);
  assert.match(source, /function isConversationLiveEventKind\(kind\) \{\s*return kind === "assistant" \|\| kind === "failed" \|\| kind === "stopped";\s*\}/);
  assert.doesNotMatch(source, /activeCollapsedGroup/);
  assert.doesNotMatch(source, /<CollapsedLiveEventGroup/);
});

test("final run events stay collapsed instead of duplicating the assistant transcript", () => {
  const source = mainSource();
  const runner = fs.readFileSync(path.join(repoRoot, "src/server/agent-runner.js"), "utf8");
  assert.match(source, /function isExpandedLiveEventKind\(kind\) \{\s*return kind === "assistant";\s*\}/);
  assert.match(runner, /finalRunEventText\(run, agentName, exitCode, errorMessage\)/);
  assert.match(runner, /addRunEvent\(run, run\.status, finalRunEventText/);
});

test("conversation payload is selected for useful events before slicing", () => {
  const runner = fs.readFileSync(path.join(repoRoot, "src/server/agent-runner.js"), "utf8");
  assert.match(runner, /events:\s*selectConversationEvents\(run\.events \|\| \[\]\)/);
  assert.match(runner, /function selectConversationEvents\(events\)/);
  assert.match(runner, /isConversationRunEvent\(event\)/);
  assert.doesNotMatch(runner, /event\.kind === "tool"/);
  assert.doesNotMatch(runner, /events:\s*\(run\.events \|\| \[\]\)\.slice\(-80\)/);
});

test("live activity groups consecutive collapsed rows outside the conversation payload", () => {
  const source = mainSource();
  const css = cssSource();
  assert.match(source, /groupLiveActivityEvents\(run\.events\?\.slice\(-30\) \|\| \[\]\)/);
  assert.match(source, /function groupLiveActivityEvents\(events\)/);
  assert.match(source, /group\.type === "collapsed"/);
  assert.match(source, /group\.events\.map\(\(event\)/);
  assert.match(source, /\{group\.events\.length\} collapsed event/);
  assert.match(css, /\.live-event-group[\s\S]*border/);
  assert.match(css, /\.live-event-group-list[\s\S]*display:\s*grid/);
});

test("settings notification test uses service worker notifications where available", () => {
  const source = mainSource();
  const css = cssSource();
  const html = fs.readFileSync(path.join(repoRoot, "ui/index.html"), "utf8");
  const worker = fs.readFileSync(path.join(repoRoot, "ui/public/thomas-sw.js"), "utf8");
  const manifest = fs.readFileSync(path.join(repoRoot, "ui/public/manifest.webmanifest"), "utf8");
  assert.match(source, /function registerThomasServiceWorker\(\)/);
  assert.match(source, /navigator\.serviceWorker\.register\("\/thomas-sw\.js"\)/);
  assert.match(source, /async function showThomasNotification\(title, options = \{\}\)/);
  assert.match(source, /registration\.showNotification\(title, options\)/);
  assert.match(source, /function notificationSupportStatus\(\)/);
  assert.match(source, /window\.isSecureContext === false/);
  assert.match(source, /Add Thomas to your Home Screen/);
  assert.match(source, /setNotificationStatus\(await showThomasNotification/);
  assert.match(source, /notifyHumanReviewTickets\(state, notifiedHumanReviewTicketIds\.current, notificationBaselineReady\)/);
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest" \/>/);
  assert.match(worker, /self\.registration\.showNotification/);
  assert.match(manifest, /"display": "standalone"/);
  assert.match(source, /className="notification-status"/);
  assert.match(css, /\.notification-status[\s\S]*grid-column:\s*1 \/ -1/);
});

test("agent runner keeps event ids monotonic after pruning", () => {
  const runner = fs.readFileSync(path.join(repoRoot, "src/server/agent-runner.js"), "utf8");
  assert.match(runner, /nextEventSequence:\s*1/);
  assert.match(runner, /run\.nextEventSequence = nextEventSequence\(run\)/);
  assert.match(runner, /function nextRunEventId\(run\)/);
  assert.match(runner, /id: nextRunEventId\(run\)/);
  assert.doesNotMatch(runner, /id: `\$\{run\.id\}-\$\{run\.events\.length \+ 1\}`/);
});

test("assistant live events and chat-style markdown wrap inside their cards", () => {
  const source = mainSource();
  const css = cssSource();
  assert.match(source, /event\.kind === "assistant" \? <MarkdownText value=\{event\.text\} className="live-event-markdown" \/> : <p>\{event\.text\}<\/p>/);
  assert.match(css, /\.live-event-markdown[\s\S]*min-width:\s*0/);
  assert.match(css, /\.note[\s\S]*min-width:\s*0/);
  assert.match(css, /\.markdown-body[\s\S]*overflow-wrap:\s*anywhere/);
  assert.match(css, /\.markdown-body pre[\s\S]*white-space:\s*pre-wrap/);
  assert.match(css, /\.markdown-body code[\s\S]*word-break:\s*break-word/);
});

test("assistant live events keep the blue agent block highlight", () => {
  const css = cssSource();
  assert.match(css, /\.live-event-assistant[\s\S]*border-left:\s*3px solid var\(--blue\)/);
  assert.match(css, /\.live-event-assistant[\s\S]*background:\s*color-mix\(in srgb, var\(--blue\) 8%, var\(--card\)\)/);
  assert.match(css, /\.live-event-assistant span[\s\S]*color:\s*color-mix\(in srgb, var\(--blue\) 82%, var\(--foreground\)\)/);
});

test("expanded live event text starts on the first row without spacer gap", () => {
  const css = cssSource();
  assert.match(css, /\.live-event-expanded[\s\S]*grid-template-columns:\s*82px minmax\(0, 1fr\)/);
  assert.match(css, /\.live-event-expanded[\s\S]*row-gap:\s*0/);
  assert.match(css, /\.live-event-expanded summary[\s\S]*grid-column:\s*1/);
  assert.match(css, /\.live-event-expanded > p[\s\S]*grid-column:\s*2/);
  assert.match(css, /\.live-event-expanded > p[\s\S]*margin-left:\s*0/);
  assert.match(css, /\.live-event-expanded > \.live-event-markdown[\s\S]*grid-column:\s*2/);
  assert.match(css, /\.live-event-expanded > \.live-event-markdown[\s\S]*margin-left:\s*0/);
});

test("settings no longer expose a live agent activity log checkbox", () => {
  const source = mainSource();
  assert.doesNotMatch(source, /Show live agent activity/);
  assert.doesNotMatch(source, /showLiveAgentActivity/);
});
