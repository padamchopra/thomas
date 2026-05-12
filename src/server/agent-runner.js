"use strict";

const fs = require("node:fs");
const os = require("node:os");
const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");
const { defaultRunLogRoot, ensureTicketWorkspace } = require("./workspace");

const BG_JOB_GRACE_MS = 30000;

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

    const cwd = ensureTicketWorkspace(ticket, {
      ...runnerOptions,
      branchPrefix: runnerOptions.getBranchPrefix?.(),
    }).path;
    const runId = `run-${ticket.id}-${Date.now()}`;
    const liveActivity = true;
    const resume = options.resume === true;
    const conversationName = buildConversationName(ticket);
    const previousSession = resume ? latestProviderSessionForTicket(runLogRoot, runs, ticket.id, agent.id) : null;
    const prompt = buildPrompt(ticket, options.message || "", { resume });
    const useClaudeAgents = claudeAgentsEnabled(service, runnerOptions);
    const command = agentCommand(agent, {
      prompt,
      liveActivity,
      resume,
      providerSessionId: previousSession?.providerSessionId || "",
      conversationName,
      useClaudeAgents,
    });
    const provider = agentProvider(agent);
    const bgEligible = provider === "claude" && useClaudeAgents;
    const run = {
      id: runId,
      ticketId: ticket.id,
      agentId: agent.id,
      agentName: agent.name,
      provider,
      providerSessionId: previousSession?.providerSessionId || "",
      conversationName,
      status: "running",
      command: displayCommand(command),
      cwd,
      startedAt: new Date().toISOString(),
      endedAt: null,
      exitCode: null,
      nextEventSequence: 1,
      events: [],
      summary: "",
      child: null,
      metaPath: path.join(runLogRoot, `${safeRunFileName(runId)}.json`),
      eventsPath: path.join(runLogRoot, `${safeRunFileName(runId)}.jsonl`),
      stdoutPath: path.join(runLogRoot, `${safeRunFileName(runId)}.stdout.log`),
      stderrPath: path.join(runLogRoot, `${safeRunFileName(runId)}.stderr.log`),
      stdoutOffset: 0,
      stderrOffset: 0,
      bgEligible,
      bgMode: false,
      daemonShort: "",
      transcriptPath: "",
      transcriptOffset: 0,
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
      if (run.bgEligible && !run.stopped) {
        const short = parseBackgroundedShort(readStdoutText(run));
        if (short) {
          adoptBgRun(run, short);
          return;
        }
      }
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
    if (run.bgMode && run.daemonShort) {
      stopBgRun(run);
      pollBgRun(run, service, runnerOptions);
      return {
        ...run,
        child: undefined,
        events: selectConversationEvents(run.events || []),
      };
    }
    const signalled = killRunProcess(run, "SIGTERM");
    if (!signalled) {
      finishStoppedRun(run, service, ticketId, { detached: true, missingPid: true });
      return {
        ...run,
        child: undefined,
        events: selectConversationEvents(run.events || []),
      };
    }
    saveRunMeta(run);
    setTimeout(() => {
      if (run.status !== "running") return;
      killRunProcess(run, "SIGKILL");
    }, 5000).unref?.();
    return {
      ...run,
      child: undefined,
      events: selectConversationEvents(run.events || []),
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
    provider: run.provider || "",
    providerSessionId: run.providerSessionId || "",
    conversationName: run.conversationName || "",
    cwd: run.cwd,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    exitCode: run.exitCode,
    logPath: run.eventsPath,
    stdoutPath: run.stdoutPath,
    stderrPath: run.stderrPath,
    events: selectConversationEvents(run.events || []),
    summary: run.summary || "",
  };
}

function selectConversationEvents(events) {
  return (events || []).filter(isConversationRunEvent).slice(-80);
}

function isConversationRunEvent(event) {
  if (!event || !event.kind) return false;
  if (event.kind === "assistant") return true;
  if (event.kind === "failed" || event.kind === "stopped") return true;
  return false;
}

