#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline/promises");
const { spawn, spawnSync } = require("child_process");

const SCRIPT_PATH = fs.realpathSync(__filename);
const ROOT_DIR = path.resolve(path.dirname(SCRIPT_PATH), "..");
const PACKAGE_PATH = path.join(ROOT_DIR, "package.json");
const PACKAGE = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));

const CONFIG_DIR =
  process.env.CONDUCTOR_CLI_HOME ||
  path.join(os.homedir(), ".conductor-cli");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const LOG_DIR = path.join(CONFIG_DIR, "logs");

class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

async function main(argv) {
  const args = argv.slice(2);

  if (args.length === 0) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      await runInteractiveMenu();
    } else {
      printHelp();
    }
    return;
  }

  if (args[0] === "--help" || args[0] === "-h") {
    printHelp();
    return;
  }

  if (args[0] === "--version" || args[0] === "-v") {
    console.log(PACKAGE.version);
    return;
  }

  const command = args[0];
  const rest = args.slice(1);

  switch (command) {
    case "menu":
    case "interactive":
    case "ui":
      await runInteractiveMenu();
      break;
    case "help":
      printHelp(rest[0]);
      break;
    case "doctor":
      commandDoctor();
      break;
    case "project":
    case "projects":
      commandProject(rest);
      break;
    case "register":
      commandProject(["add", ...rest]);
      break;
    case "workspace":
    case "workspaces":
    case "ws":
      commandWorkspace(rest);
      break;
    case "session":
    case "sessions":
      commandSession(rest);
      break;
    case "checks":
    case "check":
      commandChecks(rest);
      break;
    case "pr":
      commandPr(rest);
      break;
    default:
      throw new CliError(`Unknown command: ${command}\nRun conductor-cli --help`);
  }
}

function printHelp(topic) {
  if (topic === "project" || topic === "projects") {
    console.log(`Project commands

Usage:
  conductor-cli project add <name> <repo-path> [--worktrees-dir <dir>] [--base <ref>] [--gh-user <username>]
  conductor-cli project list
  conductor-cli project info <name>
  conductor-cli project remove <name>

Aliases:
  conductor-cli register <name> <repo-path>
`);
    return;
  }

  if (topic === "workspace" || topic === "workspaces" || topic === "ws") {
    console.log(`Workspace commands

Usage:
  conductor-cli workspace create <project> <name> [--branch <branch>] [--base <branch>] [--agent <codex|claude>] [--port <port>] [-- <command>...]
  conductor-cli workspace list [project] [--all]
  conductor-cli workspace status <project> <name>
  conductor-cli workspace path <project> <name>
  conductor-cli workspace remove <project> <name> [--force] [--delete-branch]
  conductor-cli workspace archive <project> <name>

Notes:
  create uses git worktree add. If --agent or a command after -- is provided,
  an agent session is started in the new workspace.
`);
    return;
  }

  if (topic === "session" || topic === "sessions") {
    console.log(`Session commands

Usage:
  conductor-cli session start <project> <workspace> [--agent <codex|claude>] [--name <name>] [--port <port>] [-- <command>...]
  conductor-cli session list [project] [workspace] [--all]
  conductor-cli session stop <session-id>
  conductor-cli session logs <session-id> [--tail <lines>]

Examples:
  conductor-cli session start app auth --agent codex
  conductor-cli session start app auth -- npm test -- --watch
`);
    return;
  }

  if (topic === "pr") {
    console.log(`Pull request commands

Usage:
  conductor-cli pr watch [project] [--once] [--interval <seconds>] [--cleanup] [--force] [--delete-branch]

Behavior:
  Polls gh pr view from each active workspace. When a PR is merged, the
  workspace is marked merged. With --cleanup, running sessions are stopped
  and the git worktree is removed.

Notes:
  Run this command when you want merged-PR cleanup. Use --once for a single
  scan, or leave it running for continuous cleanup.
`);
    return;
  }

  console.log(`conductor-cli ${PACKAGE.version}

Local-first multi-agent workspace management with git worktrees.

Usage:
  conductor-cli
  conductor-cli <command> [options]

Commands:
  menu        Open the interactive selection menu
  project     Register and inspect repositories
  register    Alias for project add
  workspace   Create, inspect, archive, and remove git worktree workspaces
  session     Start, list, stop, and inspect detached agent sessions
  checks      Show git and GitHub PR readiness for a workspace
  pr          Watch PR state and clean up merged workspaces
  doctor      Check local tool availability

Common flow:
  conductor-cli project add app ~/src/app
  conductor-cli workspace create app auth --agent codex
  conductor-cli workspace list app
  conductor-cli checks app auth
  conductor-cli pr watch app --cleanup

Run conductor-cli help <command> for command details.
`);
}

function commandDoctor() {
  const rows = [
    ["git", hasCommand("git") ? "ok" : "missing", "required"],
    ["gh", hasCommand("gh") ? "ok" : "missing", "needed for PR watch/checks"],
    ["codex", hasCommand("codex") ? "ok" : "missing", "optional agent"],
    ["claude", hasCommand("claude") ? "ok" : "missing", "optional agent"],
  ];

  printTable(rows, ["tool", "status", "purpose"]);
  console.log(`config: ${CONFIG_PATH}`);
}

