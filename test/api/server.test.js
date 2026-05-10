"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { createStateStore } = require("../../src/core/state-store");
const { createThomasService } = require("../../src/core/thomas-service");
const { createHttpServer } = require("../../src/server/app");

async function withServer(fn, options = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "thomas-api-"));
  const service = createThomasService({
    store: createStateStore({ dbPath: path.join(tmp, "thomas.db") }),
  });
  const serverOptions = {
    runLogRoot: path.join(tmp, "run-logs"),
    ...(typeof options === "function" ? options(tmp) : options),
  };
  const server = await startServer({ service, ...serverOptions });
  try {
    await fn(server.baseUrl, tmp);
  } finally {
    await server.close();
  }
}

async function startServer(options) {
  const server = createHttpServer(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("API creates projects, tickets, and comments", async () => {
  await withServer(async (baseUrl) => {
    const project = await post(`${baseUrl}/api/projects`, { name: "App", prefix: "APP" });
    assert.equal(project.project.prefix, "APP");

    const ticket = await post(`${baseUrl}/api/tickets`, {
      projectId: project.project.id,
      title: "Build the React board",
    });
    assert.equal(ticket.ticket.id, "APP-1");

    const comment = await post(`${baseUrl}/api/tickets/APP-1/comments`, {
      body: "Started.",
    });
    assert.equal(comment.comment.ticketId, "APP-1");
    assert.equal(comment.comment.author, "you");

    const stateResponse = await fetch(`${baseUrl}/api/state`);
    const state = await stateResponse.json();
    assert.equal(state.state.tickets[0].comments[0].body, "Started.");
  });
});

test("API dispatches assigned ticket and exposes live activity", async () => {
  await withServer(async (baseUrl, tmp) => {
    const repoPath = path.join(tmp, "repo");
    fs.mkdirSync(repoPath);
    const agentScript = path.join(tmp, "fake-agent.js");
    fs.writeFileSync(agentScript, [
      "console.log(JSON.stringify({ type: 'system', subtype: 'init' }));",
      "console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Reading ' } } }));",
      "console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'context' } } }));",
      "console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Bash', input: { command: 'git status' } } } }));",
      "console.log('SUMMARY: changed one file');",
    ].join("\n"));

    const project = await post(`${baseUrl}/api/projects`, { name: "App", prefix: "APP", repoPath });
    const agent = await post(`${baseUrl}/api/agents`, {
      name: "Fake",
      type: "custom",
      command: `${process.execPath} ${agentScript}`,
    });
    const ticket = await post(`${baseUrl}/api/tickets`, {
      projectId: project.project.id,
      title: "Dispatch me",
      assigneeAgentId: agent.agent.id,
    });

    const run = await post(`${baseUrl}/api/tickets/${ticket.ticket.id}/dispatch`, {});
    assert.equal(run.run.status, "running");

    const state = await waitForState(baseUrl, (next) => {
      const updated = next.tickets.find((item) => item.id === ticket.ticket.id);
      return updated?.status === "human_review" && updated.comments.length > 0;
    });
    const updated = state.tickets.find((item) => item.id === ticket.ticket.id);
    assert.match(updated.comments.at(-1).body, /changed one file|Reading context/);
    const completedRun = state.runs.find((item) => item.ticketId === ticket.ticket.id);
    assert.equal(completedRun.events.some((event) => event.kind === "status" && event.text === "System"), false);
    assert.equal(completedRun.events.some((event) => event.kind === "assistant" && event.text === "Reading context"), true);
    assert.equal(completedRun.events.some((event) => event.kind === "tool" && event.text === "$ git status"), true);
    assert.equal(fs.existsSync(completedRun.logPath), true);
    assert.match(fs.readFileSync(completedRun.logPath, "utf8"), /Reading context/);
  });
});

test("run transcript is hydrated from log files after restart", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "thomas-api-"));
  const runLogRoot = path.join(tmp, "run-logs");
  const service = createThomasService({
    store: createStateStore({ dbPath: path.join(tmp, "thomas.db") }),
  });
  let server = await startServer({ service, runLogRoot });
  try {
    const repoPath = path.join(tmp, "repo");
    fs.mkdirSync(repoPath);
    const agentScript = path.join(tmp, "fake-agent.js");
    fs.writeFileSync(agentScript, "setTimeout(() => console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Persistent transcript' } } })), 500);");
    const project = await post(`${server.baseUrl}/api/projects`, { name: "App", prefix: "APP", repoPath });
    const agent = await post(`${server.baseUrl}/api/agents`, {
      name: "Fake",
      type: "custom",
      command: `${process.execPath} ${agentScript}`,
    });
    const ticket = await post(`${server.baseUrl}/api/tickets`, {
      projectId: project.project.id,
      title: "Persist me",
      assigneeAgentId: agent.agent.id,
    });
    await post(`${server.baseUrl}/api/tickets/${ticket.ticket.id}/dispatch`, {});
    await server.close();
    server = null;

    server = await startServer({ service, runLogRoot });
    const state = await waitForState(server.baseUrl, (next) => {
      const updated = next.tickets.find((item) => item.id === ticket.ticket.id);
      const run = next.runs.find((item) => item.ticketId === ticket.ticket.id);
      return updated?.status === "human_review" && run?.events.some((event) => event.text.includes("Persistent transcript"));
    });
    const hydrated = state.runs.find((run) => run.ticketId === ticket.ticket.id);
    assert.equal(Boolean(hydrated), true);
    assert.equal(hydrated.events.some((event) => event.text.includes("Persistent transcript")), true);
  } finally {
    if (server) await server.close();
  }
});

