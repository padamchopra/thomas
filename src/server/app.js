"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { URL } = require("node:url");
const { createThomasService } = require("../core/thomas-service");
const { createAgentRunner } = require("./agent-runner");
const { defaultRunLogRoot, defaultWorktreeRoot, isGitRoot, resolveTicketWorkspace } = require("./workspace");
const PACKAGE = require("../../package.json");

function createApp(options = {}) {
  const service = options.service || createThomasService(options);
  const workspaceRoot = options.workspaceRoot;
  const runLogRoot = options.runLogRoot;
  const runner = options.runner || createAgentRunner(service, { workspaceRoot, runLogRoot });
  const prSyncer = createPrSyncer(service, runner, options);
  const systemActions = options.systemActions || {};
  const uiDist = options.uiDist || path.resolve(__dirname, "..", "..", "ui", "dist");
  const uiIndex = path.join(uiDist, "index.html");

  return async function app(req, res) {
    try {
      const requestUrl = new URL(req.url || "/", "http://localhost");
      if (requestUrl.pathname.startsWith("/api/")) {
        await handleApi(service, runner, req, res, requestUrl, { workspaceRoot, systemActions, prSyncer });
        return;
      }
      await serveUi(req, res, requestUrl, uiDist, uiIndex);
    } catch (error) {
      sendJson(res, error.status || 500, { ok: false, error: error.message || "Internal server error" });
    }
  };
}

function createHttpServer(options = {}) {
  return http.createServer(createApp(options));
}

