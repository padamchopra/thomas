"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function defaultHome() {
  return process.env.THOMAS_HOME || process.env.THOMAS_CLI_HOME || path.join(os.homedir(), ".thomas");
}

function defaultStatePath(home = defaultHome()) {
  return process.env.THOMAS_DB_PATH || process.env.THOMAS_STATE_PATH || path.join(home, "thomas.db");
}

function createStateStore(options = {}) {
  const dbPath = options.dbPath || options.statePath || defaultStatePath(options.home);

  return {
    path: dbPath,
    load() {
      ensureStateDb(dbPath);
      return normalizeState(readState(dbPath));
    },
    save(state) {
      ensureStateDb(dbPath);
      const normalized = normalizeState(state);
      writeState(dbPath, normalized);
      return normalized;
    },
  };
}

function defaultState() {
  const now = new Date().toISOString();
  return {
    version: 2,
    createdAt: now,
    updatedAt: now,
    counters: {
      activity: 1,
      agent: 1,
      comment: 1,
      project: 1,
      ticket: 1,
    },
    projects: [],
    agents: [
      {
        id: "agent-claude",
        name: "Claude",
        type: "claude",
        command: "claude",
        status: "available",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "agent-codex",
        name: "Codex",
        type: "codex",
        command: "codex",
        status: "available",
        createdAt: now,
        updatedAt: now,
      },
    ],
    tickets: [],
    comments: [],
    activity: [],
    settings: {
      theme: "system",
      notifyHumanReview: false,
      preferredTerminal: "warp",
      branchPrefix: "thomas",
    },
  };
}

function ensureStateDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  if (!hasCommand("sqlite3")) {
    throw new Error("Missing sqlite3. Install SQLite to use Thomas state.");
  }
  if (isLegacyStateDb(dbPath)) {
    const migrated = readLegacyState(dbPath);
    backupLegacyDb(dbPath);
    dropLegacySchema(dbPath);
    createSchema(dbPath);
    writeState(dbPath, migrated, { skipEnsure: true });
    return;
  }
  createSchema(dbPath);
  ensureColumn(dbPath, "projects", "setup_script", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(dbPath, "comments", "metadata", "TEXT NOT NULL DEFAULT '{}'");
}

function createSchema(dbPath) {
  sqliteExec(dbPath, `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  repo_path TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  setup_script TEXT NOT NULL DEFAULT '',
  next_ticket_number INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  command TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'available',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  assignee_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  parent_ticket_id TEXT REFERENCES tickets(id) ON DELETE SET NULL,
  workspace_id TEXT,
  pr_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ticket_blockers (
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  blocker_ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  PRIMARY KEY (ticket_id, blocker_ticket_id)
);
CREATE TABLE IF NOT EXISTS ticket_labels (
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  PRIMARY KEY (ticket_id, label)
);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  subject TEXT,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tickets_project_index ON tickets(project_id);
CREATE INDEX IF NOT EXISTS tickets_assignee_index ON tickets(assignee_agent_id);
CREATE INDEX IF NOT EXISTS comments_ticket_index ON comments(ticket_id);
CREATE INDEX IF NOT EXISTS activity_created_at_index ON activity(created_at);
`);
}

