#!/usr/bin/env node
// claude-model-guard — uninstall.mjs
// Removes the SessionEnd/PreCompact hooks and the daily scheduler.
// Keeps your accumulated log by default; pass --purge to also delete the data dir.
//
// Usage:  node uninstall.mjs [--purge]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const HOME = os.homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, ".claude");
const SETTINGS = path.join(CLAUDE_DIR, "settings.json");
const DATA_DIR = process.env.CLAUDE_MODEL_GUARD_DIR || path.join(CLAUDE_DIR, "claude-model-guard");
const TASKS = ["ClaudeModelGuard", "ClaudeModelSwitchLog"];
const CRON_MARKER = "# claude-model-guard";
const PURGE = process.argv.slice(2).includes("--purge");
const say = (m) => process.stdout.write(m + "\n");

// hooks
if (fs.existsSync(SETTINGS)) {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
    if (s.hooks) {
      for (const evt of ["SessionEnd", "PreCompact"]) {
        if (!Array.isArray(s.hooks[evt])) continue;
        s.hooks[evt] = s.hooks[evt].filter(
          (g) => !(g?.hooks || []).some((h) => String(h?.command || "").includes("scan-model-switches.mjs")));
        if (s.hooks[evt].length === 0) delete s.hooks[evt];
      }
    }
    fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2));
    say(`hooks removed from ${SETTINGS}`);
  } catch (e) { say(`! could not update settings.json: ${e.message}`); }
}

// scheduler
if (process.platform === "win32") {
  for (const t of TASKS) { try { execSync(`schtasks /Delete /TN "${t}" /F`, { stdio: "ignore" }); say(`removed task ${t}`); } catch {} }
} else {
  try {
    let existing = "";
    try { existing = execSync("crontab -l", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch {}
    const filtered = existing.split("\n").filter((l) => l && !l.includes(CRON_MARKER));
    execSync("crontab -", { input: filtered.join("\n") + "\n" });
    say("cron entry removed");
  } catch (e) { say(`! cron cleanup skipped: ${e.message}`); }
}

if (PURGE) {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); say(`purged data dir ${DATA_DIR}`); } catch {}
} else {
  say(`kept your log at ${DATA_DIR} (pass --purge to delete)`);
}
say("Done. Restart Claude Code so the hook change takes effect.");
