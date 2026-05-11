"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
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
    workspaceRoot: path.join(tmp, "worktrees"),
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

test("API auto-dispatches assigned tickets on create and exposes live activity", async () => {
  await withServer(async (baseUrl, tmp) => {
    const repoPath = path.join(tmp, "repo");
    createGitRepo(repoPath);
    const agentScript = path.join(tmp, "fake-agent.js");
    fs.writeFileSync(agentScript, [
      "require('node:fs').writeFileSync('prompt.txt', process.argv.at(-1));",
      "console.log(JSON.stringify({ type: 'system', subtype: 'init' }));",
      "console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Reading ' } } }));",
      "console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'context' } } }));",
      "console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Bash', input: { command: 'git status' } } } }));",
      "console.log('SUMMARY: changed one file');",
    ].join("\n"));

    const project = await post(`${baseUrl}/api/projects`, {
      name: "App",
      prefix: "APP",
      repoPath,
      setupScript: "printf \"%s/%s/%s\" \"$THOMAS_PROJECT\" \"$THOMAS_WORKSPACE\" \"$THOMAS_WORKSPACE_PATH\" > setup-output.txt",
    });
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
    assert.equal(ticket.run.status, "running");
    assert.equal(ticket.ticket.status, "in_progress");

    const state = await waitForState(baseUrl, (next) => {
      const updated = next.tickets.find((item) => item.id === ticket.ticket.id);
      const completedRun = next.runs.find((item) => item.ticketId === ticket.ticket.id && item.status === "finished");
      return updated?.status === "human_review" && completedRun?.events.some((event) => event.kind === "assistant");
    });
    const updated = state.tickets.find((item) => item.id === ticket.ticket.id);
    assert.equal(updated.comments.length, 0);
    const completedRun = state.runs.find((item) => item.ticketId === ticket.ticket.id);
    const expectedWorktree = path.join(tmp, "worktrees", "App", "app-1");
    assert.equal(completedRun.cwd, expectedWorktree);
    const prompt = fs.readFileSync(path.join(expectedWorktree, "prompt.txt"), "utf8");
    assert.match(prompt, /Ticket: APP-1/);
    assert.match(prompt, /Do not call tracker APIs or change ticket status directly/);
    assert.doesNotMatch(prompt, /Finish:/);
    assert.doesNotMatch(prompt, /SUMMARY:/);
    assert.doesNotMatch(prompt, /Keep it to 2-5 sentences/);
    assert.doesNotMatch(prompt, /Working context/);
    assert.doesNotMatch(prompt, /Current worktree/);
    assert.doesNotMatch(prompt, /Source repository/);
    assert.doesNotMatch(prompt, /Thomas ticket/);
    assert.equal(fs.readFileSync(path.join(expectedWorktree, "setup-output.txt"), "utf8"), `App/app-1/${expectedWorktree}`);
    assert.equal(completedRun.events.some((event) => event.kind === "status" && event.text === "System"), false);
    assert.equal(completedRun.events.some((event) => event.kind === "assistant" && event.text === "Reading context"), true);
    assert.equal(completedRun.events.some((event) => event.kind === "tool" && event.text === "$ git status"), true);
    assert.equal(fs.existsSync(completedRun.logPath), true);
    assert.match(fs.readFileSync(completedRun.logPath, "utf8"), /Reading context/);
  });
});

test("API auto-dispatches todo tickets when an assignee is added", async () => {
  await withServer(async (baseUrl, tmp) => {
    const repoPath = path.join(tmp, "repo");
    createGitRepo(repoPath);
    const agentScript = path.join(tmp, "assign-agent.js");
    fs.writeFileSync(agentScript, "console.log('SUMMARY: started after assignment');");

    const project = await post(`${baseUrl}/api/projects`, { name: "App", prefix: "APP", repoPath });
    const agent = await post(`${baseUrl}/api/agents`, {
      name: "Fake",
      type: "custom",
      command: `${process.execPath} ${agentScript}`,
    });
    const ticket = await post(`${baseUrl}/api/tickets`, {
      projectId: project.project.id,
      title: "Assign me",
    });

    const assigned = await patchAsUi(`${baseUrl}/api/tickets/${ticket.ticket.id}`, {
      assigneeAgentId: agent.agent.id,
    });
    assert.equal(assigned.run.status, "running");
    assert.equal(assigned.ticket.status, "in_progress");

    const state = await waitForState(baseUrl, (next) => {
      const updated = next.tickets.find((item) => item.id === ticket.ticket.id);
      const run = next.runs.find((item) => item.ticketId === ticket.ticket.id && item.status === "finished");
      return updated?.status === "human_review" && run?.summary.includes("started after assignment");
    });
    const updated = state.tickets.find((item) => item.id === ticket.ticket.id);
    assert.equal(updated.comments.length, 0);
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
    createGitRepo(repoPath);
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
    assert.equal(ticket.run.status, "running");
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
    createGitRepo(repoPath);
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
    assert.equal(ticket.run.status, "running");

    const stopped = await post(`${baseUrl}/api/tickets/${ticket.ticket.id}/stop`, {});
    assert.equal(stopped.run.status, "running");

    const state = await waitForState(baseUrl, (next) => {
      const updated = next.tickets.find((item) => item.id === ticket.ticket.id);
      return updated?.status === "human_review";
    });
    const updated = state.tickets.find((item) => item.id === ticket.ticket.id);
    assert.equal(updated.status, "human_review");
    assert.equal(updated.comments.length, 0);
  });
});