function readState(dbPath) {
  const state = defaultState();
  const metaRows = sqliteJson(dbPath, "SELECT key, value FROM meta;");
  const meta = Object.fromEntries(metaRows.map((row) => [row.key, row.value]));
  if (meta.version) state.version = Number.parseInt(meta.version, 10) || state.version;
  if (meta.created_at) state.createdAt = meta.created_at;
  if (meta.updated_at) state.updatedAt = meta.updated_at;
  if (meta.settings) state.settings = parseJson(meta.settings, state.settings);

  const counterRows = sqliteJson(dbPath, "SELECT name, value FROM counters;");
  for (const row of counterRows) {
    state.counters[row.name] = Number.parseInt(row.value, 10) || 1;
  }

  const projects = sqliteJson(dbPath, `
SELECT
  id,
  name,
  prefix,
  repo_path AS repoPath,
  description,
  setup_script AS setupScript,
  next_ticket_number AS nextTicketNumber,
  created_at AS createdAt,
  updated_at AS updatedAt
FROM projects
ORDER BY name;
`);
  state.projects = projects.map((project) => ({
    ...project,
    nextTicketNumber: Number.parseInt(project.nextTicketNumber, 10) || 1,
  }));

  const agents = sqliteJson(dbPath, `
SELECT
  id,
  name,
  type,
  command,
  status,
  created_at AS createdAt,
  updated_at AS updatedAt
FROM agents
ORDER BY name;
`);
  state.agents = agents.length > 0 ? agents : state.agents;

  const blockerRows = sqliteJson(dbPath, "SELECT ticket_id AS ticketId, blocker_ticket_id AS blockerTicketId FROM ticket_blockers ORDER BY ticket_id, blocker_ticket_id;");
  const blockersByTicket = groupRows(blockerRows, "ticketId", "blockerTicketId");
  const labelRows = sqliteJson(dbPath, "SELECT ticket_id AS ticketId, label FROM ticket_labels ORDER BY ticket_id, label;");
  const labelsByTicket = groupRows(labelRows, "ticketId", "label");

  state.tickets = sqliteJson(dbPath, `
SELECT
  id,
  number,
  project_id AS projectId,
  title,
  description,
  status,
  priority,
  assignee_agent_id AS assigneeAgentId,
  parent_ticket_id AS parentTicketId,
  workspace_id AS workspaceId,
  pr_url AS prUrl,
  created_at AS createdAt,
  updated_at AS updatedAt
FROM tickets
ORDER BY project_id, number;
`).map((ticket) => ({
    ...ticket,
    number: Number.parseInt(ticket.number, 10) || 0,
    assigneeAgentId: ticket.assigneeAgentId || null,
    parentTicketId: ticket.parentTicketId || null,
    workspaceId: ticket.workspaceId || null,
    prUrl: ticket.prUrl || null,
    blockedByTicketIds: blockersByTicket.get(ticket.id) || [],
    labels: labelsByTicket.get(ticket.id) || [],
  }));

  state.comments = sqliteJson(dbPath, `
SELECT
  id,
  ticket_id AS ticketId,
  author,
  body,
  metadata,
  created_at AS createdAt,
  updated_at AS updatedAt
FROM comments
ORDER BY created_at;
`).map((comment) => ({
    ...comment,
    metadata: parseJson(comment.metadata, {}),
  }));

  state.activity = sqliteJson(dbPath, `
SELECT
  id,
  type,
  actor,
  subject,
  details,
  created_at AS createdAt
FROM activity
ORDER BY created_at;
`).map((event) => ({
    ...event,
    subject: event.subject || null,
    details: parseJson(event.details, {}),
  }));

  return state;
}

