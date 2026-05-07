#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const readlineCore = require("readline");
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
const HOOKS_DIR = path.join(CONFIG_DIR, "hooks");
const HOOK_SCRIPT_PATH = path.join(HOOKS_DIR, "agent-notify.js");
const NOTIFIER_SOURCE_PATH = path.join(HOOKS_DIR, "ConductorNotifier.swift");
const NOTIFIER_EXECUTABLE_PATH = path.join(HOOKS_DIR, "conductor-notifier");
const SWIFT_MODULE_CACHE_DIR = path.join(HOOKS_DIR, "swift-module-cache");

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
    case "state":
      commandState(rest);
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
    case "claude-profile":
    case "claude-profiles":
      commandClaudeProfile(rest);
      break;
    case "settings":
    case "setting":
      commandSettings(rest);
      break;
    default:
      throw new CliError(`Unknown command: ${command}\nRun conductor-cli --help`);
  }
}

function printHelp(topic) {
  if (topic === "project" || topic === "projects") {
    console.log(`Project commands

Usage:
  conductor-cli project add <name> <repo-path> [--worktrees-dir <dir>] [--base <ref>] [--gh-user <username>] [--claude-profile <profile>]
  conductor-cli project list
  conductor-cli project info <name>
  conductor-cli project set-claude-profile <name> <profile|default|none>
  conductor-cli project remove <name>

Aliases:
  conductor-cli register <name> <repo-path>
`);
    return;
  }

  if (topic === "workspace" || topic === "workspaces" || topic === "ws") {
    console.log(`Workspace commands

Usage:
  conductor-cli workspace create <project> <name> [--base <branch>] [--agent <codex|claude>] [--port <port>] [--terminal <auto|terminal|iterm|warp>] [--attach|--detach] [-- <command>...]
  conductor-cli workspace list [project] [--all]
  conductor-cli workspace status <project> <name>
  conductor-cli workspace path <project> <name>
  conductor-cli workspace remove <project> <name> [--force] [--delete-branch]
  conductor-cli workspace archive <project> <name>

Notes:
  create uses git worktree add. If --agent or a command after -- is provided,
  a session is prepared and a terminal tab is opened by default.
  The workspace name determines the branch: <github-user>/<workspace>.
`);
    return;
  }

  if (topic === "session" || topic === "sessions") {
    console.log(`Session commands

Usage:
  conductor-cli session start <project> <workspace> [--agent <codex|claude>] [--name <name>] [--port <port>] [--terminal <auto|terminal|iterm|warp>] [--attach|--detach] [-- <command>...]
  conductor-cli session run <session-id>
  conductor-cli session resume <session-id>
  conductor-cli session list [project] [workspace] [--all]
  conductor-cli session stop <session-id>
  conductor-cli session logs <session-id> [--tail <lines>]

Examples:
  conductor-cli session start app auth --agent codex
  conductor-cli session start app auth --agent claude --terminal warp
  conductor-cli session start app auth --agent codex --detach
  conductor-cli session start app auth -- npm test -- --watch

Notes:
  Codex and Claude prepare a session and open a terminal tab by default.
  Run the printed conductor-cli session run command inside that terminal to
  start the agent with conductor's project/workspace environment.
  Resume uses the agent's native resume command when supported.
  Use --detach for background log mode, or --attach to run immediately in the
  current terminal.
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

  if (topic === "claude-profile" || topic === "claude-profiles") {
    console.log(`Claude profile commands

Usage:
  conductor-cli claude-profile add <name> <command>
  conductor-cli claude-profile list
  conductor-cli claude-profile default <name>
  conductor-cli claude-profile remove <name>
  conductor-cli claude-profile resolve [project]

Examples:
  conductor-cli claude-profile add personal claude
  conductor-cli claude-profile add work claude-work
  conductor-cli claude-profile default personal
  conductor-cli project set-claude-profile app work

Behavior:
  Projects use their assigned Claude profile. If no project profile is set,
  conductor-cli uses the default Claude profile. If no default is configured,
  the command is claude.
`);
    return;
  }

  if (topic === "settings" || topic === "setting") {
    console.log(`Settings commands

Usage:
  conductor-cli settings show
  conductor-cli settings notifications on|off
  conductor-cli settings sound <sound-name|none>
  conductor-cli settings terminal <auto|terminal|iterm|warp|warppreview>
  conductor-cli settings macos-notification on|off
  conductor-cli settings hooks status
  conductor-cli settings hooks install <claude|codex|all>
  conductor-cli settings hooks remove <claude|codex|all>
  conductor-cli settings test

Notes:
  Claude uses Stop and SubagentStop hooks.
  Codex uses its notify command from ~/.codex/config.toml.
  Hook notifications default to conductor-launched sessions only.
  Terminal controls which app conductor-cli uses for new agent tabs.
`);
    return;
  }

  if (topic === "state") {
    console.log(`State command

Usage:
  conductor-cli state

Notes:
  Prints the normalized conductor-cli state as JSON for GUI and automation
  clients. The CLI config remains the source of truth.
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
  session     Start, list, stop, and inspect agent sessions
  checks      Show git and GitHub PR readiness for a workspace
  pr          Watch PR state and clean up merged workspaces
  claude-profile
               Configure named Claude command profiles
  settings    Configure agent completion hooks and sounds
  state       Print JSON state for app integrations
  doctor      Check local tool availability

Common flow:
  conductor-cli project add app ~/src/app
  conductor-cli workspace create app auth --agent codex
  conductor-cli workspace list app
  conductor-cli checks app auth
  conductor-cli pr watch app --cleanup

Codex and Claude sessions prepare a terminal tab by default.

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

function commandState(args) {
  if (args[0] === "--help" || args[0] === "-h") {
    printHelp("state");
    return;
  }

  if (args.length > 0) {
    throw new CliError("Usage: conductor-cli state");
  }

  const config = loadConfig();
  refreshSessionStates(config);
  saveConfig(config);
  console.log(JSON.stringify(buildAppState(config), null, 2));
}

function buildAppState(config) {
  return {
    version: config.version,
    cliVersion: PACKAGE.version,
    generatedAt: new Date().toISOString(),
    configPath: CONFIG_PATH,
    projects: Object.values(config.projects).sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
    workspaces: Object.values(config.workspaces)
      .flatMap((workspaces) => Object.values(workspaces))
      .sort((a, b) =>
        `${a.project}/${a.name}`.localeCompare(`${b.project}/${b.name}`),
      ),
    sessions: Object.values(config.sessions).map(appSessionState).sort((a, b) =>
      String(b.startedAt || b.openedAt || b.resumedAt || "").localeCompare(
        String(a.startedAt || a.openedAt || a.resumedAt || ""),
      ),
    ),
    settings: config.settings,
  };
}

function appSessionState(session) {
  return {
    ...session,
    commandText: Array.isArray(session.command) ? shellJoin(session.command) : "",
    runCommand: session.runCommand || sessionRunCommand(session.id),
    resumeCommand: sessionResumeCommand(session),
  };
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
          label: "Settings",
          value: "settings",
          description: "configure agent completion hooks",
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
    case "settings":
      await interactiveSettings(rl);
      return true;
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

async function askSessionLaunchMode(rl) {
  return choose(rl, "Launch mode", [
    {
      label: "New terminal tab",
      value: "terminal",
      description: "open workspace and print the command to run",
    },
    {
      label: "Current terminal",
      value: "attach",
      description: "use this pane until the command exits",
    },
    {
      label: "Background log",
      value: "detach",
      description: "no interactive terminal",
    },
  ]);
}

function appendLaunchArgs(args, launchMode, terminalApp = "auto") {
  if (launchMode === "terminal") {
    args.push("--terminal", terminalApp);
  } else if (launchMode === "attach") {
    args.push("--attach");
  } else if (launchMode === "detach") {
    args.push("--detach");
  }
}

async function interactiveCreateWorkspace(rl) {
  const config = loadConfig();
  const projectName = await selectProject(rl, config);
  if (!projectName) return;

  const project = requireProject(config, projectName);
  const workspaceName = await askRequired(rl, "Workspace name");
  const branch = defaultWorkspaceBranch(
    project,
    normalizeName(workspaceName, "workspace"),
  );
  console.log(`Branch: ${branch}`);
  const base = await ask(rl, "Base ref", project.mainBranch || "origin/main");
  const sessionMode = await choose(rl, "Start a session now?", [
    { label: "No", value: "none" },
    { label: "Codex", value: "codex" },
    { label: "Claude", value: "claude" },
    { label: "Custom command", value: "custom" },
  ]);

  const args = [projectName, workspaceName];
  if (base) args.push("--base", base);
  let customCommand = null;

  if (sessionMode === "codex" || sessionMode === "claude") {
    args.push("--agent", sessionMode);
    const port = await ask(rl, "CONDUCTOR_PORT", "");
    if (port) args.push("--port", port);
  } else if (sessionMode === "custom") {
    const command = await askRequired(rl, "Command to run");
    const port = await ask(rl, "CONDUCTOR_PORT", "");
    if (port) args.push("--port", port);
    customCommand = ["sh", "-lc", command];
  }

  if (sessionMode !== "none") {
    appendLaunchArgs(
      args,
      await askSessionLaunchMode(rl),
      config.settings.terminalApp,
    );
    if (customCommand) args.push("--", ...customCommand);
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
  let customCommand = null;

  if (sessionMode === "custom") {
    const command = await askRequired(rl, "Command to run");
    customCommand = ["sh", "-lc", command];
  } else {
    args.push("--agent", sessionMode);
  }

  appendLaunchArgs(
    args,
    await askSessionLaunchMode(rl),
    config.settings.terminalApp,
  );
  if (customCommand) args.push("--", ...customCommand);

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
    { label: "Settings", value: "settings" },
  ]);
  printHelp(topic);
}

async function interactiveSettings(rl) {
  while (true) {
    const config = loadConfig();
    printSettings(config);
    console.log("");

    const action = await choose(rl, "Settings", [
      { label: "Choose terminal app", value: "choose-terminal" },
      { label: "Toggle notifications", value: "toggle-notifications" },
      { label: "Choose sound", value: "choose-sound" },
      { label: "Toggle macOS banner", value: "toggle-banner" },
      {
        label: "Install Claude hook",
        value: "install-claude",
        description: "Stop and SubagentStop",
      },
      {
        label: "Install Codex hook",
        value: "install-codex",
        description: "notify command",
      },
      { label: "Remove Claude hook", value: "remove-claude" },
      { label: "Remove Codex hook", value: "remove-codex" },
      { label: "Test notification", value: "test" },
      { label: "Back", value: "back" },
    ]);

    if (action === "back") return;

    if (action === "choose-terminal") {
      await interactiveChooseTerminal(rl, config);
    } else if (action === "toggle-notifications") {
      config.settings.notifications.enabled =
        !config.settings.notifications.enabled;
      saveConfig(config);
      console.log(
        `Notifications ${config.settings.notifications.enabled ? "enabled" : "disabled"}.`,
      );
    } else if (action === "choose-sound") {
      await interactiveChooseSound(rl, config);
    } else if (action === "toggle-banner") {
      config.settings.notifications.macosNotification =
        !config.settings.notifications.macosNotification;
      saveConfig(config);
      console.log(
        `macOS banner ${config.settings.notifications.macosNotification ? "enabled" : "disabled"}.`,
      );
    } else if (action === "install-claude") {
      installClaudeHook(config);
      saveConfig(config);
      console.log("Installed Claude completion hook.");
    } else if (action === "install-codex") {
      installCodexHook(config);
      saveConfig(config);
      console.log("Installed Codex notify hook.");
    } else if (action === "remove-claude") {
      removeClaudeHook(config);
      saveConfig(config);
      console.log("Removed Claude completion hook.");
    } else if (action === "remove-codex") {
      removeCodexHook(config);
      saveConfig(config);
      console.log("Removed Codex notify hook.");
    } else if (action === "test") {
      ensureHookScript(config);
      sendNotification(config.settings.notifications, "test", "conductor-cli/settings");
      console.log("Notification test sent.");
    }

    console.log("");
  }
}

async function interactiveChooseTerminal(rl, config) {
  const selected = await choose(rl, "Terminal app", terminalChoices());
  config.settings.terminalApp = normalizeTerminalApp(selected);
  saveConfig(config);
  console.log(`Terminal app set to ${terminalLabel(config.settings.terminalApp)}.`);
}

async function interactiveChooseSound(rl, config) {
  const choices = [
    { label: "No sound", value: "none" },
    ...listSystemSounds().map((sound) => ({ label: sound, value: sound })),
    { label: "Custom name", value: "__custom__" },
  ];
  const selected = await choose(rl, "Sound", choices);
  const sound = selected === "__custom__"
    ? await askRequired(rl, "Sound name")
    : selected;

  config.settings.notifications.soundName = sound;
  saveConfig(config);
  console.log(`Sound set to ${sound}.`);
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
  if (supportsArrowMenu()) {
    return chooseWithArrows(rl, prompt, choices);
  }

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

function supportsArrowMenu() {
  return Boolean(
    process.stdin.isTTY &&
      process.stdout.isTTY &&
      typeof process.stdin.setRawMode === "function",
  );
}

async function chooseWithArrows(rl, prompt, choices) {
  const input = process.stdin;
  const output = process.stdout;
  const previousRawMode = input.isRaw;
  let selected = 0;
  let renderedLines = 0;
  let digitBuffer = "";
  let digitTimer = null;
  let onKeypress = null;

  readlineCore.emitKeypressEvents(input, rl);
  rl.pause();
  input.setRawMode(true);
  input.resume();
  output.write("\x1b[?25l");

  const clearDigitTimer = () => {
    if (digitTimer) clearTimeout(digitTimer);
    digitTimer = null;
  };

  const clearRendered = () => {
    if (renderedLines === 0) return;
    readlineCore.moveCursor(output, 0, -renderedLines);
    for (let index = 0; index < renderedLines; index += 1) {
      readlineCore.clearLine(output, 0);
      readlineCore.cursorTo(output, 0);
      if (index < renderedLines - 1) readlineCore.moveCursor(output, 0, 1);
    }
    if (renderedLines > 1) {
      readlineCore.moveCursor(output, 0, -(renderedLines - 1));
    }
    readlineCore.cursorTo(output, 0);
    renderedLines = 0;
  };

  const cleanup = () => {
    clearDigitTimer();
    input.off("keypress", onKeypress);
    input.setRawMode(previousRawMode || false);
    output.write("\x1b[?25h");
    clearRendered();
    rl.resume();
  };

  const render = () => {
    const lines = buildChoiceLines(prompt, choices, selected);
    if (renderedLines > 0) {
      readlineCore.moveCursor(output, 0, -renderedLines);
    }

    for (const line of lines) {
      readlineCore.clearLine(output, 0);
      readlineCore.cursorTo(output, 0);
      output.write(line);
      output.write("\n");
    }

    renderedLines = lines.length;
  };

  return new Promise((resolve, reject) => {
    const finish = (choice) => {
      cleanup();
      resolve(choice.value);
    };

    const fail = (error) => {
      cleanup();
      reject(error);
    };

    onKeypress = (str, key = {}) => {
      if (key.ctrl && key.name === "c") {
        fail(new CliError("Interrupted", 130));
        return;
      }

      if (key.name === "up" || key.name === "k") {
        selected = (selected - 1 + choices.length) % choices.length;
        digitBuffer = "";
        render();
        return;
      }

      if (key.name === "down" || key.name === "j" || key.name === "tab") {
        selected = (selected + 1) % choices.length;
        digitBuffer = "";
        render();
        return;
      }

      if (key.name === "return" || key.name === "enter") {
        finish(choices[selected]);
        return;
      }

      if (key.name === "escape" || key.name === "q") {
        const backChoice = choices.find((choice) =>
          ["back", "quit"].includes(String(choice.value).toLowerCase()),
        );
        if (backChoice) finish(backChoice);
        return;
      }

      if (/^\d$/.test(str || "")) {
        digitBuffer += str;
        clearDigitTimer();
        const index = Number.parseInt(digitBuffer, 10) - 1;
        if (index >= 0 && index < choices.length) {
          selected = index;
          render();
          const canBeLonger = choices.length >= Number.parseInt(`${digitBuffer}0`, 10);
          if (!canBeLonger) {
            finish(choices[selected]);
            return;
          }
        }
        digitTimer = setTimeout(() => {
          const bufferedIndex = Number.parseInt(digitBuffer, 10) - 1;
          digitBuffer = "";
          if (bufferedIndex >= 0 && bufferedIndex < choices.length) {
            finish(choices[bufferedIndex]);
          }
        }, 500);
      }
    };

    input.on("keypress", onKeypress);
    render();
  });
}

function buildChoiceLines(prompt, choices, selected) {
  const width = Math.max(40, process.stdout.columns || 100);
  const numberWidth = String(choices.length).length;
  const lines = [
    prompt,
    dim("Use up/down, j/k, or numbers. Enter selects."),
  ];

  choices.forEach((choice, index) => {
    const number = `${index + 1}.`.padStart(numberWidth + 1);
    const suffix = choice.description ? ` - ${choice.description}` : "";
    const marker = index === selected ? ">" : " ";
    const rawLine = `${marker} ${number} ${choice.label}${suffix}`;
    const visible = truncate(rawLine, width);
    lines.push(index === selected ? inverse(visible.padEnd(Math.min(width, visible.length + 2))) : visible);
  });

  return lines;
}

function truncate(value, width) {
  if (value.length <= width) return value;
  if (width <= 3) return value.slice(0, width);
  return `${value.slice(0, width - 3)}...`;
}

function inverse(value) {
  return `\x1b[7m${value}\x1b[0m`;
}

function dim(value) {
  return `\x1b[2m${value}\x1b[0m`;
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
    case "set-claude-profile":
      projectSetClaudeProfile(args.slice(1));
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
    string: ["worktrees-dir", "main", "base", "gh-user", "claude-profile"],
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
  const claudeProfile = normalizeOptionalClaudeProfile(parsed["claude-profile"]);
  const remote = git(repoPath, ["config", "--get", "remote.origin.url"], {
    allowFailure: true,
  }).stdout.trim();

  const config = loadConfig();
  if (claudeProfile && !config.settings.claudeProfiles.profiles[claudeProfile]) {
    throw new CliError(`Unknown Claude profile: ${claudeProfile}`);
  }
  if (config.projects[name]) {
    throw new CliError(`Project already exists: ${name}`);
  }

  config.projects[name] = {
    name,
    repoPath,
    worktreesDir,
    mainBranch,
    githubUser: githubUser || null,
    claudeProfile,
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
  console.log(`Claude profile: ${claudeProfile || "default"}`);
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
      project.claudeProfile || "default",
      String(active),
      project.worktreesDir,
    ];
  });

  if (rows.length === 0) {
    console.log("No projects registered.");
    return;
  }

  printTable(rows, ["name", "repo", "base", "claude", "active", "worktrees"]);
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
  console.log(`Claude profile: ${project.claudeProfile || "default"} (${resolveClaudeProfileCommand(config, project.name)})`);
  if (project.remote) console.log(`remote: ${project.remote}`);
  console.log(`workspaces: ${workspaces.length}`);
}

function projectSetClaudeProfile(args) {
  const [name, profileInput] = args;
  if (!name || !profileInput) {
    throw new CliError("Usage: conductor-cli project set-claude-profile <name> <profile|default|none>");
  }
  const config = loadConfig();
  const project = requireProject(config, name);
  const profile = normalizeOptionalClaudeProfile(profileInput);
  if (profile && !config.settings.claudeProfiles.profiles[profile]) {
    throw new CliError(`Unknown Claude profile: ${profile}`);
  }
  project.claudeProfile = profile;
  saveConfig(config);
  console.log(`Project ${name} Claude profile set to ${profile || "default"}.`);
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
    boolean: ["attach", "detach"],
    string: ["base", "path", "agent", "session", "port", "terminal"],
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

  const branch = defaultWorkspaceBranch(project, workspaceName);
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
    const session = launchSession(updatedConfig, projectName, workspaceName, {
      agent: parsed.agent,
      name: parsed.session,
      port: parsed.port,
      command: parsed["--"],
      attach: parsed.attach,
      detach: parsed.detach,
      terminal: parsed.terminal,
    });
    saveConfig(updatedConfig);
    printSessionLaunch(session, { compact: true });
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

function commandClaudeProfile(args) {
  const sub = args[0] || "list";
  if (sub === "--help" || sub === "-h") {
    printHelp("claude-profile");
    return;
  }
  const config = loadConfig();
  switch (sub) {
    case "add": {
      const [name, command, ...extra] = args.slice(1);
      if (!name || !command || extra.length > 0) throw new CliError("Usage: conductor-cli claude-profile add <name> <command>");
      validateClaudeProfileName(name);
      config.settings.claudeProfiles.profiles[name] = { name, command };
      if (!config.settings.claudeProfiles.default) config.settings.claudeProfiles.default = name;
      saveConfig(config);
      console.log(`Claude profile ${name} -> ${command}`);
      break;
    }
    case "list":
    case "ls":
      printClaudeProfiles(config);
      break;
    case "default": {
      const name = args[1];
      if (!name) throw new CliError("Usage: conductor-cli claude-profile default <name>");
      if (!config.settings.claudeProfiles.profiles[name]) throw new CliError(`Unknown Claude profile: ${name}`);
      config.settings.claudeProfiles.default = name;
      saveConfig(config);
      console.log(`Default Claude profile set to ${name}.`);
      break;
    }
    case "remove":
    case "rm": {
      const name = args[1];
      if (!name) throw new CliError("Usage: conductor-cli claude-profile remove <name>");
      if (!config.settings.claudeProfiles.profiles[name]) throw new CliError(`Unknown Claude profile: ${name}`);
      delete config.settings.claudeProfiles.profiles[name];
      if (config.settings.claudeProfiles.default === name) config.settings.claudeProfiles.default = null;
      for (const project of Object.values(config.projects)) {
        if (project.claudeProfile === name) project.claudeProfile = null;
      }
      saveConfig(config);
      console.log(`Removed Claude profile ${name}.`);
      break;
    }
    case "resolve": {
      const project = args[1] || null;
      console.log(resolveClaudeProfileCommand(config, project));
      break;
    }
    default:
      throw new CliError(`Unknown claude-profile command: ${sub}`);
  }
}

function printClaudeProfiles(config) {
  const profiles = Object.values(config.settings.claudeProfiles.profiles || {});
  if (profiles.length === 0) {
    console.log("No Claude profiles configured. Default command: claude");
    return;
  }
  const defaultName = config.settings.claudeProfiles.default;
  printTable(profiles.map((profile) => [profile.name, profile.command, profile.name === defaultName ? "yes" : ""]), ["name", "command", "default"]);
}

function normalizeOptionalClaudeProfile(value) {
  if (!value || value === "default" || value === "none") return null;
  validateClaudeProfileName(value);
  return value;
}

function validateClaudeProfileName(name) {
  validateName(name, "Claude profile");
  if (name === "default" || name === "none") {
    throw new CliError("Claude profile names 'default' and 'none' are reserved.");
  }
}

function resolveClaudeProfileCommand(config, projectName = null) {
  const profiles = config.settings.claudeProfiles || { default: null, profiles: {} };
  let profileName = null;
  if (projectName && config.projects[projectName]) {
    profileName = config.projects[projectName].claudeProfile || null;
  }
  profileName = profileName || profiles.default;
  if (profileName && profiles.profiles?.[profileName]?.command) return profiles.profiles[profileName].command;
  return "claude";
}

function commandSettings(args) {
  const sub = args[0] || "show";

  if (sub === "--help" || sub === "-h") {
    printHelp("settings");
    return;
  }

  const config = loadConfig();

  switch (sub) {
    case "show":
      refreshHookScriptIfInstalled(config);
      saveConfig(config);
      printSettings(config);
      break;
    case "notifications":
      config.settings.notifications.enabled = requireBoolean(
        args[1],
        "Usage: conductor-cli settings notifications on|off",
      );
      saveConfig(config);
      console.log(
        `Notifications ${config.settings.notifications.enabled ? "enabled" : "disabled"}.`,
      );
      break;
    case "sound":
      if (!args[1]) {
        throw new CliError("Usage: conductor-cli settings sound <sound-name|none>");
      }
      config.settings.notifications.soundName = args[1];
      saveConfig(config);
      console.log(`Sound set to ${args[1]}.`);
      break;
    case "terminal":
      if (!args[1]) {
        throw new CliError(
          "Usage: conductor-cli settings terminal <auto|terminal|iterm|warp|warppreview>",
        );
      }
      config.settings.terminalApp = normalizeTerminalApp(args[1]);
      saveConfig(config);
      console.log(`Terminal app set to ${terminalLabel(config.settings.terminalApp)}.`);
      break;
    case "macos-notification":
      config.settings.notifications.macosNotification = requireBoolean(
        args[1],
        "Usage: conductor-cli settings macos-notification on|off",
      );
      saveConfig(config);
      console.log(
        `macOS banner ${config.settings.notifications.macosNotification ? "enabled" : "disabled"}.`,
      );
      break;
    case "hooks":
      commandSettingsHooks(config, args.slice(1));
      break;
    case "test":
      ensureHookScript(config);
      sendNotification(config.settings.notifications, "test", "conductor-cli/settings");
      console.log("Notification test sent.");
      break;
    default:
      throw new CliError(`Unknown settings command: ${sub}`);
  }
}

function commandSettingsHooks(config, args) {
  const sub = args[0] || "status";
  const target = args[1] || "all";

  switch (sub) {
    case "status":
      refreshHookScriptIfInstalled(config);
      saveConfig(config);
      printHookStatus(config);
      break;
    case "install":
      if (target === "claude" || target === "all") installClaudeHook(config);
      if (target === "codex" || target === "all") installCodexHook(config);
      if (!["claude", "codex", "all"].includes(target)) {
        throw new CliError("Usage: conductor-cli settings hooks install <claude|codex|all>");
      }
      saveConfig(config);
      console.log(`Installed ${target} hook${target === "all" ? "s" : ""}.`);
      break;
    case "remove":
      if (target === "claude" || target === "all") removeClaudeHook(config);
      if (target === "codex" || target === "all") removeCodexHook(config);
      if (!["claude", "codex", "all"].includes(target)) {
        throw new CliError("Usage: conductor-cli settings hooks remove <claude|codex|all>");
      }
      saveConfig(config);
      console.log(`Removed ${target} hook${target === "all" ? "s" : ""}.`);
      break;
    default:
      throw new CliError(`Unknown settings hooks command: ${sub}`);
  }
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
    case "run":
      sessionRun(args.slice(1));
      break;
    case "resume":
      sessionResume(args.slice(1));
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
    boolean: ["attach", "detach"],
    string: ["agent", "name", "port", "terminal"],
  });
  const [projectName, workspaceName] = parsed._;
  if (!projectName || !workspaceName) {
    throw new CliError(
      "Usage: conductor-cli session start <project> <workspace> [options]",
    );
  }

  const config = loadConfig();
  const session = launchSession(config, projectName, workspaceName, {
    agent: parsed.agent,
    name: parsed.name,
    port: parsed.port,
    command: parsed["--"],
    attach: parsed.attach,
    detach: parsed.detach,
    terminal: parsed.terminal,
  });
  saveConfig(config);

  printSessionLaunch(session);
  if (session.exitCode && session.exitCode !== 0) process.exitCode = session.exitCode;
}

function sessionRun(args) {
  runStoredSessionCommand(args, {
    usage: "Usage: conductor-cli session run <session-id>",
    action: "Starting",
    commandForSession: (session) => session.command,
    missingMessage: (session) => `Session ${session.id} does not have a runnable command.`,
  });
}

function sessionResume(args) {
  runStoredSessionCommand(args, {
    usage: "Usage: conductor-cli session resume <session-id>",
    action: "Resuming",
    commandForSession: sessionResumeAgentCommand,
    missingMessage: (session) =>
      `Session ${session.id} does not have a supported resume command.`,
    markResumed: true,
  });
}

function runStoredSessionCommand(args, options) {
  const [id] = args;
  if (!id) throw new CliError(options.usage);

  const config = loadConfig();
  const session = config.sessions[id];
  if (!session) throw new CliError(`Unknown session: ${id}`);
  const command = options.commandForSession(session);
  if (!command || !Array.isArray(command) || command.length === 0) {
    throw new CliError(options.missingMessage(session));
  }
  if (!session.cwd || !fs.existsSync(session.cwd)) {
    throw new CliError(`Session cwd does not exist: ${session.cwd || ""}`);
  }
  if (session.status === "running" || session.status === "attached") {
    throw new CliError(`Session ${id} is already ${session.status}.`);
  }

  session.status = "attached";
  session.launchMode = "attach";
  session.startedAt = new Date().toISOString();
  if (options.markResumed) {
    session.resumedAt = session.startedAt;
    session.lastResumeCommand = command;
  }
  saveConfig(config);

  console.log(`${options.action} session ${session.id} in current terminal`);
  console.log(`cwd: ${session.cwd}`);
  console.log(`command: ${shellJoin(command)}`);

  const result = spawnSync(command[0], command.slice(1), {
    cwd: session.cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      ...sessionEnvForRun(config, session),
    },
  });

  const updatedConfig = loadConfig();
  const updatedSession = updatedConfig.sessions[id] || session;

  if (result.error) {
    updatedSession.status = "failed";
    updatedSession.error = result.error.message;
    updatedSession.exitedAt = new Date().toISOString();
    saveConfig(updatedConfig);
    throw new CliError(result.error.message);
  }

  updatedSession.status = "exited";
  updatedSession.exitCode = result.status === null ? 1 : result.status;
  if (result.signal) updatedSession.signal = result.signal;
  updatedSession.exitedAt = new Date().toISOString();
  saveConfig(updatedConfig);
  if (updatedSession.exitCode && updatedSession.exitCode !== 0) {
    process.exitCode = updatedSession.exitCode;
  }
}

