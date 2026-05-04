# conductor-cli

`conductor-cli` is a local-first command line tool for running parallel AI coding work in isolated git worktrees.

It mirrors the core Conductor workflow in CLI form:

- Register a project for a local git repository.
- Create one workspace per task, branch, issue, or PR.
- Start Codex, Claude, or any custom command inside that workspace.
- Check git and PR readiness from the terminal.
- Watch PRs and clean up merged worktrees automatically.

## Install

```sh
./install.sh
conductor-cli --help
```

The installer symlinks `bin/conductor-cli.js` into `/usr/local/bin` when writable, otherwise `~/.local/bin`. Override with:

```sh
CONDUCTOR_CLI_INSTALL_DIR="$HOME/bin" ./install.sh
```

## Requirements

- Node.js 18+
- Git
- GitHub CLI (`gh`) for PR checks and merged-PR cleanup
- Optional: `codex` and/or `claude` for agent sessions

Run:

```sh
conductor-cli doctor
```

## Basic Flow

Run the interactive menu:

```sh
conductor-cli
```

You can also open it explicitly:

```sh
conductor-cli menu
```

Register a project:

```sh
conductor-cli project add app ~/src/app
```

By default, new project worktrees live under `~/.conductor-cli/worktrees/<project>/`.
New workspaces branch from `origin/main` and use a branch name like `<github-user>/<workspace>`.

Create a worktree workspace and start Codex in it:

```sh
conductor-cli workspace create app auth --agent codex
```

Create a workspace but run a custom command instead:

```sh
conductor-cli workspace create app tests -- npm test -- --watch
```

List active workspaces:

```sh
conductor-cli workspace list app
```

Check workspace state:

```sh
conductor-cli checks app auth
```

Watch GitHub PRs and remove worktrees after merge:

```sh
conductor-cli pr watch app --cleanup
```

For a one-shot scan:

```sh
conductor-cli pr watch app --once --cleanup
```

## Workspace Cleanup

Workspaces are not deleted automatically unless a cleanup watcher is running.

Manual cleanup:

```sh
conductor-cli workspace remove app auth
```

Merged-PR cleanup:

```sh
conductor-cli pr watch app --cleanup
```

Use `--once` for a single scan, or omit it to keep watching until you stop the process.
The interactive menu exposes the same cleanup choices under `PR cleanup watch`.

## Commands

```sh
conductor-cli
conductor-cli menu
```

```sh
conductor-cli project add <name> <repo-path> [--worktrees-dir <dir>] [--base <ref>] [--gh-user <username>]
conductor-cli project list
conductor-cli project info <name>
conductor-cli project remove <name>
```

```sh
conductor-cli workspace create <project> <name> [--branch <branch>] [--base <branch>] [--agent <agent>] [--port <port>] [-- <command>...]
conductor-cli workspace list [project] [--all]
conductor-cli workspace status <project> <name>
conductor-cli workspace path <project> <name>
conductor-cli workspace archive <project> <name>
conductor-cli workspace remove <project> <name> [--force] [--delete-branch]
```

```sh
conductor-cli session start <project> <workspace> [--agent <agent>] [--name <name>] [--port <port>] [-- <command>...]
conductor-cli session list [project] [workspace] [--all]
conductor-cli session stop <session-id>
conductor-cli session logs <session-id> [--tail <lines>]
```

```sh
conductor-cli pr watch [project] [--once] [--interval <seconds>] [--cleanup] [--force] [--delete-branch]
```

## Data Model

State is stored in `~/.conductor-cli/config.json` unless `CONDUCTOR_CLI_HOME` is set.

- A project points at one local git repository.
- A workspace maps to one branch and one git worktree.
- By default, worktrees are created under `~/.conductor-cli/worktrees/<project>/<workspace>`.
- By default, workspace branches are created from `origin/main`.
- Branch names default to `<github-user>/<workspace>`. The username is read from `--gh-user`, `CONDUCTOR_CLI_GH_USER`, `GITHUB_USER`, `GH_USER`, `git config github.user`, or `gh api user --jq .login`. If none is available, the branch prefix falls back to `conductor`.
- A session is a detached local process running inside a workspace.
- PR cleanup uses `gh pr view` from each active workspace branch.

Workspace `.context/` directories are created and excluded from that worktree's git status so agents can receive uncommitted notes and handoffs.