test("API stops running ticket agents", async () => {
  await withServer(async (baseUrl, tmp) => {
    const repoPath = path.join(tmp, "repo");
    fs.mkdirSync(repoPath);
    const agentScript = path.join(tmp, "slow-agent.js");
    fs.writeFileSync(agentScript, "setTimeout(() => console.log('SUMMARY: done'), 30000);");

    const project = await post(`${baseUrl}/api/projects`, { name: "App", prefix: "APP", repoPath });
    const agent = await post(`${baseUrl}/api/agents`, {
      name: "Slow",
      type: "custom",
      command: `${process.execPath} ${agentScript}`,
    });
    const ticket = await post(`${baseUrl}/api/tickets`, {
      projectId: project.project.id,
      title: "Stop me",
      assigneeAgentId: agent.agent.id,
    });

    await post(`${baseUrl}/api/tickets/${ticket.ticket.id}/dispatch`, {});
    const stopped = await post(`${baseUrl}/api/tickets/${ticket.ticket.id}/stop`, {});
    assert.equal(stopped.run.status, "running");

    const state = await waitForState(baseUrl, (next) => {
      const updated = next.tickets.find((item) => item.id === ticket.ticket.id);
      return updated?.status === "todo";
    });
    const updated = state.tickets.find((item) => item.id === ticket.ticket.id);
    assert.equal(updated.comments.length, 0);
  });
});

test("human review comments resume the assigned agent", async () => {
  await withServer(async (baseUrl, tmp) => {
    const repoPath = path.join(tmp, "repo");
    fs.mkdirSync(repoPath);
    const agentScript = path.join(tmp, "review-agent.js");
    fs.writeFileSync(agentScript, "console.log('SUMMARY: applied review feedback');");

    const project = await post(`${baseUrl}/api/projects`, { name: "App", prefix: "APP", repoPath });
    const agent = await post(`${baseUrl}/api/agents`, {
      name: "Fake",
      type: "custom",
      command: `${process.execPath} ${agentScript}`,
    });
    const ticket = await post(`${baseUrl}/api/tickets`, {
      projectId: project.project.id,
      title: "Review me",
      status: "human_review",
      assigneeAgentId: agent.agent.id,
    });

    const comment = await postAsUi(`${baseUrl}/api/tickets/${ticket.ticket.id}/comments`, {
      body: "Please address this review note.",
    });
    assert.equal(comment.comment.author, "you");
    assert.equal(comment.run.status, "running");

    const state = await waitForState(baseUrl, (next) => {
      const updated = next.tickets.find((item) => item.id === ticket.ticket.id);
      return updated?.status === "human_review" && updated.comments.some((item) => item.author === "agent");
    });
    const updated = state.tickets.find((item) => item.id === ticket.ticket.id);
    assert.equal(updated.comments.some((item) => item.author === "you" && item.body.includes("review note")), true);
    assert.match(updated.comments.at(-1).body, /applied review feedback/);
  });
});

