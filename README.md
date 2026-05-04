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

## Recommended Flow

Start with the interactive menu:

```sh
conductor-cli
```

Use arrow keys or `j`/`k` to move, then press Enter. Number keys still work.

From there you can:

- register a project
- create a workspace
- start a Codex, Claude, or custom session
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

Create a workspace and start Codex:

```sh
conductor-cli workspace create app auth --agent codex
```

Start a session in an existing workspace:

```sh
conductor-cli session start app auth --agent claude
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
conductor-cli settings sound Glass
conductor-cli settings hooks install all
```

Claude uses `Stop` and `SubagentStop` hooks. Codex uses its `notify` command.

## Defaults

- Config lives in `~/.conductor-cli/config.json`.
- Worktrees live in `~/.conductor-cli/worktrees/<project>/<workspace>`.
- New workspaces branch from `origin/main`.
- Branches default to `<github-user>/<workspace>`.
- Workspaces are not deleted automatically unless you run PR cleanup.
- Agent completion sounds are opt-in through `settings hooks install`.

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
