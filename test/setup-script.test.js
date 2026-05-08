"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const CLI = path.resolve(__dirname, "..", "bin", "thomas.js");

function run(args, options = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env || {}), THOMAS_CLI_HOME: options.home },
    encoding: "utf8",
    input: options.input,
  });
  if (options.allowFailure) return result;
  assert.equal(
    result.status,
    0,
    `command failed: thomas ${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result;
}

function state(home) {
  return JSON.parse(run(["state"], { home }).stdout);
}

function stateWithEnv(home, env) {
  return JSON.parse(run(["state"], { home, env }).stdout);
}

function projectState(home, name) {
  const project = state(home).projects.find((item) => item.name === name);
  assert.ok(project, `expected project ${name}`);
  return project;
}

function workspaceState(home, project, name) {
  const workspace = state(home).workspaces.find(
    (item) => item.project === project && item.name === name,
  );
  assert.ok(workspace, `expected workspace ${project}/${name}`);
  return workspace;
}

function ticketState(home, id) {
  const ticket = state(home).kanban.tickets.find((item) => item.id === id);
  assert.ok(ticket, `expected ticket ${id}`);
  return ticket;
}

function makeGitRepo(root) {
  fs.mkdirSync(root, { recursive: true });
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test User"]);
  fs.writeFileSync(path.join(root, "README.md"), "# fixture\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "initial"]);
  return root;
}

function makeMockAgent(root, body = "") {
  const agentPath = path.join(root, "mock-agent.js");
  fs.writeFileSync(agentPath, `#!/usr/bin/env node
const fs = require("node:fs");
const prompt = process.env.THOMAS_AGENT_PROMPT_FILE ? fs.readFileSync(process.env.THOMAS_AGENT_PROMPT_FILE, "utf8") : "";
fs.appendFileSync("agent-prompts.log", prompt + "\\n---\\n");
${body || 'console.log("SUMMARY:\\nchanged files\\nran checks");'}
`);
  fs.chmodSync(agentPath, 0o755);
  return agentPath;
}

function makeFakeGh(root, json) {
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const ghPath = path.join(bin, "gh");
  fs.writeFileSync(ghPath, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(json).replace(/'/g, "'\"'\"'")}'\n`);
  fs.chmodSync(ghPath, 0o755);
  return bin;
}

function waitFor(fn, message) {
  const deadline = Date.now() + 5000;
  let last;
  while (Date.now() < deadline) {
    last = fn();
    if (last) return last;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  assert.ok(last, message);
}

test("project add --setup-script stores script contents in thomas state", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "thomas-setup-add-"));
  const home = path.join(tmp, "home");
  const repo = makeGitRepo(path.join(tmp, "repo"));
  const setupPath = path.join(tmp, "setup.sh");
  fs.writeFileSync(setupPath, "#!/bin/sh\necho configured > setup-output.txt\n");

  run(["project", "add", "app", repo, "--base", "main", "--setup-script", setupPath], { home });

  const project = projectState(home, "app");
  assert.equal(project.setupScript.content, "#!/bin/sh\necho configured > setup-output.txt\n");
  assert.equal(project.setupScript.source, setupPath);
});

test("project add --setup-script - stores script contents from stdin", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "thomas-setup-stdin-"));
  const home = path.join(tmp, "home");
  const repo = makeGitRepo(path.join(tmp, "repo"));
  const script = "echo stdin-script > setup-output.txt\n";

  run(["project", "add", "app", repo, "--base", "main", "--setup-script", "-"], {
    home,
    input: script,
  });

  const project = projectState(home, "app");
  assert.equal(project.setupScript.content, script);
  assert.equal(project.setupScript.source, "-");
});

test("workspace create runs the stored setup script in the new worktree", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "thomas-setup-run-"));
  const home = path.join(tmp, "home");
  const repo = makeGitRepo(path.join(tmp, "repo"));
  const setupPath = path.join(tmp, "setup.sh");
  fs.writeFileSync(
    setupPath,
    "#!/bin/sh\nprintf '%s/%s/%s' \"$THOMAS_PROJECT\" \"$THOMAS_WORKSPACE\" \"$(pwd)\" > setup-output.txt\n",
  );

  run(["project", "add", "app", repo, "--base", "main", "--setup-script", setupPath], { home });
  run(["workspace", "create", "app", "feature", "--base", "main", "--detach"], { home });

  const workspacePath = fs.realpathSync(path.join(home, "worktrees", "app", "feature"));
  assert.equal(
    fs.readFileSync(path.join(workspacePath, "setup-output.txt"), "utf8"),
    `app/feature/${workspacePath}`,
  );
});

