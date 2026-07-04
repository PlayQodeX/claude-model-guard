# claude-model-guard — X post set

Suggested slot: Thursday July 9, 4-8 PM (peak window). Friday is dead, don't post today.

---

## Main post (with poster image)

Claude Code has a setting that swaps models when a message gets flagged. Fable refuses, Opus picks it up, and the session keeps moving like nothing happened.

I get why. A refusal isn't an error. It's a normal 200 with stop_reason: refusal, so nothing in the harness treats it as a failure. Nothing failing means nothing telling you.

I didn't want to turn the setting off, the fallback is doing its job. I just wanted to know when it happens.

So I built claude-model-guard. A skill that reads Claude Code's own local transcripts and keeps two reports: every model switch, and every classifier block with the verbatim reason. Refreshes at session end, before compaction, and daily. Nothing leaves the machine.

Link in the reply.

---

## Reply 1 — link comment (post immediately after main)

Repo: <ADD YOUR LINK HERE>

Install is one script, uninstall is one script, and --purge deletes the log if you want it gone.

---

## Reply 2 — self-reply, ~15 min later (text only, no image)

The one thing I couldn't log: why a message got flagged. Blocks come with a verbatim reason, switches don't, the harness just doesn't persist it. Closest I could get is storing the prompt that triggered the switch. If anyone knows where that reason lives, I want it.