async function runInteractiveMenu() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(`conductor-cli ${PACKAGE.version}`);

  try {
    while (true) {
      const action = await choose(rl, "What do you want to do?", [
        {
          label: "Create workspace",
          value: "create-workspace",
          description: "new branch and worktree for a task",
        },
        {
          label: "Start session",
          value: "start-session",
          description: "launch Codex, Claude, or a command in a workspace",
        },
        {
          label: "Check workspace",
          value: "checks",
          description: "show git and PR state",
        },
        {
          label: "List workspaces",
          value: "list-workspaces",
          description: "show active task worktrees",
        },
        {
          label: "Manage workspace",
          value: "manage-workspace",
          description: "status, path, archive, or remove",
        },
        {
          label: "PR cleanup watch",
          value: "pr-watch",
          description: "scan or watch merged PRs",
        },
        {
          label: "List sessions",
          value: "list-sessions",
          description: "show running or historical sessions",
        },
        {
          label: "Register project",
          value: "register-project",
          description: "add a repo to conductor-cli",
        },
        {
          label: "List projects",
          value: "list-projects",
          description: "show registered repos",
        },
        {
          label: "Doctor",
          value: "doctor",
          description: "check local tool availability",
        },
        {
          label: "Help",
          value: "help",
          description: "show command help",
        },
        { label: "Quit", value: "quit" },
      ]);

      if (action === "quit") break;

      try {
        const keepGoing = await runInteractiveAction(rl, action);
        if (keepGoing === false) break;
      } catch (error) {
        console.error("");
        console.error(formatError(error));
      }

      if (process.stdin.isTTY) {
        await pause(rl);
      }
    }
  } finally {
    rl.close();
  }
}

async function runInteractiveAction(rl, action) {
  console.log("");

  switch (action) {
    case "register-project":
      await interactiveRegisterProject(rl);
      return true;
    case "list-projects":
      projectList();
      return true;
    case "create-workspace":
      await interactiveCreateWorkspace(rl);
      return true;
    case "list-workspaces":
      await interactiveListWorkspaces(rl);
      return true;
    case "manage-workspace":
      await interactiveManageWorkspace(rl);
      return true;
    case "start-session":
      await interactiveStartSession(rl);
      return true;
    case "list-sessions":
      await interactiveListSessions(rl);
      return true;
    case "checks":
      await interactiveChecks(rl);
      return true;
    case "pr-watch":
      return interactivePrWatch(rl);
    case "doctor":
      commandDoctor();
      return true;
    case "help":
      await interactiveHelp(rl);
      return true;
    default:
      throw new CliError(`Unknown menu action: ${action}`);
  }
}

async function interactiveRegisterProject(rl) {
  const defaultRepo = tryRepoRoot(process.cwd()) || process.cwd();
  const defaultName = normalizeName(path.basename(defaultRepo), "project");
  const name = await ask(rl, "Project name", defaultName);
  const repoPath = await ask(rl, "Repo path", defaultRepo);
  const base = await ask(rl, "Base ref", "origin/main");
  const ghUser = await ask(rl, "GitHub username for branch prefix", "");
  const worktreesDir = await ask(
    rl,
    "Worktrees dir",
    defaultWorktreesDir(name),
  );

  const args = [name, repoPath];
  if (worktreesDir) args.push("--worktrees-dir", worktreesDir);
  if (base) args.push("--base", base);
  if (ghUser) args.push("--gh-user", ghUser);
  projectAdd(args);
}

async function interactiveCreateWorkspace(rl) {
  const config = loadConfig();
  const projectName = await selectProject(rl, config);
  if (!projectName) return;

  const project = requireProject(config, projectName);
  const workspaceName = await askRequired(rl, "Workspace name");
  const branch = await ask(
    rl,
    "Branch",
    defaultWorkspaceBranch(project, normalizeName(workspaceName, "workspace")),
  );
  const base = await ask(rl, "Base ref", project.mainBranch || "origin/main");
  const sessionMode = await choose(rl, "Start a session now?", [
    { label: "No", value: "none" },
    { label: "Codex", value: "codex" },
    { label: "Claude", value: "claude" },
    { label: "Custom command", value: "custom" },
  ]);

  const args = [projectName, workspaceName];
  if (branch) args.push("--branch", branch);
  if (base) args.push("--base", base);

  if (sessionMode === "codex" || sessionMode === "claude") {
    args.push("--agent", sessionMode);
    const port = await ask(rl, "CONDUCTOR_PORT", "");
    if (port) args.push("--port", port);
  } else if (sessionMode === "custom") {
    const command = await askRequired(rl, "Command to run");
    const port = await ask(rl, "CONDUCTOR_PORT", "");
    if (port) args.push("--port", port);
    args.push("--", "sh", "-lc", command);
  }

  workspaceCreate(args);
}

async function interactiveListWorkspaces(rl) {
  const config = loadConfig();
  const projectName = await selectProject(rl, config, { allowAll: true });
  if (projectName === null) return;

  const includeAll = await confirm(rl, "Include archived/removed workspaces?", false);
  const args = [];
  if (projectName !== "__all__") args.push(projectName);
  if (includeAll) args.push("--all");
  workspaceList(args);
}

async function interactiveManageWorkspace(rl) {
  const config = loadConfig();
  const projectName = await selectProject(rl, config);
  if (!projectName) return;

  const workspaceName = await selectWorkspace(rl, config, projectName);
  if (!workspaceName) return;

  const action = await choose(rl, "Workspace action", [
    { label: "Status", value: "status" },
    { label: "Print path", value: "path" },
    { label: "Archive", value: "archive" },
    { label: "Remove worktree", value: "remove" },
    { label: "Back", value: "back" },
  ]);

  if (action === "status") {
    workspaceStatus([projectName, workspaceName]);
  } else if (action === "path") {
    workspacePath([projectName, workspaceName]);
  } else if (action === "archive") {
    workspaceArchive([projectName, workspaceName]);
  } else if (action === "remove") {
    const ok = await confirm(
      rl,
      `Remove worktree for ${projectName}/${workspaceName}?`,
      false,
    );
    if (!ok) return;

    const args = [projectName, workspaceName];
    if (await confirm(rl, "Force remove if dirty?", false)) args.push("--force");
    if (await confirm(rl, "Delete local branch too?", false)) {
      args.push("--delete-branch");
    }
    workspaceRemove(args);
  }
}

