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

test("project add --setup-script stores script contents in thomas config", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "thomas-setup-add-"));
  const home = path.join(tmp, "home");
  const repo = makeGitRepo(path.join(tmp, "repo"));
  const setupPath = path.join(tmp, "setup.sh");
  fs.writeFileSync(setupPath, "#!/bin/sh\necho configured > setup-output.txt\n");

  run(["project", "add", "app", repo, "--base", "main", "--setup-script", setupPath], { home });

  const config = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.equal(config.projects.app.setupScript.content, "#!/bin/sh\necho configured > setup-output.txt\n");
  assert.equal(config.projects.app.setupScript.source, setupPath);
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

  const config = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.equal(config.projects.app.setupScript.content, script);
  assert.equal(config.projects.app.setupScript.source, "-");
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
  let config = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.equal(config.projects.app.setupScript.content, "#!/bin/sh\necho updated\n");

  run(["project", "set-setup-script", "app", "none"], { home });
  config = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.equal(config.projects.app.setupScript, null);
});