test("human review comments resume the assigned agent", async () => {
  await withServer(async (baseUrl, tmp) => {
    const repoPath = path.join(tmp, "repo");
    createGitRepo(repoPath);
    const agentScript = path.join(tmp, "review-agent.js");
    fs.writeFileSync(agentScript, [
      "require('node:fs').writeFileSync('prompt.txt', process.argv.at(-1));",
      "console.log('SUMMARY: applied review feedback');",
    ].join("\n"));

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
    assert.equal(ticket.run, null);

    const comment = await postAsUi(`${baseUrl}/api/tickets/${ticket.ticket.id}/comments`, {
      body: "Please address this review note.",
    });
    assert.equal(comment.comment.author, "you");
    assert.equal(comment.run.status, "running");

    const state = await waitForState(baseUrl, (next) => {
      const updated = next.tickets.find((item) => item.id === ticket.ticket.id);
      const run = next.runs.find((item) => item.ticketId === ticket.ticket.id && item.status === "finished");
      return updated?.status === "human_review" && run?.summary.includes("applied review feedback");
    });
    const updated = state.tickets.find((item) => item.id === ticket.ticket.id);
    assert.deepEqual(updated.comments.map((item) => item.author), ["you"]);
    const run = state.runs.find((item) => item.ticketId === ticket.ticket.id);
    const prompt = fs.readFileSync(path.join(run.cwd, "prompt.txt"), "utf8");
    assert.match(prompt, /Latest human reply:\nPlease address this review note/);
    assert.doesNotMatch(prompt, /Recent conversation:/);
  });
});

test("todo comments dispatch the assigned agent", async () => {
  await withServer(async (baseUrl, tmp) => {
    const repoPath = path.join(tmp, "repo");
    createGitRepo(repoPath);
    const agentScript = path.join(tmp, "todo-reply-agent.js");
    fs.writeFileSync(agentScript, "console.log('SUMMARY: picked up todo reply');");

    const project = await post(`${baseUrl}/api/projects`, { name: "App", prefix: "APP", repoPath });
    const agent = await post(`${baseUrl}/api/agents`, {
      name: "Fake",
      type: "custom",
      command: `${process.execPath} ${agentScript}`,
    });
    const ticket = await post(`${baseUrl}/api/tickets`, {
      projectId: project.project.id,
      title: "Reply from todo",
      status: "human_review",
      assigneeAgentId: agent.agent.id,
    });
    await patchAsAgent(`${baseUrl}/api/tickets/${ticket.ticket.id}`, { status: "todo" });

    const comment = await postAsUi(`${baseUrl}/api/tickets/${ticket.ticket.id}/comments`, {
      body: "Please start from this note.",
    });
    assert.equal(comment.run.status, "running");

    const state = await waitForState(baseUrl, (next) => {
      const updated = next.tickets.find((item) => item.id === ticket.ticket.id);
      const run = next.runs.find((item) => item.ticketId === ticket.ticket.id && item.status === "finished");
      return updated?.status === "human_review" && run?.summary.includes("picked up todo reply");
    });
    const updated = state.tickets.find((item) => item.id === ticket.ticket.id);
    assert.deepEqual(updated.comments.map((item) => item.author), ["you"]);
  });
});

