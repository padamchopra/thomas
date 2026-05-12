"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");
const mainSource = () => fs.readFileSync(path.join(repoRoot, "ui/src/main.jsx"), "utf8");
const cssSource = () => fs.readFileSync(path.join(repoRoot, "ui/src/styles.css"), "utf8");

test("dashboard exposes aggregate operation signals without ticket queues", () => {
  const source = mainSource();
  const css = cssSource();
  const dashboardSource = source.slice(source.indexOf("function Dashboard("), source.indexOf("function DashboardMetricCard"));
  assert.match(source, /className="dashboard-signal-grid"/);
  assert.match(source, /label="In Flight" value=\{inFlightCount\}/);
  assert.doesNotMatch(source, /label="Open Work"/);
  assert.match(dashboardSource, /onOpenTicketsPreset\("in_flight"\)/);
  assert.match(dashboardSource, /onOpenTicketsPreset\("needs_review"\)/);
  assert.match(dashboardSource, /onOpenTicketsPreset\("unassigned"\)/);
  assert.match(dashboardSource, /onOpenTicketsPreset\("done"\)/);
  assert.doesNotMatch(dashboardSource, /DashboardQueuePanel/);
  assert.doesNotMatch(dashboardSource, /title="Needs Attention"/);
  assert.doesNotMatch(dashboardSource, /title="Active Review"/);
  assert.doesNotMatch(dashboardSource, /title="Recent Tickets"/);
  assert.doesNotMatch(dashboardSource, /<h2>Activity<\/h2>/);
  assert.match(source, /function DashboardMetricCard/);
  assert.match(source, /<button type="button" className="dashboard-metric-card"/);
  assert.doesNotMatch(source, /function DashboardQueuePanel/);
  assert.match(source, /data-tone=\{tone\}/);
  assert.match(css, /\.dashboard-signal-grid\s*\{[\s\S]*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 1100px\)[\s\S]*\.dashboard-signal-grid\s*\{\s*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.dashboard-signal-grid\s*\{\s*grid-template-columns:\s*1fr/);
});

test("dashboard cards open tickets with matching preset filters", () => {
  const source = mainSource();
  assert.match(source, /const openTicketsWithPreset = \(preset\) => \{/);
  assert.match(source, /const openTicketsWithStatus = \(status\) => \{/);
  assert.match(source, /setTicketPresetFilter\(preset\)/);
  assert.match(source, /setStatusFilter\(status\)/);
  assert.match(source, /onOpenTicketsStatus=\{openTicketsWithStatus\}/);
  assert.match(source, /onOpenAgent=\{openAgent\}/);
  assert.match(source, /onOpenProject=\{openProject\}/);
  assert.match(source, /ticketMatchesPreset\(ticket, state\?\.runs \|\| \[\], ticketPresetFilter\)/);
  assert.match(source, /if \(preset === "in_flight"\)[\s\S]*ticket\.status === "in_progress"[\s\S]*run\.status === "running"/);
  assert.match(source, /if \(preset === "needs_review"\) return \["human_review", "pr_review"\]\.includes\(ticket\.status\)/);
  assert.match(source, /if \(preset === "unassigned"\) return ticket\.status === "todo" && !ticket\.assigneeAgentId/);
  assert.match(source, /if \(preset === "done"\) return ticket\.status === "done"/);
});

test("dashboard header stays focused on title and new ticket action", () => {
  const source = mainSource();
  assert.match(source, /const isDashboardHome = !selectedTicket && view === "dashboard"/);
  assert.match(source, /\{!isDashboardHome \? <p>\{headerSubtitle\}<\/p> : null\}/);
  assert.match(source, /\{!selectedTicket && !isDashboardHome && <div className="view-switch">/);
  assert.match(source, /\{!isDashboardHome \? <label className="find-box">/);
});

test("dashboard rail shows workload and status meters for scanability", () => {
  const source = mainSource();
  const css = cssSource();
  const dashboardSource = source.slice(source.indexOf("function Dashboard("), source.indexOf("function DashboardMetricCard"));
  assert.match(dashboardSource, /className="workload-row row-link"[\s\S]*onClick=\{\(\) => onOpenAgent\(row\.agent\.id\)\}/);
  assert.match(dashboardSource, /className="workload-row workload-unassigned row-link"[\s\S]*onClick=\{\(\) => onOpenTicketsPreset\("unassigned"\)\}/);
  assert.match(dashboardSource, /className="status-row status-mix-row row-link"[\s\S]*onClick=\{\(\) => onOpenTicketsStatus\(row\.status\)\}/);
  assert.match(dashboardSource, /className="status-row project-queue-row row-link"[\s\S]*onClick=\{\(\) => onOpenProject\(row\.project\.id\)\}/);
  assert.match(source, /className="workload-meter"/);
  assert.match(source, /className="status-meter"/);
  assert.match(source, /row\.review\} review · \{row\.blocked\} blocked/);
  assert.match(source, /row\.share/);
  assert.match(source, /count:\s*openTickets\.filter\(\(ticket\) => ticket\.status === status\)\.length/);
  assert.match(css, /\.workload-meter,[\s\S]*\.status-meter\s*\{/);
  assert.match(css, /\.row-link\s*\{[\s\S]*cursor:\s*pointer/);
  assert.match(css, /\.status-mix-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) 76px auto/);
  assert.match(css, /\.status-row > span\s*\{[\s\S]*display:\s*inline-flex/);
  assert.doesNotMatch(css, /\.status-row span\s*\{[\s\S]*display:\s*inline-flex/);
});
