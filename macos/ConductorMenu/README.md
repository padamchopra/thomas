# Conductor Menu

Native macOS menu bar client for `conductor-cli`.

The menu app is intentionally thin:

- `~/.conductor-cli/config.json` remains the source of truth.
- `conductor-cli state` provides read-only JSON state for the app.
- Actions such as starting Codex or Claude call the same CLI commands.
- Settings, including the terminal app used for agent tabs, are stored in the
  same `~/.conductor-cli/config.json` file.

## Build

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
