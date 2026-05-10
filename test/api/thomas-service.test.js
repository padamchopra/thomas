"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { createStateStore } = require("../../src/core/state-store");
const { createThomasService } = require("../../src/core/thomas-service");

function service() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "thomas-service-"));
  return createThomasService({
    store: createStateStore({ dbPath: path.join(tmp, "thomas.db") }),
  });
}

test("tickets can be created without an assignee", () => {
  const thomas = service();
  const project = thomas.createProject({ name: "App", prefix: "APP" });
  const ticket = thomas.createTicket({ projectId: project.id, title: "Triage this later" });

  assert.equal(ticket.id, "APP-1");
  assert.equal(ticket.status, "todo");
  assert.equal(ticket.assigneeAgentId, null);

  const state = thomas.getState();
  assert.equal(state.stats.unassignedTodo, 1);
});

test("tickets expose parent children and blocker relations", () => {
  const thomas = service();
  const project = thomas.createProject({ name: "App", prefix: "APP" });
  const parent = thomas.createTicket({ projectId: project.id, title: "Parent" });
  const child = thomas.createTicket({ projectId: project.id, title: "Child", parentTicketId: parent.id });
  const blocked = thomas.createTicket({
    projectId: project.id,
    title: "Blocked",
    blockedByTicketIds: [child.id],
  });

  const state = thomas.getState();
  const parentState = state.tickets.find((ticket) => ticket.id === parent.id);
  const childState = state.tickets.find((ticket) => ticket.id === child.id);
  const blockedState = state.tickets.find((ticket) => ticket.id === blocked.id);

  assert.deepEqual(parentState.children.map((item) => item.id), [child.id]);
  assert.deepEqual(childState.blocks.map((item) => item.id), [blocked.id]);
  assert.deepEqual(blockedState.blockedBy.map((item) => item.id), [child.id]);
  assert.equal(blockedState.status, "blocked");
});

test("circular blockers are rejected", () => {
  const thomas = service();
  const project = thomas.createProject({ name: "App", prefix: "APP" });
  const first = thomas.createTicket({ projectId: project.id, title: "First" });
  const second = thomas.createTicket({ projectId: project.id, title: "Second", blockedByTicketIds: [first.id] });

  assert.throws(
    () => thomas.setBlockers(first.id, [second.id]),
    /Circular blocker relationship rejected/,
  );
});

test("state is persisted in sqlite tables", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "thomas-sqlite-"));
  const dbPath = path.join(tmp, "thomas.db");
  const thomas = createThomasService({
    store: createStateStore({ dbPath }),
  });

  const project = thomas.createProject({ name: "App", prefix: "APP" });
  thomas.createTicket({ projectId: project.id, title: "Stored in SQLite" });

  assert.equal(fs.existsSync(dbPath), true);
  assert.equal(fs.existsSync(path.join(tmp, "state.json")), false);

  const reloaded = createThomasService({
    store: createStateStore({ dbPath }),
  }).getState();
  assert.equal(reloaded.projects[0].name, "App");
  assert.equal(reloaded.tickets[0].title, "Stored in SQLite");
  assert.equal(reloaded.statePath, dbPath);
});

test("legacy sqlite state is migrated to normalized tables", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "thomas-legacy-db-"));
  const dbPath = path.join(tmp, "thomas.db");
  sqlite(dbPath, `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);
CREATE TABLE projects (name TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE workspaces (project TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (project, name));
CREATE TABLE sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
INSERT INTO settings (id, data) VALUES (1, '{"agentProfiles":{"profiles":{"codex":{"type":"codex","command":"codex"}}}}');
INSERT INTO projects (name, data) VALUES ('app', '{"name":"app","repoPath":"/tmp/app","identifier":"APP","kanbanNextNumber":2,"createdAt":"2026-01-01T00:00:00.000Z"}');
INSERT INTO workspaces (project, name, data) VALUES ('app', 'app-1', '{"name":"app-1","project":"app","status":"active","createdAt":"2026-01-01T00:00:00.000Z","kanban":{"number":1,"title":"Legacy ticket","description":"from old db","assignedAgentProfile":"codex","comments":[{"author":"human","body":"hello","createdAt":"2026-01-02T00:00:00.000Z"}],"createdAt":"2026-01-01T00:00:00.000Z"}}');
`);

  const thomas = createThomasService({
    store: createStateStore({ dbPath }),
  });
  const state = thomas.getState();

  assert.equal(state.projects[0].name, "app");
  assert.equal(state.projects[0].repoPath, "/tmp/app");
  assert.equal(state.tickets[0].id, "APP-1");
  assert.equal(state.tickets[0].title, "Legacy ticket");
  assert.equal(state.tickets[0].comments[0].body, "hello");
  assert.equal(state.tickets[0].assigneeAgentId, "agent-codex");

  const columns = sqliteJson(dbPath, "PRAGMA table_info(projects);").map((row) => row.name);
  assert.equal(columns.includes("id"), true);
  assert.equal(columns.includes("data"), false);
  assert.equal(fs.readdirSync(tmp).some((name) => name.includes(".legacy-") && name.endsWith(".bak")), true);
});

test("interrupted in-progress tickets are recovered to human review", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "thomas-service-"));
  const service = createThomasService({
    store: createStateStore({ dbPath: path.join(tmp, "state.db") }),
  });
  const project = service.createProject({ name: "App", prefix: "APP" });
  const ticket = service.createTicket({ projectId: project.id, title: "Lost run", status: "in_progress" }, "agent");

  assert.equal(service.recoverInterruptedRuns(), 1);
  const recovered = service.getState().tickets.find((item) => item.id === ticket.id);
  assert.equal(recovered.status, "human_review");
  assert.equal(recovered.comments.at(-1).author, "agent");
  assert.equal(recovered.comments.at(-1).metadata.type, "agent_run_interrupted");
  assert.equal(service.recoverInterruptedRuns(), 0);
});

function sqlite(dbPath, sql) {
  const result = spawnSync("sqlite3", [dbPath], { input: sql, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function sqliteJson(dbPath, sql) {
  const result = spawnSync("sqlite3", ["-json", dbPath, sql], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout || "[]");
}
