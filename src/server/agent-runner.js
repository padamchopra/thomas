"use strict";

const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");
const { defaultRunLogRoot, ensureTicketWorkspace } = require("./workspace");

function createAgentRunner(service, runnerOptions = {}) {
  const runs = new Map();
  const runLogRoot = runnerOptions.runLogRoot || defaultRunLogRoot();
  fs.mkdirSync(runLogRoot, { recursive: true });

  function dispatch(ticketId, options = {}) {
    const state = service.getState();
    const ticket = state.tickets.find((item) => item.id === ticketId);
    if (!ticket) throw httpError(404, `Unknown ticket: ${ticketId}`);
    if (ticket.status === "in_progress") throw httpError(409, `${ticket.id} is already in progress.`);
    if (!ticket.assigneeAgentId) throw httpError(400, "Assign an agent before dispatching this ticket.");
    const agent = state.agents.find((item) => item.id === ticket.assigneeAgentId);
    if (!agent) throw httpError(404, `Unknown agent: ${ticket.assigneeAgentId}`);
    if (agent.status === "paused" || agent.status === "offline") throw httpError(400, `${agent.name} is ${agent.status}.`);
    if (!ticket.project?.repoPath) throw httpError(400, "Ticket project has no repository folder configured.");

    const cwd = ensureTicketWorkspace(ticket, runnerOptions).path;
    const runId = `run-${ticket.id}-${Date.now()}`;
    const liveActivity = true;
    const prompt = buildPrompt(ticket, options.message || "", { resume: options.resume === true });
    const command = agentCommand(agent, { prompt, liveActivity, resume: options.resume === true });
    const run = {
      id: runId,
      ticketId: ticket.id,
      agentId: agent.id,
      agentName: agent.name,
      status: "running",
      command: displayCommand(command),
      cwd,
      startedAt: new Date().toISOString(),
      endedAt: null,
      exitCode: null,
      events: [],
      summary: "",
      child: null,
      metaPath: path.join(runLogRoot, `${safeRunFileName(runId)}.json`),
      eventsPath: path.join(runLogRoot, `${safeRunFileName(runId)}.jsonl`),
      stdoutPath: path.join(runLogRoot, `${safeRunFileName(runId)}.stdout.log`),
      stderrPath: path.join(runLogRoot, `${safeRunFileName(runId)}.stderr.log`),
      stdoutOffset: 0,
      stderrOffset: 0,
    };
    runs.set(runId, run);
    saveRunMeta(run);
    saveRunEvents(run);

    service.updateTicket(ticket.id, { status: "in_progress" }, "agent");
    service.recordActivity("agent.run.started", ticket.id, {
      ticketId: ticket.id,
      agentId: agent.id,
      runId,
      command: run.command,
    });
    addRunEvent(run, "status", `Started ${agent.name}.`);

    const stdoutFd = fs.openSync(run.stdoutPath, "a");
    const stderrFd = fs.openSync(run.stderrPath, "a");
    const child = spawn(command[0], command.slice(1), {
      cwd,
      detached: true,
      env: {
        ...process.env,
        THOMAS_TICKET_ID: ticket.id,
        THOMAS_RUN_ID: runId,
        THOMAS_PROJECT: ticket.project.name,
      },
      stdio: ["ignore", stdoutFd, stderrFd],
    });
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);

    run.pid = child.pid;
    run.child = child;
    saveRunMeta(run);
    child.unref();
    child.on("error", (error) => finishRun(run, ticket.id, agent.name, 1, error.message));
    child.on("close", (code) => {
      parseRunOutput(run, liveActivity);
      finishRun(run, ticket.id, agent.name, code || 0);
    });

    return run;
  }

  function getRuns() {
    const hydrated = hydrateRuns(runLogRoot, runs);
    for (const run of hydrated) refreshRun(run, service, runnerOptions);
    const state = service.getState();
    const ticketStatuses = new Map(state.tickets.map((ticket) => [ticket.id, ticket.status]));
    return hydrated.map((run) => {
      const visible = sanitizeRun(run);
      if (visible.status === "running" && ticketStatuses.get(visible.ticketId) !== "in_progress") {
        visible.status = "interrupted";
      }
      return visible;
    });
  }

  function stop(ticketId) {
    const run = hydrateRuns(runLogRoot, runs).find((item) => item.ticketId === ticketId && item.status === "running");
    if (!run) throw httpError(404, `No running agent for ticket: ${ticketId}`);
    run.stopped = true;
    addRunEvent(run, "status", "Stop requested.");
    if (run.child && !run.child.killed) {
      run.child.kill("SIGTERM");
    } else if (run.pid && isProcessAlive(run.pid)) {
      process.kill(run.pid, "SIGTERM");
    }
    setTimeout(() => {
      if (run.status !== "running") return;
      if (run.child && !run.child.killed) {
        run.child.kill("SIGKILL");
      } else if (run.pid && isProcessAlive(run.pid)) {
        process.kill(run.pid, "SIGKILL");
      }
    }, 5000).unref?.();
    return {
      ...run,
      child: undefined,
      events: run.events.slice(-80),
    };
  }

  function cleanupTicketRuns(ticketId) {
    const safePrefix = `${safeRunFileName(`run-${ticketId}`)}-`;
    const deleted = [];
    for (const [runId] of runs) {
      if (String(runId).startsWith(`run-${ticketId}-`)) runs.delete(runId);
    }
    let files = [];
    try {
      files = fs.readdirSync(runLogRoot);
    } catch {
      return deleted;
    }
    for (const file of files) {
      if (!file.startsWith(safePrefix)) continue;
      const target = path.join(runLogRoot, file);
      try {
        fs.rmSync(target, { force: true });
        deleted.push(target);
      } catch {
        // Cleanup is best-effort; stale files should not block archival.
      }
    }
    return deleted;
  }

  function finishRun(run, ticketId, agentName, exitCode, errorMessage = "") {
    if (run.status !== "running") return;
    parseRunOutput(run, true);
    run.status = run.stopped ? "stopped" : exitCode === 0 ? "finished" : "failed";
    run.exitCode = exitCode;
    run.endedAt = new Date().toISOString();
    saveRunMeta(run);
    const summary = run.stopped ? `${agentName} was stopped by the user.` : cleanSummary(run.summary) || errorMessage || `${agentName} finished with exit code ${exitCode}.`;
    addRunEvent(run, run.status, finalRunEventText(run, agentName, exitCode, errorMessage));
    updateTicketAfterRun(service, ticketId, run, summary, runnerOptions);
    service.recordActivity("agent.run.finished", ticketId, {
      ticketId,
      agentId: run.agentId,
      runId: run.id,
      exitCode,
      stopped: run.stopped === true,
    });
  }

  return { dispatch, getRuns, stop, cleanupTicketRuns };
}