async function handleApi(service, runner, req, res, requestUrl, options = {}) {
  const method = req.method || "GET";
  const parts = requestUrl.pathname.split("/").filter(Boolean).slice(1);
  const actor = req.headers["x-thomas-actor"] || "api";

  if (method === "GET" && parts.length === 1 && parts[0] === "state") {
    options.prSyncer?.maybeSync();
    sendJson(res, 200, { ok: true, state: stateWithRuns(service, runner, options) });
    return;
  }

  if (method === "GET" && parts.length === 1 && parts[0] === "tickets") {
    options.prSyncer?.maybeSync();
    const state = stateWithRuns(service, runner, options);
    sendJson(res, 200, { ok: true, tickets: filterTickets(state.tickets, requestUrl.searchParams), state });
    return;
  }

  if (method === "POST" && parts.length === 1 && parts[0] === "tickets") {
    const ticket = service.createTicket(await readJson(req), actor);
    sendJson(res, 201, { ok: true, ticket, state: stateWithRuns(service, runner, options) });
    return;
  }

  if (method === "PATCH" && parts.length === 2 && parts[0] === "tickets") {
    const ticket = updateTicketAndCleanup(service, runner, parts[1], await readJson(req), actor, options);
    sendJson(res, 200, { ok: true, ticket, state: stateWithRuns(service, runner, options) });
    return;
  }

  if (method === "POST" && parts.length === 3 && parts[0] === "tickets" && parts[2] === "comments") {
    const body = await readJson(req);
    const beforeTicket = service.getState().tickets.find((item) => item.id === parts[1]);
    const comment = service.addComment(parts[1], body, actor);
    let run = null;
    if (shouldDispatchAfterComment(beforeTicket, body, actor, runner)) {
      run = runner.dispatch(parts[1], { message: body.body || "", resume: true });
    }
    sendJson(res, 201, { ok: true, comment, run: sanitizeRun(run), state: stateWithRuns(service, runner, options) });
    return;
  }

  if (method === "POST" && parts.length === 3 && parts[0] === "tickets" && parts[2] === "dispatch") {
    const run = runner.dispatch(parts[1], await readJson(req));
    sendJson(res, 202, { ok: true, run, state: stateWithRuns(service, runner, options) });
    return;
  }

  if (method === "POST" && parts.length === 3 && parts[0] === "tickets" && parts[2] === "stop") {
    const run = runner.stop(parts[1]);
    sendJson(res, 200, { ok: true, run, state: stateWithRuns(service, runner, options) });
    return;
  }

  if (method === "GET" && parts.length === 3 && parts[0] === "tickets" && parts[2] === "diff") {
    sendJson(res, 200, { ok: true, diff: ticketDiff(service, parts[1], options) });
    return;
  }

  if (method === "POST" && parts.length === 3 && parts[0] === "tickets" && parts[2] === "open-file") {
    const body = await readJson(req);
    sendJson(res, 200, { ok: true, opened: openProjectFile(service, parts[1], body.filePath || "", options) });
    return;
  }

  if (method === "POST" && parts.length === 3 && parts[0] === "tickets" && parts[2] === "open-worktree") {
    sendJson(res, 200, { ok: true, opened: openTicketWorktree(service, parts[1], options) });
    return;
  }

  if (method === "POST" && parts.length === 3 && parts[0] === "tickets" && parts[2] === "resume-terminal") {
    sendJson(res, 200, { ok: true, opened: openResumeTerminal(service, parts[1], options) });
    return;
  }

  if (method === "POST" && parts.length === 3 && parts[0] === "tickets" && parts[2] === "assign") {
    const body = await readJson(req);
    const ticket = service.assignTicket(parts[1], body.assigneeAgentId || body.agentId || null, actor);
    sendJson(res, 200, { ok: true, ticket, state: stateWithRuns(service, runner, options) });
    return;
  }

  if (method === "POST" && parts.length === 3 && parts[0] === "tickets" && parts[2] === "blockers") {
    const body = await readJson(req);
    const ticket = service.setBlockers(parts[1], body.blockedByTicketIds || [], actor);
    sendJson(res, 200, { ok: true, ticket, state: stateWithRuns(service, runner, options) });
    return;
  }

  if (method === "PATCH" && parts.length === 1 && parts[0] === "settings") {
    const settings = service.updateSettings(await readJson(req), actor);
    sendJson(res, 200, { ok: true, settings, state: stateWithRuns(service, runner, options) });
    return;
  }

  if (method === "GET" && parts.length === 1 && parts[0] === "projects") {
    sendJson(res, 200, { ok: true, projects: service.getState().projects });
    return;
  }

  if (method === "POST" && parts.length === 1 && parts[0] === "projects") {
    const project = service.createProject(await readJson(req), actor);
    sendJson(res, 201, { ok: true, project, state: stateWithRuns(service, runner, options) });
    return;
  }

  if (method === "POST" && parts.length === 2 && parts[0] === "projects" && parts[1] === "choose-folder") {
    const repoPath = chooseFolder();
    sendJson(res, 200, { ok: true, repoPath });
    return;
  }

  if (method === "GET" && parts.length === 1 && parts[0] === "agents") {
    sendJson(res, 200, { ok: true, agents: service.getState().agents });
    return;
  }

  if (method === "POST" && parts.length === 1 && parts[0] === "agents") {
    const agent = service.createAgent(await readJson(req), actor);
    sendJson(res, 201, { ok: true, agent, state: stateWithRuns(service, runner, options) });
    return;
  }

  sendJson(res, 404, { ok: false, error: "API route not found" });
}

function stateWithRuns(service, runner, options) {
  const state = service.getState();
  return { ...state, appVersion: PACKAGE.version, cache: cacheInfo(options), runs: runner.getRuns() };
}

function cacheInfo(options = {}) {
  const paths = [options.workspaceRoot || defaultWorktreeRoot(), options.runLogRoot || defaultRunLogRoot()];
  const entries = paths.map((targetPath) => ({
    path: targetPath,
    bytes: directorySize(targetPath),
  }));
  return {
    bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
    entries,
  };
}

function directorySize(targetPath) {
  let total = 0;
  const visit = (current) => {
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return;
    }
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
      total += stat.size;
      return;
    }
    if (!stat.isDirectory()) return;
    let entries = [];
    try {
      entries = fs.readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) visit(path.join(current, entry));
  };
  visit(targetPath);
  return total;
}