test("project set-setup-script updates and clears scripts for existing projects", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "thomas-setup-set-"));
  const home = path.join(tmp, "home");
  const repo = makeGitRepo(path.join(tmp, "repo"));
  const setupPath = path.join(tmp, "setup.sh");
  fs.writeFileSync(setupPath, "#!/bin/sh\necho updated\n");

  run(["project", "add", "app", repo, "--base", "main"], { home });
  run(["project", "set-setup-script", "app", setupPath], { home });
  assert.equal(projectState(home, "app").setupScript.content, "#!/bin/sh\necho updated\n");

  run(["project", "set-setup-script", "app", "none"], { home });
  assert.equal(projectState(home, "app").setupScript, null);
});

test("state migrates legacy config json into sqlite", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "thomas-state-migrate-"));
  const home = path.join(tmp, "home");
  const repo = makeGitRepo(path.join(tmp, "repo"));
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, "config.json"),
    `${JSON.stringify({
      version: 1,
      projects: {
        app: {
          name: "app",
          repoPath: repo,
          worktreesDir: path.join(home, "worktrees", "app"),
          mainBranch: "main",
          identifier: "APP",
          kanbanNextNumber: 1,
          githubUser: "thomas",
          agentProfile: null,
          setupScript: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      },
      workspaces: {},
      sessions: {},
      settings: {},
    })}\n`,
  );

  assert.equal(projectState(home, "app").identifier, "APP");
  assert.ok(fs.existsSync(path.join(home, "thomas.db")));
});

test("agent profiles store type and default launch command", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "thomas-agent-profile-"));
  const home = path.join(tmp, "home");

  run(["agent-profile", "add", "reviewer", "--type", "codex"], { home });
  run(["agent-profile", "default", "reviewer"], { home });

  const profileState = state(home);
  assert.equal(profileState.settings.agentProfiles.default, "reviewer");
  assert.equal(profileState.settings.agentProfiles.profiles.reviewer.type, "codex");
  assert.equal(profileState.settings.agentProfiles.profiles.reviewer.command, "codex");
  assert.equal(profileState.settings.agentProfiles.profiles.claude.type, "claude");
  assert.equal(profileState.settings.agentProfiles.profiles.codex.type, "codex");
});

test("agent log preference controls ticket agent launch flags", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "thomas-agent-log-pref-"));
  const home = path.join(tmp, "home");
  const repo = makeGitRepo(path.join(tmp, "repo"));
  const agent = makeMockAgent(tmp);

  run(["settings", "agent-logs", "off"], { home });
  run(["agent-profile", "add", "bot", agent, "--type", "codex"], { home });
  run(["project", "add", "app", repo, "--base", "main", "--identifier", "APP", "--agent-profile", "bot"], { home });
  run(["kanban", "create", "app", "Quiet run"], { home });
  waitFor(() => ticketState(home, "APP-1").agentRun?.status === "done", "expected quiet run");

  const appState = state(home);
  assert.equal(appState.settings.preferences.showAgentLogs, false);
  const session = appState.sessions.find((item) => item.ticketId === "APP-1");
  assert.ok(session);
  assert.deepEqual(session.command.slice(1, 2), ["exec"]);
  assert.equal(session.command.includes("--json"), false);
});

test("kanban create makes a numbered workspace-backed ticket", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "thomas-kanban-create-"));
  const home = path.join(tmp, "home");
  const repo = makeGitRepo(path.join(tmp, "repo"));

  run(["project", "add", "app", repo, "--base", "main", "--identifier", "APP"], { home });
  run(["kanban", "--create", "app", "First ticket", "--no-run"], { home });
  run(["kanban", "--create", "app", "Second ticket", "--status", "In Progress", "--no-run"], { home });

  const project = projectState(home, "app");
  const first = workspaceState(home, "app", "app-1");
  const second = workspaceState(home, "app", "app-2");
  assert.equal(project.identifier, "APP");
  assert.equal(project.kanbanNextNumber, 3);
  assert.equal(first.kanban.number, 1);
  assert.equal(first.kanban.title, "First ticket");
  assert.equal(first.kanban.status, "To-do");
  assert.equal(second.kanban.status, "To-do");
  assert.equal(first.branch, "thomas/app-1");
});

test("kanban status is derived instead of manually controlled in app state", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "thomas-kanban-status-"));
  const home = path.join(tmp, "home");
  const repo = makeGitRepo(path.join(tmp, "repo"));

  run(["project", "add", "app", repo, "--base", "main", "--identifier", "APP"], { home });
  run(["kanban", "create", "app", "Review this", "--no-run"], { home });
  run(["kanban", "status", "APP-1", "PR Review"], { home });

  assert.equal(ticketState(home, "APP-1").status, "To-do");
});

