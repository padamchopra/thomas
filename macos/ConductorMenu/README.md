# Conductor Menu

Native macOS menu bar client for `conductor-cli`.

The menu app is intentionally thin:

- `~/.conductor-cli/config.json` remains the source of truth.
- `conductor-cli state` provides read-only JSON state for the app.
- Actions such as starting Codex or Claude call the same CLI commands.
- Settings, including the terminal app used for agent tabs, are stored in the
  same `~/.conductor-cli/config.json` file.
- Agent profiles are shared with the CLI. The built-in `claude` and `codex`
  profiles are always shown, and `claude` is the default until changed.

## Install

From the repo root:

```sh
./install-mac-app.sh
```

This builds the app, installs it to `/Applications/Conductor.app`, and launches
it. Use `./install-mac-app.sh --no-open` to install without launching.

## Build Only

```sh
./macos/ConductorMenu/build-app.sh
```

The app bundle is written to:

```text
macos/ConductorMenu/.build/ConductorMenu.app
```

Open it from Finder or with:

```sh
open macos/ConductorMenu/.build/ConductorMenu.app
```

During local development, the app bundle stores the repo's
`bin/conductor-cli.js` path in its resources so it uses the same implementation
as the CLI.

The bundle also includes a copy of `bin/conductor-cli.js` and `package.json` in
`Contents/Resources`, so GitHub Actions builds can run without pointing at the
CI checkout path. `CONDUCTOR_CLI_BIN` can still override the command at runtime.

## CI Builds

The root workflow at `.github/workflows/build-mac-app.yml` builds, ad-hoc signs,
zips, and uploads `Conductor.app` as a workflow artifact. On `v*` tags, it also
attaches the zip to the GitHub release.
