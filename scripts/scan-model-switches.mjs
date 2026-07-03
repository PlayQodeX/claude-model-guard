#!/usr/bin/env node
// claude-model-guard — scan-model-switches.mjs
//
// Scans Claude Code session transcripts (~/.claude/projects/*/*.jsonl) and logs
// how Claude Code has been routing models, so you can look back on it. Detects:
//
//   • Safety fallbacks (Fable → Opus) — the authoritative signal per Anthropic's
//     "Refusals and fallback" spec:
//     https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback
//     A fallback-served assistant turn carries a `fallback` content block
//     {"type":"fallback","from":{model},"to":{model}} and/or a `fallback_message`
//     entry in `usage.iterations` (sticky-routed turns have only the latter).
//     NOTE: model-diffing between turns does NOT catch this — the served turn's
//     `message.model` is the fallback model, so the switch hides inside one turn.
//   • Refusals not served by a fallback — `stop_reason:"refusal"` with
//     `stop_details.category` (cyber|bio|frontier_llm|reasoning_extraction) and a
//     human-readable `explanation`. This is the only place the decline *category*
//     is recorded; on a fallback-served turn `stop_details` is null.
//   • Manual/routing model switches (e.g. Opus↔Sonnet via /model or opusplan) —
//     a real claude-* model change between consecutive turns.
//   • Auto-mode classifier blocks — separate mechanism, written to its own report.
//
// For Claude Code specifically (reads Claude Code's local transcripts). Does not
// touch Cowork or anything else. state.json is the source-of-truth DB; the .md/
// .pdf are regenerated each run, so all triggers are idempotent.
//
// Usage:
//   node scan-model-switches.mjs --transcript "<path>"   # scan one session (hooks)
//   node scan-model-switches.mjs --all [--days N]        # scan recent sessions (daily)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, ".claude");
const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects");
const DATA_DIR = process.env.CLAUDE_MODEL_GUARD_DIR || path.join(CLAUDE_DIR, "claude-model-guard");
fs.mkdirSync(DATA_DIR, { recursive: true });

const STATE_PATH = path.join(DATA_DIR, "state.json");
const MD_PATH = path.join(DATA_DIR, "model-switch-log.md");
const PDF_PATH = path.join(DATA_DIR, "model-switch-log.pdf");
const BLOCK_MD_PATH = path.join(DATA_DIR, "auto-mode-blocks.md");
const BLOCK_PDF_PATH = path.join(DATA_DIR, "auto-mode-blocks.pdf");
const RUNLOG_PATH = path.join(DATA_DIR, "run.log");

const FABLE_RE = /fable/i;
const OPUS_RE = /opus/i;

const argv = process.argv.slice(2);
const argVal = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const MODE_ALL = argv.includes("--all");
const DAYS = Number(argVal("--days") ?? 7);
let transcriptArg = argVal("--transcript");

const log = (m) => { try { fs.appendFileSync(RUNLOG_PATH, `[${new Date().toISOString()}] ${m}\n`); } catch {} };

async function readStdinTranscript() {
  if (process.stdin.isTTY) return undefined;
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return undefined;
  try { const o = JSON.parse(raw); return o.transcript_path || o.transcriptPath; } catch { return undefined; }
}

function loadState() {
  try {
    const o = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    o.events ??= []; o.seen ??= {}; return o;
  } catch { return { events: [], seen: {} }; }
}
const saveState = (s) => fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));

function listSessionFiles() {
  const out = [];
  let projects = [];
  try { projects = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }); } catch { return out; }
  const cutoff = Date.now() - DAYS * 86400_000;
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, p.name);
    let files = [];
    try { files = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue; // top-level sessions only
      const full = path.join(dir, f.name);
      try { if (fs.statSync(full).mtimeMs >= cutoff) out.push(full); } catch {}
    }
  }
  return out;
}

