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
  assert.match(source, /detailTab === "conversation"[\s\S]*<ConversationTimeline comments=\{orderedComments\} run=\{ticketRun\}/);
  assert.doesNotMatch(source, /detailTab === "conversation"[\s\S]*<LiveActivity run=\{ticketRun\}/);
});

test("conversation timeline sorts comments and live activity together by timestamp", () => {
  const source = mainSource();
  assert.match(source, /function buildConversationTimelineItems\(comments, run\)/);
  assert.match(source, /comments\.map\(\(comment\) => \(\{ type: "comment"/);
  assert.match(source, /\(run\?\.events \|\| \[\]\)\.slice\(-30\)\.map\(\(event\) => \(\{ type: "event"/);
  assert.match(source, /\.sort\(\(a, b\) => dateValue\(a\.createdAt\) - dateValue\(b\.createdAt\)\)/);
  assert.match(source, /function groupConversationTimelineItems\(items\)/);
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

test("conversation timeline combines low-signal run activity into one block per human segment", () => {
  const source = mainSource();
  assert.match(source, /let activeCollapsedGroup = null/);
  assert.match(source, /activeCollapsedGroup\.events\.push\(item\.event\)/);
  assert.match(source, /if \(item\.type === "comment"\) \{\s*activeCollapsedGroup = null;/);
});

test("final run events stay collapsed instead of duplicating the assistant transcript", () => {
  const source = mainSource();
  const runner = fs.readFileSync(path.join(repoRoot, "src/server/agent-runner.js"), "utf8");
  assert.match(source, /function isExpandedLiveEventKind\(kind\) \{\s*return kind === "assistant";\s*\}/);
  assert.match(runner, /finalRunEventText\(run, agentName, exitCode, errorMessage\)/);
  assert.match(runner, /addRunEvent\(run, run\.status, finalRunEventText/);
});

test("live activity groups consecutive collapsed rows into one expandable block", () => {
  const source = mainSource();
  const css = cssSource();
  assert.match(source, /groupConversationTimelineItems\(timelineItems\)/);
  assert.match(source, /function groupConversationTimelineItems\(items\)/);
  assert.match(source, /group\.type === "collapsed"/);
  assert.match(source, /group\.events\.map\(\(event\)/);
  assert.match(source, /\{group\.events\.length\} collapsed event/);
  assert.match(css, /\.live-event-group[\s\S]*border/);
  assert.match(css, /\.live-event-group-list[\s\S]*display:\s*grid/);
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
