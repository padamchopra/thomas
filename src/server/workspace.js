"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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

function isGitRoot(repoPath) {
  return Boolean(repoPath) && fs.existsSync(path.join(repoPath, ".git"));
}

module.exports = {
  defaultRunLogRoot,
  defaultWorktreeRoot,
  isGitRoot,
  resolveTicketWorkspace,
  thomasHome,
};