test("API syncs merged PR review tickets to done", async () => {
  await withServer(async (baseUrl, tmp) => {
    const repoPath = path.join(tmp, "repo");
    fs.mkdirSync(repoPath);
    const project = await post(`${baseUrl}/api/projects`, { name: "App", prefix: "APP", repoPath });
    const ticket = await post(`${baseUrl}/api/tickets`, {
      projectId: project.project.id,
      title: "Merged PR",
      status: "pr_review",
      prUrl: "https://github.com/example/app/pull/10",
    });

    const response = await fetch(`${baseUrl}/api/state`);
    const data = await response.json();
    assert.equal(response.status, 200, data.error);
    const updated = data.state.tickets.find((item) => item.id === ticket.ticket.id);
    assert.equal(updated.status, "done");
  }, {
    prSyncIntervalMs: 0,
    checkPullRequestStatus: () => ({ state: "MERGED", mergedAt: "2026-05-09T16:23:45Z" }),
  });
});

test("done tickets delete comments, activity, worktree, and run logs", async () => {
  await withServer(async (baseUrl, tmp) => {
    const repoPath = path.join(tmp, "repo");
    const workspaceRoot = path.join(tmp, "worktrees");
    const runLogRoot = path.join(tmp, "run-logs");
    fs.mkdirSync(repoPath);
    const project = await post(`${baseUrl}/api/projects`, { name: "App", prefix: "APP", repoPath });
    const ticket = await post(`${baseUrl}/api/tickets`, {
      projectId: project.project.id,
      title: "Archive artifacts",
      status: "human_review",
      workspaceId: "app-1",
      prUrl: "https://github.com/example/app/pull/1",
    });
    await postAsUi(`${baseUrl}/api/tickets/${ticket.ticket.id}/comments`, { body: "remove after done" });

    const worktreePath = path.join(workspaceRoot, "App", "app-1");
    createGitRepo(worktreePath);
    fs.mkdirSync(path.join(worktreePath, "src"), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, "src", "index.js"), "console.log('done');");
    fs.mkdirSync(runLogRoot, { recursive: true });
    fs.writeFileSync(path.join(runLogRoot, `run-${ticket.ticket.id}-1.json`), JSON.stringify({ id: `run-${ticket.ticket.id}-1`, ticketId: ticket.ticket.id }));
    fs.writeFileSync(path.join(runLogRoot, `run-${ticket.ticket.id}-1.jsonl`), "{}\n");
    fs.writeFileSync(path.join(runLogRoot, `run-${ticket.ticket.id}-1.stdout.log`), "output");

    const archived = await patchAsAgent(`${baseUrl}/api/tickets/${ticket.ticket.id}`, { status: "done" });
    const updated = archived.state.tickets.find((item) => item.id === ticket.ticket.id);
    assert.equal(updated.status, "done");
    assert.equal(updated.workspaceId, null);
    assert.deepEqual(updated.comments, []);
    assert.equal(archived.state.activity.some((event) => event.subject === ticket.ticket.id || event.details?.ticketId === ticket.ticket.id), false);
    assert.equal(fs.existsSync(worktreePath), false);
    assert.deepEqual(fs.readdirSync(runLogRoot).filter((file) => file.includes(ticket.ticket.id)), []);
  }, (tmp) => ({
    workspaceRoot: path.join(tmp, "worktrees"),
    runLogRoot: path.join(tmp, "run-logs"),
  }));
});