async function interactiveStartSession(rl) {
  const config = loadConfig();
  const projectName = await selectProject(rl, config);
  if (!projectName) return;

  const workspaceName = await selectWorkspace(rl, config, projectName);
  if (!workspaceName) return;

  const sessionMode = await choose(rl, "Session type", [
    { label: "Codex", value: "codex" },
    { label: "Claude", value: "claude" },
    { label: "Custom command", value: "custom" },
    { label: "Back", value: "back" },
  ]);
  if (sessionMode === "back") return;

  const args = [projectName, workspaceName];
  const name = await ask(rl, "Session name", "");
  const port = await ask(rl, "CONDUCTOR_PORT", "");
  if (name) args.push("--name", name);
  if (port) args.push("--port", port);

  if (sessionMode === "custom") {
    const command = await askRequired(rl, "Command to run");
    args.push("--", "sh", "-lc", command);
  } else {
    args.push("--agent", sessionMode);
  }

  sessionStart(args);
}

async function interactiveListSessions(rl) {
  const config = loadConfig();
  const projectName = await selectProject(rl, config, { allowAll: true });
  if (projectName === null) return;

  const includeAll = await confirm(rl, "Include exited/stopped sessions?", false);
  const args = [];
  if (projectName !== "__all__") args.push(projectName);
  if (includeAll) args.push("--all");
  sessionList(args);
}

async function interactiveChecks(rl) {
  const config = loadConfig();
  const projectName = await selectProject(rl, config);
  if (!projectName) return;

  const workspaceName = await selectWorkspace(rl, config, projectName);
  if (!workspaceName) return;

  commandChecks([projectName, workspaceName]);
}

async function interactivePrWatch(rl) {
  const config = loadConfig();
  const projectName = await selectProject(rl, config, { allowAll: true });
  if (projectName === null) return true;

  const mode = await choose(rl, "PR cleanup mode", [
    { label: "One-shot scan", value: "scan" },
    { label: "One-shot cleanup merged workspaces", value: "cleanup" },
    { label: "Continuous watch", value: "watch" },
    { label: "Continuous cleanup watch", value: "watch-cleanup" },
    { label: "Back", value: "back" },
  ]);
  if (mode === "back") return true;

  const args = ["watch"];
  if (projectName !== "__all__") args.push(projectName);

  if (mode === "scan" || mode === "cleanup") args.push("--once");
  if (mode === "cleanup" || mode === "watch-cleanup") {
    args.push("--cleanup");
    if (await confirm(rl, "Delete local branches after cleanup?", false)) {
      args.push("--delete-branch");
    }
  }
  if (mode === "watch" || mode === "watch-cleanup") {
    const interval = await ask(rl, "Interval seconds", "60");
    if (interval) args.push("--interval", interval);
  }

  commandPr(args);
  return mode === "scan" || mode === "cleanup";
}

async function interactiveHelp(rl) {
  const topic = await choose(rl, "Help topic", [
    { label: "Main help", value: null },
    { label: "Projects", value: "project" },
    { label: "Workspaces", value: "workspace" },
    { label: "Sessions", value: "session" },
    { label: "Pull requests", value: "pr" },
  ]);
  printHelp(topic);
}

async function selectProject(rl, config, options = {}) {
  const projects = Object.values(config.projects).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  if (projects.length === 0) {
    console.log("No projects registered yet.");
    return null;
  }

  const choices = projects.map((project) => ({
    label: project.name,
    value: project.name,
    description: project.repoPath,
  }));
  if (options.allowAll) {
    choices.unshift({
      label: "All projects",
      value: "__all__",
      description: "do not filter by project",
    });
  }

  return choose(rl, "Project", choices);
}

async function selectWorkspace(rl, config, projectName, options = {}) {
  const workspaces = Object.values(config.workspaces[projectName] || {})
    .filter((workspace) => options.all || workspace.status === "active")
    .sort((a, b) => a.name.localeCompare(b.name));

  if (workspaces.length === 0) {
    console.log(`No active workspaces for ${projectName}.`);
    return null;
  }

  return choose(
    rl,
    "Workspace",
    workspaces.map((workspace) => ({
      label: workspace.name,
      value: workspace.name,
      description: `${workspace.branch} (${workspace.status})`,
    })),
  );
}

async function choose(rl, prompt, choices) {
  console.log(prompt);
  choices.forEach((choice, index) => {
    const suffix = choice.description ? ` - ${choice.description}` : "";
    console.log(`  ${index + 1}. ${choice.label}${suffix}`);
  });

  while (true) {
    const answer = (await rl.question("Select: ")).trim();
    const index = Number.parseInt(answer, 10);
    if (Number.isInteger(index) && index >= 1 && index <= choices.length) {
      return choices[index - 1].value;
    }

    const matching = choices.find(
      (choice) => choice.label.toLowerCase() === answer.toLowerCase(),
    );
    if (matching) return matching.value;

    console.log(`Enter a number from 1 to ${choices.length}.`);
  }
}

async function ask(rl, prompt, defaultValue) {
  const suffix =
    defaultValue === undefined || defaultValue === "" ? "" : ` [${defaultValue}]`;
  const answer = (await rl.question(`${prompt}${suffix}: `)).trim();
  return answer || defaultValue || "";
}

async function askRequired(rl, prompt) {
  while (true) {
    const answer = (await ask(rl, prompt, "")).trim();
    if (answer) return answer;
    console.log(`${prompt} is required.`);
  }
}

async function confirm(rl, prompt, defaultValue) {
  const suffix = defaultValue ? " [Y/n]" : " [y/N]";
  const answer = (await rl.question(`${prompt}${suffix}: `)).trim().toLowerCase();
  if (!answer) return defaultValue;
  return answer === "y" || answer === "yes";
}

