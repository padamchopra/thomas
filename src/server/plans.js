"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PLAN_FILE_NAMES = new Set(["plan.html", "plan.md", "PLAN.html", "PLAN.md"]);
const IGNORED_DIRS = new Set([
  ".git",
  ".gradle",
  ".idea",
  ".next",
  ".nuxt",
  ".turbo",
  ".vite",
  "build",
  "dist",
  "node_modules",
  "out",
  "DerivedData",
]);
const MAX_PLAN_BYTES = 512 * 1024;
const MAX_DISCOVERED_FILES = 20000;

function discoverPlanFiles(repoPath, ticketId, selectedPath = "") {
  const root = path.resolve(repoPath);
  const files = [];
  let scanned = 0;
  let truncated = false;

  function visit(dir, relativeDir = "") {
    if (scanned >= MAX_DISCOVERED_FILES) {
      truncated = true;
      return;
    }
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const entry of entries) {
      if (scanned >= MAX_DISCOVERED_FILES) {
        truncated = true;
        return;
      }
      if (entry.isSymbolicLink()) continue;
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const absolutePath = path.join(root, relativePath);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        scanned += 1;
        if (PLAN_FILE_NAMES.has(entry.name)) files.push(planFileInfo(root, relativePath, ticketId));
      }
    }
  }

  visit(root);
  files.sort((a, b) => planRank(a, ticketId, selectedPath) - planRank(b, ticketId, selectedPath) || a.path.localeCompare(b.path));
  return { files, truncated };
}

function readPlanFile(repoPath, relativePath) {
  const safePath = safeRelativePath(relativePath);
  const root = path.resolve(repoPath);
  const target = path.resolve(root, safePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw planError(400, "Plan path must stay inside the ticket workspace.");
  if (!fs.existsSync(target)) throw planError(404, `Plan file does not exist: ${safePath}`);
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw planError(400, `Plan path is not a file: ${safePath}`);
  if (stat.size > MAX_PLAN_BYTES) throw planError(413, `Plan file is too large to preview: ${safePath}`);
  const content = fs.readFileSync(target, "utf8");
  return {
    ...planFileInfo(root, safePath, ""),
    content,
    anchors: planAnchors(content, planFormat(safePath)),
  };
}

function createThomasPlanFile(repoPath, ticket) {
  const root = path.resolve(repoPath);
  const relativePath = ".context/plan.md";
  const target = path.join(root, relativePath);
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, defaultThomasPlan(ticket));
  }
  return readPlanFile(root, relativePath);
}

function planFileInfo(root, relativePath, ticketId) {
  const target = path.join(root, relativePath);
  const stat = fs.statSync(target);
  return {
    path: relativePath.replace(/\\/g, "/"),
    name: path.basename(relativePath),
    format: planFormat(relativePath),
    bytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    thomasOwned: relativePath.replace(/\\/g, "/").startsWith(".context/"),
    ticketMatched: ticketId ? relativePath.toLowerCase().includes(String(ticketId).toLowerCase()) : false,
  };
}

function planRank(file, ticketId, selectedPath) {
  let rank = 0;
  if (selectedPath && file.path === selectedPath) rank -= 1000;
  if (ticketId && file.path.toLowerCase().includes(String(ticketId).toLowerCase())) rank -= 100;
  if (file.thomasOwned) rank -= 50;
  rank += file.path.split("/").length;
  if (file.format === "markdown") rank -= 3;
  return rank;
}

function planFormat(relativePath) {
  return String(relativePath || "").toLowerCase().endsWith(".html") ? "html" : "markdown";
}

function safeRelativePath(value) {
  const relativePath = String(value || "").trim().replace(/\\/g, "/");
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.split("/").includes("..")) {
    throw planError(400, "Invalid plan path.");
  }
  return relativePath;
}

function planAnchors(content, format) {
  if (format === "html") return htmlAnchors(content);
  return markdownAnchors(content);
}

function htmlAnchors(content) {
  const anchors = [{ type: "plan", label: "Plan-wide" }];
  const seen = new Set();
  const stepRe = /<article\b[^>]*class=["'][^"']*\bstep\b[^"']*["'][^>]*data-step=["']([^"']+)["'][^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/gi;
  let match;
  while ((match = stepRe.exec(content))) {
    const step = stripTags(match[1]);
    const label = stripTags(match[2]).replace(/^\s*\d+\.\s*/, "").trim() || `Step ${step}`;
    const key = `step:${step}`;
    if (!seen.has(key)) {
      seen.add(key);
      anchors.push({ type: "html-step", step, label: `Step ${step}: ${label}`, selector: `article.step[data-step="${step}"]` });
    }
  }
  const headingRe = /<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  while ((match = headingRe.exec(content))) {
    const label = stripTags(match[2]).trim();
    const key = `heading:${label.toLowerCase()}`;
    if (label && !seen.has(key)) {
      seen.add(key);
      anchors.push({ type: "heading", label });
    }
  }
  return anchors.slice(0, 80);
}

function markdownAnchors(content) {
  const anchors = [{ type: "plan", label: "Plan-wide" }];
  for (const [index, line] of String(content || "").split(/\r?\n/).entries()) {
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) anchors.push({ type: "heading", label: heading[2].trim(), line: index + 1 });
  }
  return anchors.slice(0, 80);
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function defaultThomasPlan(ticket) {
  return [
    `# Plan for ${ticket.id}: ${ticket.title}`,
    "",
    "## Understanding",
    ticket.description ? ticket.description : "Describe the intended outcome before dispatching an agent.",
    "",
    "## Steps",
    "- [ ] Clarify the target behavior and relevant files.",
    "- [ ] Implement the smallest useful change.",
    "- [ ] Run the most relevant verification.",
    "- [ ] Summarize the result, risks, and next action.",
    "",
    "## Evidence Checklist",
    "- [ ] Implementation matches the ticket description.",
    "- [ ] Relevant validation has been run or explicitly waived.",
    "- [ ] Final agent summary explains what changed and any residual risk.",
    "",
  ].join("\n");
}

function planError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

module.exports = {
  createThomasPlanFile,
  discoverPlanFiles,
  readPlanFile,
};
