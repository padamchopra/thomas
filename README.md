# conductor-cli

`conductor-cli` is a small CLI for running AI coding work in isolated git worktrees.

Use it when you want several Codex or Claude sessions working on separate branches without touching your main checkout.

## Install

```sh
./install.sh
```

Then run:

```sh
conductor-cli
```

The installer links the CLI into `/usr/local/bin` when possible, otherwise `~/.local/bin`.

## Requirements

- Node.js 18+
- Git
- GitHub CLI (`gh`) for PR checks and merged-PR cleanup
- Optional: `codex` and `claude`

Check your setup:

```sh
conductor-cli doctor
```

## How It Works

A **project** is a registered git repo.

A **workspace** is one task branch plus one git worktree:

```text
project: conductor-cli
workspace: add-pr-cleanup
branch: padamchopra/add-pr-cleanup
path: ~/.conductor-cli/worktrees/conductor-cli/add-pr-cleanup
```

Each workspace can run its own agent session.
Codex and Claude sessions prepare a terminal tab by default, then you run the
printed command inside it so the agent gets a real interactive terminal.

## Recommended Flow

Start the local web dashboard:

```sh
conductor-cli dashboard
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
conductor-cli dashboard --port 0 --no-open
conductor-cli dashboard --host 127.0.0.1 --port 8080
```

You can still use the terminal menu when you want a keyboard-driven flow:

```sh
conductor-cli menu
```

## Useful Commands

Register a repo:

```sh
conductor-cli project add app ~/src/app
conductor-cli project add app ~/src/app --setup-script ./scripts/bootstrap-worktree.sh
```

Setup scripts are copied into `~/.conductor-cli/config.json` rather than linked
from the original file path, then run automatically from each new workspace
root after `git worktree add`:

```sh
conductor-cli project set-setup-script app ./scripts/bootstrap-worktree.sh
conductor-cli project set-setup-script app none
```

When a setup script runs, conductor exports `CONDUCTOR_PROJECT`,
`CONDUCTOR_WORKSPACE`, `CONDUCTOR_BRANCH`, `CONDUCTOR_WORKSPACE_PATH`, and
`CONDUCTOR_REPO_PATH`.

Create a workspace and prepare Codex:

```sh
conductor-cli workspace create app auth --agent codex
```

Prepare a session in an existing workspace:

```sh
conductor-cli session start app auth --agent claude
```

Resume a stored agent session:

```sh
conductor-cli session resume <session-id>
```

List workspaces:

```sh
conductor-cli workspace list app
```

Remove a workspace:

```sh
conductor-cli workspace remove app auth
```

Clean up merged PR workspaces:

```sh
conductor-cli pr watch app --once --cleanup
```

For continuous cleanup, omit `--once`.

Configure session completion sounds:

```sh
conductor-cli settings show
conductor-cli settings terminal warp
conductor-cli settings sound Glass
conductor-cli settings hooks install all
```

Agent profiles choose the command used when a session starts. `claude` and
`codex` are built in, and `claude` is the default:

```sh
conductor-cli agent-profile list
conductor-cli agent-profile default codex
conductor-cli agent-profile add work claude-work
conductor-cli project set-agent-profile app work
```

Claude uses `Stop` and `SubagentStop` hooks. Codex uses its `notify` command.
Hook notifications only fire for conductor-launched sessions, even though the
Claude and Codex hook entries are installed globally.

Terminal sessions auto-detect your terminal on macOS:

- Terminal.app opens a terminal at the workspace
- iTerm opens a terminal at the workspace
- Warp opens a new tab at the workspace

The agent does not auto-run in the new terminal. Run the printed
`conductor-cli session run <id>` command there; the dashboard shows it on the
session card. Use `--detach` only when you explicitly want background log mode.

## Defaults

- Config lives in `~/.conductor-cli/config.json`.
- Worktrees live in `~/.conductor-cli/worktrees/<project>/<workspace>`.
- New workspaces branch from `origin/main`.
- Project setup scripts, when configured, run automatically after workspace creation.
- Branches default to `<github-user>/<workspace>`.
- Codex and Claude sessions prepare a terminal tab and print a run command.
- Agent profiles always include `claude` and `codex`; the default is `claude`.
- The terminal app defaults to `auto`; set it to `terminal`, `iterm`, `warp`,
  or `warppreview` from settings.
- Workspaces are not deleted automatically unless you run PR cleanup.
- Agent completion sounds are opt-in through `settings hooks install`.
- Hook notifications only fire for conductor sessions.

## More Help

Use built-in help instead of memorizing commands:

```sh
conductor-cli --help
conductor-cli help project
conductor-cli help workspace
conductor-cli help session
conductor-cli help pr
conductor-cli help settings
conductor-cli help dashboard
```

## Web Dashboard

`conductor-cli dashboard` replaces the old native macOS menu app. It serves the
UI and JSON API from the CLI process itself, so `~/.conductor-cli/config.json`
remains the single source of truth and there is nothing platform-specific to
install.

The dashboard is localhost-only by default. Stop it with Ctrl-C.