function createPrSyncer(service, runner, options = {}) {
  if (options.prSync === false) {
    return { maybeSync: () => [] };
  }
  const intervalMs = Number.isFinite(options.prSyncIntervalMs) ? options.prSyncIntervalMs : 60000;
  const checkPullRequestStatus = options.checkPullRequestStatus || defaultCheckPullRequestStatus;
  let lastSyncAt = 0;
  return {
    maybeSync() {
      const now = Date.now();
      if (lastSyncAt && now - lastSyncAt < intervalMs) return [];
      lastSyncAt = now;
      return syncMergedPullRequests(service, runner, checkPullRequestStatus, options);
    },
  };
}

function syncMergedPullRequests(service, runner, checkPullRequestStatus, options = {}) {
  const state = service.getState();
  const candidates = state.tickets.filter((ticket) => ticket.status === "pr_review" && ticket.prUrl);
  const updated = [];
  for (const ticket of candidates) {
    const result = checkPullRequestStatus(ticket.prUrl, ticket.project?.repoPath || "");
    if (String(result?.state || "").toUpperCase() !== "MERGED") continue;
    updateTicketAndCleanup(service, runner, ticket.id, { status: "done" }, "agent", options, ticket);
    updated.push(ticket.id);
  }
  return updated;
}

function defaultCheckPullRequestStatus(prUrl, repoPath) {
  const result = spawnSync("gh", ["pr", "view", prUrl, "--json", "state,mergedAt,url,title"], {
    cwd: repoPath || process.cwd(),
    encoding: "utf8",
    timeout: 15000,
  });
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout || "{}");
  } catch {
    return null;
  }
}

function updateTicketAndCleanup(service, runner, ticketId, input, actor, options = {}, beforeTicket = null) {
  const before = beforeTicket || service.getState().tickets.find((item) => item.id === ticketId);
  const ticket = service.updateTicket(ticketId, input, actor);
  if (ticket.status === "done") {
    cleanupDoneTicketArtifacts(before, runner, options);
  }
  return ticket;
}

function cleanupDoneTicketArtifacts(ticket, runner, options = {}) {
  if (!ticket) return { worktree: null, logs: [] };
  const deleted = { worktree: null, logs: [] };
  const artifactPath = resolveTicketArtifactPath(ticket, options);
  if (artifactPath) {
    deleted.worktree = removeWorktree(artifactPath, ticket.project?.repoPath || "");
  } else {
    const resolved = resolveTicketWorkspace(ticket, options);
    if (resolved.source === "worktree" && resolved.path) {
      deleted.worktree = removeWorktree(resolved.path, resolved.projectPath);
    }
  }
  if (runner?.cleanupTicketRuns) {
    deleted.logs = runner.cleanupTicketRuns(ticket.id);
  }
  return deleted;
}

function resolveTicketArtifactPath(ticket, options = {}) {
  const workspaceId = ticket.workspaceId || ticket.id?.toLowerCase();
  if (!workspaceId) return "";
  const worktreeRoot = options.workspaceRoot || defaultWorktreeRoot();
  const candidates = [];
  if (ticket.project?.name) candidates.push(path.join(worktreeRoot, ticket.project.name, workspaceId));
  if (ticket.projectId) candidates.push(path.join(worktreeRoot, ticket.projectId, workspaceId));
  candidates.push(path.join(worktreeRoot, workspaceId));
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const resolved = path.resolve(candidate);
    const root = path.resolve(worktreeRoot);
    if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) continue;
    return resolved;
  }
  return "";
}

function removeWorktree(worktreePath, projectPath) {
  const target = path.resolve(worktreePath);
  const project = projectPath ? path.resolve(projectPath) : "";
  if (!target || (project && target === project)) return null;
  if (!fs.existsSync(target)) return null;
  if (project && isGitRoot(project)) {
    const result = spawnSync("git", ["worktree", "remove", "--force", target], {
      cwd: project,
      encoding: "utf8",
      timeout: 30000,
    });
    if (result.status === 0 || !fs.existsSync(target)) return target;
  }
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    pruneEmptyParents(path.dirname(target), optionsWorktreeRoot(target));
    return target;
  } catch {
    return null;
  }
}

function optionsWorktreeRoot(target) {
  const parts = path.resolve(target).split(path.sep);
  const index = parts.lastIndexOf("worktrees");
  return index >= 0 ? parts.slice(0, index + 1).join(path.sep) || path.sep : path.dirname(target);
}