test("agent completion detects pull requests with gh and moves ticket to PR review", async () => {
  let detectedCwd = "";
  await withServer(async (baseUrl, tmp) => {
    const repoPath = path.join(tmp, "repo");
    createGitRepo(repoPath);
    const agentScript = path.join(tmp, "pr-agent.js");
    fs.writeFileSync(agentScript, "console.log('SUMMARY: opened a pull request');");

    const project = await post(`${baseUrl}/api/projects`, { name: "App", prefix: "APP", repoPath });
    const agent = await post(`${baseUrl}/api/agents`, {
      name: "Fake",
      type: "custom",
      command: `${process.execPath} ${agentScript}`,
    });
    const ticket = await post(`${baseUrl}/api/tickets`, {
      projectId: project.project.id,
      title: "Open a PR",
      assigneeAgentId: agent.agent.id,
    });
    assert.equal(ticket.run.status, "running");

    const state = await waitForState(baseUrl, (next) => {
      const updated = next.tickets.find((item) => item.id === ticket.ticket.id);
      return updated?.status === "pr_review";
    });
    const updated = state.tickets.find((item) => item.id === ticket.ticket.id);
    assert.equal(updated.prUrl, "https://github.com/example/app/pull/42");
    assert.equal(updated.comments.length, 0);
    assert.equal(detectedCwd, path.join(tmp, "worktrees", "App", "app-1"));
  }, {
    findPullRequestUrl: (run) => {
      detectedCwd = run.cwd;
      return "https://github.com/example/app/pull/42";
    },
  });
});

