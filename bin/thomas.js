#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const readlineCore = require("readline");
const readline = require("readline/promises");
const { spawn, spawnSync } = require("child_process");
const http = require("http");
const { URL } = require("url");

const SCRIPT_PATH = fs.realpathSync(__filename);
const ROOT_DIR = path.resolve(path.dirname(SCRIPT_PATH), "..");
const PACKAGE_PATH = path.join(ROOT_DIR, "package.json");
const PACKAGE = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));

const CONFIG_DIR =
  process.env.THOMAS_CLI_HOME ||
  path.join(os.homedir(), ".thomas");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const STATE_DB_PATH = path.join(CONFIG_DIR, "thomas.db");
const LOG_DIR = path.join(CONFIG_DIR, "logs");
const HOOKS_DIR = path.join(CONFIG_DIR, "hooks");
const HOOK_SCRIPT_PATH = path.join(HOOKS_DIR, "agent-notify.js");
const NOTIFIER_SOURCE_PATH = path.join(HOOKS_DIR, "ThomasNotifier.swift");
const NOTIFIER_EXECUTABLE_PATH = path.join(HOOKS_DIR, "thomas-notifier");
const SWIFT_MODULE_CACHE_DIR = path.join(HOOKS_DIR, "swift-module-cache");
const KANBAN_STATUSES = [
  "To-do",
  "In Progress",
  "PR Review",
  "Human Review",
  "Done",
];

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
    case "version":
      console.log(PACKAGE.version);
      break;
    case "dashboard":
    case "dash":
      await commandDashboard(rest);
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
    case "kanban":
      commandKanban(rest);
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
    case "agent-profile":
    case "agent-profiles":
      commandAgentProfile(rest);
      break;
    case "claude-profile":
    case "claude-profiles":
      commandAgentProfile(rest, { legacyName: "claude-profile" });
      break;
    case "settings":
    case "setting":
      commandSettings(rest);
      break;
    default:
      throw new CliError(`Unknown command: ${command}\nRun thomas --help`);
  }
}

