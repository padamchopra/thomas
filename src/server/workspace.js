"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function thomasHome() {
  return process.env.THOMAS_HOME || process.env.THOMAS_CLI_HOME || path.join(os.homedir(), ".thomas");
}

function defaultWorktreeRoot() {
  return process.env.THOMAS_WORKTREES_PATH || path.join(thomasHome(), "worktrees");
}

function defaultRunLogRoot() {
  return process.env.THOMAS_RUN_LOGS_PATH || path.join(thomasHome(), "logs", "runs");
}

function resolveTicketWorkspace(ticket, options = {}) {
  const projectPath = ticket.project?.repoPath ? path.resolve(ticket.project.repoPath) : "";
  const worktreeRoot = options.workspaceRoot || defaultWorktreeRoot();
  const workspaceId = ticket.workspaceId || ticket.id?.toLowerCase();
  const candidates = [];

  if (workspaceId && ticket.project?.name) {
    candidates.push(path.join(worktreeRoot, ticket.project.name, workspaceId));
  }
  if (workspaceId && ticket.projectId) {
    candidates.push(path.join(worktreeRoot, ticket.projectId, workspaceId));
  }
  if (workspaceId) {
    candidates.push(path.join(worktreeRoot, workspaceId));
  }

  for (const candidate of candidates) {
    if (isGitRoot(candidate)) {
      return { path: path.resolve(candidate), source: "worktree", projectPath };
    }
  }

  return { path: projectPath, source: "project", projectPath };
}

function ensureTicketWorkspace(ticket, options = {}) {
  const resolved = resolveTicketWorkspace(ticket, options);
  if (resolved.source === "worktree") return resolved;
  const projectPath = ticket.project?.repoPath ? path.resolve(ticket.project.repoPath) : "";
  if (!isGitRoot(projectPath)) throw workspaceError(`Ticket project is not a git repository: ${projectPath || "unknown"}`);

  const worktreePath = preferredTicketWorktreePath(ticket, options);
  if (!worktreePath) throw workspaceError("Ticket has no workspace identifier.");
  if (fs.existsSync(worktreePath)) {
    if (isGitRoot(worktreePath)) return { path: path.resolve(worktreePath), source: "worktree", projectPath };
    if (fs.readdirSync(worktreePath).length > 0) throw workspaceError(`Workspace path is not a git repository: ${worktreePath}`);
  }

  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  const branch = defaultWorkspaceBranch(projectPath, ticket.workspaceId || ticket.id?.toLowerCase(), options.branchPrefix);
  const base = defaultBaseRef(projectPath);
  const args = branchExists(projectPath, branch)
    ? ["worktree", "add", worktreePath, branch]
    : ["worktree", "add", "-b", branch, worktreePath, base];
  const result = git(projectPath, args);
  if (result.status !== 0) {
    throw workspaceError(result.stderr.trim() || result.stdout.trim() || `Could not create worktree: ${worktreePath}`);
  }
  fs.mkdirSync(path.join(worktreePath, ".context"), { recursive: true });
  addWorktreeExclude(worktreePath, ".context/");
  runProjectSetupScript(ticket.project, {
    name: ticket.workspaceId || ticket.id?.toLowerCase(),
    branch,
    path: worktreePath,
  });
  return { path: path.resolve(worktreePath), source: "worktree", projectPath };
}

function preferredTicketWorktreePath(ticket, options = {}) {
  const workspaceId = ticket.workspaceId || ticket.id?.toLowerCase();
  if (!workspaceId) return "";
  const worktreeRoot = options.workspaceRoot || defaultWorktreeRoot();
  if (ticket.project?.name) return path.join(worktreeRoot, ticket.project.name, workspaceId);
  if (ticket.projectId) return path.join(worktreeRoot, ticket.projectId, workspaceId);
  return path.join(worktreeRoot, workspaceId);
}

function isGitRoot(repoPath) {
  return Boolean(repoPath) && fs.existsSync(path.join(repoPath, ".git"));
}

function defaultWorkspaceBranch(repoPath, workspaceId, branchPrefix) {
  const prefix = sanitizeBranchPrefix(branchPrefix) || detectGithubUsername(repoPath) || "thomas";
  return `${prefix}/${sanitizeBranchSegment(workspaceId)}`;
}

function detectGithubUsername(repoPath) {
  const envUser = process.env.THOMAS_CLI_GH_USER || process.env.GITHUB_USER || process.env.GH_USER;
  if (envUser) return sanitizeBranchSegment(envUser);
  const configured = git(repoPath, ["config", "--get", "github.user"]);
  return configured.status === 0 && configured.stdout.trim() ? sanitizeBranchSegment(configured.stdout.trim()) : "";
}

function defaultBaseRef(repoPath) {
  for (const ref of ["origin/main", "main", "master", "HEAD"]) {
    if (refExists(repoPath, ref)) return ref;
  }
  throw workspaceError("No base ref found for worktree creation.");
}

function branchExists(repoPath, branch) {
  return git(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0;
}

function refExists(repoPath, ref) {
  return git(repoPath, ["rev-parse", "--verify", "--quiet", ref]).status === 0;
}

function addWorktreeExclude(worktreePath, pattern) {
  const result = git(worktreePath, ["rev-parse", "--git-path", "info/exclude"]);
  if (result.status !== 0 || !result.stdout.trim()) return;
  const excludePath = path.resolve(worktreePath, result.stdout.trim());
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  const current = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
  if (!current.split(/\r?\n/).includes(pattern)) {
    fs.appendFileSync(excludePath, `${current.endsWith("\n") || current === "" ? "" : "\n"}${pattern}\n`);
  }
}

function runProjectSetupScript(project, workspace) {
  const setupScript = String(project?.setupScript || "").trim();
  if (!setupScript) return;
  const scriptPath = path.join(workspace.path, ".context", "thomas-setup-script");
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, setupScript);
  fs.chmodSync(scriptPath, 0o700);
  const command = setupScript.startsWith("#!") ? scriptPath : "/bin/sh";
  const args = setupScript.startsWith("#!") ? [] : [scriptPath];
  const result = spawnSync(command, args, {
    cwd: workspace.path,
    env: {
      ...process.env,
      THOMAS_PROJECT: project?.name || "",
      THOMAS_WORKSPACE: workspace.name,
      THOMAS_BRANCH: workspace.branch,
      THOMAS_WORKSPACE_PATH: workspace.path,
      THOMAS_REPO_PATH: project?.repoPath || "",
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 300000,
  });
  if (result.status !== 0) {
    throw workspaceError(result.stderr.trim() || result.stdout.trim() || `Setup script failed with exit code ${result.status}`);
  }
}

function git(repoPath, args) {
  return spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8", timeout: 30000 });
}

function sanitizeBranchSegment(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .replace(/-+/g, "-") || "workspace";
}

function sanitizeBranchPrefix(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .split("/")
    .map((part) => part
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "")
      .replace(/-+/g, "-"))
    .filter(Boolean)
    .join("/");
}

function workspaceError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

module.exports = {
  defaultRunLogRoot,
  defaultWorktreeRoot,
  ensureTicketWorkspace,
  isGitRoot,
  preferredTicketWorktreePath,
  resolveTicketWorkspace,
  thomasHome,
};