function pruneEmptyParents(start, stop) {
  let current = path.resolve(start);
  const root = path.resolve(stop);
  while (current.startsWith(root) && current !== root) {
    try {
      fs.rmdirSync(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

function shouldDispatchAfterComment(ticket, body, actor, runner) {
  if (!ticket || !["human_review", "pr_review"].includes(ticket.status)) return false;
  if (!ticket.assigneeAgentId) return false;
  const author = String(body?.author || actor || "").trim().toLowerCase();
  if (!["ui", "you", "human"].includes(author)) return false;
  return !runner.getRuns().some((run) => run.ticketId === ticket.id && run.status === "running");
}

function sanitizeRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    ticketId: run.ticketId,
    agentId: run.agentId,
    agentName: run.agentName,
    status: run.status,
    command: run.command,
    cwd: run.cwd,
    startedAt: run.startedAt,
  };
}

function chooseFolder() {
  if (process.platform !== "darwin") {
    const error = new Error("Folder browsing is currently implemented with the macOS folder picker.");
    error.status = 501;
    throw error;
  }
  const script = [
    'set selectedFolder to choose folder with prompt "Choose a project repository folder"',
    "POSIX path of selectedFolder",
  ].join("\n");
  const result = spawnSync("osascript", ["-e", script], {
    encoding: "utf8",
    timeout: 120000,
  });
  if (result.status !== 0) {
    const message = String(result.stderr || result.stdout || "").trim();
    const error = new Error(message.includes("User canceled") ? "Folder selection cancelled." : `Could not open folder picker: ${message || result.error?.message || "unknown error"}`);
    error.status = message.includes("User canceled") ? 400 : 500;
    throw error;
  }
  return result.stdout.trim().replace(/\/$/, "");
}

function filterTickets(tickets, params) {
  return tickets.filter((ticket) => {
    if (params.get("status") && !params.get("status").split(",").includes(ticket.status)) return false;
    if (params.get("projectId") && ticket.projectId !== params.get("projectId")) return false;
    if (params.get("assigneeAgentId") && ticket.assigneeAgentId !== params.get("assigneeAgentId")) return false;
    return true;
  });
}

function ticketDiff(service, ticketId, options = {}) {
  const { ticket, repoPath, workspaceSource } = ticketRepository(service, ticketId, options);
  const result = spawnSync("git", ["diff", "--no-ext-diff", "--unified=80", "--", "."], {
    cwd: repoPath,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: 10000,
  });
  if (result.status !== 0) {
    const error = new Error(result.stderr.trim() || "Could not read git diff.");
    error.status = 500;
    throw error;
  }
  return {
    ticketId: ticket.id,
    projectId: ticket.projectId,
    repoPath,
    workspaceSource,
    generatedAt: new Date().toISOString(),
    tree: projectTree(repoPath, result.stdout || ""),
    files: parseUnifiedDiff(result.stdout || ""),
  };
}

function ticketRepository(service, ticketId, options = {}) {
  const state = service.getState();
  const ticket = state.tickets.find((item) => item.id === ticketId);
  if (!ticket) {
    const error = new Error(`Unknown ticket: ${ticketId}`);
    error.status = 404;
    throw error;
  }
  const resolved = resolveTicketWorkspace(ticket, options);
  const repoPath = resolved.path;
  if (!repoPath) {
    const error = new Error("Project has no repository folder configured.");
    error.status = 400;
    throw error;
  }
  if (!isGitRoot(repoPath)) {
    const error = new Error(`Ticket workspace is not a git repository: ${repoPath}`);
    error.status = 400;
    throw error;
  }
  return { ticket, repoPath, workspaceSource: resolved.source };
}

function projectTree(repoPath, diffText) {
  const limit = 50000;
  const scanned = scanProjectFiles(repoPath, limit);
  const allFiles = Array.from(new Set(scanned.files.concat(diffFilePaths(diffText)))).sort((a, b) => a.localeCompare(b));
  return {
    rootName: path.basename(repoPath),
    truncated: scanned.truncated || allFiles.length > limit,
    dirs: scanned.dirs,
    files: allFiles.slice(0, limit),
  };
}

function scanProjectFiles(repoPath, limit) {
  const dirs = [];
  const files = [];
  let truncated = false;
  const ignoredDirs = new Set([
    ".git",
    ".gradle",
    ".idea",
    ".next",
    ".nuxt",
    ".turbo",
    ".vite",
    "build",
    "dist",
    "node_modules",
    "out",
  ]);

  function visit(dir, relativeDir = "") {
    if (files.length >= limit) {
      truncated = true;
      return;
    }
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const entry of entries) {
      if (files.length >= limit) {
        truncated = true;
        return;
      }
      if (entry.isSymbolicLink()) continue;
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (ignoredDirs.has(entry.name)) continue;
        dirs.push(relativePath);
        visit(path.join(dir, entry.name), relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  }

  visit(repoPath);
  return { dirs, files, truncated };
}

function diffFilePaths(diffText) {
  return parseUnifiedDiff(diffText)
    .map((file) => file.newPath || file.oldPath)
    .filter(Boolean);
}

function openProjectFile(service, ticketId, filePath, options = {}) {
  const { repoPath } = ticketRepository(service, ticketId, options);
  const relativePath = String(filePath || "").trim();
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
    const error = new Error("Invalid project file path.");
    error.status = 400;
    throw error;
  }

  const target = path.resolve(repoPath, relativePath);
  const repoRoot = path.resolve(repoPath);
  if (target !== repoRoot && !target.startsWith(`${repoRoot}${path.sep}`)) {
    const error = new Error("File path must stay inside the project folder.");
    error.status = 400;
    throw error;
  }
  if (!fs.existsSync(target)) {
    const error = new Error(`File does not exist: ${relativePath}`);
    error.status = 404;
    throw error;
  }

  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", target] : [target];
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 10000 });
  if (result.status !== 0) {
    const error = new Error(result.stderr.trim() || result.stdout.trim() || `Could not open file: ${relativePath}`);
    error.status = 500;
    throw error;
  }
  return { filePath: relativePath };
}