async function pause(rl) {
  await rl.question("\nPress Enter to continue...");
  console.log("");
}

function formatError(error) {
  if (error instanceof CliError) return error.message;
  return error.stack || error.message || String(error);
}

function commandProject(args) {
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    printHelp("project");
    return;
  }

  switch (sub) {
    case "add":
      projectAdd(args.slice(1));
      break;
    case "list":
    case "ls":
      projectList();
      break;
    case "info":
      projectInfo(args.slice(1));
      break;
    case "remove":
    case "rm":
      projectRemove(args.slice(1));
      break;
    default:
      throw new CliError(`Unknown project command: ${sub}`);
  }
}

function projectAdd(args) {
  const parsed = parseOptions(args, {
    string: ["worktrees-dir", "main", "base", "gh-user"],
  });

  const [name, repoInput] = parsed._;
  if (!name || !repoInput) {
    throw new CliError("Usage: conductor-cli project add <name> <repo-path>");
  }
  validateName(name, "project");

  const repoPath = resolveRepoPath(repoInput);
  const worktreesDir = path.resolve(
    parsed["worktrees-dir"] || defaultWorktreesDir(name),
  );
  const mainBranch = parsed.base || parsed.main || "origin/main";
  const githubUser = parsed["gh-user"] || detectGithubUsername(repoPath);
  const remote = git(repoPath, ["config", "--get", "remote.origin.url"], {
    allowFailure: true,
  }).stdout.trim();

  const config = loadConfig();
  if (config.projects[name]) {
    throw new CliError(`Project already exists: ${name}`);
  }

  config.projects[name] = {
    name,
    repoPath,
    worktreesDir,
    mainBranch,
    githubUser: githubUser || null,
    remote: remote || null,
    createdAt: new Date().toISOString(),
  };
  config.workspaces[name] = config.workspaces[name] || {};
  saveConfig(config);

  console.log(`Registered project ${name}`);
  console.log(`repo: ${repoPath}`);
  console.log(`worktrees: ${worktreesDir}`);
  console.log(`base: ${mainBranch}`);
  console.log(`branch prefix: ${githubUser || "conductor"}/*`);
}

function projectList() {
  const config = loadConfig();
  const rows = Object.values(config.projects).map((project) => {
    const workspaces = Object.values(config.workspaces[project.name] || {});
    const active = workspaces.filter((ws) => ws.status === "active").length;
    return [
      project.name,
      project.repoPath,
      project.mainBranch,
      String(active),
      project.worktreesDir,
    ];
  });

  if (rows.length === 0) {
    console.log("No projects registered.");
    return;
  }

  printTable(rows, ["name", "repo", "base", "active", "worktrees"]);
}

function projectInfo(args) {
  const [name] = args;
  if (!name) throw new CliError("Usage: conductor-cli project info <name>");

  const config = loadConfig();
  const project = requireProject(config, name);
  const workspaces = Object.values(config.workspaces[name] || {});

  console.log(`name: ${project.name}`);
  console.log(`repo: ${project.repoPath}`);
  console.log(`worktrees: ${project.worktreesDir}`);
  console.log(`base: ${project.mainBranch}`);
  console.log(`branch prefix: ${project.githubUser || "conductor"}/*`);
  if (project.remote) console.log(`remote: ${project.remote}`);
  console.log(`workspaces: ${workspaces.length}`);
}

function projectRemove(args) {
  const parsed = parseOptions(args, { boolean: ["force"] });
  const [name] = parsed._;
  if (!name) throw new CliError("Usage: conductor-cli project remove <name>");

  const config = loadConfig();
  requireProject(config, name);

  const active = Object.values(config.workspaces[name] || {}).filter(
    (ws) => ws.status === "active",
  );
  if (active.length > 0 && !parsed.force) {
    throw new CliError(
      `Project ${name} has ${active.length} active workspace(s). Re-run with --force to unregister anyway.`,
    );
  }

  delete config.projects[name];
  delete config.workspaces[name];
  saveConfig(config);
  console.log(`Removed project ${name}`);
}

function commandWorkspace(args) {
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    printHelp("workspace");
    return;
  }

  switch (sub) {
    case "create":
    case "new":
      workspaceCreate(args.slice(1));
      break;
    case "list":
    case "ls":
      workspaceList(args.slice(1));
      break;
    case "status":
      workspaceStatus(args.slice(1));
      break;
    case "path":
      workspacePath(args.slice(1));
      break;
    case "archive":
      workspaceArchive(args.slice(1));
      break;
    case "remove":
    case "rm":
      workspaceRemove(args.slice(1));
      break;
    default:
      throw new CliError(`Unknown workspace command: ${sub}`);
  }
}