function writeState(dbPath, state, options = {}) {
  if (!options.skipEnsure) ensureStateDb(dbPath);
  const statements = [
    "PRAGMA foreign_keys = OFF;",
    "BEGIN IMMEDIATE;",
    "DELETE FROM activity;",
    "DELETE FROM comments;",
    "DELETE FROM ticket_labels;",
    "DELETE FROM ticket_blockers;",
    "DELETE FROM tickets;",
    "DELETE FROM agents;",
    "DELETE FROM projects;",
    "DELETE FROM counters;",
    "DELETE FROM meta;",
    `INSERT INTO meta (key, value) VALUES ('version', ${sqlValue(String(state.version || 2))});`,
    `INSERT INTO meta (key, value) VALUES ('created_at', ${sqlValue(state.createdAt || new Date().toISOString())});`,
    `INSERT INTO meta (key, value) VALUES ('updated_at', ${sqlValue(state.updatedAt || new Date().toISOString())});`,
    `INSERT INTO meta (key, value) VALUES ('settings', ${sqlValue(JSON.stringify(state.settings || defaultState().settings))});`,
  ];

  for (const [name, value] of Object.entries(state.counters || {})) {
    statements.push(`INSERT INTO counters (name, value) VALUES (${sqlValue(name)}, ${sqlNumber(value)});`);
  }

  for (const project of state.projects) {
    statements.push(`INSERT INTO projects (
      id, name, prefix, repo_path, description, setup_script, next_ticket_number, created_at, updated_at
    ) VALUES (
      ${sqlValue(project.id)},
      ${sqlValue(project.name)},
      ${sqlValue(project.prefix)},
      ${sqlValue(project.repoPath || "")},
      ${sqlValue(project.description || "")},
      ${sqlValue(project.setupScript || "")},
      ${sqlNumber(project.nextTicketNumber || 1)},
      ${sqlValue(project.createdAt)},
      ${sqlValue(project.updatedAt)}
    );`);
  }

  for (const agent of state.agents) {
    statements.push(`INSERT INTO agents (
      id, name, type, command, status, created_at, updated_at
    ) VALUES (
      ${sqlValue(agent.id)},
      ${sqlValue(agent.name)},
      ${sqlValue(agent.type || "custom")},
      ${sqlValue(agent.command || "")},
      ${sqlValue(agent.status || "available")},
      ${sqlValue(agent.createdAt)},
      ${sqlValue(agent.updatedAt)}
    );`);
  }

  for (const ticket of state.tickets) {
    statements.push(`INSERT INTO tickets (
      id, number, project_id, title, description, status, priority, assignee_agent_id,
      parent_ticket_id, workspace_id, pr_url, created_at, updated_at
    ) VALUES (
      ${sqlValue(ticket.id)},
      ${sqlNumber(ticket.number)},
      ${sqlValue(ticket.projectId)},
      ${sqlValue(ticket.title)},
      ${sqlValue(ticket.description || "")},
      ${sqlValue(ticket.status)},
      ${sqlValue(ticket.priority)},
      ${sqlNullable(ticket.assigneeAgentId)},
      ${sqlNullable(ticket.parentTicketId)},
      ${sqlNullable(ticket.workspaceId)},
      ${sqlNullable(ticket.prUrl)},
      ${sqlValue(ticket.createdAt)},
      ${sqlValue(ticket.updatedAt)}
    );`);
    for (const blockerId of ticket.blockedByTicketIds || []) {
      statements.push(`INSERT INTO ticket_blockers (ticket_id, blocker_ticket_id) VALUES (${sqlValue(ticket.id)}, ${sqlValue(blockerId)});`);
    }
    for (const label of ticket.labels || []) {
      statements.push(`INSERT INTO ticket_labels (ticket_id, label) VALUES (${sqlValue(ticket.id)}, ${sqlValue(label)});`);
    }
  }

  for (const comment of state.comments) {
    statements.push(`INSERT INTO comments (
      id, ticket_id, author, body, metadata, created_at, updated_at
    ) VALUES (
      ${sqlValue(comment.id)},
      ${sqlValue(comment.ticketId)},
      ${sqlValue(comment.author || "api")},
      ${sqlValue(comment.body || "")},
      ${sqlValue(JSON.stringify(comment.metadata || {}))},
      ${sqlValue(comment.createdAt)},
      ${sqlValue(comment.updatedAt)}
    );`);
  }

  for (const event of state.activity) {
    statements.push(`INSERT INTO activity (
      id, type, actor, subject, details, created_at
    ) VALUES (
      ${sqlValue(event.id)},
      ${sqlValue(event.type)},
      ${sqlValue(event.actor || "api")},
      ${sqlNullable(event.subject)},
      ${sqlValue(JSON.stringify(event.details || {}))},
      ${sqlValue(event.createdAt)}
    );`);
  }

  statements.push("COMMIT;");
  statements.push("PRAGMA foreign_keys = ON;");
  sqliteExec(dbPath, statements.join("\n"));
}

function isLegacyStateDb(dbPath) {
  if (!fs.existsSync(dbPath)) return false;
  const columns = tableColumns(dbPath, "projects");
  return columns.includes("data") && columns.includes("name") && !columns.includes("id");
}

function tableColumns(dbPath, tableName) {
  try {
    return sqliteJson(dbPath, `PRAGMA table_info(${tableName});`).map((row) => row.name);
  } catch {
    return [];
  }
}