function printHelp(topic) {
  if (topic === "project" || topic === "projects") {
    console.log(`Project commands

Usage:
  thomas project add <name> <repo-path> [--worktrees-dir <dir>] [--base <ref>] [--gh-user <username>] [--identifier <id>] [--agent-profile <profile>] [--setup-script <file|->]
  thomas project list
  thomas project info <name>
  thomas project set-identifier <name> <identifier>
  thomas project set-agent-profile <name> <profile|default|none>
  thomas project set-setup-script <name> <file|-|none>
  thomas project remove <name>

Aliases:
  thomas register <name> <repo-path>
  thomas project set-claude-profile <name> <profile|default|none>

Notes:
  Setup scripts are stored in thomas config and run automatically from
  the workspace root after git worktree creation.
`);
    return;
  }

  if (topic === "workspace" || topic === "workspaces" || topic === "ws") {
    console.log(`Workspace commands

Usage:
  thomas workspace create <project> <name> [--base <branch>] [--agent <profile>] [--port <port>] [--terminal <auto|terminal|iterm|warp>] [--attach|--detach] [-- <command>...]
  thomas workspace list [project] [--all]
  thomas workspace status <project> <name>
  thomas workspace path <project> <name>
  thomas workspace remove <project> <name> [--force] [--delete-branch]
  thomas workspace archive <project> <name>

Notes:
  create uses git worktree add. If --agent or a command after -- is provided,
  a session is prepared and a terminal tab is opened by default.
  The workspace name determines the branch: <github-user>/<workspace>.
  If the project has a setup script, create runs it before preparing a session.
`);
    return;
  }

  if (topic === "kanban") {
    console.log(`Kanban commands

Usage:
  thomas kanban --create <project> [title] [--status <status>] [--agent <profile>] [--terminal <auto|terminal|iterm|warp>] [--attach|--detach]
  thomas kanban create <project> [title] [--status <status>] [--agent <profile>] [--terminal <auto|terminal|iterm|warp>] [--attach|--detach]
  thomas kanban list [project] [--all]
  thomas kanban status <ticket-id> <status>
  thomas kanban description <ticket-id> <description>
  thomas kanban project-id <project> <identifier>

Examples:
  thomas kanban --create thomas "Add board dashboard"
  thomas kanban status THOMAS-1 "PR Review"
  thomas kanban project-id jupiter-mobile JMOBILE

Behavior:
  Kanban is optional. Tickets are workspaces with extra board metadata.
  Ticket IDs use the project identifier and project-local number, such as
  THOMAS-1. Creating THOMAS-1 creates workspace thomas-1 and branch
  <github-user>/thomas-1.

Statuses:
  ${KANBAN_STATUSES.join(", ")}
`);
    return;
  }

  if (topic === "session" || topic === "sessions") {
    console.log(`Session commands

Usage:
  thomas session start <project> <workspace> [--agent <profile>] [--name <name>] [--port <port>] [--terminal <auto|terminal|iterm|warp>] [--attach|--detach] [-- <command>...]
  thomas session run <session-id>
  thomas session resume <session-id>
  thomas session list [project] [workspace] [--all]
  thomas session stop <session-id>
  thomas session logs <session-id> [--tail <lines>]

Examples:
  thomas session start app auth --agent codex
  thomas session start app auth --agent claude --terminal warp
  thomas session start app auth --agent codex --detach
  thomas session start app auth -- npm test -- --watch

Notes:
  Codex and Claude prepare a session and open a terminal tab by default.
  Run the printed thomas session run command inside that terminal to
  start the agent with thomas's project/workspace environment.
  Resume uses the agent's native resume command when supported.
  Use --detach for background log mode, or --attach to run immediately in the
  current terminal.
`);
    return;
  }

  if (topic === "pr") {
    console.log(`Pull request commands

Usage:
  thomas pr watch [project] [--once] [--interval <seconds>] [--cleanup] [--force] [--delete-branch]

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

  if (
    topic === "agent-profile" ||
    topic === "agent-profiles" ||
    topic === "claude-profile" ||
    topic === "claude-profiles"
  ) {
    console.log(`Agent profile commands

Usage:
  thomas agent-profile add <name> [command] [--type claude|codex]
  thomas agent-profile list
  thomas agent-profile default <name>
  thomas agent-profile remove <name>
  thomas agent-profile resolve [project]

Examples:
  thomas agent-profile add work claude-work --type claude
  thomas agent-profile default codex
  thomas project set-agent-profile app work

Behavior:
  Projects use their assigned agent profile. If no project profile is set,
  thomas uses the default agent profile.
  The built-in claude and codex profiles are always available. The default is
  claude unless you change it.

Aliases:
  thomas claude-profile ...
`);
    return;
  }

  if (topic === "settings" || topic === "setting") {
    console.log(`Settings commands

Usage:
  thomas settings show
  thomas settings notifications on|off
  thomas settings sound <sound-name|none>
  thomas settings terminal <auto|terminal|iterm|warp|warppreview>
  thomas settings macos-notification on|off
  thomas settings hooks status
  thomas settings hooks install <claude|codex|all>
  thomas settings hooks remove <claude|codex|all>
  thomas settings test

Notes:
  Claude uses Stop and SubagentStop hooks.
  Codex uses its notify command from ~/.codex/config.toml.
  Hook notifications default to thomas-launched sessions only.
  Terminal controls which app thomas uses for new agent tabs.
`);
    return;
  }

  if (topic === "dashboard" || topic === "dash") {
    console.log(`Dashboard command

Usage:
  thomas dashboard [--host <host>] [--port <port>] [--no-open]

Behavior:
  Starts a local web dashboard for the board, projects, workspaces, sessions,
  agent profiles, settings, and checks. Binds to localhost by default.
`);
    return;
  }

  if (topic === "state") {
    console.log(`State command

Usage:
  thomas state
  thomas dashboard [--host <host>] [--port <port>] [--no-open]

Notes:
  Prints the normalized thomas state as JSON for GUI and automation
  clients. The CLI config remains the source of truth.
`);
    return;
  }

  console.log(`thomas ${PACKAGE.version}

Local-first multi-agent workspace management with git worktrees.

Usage:
  thomas
  thomas <command> [options]

Commands:
  menu        Open the interactive selection menu
  project     Register and inspect repositories
  register    Alias for project add
  workspace   Create, inspect, archive, and remove git worktree workspaces
  kanban      Optional ticket board built on top of workspaces
  session     Start, list, stop, and inspect agent sessions
  checks      Show git and GitHub PR readiness for a workspace
  pr          Watch PR state and clean up merged workspaces
  agent-profile
               Configure named agent command profiles
  settings    Configure agent completion hooks and sounds
  state       Print JSON state for app integrations
  dashboard   Serve the local web dashboard
  doctor      Check local tool availability
  version     Print the CLI version

Common flow:
  thomas project add app ~/src/app
  thomas workspace create app auth --agent codex
  thomas workspace list app
  thomas checks app auth
  thomas pr watch app --cleanup

Optional kanban flow:
  thomas kanban --create app "Auth flow"
  thomas kanban status APP-1 "In Progress"

Agent sessions prepare a terminal tab by default.

Run thomas help <command> for command details.
`);
}

function commandDoctor() {
  const rows = [
    ["git", hasCommand("git") ? "ok" : "missing", "required"],
    ["sqlite3", hasCommand("sqlite3") ? "ok" : "missing", "required for local state"],
    ["gh", hasCommand("gh") ? "ok" : "missing", "needed for PR watch/checks"],
    ["codex", hasCommand("codex") ? "ok" : "missing", "optional agent"],
    ["claude", hasCommand("claude") ? "ok" : "missing", "optional agent"],
  ];

  printTable(rows, ["tool", "status", "purpose"]);
  console.log(`state: ${STATE_DB_PATH}`);
  if (fs.existsSync(CONFIG_PATH)) {
    console.log(`legacy config: ${CONFIG_PATH}`);
  }
}

function commandState(args) {
  if (args[0] === "--help" || args[0] === "-h") {
    printHelp("state");
    return;
  }

  if (args.length > 0) {
    throw new CliError("Usage: thomas state");
  }

  const config = loadConfig();
  refreshSessionStates(config);
  saveConfig(config);
  console.log(JSON.stringify(buildAppState(config), null, 2));
}

async function commandDashboard(args) {
  const parsed = parseOptions(args, {
    boolean: ["open", "no-open"],
    string: ["host", "port"],
  });
  if (parsed._.length > 0) {
    throw new CliError("Usage: thomas dashboard [--host <host>] [--port <port>] [--no-open]");
  }

  const host = parsed.host || "127.0.0.1";
  const requestedPort = Number.parseInt(parsed.port || process.env.THOMAS_DASHBOARD_PORT || "4587", 10);
  const port = Number.isFinite(requestedPort) && requestedPort >= 0 ? requestedPort : 4587;
  const server = http.createServer((req, res) => {
    handleDashboardRequest(req, res).catch((error) => {
      sendJson(res, error instanceof CliError ? error.exitCode === 404 ? 404 : 400 : 500, {
        ok: false,
        error: formatError(error),
      });
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://${host}:${actualPort}/`;
  console.log(`thomas dashboard: ${url}`);
  console.log("Press Ctrl-C to stop.");

  const shouldOpen = parsed.open || (!parsed["no-open"] && process.stdout.isTTY);
  if (shouldOpen) openBrowser(url);
}

async function handleDashboardRequest(req, res) {
  const requestUrl = new URL(req.url || "/", "http://localhost");
  if (req.method === "GET" && requestUrl.pathname === "/") {
    sendHtml(res, dashboardHtml("index.html"));
    return;
  }
  if (req.method === "GET" && requestUrl.pathname === "/api/state") {
    sendJson(res, 200, { ok: true, state: dashboardState() });
    return;
  }
  if (req.method === "GET" && requestUrl.pathname === "/api/checks") {
    const project = requestUrl.searchParams.get("project");
    const workspace = requestUrl.searchParams.get("workspace");
    if (!project || !workspace) throw new CliError("Missing project or workspace");
    sendJson(res, 200, { ok: true, output: captureOutput(() => commandChecks([project, workspace])) });
    return;
  }
  if (req.method === "GET" && requestUrl.pathname === "/api/session/logs") {
    const id = requestUrl.searchParams.get("id");
    if (!id) throw new CliError("Missing session id");
    sendJson(res, 200, { ok: true, output: captureOutput(() => sessionLogs([id, "--tail", "200"])) });
    return;
  }
  if (req.method === "POST" && requestUrl.pathname.startsWith("/api/")) {
    const body = await readRequestJson(req);
    const result = handleDashboardAction(requestUrl.pathname.slice("/api/".length), body || {});
    sendJson(res, 200, { ok: true, ...result, state: dashboardState() });
    return;
  }
  sendJson(res, 404, { ok: false, error: "Not found" });
}

function dashboardState() {
  const config = loadConfig();
  refreshSessionStates(config);
  saveConfig(config);
  return buildAppState(config);
}

function handleDashboardAction(action, body) {
  switch (action) {
    case "project/add":
      return withCapturedOutput(() => projectAdd(compactArgs([
        body.name,
        body.repoPath,
        "--worktrees-dir", body.worktreesDir,
        "--base", body.base,
        "--gh-user", body.githubUser,
        "--identifier", body.identifier,
        "--agent-profile", body.agentProfile,
      ])));
    case "project/remove":
      return withCapturedOutput(() => projectRemove(compactArgs([body.name, body.force ? "--force" : null])));
    case "project/set-agent-profile":
      return withCapturedOutput(() => projectSetAgentProfile([body.name, body.agentProfile || "default"]));
    case "project/set-identifier":
      return withCapturedOutput(() => projectSetIdentifier([body.name, body.identifier]));
    case "project/choose-repo":
      return { repoPath: chooseProjectRepoPath() };
    case "project/update":
      return withCapturedOutput(() => projectUpdateFromDashboard(body));
    case "kanban/create": {
      const args = compactArgs([
        body.project,
        body.title,
        "--description", body.description,
        "--status", body.status,
        "--agent", body.agent,
        "--port", body.port,
      ]);
      if (body.launchMode === "detach") args.push("--detach");
      if (body.launchMode === "terminal") args.push("--terminal", body.terminal || "auto");
      if (body.command) args.push("--", "sh", "-lc", body.command);
      return withCapturedOutput(() => kanbanCreate(args));
    }
    case "kanban/status":
      return withCapturedOutput(() => kanbanStatus([body.ticketId, body.status]));
    case "kanban/description":
      return withCapturedOutput(() => kanbanDescription([body.ticketId, body.description || ""]));
    case "workspace/create": {
      const args = compactArgs([
        body.project,
        body.name,
        "--base", body.base,
        "--path", body.path,
        "--agent", body.agent,
        "--session", body.sessionName,
        "--port", body.port,
      ]);
      if (body.launchMode === "detach") args.push("--detach");
      if (body.launchMode === "terminal") args.push("--terminal", body.terminal || "auto");
      if ((body.launchMode === "detach" || body.launchMode === "terminal") && !body.agent && !body.command) {
        args.push("--agent", loadConfig().settings.agentProfiles.default || "claude");
      }
      if (body.command) args.push("--", "sh", "-lc", body.command);
      return withCapturedOutput(() => workspaceCreate(args));
    }
    case "workspace/archive":
      return withCapturedOutput(() => workspaceArchive([body.project, body.workspace]));
    case "workspace/remove":
      return withCapturedOutput(() => workspaceRemove(compactArgs([
        body.project,
        body.workspace,
        body.force ? "--force" : null,
        body.deleteBranch ? "--delete-branch" : null,
      ])));
    case "session/start": {
      const args = compactArgs([
        body.project,
        body.workspace,
        "--agent", body.agent,
        "--name", body.name,
        "--port", body.port,
      ]);
      if (body.launchMode === "terminal") args.push("--terminal", body.terminal || "auto");
      else args.push("--detach");
      if (!body.agent && !body.command) {
        args.push("--agent", loadConfig().settings.agentProfiles.default || "claude");
      }
      if (body.command) args.push("--", "sh", "-lc", body.command);
      return withCapturedOutput(() => sessionStart(args));
    }
    case "session/stop":
      return withCapturedOutput(() => sessionStop([body.id]));
    case "session/resume":
      return withCapturedOutput(() => sessionResume([body.id]));
    case "agent-profile/add":
      return withCapturedOutput(() => commandAgentProfile(compactArgs(["add", body.name, body.command, "--type", body.type])));
    case "agent-profile/default":
      return withCapturedOutput(() => commandAgentProfile(["default", body.name]));
    case "agent-profile/remove":
      return withCapturedOutput(() => commandAgentProfile(["remove", body.name]));
    case "settings/update": {
      const config = loadConfig();
      if (body.terminalApp) config.settings.terminalApp = normalizeTerminalApp(body.terminalApp);
      if (body.notificationsEnabled !== undefined) config.settings.notifications.enabled = Boolean(body.notificationsEnabled);
      if (body.soundName !== undefined) config.settings.notifications.soundName = body.soundName || "none";
      if (body.macosNotification !== undefined) config.settings.notifications.macosNotification = Boolean(body.macosNotification);
      saveConfig(config);
      return { output: "Settings updated." };
    }
    case "settings/hooks/install":
      return withCapturedOutput(() => {
        const config = loadConfig();
        commandSettingsHooks(config, ["install", body.target || "all"]);
      });
    case "settings/hooks/remove":
      return withCapturedOutput(() => {
        const config = loadConfig();
        commandSettingsHooks(config, ["remove", body.target || "all"]);
      });
    case "settings/test":
      return withCapturedOutput(() => commandSettings(["test"]));
    default:
      throw new CliError(`Unknown dashboard action: ${action}`);
  }
}

function compactArgs(values) {
  const args = [];
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (value === null || value === undefined || value === "") {
      if (String(values[i - 1] || "").startsWith("--")) args.pop();
      continue;
    }
    args.push(String(value));
  }
  return args;
}

function withCapturedOutput(fn) {
  return { output: captureOutput(fn) };
}

function captureOutput(fn) {
  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...parts) => logs.push(parts.join(" "));
  console.error = (...parts) => logs.push(parts.join(" "));
  try {
    fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return logs.join("\n");
}

function readRequestJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(new CliError("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data.trim()) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(new CliError("Invalid JSON request body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendHtml(res, html) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
}

function openBrowser(url) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(opener, args, { detached: true, stdio: "ignore" });
  child.unref();
}

function dashboardHtml(fileName = "index.html") {
  return fs.readFileSync(path.join(ROOT_DIR, "dashboard", fileName), "utf8");
}

function buildAppState(config) {
  const workspaces = Object.values(config.workspaces)
    .flatMap((projectWorkspaces) => Object.values(projectWorkspaces))
    .sort((a, b) =>
      `${a.project}/${a.name}`.localeCompare(`${b.project}/${b.name}`),
    );
  return {
    version: config.version,
    cliVersion: PACKAGE.version,
    generatedAt: new Date().toISOString(),
    configPath: STATE_DB_PATH,
    statePath: STATE_DB_PATH,
    defaultGithubUser: detectDefaultGithubUsername(),
    projects: Object.values(config.projects).sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
    workspaces,
    kanban: {
      statuses: KANBAN_STATUSES,
      tickets: workspaces
        .filter((workspace) => workspace.kanban)
        .map((workspace) => kanbanTicketState(config, workspace))
        .sort((a, b) => a.sortKey.localeCompare(b.sortKey)),
    },
    sessions: Object.values(config.sessions).map(appSessionState).sort((a, b) =>
      String(b.startedAt || b.openedAt || b.resumedAt || "").localeCompare(
        String(a.startedAt || a.openedAt || a.resumedAt || ""),
      ),
    ),
    settings: config.settings,
  };
}

function kanbanTicketState(config, workspace) {
  const project = config.projects[workspace.project] || {};
  const ticket = workspace.kanban || {};
  const number = Number(ticket.number || 0);
  const identifier = project.identifier || defaultProjectIdentifier(workspace.project);
  const ticketId = formatTicketId(identifier, number);
  const status = normalizeKanbanStatus(ticket.status || "To-do");
  return {
    id: ticketId,
    sortKey: `${workspace.project}/${String(number).padStart(8, "0")}`,
    project: workspace.project,
    projectIdentifier: identifier,
    number,
    title: ticket.title || ticketId,
    description: ticket.description || "",
    status,
    workspace: workspace.name,
    workspaceStatus: workspace.status,
    branch: workspace.branch,
    path: workspace.path,
    prUrl: workspace.prUrl || null,
    createdAt: ticket.createdAt || workspace.createdAt,
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

  console.log(`thomas ${PACKAGE.version}`);

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
          description: "launch an agent profile or command in a workspace",
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
          description: "add a repo to thomas",
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
  const config = loadConfig();
  const defaultRepo = tryRepoRoot(process.cwd()) || process.cwd();
  const defaultName = normalizeName(path.basename(defaultRepo), "project");
  const name = await ask(rl, "Project name", defaultName);
  const repoPath = await ask(rl, "Repo path", defaultRepo);
  const base = await ask(rl, "Base ref", "origin/main");
  const identifier = await ask(
    rl,
    "Kanban identifier",
    defaultProjectIdentifier(name),
  );
  const ghUser = await ask(rl, "GitHub username for branch prefix", "");
  const worktreesDir = await ask(
    rl,
    "Worktrees dir",
    defaultWorktreesDir(name),
  );
  const agentProfile = await choose(rl, "Agent profile", [
    { label: `Default (${config.settings.agentProfiles.default})`, value: "default" },
    ...agentProfileChoices(config),
  ]);
  const setupScript = await ask(
    rl,
    "Setup script path (stored in config, blank for none)",
    "",
  );

  const args = [name, repoPath];
  if (worktreesDir) args.push("--worktrees-dir", worktreesDir);
  if (base) args.push("--base", base);
  if (identifier) args.push("--identifier", identifier);
  if (ghUser) args.push("--gh-user", ghUser);
  if (agentProfile !== "default") args.push("--agent-profile", agentProfile);
  if (setupScript) args.push("--setup-script", setupScript);
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
  const sessionMode = await choose(
    rl,
    "Start a session now?",
    agentProfileChoices(config, { includeNone: true, includeCustom: true }),
  );

  const args = [projectName, workspaceName];
  if (base) args.push("--base", base);
  let customCommand = null;

  if (sessionMode !== "none" && sessionMode !== "custom") {
    args.push("--agent", sessionMode);
    const port = await ask(rl, "THOMAS_PORT", "");
    if (port) args.push("--port", port);
  } else if (sessionMode === "custom") {
    const command = await askRequired(rl, "Command to run");
    const port = await ask(rl, "THOMAS_PORT", "");
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

  const sessionMode = await choose(
    rl,
    "Session type",
    agentProfileChoices(config, { includeCustom: true, includeBack: true }),
  );
  if (sessionMode === "back") return;

  const args = [projectName, workspaceName];
  const name = await ask(rl, "Session name", "");
  const port = await ask(rl, "THOMAS_PORT", "");
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
    { label: "Agent profiles", value: "agent-profile" },
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
      sendNotification(config.settings.notifications, "test", "thomas/settings");
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

function agentProfileChoices(config, options = {}) {
  const defaultName = config.settings.agentProfiles.default || "claude";
  const profiles = Object.values(config.settings.agentProfiles.profiles || {})
    .sort((a, b) =>
      agentProfileChoiceSortKey(a.name, defaultName)
        .localeCompare(agentProfileChoiceSortKey(b.name, defaultName)),
    );
  const choices = profiles.map((profile) => ({
    label: profile.name === defaultName ? `${profile.name} (default)` : profile.name,
    value: profile.name,
    description: profile.command,
  }));
  if (options.includeNone) {
    choices.unshift({ label: "No", value: "none" });
  }
  if (options.includeCustom) {
    choices.push({ label: "Custom command", value: "custom" });
  }
  if (options.includeBack) {
    choices.push({ label: "Back", value: "back" });
  }
  return choices;
}

function agentProfileChoiceSortKey(name, defaultName) {
  if (name === defaultName) return "0";
  return `1-${agentProfileSortKey(name)}`;
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
    case "set-identifier":
    case "set-id":
      projectSetIdentifier(args.slice(1));
      break;
    case "set-agent-profile":
      projectSetAgentProfile(args.slice(1));
      break;
    case "set-setup-script":
      projectSetSetupScript(args.slice(1));
      break;
    case "set-claude-profile":
      projectSetAgentProfile(args.slice(1), { legacyName: "set-claude-profile" });
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
    string: [
      "worktrees-dir",
      "main",
      "base",
      "gh-user",
      "identifier",
      "agent-profile",
      "claude-profile",
      "setup-script",
    ],
  });

  const [name, repoInput] = parsed._;
  if (!name || !repoInput) {
    throw new CliError("Usage: thomas project add <name> <repo-path>");
  }
  validateName(name, "project");

  const repoPath = resolveRepoPath(repoInput);
  const worktreesDir = path.resolve(
    parsed["worktrees-dir"] || defaultWorktreesDir(name),
  );
  const mainBranch = parsed.base || parsed.main || "origin/main";
  const githubUser = parsed["gh-user"] || detectGithubUsername(repoPath);
  const identifier = normalizeProjectIdentifier(
    parsed.identifier || defaultProjectIdentifier(name),
  );
  const agentProfile = normalizeOptionalAgentProfile(
    parsed["agent-profile"] || parsed["claude-profile"],
  );
  const setupScript = parsed["setup-script"]
    ? readSetupScriptInput(parsed["setup-script"])
    : null;
  const remote = git(repoPath, ["config", "--get", "remote.origin.url"], {
    allowFailure: true,
  }).stdout.trim();

  const config = loadConfig();
  if (agentProfile && !config.settings.agentProfiles.profiles[agentProfile]) {
    throw new CliError(`Unknown agent profile: ${agentProfile}`);
  }
  if (config.projects[name]) {
    throw new CliError(`Project already exists: ${name}`);
  }

  config.projects[name] = {
    name,
    repoPath,
    worktreesDir,
    mainBranch,
    identifier,
    kanbanNextNumber: 1,
    githubUser: githubUser || null,
    agentProfile,
    setupScript,
    remote: remote || null,
    createdAt: new Date().toISOString(),
  };
  config.workspaces[name] = config.workspaces[name] || {};
  saveConfig(config);

  console.log(`Registered project ${name}`);
  console.log(`repo: ${repoPath}`);
  console.log(`worktrees: ${worktreesDir}`);
  console.log(`base: ${mainBranch}`);
  console.log(`identifier: ${identifier}`);
  console.log(`branch prefix: ${githubUser || "thomas"}/*`);
  console.log(`Agent profile: ${agentProfile || "default"}`);
  console.log(`Setup script: ${setupScript ? "configured" : "none"}`);
}

function projectList() {
  const config = loadConfig();
  const rows = Object.values(config.projects).map((project) => {
    const workspaces = Object.values(config.workspaces[project.name] || {});
    const active = workspaces.filter((ws) => ws.status === "active").length;
    return [
      project.name,
      project.identifier || defaultProjectIdentifier(project.name),
      project.repoPath,
      project.mainBranch,
      project.agentProfile || "default",
      String(active),
      project.worktreesDir,
    ];
  });

  if (rows.length === 0) {
    console.log("No projects registered.");
    return;
  }

  printTable(rows, ["name", "id", "repo", "base", "agent", "active", "worktrees"]);
}

function projectInfo(args) {
  const [name] = args;
  if (!name) throw new CliError("Usage: thomas project info <name>");

  const config = loadConfig();
  const project = requireProject(config, name);
  const workspaces = Object.values(config.workspaces[name] || {});

  console.log(`name: ${project.name}`);
  console.log(`repo: ${project.repoPath}`);
  console.log(`worktrees: ${project.worktreesDir}`);
  console.log(`base: ${project.mainBranch}`);
  console.log(`identifier: ${project.identifier || defaultProjectIdentifier(project.name)}`);
  console.log(`next ticket: ${project.kanbanNextNumber || nextKanbanNumber(config, project.name)}`);
  console.log(`branch prefix: ${project.githubUser || "thomas"}/*`);
  const resolved = resolveAgentProfile(config, project.name);
  console.log(`Agent profile: ${project.agentProfile || "default"} (${resolved.name} -> ${resolved.command})`);
  console.log(`Setup script: ${project.setupScript?.content ? "configured" : "none"}`);
  if (project.remote) console.log(`remote: ${project.remote}`);
  console.log(`workspaces: ${workspaces.length}`);
}

function projectSetIdentifier(args) {
  const [name, identifierInput] = args;
  if (!name || !identifierInput) {
    throw new CliError("Usage: thomas project set-identifier <name> <identifier>");
  }
  const config = loadConfig();
  const project = requireProject(config, name);
  project.identifier = normalizeProjectIdentifier(identifierInput);
  project.kanbanNextNumber = Math.max(
    Number(project.kanbanNextNumber || 1),
    nextKanbanNumber(config, name),
  );
  saveConfig(config);
  console.log(`Project ${name} identifier set to ${project.identifier}.`);
}

function projectSetAgentProfile(args, options = {}) {
  const [name, profileInput] = args;
  if (!name || !profileInput) {
    const sub = options.legacyName || "set-agent-profile";
    throw new CliError(`Usage: thomas project ${sub} <name> <profile|default|none>`);
  }
  const config = loadConfig();
  const project = requireProject(config, name);
  const profile = normalizeOptionalAgentProfile(profileInput);
  if (profile && !config.settings.agentProfiles.profiles[profile]) {
    throw new CliError(`Unknown agent profile: ${profile}`);
  }
  project.agentProfile = profile;
  delete project.claudeProfile;
  saveConfig(config);
  console.log(`Project ${name} agent profile set to ${profile || "default"}.`);
}

function projectUpdateFromDashboard(body) {
  const name = body.name;
  if (!name) throw new CliError("Missing project name.");
  const config = loadConfig();
  const project = requireProject(config, name);

  if (body.identifier !== undefined) {
    project.identifier = normalizeProjectIdentifier(body.identifier);
  }
  if (body.base !== undefined && String(body.base).trim()) {
    project.mainBranch = String(body.base).trim();
  }
  if (body.githubUser !== undefined) {
    const githubUser = String(body.githubUser || "").trim();
    project.githubUser = githubUser ? sanitizeBranchSegment(githubUser) : null;
  }
  if (body.agentProfile !== undefined) {
    const profile = normalizeOptionalAgentProfile(body.agentProfile);
    if (profile && !config.settings.agentProfiles.profiles[profile]) {
      throw new CliError(`Unknown agent profile: ${profile}`);
    }
    project.agentProfile = profile;
  }
  if (body.setupScript !== undefined) {
    const content = String(body.setupScript || "");
    project.setupScript = content.trim()
      ? {
          source: "dashboard",
          content,
          updatedAt: new Date().toISOString(),
        }
      : null;
  }

  project.kanbanNextNumber = Math.max(
    Number(project.kanbanNextNumber || 1),
    nextKanbanNumber(config, name),
  );
  saveConfig(config);
  console.log(`Updated project ${name}.`);
}

function projectSetSetupScript(args) {
  const [name, scriptInput, ...extra] = args;
  if (!name || !scriptInput || extra.length > 0) {
    throw new CliError("Usage: thomas project set-setup-script <name> <file|-|none>");
  }
  const config = loadConfig();
  const project = requireProject(config, name);
  project.setupScript = readSetupScriptInput(scriptInput);
  saveConfig(config);
  console.log(`Project ${name} setup script ${project.setupScript ? "configured" : "cleared"}.`);
}

function projectRemove(args) {
  const parsed = parseOptions(args, { boolean: ["force"] });
  const [name] = parsed._;
  if (!name) throw new CliError("Usage: thomas project remove <name>");

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

function commandKanban(args) {
  const normalized = normalizeKanbanArgs(args);
  const sub = normalized[0] || "list";

  if (sub === "--help" || sub === "-h" || sub === "help") {
    printHelp("kanban");
    return;
  }

  switch (sub) {
    case "create":
      kanbanCreate(normalized.slice(1));
      break;
    case "list":
    case "ls":
      kanbanList(normalized.slice(1));
      break;
    case "status":
    case "move":
      kanbanStatus(normalized.slice(1));
      break;
    case "description":
    case "describe":
      kanbanDescription(normalized.slice(1));
      break;
    case "project-id":
    case "identifier":
      projectSetIdentifier(normalized.slice(1));
      break;
    default:
      throw new CliError(`Unknown kanban command: ${sub}`);
  }
}

function normalizeKanbanArgs(args) {
  if (args[0] === "--create") return ["create", ...args.slice(1)];
  if (args[0] === "--list") return ["list", ...args.slice(1)];
  if (args[0] === "--status") return ["status", ...args.slice(1)];
  if (args[0] === "--project-id" || args[0] === "--identifier") {
    return ["project-id", ...args.slice(1)];
  }
  return args;
}

function kanbanCreate(args) {
  const parsed = parseOptions(args, {
    boolean: ["attach", "detach"],
    string: ["status", "description", "agent", "session", "port", "terminal", "base"],
  });
  const [projectName, ...titleParts] = parsed._;
  if (!projectName) {
    throw new CliError("Usage: thomas kanban --create <project> [title] [options]");
  }

  const config = loadConfig();
  const project = requireProject(config, projectName);
  const number = nextKanbanNumber(config, projectName);
  const identifier = project.identifier || defaultProjectIdentifier(projectName);
  const ticketId = formatTicketId(identifier, number);
  const workspaceName = normalizeName(ticketId.toLowerCase(), "workspace");
  const status = normalizeKanbanStatus(parsed.status || "To-do");
  const title = titleParts.join(" ").trim() || ticketId;
  const description = parsed.description || "";

  const createArgs = [projectName, workspaceName];
  if (parsed.base) createArgs.push("--base", parsed.base);
  if (parsed.agent) createArgs.push("--agent", parsed.agent);
  if (parsed.session) createArgs.push("--session", parsed.session);
  if (parsed.port) createArgs.push("--port", parsed.port);
  if (parsed.terminal) createArgs.push("--terminal", parsed.terminal);
  if (parsed.attach) createArgs.push("--attach");
  if (parsed.detach) createArgs.push("--detach");
  if (parsed["--"].length > 0) createArgs.push("--", ...parsed["--"]);

  workspaceCreate(createArgs);

  const updatedConfig = loadConfig();
  const workspace = requireWorkspace(updatedConfig, projectName, workspaceName);
  workspace.kanban = {
    number,
    title,
    description,
    status,
    createdAt: workspace.createdAt || new Date().toISOString(),
  };
  const updatedProject = requireProject(updatedConfig, projectName);
  updatedProject.identifier = identifier;
  updatedProject.kanbanNextNumber = Math.max(number + 1, nextKanbanNumber(updatedConfig, projectName));
  saveConfig(updatedConfig);

  console.log(`ticket: ${ticketId}`);
  console.log(`status: ${status}`);
  console.log(`title: ${title}`);
}

function kanbanList(args) {
  const parsed = parseOptions(args, { boolean: ["all"] });
  const [projectName] = parsed._;
  const config = loadConfig();
  if (projectName) requireProject(config, projectName);
  const rows = [];

  for (const workspace of Object.values(config.workspaces).flatMap((items) => Object.values(items))) {
    if (!workspace.kanban) continue;
    if (projectName && workspace.project !== projectName) continue;
    if (!parsed.all && workspace.status !== "active") continue;
    const ticket = kanbanTicketState(config, workspace);
    rows.push([
      ticket.id,
      ticket.status,
      ticket.project,
      ticket.workspace,
      ticket.title,
      ticket.branch || "",
    ]);
  }

  rows.sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  if (rows.length === 0) {
    console.log("No kanban tickets found.");
    return;
  }
  printTable(rows, ["ticket", "status", "project", "workspace", "title", "branch"]);
}

function kanbanStatus(args) {
  const [ticketInput, ...statusParts] = args;
  const statusInput = statusParts.join(" ");
  if (!ticketInput || !statusInput) {
    throw new CliError("Usage: thomas kanban status <ticket-id> <status>");
  }
  const status = normalizeKanbanStatus(statusInput);
  const config = loadConfig();
  const workspace = findKanbanWorkspace(config, ticketInput);
  workspace.kanban.status = status;
  workspace.kanban.updatedAt = new Date().toISOString();
  saveConfig(config);
  console.log(`${kanbanTicketState(config, workspace).id} -> ${status}`);
}

function kanbanDescription(args) {
  const [ticketInput, ...descriptionParts] = args;
  if (!ticketInput) {
    throw new CliError("Usage: thomas kanban description <ticket-id> <description>");
  }
  const config = loadConfig();
  const workspace = findKanbanWorkspace(config, ticketInput);
  workspace.kanban = workspace.kanban || {};
  const status = normalizeKanbanStatus(workspace.kanban.status || "To-do");
  if (status !== "To-do") {
    throw new CliError("Ticket description can only be edited while status is To-do.");
  }
  workspace.kanban.description = descriptionParts.join(" ");
  workspace.kanban.updatedAt = new Date().toISOString();
  saveConfig(config);
  console.log(`${kanbanTicketState(config, workspace).id} description updated.`);
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
      "Usage: thomas workspace create <project> <name> [options]",
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

  runProjectSetupScript(project, workspace);

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
    throw new CliError("Usage: thomas workspace status <project> <name>");
  }

  const config = loadConfig();
  const workspace = requireWorkspace(config, projectName, workspaceName);
  printWorkspaceStatus(workspace);
}

function workspacePath(args) {
  const [projectName, workspaceName] = args;
  if (!projectName || !workspaceName) {
    throw new CliError("Usage: thomas workspace path <project> <name>");
  }

  const config = loadConfig();
  const workspace = requireWorkspace(config, projectName, workspaceName);
  console.log(workspace.path);
}

function workspaceArchive(args) {
  const [projectName, workspaceName] = args;
  if (!projectName || !workspaceName) {
    throw new CliError("Usage: thomas workspace archive <project> <name>");
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
    throw new CliError("Usage: thomas workspace remove <project> <name>");
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

function commandAgentProfile(args, options = {}) {
  const sub = args[0] || "list";
  if (sub === "--help" || sub === "-h") {
    printHelp("agent-profile");
    return;
  }
  const commandName = options.legacyName || "agent-profile";
  const config = loadConfig();
  switch (sub) {
    case "add": {
      const parsed = parseOptions(args.slice(1), {
        string: ["type", "command"],
      });
      const [name, commandArg, ...extra] = parsed._;
      if (!name || extra.length > 0) {
        throw new CliError(`Usage: thomas ${commandName} add <name> [command] [--type claude|codex]`);
      }
      validateAgentProfileName(name, { allowBuiltin: false });
      const type = normalizeAgentProfileType(parsed.type || name);
      const command = parsed.command || commandArg || defaultAgentCommand(type);
      config.settings.agentProfiles.profiles[name] = { name, type, command };
      saveConfig(config);
      console.log(`Agent profile ${name} (${type}) -> ${command}`);
      break;
    }
    case "list":
    case "ls":
      printAgentProfiles(config);
      break;
    case "default": {
      const name = args[1];
      if (!name) throw new CliError(`Usage: thomas ${commandName} default <name>`);
      if (!config.settings.agentProfiles.profiles[name]) {
        throw new CliError(`Unknown agent profile: ${name}`);
      }
      config.settings.agentProfiles.default = name;
      saveConfig(config);
      console.log(`Default agent profile set to ${name}.`);
      break;
    }
    case "remove":
    case "rm": {
      const name = args[1];
      if (!name) throw new CliError(`Usage: thomas ${commandName} remove <name>`);
      if (isBuiltinAgentProfile(name)) {
        throw new CliError("Built-in agent profiles cannot be removed.");
      }
      if (!config.settings.agentProfiles.profiles[name]) {
        throw new CliError(`Unknown agent profile: ${name}`);
      }
      delete config.settings.agentProfiles.profiles[name];
      if (config.settings.agentProfiles.default === name) {
        config.settings.agentProfiles.default = "claude";
      }
      for (const project of Object.values(config.projects)) {
        if (project.agentProfile === name) project.agentProfile = null;
      }
      saveConfig(config);
      console.log(`Removed agent profile ${name}.`);
      break;
    }
    case "resolve": {
      const project = args[1] || null;
      const profile = resolveAgentProfile(config, project);
      console.log(`${profile.name}: ${profile.type || "claude"} -> ${profile.command}`);
      break;
    }
    default:
      throw new CliError(`Unknown ${commandName} command: ${sub}`);
  }
}

function printAgentProfiles(config) {
  const profiles = Object.values(config.settings.agentProfiles.profiles || {})
    .sort((a, b) => agentProfileSortKey(a.name).localeCompare(agentProfileSortKey(b.name)));
  const defaultName = config.settings.agentProfiles.default || "claude";
  printTable(
    profiles.map((profile) => [
      profile.name,
      profile.type || "claude",
      profile.command,
      profile.name === defaultName ? "yes" : "",
      isBuiltinAgentProfile(profile.name) ? "yes" : "",
    ]),
    ["name", "type", "command", "default", "built-in"],
  );
}

function normalizeOptionalAgentProfile(value) {
  if (!value || value === "default" || value === "none") return null;
  validateAgentProfileName(value, { allowBuiltin: true });
  return value;
}

function validateAgentProfileName(name, options = {}) {
  validateName(name, "agent profile");
  if (name === "default" || name === "none") {
    throw new CliError("Agent profile names 'default' and 'none' are reserved.");
  }
  if (!options.allowBuiltin && isBuiltinAgentProfile(name)) {
    throw new CliError("Built-in agent profile names 'claude' and 'codex' are reserved.");
  }
}

function resolveAgentProfile(config, projectName = null, requestedName = null) {
  const profiles = config.settings.agentProfiles || defaultAgentProfiles();
  let profileName = null;
  if (requestedName) profileName = requestedName;
  if (projectName && config.projects[projectName]) {
    profileName = profileName || config.projects[projectName].agentProfile || null;
  }
  profileName = profileName || profiles.default;
  if (profileName && profiles.profiles?.[profileName]?.command) {
    return profiles.profiles[profileName];
  }
  if (requestedName) {
    throw new CliError(`Unknown agent profile: ${requestedName}`);
  }
  return profiles.profiles.claude || { name: "claude", command: "claude" };
}

function resolveAgentProfileCommand(config, projectName = null, requestedName = null) {
  return resolveAgentProfile(config, projectName, requestedName).command;
}

function isBuiltinAgentProfile(name) {
  return name === "claude" || name === "codex";
}

function agentProfileSortKey(name) {
  if (name === "claude") return "0";
  if (name === "codex") return "1";
  return `2-${name}`;
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
        "Usage: thomas settings notifications on|off",
      );
      saveConfig(config);
      console.log(
        `Notifications ${config.settings.notifications.enabled ? "enabled" : "disabled"}.`,
      );
      break;
    case "sound":
      if (!args[1]) {
        throw new CliError("Usage: thomas settings sound <sound-name|none>");
      }
      config.settings.notifications.soundName = args[1];
      saveConfig(config);
      console.log(`Sound set to ${args[1]}.`);
      break;
    case "terminal":
      if (!args[1]) {
        throw new CliError(
          "Usage: thomas settings terminal <auto|terminal|iterm|warp|warppreview>",
        );
      }
      config.settings.terminalApp = normalizeTerminalApp(args[1]);
      saveConfig(config);
      console.log(`Terminal app set to ${terminalLabel(config.settings.terminalApp)}.`);
      break;
    case "macos-notification":
      config.settings.notifications.macosNotification = requireBoolean(
        args[1],
        "Usage: thomas settings macos-notification on|off",
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
      sendNotification(config.settings.notifications, "test", "thomas/settings");
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
        throw new CliError("Usage: thomas settings hooks install <claude|codex|all>");
      }
      saveConfig(config);
      console.log(`Installed ${target} hook${target === "all" ? "s" : ""}.`);
      break;
    case "remove":
      if (target === "claude" || target === "all") removeClaudeHook(config);
      if (target === "codex" || target === "all") removeCodexHook(config);
      if (!["claude", "codex", "all"].includes(target)) {
        throw new CliError("Usage: thomas settings hooks remove <claude|codex|all>");
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
      "Usage: thomas session start <project> <workspace> [options]",
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
    usage: "Usage: thomas session run <session-id>",
    action: "Starting",
    commandForSession: (session) => session.command,
    missingMessage: (session) => `Session ${session.id} does not have a runnable command.`,
  });
}

function sessionResume(args) {
  runStoredSessionCommand(args, {
    usage: "Usage: thomas session resume <session-id>",
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

  if (agent.includes("codex") || binary.includes("codex")) {
    return [executable || "codex", "resume", "--last"];
  }
  if (agent.includes("claude") || binary.includes("claude")) {
    return [executable || "claude", "--continue"];
  }
  return null;
}

function sessionEnvForRun(config, session) {
  if (session.env && typeof session.env === "object") return session.env;
  const workspace = config.workspaces?.[session.project]?.[session.workspace];
  return {
    THOMAS_CLI: "1",
    THOMAS_SESSION_ID: session.id,
    THOMAS_SESSION_NAME: session.name || session.id,
    THOMAS_PROJECT: session.project,
    THOMAS_WORKSPACE: session.workspace,
    ...(workspace?.branch ? { THOMAS_BRANCH: workspace.branch } : {}),
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
  if (!id) throw new CliError("Usage: thomas session stop <session-id>");

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
  if (!id) throw new CliError("Usage: thomas session logs <session-id>");

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
  if (hasCommand("thomas")) return "thomas";
  return shellJoin([process.execPath, SCRIPT_PATH]);
}

function commandChecks(args) {
  const [projectName, workspaceName] = args;
  if (!projectName || !workspaceName) {
    throw new CliError("Usage: thomas checks <project> <workspace>");
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
  const agent = options.agent || (hasCommand ? null : config.settings.agentProfiles.default);
  if (!hasCommand && config.settings.agentProfiles.profiles[agent]) {
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
    const profile = resolveAgentProfile(config, projectName, agent);
    agent = profile.name;
    command = [profile.command];
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
    THOMAS_CLI: "1",
    THOMAS_SESSION_ID: id,
    THOMAS_SESSION_NAME: sessionName,
    THOMAS_PROJECT: projectName,
    THOMAS_WORKSPACE: workspace.name,
    THOMAS_BRANCH: workspace.branch,
    ...(options.port ? { THOMAS_PORT: String(options.port) } : {}),
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
  const prefix = username ? sanitizeBranchSegment(username) : "thomas";
  return `${prefix}/${sanitizeBranchSegment(workspaceName)}`;
}

function defaultProjectIdentifier(name) {
  const parts = String(name || "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const raw = parts.length === 0
    ? "PROJECT"
    : parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).map((part) => part[0]).join("")}${parts[parts.length - 1]}`;
  return normalizeProjectIdentifier(
    /^[A-Za-z]/.test(raw) ? raw : `P${raw}`,
  );
}

function normalizeProjectIdentifier(identifier) {
  const normalized = String(identifier || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "");
  if (!normalized) throw new CliError("Project identifier cannot be empty.");
  if (!/^[A-Z][A-Z0-9]*$/.test(normalized)) {
    throw new CliError("Project identifier must start with a letter and contain only letters or numbers.");
  }
  return normalized;
}

function formatTicketId(identifier, number) {
  const parsed = Number.parseInt(number, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CliError(`Invalid ticket number: ${number}`);
  }
  return `${normalizeProjectIdentifier(identifier)}-${parsed}`;
}

function normalizeKanbanStatus(status) {
  const normalized = String(status || "")
    .trim()
    .toLowerCase()
    .replace(/[-_\s]+/g, " ");
  const match = KANBAN_STATUSES.find(
    (value) => value.toLowerCase().replace(/[-_\s]+/g, " ") === normalized,
  );
  if (!match) {
    throw new CliError(`Unknown kanban status: ${status}\nUse one of: ${KANBAN_STATUSES.join(", ")}`);
  }
  return match;
}

function nextKanbanNumber(config, projectName) {
  const project = requireProject(config, projectName);
  const configured = Number.parseInt(project.kanbanNextNumber || "1", 10);
  const maxExisting = Object.values(config.workspaces[projectName] || {})
    .map((workspace) => Number.parseInt(workspace.kanban?.number || "0", 10))
    .filter((number) => Number.isInteger(number) && number > 0)
    .reduce((max, number) => Math.max(max, number), 0);
  return Math.max(Number.isInteger(configured) ? configured : 1, maxExisting + 1);
}

function findKanbanWorkspace(config, ticketInput) {
  const parsed = parseTicketId(ticketInput);
  const matches = [];
  for (const project of Object.values(config.projects)) {
    const identifier = project.identifier || defaultProjectIdentifier(project.name);
    if (identifier !== parsed.identifier) continue;
    const workspace = Object.values(config.workspaces[project.name] || {})
      .find((item) => Number(item.kanban?.number) === parsed.number);
    if (workspace) matches.push(workspace);
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new CliError(`Ambiguous ticket id: ${ticketInput}`);
  throw new CliError(`Unknown kanban ticket: ${ticketInput}`);
}

function parseTicketId(ticketInput) {
  const match = String(ticketInput || "").trim().match(/^([A-Za-z][A-Za-z0-9]*)-(\d+)$/);
  if (!match) throw new CliError(`Invalid ticket id: ${ticketInput}`);
  return {
    identifier: normalizeProjectIdentifier(match[1]),
    number: Number.parseInt(match[2], 10),
  };
}

function detectGithubUsername(repoPath) {
  const envUser =
    process.env.THOMAS_CLI_GH_USER ||
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

function detectDefaultGithubUsername() {
  const envUser =
    process.env.THOMAS_CLI_GH_USER ||
    process.env.GITHUB_USER ||
    process.env.GH_USER;
  if (envUser) return sanitizeBranchSegment(envUser);
  if (!hasCommand("gh")) return null;

  const ghUser = run("gh", ["api", "user", "--jq", ".login"], {
    allowFailure: true,
  }).stdout.trim();
  return ghUser ? sanitizeBranchSegment(ghUser) : null;
}

function chooseProjectRepoPath() {
  if (process.platform !== "darwin") {
    throw new CliError("Folder picker is currently supported on macOS only.");
  }
  const result = run("osascript", [
    "-e",
    'POSIX path of (choose folder with prompt "Select project repository")',
  ], {
    allowFailure: true,
  });
  if (result.status !== 0) {
    throw new CliError((result.stderr || result.stdout || "Folder selection cancelled.").trim());
  }
  return result.stdout.trim().replace(/\/$/, "");
}

function readSetupScriptInput(input) {
  const normalized = String(input || "").trim();
  if (["none", "null", "clear", "off", "remove", "delete"].includes(normalized.toLowerCase())) {
    return null;
  }

  const content = normalized === "-"
    ? fs.readFileSync(0, "utf8")
    : fs.readFileSync(path.resolve(expandHome(normalized)), "utf8");
  if (!content.trim()) throw new CliError("Setup script cannot be empty.");

  return {
    source: normalized,
    content,
    updatedAt: new Date().toISOString(),
  };
}

function runProjectSetupScript(project, workspace) {
  const setupScript = project.setupScript;
  if (!setupScript?.content) return;

  const scriptPath = path.join(workspace.path, ".context", "thomas-setup-script");
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, setupScript.content);
  fs.chmodSync(scriptPath, 0o700);

  console.log("Running setup script...");
  const command = setupScript.content.startsWith("#!") ? scriptPath : "/bin/sh";
  const args = setupScript.content.startsWith("#!") ? [] : [scriptPath];
  const result = spawnSync(command, args, {
    cwd: workspace.path,
    env: {
      ...process.env,
      THOMAS_CLI: "1",
      THOMAS_PROJECT: project.name,
      THOMAS_WORKSPACE: workspace.name,
      THOMAS_BRANCH: workspace.branch,
      THOMAS_WORKSPACE_PATH: workspace.path,
      THOMAS_REPO_PATH: project.repoPath,
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) throw new CliError(`Setup script failed: ${result.error.message}`);
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new CliError(
      `Setup script failed with exit code ${result.status}${output ? `\n${output}` : ""}`,
    );
  }
  console.log("Setup script completed.");
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
    agentProfiles: defaultAgentProfiles(),
  };
}

function defaultAgentProfiles() {
  return {
    default: "claude",
    profiles: {
      claude: { name: "claude", type: "claude", command: "claude" },
      codex: { name: "codex", type: "codex", command: "codex" },
    },
  };
}

function normalizeAgentProfile(name, profile) {
  const raw = typeof profile === "string" ? { command: profile } : profile || {};
  const type = normalizeAgentProfileType(raw.type || name);
  return {
    name: raw.name || name,
    type,
    command: raw.command || defaultAgentCommand(type),
  };
}

function normalizeAgentProfileType(type) {
  const normalized = String(type || "").trim().toLowerCase();
  if (normalized === "codex") return "codex";
  return "claude";
}

function defaultAgentCommand(type) {
  return normalizeAgentProfileType(type) === "codex" ? "codex" : "claude";
}

function normalizeConfig(config) {
  const defaults = defaultConfig();
  const rawSettings = config.settings || {};
  const rawAgentProfiles = rawSettings.agentProfiles || {};
  const rawClaudeProfiles = rawSettings.claudeProfiles || {};
  const agentProfiles = {
    default:
      rawAgentProfiles.default ||
      rawClaudeProfiles.default ||
      defaults.settings.agentProfiles.default,
    profiles: {
      ...defaults.settings.agentProfiles.profiles,
      ...(rawClaudeProfiles.profiles || {}),
      ...(rawAgentProfiles.profiles || {}),
    },
  };
  for (const [name, profile] of Object.entries(agentProfiles.profiles)) {
    agentProfiles.profiles[name] = normalizeAgentProfile(name, profile);
  }
  if (!agentProfiles.profiles[agentProfiles.default]) {
    agentProfiles.default = defaults.settings.agentProfiles.default;
  }

  config.version = config.version || defaults.version;
  config.projects = config.projects || {};
  config.workspaces = config.workspaces || {};
  config.sessions = config.sessions || {};
  config.settings = {
    ...defaults.settings,
    ...rawSettings,
    terminalApp: normalizeTerminalSetting(
      rawSettings.terminalApp || defaults.settings.terminalApp,
    ),
    notifications: {
      ...defaults.settings.notifications,
      ...(rawSettings.notifications || {}),
    },
    agentHooks: {
      ...defaults.settings.agentHooks,
      ...(rawSettings.agentHooks || {}),
      claude: {
        ...defaults.settings.agentHooks.claude,
        ...((rawSettings.agentHooks || {}).claude || {}),
      },
      codex: {
        ...defaults.settings.agentHooks.codex,
        ...((rawSettings.agentHooks || {}).codex || {}),
      },
    },
    agentProfiles,
  };
  delete config.settings.claudeProfiles;
  delete config.settings.notifications.scope;
  for (const project of Object.values(config.projects)) {
    project.identifier = normalizeProjectIdentifier(
      project.identifier || defaultProjectIdentifier(project.name),
    );
    project.kanbanNextNumber = Math.max(
      Number.parseInt(project.kanbanNextNumber || "1", 10) || 1,
      nextKanbanNumberForProjectData(config, project.name),
    );
    if (!project.agentProfile && project.claudeProfile) {
      project.agentProfile = project.claudeProfile;
    }
    delete project.claudeProfile;
    if (
      project.agentProfile &&
      !config.settings.agentProfiles.profiles[project.agentProfile]
    ) {
      project.agentProfile = null;
    }
    if (!project.setupScript?.content) {
      project.setupScript = null;
    }
  }
  return config;
}

function nextKanbanNumberForProjectData(config, projectName) {
  const maxExisting = Object.values(config.workspaces?.[projectName] || {})
    .map((workspace) => Number.parseInt(workspace.kanban?.number || "0", 10))
    .filter((number) => Number.isInteger(number) && number > 0)
    .reduce((max, number) => Math.max(max, number), 0);
  return maxExisting + 1;
}

function printSettings(config) {
  const settings = config.settings.notifications;
  console.log(`terminal: ${terminalLabel(config.settings.terminalApp)}`);
  console.log(`notifications: ${settings.enabled ? "on" : "off"}`);
  console.log(`sound: ${settings.soundName}`);
  console.log(`macOS banner: ${settings.macosNotification ? "on" : "off"}`);
  console.log(`default agent profile: ${config.settings.agentProfiles.default || "claude"}`);
  printHookStatus(config);
}

function terminalChoices() {
  return [
    {
      label: "Auto",
      value: "auto",
      description: "detect current terminal; prefers installed Warp/iTerm on macOS",
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
  const script = buildHookScript(STATE_DB_PATH, notifierExecutable);
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
  fs.rmSync(path.join(HOOKS_DIR, "ThomasNotifier.app"), {
    recursive: true,
    force: true,
  });
  fs.rmSync(path.join(HOOKS_DIR, "ThomasNotifier.applescript"), { force: true });
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

function buildHookScript(stateDbPath, notifierExecutable) {
  return `#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const STATE_DB_PATH = ${JSON.stringify(stateDbPath)};
const NOTIFIER_EXECUTABLE = ${JSON.stringify(notifierExecutable || "")};

function main() {
  const agent = process.argv[2] || "agent";
  const config = loadConfig();
  const settings = config.settings?.notifications || {};
  const isThomasSession =
    process.env.THOMAS_CLI === "1" ||
    Boolean(
      process.env.THOMAS_SESSION_ID ||
        process.env.THOMAS_PROJECT ||
        process.env.THOMAS_WORKSPACE,
    );

  const input = readStdin();
  const hook = parseJson(input);
  const event = hook?.hook_event_name || hook?.hookEventName || "done";
  const text = notificationText(agent, event, hook);

  if (settings.enabled !== false && isThomasSession) {
    play(settings.soundName || "Glass");
    if (settings.macosNotification) {
      notify(text.title, text.message);
    }
  }

}

function notificationText(agent, event, hook) {
  const project = process.env.THOMAS_PROJECT || "";
  const workspace = process.env.THOMAS_WORKSPACE || "";
  const session = process.env.THOMAS_SESSION_NAME || process.env.THOMAS_SESSION_ID || "";
  const branch = process.env.THOMAS_BRANCH || "";
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
    const result = spawnSync(
      "sqlite3",
      ["-json", STATE_DB_PATH, "SELECT data FROM settings WHERE id = 1"],
      { encoding: "utf8", timeout: 5000 },
    );
    if (result.status !== 0) return {};
    const rows = JSON.parse(result.stdout || "[]");
    const settings = rows[0]?.data ? JSON.parse(rows[0].data) : {};
    return { settings };
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
      process.env.THOMAS_CLI_CLAUDE_SETTINGS ||
        path.join(os.homedir(), ".claude", "settings.json"),
    ),
  );
}

function getCodexConfigPath() {
  return path.resolve(
    expandHome(
      process.env.THOMAS_CLI_CODEX_CONFIG ||
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
  ensureStateDb();
  if (fs.existsSync(CONFIG_PATH) && !stateDbHasData()) {
    saveConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")));
  }

  return normalizeConfig(readConfigFromStateDb());
}

function saveConfig(config) {
  const normalized = normalizeConfig(config);
  ensureStateDb();

  const statements = [
    "BEGIN IMMEDIATE;",
    "DELETE FROM meta;",
    "DELETE FROM settings;",
    "DELETE FROM projects;",
    "DELETE FROM workspaces;",
    "DELETE FROM sessions;",
    `INSERT INTO meta (key, value) VALUES ('schema_version', ${sqlValue("1")});`,
    `INSERT INTO meta (key, value) VALUES ('state_version', ${sqlValue(String(normalized.version || 1))});`,
    `INSERT INTO settings (id, data) VALUES (1, ${sqlJson(normalized.settings)});`,
  ];

  for (const [name, project] of Object.entries(normalized.projects).sort()) {
    statements.push(
      `INSERT INTO projects (name, data) VALUES (${sqlValue(name)}, ${sqlJson(project)});`,
    );
  }

  for (const [projectName, projectWorkspaces] of Object.entries(normalized.workspaces).sort()) {
    for (const [name, workspace] of Object.entries(projectWorkspaces).sort()) {
      statements.push(
        `INSERT INTO workspaces (project, name, data) VALUES (${sqlValue(projectName)}, ${sqlValue(name)}, ${sqlJson(workspace)});`,
      );
    }
  }

  for (const [id, session] of Object.entries(normalized.sessions).sort()) {
    statements.push(
      `INSERT INTO sessions (id, data) VALUES (${sqlValue(id)}, ${sqlJson(session)});`,
    );
  }

  statements.push("COMMIT;");
  sqliteExec(statements.join("\n"));
}

function ensureStateDb() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (!hasCommand("sqlite3")) {
    throw new CliError("Missing sqlite3. Install SQLite to use thomas state.");
  }
  sqliteExec(`
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  name TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspaces (
  project TEXT NOT NULL,
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (project, name)
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS workspaces_project_index ON workspaces (project);
`);
}

function stateDbHasData() {
  const rows = sqliteJson(`
SELECT
  (SELECT COUNT(*) FROM settings) +
  (SELECT COUNT(*) FROM projects) +
  (SELECT COUNT(*) FROM workspaces) +
  (SELECT COUNT(*) FROM sessions) AS count;
`);
  return Number(rows[0]?.count || 0) > 0;
}

function readConfigFromStateDb() {
  const config = defaultConfig();
  const settings = sqliteJson("SELECT data FROM settings WHERE id = 1;")[0]?.data;
  if (settings) {
    config.settings = jsonParse(settings, defaultSettings());
  }

  for (const row of sqliteJson("SELECT name, data FROM projects ORDER BY name;")) {
    config.projects[row.name] = jsonParse(row.data, {});
  }

  for (const row of sqliteJson("SELECT project, name, data FROM workspaces ORDER BY project, name;")) {
    if (!config.workspaces[row.project]) config.workspaces[row.project] = {};
    config.workspaces[row.project][row.name] = jsonParse(row.data, {});
  }

  for (const row of sqliteJson("SELECT id, data FROM sessions ORDER BY id;")) {
    config.sessions[row.id] = jsonParse(row.data, {});
  }

  const version = sqliteJson("SELECT value FROM meta WHERE key = 'state_version';")[0]?.value;
  config.version = Number.parseInt(version || "1", 10) || 1;
  return config;
}

function jsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function sqliteExec(sql) {
  const result = spawnSync("sqlite3", [STATE_DB_PATH], {
    input: sql,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new CliError(`SQLite state error: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout;
}

function sqliteJson(sql) {
  const result = spawnSync("sqlite3", ["-json", STATE_DB_PATH, sql], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new CliError(`SQLite state error: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return jsonParse(result.stdout || "[]", []);
}

function sqlJson(value) {
  return sqlValue(JSON.stringify(value ?? null));
}

function sqlValue(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
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