test("API syncs merged PR review tickets to done", async () => {
  await withServer(async (baseUrl, tmp) => {
    const repoPath = path.join(tmp, "repo");
    createGitRepo(repoPath);
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

test("ticket status refresh corrects stale workflow states", async () => {
  let detectedCwd = "";
  await withServer(async (baseUrl, tmp) => {
    const repoPath = path.join(tmp, "repo");
    createGitRepo(repoPath);
    const project = await post(`${baseUrl}/api/projects`, { name: "App", prefix: "APP", repoPath });
    const staleInProgress = await post(`${baseUrl}/api/tickets`, {
      projectId: project.project.id,
      title: "Stale running status",
      status: "human_review",
    });
    await patchAsAgent(`${baseUrl}/api/tickets/${staleInProgress.ticket.id}`, { status: "in_progress" });

    const refreshedStale = await post(`${baseUrl}/api/tickets/${staleInProgress.ticket.id}/refresh-status`, {});
    assert.equal(refreshedStale.refreshed.previousStatus, "in_progress");
    assert.equal(refreshedStale.refreshed.status, "human_review");
    assert.equal(refreshedStale.refreshed.reason, "awaiting_human_review");

    const prTicket = await post(`${baseUrl}/api/tickets`, {
      projectId: project.project.id,
      title: "Detect PR",
      status: "human_review",
    });
    const refreshedPr = await post(`${baseUrl}/api/tickets/${prTicket.ticket.id}/refresh-status`, {});
    assert.equal(refreshedPr.refreshed.status, "pr_review");
    assert.equal(refreshedPr.refreshed.prUrl, "https://github.com/example/app/pull/77");
    assert.equal(refreshedPr.state.tickets.find((ticket) => ticket.id === prTicket.ticket.id).status, "pr_review");
    assert.equal(detectedCwd, repoPath);

    const mergedTicket = await post(`${baseUrl}/api/tickets`, {
      projectId: project.project.id,
      title: "Merged PR",
      status: "pr_review",
      prUrl: "https://github.com/example/app/pull/88",
    });
    const refreshedMerged = await post(`${baseUrl}/api/tickets/${mergedTicket.ticket.id}/refresh-status`, {});
    assert.equal(refreshedMerged.refreshed.status, "done");
    assert.equal(refreshedMerged.refreshed.reason, "merged_pull_request");
  }, {
    findPullRequestUrl: (run) => {
      detectedCwd = run.cwd;
      return run.ticketId === "APP-2" ? "https://github.com/example/app/pull/77" : "";
    },
    checkPullRequestStatus: (prUrl) => ({
      state: prUrl.endsWith("/88") ? "MERGED" : "OPEN",
      url: prUrl,
    }),
  });
});

test("done tickets delete comments, activity, worktree, and run logs", async () => {
  await withServer(async (baseUrl, tmp) => {
    const repoPath = path.join(tmp, "repo");
    const workspaceRoot = path.join(tmp, "worktrees");
    const runLogRoot = path.join(tmp, "run-logs");
    createGitRepo(repoPath);
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

test("deleting tickets removes Thomas worktrees but never the project root", async () => {
  await withServer(async (baseUrl, tmp) => {
    const repoPath = path.join(tmp, "repo");
    const workspaceRoot = path.join(tmp, "worktrees");
    createGitRepo(repoPath);
    const project = await post(`${baseUrl}/api/projects`, { name: "App", prefix: "APP", repoPath });
    const worktreeTicket = await post(`${baseUrl}/api/tickets`, {
      projectId: project.project.id,
      title: "Delete worktree",
      status: "human_review",
      workspaceId: "app-1",
    });
    const rootTicket = await post(`${baseUrl}/api/tickets`, {
      projectId: project.project.id,
      title: "Delete root fallback",
      status: "human_review",
    });
    await postAsUi(`${baseUrl}/api/tickets/${worktreeTicket.ticket.id}/comments`, { body: "delete me" });
    const worktreePath = path.join(workspaceRoot, "App", "app-1");
    createGitRepo(worktreePath);

    const deletedWorktree = await deleteAsUi(`${baseUrl}/api/tickets/${worktreeTicket.ticket.id}`);
    assert.equal(deletedWorktree.deleted.ticketId, worktreeTicket.ticket.id);
    assert.equal(fs.existsSync(worktreePath), false);
    assert.equal(fs.existsSync(repoPath), true);
    assert.equal(deletedWorktree.state.tickets.some((ticket) => ticket.id === worktreeTicket.ticket.id), false);
    assert.equal(deletedWorktree.state.comments?.some?.((comment) => comment.ticketId === worktreeTicket.ticket.id) || false, false);

    const deletedRootFallback = await deleteAsUi(`${baseUrl}/api/tickets/${rootTicket.ticket.id}`);
    assert.equal(deletedRootFallback.deleted.ticketId, rootTicket.ticket.id);
    assert.equal(deletedRootFallback.deleted.artifacts.worktree, null);
    assert.equal(fs.existsSync(repoPath), true);
    assert.equal(deletedRootFallback.state.tickets.some((ticket) => ticket.id === rootTicket.ticket.id), false);
  }, (tmp) => ({ workspaceRoot: path.join(tmp, "worktrees") }));
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
  const actions = { openedPath: "", terminalPath: "", terminal: "", clipboard: "" };
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
      status: "human_review",
      assigneeAgentId: agent.agent.id,
    });

    const opened = await post(`${baseUrl}/api/tickets/${ticket.ticket.id}/open-worktree`, {});
    const expectedWorktree = path.join(tmp, "worktrees", "App", "app-1");
    assert.equal(opened.opened.repoPath, expectedWorktree);
    assert.equal(opened.opened.workspaceSource, "worktree");
    assert.equal(actions.openedPath, expectedWorktree);

    const terminal = await post(`${baseUrl}/api/tickets/${ticket.ticket.id}/resume-terminal`, {});
    assert.equal(terminal.opened.repoPath, expectedWorktree);
    assert.equal(actions.terminalPath, expectedWorktree);
    assert.equal(actions.terminal, "warp");
    assert.equal(actions.clipboard, "thomas ticket reply APP-1 <message>");
    assert.equal(terminal.opened.command, actions.clipboard);
    assert.equal(terminal.opened.terminal, "warp");

    await patchAsUi(`${baseUrl}/api/settings`, { preferredTerminal: "terminal" });
    const defaultTerminal = await post(`${baseUrl}/api/tickets/${ticket.ticket.id}/resume-terminal`, {});
    assert.equal(defaultTerminal.opened.terminal, "terminal");
    assert.equal(actions.terminal, "terminal");

    const oneOffTerminal = await post(`${baseUrl}/api/tickets/${ticket.ticket.id}/resume-terminal`, { terminal: "iterm" });
    assert.equal(oneOffTerminal.opened.terminal, "iterm");
    assert.equal(actions.terminal, "iterm");
  }, {
    systemActions: {
      openPath: (targetPath) => {
        actions.openedPath = targetPath;
      },
      openTerminal: (targetPath, terminal) => {
        actions.terminalPath = targetPath;
        actions.terminal = terminal;
      },
      copyToClipboard: (text) => {
        actions.clipboard = text;
      },
    },
  });
});

test("ticket workspace actions prefer the active run workspace", async () => {
  const actions = { openedPath: "", terminalPath: "" };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "thomas-api-"));
  const service = createThomasService({
    store: createStateStore({ dbPath: path.join(tmp, "thomas.db") }),
  });
  const repoPath = path.join(tmp, "repo");
  const runWorkspace = path.join(tmp, "run-workspace");
  const runs = [];
  const runner = {
    dispatch: (ticketId) => {
      const ticket = service.getState().tickets.find((item) => item.id === ticketId);
      const run = {
        id: `run-${ticketId}-1`,
        ticketId,
        agentId: ticket.assigneeAgentId,
        agentName: "Fake",
        status: "running",
        command: "fake",
        cwd: runWorkspace,
        startedAt: new Date().toISOString(),
        events: [],
      };
      runs.push(run);
      service.updateTicket(ticketId, { status: "in_progress" }, "agent");
      return run;
    },
    getRuns: () => runs,
    stop: (ticketId) => {
      const run = runs.find((item) => item.ticketId === ticketId);
      run.status = "stopped";
      service.updateTicket(ticketId, { status: "todo" }, "agent");
      return run;
    },
    cleanupTicketRuns: () => [],
  };
  const server = await startServer({
    service,
    runner,
    systemActions: {
      openPath: (targetPath) => {
        actions.openedPath = targetPath;
      },
      openTerminal: (targetPath) => {
        actions.terminalPath = targetPath;
      },
      copyToClipboard: () => {},
    },
  });
  try {
    createGitRepo(repoPath);
    createGitRepo(runWorkspace);
    const project = await post(`${server.baseUrl}/api/projects`, { name: "App", prefix: "APP", repoPath });
    const agent = await post(`${server.baseUrl}/api/agents`, {
      name: "Fake",
      type: "custom",
      command: "fake",
    });
    const ticket = await post(`${server.baseUrl}/api/tickets`, {
      projectId: project.project.id,
      title: "Run workspace",
      assigneeAgentId: agent.agent.id,
    });

    assert.equal(ticket.run.status, "running");

    const opened = await post(`${server.baseUrl}/api/tickets/${ticket.ticket.id}/open-worktree`, {});
    assert.equal(opened.opened.repoPath, runWorkspace);
    assert.equal(opened.opened.workspaceSource, "run");
    assert.equal(actions.openedPath, runWorkspace);

    const terminal = await post(`${server.baseUrl}/api/tickets/${ticket.ticket.id}/resume-terminal`, {});
    assert.equal(terminal.opened.repoPath, runWorkspace);
    assert.equal(terminal.opened.workspaceSource, "run");
    assert.equal(actions.terminalPath, runWorkspace);
  } finally {
    await server.close();
  }
});

test("ticket reply CLI posts a human comment and resumes the assigned agent", async () => {
  await withServer(async (baseUrl, tmp) => {
    const repoPath = path.join(tmp, "repo");
    createGitRepo(repoPath);
    const agentScript = path.join(tmp, "fake-agent.js");
    fs.writeFileSync(agentScript, "console.log('SUMMARY: resumed from CLI');");
    const project = await post(`${baseUrl}/api/projects`, { name: "App", prefix: "APP", repoPath });
    const agent = await post(`${baseUrl}/api/agents`, {
      name: "Fake",
      type: "custom",
      command: `${process.execPath} ${agentScript}`,
    });
    const ticket = await post(`${baseUrl}/api/tickets`, {
      projectId: project.project.id,
      title: "Needs reply",
      status: "human_review",
      assigneeAgentId: agent.agent.id,
    });

    const result = await runNode([path.join(__dirname, "../../bin/thomas.js"), "ticket", "reply", ticket.ticket.id, "Please continue"], {
      env: { ...process.env, THOMAS_URL: baseUrl },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /APP-1: comment added/);
    assert.match(result.stdout, /APP-1: resumed Fake/);

    const state = await waitForState(baseUrl, (next) => {
      const updated = next.tickets.find((item) => item.id === ticket.ticket.id);
      const run = next.runs.find((item) => item.ticketId === ticket.ticket.id && item.status === "finished");
      return updated?.comments.some((item) => item.author === "you" && item.body === "Please continue")
        && run?.summary.includes("resumed from CLI");
    });
    const updated = state.tickets.find((item) => item.id === ticket.ticket.id);
    assert.equal(updated.status, "human_review");
    assert.deepEqual(updated.comments.map((item) => item.author), ["you"]);
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

async function runNode(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
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

async function patchAsUi(url, body) {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-thomas-actor": "ui" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  assert.equal(response.status < 400, true, data.error);
  return data;
}

async function deleteAsUi(url) {
  const response = await fetch(url, {
    method: "DELETE",
    headers: { "content-type": "application/json", "x-thomas-actor": "ui" },
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
  assert.equal(spawnSync("git", ["config", "user.email", "thomas@example.test"], { cwd: repoPath, encoding: "utf8" }).status, 0);
  assert.equal(spawnSync("git", ["config", "user.name", "Thomas Test"], { cwd: repoPath, encoding: "utf8" }).status, 0);
  fs.writeFileSync(path.join(repoPath, "README.md"), "# Test\n");
  assert.equal(spawnSync("git", ["add", "README.md"], { cwd: repoPath, encoding: "utf8" }).status, 0);
  const commit = spawnSync("git", ["commit", "-m", "initial"], { cwd: repoPath, encoding: "utf8" });
  assert.equal(commit.status, 0, commit.stderr || commit.stdout);
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