test("kanban descriptions can be edited while todo", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "thomas-kanban-description-"));
  const home = path.join(tmp, "home");
  const repo = makeGitRepo(path.join(tmp, "repo"));

  run(["project", "add", "app", repo, "--base", "main", "--identifier", "APP"], { home });
  run(["kanban", "create", "app", "Describe this", "--description", "initial", "--no-run"], { home });
  run(["kanban", "description", "APP-1", "updated"], { home });

  assert.equal(workspaceState(home, "app", "app-1").kanban.description, "updated");
});

test("ticket assignee can change only while todo", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "thomas-ticket-assign-"));
  const home = path.join(tmp, "home");
  const repo = makeGitRepo(path.join(tmp, "repo"));
  const agent = makeMockAgent(tmp);

  run(["agent-profile", "add", "bot", agent, "--type", "codex"], { home });
  run(["project", "add", "app", repo, "--base", "main", "--identifier", "APP"], { home });
  run(["kanban", "create", "app", "Assignable", "--no-run"], { home });
  run(["ticket", "assign", "APP-1", "bot"], { home });
  assert.equal(ticketState(home, "APP-1").assignedAgentProfile, "bot");

  run(["ticket", "run", "APP-1"], { home });
  const blocked = run(["ticket", "assign", "APP-1", "claude"], {
    home,
    allowFailure: true,
  });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /only be changed while status is To-do/);
});

test("kanban create auto-runs the project default ticket agent", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "thomas-ticket-agent-"));
  const home = path.join(tmp, "home");
  const repo = makeGitRepo(path.join(tmp, "repo"));
  const agent = makeMockAgent(tmp);

  run(["agent-profile", "add", "bot", agent, "--type", "codex"], { home });
  run(["project", "add", "app", repo, "--base", "main", "--identifier", "APP", "--agent-profile", "bot"], { home });
  run(["kanban", "create", "app", "Implement auto run"], { home });

  waitFor(() => {
    const ticket = ticketState(home, "APP-1");
    return ticket.status === "Human Review" && ticket.comments.length > 0 ? ticket : null;
  }, "expected completed agent run");

  const ticket = ticketState(home, "APP-1");
  assert.equal(ticket.assignedAgentProfile, "bot");
  assert.equal(ticket.agentRun.status, "done");
  assert.equal(ticket.comments.at(-1).kind, "summary");
  assert.match(ticket.comments.at(-1).body, /changed files/);
});

test("ticket reply stores human reply and resumes the prior agent context", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "thomas-ticket-reply-"));
  const home = path.join(tmp, "home");
  const repo = makeGitRepo(path.join(tmp, "repo"));
  const agent = makeMockAgent(tmp);

  run(["agent-profile", "add", "bot", agent, "--type", "codex"], { home });
  run(["project", "add", "app", repo, "--base", "main", "--identifier", "APP", "--agent-profile", "bot"], { home });
  run(["kanban", "create", "app", "Need iteration"], { home });
  waitFor(() => {
    const ticket = ticketState(home, "APP-1");
    return ticket.agentRun?.status === "done" && ticket.status === "Human Review" ? ticket : null;
  }, "expected first run");

  run(["ticket", "reply", "APP-1", "Please continue with the existing approach"], { home });
  waitFor(() => {
    const ticket = ticketState(home, "APP-1");
    return ticket.comments.filter((comment) => comment.kind === "summary").length >= 2 ? ticket : null;
  }, "expected resumed run");

  const ticket = ticketState(home, "APP-1");
  assert.ok(ticket.comments.some((comment) => comment.author === "human" && /Please continue/.test(comment.body)));
  const resumedSession = state(home).sessions.find((session) => session.id === ticket.agentRun.sessionId);
  assert.deepEqual(resumedSession.command.slice(1, 5), ["exec", "resume", "--json", "--last"]);
  const workspace = workspaceState(home, "app", "app-1");
  const promptLog = fs.readFileSync(path.join(workspace.path, "agent-prompts.log"), "utf8");
  assert.match(promptLog, /Latest human reply:\nPlease continue with the existing approach/);
});

