# Thomas

Thomas is a local orchestrator for AI coding work. It gives you one local
control plane for projects, workspace-backed kanban tickets, git worktrees,
agent profiles, agent runs, PR state, and cleanup.

The web UI is the main human interface. The CLI is also intentionally useful to
agents: it lets Codex, Claude, or other scripts inspect state, create tickets,
assign agents, reply to blocked work, and keep the board in sync without
touching the database directly.

## Install

```sh
./install.sh
```

Then run:

```sh
thomas
```

The installer links the CLI into `/usr/local/bin` when possible, otherwise
`~/.local/bin`.

## Requirements

- Node.js 18+
- Git
- SQLite (`sqlite3`)
- GitHub CLI (`gh`) for PR checks and merged-PR cleanup
- Optional agent CLIs: `codex` and `claude`

Check your machine:

```sh
thomas doctor
```

## Web UI

Start the local dashboard:

```sh
thomas dashboard
```

Thomas serves the dashboard and JSON API from the CLI process itself. The
dashboard is localhost-only by default and uses `~/.thomas/thomas.db` as the
single source of truth.

By default it binds to `127.0.0.1:4587`:

```sh
thomas dashboard --port 0 --no-open
thomas dashboard --host 127.0.0.1 --port 8080
```

The dashboard currently provides:

- Board view for workspace-backed tickets
- Projects view for registered repositories and workspaces
- Agents view for agent profiles and active assigned tickets grouped by status
- Ticket detail with description, assignee, agent state, comments, and replies
- Project registration, identifiers, setup scripts, and default agent profiles
- Light and dark themes

## Core Model

A **project** is a registered git repository.

A **workspace** is one isolated task branch plus one git worktree:

```text
project: thomas
workspace: thomas-1
branch: padamchopra/thomas-1
path: ~/.thomas/worktrees/thomas/thomas-1
```

A **ticket** is kanban metadata attached to a workspace. Ticket IDs use the
project identifier and a project-local number, such as `THOMAS-1`.

An **agent profile** names an agent type and launch command. `claude` and
`codex` are built in, and projects can set their own default profile.

## Agent-Controlled Kanban

Creating a To-do ticket creates the workspace and starts the assigned agent
automatically:

```sh
thomas kanban create thomas "Improve board layout"
```

Thomas assigns the ticket to:

1. the agent selected when the ticket is created,
2. otherwise the project's default agent profile,
3. otherwise the global default agent profile.

Agent output is captured in Thomas logs. When the agent stops, Thomas posts a
short summary comment. If the agent prints `BLOCKED:` or exits with a non-zero
code, Thomas posts the blocked reason instead.

Reply to the ticket to resume the previous agent context:

```sh
thomas ticket reply THOMAS-1 "Use the existing dashboard API helper and continue."
```

Useful ticket commands:

```sh
thomas kanban list
thomas ticket assign THOMAS-1 codex
thomas ticket run THOMAS-1
thomas ticket comments THOMAS-1
thomas ticket reply THOMAS-1 "Please continue with this direction."
thomas ticket delete THOMAS-1
```

Ticket status is derived from real state:

- `To-do`: no agent has started yet.
- `In Progress`: an agent process is currently running.
- `Human Review`: the agent finished or blocked and left a comment.
- `PR Review`: a PR is associated with the workspace.
- `Done`: the PR is merged.

When a PR is merged, Thomas keeps the ticket metadata and comments but cleans up
the actual worktree so finished work does not accumulate locally.

Deleting a ticket is destructive: Thomas stops associated agent sessions and
removes the associated workspace/worktree.

## Projects

Register repositories:

```sh
thomas project add app ~/src/app
thomas project add thomas ~/src/thomas --identifier THOMAS
thomas project add app ~/src/app --setup-script ./scripts/bootstrap-worktree.sh
```

Set project defaults:

```sh
thomas project set-identifier app APP
thomas project set-agent-profile app codex
thomas project set-setup-script app ./scripts/bootstrap-worktree.sh
thomas project set-setup-script app none
```

Setup scripts are copied into Thomas state and run from each new workspace root
after `git worktree add`. Thomas exports `THOMAS_PROJECT`,
`THOMAS_WORKSPACE`, `THOMAS_BRANCH`, `THOMAS_WORKSPACE_PATH`, and
`THOMAS_REPO_PATH` while running setup scripts.

## Workspaces And Sessions

Kanban is the higher-level workflow, but you can still use raw workspaces and
sessions directly:

```sh
thomas workspace create app auth
thomas workspace list app
thomas workspace remove app auth

thomas session start app auth --agent claude
thomas session resume <session-id>
thomas session logs <session-id>
```

Interactive session starts prepare a terminal tab by default. Run the printed
`thomas session run <id>` command in that terminal. Use detached sessions only
when you explicitly want background log mode outside the kanban runner.

## Agent Profiles

```sh
thomas agent-profile list
thomas agent-profile default codex
thomas agent-profile add reviewer --type codex
thomas agent-profile add work claude-work --type claude
```

Agent profiles are shared by the web UI, CLI, and ticket runner.

## Notifications

Thomas can install completion hooks for Claude and Codex. Hook notifications
only fire for Thomas-launched sessions, even though the hook entries are
installed globally in the agent tools.

```sh
thomas settings show
thomas settings terminal warp
thomas settings sound Glass
thomas settings hooks install all
```

Terminal app choices are `auto`, `terminal`, `iterm`, `warp`, and
`warppreview`.

## State And Defaults

- State lives in `~/.thomas/thomas.db`.
- Worktrees live in `~/.thomas/worktrees/<project>/<workspace>`.
- New workspaces branch from `origin/main` by default.
- Branches default to `<github-user>/<workspace>`.
- Kanban is optional; raw workspace/session commands still work.
- Project identifiers default from project names and can be changed.
- Agent profiles always include `claude` and `codex`.
- The default agent profile is `claude`.

## For Agents

Agents should use the CLI instead of editing Thomas state directly:

```sh
thomas state
thomas kanban list
thomas ticket comments THOMAS-1
thomas ticket reply THOMAS-1 "I am unblocked; continue."
thomas checks thomas thomas-1
```

`thomas state` returns normalized JSON for automation clients. The dashboard
uses the same state and API, so humans and agents stay in sync.

## Help

```sh
thomas --help
thomas help project
thomas help workspace
thomas help kanban
thomas help ticket
thomas help session
thomas help settings
thomas help dashboard
```