function sanitizeRun(run) {
  return {
    id: run.id,
    ticketId: run.ticketId,
    agentId: run.agentId,
    agentName: run.agentName,
    status: run.status,
    command: run.command,
    cwd: run.cwd,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    exitCode: run.exitCode,
    logPath: run.eventsPath,
    stdoutPath: run.stdoutPath,
    stderrPath: run.stderrPath,
    events: (run.events || []).slice(-80),
    summary: run.summary || "",
  };
}

function refreshRun(run, service, runnerOptions = {}) {
  if (run.status !== "running") return;
  parseRunOutput(run, true);
  if (run.pid && isProcessAlive(run.pid)) {
    saveRunMeta(run);
    return;
  }
  if (run.pid) {
    run.status = "finished";
    run.exitCode = null;
    run.endedAt = new Date().toISOString();
    const summary = cleanSummary(run.summary) || "Agent run finished while Thomas was not attached.";
    addRunEvent(run, "finished", finalRunEventText(run, run.agentName || "Agent", 0));
    try {
      const state = service.getState();
      const ticket = state.tickets.find((item) => item.id === run.ticketId);
      if (ticket?.status === "in_progress") {
        const prUrl = ticket.prUrl || findPullRequestUrl(run, summary, runnerOptions);
        service.updateTicket(run.ticketId, prUrl ? { status: "pr_review", prUrl } : { status: "human_review" }, "agent");
        service.recordActivity("agent.run.finished", run.ticketId, {
          ticketId: run.ticketId,
          agentId: run.agentId,
          runId: run.id,
          exitCode: null,
          detached: true,
        });
      }
    } catch {
      // Keep transcript hydration best-effort; state reads should not fail on recovery.
    }
    saveRunMeta(run);
  }
}

