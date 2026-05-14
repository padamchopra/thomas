"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");
const mainSource = () => fs.readFileSync(path.join(repoRoot, "ui/src/main.jsx"), "utf8");
const cssSource = () => fs.readFileSync(path.join(repoRoot, "ui/src/styles.css"), "utf8");

test("ticket details merge live run activity into the persistent conversation rail", () => {
  const source = mainSource();
  assert.doesNotMatch(source, /onClick=\{\(\) => setDetailTab\("activity"\)\}>Activity<\/button>/);
  assert.doesNotMatch(source, /detailTab === "activity" &&/);
  assert.doesNotMatch(source, /detailTab === "conversation"/);
  assert.match(source, /const ticketRuns = \(state\.runs \|\| \[\]\)[\s\S]*\.filter\(\(run\) => run\.ticketId === ticket\.id/);
  assert.match(source, /<aside className="conversation-rail">[\s\S]*<ConversationTimeline comments=\{orderedComments\} runs=\{ticketRuns\}/);
  assert.doesNotMatch(source, /<LiveActivity run=\{ticketRun\}/);
});

test("ticket details expose manual setup script action for the ticket worktree", () => {
  const source = mainSource();
  const api = fs.readFileSync(path.join(repoRoot, "ui/src/lib/api.js"), "utf8");
  const server = fs.readFileSync(path.join(repoRoot, "src/server/app.js"), "utf8");
  const workspace = fs.readFileSync(path.join(repoRoot, "src/server/workspace.js"), "utf8");
  assert.match(api, /export async function runTicketSetupScript\(ticketId\)/);
  assert.match(api, /\/run-setup-script/);
  assert.match(source, /onRunSetupScript=\{handleRunTicketSetupScript\}/);
  assert.match(source, /function TicketDetail\([\s\S]*onRunSetupScript/);
  assert.match(source, /title="Run setup script in worktree"/);
  assert.match(source, /const result = await onRunSetupScript\(ticket\.id\)/);
  assert.match(server, /parts\[2\] === "run-setup-script"/);
  assert.match(workspace, /function runTicketSetupScript\(ticket, options = \{\}\)/);
  assert.match(workspace, /ensureTicketWorkspace\(ticket, \{ \.\.\.options, runSetup: false \}\)/);
  assert.match(workspace, /cwd:\s*workspace\.path/);
});

test("ticket details support You as a manual assignee", () => {
  const source = mainSource();
  const css = cssSource();
  assert.match(source, /const SELF_ASSIGNEE_ID = "you"/);
  assert.match(source, /<option value=\{SELF_ASSIGNEE_ID\}>You<\/option>/);
  assert.match(source, /const isSelfAssigned = ticket\.assigneeAgentId === SELF_ASSIGNEE_ID/);
  assert.match(source, /isSelfAssigned \? \(/);
  assert.match(source, /<select value=\{ticket\.status\} onChange=\{updateStatus\} aria-label="Ticket status">/);
  assert.match(source, /<select value=\{ticket\.assigneeAgentId \|\| ""\} onChange=\{updateAssignee\} aria-label="Ticket assignee">/);
  assert.match(source, /label="Assignees"/);
  assert.match(css, /\.ticket-meta-select select,[\s\S]*\.status-chip-select select/);
});

test("ticket details show a live elapsed timer while the ticket run is in progress", () => {
  const source = mainSource();
  assert.match(source, /function TicketHeaderProperties\(\{ state, ticket,/);
  assert.match(source, /const runningTicketRun = state\.runs\?\.find\(\(run\) => run\.ticketId === ticket\.id && run\.status === "running"\) \|\| null/);
  assert.match(source, /\{runningTicketRun \? <RunningElapsed run=\{runningTicketRun\} \/> : null\}/);
});

test("sub-issue section stays compact and lets child issue titles wrap", () => {
  const css = cssSource();
  assert.match(css, /\.ticket-workspace-main[\s\S]*align-content:\s*start/);
  assert.match(css, /\.sub-issues-section[\s\S]*align-self:\s*start/);
  assert.match(css, /\.sub-issue-list[\s\S]*align-items:\s*start/);
  assert.match(css, /\.sub-issue-row,[\s\S]*width:\s*fit-content/);
  assert.match(css, /\.sub-issue-row span:last-child[\s\S]*white-space:\s*normal/);
  assert.match(css, /\.sub-issue-row span:last-child[\s\S]*overflow-wrap:\s*anywhere/);
});

test("conversation rail shows queued follow-ups with removable cross controls", () => {
  const source = mainSource();
  const css = cssSource();
  const api = fs.readFileSync(path.join(repoRoot, "ui/src/lib/api.js"), "utf8");
  assert.match(api, /export async function removeQueuedFollowup\(ticketId, followupId\)/);
  assert.match(source, /onRemoveQueuedFollowup/);
  assert.match(source, /const queuedFollowups = ticket\.queuedFollowups \|\| \[\]/);
  assert.match(source, /<QueuedFollowupsList followups=\{queuedFollowups\} onRemove=\{\(followupId\) => onRemoveQueuedFollowup\(ticket\.id, followupId\)\} \/>/);
  assert.match(source, /function QueuedFollowupsList\(\{ followups, onRemove \}\)/);
  assert.match(source, /aria-label=\{`Remove queued follow-up/);
  assert.match(css, /\.queued-followups[\s\S]*display:\s*grid/);
  assert.match(css, /\.queued-followup-item[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) auto/);
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
  assert.match(source, /return `\$\{run\?\.id \|\| "run"\}:\$\{event\?\.kind \|\| "event"\}:\$\{event\?\.createdAt \|\| ""\}:\$\{textKey\}`/);
  assert.match(source, /return `event-\$\{scopedId\}`/);
  assert.match(source, /return `event-\$\{scopedId\}:\$\{index \+ 1\}`/);
  assert.doesNotMatch(source, /activeCollapsedGroup\.id = `collapsed-\$\{activeCollapsedGroup\.events\[0\]\.id\}-\$\{item\.id\}`/);
});

test("conversation timeline is an internally scrolling frame that sticks to bottom", () => {
  const source = mainSource();
  const css = cssSource();
  assert.match(source, /const frameRef = useRef\(null\)/);
  assert.match(source, /const shouldStickRef = useRef\(true\)/);
  assert.match(source, /frame\.scrollTop = frame\.scrollHeight/);
  assert.match(source, /distanceFromBottom < 48/);
  assert.match(source, /<div className="conversation-frame">/);
  assert.match(source, /<div className="conversation-scroll" ref=\{frameRef\} onScroll=\{handleScroll\}>/);
  assert.match(css, /\.conversation-frame[\s\S]*overflow:\s*hidden/);
  assert.match(css, /\.conversation-scroll[\s\S]*overflow-y:\s*auto/);
});

test("diff viewer collapses unchanged context and can hide the file tree", () => {
  const source = mainSource();
  const css = cssSource();
  assert.match(source, /const \[treeCollapsed, setTreeCollapsed\] = useState\(false\)/);
  assert.match(source, /const \[expandedContext, setExpandedContext\] = useState\(\(\) => new Set\(\)\)/);
  assert.match(source, /function buildDiffLineBlocks\(lines\)/);
  assert.match(source, /line\.type === "context" \? "context" : "change"/);
  assert.match(source, /className=\{`diff-review-layout\$\{treeCollapsed \? " tree-collapsed" : ""\}`\}/);
  assert.match(source, /className="quiet-button project-tree-toggle project-tree-toggle-collapsed"/);
  assert.match(source, /className=\{`diff-context-group\$\{expanded \? " expanded" : ""\}`\}/);
  assert.match(source, /className="diff-context-toggle"/);
  assert.match(source, /\{block\.lines\.length\} unchanged line/);
  assert.match(css, /\.diff-review-layout\.tree-collapsed[\s\S]*grid-template-columns:\s*42px minmax\(0, 1fr\)/);
  assert.match(css, /\.diff-context-toggle[\s\S]*grid-template-columns:\s*28px minmax\(0, 1fr\) auto/);
  assert.match(css, /\.inline-diff-section[\s\S]*max-height:\s*min\(46vh, 560px\)/);
  assert.match(css, /\.inline-diff-section \.diff-viewer[\s\S]*overflow-y:\s*auto/);
  assert.match(css, /\.diff-file[\s\S]*overflow-x:\s*auto/);
  assert.match(css, /\.diff-line[\s\S]*grid-template-columns:\s*28px 44px 44px max-content/);
  assert.match(css, /\.diff-line pre[\s\S]*overflow:\s*visible/);
});

test("agent runner skips exact consecutive duplicate run events", () => {
  const runner = fs.readFileSync(path.join(repoRoot, "src/server/agent-runner.js"), "utf8");
  assert.match(runner, /const last = run\.events\.at\(-1\)/);
  assert.match(runner, /if \(last\?\.kind === kind && last\.text === cleaned\) return;/);
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