test("diff uses ticket worktree when one exists", async () => {
  await withServer(async (baseUrl, tmp) => {
    const repoPath = path.join(tmp, "repo");
    const workspaceRoot = path.join(tmp, "worktrees");
    const ticketWorktree = path.join(workspaceRoot, "Jupiter Mobile", "jmobile-3");
    createGitRepo(repoPath);
    createGitRepo(ticketWorktree);
    fs.mkdirSync(path.join(repoPath, "task"), { recursive: true });
    fs.mkdirSync(path.join(ticketWorktree, "task", "JMOBILE-3"), { recursive: true });
    fs.writeFileSync(path.join(ticketWorktree, "task", "JMOBILE-3", "plan.html"), "<h1>plan</h1>");

    const project = await post(`${baseUrl}/api/projects`, { name: "Jupiter Mobile", prefix: "JMOBILE", repoPath });
    const ticket = await post(`${baseUrl}/api/tickets`, {
      projectId: project.project.id,
      title: "Use worktree",
      workspaceId: "jmobile-3",
    });

    const response = await fetch(`${baseUrl}/api/tickets/${ticket.ticket.id}/diff`);
    const data = await response.json();
    assert.equal(response.status, 200, data.error);
    assert.equal(data.diff.workspaceSource, "worktree");
    assert.equal(data.diff.repoPath, ticketWorktree);
    assert.equal(data.diff.tree.files.includes("task/JMOBILE-3/plan.html"), true);
  }, (tmp) => ({ workspaceRoot: path.join(tmp, "worktrees") }));
});

test("ticket actions open worktree and prepare resume command", async () => {
  const actions = { openedPath: "", terminalPath: "", clipboard: "" };
  await withServer(async (baseUrl, tmp) => {
    const repoPath = path.join(tmp, "repo with spaces");
    createGitRepo(repoPath);
    const project = await post(`${baseUrl}/api/projects`, { name: "App", prefix: "APP", repoPath });
    const agent = await post(`${baseUrl}/api/agents`, {
      name: "Claude",
      type: "claude",
      command: "claude --permission-mode auto",
    });
    const ticket = await post(`${baseUrl}/api/tickets`, {
      projectId: project.project.id,
      title: "Open tools",
      assigneeAgentId: agent.agent.id,
    });

    const opened = await post(`${baseUrl}/api/tickets/${ticket.ticket.id}/open-worktree`, {});
    assert.equal(opened.opened.repoPath, repoPath);
    assert.equal(actions.openedPath, repoPath);

    const terminal = await post(`${baseUrl}/api/tickets/${ticket.ticket.id}/resume-terminal`, {});
    assert.equal(terminal.opened.repoPath, repoPath);
    assert.equal(actions.terminalPath, repoPath);
    assert.equal(actions.clipboard, `cd '${repoPath}' && claude --permission-mode auto --continue`);
    assert.equal(terminal.opened.command, actions.clipboard);
  }, {
    systemActions: {
      openPath: (targetPath) => {
        actions.openedPath = targetPath;
      },
      openTerminal: (targetPath) => {
        actions.terminalPath = targetPath;
      },
      copyToClipboard: (text) => {
        actions.clipboard = text;
      },
    },
  });
});

async function post(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  assert.equal(response.status < 400, true, data.error);
  return data;
}

async function postAsUi(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-thomas-actor": "ui" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  assert.equal(response.status < 400, true, data.error);
  return data;
}

async function patchAsAgent(url, body) {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-thomas-actor": "agent" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  assert.equal(response.status < 400, true, data.error);
  return data;
}

function createGitRepo(repoPath) {
  fs.mkdirSync(repoPath, { recursive: true });
  const result = spawnSync("git", ["init"], { cwd: repoPath, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

async function waitForState(baseUrl, predicate) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/state`);
    const data = await response.json();
    if (predicate(data.state)) return data.state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for state.");
}