function readLegacyState(dbPath) {
  const state = defaultState();
  const projectIdByName = new Map();
  const now = new Date().toISOString();
  const legacySettings = parseJson(sqliteJson(dbPath, "SELECT data FROM settings WHERE id = 1;")[0]?.data || "{}", {});

  state.agents = legacyAgents(legacySettings, now);
  state.counters.agent = nextNumericCounter(state.agents, "agent");

  for (const row of sqliteJson(dbPath, "SELECT name, data FROM projects ORDER BY name;")) {
    const legacy = parseJson(row.data, {});
    const id = nextId(state, "project", "project");
    const project = {
      id,
      name: legacy.name || row.name,
      prefix: normalizePrefix(legacy.identifier || row.name),
      repoPath: legacy.repoPath || "",
      description: "",
      setupScript: legacy.setupScript?.content || legacy.setupScript || "",
      nextTicketNumber: Math.max(Number.parseInt(legacy.kanbanNextNumber || "1", 10) || 1, 1),
      createdAt: legacy.createdAt || now,
      updatedAt: legacy.updatedAt || legacy.createdAt || now,
    };
    state.projects.push(project);
    projectIdByName.set(row.name, id);
  }

  for (const row of sqliteJson(dbPath, "SELECT project, name, data FROM workspaces ORDER BY project, name;")) {
    const workspace = parseJson(row.data, {});
    if (!workspace.kanban) continue;
    const projectId = projectIdByName.get(row.project);
    const project = state.projects.find((item) => item.id === projectId);
    if (!project) continue;
    const kanban = workspace.kanban || {};
    const number = Number.parseInt(kanban.number || "0", 10) || project.nextTicketNumber;
    project.nextTicketNumber = Math.max(project.nextTicketNumber, number + 1);
    const ticketId = `${project.prefix}-${number}`;
    const createdAt = kanban.createdAt || workspace.createdAt || now;
    const updatedAt = kanban.updatedAt || workspace.updatedAt || createdAt;
    state.tickets.push({
      id: ticketId,
      number,
      projectId,
      title: kanban.title || ticketId,
      description: kanban.description || "",
      status: legacyStatus(kanban.status || workspace.status),
      priority: "medium",
      assigneeAgentId: kanban.assignedAgentProfile ? legacyAgentId(kanban.assignedAgentProfile) : null,
      parentTicketId: null,
      blockedByTicketIds: [],
      labels: [],
      workspaceId: row.name,
      prUrl: workspace.prUrl || null,
      createdAt,
      updatedAt,
    });
    for (const comment of Array.isArray(kanban.comments) ? kanban.comments : []) {
      state.comments.push({
        id: nextId(state, "comment", "comment"),
        ticketId,
        author: comment.author || "system",
        body: comment.body || "",
        metadata: comment.metadata || {},
        createdAt: comment.createdAt || updatedAt,
        updatedAt: comment.updatedAt || comment.createdAt || updatedAt,
      });
    }
  }

  for (const project of state.projects) {
    project.nextTicketNumber = Math.max(project.nextTicketNumber, nextTicketNumberForProject(state, project.id));
  }
  state.counters.ticket = Math.max(state.counters.ticket, state.tickets.length + 1);
  state.updatedAt = now;
  return normalizeState(state);
}

function legacyAgents(legacySettings, now) {
  const profiles = legacySettings?.agentProfiles?.profiles || {};
  const agents = [];
  for (const [name, profile] of Object.entries(profiles)) {
    agents.push({
      id: legacyAgentId(name),
      name: displayName(name),
      type: profile.type || name,
      command: profile.command || name,
      status: "available",
      createdAt: now,
      updatedAt: now,
    });
  }
  if (!agents.some((agent) => agent.id === "agent-claude")) {
    agents.push({ id: "agent-claude", name: "Claude", type: "claude", command: "claude", status: "available", createdAt: now, updatedAt: now });
  }
  if (!agents.some((agent) => agent.id === "agent-codex")) {
    agents.push({ id: "agent-codex", name: "Codex", type: "codex", command: "codex", status: "available", createdAt: now, updatedAt: now });
  }
  return agents;
}

function legacyStatus(value) {
  const normalized = String(value || "").toLowerCase().replace(/[-\s]+/g, "_");
  if (normalized === "to_do" || normalized === "active") return "todo";
  if (normalized === "in_progress" || normalized === "running") return "in_progress";
  if (normalized === "human_review" || normalized === "blocked") return "human_review";
  if (normalized === "pr_review") return "pr_review";
  if (normalized === "done" || normalized === "merged") return "done";
  if (normalized === "removed" || normalized === "cancelled") return "cancelled";
  return "todo";
}

function legacyAgentId(name) {
  return `agent-${String(name || "agent").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent"}`;
}

function displayName(value) {
  return String(value || "")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ") || "Agent";
}

function nextNumericCounter(items, prefix) {
  return items.reduce((max, item) => {
    const match = String(item.id || "").match(new RegExp(`^${prefix}-(\\d+)$`));
    return Math.max(max, match ? Number.parseInt(match[1], 10) + 1 : 1);
  }, 1);
}

function nextId(state, counter, prefix) {
  const value = state.counters[counter] || 1;
  state.counters[counter] = value + 1;
  return `${prefix}-${value}`;
}

function normalizePrefix(value) {
  const prefix = String(value || "PROJ").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!prefix) return "PROJ";
  return /^[A-Z]/.test(prefix) ? prefix : `P${prefix}`;
}

function nextTicketNumberForProject(state, projectId) {
  return state.tickets
    .filter((ticket) => ticket.projectId === projectId)
    .reduce((max, ticket) => Math.max(max, Number.parseInt(ticket.number, 10) + 1 || 1), 1);
}

function backupLegacyDb(dbPath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.copyFileSync(dbPath, `${dbPath}.legacy-${stamp}.bak`);
}

