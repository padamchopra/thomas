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

Start with the interactive menu:

```sh
conductor-cli
```

Use arrow keys or `j`/`k` to move, then press Enter. Number keys still work.

From there you can:

- register a project
- create a workspace
- prepare a Codex, Claude, or custom session
- list and delete workspaces
- check PR status
- run merged-PR cleanup
- manage settings, including completion sounds

You can also open the menu explicitly:

```sh
conductor-cli menu
```

## Useful Commands

Register a repo:

```sh
conductor-cli project add app ~/src/app
```

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
`conductor-cli session run <id>` command there; the menu app copies it for you.
Use `--detach` only when you explicitly want background log mode.

## Defaults

- Config lives in `~/.conductor-cli/config.json`.
- Worktrees live in `~/.conductor-cli/worktrees/<project>/<workspace>`.
- New workspaces branch from `origin/main`.
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
```

## macOS Menu App

There is an early native menu bar app in `macos/ConductorMenu`.
It uses `conductor-cli state` for JSON state and calls the CLI for actions, so
the CLI config stays the single source of truth.

Build, install, and launch it with:

```sh
./install-mac-app.sh
```

Use `./install-mac-app.sh --no-open` if you only want to install it.

GitHub Actions builds a zipped `Conductor.app` artifact on pushes, PRs, and
manual runs. Pushing a `v*` tag also attaches the zip to the GitHub release.
The app is ad-hoc signed but not notarized, so macOS may still show a first-run
Gatekeeper warning.