function workspaceCreate(args) {
  const parsed = parseOptions(args, {
    string: ["branch", "base", "path", "agent", "session", "port"],
  });

  const [projectName, rawName] = parsed._;
  if (!projectName || !rawName) {
    throw new CliError(
      "Usage: conductor-cli workspace create <project> <name> [options]",
    );
  }

  const workspaceName = normalizeName(rawName, "workspace");
  const config = loadConfig();
  const project = requireProject(config, projectName);
  const projectWorkspaces = config.workspaces[projectName] || {};

  if (projectWorkspaces[workspaceName]?.status === "active") {
    throw new CliError(
      `Workspace already exists: ${projectName}/${workspaceName}`,
    );
  }

  const branch = parsed.branch || defaultWorkspaceBranch(project, workspaceName);
  const base = parsed.base || project.mainBranch || "origin/main";
  const workspacePath = path.resolve(
    parsed.path || path.join(project.worktreesDir, workspaceName),
  );

  if (fs.existsSync(workspacePath) && fs.readdirSync(workspacePath).length > 0) {
    throw new CliError(`Workspace path is not empty: ${workspacePath}`);
  }

  fs.mkdirSync(path.dirname(workspacePath), { recursive: true });

  if (branchExists(project.repoPath, branch)) {
    git(project.repoPath, ["worktree", "add", workspacePath, branch]);
  } else {
    ensureRefExists(project.repoPath, base);
    git(project.repoPath, ["worktree", "add", "-b", branch, workspacePath, base]);
  }

  const actualBranch = getCurrentBranch(workspacePath);
  fs.mkdirSync(path.join(workspacePath, ".context"), { recursive: true });
  addWorktreeExclude(workspacePath, ".context/");

  const workspace = {
    name: workspaceName,
    project: projectName,
    path: workspacePath,
    branch: actualBranch,
    base,
    status: "active",
    createdAt: new Date().toISOString(),
    prUrl: null,
  };

  projectWorkspaces[workspaceName] = workspace;
  config.workspaces[projectName] = projectWorkspaces;
  saveConfig(config);

  console.log(`Created workspace ${projectName}/${workspaceName}`);
  console.log(`branch: ${actualBranch}`);
  console.log(`path: ${workspacePath}`);

  if (parsed.agent || parsed["--"].length > 0) {
    const updatedConfig = loadConfig();
    const session = startSession(updatedConfig, projectName, workspaceName, {
      agent: parsed.agent,
      name: parsed.session,
      port: parsed.port,
      command: parsed["--"],
    });
    saveConfig(updatedConfig);
    console.log(`session: ${session.id}`);
    console.log(`log: ${session.logPath}`);
  }
}

function workspaceList(args) {
  const parsed = parseOptions(args, { boolean: ["all"] });
  const [projectName] = parsed._;
  const config = loadConfig();
  const rows = [];

  for (const project of Object.values(config.projects)) {
    if (projectName && project.name !== projectName) continue;

    for (const workspace of Object.values(config.workspaces[project.name] || {})) {
      if (!parsed.all && workspace.status !== "active") continue;
      rows.push([
        project.name,
        workspace.name,
        workspace.branch,
        workspace.status,
        workspace.prUrl || "",
        workspace.path,
      ]);
    }
  }

  if (rows.length === 0) {
    console.log("No workspaces found.");
    return;
  }

  printTable(rows, ["project", "workspace", "branch", "status", "pr", "path"]);
}

function workspaceStatus(args) {
  const [projectName, workspaceName] = args;
  if (!projectName || !workspaceName) {
    throw new CliError("Usage: conductor-cli workspace status <project> <name>");
  }

  const config = loadConfig();
  const workspace = requireWorkspace(config, projectName, workspaceName);
  printWorkspaceStatus(workspace);
}

function workspacePath(args) {
  const [projectName, workspaceName] = args;
  if (!projectName || !workspaceName) {
    throw new CliError("Usage: conductor-cli workspace path <project> <name>");
  }

  const config = loadConfig();
  const workspace = requireWorkspace(config, projectName, workspaceName);
  console.log(workspace.path);
}

function workspaceArchive(args) {
  const [projectName, workspaceName] = args;
  if (!projectName || !workspaceName) {
    throw new CliError("Usage: conductor-cli workspace archive <project> <name>");
  }

  const config = loadConfig();
  requireWorkspace(config, projectName, workspaceName);
  archiveWorkspace(config, projectName, workspaceName, "archived");
  saveConfig(config);
  console.log(`Archived workspace ${projectName}/${workspaceName}`);
}

function workspaceRemove(args) {
  const parsed = parseOptions(args, {
    boolean: ["force", "delete-branch", "archive-only"],
  });
  const [projectName, workspaceName] = parsed._;
  if (!projectName || !workspaceName) {
    throw new CliError("Usage: conductor-cli workspace remove <project> <name>");
  }

  const config = loadConfig();
  removeWorkspace(config, projectName, workspaceName, {
    force: parsed.force,
    deleteBranch: parsed["delete-branch"],
    archiveOnly: parsed["archive-only"],
    stopSessions: true,
  });
  saveConfig(config);
  console.log(`Removed workspace ${projectName}/${workspaceName}`);
}

function commandSession(args) {
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    printHelp("session");
    return;
  }

  switch (sub) {
    case "start":
      sessionStart(args.slice(1));
      break;
    case "list":
    case "ls":
      sessionList(args.slice(1));
      break;
    case "stop":
      sessionStop(args.slice(1));
      break;
    case "logs":
    case "log":
      sessionLogs(args.slice(1));
      break;
    default:
      throw new CliError(`Unknown session command: ${sub}`);
  }
}

function sessionStart(args) {
  const parsed = parseOptions(args, {
    string: ["agent", "name", "port"],
  });
  const [projectName, workspaceName] = parsed._;
  if (!projectName || !workspaceName) {
    throw new CliError(
      "Usage: conductor-cli session start <project> <workspace> [options]",
    );
  }

  const config = loadConfig();
  const session = startSession(config, projectName, workspaceName, {
    agent: parsed.agent,
    name: parsed.name,
    port: parsed.port,
    command: parsed["--"],
  });
  saveConfig(config);

  console.log(`Started session ${session.id}`);
  console.log(`pid: ${session.pid}`);
  console.log(`cwd: ${session.cwd}`);
  console.log(`log: ${session.logPath}`);
}

function sessionList(args) {
  const parsed = parseOptions(args, { boolean: ["all"] });
  const [projectName, workspaceName] = parsed._;
  const config = loadConfig();
  refreshSessionStates(config);
  saveConfig(config);

  const rows = Object.values(config.sessions)
    .filter((session) => {
      const active =
        session.status === "running" || session.status === "stop_failed";
      if (!parsed.all && !active) return false;
      if (projectName && session.project !== projectName) return false;
      if (workspaceName && session.workspace !== workspaceName) return false;
      return true;
    })
    .map((session) => [
      session.id,
      session.project,
      session.workspace,
      session.agent,
      session.status,
      String(session.pid || ""),
      session.logPath,
    ]);

  if (rows.length === 0) {
    console.log("No sessions found.");
    return;
  }

  printTable(rows, ["id", "project", "workspace", "agent", "status", "pid", "log"]);
}

