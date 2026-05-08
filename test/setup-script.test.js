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
    env: { ...process.env, THOMAS_CLI_HOME: options.home },
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

test("kanban create makes a numbered workspace-backed ticket", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "thomas-kanban-create-"));
  const home = path.join(tmp, "home");
  const repo = makeGitRepo(path.join(tmp, "repo"));

  run(["project", "add", "app", repo, "--base", "main", "--identifier", "APP"], { home });
  run(["kanban", "--create", "app", "First ticket"], { home });
  run(["kanban", "--create", "app", "Second ticket", "--status", "In Progress"], { home });

  const project = projectState(home, "app");
  const first = workspaceState(home, "app", "app-1");
  const second = workspaceState(home, "app", "app-2");
  assert.equal(project.identifier, "APP");
  assert.equal(project.kanbanNextNumber, 3);
  assert.equal(first.kanban.number, 1);
  assert.equal(first.kanban.title, "First ticket");
  assert.equal(first.kanban.status, "To-do");
  assert.equal(second.kanban.status, "In Progress");
  assert.equal(first.branch, "thomas/app-1");
});

test("kanban status moves a ticket manually", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "thomas-kanban-status-"));
  const home = path.join(tmp, "home");
  const repo = makeGitRepo(path.join(tmp, "repo"));

  run(["project", "add", "app", repo, "--base", "main", "--identifier", "APP"], { home });
  run(["kanban", "create", "app", "Review this"], { home });
  run(["kanban", "status", "APP-1", "PR Review"], { home });

  assert.equal(workspaceState(home, "app", "app-1").kanban.status, "PR Review");
});

test("kanban descriptions can only be edited while todo", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "thomas-kanban-description-"));
  const home = path.join(tmp, "home");
  const repo = makeGitRepo(path.join(tmp, "repo"));

  run(["project", "add", "app", repo, "--base", "main", "--identifier", "APP"], { home });
  run(["kanban", "create", "app", "Describe this", "--description", "initial"], { home });
  run(["kanban", "description", "APP-1", "updated"], { home });
  run(["kanban", "status", "APP-1", "In Progress"], { home });
  const blocked = run(["kanban", "description", "APP-1", "blocked"], {
    home,
    allowFailure: true,
  });

  assert.equal(workspaceState(home, "app", "app-1").kanban.description, "updated");
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /only be edited while status is To-do/);
});