function openTicketWorktree(service, ticketId, options = {}) {
  const { repoPath, workspaceSource } = ticketRepository(service, ticketId, options);
  openPath(repoPath, options);
  return { repoPath, workspaceSource };
}

function openResumeTerminal(service, ticketId, options = {}) {
  const { ticket, repoPath, workspaceSource } = ticketRepository(service, ticketId, options);
  const agent = ticket.assigneeAgentId ? service.getState().agents.find((item) => item.id === ticket.assigneeAgentId) : null;
  if (!agent) {
    const error = new Error("Assign an agent before resuming a session.");
    error.status = 400;
    throw error;
  }
  const command = buildResumeCommand(agent, repoPath);
  copyToClipboard(command, options);
  openTerminal(repoPath, options);
  return { repoPath, workspaceSource, command };
}

function openPath(targetPath, options = {}) {
  if (options.systemActions?.openPath) return options.systemActions.openPath(targetPath);
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", targetPath] : [targetPath];
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 10000 });
  if (result.status !== 0) {
    const error = new Error(result.stderr.trim() || result.stdout.trim() || `Could not open path: ${targetPath}`);
    error.status = 500;
    throw error;
  }
}

function openTerminal(repoPath, options = {}) {
  if (options.systemActions?.openTerminal) return options.systemActions.openTerminal(repoPath);
  if (process.platform !== "darwin") {
    openPath(repoPath, options);
    return;
  }
  const result = spawnSync("open", ["-a", "Terminal", repoPath], { encoding: "utf8", timeout: 10000 });
  if (result.status !== 0) {
    const error = new Error(result.stderr.trim() || result.stdout.trim() || `Could not open Terminal for: ${repoPath}`);
    error.status = 500;
    throw error;
  }
}

function copyToClipboard(text, options = {}) {
  if (options.systemActions?.copyToClipboard) return options.systemActions.copyToClipboard(text);
  if (process.platform !== "darwin") return;
  const result = spawnSync("pbcopy", { input: text, encoding: "utf8", timeout: 10000 });
  if (result.status !== 0) {
    const error = new Error(result.stderr.trim() || result.stdout.trim() || "Could not copy resume command to clipboard.");
    error.status = 500;
    throw error;
  }
}

