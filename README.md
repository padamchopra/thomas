# Thomas

Thomas is a local-first Node.js server and React UI for orchestrating agent
work across local projects. Humans work in the browser; agents and scripts use
the HTTP API directly.

The app tracks projects, agents, tickets, comments, sub-issues, blockers,
worktrees, review diffs, and live agent activity. Ticket status is intended to
be driven by the agent workflow rather than manual status changes in the UI.

## Install

```sh
npm install
./install.sh
```

Thomas requires Node.js 20 or newer and the `sqlite3` command-line tool.

## Run

Start the server:

```sh
thomas serve
```

The default URL is:

```text
http://127.0.0.1:4567
```

To expose the server on your local network:

```sh
thomas serve --host 0.0.0.0 --port 4567
```

For development, run the server and Vite separately:

```sh
npm run dev:server
npm run dev:ui
```

Vite runs on `http://127.0.0.1:5173` and proxies `/api` to the server on
port `4567`.

Build the React UI served by the Node server:

```sh
npm run build
npm start
```

## UI

Thomas opens to the dashboard at `/`. Browser routes are supported, so the
main views can be opened, refreshed, and linked directly.

Current views include:

- Dashboard with compact ticket status sections and current review work.
- Inbox for items that need human attention.
- Tickets with board and list layouts.
- Project pages with per-project stats and tickets.
- Agent pages with recent work, usage links, and activity context.
- Ticket detail pages with comments, Markdown rendering, dependencies,
  sub-issues, blockers, review diffs, file browsing, and live agent activity.
- Settings for local UI preferences and notification behavior.

Ticket details also provide local workflow actions:

- Stop an active agent run while the ticket is in development.
- Open the ticket worktree in Finder.
- Open a terminal resume flow for the assigned agent.
- Review local diffs and browse the ticket workspace file tree when a ticket is
  in human review.

When you comment on a ticket in human review or PR review, Thomas resumes the
assigned agent automatically with the comment as context.

PR review tickets with a pull request URL are checked periodically with
`gh pr view` and moved to done when GitHub reports the PR as merged.

When a ticket moves to done, Thomas keeps only the ticket metadata needed for
history: ticket id, title, description, status, assignee, project, and PR URL.
Ticket comments, ticket-scoped activity, Thomas-owned worktrees, and Thomas run
log files are deleted.

## Storage

Thomas stores normalized state in SQLite:

```text
~/.thomas/thomas.db
```

The default ticket worktree root is:

```text
~/.thomas/worktrees
```

Agent run metadata and transcripts are file-backed so activity can be streamed
after a server restart:

```text
~/.thomas/logs/runs
```

These paths can be overridden for development and tests with:

```text
THOMAS_DB_PATH
THOMAS_STATE_PATH
THOMAS_WORKTREES_PATH
THOMAS_RUN_LOGS_PATH
```

## Agent Execution

Agents are configured in Thomas with a type and command. The built-in defaults
are Claude and Codex.

For live activity, Thomas uses the agents' streaming or JSON execution modes:

```text
codex exec --json <prompt>
codex exec resume --json --last <prompt>

claude --output-format stream-json --verbose --include-partial-messages -p <prompt>
claude --output-format stream-json --verbose --include-partial-messages --continue -p <prompt>
```

The same runner writes transcript files under `~/.thomas/logs/runs`. The UI
shows the parsed activity instead of raw process logs.

## API

All API routes are JSON under `/api`.

```text
GET    /api/state

GET    /api/projects
POST   /api/projects
POST   /api/projects/choose-folder

GET    /api/agents
POST   /api/agents

GET    /api/tickets
POST   /api/tickets
PATCH  /api/tickets/:id
POST   /api/tickets/:id/comments
POST   /api/tickets/:id/dispatch
POST   /api/tickets/:id/stop
GET    /api/tickets/:id/diff
POST   /api/tickets/:id/open-file
POST   /api/tickets/:id/open-worktree
POST   /api/tickets/:id/resume-terminal
POST   /api/tickets/:id/assign
POST   /api/tickets/:id/blockers

PATCH  /api/settings
```

Create a project:

```sh
curl -s http://127.0.0.1:4567/api/projects \
  -H 'content-type: application/json' \
  -d '{"name":"Thomas","prefix":"THOMAS","repoPath":"/path/to/repo"}'
```

Create an unassigned to-do ticket:

```sh
curl -s http://127.0.0.1:4567/api/tickets \
  -H 'content-type: application/json' \
  -d '{"project":"Thomas","title":"Add review diff","description":"Show local changes for human review."}'
```

Add a comment:

```sh
curl -s http://127.0.0.1:4567/api/tickets/THOMAS-1/comments \
  -H 'content-type: application/json' \
  -d '{"author":"you","body":"Please tighten the empty state copy."}'
```

Set blockers:

```sh
curl -s http://127.0.0.1:4567/api/tickets/THOMAS-2/blockers \
  -H 'content-type: application/json' \
  -d '{"blockedByTicketIds":["THOMAS-1"]}'
```

## Development

```sh
npm run check
npm test
npm run build
```

The CLI is intentionally thin. It starts the local server; project, ticket, and
agent operations should go through the API.
