"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHttpServer } = require("./app");

async function startServer(options = {}) {
  const host = options.host || process.env.THOMAS_HOST || "127.0.0.1";
  const port = Number.parseInt(String(options.port || process.env.THOMAS_PORT || "4567"), 10);
  await ensureUiBuilt(options);
  const server = createHttpServer(options);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return {
    server,
    url: `http://${host}:${actualPort}`,
  };
}

async function ensureUiBuilt(options = {}) {
  if (options.autoBuildUi === false || process.env.THOMAS_AUTO_BUILD_UI === "0") return null;
  const rootDir = options.rootDir || path.resolve(__dirname, "..", "..");
  const uiDist = options.uiDist || path.join(rootDir, "ui", "dist");
  const indexPath = path.join(uiDist, "index.html");
  const reason = uiBuildReason(rootDir, indexPath);
  if (!reason) return null;
  const buildUi = options.buildUi || buildUiWithNpm;
  await buildUi({ reason, rootDir, uiDist, indexPath });
  if (!fs.existsSync(indexPath)) {
    throw new Error(`Thomas UI build completed but ${indexPath} was not created.`);
  }
  return { reason, rootDir, uiDist, indexPath };
}

function uiBuildReason(rootDir, indexPath) {
  if (!fs.existsSync(indexPath)) return "missing";
  const distMtime = fs.statSync(indexPath).mtimeMs;
  return newestUiInputMtime(rootDir) > distMtime ? "stale" : null;
}

function newestUiInputMtime(rootDir) {
  const candidates = [
    path.join(rootDir, "package.json"),
    path.join(rootDir, "package-lock.json"),
    path.join(rootDir, "ui", "vite.config.mjs"),
    path.join(rootDir, "ui", "index.html"),
    path.join(rootDir, "ui", "src"),
  ];
  return candidates.reduce((newest, candidate) => Math.max(newest, newestMtime(candidate)), 0);
}

function newestMtime(targetPath) {
  if (!fs.existsSync(targetPath)) return 0;
  const stat = fs.statSync(targetPath);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = stat.mtimeMs;
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    newest = Math.max(newest, newestMtime(path.join(targetPath, entry.name)));
  }
  return newest;
}

function buildUiWithNpm({ reason, rootDir }) {
  console.log(`Thomas UI build: npm run build (${reason})`);
  const result = spawnSync("npm", ["run", "build"], {
    cwd: rootDir,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Thomas UI build failed with exit code ${result.status}.`);
}

module.exports = {
  ensureUiBuilt,
  startServer,
};