function updateTicketAfterRun(service, ticketId, run, summary, runnerOptions = {}) {
  const state = service.getState();
  const ticket = state.tickets.find((item) => item.id === ticketId);
  if (ticket?.status === "done") return;
  if (run.stopped) {
    service.updateTicket(ticketId, { status: "human_review" }, "agent");
    return;
  }
  const prUrl = ticket?.prUrl || findPullRequestUrl(run, summary, runnerOptions);
  if (ticket?.status === "pr_review" || prUrl) {
    service.updateTicket(ticketId, prUrl ? { status: "pr_review", prUrl } : { status: "pr_review" }, "agent");
    return;
  }
  service.updateTicket(ticketId, { status: "human_review" }, "agent");
}

function findPullRequestUrl(run, summary, runnerOptions = {}) {
  if (runnerOptions.findPullRequestUrl) {
    return String(runnerOptions.findPullRequestUrl(run, summary) || "").trim();
  }
  return findPullRequestUrlWithGh(run?.cwd);
}

function findPullRequestUrlWithGh(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return "";
  const result = spawnSync("gh", ["pr", "view", "--json", "url"], {
    cwd,
    encoding: "utf8",
    timeout: 15000,
    env: {
      ...process.env,
      GH_PROMPT_DISABLED: "1",
    },
  });
  if (result.status !== 0) return "";
  try {
    const parsed = JSON.parse(result.stdout || "{}");
    return String(parsed.url || "").trim();
  } catch {
    return "";
  }
}

function hydrateRuns(runLogRoot, activeRuns) {
  const byId = new Map();
  for (const run of readPersistedRuns(runLogRoot)) byId.set(run.id, run);
  for (const run of activeRuns.values()) byId.set(run.id, run);
  return Array.from(byId.values())
    .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")))
    .slice(0, 80);
}

