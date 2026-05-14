"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { startServer } = require("../../src/server");

async function withStartedServer(options, fn) {
  const { server, url } = await startServer({ host: "127.0.0.1", port: 0, ...options });
  try {
    await fn({ server, url });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("startServer builds the React UI when the compiled dashboard is missing", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "thomas-start-"));
  const rootDir = path.join(tmp, "repo");
  const uiDist = path.join(rootDir, "ui", "dist");
  const built = [];

  await withStartedServer({
    rootDir,
    uiDist,
    buildUi({ reason, rootDir: receivedRoot, uiDist: receivedDist }) {
      built.push({ reason, receivedRoot, receivedDist });
      fs.mkdirSync(uiDist, { recursive: true });
      fs.writeFileSync(path.join(uiDist, "index.html"), "<!doctype html><title>Built Thomas</title>");
    },
  }, async ({ url }) => {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Built Thomas/);
  });

  assert.deepEqual(built, [{ reason: "missing", receivedRoot: rootDir, receivedDist: uiDist }]);
});

test("startServer rebuilds the React UI when source files are newer than dist", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "thomas-start-"));
  const rootDir = path.join(tmp, "repo");
  const uiDist = path.join(rootDir, "ui", "dist");
  const sourceFile = path.join(rootDir, "ui", "src", "main.jsx");
  const indexFile = path.join(uiDist, "index.html");
  const built = [];

  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.mkdirSync(uiDist, { recursive: true });
  fs.writeFileSync(indexFile, "<!doctype html><title>Old Thomas</title>");
  fs.writeFileSync(sourceFile, "console.log('new source');\n");
  const oldTime = new Date(Date.now() - 60_000);
  const newTime = new Date(Date.now());
  fs.utimesSync(indexFile, oldTime, oldTime);
  fs.utimesSync(sourceFile, newTime, newTime);

  await withStartedServer({
    rootDir,
    uiDist,
    buildUi({ reason }) {
      built.push(reason);
      fs.writeFileSync(indexFile, "<!doctype html><title>Fresh Thomas</title>");
    },
  }, async ({ url }) => {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Fresh Thomas/);
  });

  assert.deepEqual(built, ["stale"]);
});