function refreshRun(run, service, runnerOptions = {}) {
  if (run.status !== "running") return;
  if (run.bgMode && run.daemonShort) {
    pollBgRun(run, service, runnerOptions);
    return;
  }
  parseRunOutput(run, true);
  if (run.pid && isProcessAlive(run.pid)) {
    saveRunMeta(run);
    return;
  }
  if (run.pid) {
    if (run.stopped) {
      finishStoppedRun(run, service, run.ticketId, { detached: true });
      return;
    }
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

function pollBgRun(run, service, runnerOptions = {}) {
  const jobState = readBgJobState(run.daemonShort);
  if (jobState) {
    if (!run.transcriptPath || !fs.existsSync(run.transcriptPath)) {
      const resolved = resolveBgTranscriptPath(run, jobState);
      if (resolved) run.transcriptPath = resolved;
    }
    if (jobState.sessionId && !run.providerSessionId) {
      run.providerSessionId = String(jobState.sessionId);
    }
  }
  parseTranscriptOutput(run);

  if (run.stopped && (!jobState || isTerminalBgState(jobState))) {
    finishStoppedRun(run, service, run.ticketId, { detached: true });
    return;
  }
  if (jobState && isTerminalBgState(jobState)) {
    const summary = jobState.output?.result || jobState.detail || run.summary;
    if (summary) run.summary = summary;
    const exitCode = jobState.state === "failed" ? 1 : 0;
    const ticket = safeFindTicket(service, run.ticketId);
    finishRunFromState(run, service, ticket, exitCode, "", runnerOptions);
    return;
  }
  if (!jobState) {
    const sinceStart = Date.now() - new Date(run.startedAt).getTime();
    if (sinceStart > BG_JOB_GRACE_MS) {
      run.status = "interrupted";
      run.endedAt = new Date().toISOString();
      addRunEvent(run, "stopped", "Claude bg job vanished before producing a transcript.");
      try {
        service.updateTicket(run.ticketId, { status: "human_review" }, "agent");
      } catch {
        // Best-effort recovery; ticket update may fail if the service is mid-shutdown.
      }
      saveRunMeta(run);
      return;
    }
  }
  saveRunMeta(run);
}

function isTerminalBgState(jobState) {
  if (!jobState) return false;
  if (jobState.state === "done" || jobState.state === "failed") return true;
  if (jobState.firstTerminalAt && !jobState.inFlight?.tasks) return true;
  return false;
}

function safeFindTicket(service, ticketId) {
  try {
    return service.getState().tickets.find((item) => item.id === ticketId) || null;
  } catch {
    return null;
  }
}

function finishRunFromState(run, service, ticket, exitCode, errorMessage, runnerOptions) {
  if (run.status !== "running") return;
  run.status = exitCode === 0 ? "finished" : "failed";
  run.exitCode = exitCode;
  run.endedAt = new Date().toISOString();
  const summary = cleanSummary(run.summary) || errorMessage || `${run.agentName} finished.`;
  addRunEvent(run, run.status, finalRunEventText(run, run.agentName || "Agent", exitCode, errorMessage));
  try {
    if (ticket?.status === "in_progress") {
      const prUrl = ticket.prUrl || findPullRequestUrl(run, summary, runnerOptions);
      service.updateTicket(run.ticketId, prUrl ? { status: "pr_review", prUrl } : { status: "human_review" }, "agent");
    }
    service.recordActivity("agent.run.finished", run.ticketId, {
      ticketId: run.ticketId,
      agentId: run.agentId,
      runId: run.id,
      exitCode,
      bg: true,
    });
  } catch {
    // Activity recording is best-effort.
  }
  saveRunMeta(run);
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

function finishStoppedRun(run, service, ticketId, details = {}) {
  run.status = "interrupted";
  run.exitCode = null;
  run.endedAt = new Date().toISOString();
  addRunEvent(run, "stopped", details.missingPid
    ? "Stop requested; Thomas was no longer attached to this legacy run process."
    : "Agent run stopped.");
  try {
    service.updateTicket(ticketId, { status: "human_review" }, "agent");
    service.recordActivity("agent.run.stopped", ticketId, {
      ticketId,
      agentId: run.agentId,
      runId: run.id,
      ...details,
    });
  } catch {
    // Keep stop best-effort if state persistence is temporarily unavailable.
  }
  saveRunMeta(run);
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
      run.transcriptOffset = Number.isFinite(run.transcriptOffset) ? run.transcriptOffset : 0;
      run.bgEligible = run.bgEligible === true;
      run.bgMode = run.bgMode === true;
      run.daemonShort = run.daemonShort || "";
      run.transcriptPath = run.transcriptPath || "";
      run.events = readRunEvents(run.eventsPath);
      run.nextEventSequence = nextEventSequence(run);
      recoverProviderSessionFromOutput(run);
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
  fs.writeFileSync(run.metaPath, JSON.stringify(persistRunMeta(run), null, 2));
}

function persistRunMeta(run) {
  return {
    ...sanitizeRun(run),
    pid: run.pid || null,
    stdoutOffset: Number.isFinite(run.stdoutOffset) ? run.stdoutOffset : 0,
    stderrOffset: Number.isFinite(run.stderrOffset) ? run.stderrOffset : 0,
    stopped: run.stopped === true,
    bgEligible: run.bgEligible === true,
    bgMode: run.bgMode === true,
    daemonShort: run.daemonShort || "",
    transcriptPath: run.transcriptPath || "",
    transcriptOffset: Number.isFinite(run.transcriptOffset) ? run.transcriptOffset : 0,
  };
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

function recoverProviderSessionFromOutput(run) {
  if (run.providerSessionId || !run.stdoutPath || !fs.existsSync(run.stdoutPath)) return;
  try {
    const text = fs.readFileSync(run.stdoutPath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      captureProviderSession(run, JSON.parse(trimmed));
      if (run.providerSessionId) return;
    }
  } catch {
    // Legacy run logs are best-effort; missing session metadata only affects precise resume.
  }
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

function killRunProcess(run, signal) {
  const pid = run?.child?.pid || run?.pid;
  if (!pid) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    // Detached runs are process-group leaders on POSIX. If group signalling is
    // unavailable or the group is already gone, fall back to the direct child.
  }
  try {
    if (run.child && !run.child.killed) {
      run.child.kill(signal);
      return true;
    }
    if (isProcessAlive(pid)) {
      process.kill(pid, signal);
      return true;
    }
  } catch {
    // Stop is best-effort; refreshRun will reconcile status when the process exits.
  }
  return false;
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
    const parsed = parseStructuredEvent(trimmed, run);
    if (parsed) {
      if (parsed.hidden) continue;
      if (parsed.append) {
        appendRunEvent(run, parsed.kind, parsed.text);
      } else {
        addRunEvent(run, parsed.kind, parsed.text);
      }
      if (parsed.summary) run.summary += parsed.append ? parsed.summary : `${parsed.summary}\n`;
    } else if (stream === "transcript") {
      // Transcript lines are structured JSON; ignore anything we cannot map cleanly.
    } else {
      if (stream === "stderr") addRunEvent(run, stream, trimmed);
      run.summary += `${trimmed}\n`;
    }
    if (run.summary.length > 20000) run.summary = run.summary.slice(-20000);
  }
}

function parseStructuredEvent(line, run = null) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  captureProviderSession(run, event);

  if (event.type === "queue-operation" || event.type === "attachment") {
    return { hidden: true };
  }
  if (event.type === "stream_event" && event.event) {
    return parseStreamEvent(event.event) || { hidden: true };
  }
  if (event.type === "assistant" && event.message?.content) {
    return parseAssistantMessage(event.message);
  }
  if (event.type === "result") {
    return event.result ? { kind: "assistant", text: event.result, summary: event.result } : null;
  }
  if (event.type === "system" || event.type === "user") return { hidden: true };

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

function captureProviderSession(run, event) {
  if (!run || run.providerSessionId || !event || typeof event !== "object") return;
  if (event.type === "system" && event.subtype === "init" && event.session_id) {
    run.provider = run.provider || "claude";
    run.providerSessionId = String(event.session_id);
    return;
  }
  if (event.sessionId && (event.type === "assistant" || event.type === "user" || event.sessionKind === "bg")) {
    run.provider = run.provider || "claude";
    run.providerSessionId = String(event.sessionId);
    return;
  }
  if (event.type === "session_meta" && event.payload?.id) {
    run.provider = run.provider || "codex";
    run.providerSessionId = String(event.payload.id);
  }
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
  const last = run.events.at(-1);
  if (last?.kind === kind && last.text === cleaned) return;
  run.events.push({
    id: nextRunEventId(run),
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
    id: nextRunEventId(run),
    kind,
    text: next.length > 2000 ? `...${next.slice(-2000)}` : next,
    createdAt: new Date().toISOString(),
  });
  if (run.events.length > 120) run.events.splice(0, run.events.length - 120);
  saveRunEvents(run);
  saveRunMeta(run);
}

function nextRunEventId(run) {
  if (!Number.isFinite(run.nextEventSequence) || run.nextEventSequence < 1) {
    run.nextEventSequence = nextEventSequence(run);
  }
  const id = `${run.id}-${run.nextEventSequence}`;
  run.nextEventSequence += 1;
  return id;
}

function nextEventSequence(run) {
  const prefix = `${run.id}-`;
  let max = 0;
  for (const event of run.events || []) {
    const id = String(event?.id || "");
    if (!id.startsWith(prefix)) continue;
    const sequence = Number(id.slice(prefix.length));
    if (Number.isFinite(sequence)) max = Math.max(max, sequence);
  }
  return max + 1;
}


function agentCommand(agent, options) {
  const base = shellWords(agent.command || defaultCommand(agent.type));
  const executable = base[0] || defaultCommand(agent.type);
  const presetArgs = base.slice(1);
  const provider = agentProvider(agent, executable);
  if (provider === "codex") {
    return options.resume
      ? [executable, ...presetArgs, "exec", "resume", ...(options.liveActivity ? ["--json"] : []), ...(options.providerSessionId ? [options.providerSessionId] : ["--last"]), options.prompt]
      : [executable, ...presetArgs, "exec", ...(options.liveActivity ? ["--json"] : []), options.prompt];
  }
  if (provider === "claude") {
    const name = options.conversationName ? ["--name", options.conversationName] : [];
    const resumeTarget = options.providerSessionId || options.conversationName || "";
    if (options.useClaudeAgents) {
      return options.resume
        ? [executable, ...presetArgs, "--bg", ...name, ...(resumeTarget ? ["--resume", resumeTarget] : []), options.prompt]
        : [executable, ...presetArgs, "--bg", ...name, options.prompt];
    }
    const live = options.liveActivity ? ["--output-format", "stream-json", "--verbose", "--include-partial-messages"] : [];
    return options.resume
      ? [executable, ...presetArgs, ...live, ...name, ...(resumeTarget ? ["--resume", resumeTarget] : ["--continue"]), "-p", options.prompt]
      : [executable, ...presetArgs, ...live, ...name, "-p", options.prompt];
  }
  return [executable, ...presetArgs, options.prompt];
}

function latestProviderSessionForTicket(runLogRoot, activeRuns, ticketId, agentId) {
  return hydrateRuns(runLogRoot, activeRuns)
    .filter((run) => run.ticketId === ticketId && run.agentId === agentId && run.providerSessionId)
    .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")))[0] || null;
}

function claudeHomeRoot() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function claudeJobsRoot() {
  return path.join(claudeHomeRoot(), "jobs");
}

function claudeProjectsRoot() {
  return path.join(claudeHomeRoot(), "projects");
}

function encodeProjectCwd(cwd) {
  return String(cwd || "").replace(/\//g, "-");
}

function readBgJobState(daemonShort) {
  if (!daemonShort) return null;
  try {
    const text = fs.readFileSync(path.join(claudeJobsRoot(), daemonShort, "state.json"), "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function resolveBgTranscriptPath(run, jobState) {
  if (run.transcriptPath && fs.existsSync(run.transcriptPath)) return run.transcriptPath;
  if (jobState?.linkScanPath && fs.existsSync(jobState.linkScanPath)) return jobState.linkScanPath;
  if (jobState?.sessionId && run.cwd) {
    const candidate = path.join(claudeProjectsRoot(), encodeProjectCwd(run.cwd), `${jobState.sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return "";
}

function parseBackgroundedShort(output) {
  const match = String(output || "").match(/backgrounded\s*[·•]\s*([a-f0-9]+)/i);
  return match ? match[1] : "";
}

function readStdoutText(run) {
  if (!run.stdoutPath) return "";
  try {
    return fs.readFileSync(run.stdoutPath, "utf8");
  } catch {
    return "";
  }
}

function stopBgRun(run) {
  if (!run.daemonShort) return false;
  const result = spawnSync("claude", ["stop", run.daemonShort], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15000,
  });
  return result.status === 0;
}

function adoptBgRun(run, daemonShort) {
  run.bgMode = true;
  run.daemonShort = daemonShort;
  run.pid = null;
  run.summary = "";
  addRunEvent(run, "status", `Backgrounded as Claude job ${daemonShort}.`);
  const jobState = readBgJobState(daemonShort);
  if (jobState?.sessionId && !run.providerSessionId) {
    run.providerSessionId = String(jobState.sessionId);
  }
  const transcript = resolveBgTranscriptPath(run, jobState);
  if (transcript) run.transcriptPath = transcript;
  saveRunMeta(run);
}

function parseTranscriptOutput(run) {
  if (!run.transcriptPath || !fs.existsSync(run.transcriptPath)) return;
  let stat;
  try {
    stat = fs.statSync(run.transcriptPath);
  } catch {
    return;
  }
  const offset = Math.min(run.transcriptOffset || 0, stat.size);
  if (stat.size <= offset) return;
  const fd = fs.openSync(run.transcriptPath, "r");
  try {
    const size = stat.size - offset;
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, offset);
    run.transcriptOffset = stat.size;
    consumeOutput(run, buffer, true, "transcript");
  } finally {
    fs.closeSync(fd);
  }
}

function claudeAgentsEnabled(service, runnerOptions = {}) {
  if (typeof runnerOptions.useClaudeAgents === "boolean") return runnerOptions.useClaudeAgents;
  try {
    return service.getState().settings?.useClaudeAgents !== false;
  } catch {
    return true;
  }
}

function agentProvider(agent, executable = "") {
  const command = executable || shellWords(agent?.command || defaultCommand(agent?.type))[0] || defaultCommand(agent?.type);
  const type = String(agent?.type || "").toLowerCase();
  const name = path.basename(command).toLowerCase();
  if (type === "codex" || name.includes("codex")) return "codex";
  if (type === "claude" || name.includes("claude")) return "claude";
  return type || "custom";
}

function buildConversationName(ticket) {
  const id = String(ticket?.id || "ticket").trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return `thomas-${id || "ticket"}`;
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
  const planComments = formatPlanComments(ticket.planComments || []);
  if (planComments) {
    contextLines.push("Open Thomas plan comments:", planComments, "");
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

function formatPlanComments(comments) {
  const open = (comments || []).filter((comment) => comment.status !== "resolved");
  if (!open.length) return "";
  return open.slice(-20).map((comment, index) => {
    const anchor = comment.anchor || {};
    const anchorLabel = anchor.label || (anchor.step ? `Step ${anchor.step}` : "Plan-wide");
    const lines = [
      `${index + 1}. ${comment.planPath || "plan"} — ${anchorLabel}`,
    ];
    if (comment.selectedText) lines.push(`Selected text: ${comment.selectedText}`);
    lines.push(`Comment: ${comment.body}`);
    return lines.join("\n");
  }).join("\n\n");
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