test("ticket reply is rejected while agent is running", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "thomas-ticket-reply-running-"));
  const home = path.join(tmp, "home");
  const repo = makeGitRepo(path.join(tmp, "repo"));
  const agent = makeMockAgent(tmp, 'setInterval(() => {}, 1000);');

  run(["agent-profile", "add", "bot", agent, "--type", "codex"], { home });
  run(["project", "add", "app", repo, "--base", "main", "--identifier", "APP", "--agent-profile", "bot"], { home });
  run(["kanban", "create", "app", "Still running"], { home });
  waitFor(() => ticketState(home, "APP-1").status === "In Progress", "expected running ticket");

  const result = run(["ticket", "reply", "APP-1", "Please keep going"], {
    home,
    allowFailure: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only available in Human Review/);

  run(["ticket", "delete", "APP-1"], { home });
});

test("blocked ticket agent posts blocked reason", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "thomas-ticket-blocked-"));
  const home = path.join(tmp, "home");
  const repo = makeGitRepo(path.join(tmp, "repo"));
  const agent = makeMockAgent(tmp, 'console.log("BLOCKED: missing API token"); process.exit(2);');

  run(["agent-profile", "add", "bot", agent, "--type", "codex"], { home });
  run(["project", "add", "app", repo, "--base", "main", "--identifier", "APP", "--agent-profile", "bot"], { home });
  run(["kanban", "create", "app", "Blocked work"], { home });

  waitFor(() => ticketState(home, "APP-1").agentRun?.status === "blocked", "expected blocked run");
  const ticket = ticketState(home, "APP-1");
  assert.equal(ticket.status, "Human Review");
  assert.equal(ticket.comments.at(-1).kind, "blocked");
  assert.match(ticket.comments.at(-1).body, /missing API token/);
});

test("ticket delete removes workspace and stops associated agent", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "thomas-ticket-delete-"));
  const home = path.join(tmp, "home");
  const repo = makeGitRepo(path.join(tmp, "repo"));
  const agent = makeMockAgent(tmp, 'setInterval(() => {}, 1000);');

  run(["agent-profile", "add", "bot", agent, "--type", "codex"], { home });
  run(["project", "add", "app", repo, "--base", "main", "--identifier", "APP", "--agent-profile", "bot"], { home });
  run(["kanban", "create", "app", "Delete me"], { home });
  const running = waitFor(() => {
    const ticket = ticketState(home, "APP-1");
    return ticket.agentRun?.status === "running" ? ticket : null;
  }, "expected running agent before delete");
  const workspacePath = workspaceState(home, "app", "app-1").path;
  const runningSession = state(home).sessions.find((item) => item.id === running.agentRun.sessionId);
  assert.ok(runningSession);
  assert.ok(fs.existsSync(runningSession.logPath));
  assert.ok(fs.existsSync(runningSession.wrapperPath));
  assert.ok(fs.existsSync(runningSession.promptPath));

  run(["ticket", "delete", "APP-1"], { home });

  const appState = state(home);
  assert.equal(appState.kanban.tickets.some((ticket) => ticket.id === "APP-1"), false);
  assert.equal(appState.workspaces.some((workspace) => workspace.project === "app" && workspace.name === "app-1"), false);
  assert.equal(fs.existsSync(workspacePath), false);
  assert.equal(appState.sessions.some((item) => item.id === running.agentRun.sessionId), false);
  assert.equal(fs.existsSync(runningSession.logPath), false);
  assert.equal(fs.existsSync(runningSession.statusPath), false);
  assert.equal(fs.existsSync(runningSession.wrapperPath), false);
  assert.equal(fs.existsSync(runningSession.promptPath), false);
});

test("merged PR moves ticket to done and cleans up the worktree", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "thomas-ticket-pr-"));
  const home = path.join(tmp, "home");
  const repo = makeGitRepo(path.join(tmp, "repo"));
  const fakeBin = makeFakeGh(tmp, {
    url: "https://github.com/example/app/pull/1",
    state: "MERGED",
    mergedAt: "2026-05-08T12:00:00Z",
    headRefName: "thomas/app-1",
    number: 1,
    isDraft: false,
  });
  const env = { PATH: `${fakeBin}:${process.env.PATH}` };

  run(["project", "add", "app", repo, "--base", "main", "--identifier", "APP"], { home, env });
  run(["kanban", "create", "app", "Merge cleanup", "--no-run"], { home, env });
  assert.ok(fs.existsSync(path.join(home, "worktrees", "app", "app-1")));

  const appState = stateWithEnv(home, env);
  const ticket = appState.kanban.tickets.find((item) => item.id === "APP-1");
  const workspace = appState.workspaces.find((item) => item.project === "app" && item.name === "app-1");
  assert.equal(ticket.status, "Done");
  assert.equal(workspace.status, "merged");
  assert.equal(workspace.prUrl, "https://github.com/example/app/pull/1");
  assert.equal(fs.existsSync(workspace.path), false);
});
