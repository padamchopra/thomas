# thomas

`thomas` is a small CLI for running AI coding work in isolated git worktrees.

Use it when you want several Codex or Claude sessions working on separate branches without touching your main checkout.

## Install

```sh
./install.sh
```

Then run:

```sh
thomas
```

The installer links the CLI into `/usr/local/bin` when possible, otherwise `~/.local/bin`.

## Requirements

- Node.js 18+
- Git
- GitHub CLI (`gh`) for PR checks and merged-PR cleanup
- Optional: `codex` and `claude`

Check your setup:

```sh
thomas doctor
```

## How It Works

A **project** is a registered git repo.

A **workspace** is one task branch plus one git worktree:

```text
project: thomas
workspace: add-pr-cleanup
branch: padamchopra/add-pr-cleanup
path: ~/.thomas/worktrees/thomas/add-pr-cleanup
```

Each workspace can run its own agent session.
Codex and Claude sessions prepare a terminal tab by default, then you run the
printed command inside it so the agent gets a real interactive terminal.

## Recommended Flow

Start the local web dashboard:

```sh
thomas dashboard
```

It serves a localhost dashboard for the same day-to-day actions as the CLI:

- register and remove projects
- create, archive, and remove workspaces
- start, resume, stop, and inspect sessions
- check git and GitHub PR status
- manage agent profiles and settings
- install/test completion hooks

By default the dashboard binds to `127.0.0.1:4587` and opens your browser when run from an interactive terminal. You can override that:

```sh
thomas dashboard --port 0 --no-open
thomas dashboard --host 127.0.0.1 --port 8080
```

You can still use the terminal menu when you want a keyboard-driven flow:

```sh
thomas menu
```

## Useful Commands

Register a repo:

```sh
thomas project add app ~/src/app
thomas project add app ~/src/app --setup-script ./scripts/bootstrap-worktree.sh
```

Setup scripts are copied into `~/.thomas/config.json` rather than linked
from the original file path, then run automatically from each new workspace
root after `git worktree add`:

```sh
thomas project set-setup-script app ./scripts/bootstrap-worktree.sh
thomas project set-setup-script app none
```

When a setup script runs, thomas exports `THOMAS_PROJECT`,
`THOMAS_WORKSPACE`, `THOMAS_BRANCH`, `THOMAS_WORKSPACE_PATH`, and
`THOMAS_REPO_PATH`.

Create a workspace and prepare Codex:

```sh
thomas workspace create app auth --agent codex
```

Prepare a session in an existing workspace:

```sh
thomas session start app auth --agent claude
```

Resume a stored agent session:

```sh
thomas session resume <session-id>
```

List workspaces:

```sh
thomas workspace list app
```

Remove a workspace:

```sh
thomas workspace remove app auth
```

Clean up merged PR workspaces:

```sh
thomas pr watch app --once --cleanup
```

For continuous cleanup, omit `--once`.

Configure session completion sounds:

```sh
thomas settings show
thomas settings terminal warp
thomas settings sound Glass
thomas settings hooks install all
```

Agent profiles choose the command used when a session starts. `claude` and
`codex` are built in, and `claude` is the default:

```sh
thomas agent-profile list
thomas agent-profile default codex
thomas agent-profile add work claude-work
thomas project set-agent-profile app work
```

Claude uses `Stop` and `SubagentStop` hooks. Codex uses its `notify` command.
Hook notifications only fire for thomas-launched sessions, even though the
Claude and Codex hook entries are installed globally.

Terminal sessions auto-detect your terminal on macOS:

- Terminal.app opens a terminal at the workspace
- iTerm opens a terminal at the workspace
- Warp opens a new tab at the workspace

The agent does not auto-run in the new terminal. Run the printed
`thomas session run <id>` command there; the dashboard shows it on the
session card. Use `--detach` only when you explicitly want background log mode.

## Defaults

- Config lives in `~/.thomas/config.json`.
- Worktrees live in `~/.thomas/worktrees/<project>/<workspace>`.
- New workspaces branch from `origin/main`.
- Project setup scripts, when configured, run automatically after workspace creation.
- Branches default to `<github-user>/<workspace>`.
- Codex and Claude sessions prepare a terminal tab and print a run command.
- Agent profiles always include `claude` and `codex`; the default is `claude`.
- The terminal app defaults to `auto`; set it to `terminal`, `iterm`, `warp`,
  or `warppreview` from settings.
- Workspaces are not deleted automatically unless you run PR cleanup.
- Agent completion sounds are opt-in through `settings hooks install`.
- Hook notifications only fire for thomas sessions.

## More Help

Use built-in help instead of memorizing commands:

```sh
thomas --help
thomas --version
thomas help project
thomas help workspace
thomas help session
thomas help pr
thomas help settings
thomas help dashboard
```

## Web Dashboard

`thomas dashboard` replaces the old native macOS menu app. It serves the
UI and JSON API from the CLI process itself, so `~/.thomas/config.json`
remains the single source of truth and there is nothing platform-specific to
install.

The dashboard is localhost-only by default. Stop it with Ctrl-C.