function buildResumeCommand(agent, repoPath) {
  const base = shellWords(agent.command || defaultAgentCommand(agent.type));
  const executable = base[0] || defaultAgentCommand(agent.type);
  const presetArgs = base.slice(1);
  const type = String(agent.type || "").toLowerCase();
  const executableName = path.basename(executable).toLowerCase();
  let command;
  if (type === "codex" || executableName.includes("codex")) {
    command = [executable, ...presetArgs, "resume", "--last"];
  } else if (type === "claude" || executableName.includes("claude")) {
    command = [executable, ...presetArgs, "--continue"];
  } else {
    command = base.length ? base : [executable];
  }
  return `cd ${shellQuote(repoPath)} && ${command.map(shellQuote).join(" ")}`;
}

function defaultAgentCommand(type) {
  return String(type || "").toLowerCase() === "codex" ? "codex" : "claude";
}

function shellWords(input) {
  const words = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(String(input || "")))) words.push(match[1] ?? match[2] ?? match[3]);
  return words;
}

function shellQuote(value) {
  const text = String(value || "");
  if (/^[a-zA-Z0-9_./:=+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function parseUnifiedDiff(diffText) {
  const files = [];
  let current = null;
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;
  for (const line of String(diffText || "").split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      if (current) files.push(current);
      current = { oldPath: "", newPath: "", hunks: [] };
      hunk = null;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("--- ")) {
      current.oldPath = normalizeDiffPath(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      current.newPath = normalizeDiffPath(line.slice(4));
      continue;
    }
    const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (match) {
      oldLine = Number.parseInt(match[1], 10);
      newLine = Number.parseInt(match[2], 10);
      hunk = { header: line, lines: [] };
      current.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    const marker = line[0] || " ";
    const content = line.slice(1);
    if (marker === "+") {
      hunk.lines.push({ type: "add", newLine, oldLine: null, content });
      newLine += 1;
    } else if (marker === "-") {
      hunk.lines.push({ type: "remove", newLine: null, oldLine, content });
      oldLine += 1;
    } else {
      hunk.lines.push({ type: "context", newLine, oldLine, content });
      oldLine += 1;
      newLine += 1;
    }
  }
  if (current) files.push(current);
  return files.filter((file) => file.hunks.length > 0);
}

function normalizeDiffPath(value) {
  return String(value || "").replace(/^[ab]\//, "").replace(/^\/dev\/null$/, "");
}

async function serveUi(req, res, requestUrl, uiDist, uiIndex) {
  if (req.method !== "GET") {
    sendJson(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  if (!fs.existsSync(uiIndex)) {
    sendHtml(res, 200, missingUiHtml());
    return;
  }

  const assetPath = path.normalize(path.join(uiDist, requestUrl.pathname));
  if (assetPath.startsWith(uiDist) && fs.existsSync(assetPath) && fs.statSync(assetPath).isFile()) {
    sendFile(res, assetPath);
    return;
  }
  sendFile(res, uiIndex, "text/html; charset=utf-8");
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(Object.assign(new Error("Request body too large"), { status: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(Object.assign(new Error("Invalid JSON request body"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
}

function sendFile(res, filePath, contentType = contentTypeFor(filePath)) {
  res.writeHead(200, {
    "content-type": contentType,
    "cache-control": filePath.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
  });
  fs.createReadStream(filePath).pipe(res);
}

function contentTypeFor(filePath) {
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function missingUiHtml() {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Thomas</title></head>
<body style="font:14px system-ui;margin:40px;line-height:1.5">
  <h1>Thomas API is running</h1>
  <p>The React UI has not been built yet. Run <code>npm install</code>, then <code>npm run dev:ui</code> for Vite development or <code>npm run build</code> to serve the compiled UI from this server.</p>
  <p>API state: <a href="/api/state">/api/state</a></p>
</body>
</html>`;
}

module.exports = {
  createApp,
  createHttpServer,
};
