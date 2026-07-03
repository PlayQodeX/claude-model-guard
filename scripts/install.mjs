#!/usr/bin/env node
// claude-model-guard — install.mjs
//
// Installs passive logging of Claude Code model switches + auto-mode blocks:
//   1. Adds SessionEnd + PreCompact hooks to ~/.claude/settings.json so the log
//      updates at every session end and before every compaction.
//   2. Registers a daily scheduler (Windows Scheduled Task / cron on macOS+Linux)
//      so long-running (multi-day) sessions still get a daily refresh.
//   3. Runs an initial scan so the reports exist immediately.
//
// Idempotent + migration-safe: re-running replaces our hooks/task rather than
// duplicating them, and it removes any older hook that points at a previous
// copy of scan-model-switches.mjs.
//
// Usage:
//   node install.mjs            # install / re-install
//   node install.mjs --dry-run  # show what it would do, write nothing
//   node install.mjs --time HH:MM   # daily scheduler time (default 23:30)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCAN = path.join(HERE, "scan-model-switches.mjs");
const NODE = process.execPath;
const HOME = os.homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, ".claude");
const SETTINGS = path.join(CLAUDE_DIR, "settings.json");
const TASK_NAME = "ClaudeModelGuard";
const LEGACY_TASKS = ["ClaudeModelSwitchLog"];
const CRON_MARKER = "# claude-model-guard";

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const timeIdx = argv.indexOf("--time");
const TIME = timeIdx >= 0 ? argv[timeIdx + 1] : "23:30";
const [HH, MM] = TIME.split(":");

const say = (m) => process.stdout.write(m + "\n");
const HOOK_CMD = `"${NODE}" "${SCAN}"`;

function upsertHooks() {
  let settings = {};
  if (fs.existsSync(SETTINGS)) {
    try { settings = JSON.parse(fs.readFileSync(SETTINGS, "utf8")); }
    catch (e) { say(`! Could not parse ${SETTINGS} (${e.message}). Aborting hook install to avoid corrupting it.`); return false; }
  }
  settings.hooks ??= {};
  const ourGroup = { hooks: [{ type: "command", command: HOOK_CMD }] };
  for (const evt of ["SessionEnd", "PreCompact"]) {
    const arr = Array.isArray(settings.hooks[evt]) ? settings.hooks[evt] : [];
    // drop any prior group that references our scanner (this path or an old one)
    const kept = arr.filter(
      (g) => !(g?.hooks || []).some((h) => String(h?.command || "").includes("scan-model-switches.mjs")));
    kept.push(ourGroup);
    settings.hooks[evt] = kept;
  }
  if (DRY) { say(`[dry-run] would write SessionEnd+PreCompact hooks -> ${SETTINGS}`); return true; }
  if (fs.existsSync(SETTINGS)) {
    const bak = `${SETTINGS}.bak-claude-model-guard-${new Date().toISOString().slice(0, 10)}`;
    try { fs.copyFileSync(SETTINGS, bak); say(`  backup: ${bak}`); } catch {}
  }
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));
  say(`  hooks installed -> ${SETTINGS}`);
  return true;
}

function installScheduler() {
  const platform = process.platform;
  if (platform === "win32") {
    for (const t of LEGACY_TASKS) {
      const cmd = `schtasks /Delete /TN "${t}" /F`;
      if (DRY) say(`[dry-run] would remove legacy task: ${t}`);
      else { try { execSync(cmd, { stdio: "ignore" }); say(`  removed legacy task: ${t}`); } catch {} }
    }
    const tr = `\\"${NODE}\\" \\"${SCAN}\\" --all --days 7`;
    const cmd = `schtasks /Create /TN "${TASK_NAME}" /TR "${tr}" /SC DAILY /ST ${TIME} /F`;
    if (DRY) { say(`[dry-run] ${cmd}`); return; }
    try { execSync(cmd, { stdio: "ignore" }); say(`  daily task "${TASK_NAME}" @ ${TIME}`); }
    catch (e) { say(`! scheduled task failed: ${e.message}`); }
    return;
  }
  // macOS + Linux: cron
  const cronLine = `${MM} ${HH} * * * "${NODE}" "${SCAN}" --all --days 7 ${CRON_MARKER}`;
  if (DRY) { say(`[dry-run] would add cron line: ${cronLine}`); return; }
  let existing = "";
  try { existing = execSync("crontab -l", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch {}
  const filtered = existing.split("\n").filter((l) => l && !l.includes(CRON_MARKER));
  filtered.push(cronLine);
  try {
    execFileSync("crontab", ["-"], { input: filtered.join("\n") + "\n" });
    say(`  daily cron @ ${TIME} (${CRON_MARKER})`);
  } catch (e) {
    say(`! cron install failed (${e.message}). Add this line to your crontab manually:`);
    say(`    ${cronLine}`);
  }
}

function initialScan() {
  if (DRY) { say(`[dry-run] would run initial scan: "${NODE}" "${SCAN}" --all --days 7`); return; }
  try {
    const out = execSync(`"${NODE}" "${SCAN}" --all --days 7`, { encoding: "utf8", timeout: 120000 });
    say(`  ${out.trim()}`);
  } catch (e) { say(`! initial scan failed: ${e.message}`); }
}

say(`claude-model-guard installer${DRY ? " (dry-run)" : ""}`);
say(`  node:    ${NODE}`);
say(`  scanner: ${SCAN}`);
say(`  target:  ${SETTINGS}`);
upsertHooks();
installScheduler();
initialScan();
say(`Done. Reports: ${path.join(CLAUDE_DIR, "claude-model-guard")}\\model-switch-log.pdf (+ auto-mode-blocks.pdf)`);
say(DRY ? "Dry run only — nothing changed." : "Restart Claude Code so the new hooks load.");
