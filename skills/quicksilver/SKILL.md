---
name: quicksilver
description: Offload bulk judgment calls to Jev (TypeSafe's fast System One model) so Claude doesn't read, and pay for, content it only needs a verdict on. Use this BEFORE reading many files, long logs, or big lists just to decide which parts matter. That covers finding which files relate to a feature or bug, filtering log lines for errors, triaging or labelling many items (tickets, test failures, commits, TODOs, search hits), ranking candidates by relevance, locating the right lines in a huge file, or a yes/no check on a large document. Also use when the user says quicksilver, jev, "save tokens", "delegate", or "cheaper/faster". Skip it for generation, editing, multi-step reasoning, math, counting, or date comparison, and when the input is small enough to just read.
---

# Quicksilver: let Jev make the calls, Claude does the thinking

Jev returns **typed judgments** (yes/no probability, one-of-N label, rubric score)
in about a second, at $0.042 per million input tokens. It cannot write text or reason in
steps. So the split is simple: **Jev narrows, Claude reads only what survives.**
Every item Jev rules out is content that never enters Claude's context. That
saves tokens, saves usage limits, and cuts wall-clock time, because Jev scans
hundreds of items in parallel.

In the commands below, `qs` stands for:

```bash
node "<base directory of this skill>/scripts/qs.mjs"
```

Needs Node 18+ (globs need Node 22+). There are no other dependencies.

## First run: the key

Run `qs status` first.

- `ready` means go straight to the task.
- `not configured` means no key was found. Never ask the user to paste a key into
  the chat. The preferred fix: the user exports it in their shell profile, where
  Quicksilver detects it, then restarts Claude Code so the session inherits it:
  `JEV_API_KEY` (or `TYPESAFE_API_KEY`) with a key from **https://console.typesafe.ai**,
  or `OPENROUTER_API_KEY` with a key from **https://openrouter.ai/settings/keys**.
  Fallback without an env var: the user runs `node "<skill dir>/scripts/qs.mjs" setup`
  in their own terminal (add `--provider openrouter` for an OpenRouter key). It prompts
  with hidden input, verifies the key and saves it to `~/.quicksilver/config.json`
  (user-only permissions).

  Env keys take precedence over the saved key of the same provider. The provider is chosen by `--provider`, then `QUICKSILVER_PROVIDER`, then automatically openrouter whenever `OPENROUTER_API_KEY` is set, then the one saved by setup, then typesafe.
  Once a key is in place, carry on with the original task. Don't stop at "configured".

Exit code 3 means a key problem: missing, rejected, or out of credits. Re-run setup.
Exit code 4 means Jev rejected the request (fix the question or labels); 5 means
the request failed after retries; 1 is a usage or input error.

## When to delegate

Ask: *"Am I about to read a lot of content only to decide which parts matter?"*
If yes, and each decision fits yes/no, pick-a-label, or rate-on-a-scale, delegate.

| Situation | Command |
| --- | --- |
| "Which files deal with X?" across a repo | `qs filter "Does this file implement or handle X?" src` |
| Errors or anomalies in a big log | `qs filter "Does this line report a failure (not a warning)?" app.log --lines` |
| Where in a 5k-line file is Y? | `qs find "Y" big_file.py --top 5` |
| Sort 200 tickets, test failures, or TODOs into buckets | `qs classify --labels "bug,feature,question" --items items.jsonl` |
| CI failure triage | `qs classify --labels "flaky:Intermittent,infra:CI setup,bug:Code" ci-logs/` |
| Shortlist files for a security review | `qs filter "Does this file build SQL from user input?" src`, then read the `?` items |
| Best candidates for a query (search hits, docs, files) | `qs rank "query" docs/ --top 10` |
| One yes/no over a large document | `qs ask "Does this contract allow termination without notice?" --state @contract.txt` |
| Several questions over the same content | `qs ask spec.json` (raw request, see below) |

**Benchmarked strengths** (12 real tasks, see the repo's `bench/`): Quicksilver matched Claude's
accuracy while cutting its tokens by 77–96% on needle-in-haystack log search, finding
files across a repo, "where is X?" ranking, semantic search inside huge files, and bulk
routing or classification with clear labels (support intents, CI failure causes,
sentiment). It was weaker on subjective or expert-defined labels (commit types, alert
policies) and on look-alike code (safe vs vulnerable twins). There, use its output as a
shortlist, and check the `?` items yourself.

**Don't delegate:**
- Tiny inputs (a few files, or under ~2k tokens). Just read them.
- Exact matches. `grep` or `rg` is free and exact. Jev is for *meaning*: "handles
  auth" rather than the literal string `auth`.
- Arithmetic, counting, date or time comparison. Do those in code.
- Anything generative (writing, summarizing, editing) or needing a chain of reasoning.
- Content the user wouldn't want sent to a third-party API. Quicksilver already
  skips `.env*`, keys, certs, and credentials files, and respects `.gitignore`.

## Commands

`qs help` prints the full reference: every option, environment variable and exit code.

**Inputs** (filter, classify, rank, find): files, directories (respects
`.gitignore` inside git repos, and skips `node_modules`, `dist`, and similar),
globs, `-` for stdin, or `--items FILE.jsonl` (one JSON object per line with
`id` and `text`, or plain text lines; `-` reads stdin). Add `--lines` to judge
each line separately (logs, CSVs, lists). Use `--ext ts,tsx` to limit file types.
Items longer than `--max-chars 60000` are truncated; more than `--limit 5000`
items is refused.

```bash
qs filter "<yes/no question>" <inputs> [--threshold 0.5] [--band 0.15] [--lines]
qs classify --labels "a,b,c" <inputs> [--question "..."] [--only a] [--min-confidence 0.6] [--verbose]
qs classify --labels "bug:Something is broken,feature:A request for new behaviour" <inputs>
qs classify --labels-json '{"bug":"Something is broken"}' <inputs>   # or --labels-json @labels.json
qs rank "<query>" <inputs> [--top 10 | --all]
qs find "<what you're looking for>" <files> [--top 5] [--min-score 0.05] [--chunk 150]
qs ask "<question>" --state @file|"text"|- [--choice "a,b,c" | --score "low|mid|high"]
qs ask spec.json        # {"state": ..., "questions": {"id": {"type": "noul|choice|score", ...}}}
qs status               # key check, plus lifetime tokens saved
```

Add `--json` to any command for machine-readable output. Summary lines go to stderr.
`--save FILE` (filter, classify) writes every per-item result to FILE, while stdout
stays compact. `--width 160` clips printed item text; `--no-collapse` keeps repeated
`--lines` patterns separate; `--concurrency 16`, `--provider typesafe|openrouter`
and `--model NAME` apply everywhere.
`--fast` packs small items into shared requests (`--pack-items`, `--pack-tokens 3000`).
It's about 10× faster on big logs, but less accurate on subtle judgments. Use it for
obvious needles (crashes, OOMs) in very large logs, not for classification.

## Reading the output

Output is compact on purpose. For **filter**, each line is a probability, then the item.
With `--lines`, repeated log lines that differ only in numbers or ids are merged into
one pattern, followed by the matching line numbers:

```
0.99  src/db.ts
0.98  app.log:813  worker ERROR process killed: JavaScript heap out of memory
0.97  ×57  app.log:104  RAS KERNEL FATAL data TLB error interrupt
        also lines 115,121-130,…
? borderline (0.35–0.65) — check these yourself:
0.55  app/api/convert_safe.ts
— 340 scanned · 3 matched · 1 borderline · 4.1s · jev 90k tok ($0.0038) · ~88k Claude tokens not read
```

**classify** prints the count per label, then the ids in each label. After that it lists
each low-confidence item with its runner-up label and its text:

```
bug 41 · feature 12 · question 7
[bug] T1 T4 T9 …
? low confidence — check these yourself:
?0.49  bug (or question)  T33  login button does nothing on Safari?
```

- `?` marks a borderline or low-confidence item. **Read those yourself.** In the
  benchmark, the false positives sat in this band. Treat everything else as a
  reliable shortlist.
- `~` after an item means it was truncated past `--max-chars` (default 60k chars),
  so Jev only saw the start.
- The footer shows cost and the estimated Claude tokens avoided. Mention the
  savings to the user when they're meaningful.
- Jev's verdicts make a **shortlist, not proof**. Open the survivors before you
  edit code, draw conclusions, or tell the user something is definitely absent.
  If a filter returns nothing you expected to find, rephrase the question or
  lower `--threshold` before concluding.

## Writing good questions

Jev reads questions **literally**. Its accuracy comes from how precise the question is.

- One judgment per question. Say "Does this file send email?", not "Does this file
  send email or handle billing?". Run two filters instead.
- Spell out the exact condition, including the boundary cases: "Does this line
  report a failure (ERROR, FATAL, crash, timeout). Not warnings about deprecation?"
- Use plain meaning, not jargon hops or double negatives.
- Give classify labels short descriptions with `--labels "bug:Something broken,feature:New behaviour request"`.
  Add a catch-all label such as `other` when nothing may fit.
- For a raw `ask` spec, put the content in `state` (JSON objects are fine) and refer
  to fields in backticks inside instructions, like `` `ticket.body` ``. Questions
  run in parallel and can't see each other's answers. See
  https://docs.typesafe.ai/api.md for the full schema.

## Patterns that pay off

- **Funnel:** `qs filter` over the whole repo, then Claude reads the 5 survivors
  instead of 300 files.
- **Log triage:** `qs filter ... --lines` over a 50k-line log, then Claude
  investigates only the failures.
- **Two-pass precision:** a cheap broad `filter`, then `rank` the survivors
  against the specific question.
- **Batch triage:** dump items to JSONL (issues, test output, grep hits),
  `qs classify`, then act per bucket.

Jev handles 1,200 requests/min. Quicksilver sends one item per request by default
(packing measurably hurts accuracy), runs 16 in parallel, and retries rate limits
(429/529) automatically.