function sessionStop(args) {
  const [id] = args;
  if (!id) throw new CliError("Usage: conductor-cli session stop <session-id>");

  const config = loadConfig();
  const session = config.sessions[id];
  if (!session) throw new CliError(`Unknown session: ${id}`);

  const stopped = stopSession(session);
  saveConfig(config);
  if (stopped) {
    console.log(`Stopped session ${id}`);
  } else {
    console.log(`Stop signal failed for session ${id}: ${session.stopError}`);
  }
}

function sessionLogs(args) {
  const parsed = parseOptions(args, { string: ["tail"] });
  const [id] = parsed._;
  if (!id) throw new CliError("Usage: conductor-cli session logs <session-id>");

  const config = loadConfig();
  const session = config.sessions[id];
  if (!session) throw new CliError(`Unknown session: ${id}`);
  if (!fs.existsSync(session.logPath)) {
    console.log("");
    return;
  }

  const tail = Number.parseInt(parsed.tail || "100", 10);
  console.log(tailFile(session.logPath, Number.isFinite(tail) ? tail : 100));
}

function commandChecks(args) {
  const [projectName, workspaceName] = args;
  if (!projectName || !workspaceName) {
    throw new CliError("Usage: conductor-cli checks <project> <workspace>");
  }

  const config = loadConfig();
  const workspace = requireWorkspace(config, projectName, workspaceName);
  printWorkspaceStatus(workspace);
  console.log("");
  printPrStatus(workspace);
}

function commandPr(args) {
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    printHelp("pr");
    return;
  }

  switch (sub) {
    case "watch":
      prWatch(args.slice(1));
      break;
    default:
      throw new CliError(`Unknown pr command: ${sub}`);
  }
}

function prWatch(args) {
  const parsed = parseOptions(args, {
    boolean: ["once", "cleanup", "force", "delete-branch"],
    string: ["interval"],
  });
  const [projectName] = parsed._;
  const intervalSeconds = Number.parseInt(parsed.interval || "60", 10);
  const interval = Math.max(10, Number.isFinite(intervalSeconds) ? intervalSeconds : 60);

  if (!hasCommand("gh")) {
    throw new CliError("gh is required for PR watching. Install/authenticate GitHub CLI first.");
  }

  if (projectName) {
    const config = loadConfig();
    requireProject(config, projectName);
  }

  const scan = () => {
    const config = loadConfig();
    const merged = scanMergedPrs(config, {
      projectName,
      cleanup: parsed.cleanup,
      force: parsed.force,
      deleteBranch: parsed["delete-branch"],
    });
    saveConfig(config);

    if (merged.length === 0) {
      console.log(`${new Date().toISOString()} no merged PR workspaces found`);
      return;
    }

    for (const item of merged) {
      const action = item.cleanedUp ? "cleaned up" : "marked merged";
      console.log(
        `${new Date().toISOString()} ${action}: ${item.project}/${item.workspace} ${item.url}`,
      );
    }
  };

  scan();

  if (parsed.once) return;

  console.log(`Watching every ${interval}s. Press Ctrl-C to stop.`);
  setInterval(scan, interval * 1000);
}

function scanMergedPrs(config, options) {
  const results = [];

  for (const project of Object.values(config.projects)) {
    if (options.projectName && project.name !== options.projectName) continue;

    const workspaces = config.workspaces[project.name] || {};
    for (const workspace of Object.values(workspaces)) {
      if (workspace.status !== "active") continue;
      if (!fs.existsSync(workspace.path)) continue;

      const pr = getPr(workspace.path);
      if (!pr || !pr.mergedAt) continue;

      workspace.prUrl = pr.url;
      workspace.prNumber = pr.number;
      workspace.mergedAt = pr.mergedAt;
      workspace.status = "merged";

      let cleanedUp = false;
      if (options.cleanup) {
        removeWorkspace(config, project.name, workspace.name, {
          force: options.force,
          deleteBranch: options.deleteBranch,
          archiveOnly: false,
          stopSessions: true,
          status: "merged",
        });
        cleanedUp = true;
      }

      results.push({
        project: project.name,
        workspace: workspace.name,
        url: pr.url,
        cleanedUp,
      });
    }
  }

  return results;
}

function printWorkspaceStatus(workspace) {
  console.log(`workspace: ${workspace.project}/${workspace.name}`);
  console.log(`status: ${workspace.status}`);
  console.log(`branch: ${workspace.branch}`);
  console.log(`path: ${workspace.path}`);

  if (!fs.existsSync(workspace.path)) {
    console.log("git: workspace path missing");
    return;
  }

  const status = git(workspace.path, ["status", "--short", "--branch"], {
    allowFailure: true,
  });
  if (status.status === 0 && status.stdout.trim()) {
    console.log("");
    console.log(status.stdout.trim());
  }
}

function printPrStatus(workspace) {
  if (!hasCommand("gh")) {
    console.log("pr: gh missing");
    return;
  }

  const pr = getPr(workspace.path);
  if (!pr) {
    console.log("pr: none found for current branch");
    return;
  }

  console.log(`pr: ${pr.url}`);
  console.log(`state: ${pr.state}`);
  console.log(`draft: ${String(Boolean(pr.isDraft))}`);
  if (pr.mergedAt) console.log(`merged: ${pr.mergedAt}`);
}

