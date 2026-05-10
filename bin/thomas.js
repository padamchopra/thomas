#!/usr/bin/env node
"use strict";

const { startServer } = require("../src/server");

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message || error);
  process.exit(error.status || 1);
});

async function main(args) {
  const command = args[0] || "serve";
  if (command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return;
  }
  if (command !== "serve" && command !== "server" && command !== "dashboard") {
    throw new Error(`Unknown command: ${command}`);
  }

  const options = parseServeArgs(args.slice(1));
  const { url } = await startServer(options);
  console.log(`Thomas server: ${url}`);
  console.log("API: /api/state");
  console.log("Press Ctrl-C to stop.");
}

function parseServeArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--host") {
      options.host = args[++index];
    } else if (arg === "--port") {
      options.port = args[++index];
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  console.log(`Thomas

Usage:
  thomas serve [--host 127.0.0.1] [--port 4567]

Thomas is now API-first. Agents should use the HTTP API instead of CLI
subcommands:

  GET  /api/state
  POST /api/projects
  POST /api/tickets
  PATCH /api/tickets/:id
  POST /api/tickets/:id/comments
  POST /api/tickets/:id/assign
  POST /api/tickets/:id/blockers
`);
}
