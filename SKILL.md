---
name: claude-model-guard
description: >-
  Passively log how Claude Code routes models — every Fable→Opus (or other real
  model) switch plus every auto-mode classifier block — into reviewable md+pdf
  reports. Use instead of toggling the "switch models when a message is flagged"
  setting: keep auto-switching on but keep a record. Trigger on
  /claude-model-guard, or when the user asks to log/track/audit Claude Code model
  switches or routing, set up model-switch logging, review "how has Claude Code
  been switching models / behaving", or install/remove this logging. Claude Code
  only — not Cowork.
---

# claude-model-guard

Keeps a local, passive audit log of Claude Code's model routing so you can review
it after any session. Two separate reports:

- **model-switch-log** (`Model-routing review log`) — safety fallbacks
  (Fable→Opus), refusals not served by a fallback, and manual/routing switches
  (e.g. Opus↔Sonnet). Fallbacks are detected the authoritative way, per
  [Anthropic's Refusals-and-fallback spec](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback):
  the `fallback` content block plus the `fallback_message` entry in
  `usage.iterations` (also catches sticky-routed turns). Model-diffing between
  turns does **not** catch a fallback — the served turn's `message.model` is
  already the fallback model.
- **auto-mode-blocks** — auto-mode safety-classifier denials (verbatim reasons).
  Unrelated to model routing; kept for audit value.

It reads Claude Code's own local session transcripts (`~/.claude/projects/*/*.jsonl`).
It is **for Claude Code specifically** — it does not read Cowork or anything else.

## When to use

Invoke on `/claude-model-guard` or when the user wants to: set up / install
model-switch logging; review how Claude Code has been routing models or behaving;
"log every time it switches from Fable to Opus"; or uninstall the logging.

## How it works

A parser (`scripts/scan-model-switches.mjs`) walks the transcripts and writes an
idempotent event DB (`state.json`); the md+pdf are rendered views regenerated
each run. Three triggers all call the same parser:

- **SessionEnd** hook — refresh at the end of each session.
- **PreCompact** hook — refresh before each compaction.
- **Daily scheduler** — Windows Scheduled Task `ClaudeModelGuard` (or cron on
  macOS/Linux) running `--all --days 7`, so multi-day sessions still get a daily
  refresh (hooks only fire at session boundaries).

Reports + DB live in `~/.claude/claude-model-guard/` (separate from this skill's
code, so updating the skill never wipes the log).

## Quick commands

```bash
# install / re-install (idempotent, migration-safe)
#   --dry-run to preview, --time HH:MM to set the daily scan time (default 23:30)
node "<skill>/scripts/install.mjs"

# refresh the log right now
node "<skill>/scripts/scan-model-switches.mjs" --all

# remove hooks + scheduler  (add --purge to also delete the accumulated log)
node "<skill>/scripts/uninstall.mjs"
```

`<skill>` = this skill's own directory (e.g. `~/.claude/skills/claude-model-guard`).

## Actions (what Claude should run)

- **Install / re-install** (idempotent, migration-safe):
  `node "<skill>/scripts/install.mjs"`  — add `--dry-run` to preview, `--time HH:MM`
  to set the daily time. Requires Node. Branded PDF renders through the
  **hq-report** skill when it's installed (WeasyPrint); otherwise it falls back to
  bundled `fpdf2` (`pip install fpdf2`), then to Markdown-only. Renderer choice is
  automatic — see `branding/report-brand.json` for the theme.
- **View reports:** open `~/.claude/claude-model-guard/model-switch-log.pdf`
  (and `auto-mode-blocks.pdf`), or read the matching `.md` files.
- **Refresh now:** `node "<skill>/scripts/scan-model-switches.mjs" --all`.
- **Uninstall:** `node "<skill>/scripts/uninstall.mjs"` (add `--purge` to also
  delete the accumulated log).

After installing, tell the user to restart Claude Code so the new hooks load.

## Reason / category

A Fable→Opus fallback is recorded **definitively** (direction + timestamp from the
`fallback` block / `usage.iterations`). The decline **category** — `cyber`, `bio`,
`frontier_llm`, or `reasoning_extraction` — comes from `stop_details.category` on a
`stop_reason:"refusal"` response. Per the
[spec](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback),
Anthropic's server-side fallback returns `stop_details: null` on the turn the
fallback model serves, so the category is present only on an **unserved** refusal.
The log stores the category whenever it is present, and otherwise records the
triggering prompt as best-effort context. Auto-mode blocks carry verbatim reasons.

## Reference

- Refusals and fallback — `stop_reason:"refusal"`, `stop_details.category`, the
  `fallback` content block, `usage.iterations`, sticky routing:
  <https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback>
