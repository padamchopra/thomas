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
  if (command === "ticket") {
    await handleTicketCommand(args.slice(1));
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

async function handleTicketCommand(args) {
  const command = args[0];
  if (command !== "reply") {
    throw new Error(`Unknown ticket command: ${command || ""}`.trim());
  }
  const ticketId = args[1];
  const message = args.slice(2).join(" ").trim();
  if (!ticketId || !message) {
    const error = new Error("Usage: thomas ticket reply <ticket-id> <message>");
    error.status = 2;
    throw error;
  }
  const baseUrl = String(process.env.THOMAS_URL || process.env.THOMAS_SERVER_URL || "http://127.0.0.1:4567").replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/api/tickets/${encodeURIComponent(ticketId)}/comments`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-thomas-actor": "ui",
    },
    body: JSON.stringify({ body: message }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    const error = new Error(data.error || `Thomas server returned ${response.status}`);
    error.status = response.status < 500 ? response.status : 1;
    throw error;
  }
  console.log(`${data.comment?.ticketId || ticketId}: comment added.`);
  if (data.run) console.log(`${data.comment?.ticketId || ticketId}: resumed ${data.run.agentName || "assigned agent"}.`);
}

function printHelp() {
  console.log(`Thomas

Usage:
  thomas serve [--host 127.0.0.1] [--port 4567]
  thomas ticket reply <ticket-id> <message>

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