const parseLine = (line) => { try { return JSON.parse(line); } catch { return null; } };
function firstUserText(msg) {
  const c = msg?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) for (const b of c) if (b?.type === "text" && typeof b.text === "string") return b.text;
  return null;
}
function truncate(s, n = 240) {
  if (!s) return s;
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

async function scanFile(file, state) {
  const sessionId = path.basename(file, ".jsonl");
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  let prevModel = null, lastUserText = null, newCount = 0;

  const record = (ev) => {
    const key = `${sessionId}:${ev.kind}:${ev.id}`;
    if (state.seen[key]) return;
    state.seen[key] = true;
    state.events.push({ sessionId, ...ev });
    newCount++;
  };

  for await (const line of rl) {
    if (!line) continue;
    const o = parseLine(line);
    if (!o) continue;
    const msg = o.message;

    if (o.type === "user" && msg) {
      const txt = firstUserText(msg);
      if (txt && txt.trim()) lastUserText = txt;
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      for (const b of blocks) {
        // genuine live auto-mode denial only (starts with the exact preamble)
        if (b?.type === "tool_result" && typeof b.content === "string" &&
            b.content.trimStart().startsWith(
              "Permission for this action was denied by the Claude Code auto mode classifier")) {
          const m = b.content.match(/Reason:\s*(.+?)(?:\s*If you have other tasks|\s*IMPORTANT:|$)/s);
          record({ kind: "AUTO_MODE_BLOCK", id: b.tool_use_id || o.uuid || `${o.timestamp}`,
            ts: o.timestamp || null, reason: truncate(m ? m[1] : b.content, 500) });
        }
      }
    }

    if (o.type === "assistant" && msg?.model) {
      const model = msg.model;
      const ts = o.timestamp || null;
      const id = msg.id || o.uuid || `${ts}`;
      const content = Array.isArray(msg.content) ? msg.content : [];
      const sd = msg.stop_details || null;
      const iterations = msg.usage?.iterations || [];

      // (1) Safety fallback — authoritative. Prefer the `fallback` content block
      //     (has direction); fall back to a `fallback_message` iteration (sticky).
      const fb = content.find((b) => b?.type === "fallback");
      const fbIter = iterations.find((i) => i?.type === "fallback_message");
      if (fb || fbIter) {
        const declinedIter = iterations.find((i) => i?.type === "message");
        const fromModel = fb?.from?.model || declinedIter?.model || "(unknown — sticky-routed)";
        const toModel = fb?.to?.model || fbIter?.model || model;
        record({
          kind: "FALLBACK", id, ts, fromModel, toModel,
          category: sd?.category ?? null,
          explanation: sd?.explanation ?? null,
          servedStopReason: msg.stop_reason ?? null,
          sticky: !fb && !!fbIter,
          fableOpus: FABLE_RE.test(fromModel) && OPUS_RE.test(toModel),
          trigger: truncate(lastUserText, 240),
        });
      } else if (msg.stop_reason === "refusal" || sd?.type === "refusal") {
        // (2) Refusal NOT served by a fallback — this is where the category lives.
        record({
          kind: "REFUSAL", id, ts, model,
          category: sd?.category ?? null,
          explanation: sd?.explanation ?? null,
          trigger: truncate(lastUserText, 240),
        });
      }

      // (3) Manual/routing model change between turns (real claude-* only; skip
      //     harness-injected <synthetic> continuation turns).
      if (/^claude-/i.test(model)) {
        if (prevModel && model !== prevModel) {
          record({
            kind: "MODEL_SWITCH", id, ts, fromModel: prevModel, toModel: model,
            fableOpus: (FABLE_RE.test(prevModel) && OPUS_RE.test(model)) ||
                       (OPUS_RE.test(prevModel) && FABLE_RE.test(model)),
            trigger: truncate(lastUserText, 240),
          });
        }
        prevModel = model;
      }
    }
  }
  return newCount;
}

// ---------- rendering ----------
function fmtUtc7(iso) {
  if (!iso) return "(no timestamp)";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const s = new Date(d.getTime() + 7 * 3600_000);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(s.getUTCDate())}-${p(s.getUTCMonth() + 1)}-${s.getUTCFullYear()} | ${p(s.getUTCHours())}:${p(s.getUTCMinutes())} UTC+7`;
}
function dayKey(iso) {
  if (!iso) return "unknown-date";
  const d = new Date(iso);
  if (isNaN(d)) return "unknown-date";
  const s = new Date(d.getTime() + 7 * 3600_000);
  const p = (n) => String(n).padStart(2, "0");
  return `${s.getUTCFullYear()}-${p(s.getUTCMonth() + 1)}-${p(s.getUTCDate())}`;
}
function groupByDay(events) {
  const byDay = {};
  for (const e of events) (byDay[dayKey(e.ts)] ??= []).push(e);
  return Object.keys(byDay).sort().reverse().map((day) => [day, byDay[day]]);
}
function reasonLine(e) {
  if (e.category) {
    return `  - Reason: **${e.category}**${e.explanation ? ` — ${e.explanation}` : ""}\n`;
  }
  return `  - Reason: category not recorded on the served turn (per the fallback spec, ` +
         `\`stop_details\` is null once the fallback model serves; the category only ` +
         `appears on an *unserved* refusal). Triggering prompt: ${e.trigger || "(n/a)"}\n`;
}

function renderSwitchMd(state) {
  const evs = state.events.filter((e) => ["FALLBACK", "MODEL_SWITCH", "REFUSAL"].includes(e.kind))
    .sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
  const fallbacks = evs.filter((e) => e.kind === "FALLBACK");
  const switches = evs.filter((e) => e.kind === "MODEL_SWITCH");
  const refusals = evs.filter((e) => e.kind === "REFUSAL");

  let md = `# Model-routing review log\n\n`;
  md += `_How Claude Code has been routing models. Generated by the **claude-model-guard** ` +
        `skill — do not hand-edit; regenerated on every session end, compaction, and daily scan. ` +
        `Source DB: \`state.json\`. Detection follows Anthropic's Refusals-and-fallback spec ` +
        `(fallback content block + \`usage.iterations\`); see the note at the bottom. Auto-mode ` +
        `classifier blocks are a separate mechanism — see \`auto-mode-blocks.md\`._\n\n`;
  md += `**Last updated:** ${fmtUtc7(new Date().toISOString())}\n\n`;
  md += `## Summary\n\n| Metric | Count |\n|---|---|\n`;
  md += `| Safety fallbacks (Fable→Opus) | ${fallbacks.filter((e) => e.fableOpus).length} |\n`;
  md += `| Safety fallbacks (other) | ${fallbacks.filter((e) => !e.fableOpus).length} |\n`;
  md += `| Refusals (not served by fallback) | ${refusals.length} |\n`;
  md += `| Manual/routing model switches | ${switches.length} |\n`;
  md += `| Sessions with events | ${new Set(evs.map((e) => e.sessionId)).size} |\n\n`;

  if (evs.length === 0) {
    md += `> Nothing recorded yet. When Fable declines a message and Claude Code falls back to ` +
          `Opus, it will appear here after the next session end / compaction / daily scan.\n`;
  }
  for (const [day, list] of groupByDay(evs)) {
    md += `\n## ${day}\n\n`;
    for (const e of list) {
      if (e.kind === "FALLBACK") {
        const tag = e.fableOpus ? "🔁 **Safety fallback — Fable→Opus**" : "🔁 **Safety fallback**";
        md += `- ${tag}${e.sticky ? " _(sticky-routed)_" : ""} — ${fmtUtc7(e.ts)}\n`;
        md += `  - From \`${e.fromModel}\` → \`${e.toModel}\` (served, stop_reason: \`${e.servedStopReason}\`)\n`;
        md += `  - Session: \`${e.sessionId}\`\n`;
        md += reasonLine(e);
      } else if (e.kind === "REFUSAL") {
        md += `- ⛔ **Refusal (not served by fallback)** — ${fmtUtc7(e.ts)}\n`;
        md += `  - Model: \`${e.model}\`\n  - Session: \`${e.sessionId}\`\n`;
        md += reasonLine(e);
      } else {
        md += `- 🔀 Model switch (manual/routing) — ${fmtUtc7(e.ts)}\n`;
        md += `  - From \`${e.fromModel}\` → \`${e.toModel}\`\n  - Session: \`${e.sessionId}\`\n`;
        if (e.trigger) md += `  - Context (best-effort): ${e.trigger}\n`;
      }
    }
  }
  md += `\n---\n\n_On the reason: a Fable→Opus safety fallback is recorded definitively (the ` +
        `\`fallback\` content block and the \`fallback_message\` entry in \`usage.iterations\`), ` +
        `but Anthropic's server-side fallback returns \`stop_details: null\` on the turn the ` +
        `fallback model serves — so the decline **category** (cyber / bio / frontier_llm / ` +
        `reasoning_extraction) is only present on an *unserved* \`stop_reason:"refusal"\`. ` +
        `Ref: https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback_\n`;
  return md;
}

function renderBlockMd(state) {
  const blocks = state.events.filter((e) => e.kind === "AUTO_MODE_BLOCK")
    .sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
  let md = `# Auto-mode classifier block log\n\n`;
  md += `_Separate from model routing. Auto-mode permission denials (the safety classifier that ` +
        `blocks risky actions while in auto mode); unrelated to Fable→Opus fallback. Kept for ` +
        `audit value. Generated by **claude-model-guard** — do not hand-edit._\n\n`;
  md += `**Last updated:** ${fmtUtc7(new Date().toISOString())}\n\n`;
  md += `**Total blocks:** ${blocks.length} across ${new Set(blocks.map((e) => e.sessionId)).size} session(s)\n`;
  if (blocks.length === 0) { md += `\n> No auto-mode classifier blocks recorded.\n`; return md; }
  for (const [day, list] of groupByDay(blocks)) {
    md += `\n## ${day}\n\n`;
    for (const e of list) {
      md += `- 🛑 **Auto-mode classifier block** — ${fmtUtc7(e.ts)}\n`;
      md += `  - Session: \`${e.sessionId}\`\n  - Reason (verbatim): ${e.reason}\n`;
    }
  }
  return md;
}

function renderPdf(mdPath, pdfPath) {
  const py = path.join(HERE, "render-pdf.py");
  if (!fs.existsSync(py)) { log("render-pdf.py missing — PDF skipped."); return false; }
  for (const cmd of ["python3", "python", "py"]) {
    try {
      execSync(`${cmd} "${py}" "${mdPath}" "${pdfPath}"`, { stdio: "ignore", timeout: 30000, windowsHide: true });
      log(`PDF rendered via ${cmd}: ${pdfPath}`); return true;
    } catch (e) { log(`PDF render failed (${cmd}): ${e.message}`); }
  }
  log(`PDF render skipped (need python + fpdf2) — ${path.basename(mdPath)} still updated.`);
  return false;
}
function renderAll(state) {
  fs.writeFileSync(MD_PATH, renderSwitchMd(state));
  renderPdf(MD_PATH, PDF_PATH);
  fs.writeFileSync(BLOCK_MD_PATH, renderBlockMd(state));
  renderPdf(BLOCK_MD_PATH, BLOCK_PDF_PATH);
}

(async () => {
  const state = loadState();
  let files = [];
  if (MODE_ALL) files = listSessionFiles();
  else {
    transcriptArg = transcriptArg || (await readStdinTranscript());
    if (transcriptArg && fs.existsSync(transcriptArg)) files = [transcriptArg];
  }
  if (files.length === 0) { log(`No transcripts (mode=${MODE_ALL ? "all" : "single"})`); renderAll(state); return; }
  let total = 0;
  for (const f of files) {
    try { total += await scanFile(f, state); } catch (e) { log(`scan error ${f}: ${e.message}`); }
  }
  saveState(state);
  renderAll(state);
  log(`Scanned ${files.length} file(s); ${total} new event(s); ${state.events.length} total.`);
  process.stdout.write(`claude-model-guard: ${total} new event(s), ${state.events.length} total. Data: ${DATA_DIR}\n`);
})();