function sessionResumeAgentCommand(session) {
  const command = Array.isArray(session.command) ? session.command : [];
  const executable = command[0] || session.agent;
  const agent = String(session.agent || path.basename(executable || ""))
    .toLowerCase();
  const binary = path.basename(String(executable || "")).toLowerCase();

  if (agent.includes("codex") || binary === "codex") {
    return [executable || "codex", "resume", "--last"];
  }
  if (agent.includes("claude") || binary === "claude") {
    return [executable || "claude", "--continue"];
  }
  return null;
}

function sessionEnvForRun(config, session) {
  if (session.env && typeof session.env === "object") return session.env;
  const workspace = config.workspaces?.[session.project]?.[session.workspace];
  return {
    CONDUCTOR_CLI: "1",
    CONDUCTOR_SESSION_ID: session.id,
    CONDUCTOR_SESSION_NAME: session.name || session.id,
    CONDUCTOR_PROJECT: session.project,
    CONDUCTOR_WORKSPACE: session.workspace,
    ...(workspace?.branch ? { CONDUCTOR_BRANCH: workspace.branch } : {}),
  };
}

function sessionList(args) {
  const parsed = parseOptions(args, { boolean: ["all"] });
  const [projectName, workspaceName] = parsed._;
  const config = loadConfig();
  refreshSessionStates(config);
  saveConfig(config);

  const rows = Object.values(config.sessions)
    .filter((session) => {
      const active = ["ready", "running", "opened", "attached", "stop_failed"].includes(
        session.status,
      );
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
      session.logPath || "",
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
  if (!session.logPath) {
    console.log("No log file for this session.");
    return;
  }
  if (!fs.existsSync(session.logPath)) {
    console.log("");
    return;
  }

  const tail = Number.parseInt(parsed.tail || "100", 10);
  console.log(tailFile(session.logPath, Number.isFinite(tail) ? tail : 100));
}

function printSessionLaunch(session, options = {}) {
  const runCommand = session.runCommand || sessionRunCommand(session.id);
  if (options.compact) {
    console.log(`session: ${session.id}`);
    console.log(`launch: ${describeSessionLaunch(session)}`);
    if (session.launchMode === "terminal") console.log(`run: ${runCommand}`);
    if (session.logPath) console.log(`log: ${session.logPath}`);
    return;
  }

  const verb =
    session.launchMode === "terminal"
      ? "Prepared"
      : session.launchMode === "attach"
        ? "Finished"
        : "Started";

  console.log(`${verb} session ${session.id}`);
  if (session.launchMode === "terminal") console.log(`terminal: ${session.terminal}`);
  if (session.pid) console.log(`pid: ${session.pid}`);
  console.log(`cwd: ${session.cwd}`);
  console.log(`command: ${shellJoin(session.command)}`);
  if (session.launchMode === "terminal") {
    console.log(`run: ${runCommand}`);
  }
  if (session.logPath) console.log(`log: ${session.logPath}`);
  if (session.launchMode === "attach") {
    console.log(`exit: ${session.exitCode}`);
  }
}

function describeSessionLaunch(session) {
  if (session.launchMode === "terminal") return `terminal prompt (${session.terminal})`;
  if (session.launchMode === "attach") return `current terminal (exit ${session.exitCode})`;
  return `background log (${session.pid})`;
}

function sessionRunCommand(id) {
  return `${cliInvocation()} session run ${shellQuote(id)}`;
}

function sessionResumeCommand(session) {
  if (!sessionResumeAgentCommand(session)) return null;
  return `${cliInvocation()} session resume ${shellQuote(session.id)}`;
}

function cliInvocation() {
  if (hasCommand("conductor-cli")) return "conductor-cli";
  return shellJoin([process.execPath, SCRIPT_PATH]);
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

function launchSession(config, projectName, workspaceName, options) {
  const launch = resolveSessionLaunch(config, options);

  if (launch.mode === "attach") {
    return startAttachedSession(config, projectName, workspaceName, options);
  }

  if (launch.mode === "terminal") {
    return startTerminalSession(config, projectName, workspaceName, {
      ...options,
      terminal: launch.terminal,
    });
  }

  return startDetachedSession(config, projectName, workspaceName, options);
}

function resolveSessionLaunch(config, options) {
  const requestedModes = [options.attach, options.detach, Boolean(options.terminal)]
    .filter(Boolean).length;
  if (requestedModes > 1) {
    throw new CliError("Choose only one of --terminal, --attach, or --detach");
  }

  if (options.attach) return { mode: "attach" };
  if (options.detach) return { mode: "detach" };
  if (options.terminal) {
    return { mode: "terminal", terminal: normalizeTerminalApp(options.terminal) };
  }

  const hasCommand = (options.command || []).length > 0;
  const agent = options.agent || (hasCommand ? null : "codex");
  if (agent === "codex" || agent === "claude") {
    return {
      mode: "terminal",
      terminal: normalizeTerminalSetting(config.settings?.terminalApp || "auto"),
    };
  }

  return { mode: "detach" };
}

function prepareSession(config, projectName, workspaceName, options) {
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
    command = [agent === "claude" ? resolveClaudeProfileCommand(config, projectName) : agent];
  } else {
    agent = agent || command[0];
  }

  if (!hasCommand(command[0])) {
    throw new CliError(`Command not found: ${command[0]}`);
  }

  const sessionName = normalizeName(
    options.name || `${workspace.name}-${agent}`,
    "session",
  );
  const id = uniqueSessionId(config, sessionName);
  const env = {
    CONDUCTOR_CLI: "1",
    CONDUCTOR_SESSION_ID: id,
    CONDUCTOR_SESSION_NAME: sessionName,
    CONDUCTOR_PROJECT: projectName,
    CONDUCTOR_WORKSPACE: workspace.name,
    CONDUCTOR_BRANCH: workspace.branch,
    ...(options.port ? { CONDUCTOR_PORT: String(options.port) } : {}),
  };

  return {
    id,
    sessionName,
    projectName,
    workspace,
    agent,
    command,
    env,
  };
}

function startDetachedSession(config, projectName, workspaceName, options) {
  const prepared = prepareSession(config, projectName, workspaceName, options);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logPath = path.join(LOG_DIR, `${prepared.id}.log`);
  const out = fs.openSync(logPath, "a");

  const child = spawn(prepared.command[0], prepared.command.slice(1), {
    cwd: prepared.workspace.path,
    detached: true,
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      ...prepared.env,
    },
  });

  child.unref();
  fs.closeSync(out);

  const session = {
    id: prepared.id,
    name: prepared.sessionName,
    project: projectName,
    workspace: prepared.workspace.name,
    agent: prepared.agent,
    command: prepared.command,
    env: prepared.env,
    pid: child.pid,
    cwd: prepared.workspace.path,
    logPath,
    status: "running",
    launchMode: "detach",
    startedAt: new Date().toISOString(),
  };

  config.sessions[prepared.id] = session;
  return session;
}

function startAttachedSession(config, projectName, workspaceName, options) {
  const prepared = prepareSession(config, projectName, workspaceName, options);
  const session = {
    id: prepared.id,
    name: prepared.sessionName,
    project: projectName,
    workspace: prepared.workspace.name,
    agent: prepared.agent,
    command: prepared.command,
    env: prepared.env,
    pid: null,
    cwd: prepared.workspace.path,
    logPath: null,
    status: "attached",
    launchMode: "attach",
    startedAt: new Date().toISOString(),
  };

  config.sessions[prepared.id] = session;
  console.log(`Starting session ${session.id} in current terminal`);
  console.log(`cwd: ${session.cwd}`);
  console.log(`command: ${shellJoin(session.command)}`);

  const result = spawnSync(prepared.command[0], prepared.command.slice(1), {
    cwd: prepared.workspace.path,
    stdio: "inherit",
    env: {
      ...process.env,
      ...prepared.env,
    },
  });

  if (result.error) {
    session.status = "failed";
    session.error = result.error.message;
    session.exitedAt = new Date().toISOString();
    throw new CliError(result.error.message);
  }

  session.status = "exited";
  session.exitCode = result.status === null ? 1 : result.status;
  if (result.signal) session.signal = result.signal;
  session.exitedAt = new Date().toISOString();
  return session;
}

function startTerminalSession(config, projectName, workspaceName, options) {
  const prepared = prepareSession(config, projectName, workspaceName, options);
  const terminal = resolveTerminalApp(options.terminal || "auto");
  const openResult = openTerminalTab(terminal, {
    id: prepared.id,
    title: prepared.sessionName,
    cwd: prepared.workspace.path,
  });
  const runCommand = sessionRunCommand(prepared.id);

  const session = {
    id: prepared.id,
    name: prepared.sessionName,
    project: projectName,
    workspace: prepared.workspace.name,
    agent: prepared.agent,
    command: prepared.command,
    env: prepared.env,
    pid: null,
    cwd: prepared.workspace.path,
    logPath: null,
    status: "ready",
    launchMode: "terminal",
    terminal: openResult.terminal,
    terminalConfigPath: openResult.configPath || null,
    runCommand,
    openedAt: new Date().toISOString(),
  };

  config.sessions[prepared.id] = session;
  return session;
}

function normalizeTerminalApp(value) {
  const terminal = String(value || "auto").trim().toLowerCase();
  if (terminal === "auto") return "auto";
  if (["terminal", "terminal.app", "apple", "apple_terminal"].includes(terminal)) {
    return "terminal";
  }
  if (["iterm", "iterm2", "iterm.app"].includes(terminal)) return "iterm";
  if (terminal === "warp") return "warp";
  if (["warppreview", "warp-preview", "warp preview"].includes(terminal)) {
    return "warppreview";
  }
  throw new CliError(
    "Unknown terminal app. Use auto, terminal, iterm, warp, or warppreview.",
  );
}

function resolveTerminalApp(value) {
  const requested = normalizeTerminalApp(value);
  if (requested !== "auto") return requested;

  const termProgram = String(process.env.TERM_PROGRAM || "").toLowerCase();
  if (termProgram.includes("warp")) return "warp";
  if (termProgram.includes("iterm")) return "iterm";
  if (termProgram.includes("apple_terminal")) return "terminal";
  if (process.env.WARP_IS_LOCAL_SHELL_SESSION) return "warp";

  if (process.platform === "darwin") {
    return preferredInstalledTerminalApp() || "terminal";
  }
  throw new CliError(
    "New terminal tabs are only auto-detected on macOS. Use --attach or --detach.",
  );
}

function preferredInstalledTerminalApp() {
  if (process.platform !== "darwin") return null;
  const home = os.homedir();
  const exists = (name) =>
    fs.existsSync(path.join("/Applications", name)) ||
    fs.existsSync(path.join(home, "Applications", name));

  if (exists("Warp.app")) return "warp";
  if (exists("Warp Preview.app")) return "warppreview";
  if (exists("iTerm.app") || exists("iTerm2.app")) return "iterm";
  return null;
}

function openTerminalTab(terminal, session) {
  if (process.platform !== "darwin") {
    throw new CliError("Opening new terminal tabs is currently supported on macOS only.");
  }

  if (terminal === "terminal") {
    openAppAtPath("Terminal", session.cwd);
    return { terminal: "Terminal.app" };
  }

  if (terminal === "iterm") {
    openAppAtPath("iTerm", session.cwd);
    return { terminal: "iTerm" };
  }

  if (terminal === "warp" || terminal === "warppreview") {
    openWarpTab(terminal, session.cwd);
    return {
      terminal: terminal === "warppreview" ? "Warp Preview" : "Warp",
    };
  }

  throw new CliError(`Unsupported terminal app: ${terminal}`);
}

function openAppAtPath(appName, cwd) {
  const result = spawnSync("open", ["-a", appName, cwd], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    throw new CliError(
      `Unable to open ${appName}: ${(result.stderr || result.stdout).trim()}`,
    );
  }
}

function openWarpTab(terminal, cwd) {
  const scheme = terminal === "warppreview" ? "warppreview" : "warp";
  const uri = `${scheme}://action/new_tab?path=${encodeURIComponent(cwd)}`;
  const result = spawnSync("open", [uri], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    throw new CliError(
      `Unable to open Warp tab: ${(result.stderr || result.stdout).trim()}`,
    );
  }
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
        ["ready", "running", "opened", "attached"].includes(session.status)
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

function defaultConfig() {
  return {
    version: 1,
    projects: {},
    workspaces: {},
    sessions: {},
    settings: defaultSettings(),
  };
}

function defaultSettings() {
  return {
    terminalApp: "auto",
    notifications: {
      enabled: true,
      soundName: "Glass",
      macosNotification: false,
    },
    agentHooks: {
      claude: {},
      codex: {
        previousNotify: null,
      },
    },
    claudeProfiles: {
      default: null,
      profiles: {},
    },
  };
}

function normalizeConfig(config) {
  const defaults = defaultConfig();
  config.version = config.version || defaults.version;
  config.projects = config.projects || {};
  config.workspaces = config.workspaces || {};
  config.sessions = config.sessions || {};
  config.settings = {
    ...defaults.settings,
    ...(config.settings || {}),
    terminalApp: normalizeTerminalSetting(
      (config.settings || {}).terminalApp || defaults.settings.terminalApp,
    ),
    notifications: {
      ...defaults.settings.notifications,
      ...((config.settings || {}).notifications || {}),
    },
    agentHooks: {
      ...defaults.settings.agentHooks,
      ...((config.settings || {}).agentHooks || {}),
      claude: {
        ...defaults.settings.agentHooks.claude,
        ...(((config.settings || {}).agentHooks || {}).claude || {}),
      },
      codex: {
        ...defaults.settings.agentHooks.codex,
        ...(((config.settings || {}).agentHooks || {}).codex || {}),
      },
    },
    claudeProfiles: {
      ...defaults.settings.claudeProfiles,
      ...((config.settings || {}).claudeProfiles || {}),
      profiles: {
        ...defaults.settings.claudeProfiles.profiles,
        ...(((config.settings || {}).claudeProfiles || {}).profiles || {}),
      },
    },
  };
  delete config.settings.notifications.scope;
  return config;
}

function printSettings(config) {
  const settings = config.settings.notifications;
  console.log(`terminal: ${terminalLabel(config.settings.terminalApp)}`);
  console.log(`notifications: ${settings.enabled ? "on" : "off"}`);
  console.log(`sound: ${settings.soundName}`);
  console.log(`macOS banner: ${settings.macosNotification ? "on" : "off"}`);
  console.log(`default Claude profile: ${config.settings.claudeProfiles.default || "claude"}`);
  printHookStatus(config);
}

function terminalChoices() {
  return [
    {
      label: "Auto",
      value: "auto",
      description: "detect current terminal; menu app prefers installed Warp/iTerm",
    },
    { label: "Terminal", value: "terminal" },
    { label: "iTerm", value: "iterm" },
    { label: "Warp", value: "warp" },
    { label: "Warp Preview", value: "warppreview" },
  ];
}

function terminalLabel(value) {
  switch (normalizeTerminalSetting(value)) {
    case "auto":
      return "auto";
    case "terminal":
      return "Terminal";
    case "iterm":
      return "iTerm";
    case "warp":
      return "Warp";
    case "warppreview":
      return "Warp Preview";
    default:
      return "auto";
  }
}

function normalizeTerminalSetting(value) {
  try {
    return normalizeTerminalApp(value || "auto");
  } catch (error) {
    return "auto";
  }
}

function printHookStatus(config) {
  const claude = getClaudeHookStatus(config);
  const codex = getCodexHookStatus(config);
  console.log(`Claude hook: ${claude.installed ? "installed" : "not installed"} (${claude.path})`);
  console.log(`Codex notify: ${codex.installed ? "installed" : "not installed"} (${codex.path})`);
}

function requireBoolean(value, usage) {
  const parsed = parseBoolean(value);
  if (parsed === null) throw new CliError(usage);
  return parsed;
}

function parseBoolean(value) {
  if (value === undefined) return null;
  const normalized = String(value).trim().toLowerCase();
  if (["on", "true", "yes", "1", "enable", "enabled"].includes(normalized)) {
    return true;
  }
  if (["off", "false", "no", "0", "disable", "disabled"].includes(normalized)) {
    return false;
  }
  return null;
}

function ensureHookScript(config) {
  fs.mkdirSync(HOOKS_DIR, { recursive: true });
  const notifierExecutable = ensureNotifierApp(config);
  const script = buildHookScript(CONFIG_PATH, notifierExecutable);
  if (!fs.existsSync(HOOK_SCRIPT_PATH) || fs.readFileSync(HOOK_SCRIPT_PATH, "utf8") !== script) {
    fs.writeFileSync(HOOK_SCRIPT_PATH, script);
    fs.chmodSync(HOOK_SCRIPT_PATH, 0o755);
  }
  config.settings.agentHooks.scriptPath = HOOK_SCRIPT_PATH;
}

function ensureNotifierApp(config = null) {
  if (process.platform !== "darwin") return null;

  fs.mkdirSync(HOOKS_DIR, { recursive: true });
  cleanupLegacyNotifierApp();

  const source = buildNotifierSwift();
  const sourceChanged =
    !fs.existsSync(NOTIFIER_SOURCE_PATH) ||
    fs.readFileSync(NOTIFIER_SOURCE_PATH, "utf8") !== source;

  if (sourceChanged) {
    fs.writeFileSync(NOTIFIER_SOURCE_PATH, source);
  }

  if (!hasCommand("swiftc")) {
    setNotifierAppError(config, "swiftc not found");
    return null;
  }

  if (sourceChanged || !fs.existsSync(NOTIFIER_EXECUTABLE_PATH)) {
    fs.mkdirSync(SWIFT_MODULE_CACHE_DIR, { recursive: true });
    const tmpExecutable = `${NOTIFIER_EXECUTABLE_PATH}.tmp`;
    fs.rmSync(tmpExecutable, { force: true });
    const result = run("swiftc", [NOTIFIER_SOURCE_PATH, "-o", tmpExecutable], {
      allowFailure: true,
      env: {
        ...process.env,
        CLANG_MODULE_CACHE_PATH: SWIFT_MODULE_CACHE_DIR,
      },
    });
    if (result.status !== 0 || !fs.existsSync(NOTIFIER_EXECUTABLE_PATH)) {
      if (!fs.existsSync(tmpExecutable)) {
        setNotifierAppError(
          config,
          (result.stderr || result.stdout || "failed to compile notifier").trim(),
        );
        return fs.existsSync(NOTIFIER_EXECUTABLE_PATH) ? NOTIFIER_EXECUTABLE_PATH : null;
      }
    }
    fs.renameSync(tmpExecutable, NOTIFIER_EXECUTABLE_PATH);
    fs.chmodSync(NOTIFIER_EXECUTABLE_PATH, 0o755);
  }

  if (config?.settings?.agentHooks) {
    config.settings.agentHooks.notifierPath = NOTIFIER_EXECUTABLE_PATH;
    delete config.settings.agentHooks.notifierAppPath;
    delete config.settings.agentHooks.notifierAppError;
  }
  return NOTIFIER_EXECUTABLE_PATH;
}

function setNotifierAppError(config, message) {
  if (config?.settings?.agentHooks) {
    config.settings.agentHooks.notifierPath = null;
    delete config.settings.agentHooks.notifierAppPath;
    config.settings.agentHooks.notifierAppError = message;
  }
}

function cleanupLegacyNotifierApp() {
  fs.rmSync(path.join(HOOKS_DIR, "ConductorNotifier.app"), {
    recursive: true,
    force: true,
  });
  fs.rmSync(path.join(HOOKS_DIR, "ConductorNotifier.applescript"), { force: true });
}

function buildNotifierSwift() {
  return `import Foundation
import AppKit

class NotificationDelegate: NSObject, NSUserNotificationCenterDelegate {
  func userNotificationCenter(
    _ center: NSUserNotificationCenter,
    shouldPresent notification: NSUserNotification
  ) -> Bool {
    return true
  }
}

let title = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "Agent done"
let message = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : ""
let delegate = NotificationDelegate()
let center = NSUserNotificationCenter.default
center.delegate = delegate

let notification = NSUserNotification()
notification.title = title
notification.informativeText = message
center.deliver(notification)
RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.5))
`;
}

function refreshHookScriptIfInstalled(config) {
  const hooks = config.settings?.agentHooks || {};
  if (
    hooks.scriptPath ||
    hooks.claude?.installedAt ||
    hooks.codex?.installedAt ||
    fs.existsSync(HOOK_SCRIPT_PATH)
  ) {
    ensureHookScript(config);
  }
}

function buildHookScript(configPath, notifierExecutable) {
  return `#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const CONFIG_PATH = ${JSON.stringify(configPath)};
const NOTIFIER_EXECUTABLE = ${JSON.stringify(notifierExecutable || "")};

function main() {
  const agent = process.argv[2] || "agent";
  const config = loadConfig();
  const settings = config.settings?.notifications || {};
  const isConductorSession =
    process.env.CONDUCTOR_CLI === "1" ||
    Boolean(
      process.env.CONDUCTOR_SESSION_ID ||
        process.env.CONDUCTOR_PROJECT ||
        process.env.CONDUCTOR_WORKSPACE,
    );

  const input = readStdin();
  const hook = parseJson(input);
  const event = hook?.hook_event_name || hook?.hookEventName || "done";
  const text = notificationText(agent, event, hook);

  if (settings.enabled !== false && isConductorSession) {
    play(settings.soundName || "Glass");
    if (settings.macosNotification) {
      notify(text.title, text.message);
    }
  }

}

function notificationText(agent, event, hook) {
  const project = process.env.CONDUCTOR_PROJECT || "";
  const workspace = process.env.CONDUCTOR_WORKSPACE || "";
  const session = process.env.CONDUCTOR_SESSION_NAME || process.env.CONDUCTOR_SESSION_ID || "";
  const branch = process.env.CONDUCTOR_BRANCH || "";
  const target = hook?.cwd || hook?.workspace || hook?.project_dir || "";
  const fallback = target ? path.basename(target) : "workspace";
  const location = project && workspace ? project + "/" + workspace : fallback;
  const details = [agent + " " + event];
  if (session) details.push(session);
  if (branch) details.push(branch);
  return {
    title: "Agent done: " + location,
    message: details.join(" - "),
  };
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (error) {
    return {};
  }
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch (error) {
    return "";
  }
}

function parseJson(input) {
  if (!input.trim()) return null;
  try {
    return JSON.parse(input);
  } catch (error) {
    return null;
  }
}

function play(soundName) {
  if (!soundName || soundName === "none") return;
  const soundPath = findSound(soundName);
  if (soundPath) {
    spawnSync("afplay", [soundPath], { stdio: "ignore", timeout: 5000 });
  }
}

function notify(title, message) {
  if (NOTIFIER_EXECUTABLE && fs.existsSync(NOTIFIER_EXECUTABLE)) {
    const result = spawnSync(NOTIFIER_EXECUTABLE, [title, message], {
      stdio: "ignore",
      timeout: 5000,
    });
    if (!result.error && result.status === 0) return;
  }

  if (hasCommand("terminal-notifier")) {
    spawnSync("terminal-notifier", ["-title", title, "-message", message], {
      stdio: "ignore",
      timeout: 5000,
    });
  }
}

function hasCommand(command) {
  const result = spawnSync("which", [command], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0;
}

function findSound(soundName) {
  const name = String(soundName).replace(/\\.(aiff|aif|wav|mp3)$/i, "");
  const dirs = ["/System/Library/Sounds", "/Library/Sounds"];
  const extensions = [".aiff", ".aif", ".wav", ".mp3"];
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, name + extension);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

main();
`;
}

function installClaudeHook(config) {
  ensureHookScript(config);
  const settingsPath = getClaudeSettingsPath();
  const settings = readJsonFile(settingsPath, {});
  const command = `node ${shellQuote(HOOK_SCRIPT_PATH)} claude`;

  settings.hooks = settings.hooks || {};
  settings.hooks.Stop = addClaudeHook(settings.hooks.Stop, command);
  settings.hooks.SubagentStop = addClaudeHook(settings.hooks.SubagentStop, command);

  writeJsonFile(settingsPath, settings);
  config.settings.agentHooks.claude = {
    installedAt: new Date().toISOString(),
    settingsPath,
    command,
  };
}

function removeClaudeHook(config) {
  const settingsPath = getClaudeSettingsPath();
  const settings = readJsonFile(settingsPath, {});
  const command = `node ${shellQuote(HOOK_SCRIPT_PATH)} claude`;

  if (settings.hooks) {
    settings.hooks.Stop = removeClaudeHookCommand(settings.hooks.Stop, command);
    settings.hooks.SubagentStop = removeClaudeHookCommand(settings.hooks.SubagentStop, command);
    for (const event of ["Stop", "SubagentStop"]) {
      if (Array.isArray(settings.hooks[event]) && settings.hooks[event].length === 0) {
        delete settings.hooks[event];
      }
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }

  writeJsonFile(settingsPath, settings);
  config.settings.agentHooks.claude = {};
}

function addClaudeHook(existing, command) {
  const entries = Array.isArray(existing) ? existing : [];
  const filtered = removeClaudeHookCommand(entries, command);
  filtered.push({
    hooks: [
      {
        type: "command",
        command,
        timeout: 10,
      },
    ],
  });
  return filtered;
}

function removeClaudeHookCommand(existing, command) {
  if (!Array.isArray(existing)) return [];
  return existing
    .map((entry) => ({
      ...entry,
      hooks: (entry.hooks || []).filter((hook) => hook.command !== command),
    }))
    .filter((entry) => entry.hooks.length > 0);
}

function getClaudeHookStatus(config) {
  const settingsPath = getClaudeSettingsPath();
  const settings = readJsonFile(settingsPath, {});
  const command = `node ${shellQuote(HOOK_SCRIPT_PATH)} claude`;
  const installed = ["Stop", "SubagentStop"].every((event) =>
    hookListContains(settings.hooks?.[event], command),
  );
  return {
    installed,
    path: settingsPath,
    configuredAt: config.settings.agentHooks.claude.installedAt || null,
  };
}

function installCodexHook(config) {
  ensureHookScript(config);
  const configPath = getCodexConfigPath();
  const current = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  const existing = readCodexNotify(current);
  const notify = ["node", HOOK_SCRIPT_PATH, "codex"];
  const storedPrevious = config.settings.agentHooks.codex.previousNotify;

  if (existing && !isManagedCodexNotify(existing)) {
    config.settings.agentHooks.codex.previousNotify = isCodexComputerUseNotify(existing)
      ? null
      : existing;
  } else if (isCodexComputerUseNotify(storedPrevious)) {
    config.settings.agentHooks.codex.previousNotify = null;
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, writeCodexNotify(current, notify));
  config.settings.agentHooks.codex.installedAt = new Date().toISOString();
  config.settings.agentHooks.codex.configPath = configPath;
}

function removeCodexHook(config) {
  const configPath = getCodexConfigPath();
  if (!fs.existsSync(configPath)) {
    config.settings.agentHooks.codex.installedAt = null;
    return;
  }

  const current = fs.readFileSync(configPath, "utf8");
  const existing = readCodexNotify(current);
  if (!isManagedCodexNotify(existing)) return;

  const previous = config.settings.agentHooks.codex.previousNotify;
  const restorePrevious = previous && !isCodexComputerUseNotify(previous);
  fs.writeFileSync(
    configPath,
    restorePrevious ? writeCodexNotify(current, previous) : removeCodexNotifyLine(current),
  );
  config.settings.agentHooks.codex.installedAt = null;
}

function getCodexHookStatus(config) {
  const configPath = getCodexConfigPath();
  const toml = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  return {
    installed: isManagedCodexNotify(readCodexNotify(toml)),
    path: configPath,
    configuredAt: config.settings.agentHooks.codex.installedAt || null,
  };
}

function hookListContains(entries, command) {
  return Array.isArray(entries) && entries.some((entry) =>
    Array.isArray(entry.hooks) && entry.hooks.some((hook) => hook.command === command),
  );
}

function readCodexNotify(toml) {
  const match = toml.match(/^notify\s*=\s*(\[[^\n]*\])\s*$/m);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    return null;
  }
}

function writeCodexNotify(toml, notify) {
  const line = `notify = ${JSON.stringify(notify)}\n`;
  if (/^notify\s*=/m.test(toml)) {
    return toml.replace(/^notify\s*=\s*\[[^\n]*\]\s*$/m, line.trimEnd());
  }
  return toml ? `${line}${toml}` : line;
}

function removeCodexNotifyLine(toml) {
  return toml.replace(/^notify\s*=\s*\[[^\n]*\]\s*\n?/m, "");
}

function isManagedCodexNotify(notify) {
  return Array.isArray(notify) &&
    notify.length >= 3 &&
    notify[0] === "node" &&
    path.resolve(notify[1]) === HOOK_SCRIPT_PATH &&
    notify[2] === "codex";
}

function isCodexComputerUseNotify(notify) {
  return Array.isArray(notify) &&
    notify.some((part) => String(part).includes("SkyComputerUseClient"));
}

function sendNotification(settings, agent, target) {
  if (!settings.enabled) return;
  if (settings.soundName && settings.soundName !== "none") {
    playSystemSound(settings.soundName);
  }
  if (settings.macosNotification) {
    sendMacOsNotification("Agent done", `${agent} finished in ${target}`);
  }
}

function playSystemSound(soundName) {
  const soundPath = findSystemSoundPath(soundName);
  if (soundPath) {
    run("afplay", [soundPath], { allowFailure: true });
  }
}

function sendMacOsNotification(title, message) {
  const notifierExecutable = ensureNotifierApp();
  if (notifierExecutable) {
    run(notifierExecutable, [title, message], { allowFailure: true });
    return;
  }
  if (hasCommand("terminal-notifier")) {
    run("terminal-notifier", ["-title", title, "-message", message], {
      allowFailure: true,
    });
  }
}

function listSystemSounds() {
  const sounds = new Set();
  for (const dir of ["/System/Library/Sounds", "/Library/Sounds"]) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (/\.(aiff|aif|wav|mp3)$/i.test(file)) {
        sounds.add(file.replace(/\.(aiff|aif|wav|mp3)$/i, ""));
      }
    }
  }
  if (sounds.size === 0) {
    ["Basso", "Funk", "Glass", "Hero", "Ping", "Pop", "Submarine", "Tink"]
      .forEach((sound) => sounds.add(sound));
  }
  return [...sounds].sort((a, b) => a.localeCompare(b));
}

function findSystemSoundPath(soundName) {
  const name = String(soundName || "").replace(/\.(aiff|aif|wav|mp3)$/i, "");
  for (const dir of ["/System/Library/Sounds", "/Library/Sounds"]) {
    for (const extension of [".aiff", ".aif", ".wav", ".mp3"]) {
      const candidate = path.join(dir, `${name}${extension}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function getClaudeSettingsPath() {
  return path.resolve(
    expandHome(
      process.env.CONDUCTOR_CLI_CLAUDE_SETTINGS ||
        path.join(os.homedir(), ".claude", "settings.json"),
    ),
  );
}

function getCodexConfigPath() {
  return path.resolve(
    expandHome(
      process.env.CONDUCTOR_CLI_CODEX_CONFIG ||
        path.join(os.homedir(), ".codex", "config.toml"),
    ),
  );
}

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new CliError(`Invalid JSON: ${filePath}`);
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function shellJoin(values) {
  return values.map((value) => shellQuote(value)).join(" ");
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return defaultConfig();
  }

  return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")));
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