function dropLegacySchema(dbPath) {
  sqliteExec(dbPath, `
PRAGMA foreign_keys = OFF;
DROP TABLE IF EXISTS meta;
DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS workspaces;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS counters;
DROP TABLE IF EXISTS agents;
DROP TABLE IF EXISTS tickets;
DROP TABLE IF EXISTS ticket_blockers;
DROP TABLE IF EXISTS ticket_labels;
DROP TABLE IF EXISTS comments;
DROP TABLE IF EXISTS activity;
PRAGMA foreign_keys = ON;
`);
}

function normalizeState(state) {
  const base = defaultState();
  const next = {
    ...base,
    ...state,
    counters: { ...base.counters, ...(state && state.counters ? state.counters : {}) },
    settings: normalizeSettings({ ...base.settings, ...(state?.settings || {}) }),
    projects: Array.isArray(state?.projects) ? state.projects : [],
    agents: Array.isArray(state?.agents) && state.agents.length > 0 ? state.agents : base.agents,
    tickets: Array.isArray(state?.tickets) ? state.tickets : [],
    comments: Array.isArray(state?.comments) ? state.comments : [],
    activity: Array.isArray(state?.activity) ? state.activity : [],
  };

  for (const project of next.projects) {
    project.prefix = String(project.prefix || project.name || "PROJ")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .replace(/^[0-9]/, "P$&") || "PROJ";
    project.repoPath = project.repoPath || "";
    project.description = project.description || "";
    project.setupScript = project.setupScript || "";
    project.nextTicketNumber = Math.max(Number(project.nextTicketNumber || 1), 1);
  }

  for (const ticket of next.tickets) {
    ticket.blockedByTicketIds = Array.isArray(ticket.blockedByTicketIds) ? ticket.blockedByTicketIds : [];
    ticket.labels = Array.isArray(ticket.labels) ? ticket.labels : [];
    ticket.assigneeAgentId = ticket.assigneeAgentId || null;
    ticket.parentTicketId = ticket.parentTicketId || null;
    ticket.workspaceId = ticket.workspaceId || null;
    ticket.prUrl = ticket.prUrl || null;
  }

  for (const agent of next.agents) {
    agent.command = agent.command || "";
    agent.status = agent.status || "available";
  }

  for (const comment of next.comments) {
    comment.metadata = comment.metadata && typeof comment.metadata === "object" ? comment.metadata : {};
  }

  return next;
}

function normalizeSettings(settings) {
  const theme = ["system", "dark", "light"].includes(settings.theme) ? settings.theme : "system";
  const preferredTerminal = ["warp", "terminal", "iterm", "system"].includes(settings.preferredTerminal) ? settings.preferredTerminal : "warp";
  return {
    theme,
    notifyHumanReview: settings.notifyHumanReview === true,
    preferredTerminal,
    branchPrefix: normalizeBranchPrefix(settings.branchPrefix),
  };
}

function normalizeBranchPrefix(value) {
  const prefix = String(value || "thomas")
    .trim()
    .toLowerCase()
    .split("/")
    .map((part) => part
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "")
      .replace(/-+/g, "-"))
    .filter(Boolean)
    .join("/");
  return prefix || "thomas";
}

function groupRows(rows, keyField, valueField) {
  const result = new Map();
  for (const row of rows) {
    if (!result.has(row[keyField])) result.set(row[keyField], []);
    result.get(row[keyField]).push(row[valueField]);
  }
  return result;
}

function hasCommand(command) {
  const result = spawnSync("which", [command], { stdio: "ignore" });
  return result.status === 0;
}

function sqliteExec(dbPath, sql) {
  const result = spawnSync("sqlite3", [dbPath], {
    input: sql,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`SQLite state error: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout;
}

function sqliteJson(dbPath, sql) {
  const result = spawnSync("sqlite3", ["-json", dbPath, sql], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`SQLite state error: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return parseJson(result.stdout || "[]", []);
}

function ensureColumn(dbPath, tableName, columnName, definition) {
  const columns = sqliteJson(dbPath, `PRAGMA table_info(${tableName});`);
  if (columns.some((column) => column.name === columnName)) return;
  sqliteExec(dbPath, `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition};`);
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function sqlNullable(value) {
  return value === null || value === undefined || value === "" ? "NULL" : sqlValue(value);
}

function sqlNumber(value) {
  const number = Number.parseInt(value, 10);
  return Number.isInteger(number) ? String(number) : "0";
}

function sqlValue(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

module.exports = {
  createStateStore,
  defaultHome,
  defaultState,
  defaultStatePath,
  normalizeState,
};