function startSession(config, projectName, workspaceName, options) {
  const workspace = requireWorkspace(config, projectName, workspaceName);
  if (workspace.status !== "active") {
    throw new CliError(
      `Workspace ${projectName}/${workspaceName} is not active (${workspace.status})`,
    );
  }
  if (!fs.existsSync(workspace.path)) {
    throw new CliError(`Workspace path does not exist: ${workspace.path}`);
  }

  let command = options.command || [];
  let agent = options.agent;

  if (command.length === 0) {
    agent = agent || "codex";
    command = [agent];
  } else {
    agent = agent || command[0];
  }

  if (!hasCommand(command[0])) {
    throw new CliError(`Command not found: ${command[0]}`);
  }

  fs.mkdirSync(LOG_DIR, { recursive: true });
  const sessionName = normalizeName(
    options.name || `${workspace.name}-${agent}`,
    "session",
  );
  const id = uniqueSessionId(config, sessionName);
  const logPath = path.join(LOG_DIR, `${id}.log`);
  const out = fs.openSync(logPath, "a");

  const child = spawn(command[0], command.slice(1), {
    cwd: workspace.path,
    detached: true,
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      CONDUCTOR_PROJECT: projectName,
      CONDUCTOR_WORKSPACE: workspace.name,
      CONDUCTOR_BRANCH: workspace.branch,
      ...(options.port ? { CONDUCTOR_PORT: String(options.port) } : {}),
    },
  });

  child.unref();
  fs.closeSync(out);

  const session = {
    id,
    name: sessionName,
    project: projectName,
    workspace: workspace.name,
    agent,
    command,
    pid: child.pid,
    cwd: workspace.path,
    logPath,
    status: "running",
    startedAt: new Date().toISOString(),
  };

  config.sessions[id] = session;
  return session;
}

function stopSession(session) {
  if (session.status !== "running" || !session.pid) {
    session.status = "stopped";
    session.stoppedAt = new Date().toISOString();
    return true;
  }

  const direct = trySignal(session.pid, "SIGTERM");
  const group =
    direct.ok || direct.code === "ESRCH"
      ? { ok: true }
      : trySignal(-session.pid, "SIGTERM");

  if (!direct.ok && !group.ok && direct.code !== "ESRCH" && group.code !== "ESRCH") {
    session.status = "stop_failed";
    session.stopError = group.message || direct.message || "unknown signal error";
    session.stopFailedAt = new Date().toISOString();
    return false;
  }

  session.status = "stopped";
  session.stoppedAt = new Date().toISOString();
  return true;
}

function trySignal(pid, signal) {
  try {
    process.kill(pid, signal);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      code: error.code,
      message: error.message,
    };
  }
}

function refreshSessionStates(config) {
  for (const session of Object.values(config.sessions)) {
    if (session.status !== "running" && session.status !== "stop_failed") continue;
    if (!isPidRunning(session.pid)) {
      session.status = "exited";
      session.exitedAt = new Date().toISOString();
    }
  }
}

function isPidRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function removeWorkspace(config, projectName, workspaceName, options) {
  const project = requireProject(config, projectName);
  const workspace = requireWorkspace(config, projectName, workspaceName);

  if (options.stopSessions) {
    for (const session of Object.values(config.sessions)) {
      if (
        session.project === projectName &&
        session.workspace === workspace.name &&
        session.status === "running"
      ) {
        stopSession(session);
      }
    }
  }

  if (options.archiveOnly) {
    archiveWorkspace(config, projectName, workspaceName, "archived");
    return;
  }

  if (fs.existsSync(workspace.path)) {
    const args = ["worktree", "remove"];
    if (options.force) args.push("--force");
    args.push(workspace.path);
    git(project.repoPath, args);
  }

  if (options.deleteBranch && workspace.branch) {
    git(project.repoPath, ["branch", "-D", workspace.branch], {
      allowFailure: true,
    });
  }

  workspace.status = options.status || "removed";
  workspace.removedAt = new Date().toISOString();
}

function archiveWorkspace(config, projectName, workspaceName, status) {
  const workspace = requireWorkspace(config, projectName, workspaceName);
  workspace.status = status;
  workspace.archivedAt = new Date().toISOString();
}

function getPr(cwd) {
  const result = run("gh", [
    "pr",
    "view",
    "--json",
    "url,state,mergedAt,headRefName,number,isDraft",
  ], {
    cwd,
    allowFailure: true,
  });

  if (result.status !== 0 || !result.stdout.trim()) return null;

  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    return null;
  }
}

function resolveRepoPath(input) {
  const candidate = path.resolve(expandHome(input));
  if (!fs.existsSync(candidate)) {
    throw new CliError(`Path does not exist: ${candidate}`);
  }

  const result = git(candidate, ["rev-parse", "--show-toplevel"], {
    allowFailure: true,
  });
  if (result.status !== 0) {
    throw new CliError(`Not a git repository: ${candidate}`);
  }

  return path.resolve(result.stdout.trim());
}

function tryRepoRoot(input) {
  const result = git(input, ["rev-parse", "--show-toplevel"], {
    allowFailure: true,
  });
  return result.status === 0 && result.stdout.trim()
    ? path.resolve(result.stdout.trim())
    : null;
}

function defaultWorktreesDir(projectName) {
  return path.join(CONFIG_DIR, "worktrees", projectName);
}

function defaultWorkspaceBranch(project, workspaceName) {
  const username = project.githubUser || detectGithubUsername(project.repoPath);
  const prefix = username ? sanitizeBranchSegment(username) : "conductor";
  return `${prefix}/${sanitizeBranchSegment(workspaceName)}`;
}