function readPersistedRuns(runLogRoot) {
  let files = [];
  try {
    files = fs.readdirSync(runLogRoot).filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }
  return files.map((file) => {
    try {
      const metaPath = path.join(runLogRoot, file);
      const run = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      run.metaPath = metaPath;
      run.eventsPath = run.eventsPath || metaPath.replace(/\.json$/, ".jsonl");
      run.stdoutPath = run.stdoutPath || metaPath.replace(/\.json$/, ".stdout.log");
      run.stderrPath = run.stderrPath || metaPath.replace(/\.json$/, ".stderr.log");
      run.stdoutOffset = Number.isFinite(run.stdoutOffset) ? run.stdoutOffset : 0;
      run.stderrOffset = Number.isFinite(run.stderrOffset) ? run.stderrOffset : 0;
      run.events = readRunEvents(run.eventsPath);
      return run;
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function readRunEvents(eventsPath) {
  try {
    return fs.readFileSync(eventsPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function saveRunMeta(run) {
  if (!run.metaPath) return;
  fs.mkdirSync(path.dirname(run.metaPath), { recursive: true });
  fs.writeFileSync(run.metaPath, JSON.stringify(sanitizeRun(run), null, 2));
}

function saveRunEvents(run) {
  if (!run.eventsPath) return;
  fs.mkdirSync(path.dirname(run.eventsPath), { recursive: true });
  fs.writeFileSync(run.eventsPath, (run.events || []).map((event) => JSON.stringify(event)).join("\n") + ((run.events || []).length ? "\n" : ""));
}

function safeRunFileName(runId) {
  return String(runId || "run").replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function parseRunOutput(run, liveActivity) {
  consumeOutput(run, readNewOutput(run, "stdout"), liveActivity, "stdout");
  consumeOutput(run, readNewOutput(run, "stderr"), liveActivity, "stderr");
  saveRunMeta(run);
}

function readNewOutput(run, stream) {
  const filePath = stream === "stderr" ? run.stderrPath : run.stdoutPath;
  const offsetKey = stream === "stderr" ? "stderrOffset" : "stdoutOffset";
  if (!filePath || !fs.existsSync(filePath)) return Buffer.alloc(0);
  const stat = fs.statSync(filePath);
  const offset = Math.min(run[offsetKey] || 0, stat.size);
  if (stat.size <= offset) return Buffer.alloc(0);
  const fd = fs.openSync(filePath, "r");
  try {
    const size = stat.size - offset;
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, offset);
    run[offsetKey] = stat.size;
    return buffer;
  } finally {
    fs.closeSync(fd);
  }
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function consumeOutput(run, chunk, liveActivity, stream = "stdout") {
  if (!chunk || chunk.length === 0) return;
  const text = chunk.toString("utf8");
  if (!liveActivity) {
    run.summary += text;
    if (run.summary.length > 20000) run.summary = run.summary.slice(-20000);
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = parseStructuredEvent(trimmed);
    if (parsed) {
      if (parsed.append) {
        appendRunEvent(run, parsed.kind, parsed.text);
      } else {
        addRunEvent(run, parsed.kind, parsed.text);
      }
      if (parsed.summary) run.summary += parsed.append ? parsed.summary : `${parsed.summary}\n`;
    } else {
      addRunEvent(run, stream, trimmed);
      run.summary += `${trimmed}\n`;
    }
    if (run.summary.length > 20000) run.summary = run.summary.slice(-20000);
  }
}

function parseStructuredEvent(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }

  if (event.type === "stream_event" && event.event) {
    return parseStreamEvent(event.event);
  }
  if (event.type === "assistant" && event.message?.content) {
    return parseAssistantMessage(event.message);
  }
  if (event.type === "result") {
    return event.result ? { kind: "assistant", text: event.result, summary: event.result } : null;
  }
  if (event.type === "system" || event.type === "user") return null;

  const type = event.type || event.event || event.kind || "";
  const text =
    event.text ||
    event.message ||
    event.delta?.text ||
    event.delta?.thinking ||
    event.content ||
    event.item?.text ||
    event.output ||
    "";
  if (typeof text === "string" && text.trim()) {
    return {
      kind: type.includes("tool") ? "tool" : "assistant",
      text: text.trim(),
      summary: type.includes("message") || type.includes("assistant") ? text : "",
    };
  }
  if (event.name || event.tool || event.command) {
    return { kind: "tool", text: `Using ${event.name || event.tool || event.command}` };
  }
  if (type && !["message_start", "message_stop", "content_block_stop"].includes(type)) {
    return { kind: "status", text: titleCase(type.replace(/[._-]+/g, " ")) };
  }
  return null;
}

function parseStreamEvent(event) {
  const type = event.type || "";
  if (type === "content_block_start") {
    const block = event.content_block || {};
    if (block.type === "tool_use") return { kind: "tool", text: toolLabel(block.name, block.input) };
    return null;
  }
  if (type === "content_block_delta") {
    const delta = event.delta || {};
    if (delta.type === "text_delta" && delta.text) {
      return { kind: "assistant", text: delta.text, summary: delta.text, append: true };
    }
    if (delta.type === "thinking_delta" && delta.thinking) {
      return { kind: "thinking", text: delta.thinking, append: true };
    }
    return null;
  }
  if (type === "message_delta" || type === "message_stop" || type === "content_block_stop") return null;
  return null;
}

function parseAssistantMessage(message) {
  const content = Array.isArray(message.content) ? message.content : [];
  for (const block of content) {
    if (block.type === "tool_use") return { kind: "tool", text: toolLabel(block.name, block.input) };
    if (block.type === "text" && block.text) return { kind: "assistant", text: block.text, summary: block.text };
    if (block.type === "thinking" && block.thinking) return { kind: "thinking", text: block.thinking };
  }
  return null;
}

function toolLabel(name, input) {
  const label = name || "tool";
  if (!input || typeof input !== "object") return `Using ${label}`;
  if (input.command) return `$ ${input.command}`;
  if (input.file_path) return `${label} ${input.file_path}`;
  if (input.path) return `${label} ${input.path}`;
  return `Using ${label}`;
}

function addRunEvent(run, kind, text) {
  const cleaned = String(text || "").trim();
  if (!cleaned) return;
  run.events.push({
    id: `${run.id}-${run.events.length + 1}`,
    kind,
    text: cleaned.length > 1000 ? `${cleaned.slice(0, 1000)}...` : cleaned,
    createdAt: new Date().toISOString(),
  });
  if (run.events.length > 120) run.events.splice(0, run.events.length - 120);
  saveRunEvents(run);
  saveRunMeta(run);
}

function appendRunEvent(run, kind, text) {
  const next = String(text || "");
  if (!next) return;
  const last = run.events.at(-1);
  if (last && last.kind === kind) {
    const joined = `${last.text}${next}`;
    last.text = joined.length > 2000 ? `...${joined.slice(-2000)}` : joined;
    last.createdAt = new Date().toISOString();
    saveRunEvents(run);
    saveRunMeta(run);
    return;
  }
  if (!next.trim()) return;
  run.events.push({
    id: `${run.id}-${run.events.length + 1}`,
    kind,
    text: next.length > 2000 ? `...${next.slice(-2000)}` : next,
    createdAt: new Date().toISOString(),
  });
  if (run.events.length > 120) run.events.splice(0, run.events.length - 120);
  saveRunEvents(run);
  saveRunMeta(run);
}


function agentCommand(agent, options) {
  const base = shellWords(agent.command || defaultCommand(agent.type));
  const executable = base[0] || defaultCommand(agent.type);
  const presetArgs = base.slice(1);
  const type = String(agent.type || "").toLowerCase();
  if (type === "codex" || path.basename(executable).toLowerCase().includes("codex")) {
    return options.resume
      ? [executable, ...presetArgs, "exec", "resume", ...(options.liveActivity ? ["--json"] : []), "--last", options.prompt]
      : [executable, ...presetArgs, "exec", ...(options.liveActivity ? ["--json"] : []), options.prompt];
  }
  if (type === "claude" || path.basename(executable).toLowerCase().includes("claude")) {
    const live = options.liveActivity ? ["--output-format", "stream-json", "--verbose", "--include-partial-messages"] : [];
    return options.resume
      ? [executable, ...presetArgs, ...live, "--continue", "-p", options.prompt]
      : [executable, ...presetArgs, ...live, "-p", options.prompt];
  }
  return [executable, ...presetArgs, options.prompt];
}

function buildPrompt(ticket, message, options = {}) {
  const comments = (ticket.comments || [])
    .slice(-8)
    .map((comment) => `${promptCommentAuthor(comment.author)}: ${comment.body}`)
    .join("\n\n");
  const contextLines = [];
  if (message) {
    contextLines.push("Latest human reply:", message, "");
  }
  if (!options.resume && comments) {
    contextLines.push("Recent conversation:", comments, "");
  }
  return [
    `Ticket: ${ticket.id}`,
    "",
    "Objective:",
    "Implement the requested change in this repository. Treat the title, description, and any reply/context below as the source of truth.",
    "",
    "Title:",
    ticket.title,
    "",
    "Description:",
    ticket.description || "none",
    "",
    `Project: ${ticket.project?.name || "unknown"}`,
    "",
    ...contextLines,
    "Constraints:",
    "Work non-interactively in this repository.",
    "Make only the changes needed for this ticket.",
    "Use the current branch and worktree; do not switch branches or create additional worktrees.",
    "Do not call tracker APIs or change ticket status directly.",
    "If you open a pull request, use gh on the current branch. The runner will detect the PR after this run.",
    "Run the smallest relevant validation that gives useful signal.",
    "If blocked, explain the specific missing input, failing command, or external dependency in your normal final response.",
  ].filter(Boolean).join("\n");
}

function promptCommentAuthor(author) {
  return String(author || "").trim().toLowerCase() === "agent" ? "Agent" : "You";
}

function finalRunEventText(run, agentName, exitCode, errorMessage = "") {
  if (run.stopped) return `${agentName} was stopped by the user.`;
  if (run.status === "failed" || (Number.isFinite(exitCode) && exitCode !== 0)) {
    const detail = cleanSummary(errorMessage || run.summary);
    return detail ? `${agentName} failed with exit code ${exitCode}. ${truncateInline(detail, 180)}` : `${agentName} failed with exit code ${exitCode}.`;
  }
  return `${agentName} finished. Review the latest Agent message above for the result.`;
}

function truncateInline(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trim()}...`;
}

function cleanSummary(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "";
  const summary = trimmed.match(/SUMMARY:\s*([\s\S]+)/i);
  if (summary) return summary[1].trim();
  const blocked = trimmed.match(/BLOCKED:\s*([\s\S]+)/i);
  if (blocked) return `BLOCKED: ${blocked[1].trim()}`;
  return trimmed.split(/\r?\n/).slice(-12).join("\n").trim();
}

function shellWords(input) {
  const words = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(String(input || "")))) words.push(match[1] ?? match[2] ?? match[3]);
  return words;
}

function defaultCommand(type) {
  return String(type || "").toLowerCase() === "codex" ? "codex" : "claude";
}

function displayCommand(command) {
  return command.map((part, index) => index === command.length - 1 && part.length > 120 ? "<prompt>" : part).join(" ");
}

function titleCase(value) {
  return String(value || "").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

module.exports = { createAgentRunner };