function detectGithubUsername(repoPath) {
  const envUser =
    process.env.CONDUCTOR_CLI_GH_USER ||
    process.env.GITHUB_USER ||
    process.env.GH_USER;
  if (envUser) return sanitizeBranchSegment(envUser);

  const configured = git(repoPath, ["config", "--get", "github.user"], {
    allowFailure: true,
  }).stdout.trim();
  if (configured) return sanitizeBranchSegment(configured);

  if (!hasCommand("gh")) return null;

  const ghUser = run("gh", ["api", "user", "--jq", ".login"], {
    cwd: repoPath,
    allowFailure: true,
  }).stdout.trim();
  return ghUser ? sanitizeBranchSegment(ghUser) : null;
}

function addWorktreeExclude(workspacePath, pattern) {
  const result = git(workspacePath, ["rev-parse", "--git-path", "info/exclude"], {
    allowFailure: true,
  });
  if (result.status !== 0 || !result.stdout.trim()) return;

  const excludePath = path.resolve(workspacePath, result.stdout.trim());
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });

  const current = fs.existsSync(excludePath)
    ? fs.readFileSync(excludePath, "utf8")
    : "";
  if (!current.split(/\r?\n/).includes(pattern)) {
    fs.appendFileSync(excludePath, `${current.endsWith("\n") || current === "" ? "" : "\n"}${pattern}\n`);
  }
}

function branchExists(repoPath, branch) {
  const result = git(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    allowFailure: true,
  });
  return result.status === 0;
}

function ensureRefExists(repoPath, ref) {
  const result = git(repoPath, ["rev-parse", "--verify", "--quiet", ref], {
    allowFailure: true,
  });
  if (result.status === 0) return;

  throw new CliError(
    `Base ref not found: ${ref}\nFetch it first or pass --base <ref>.`,
  );
}

function getCurrentBranch(repoPath) {
  const result = git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"], {
    allowFailure: true,
  });
  const branch = result.stdout.trim();
  if (result.status === 0 && branch && branch !== "HEAD") return branch;
  return "main";
}

function git(cwd, args, options = {}) {
  return run("git", ["-C", cwd, ...args], options);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    if (options.allowFailure) {
      return {
        status: 1,
        stdout: "",
        stderr: result.error.message,
      };
    }
    throw new CliError(result.error.message);
  }

  const status = result.status ?? 0;
  const output = {
    status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };

  if (status !== 0 && !options.allowFailure) {
    throw new CliError((output.stderr || output.stdout || `${command} failed`).trim());
  }

  return output;
}

function hasCommand(command) {
  const result = spawnSync("which", [command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0;
}

function parseOptions(args, schema = {}) {
  const strings = new Set(schema.string || []);
  const booleans = new Set(schema.boolean || []);
  const parsed = { _: [], "--": [] };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === "--") {
      parsed["--"] = args.slice(i + 1);
      break;
    }

    if (!arg.startsWith("--") || arg === "-") {
      parsed._.push(arg);
      continue;
    }

    const equals = arg.indexOf("=");
    const key = (equals === -1 ? arg.slice(2) : arg.slice(2, equals)).trim();
    const inlineValue = equals === -1 ? null : arg.slice(equals + 1);

    if (booleans.has(key)) {
      parsed[key] = inlineValue === null ? true : inlineValue !== "false";
      continue;
    }

    if (strings.has(key)) {
      if (inlineValue !== null) {
        parsed[key] = inlineValue;
      } else {
        i += 1;
        if (i >= args.length) throw new CliError(`Missing value for --${key}`);
        parsed[key] = args[i];
      }
      continue;
    }

    throw new CliError(`Unknown option: --${key}`);
  }

  return parsed;
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return {
      version: 1,
      projects: {},
      workspaces: {},
      sessions: {},
    };
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  config.projects = config.projects || {};
  config.workspaces = config.workspaces || {};
  config.sessions = config.sessions || {};
  return config;
}

function saveConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  fs.renameSync(tmp, CONFIG_PATH);
}

function requireProject(config, name) {
  const project = config.projects[name];
  if (!project) throw new CliError(`Unknown project: ${name}`);
  return project;
}

function requireWorkspace(config, projectName, workspaceName) {
  requireProject(config, projectName);
  const workspace = config.workspaces[projectName]?.[workspaceName];
  if (!workspace) {
    throw new CliError(`Unknown workspace: ${projectName}/${workspaceName}`);
  }
  return workspace;
}

function uniqueSessionId(config, base) {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  let id = `${base}-${stamp}`;
  let index = 2;
  while (config.sessions[id]) {
    id = `${base}-${stamp}-${index}`;
    index += 1;
  }
  return id;
}

function validateName(name, label) {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new CliError(
      `${label} names may only contain letters, numbers, dots, underscores, and hyphens: ${name}`,
    );
  }
}

function normalizeName(name, label) {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) throw new CliError(`Invalid ${label} name: ${name}`);
  validateName(normalized, label);
  return normalized;
}

function sanitizeBranchSegment(value) {
  const sanitized = String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .replace(/-+/g, "-");
  if (!sanitized) throw new CliError(`Invalid branch segment: ${value}`);
  return sanitized;
}

function expandHome(input) {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

function tailFile(filePath, lines) {
  const content = fs.readFileSync(filePath, "utf8");
  const parts = content.split(/\r?\n/);
  return parts.slice(Math.max(0, parts.length - lines)).join("\n");
}

function printTable(rows, headers) {
  const widths = headers.map((header, index) =>
    Math.max(
      header.length,
      ...rows.map((row) => String(row[index] ?? "").length),
    ),
  );
  const format = (row) =>
    row
      .map((value, index) => String(value ?? "").padEnd(widths[index]))
      .join("  ");

  console.log(format(headers));
  console.log(format(headers.map((header, index) => "-".repeat(widths[index]))));
  for (const row of rows) console.log(format(row));
}

function handleFatalError(error) {
  if (error instanceof CliError) {
    console.error(error.message);
    process.exit(error.exitCode);
  }
  console.error(error.stack || error.message);
  process.exit(1);
}

main(process.argv).catch(handleFatalError);
