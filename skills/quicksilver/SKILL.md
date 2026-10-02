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

Run `qs status` first. It lists the providers in the order they are tried,
each with its state (PROVIDERS in the reference at the end says how that order
is built).

- Any line saying `ready` means go straight to the task. If a request fails on
  one provider (rejected key, no credits, model unavailable, rate limit, server
  error), Quicksilver retries it on the next provider by itself; the receipt
  says `fell back N×` and why, and `~/.quicksilver/errors.log` has the details.
  If every provider fails, the error lists each failure.
- Every line saying `key missing` (exit 3) means no key was found. Never ask the
  user to paste a key into the chat. The preferred fix: the user exports it in
  their shell profile, where Quicksilver detects it, then restarts Claude Code
  so the session inherits it: `OPENROUTER_API_KEY` with a key from
  **https://openrouter.ai/settings/keys**, or `JEV_API_KEY` (or `TYPESAFE_API_KEY`)
  with a key from **https://console.typesafe.ai**. The other providers'
  variables are under ENVIRONMENT in the reference.
  Fallback without an env var: the user runs `node "<skill dir>/scripts/qs.mjs" setup --provider NAME`
  in their own terminal. It prompts with hidden input, verifies the key and saves it
  to `~/.quicksilver/providers.json` (user-only permissions).
- The order, disabled providers, saved keys and custom endpoints live in
  `~/.quicksilver/providers.json` (example: `<skill dir>/providers.example.json`;
  the fields and the accepted `"enabled"` values are in the reference). A
  disabled provider shows as `disabled` in `qs status`, and `--provider`
  naming it is an error. If a command says `config.json is no longer read`,
  tell the user what it says to move; don't edit their files.

  Once a key is in place, carry on with the original task. Don't stop at "configured".

Exit code 3 means a key problem on every usable provider: re-run setup. Exit
code 4 means the request or the model was rejected (fix the question or labels).
EXIT CODES in the reference lists them all.

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
| Several questions over the same content | `qs ask spec.json` (raw request, see "Writing good questions") |

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
  skips secret-like files even when named explicitly, never follows symlinks
  unless `--follow-symlinks` is given, and respects `.gitignore`.

## Commands

The reference at the end of this file is the exact `qs help` output: every
command, option, default, environment variable and exit code. It is generated
from the code, so when anything here seems to disagree with it, the reference
is right.

**Inputs** (filter, classify, rank, find): files, directories, globs, `-` for
stdin, or `--items FILE.jsonl`. Add `--lines` to judge each line separately
(logs, CSVs, lists) and `--ext ts,tsx` to limit file types. Nothing is
truncated: a long item is split into chunks (see "Reading the output").

Add `--json` for machine-readable output (summary lines go to stderr), or
`--save FILE` (filter, classify) to write every per-item result to FILE while
stdout stays compact. `--fast` packs small items into shared requests: about
10× faster on big logs, but less accurate on subtle judgments. Use it for
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
- `(3 chunks, best lines 41-80)` after an item means it was longer than
  `--chunk-chars` and was judged in 3 parts; the highest-scoring part decided
  the verdict, and those lines are where to look (CHUNKS in the reference has
  the exact rule). For classify and `ask --choice`, put the catch-all label
  LAST (or name it with `--default`): a chunk that picks it does not vote.
  Since any one chunk can make an item pass, phrase questions positively
  ("Does this file send email?", not "Does it lack X?").
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
(packing measurably hurts accuracy), runs requests in parallel (`--concurrency`),
and retries rate limits, timeouts, server errors and network errors by itself.

## Reference: `qs help`

Generated from the code by `npm run sync-docs` (scripts/sync-skill-help.mjs).
Do not edit it by hand: a test fails whenever it differs from the live output.

<!-- qs-help:begin -->
```text
quicksilver: hand bulk yes/no, label, rank and find calls to Jev

usage: node qs.mjs <command> [args] [options]      (written "qs" below)

COMMANDS
  filter "<yes/no question>" <inputs>   keep the items where the answer is yes
  classify --labels "a,b,c" <inputs>    put each item under exactly one label
  rank "<query>" <inputs>               order items by relevance
  find "<what>" <files>                 locate the matching lines in big files
  ask "<question>" --state @f|text|-    one judgment over one document
  ask spec.json|-                       raw {state, questions} request
  setup [KEY] [--remove]                verify + save a key in providers.json
                                        (prompts if none; prefer an env var)
  status                                the provider chain and each one's
                                        state, plus lifetime savings
  help, --help, -h                      this screen

INPUTS  files, directories (.gitignore respected; outside git, dot-directories
        and build or dependency directories such as node_modules and dist are
        skipped), globs (Node 22+), - (stdin), --items FILE.jsonl|- (one
        {"id","text"} object or plain line each). Secret-like files (.env*,
        .envrc, keys, certs, credentials, kubeconfig, terraform vars/state,
        ...) are never sent, even when named explicitly. Symlinks are skipped
        unless --follow-symlinks. Binary files are skipped, and so are lock
        files and minified or source-map files. Any size is read up to a 100 MB
        hard cap per input; with --max-bytes N a larger file is skipped and a
        larger stdin or --items file is refused.

CHUNKS  Nothing is truncated. An item longer than --chunk-chars is split at
        line ends into overlapping chunks (500 chars), each judged on its own;
        the highest-scoring chunk decides the item: filter and ask yes/no take
        the highest probability, rank and ask --score the highest score.
        classify and ask --choice: the default label is the last one (or
        --default LABEL); a chunk whose label is the default does not vote, the
        most confident voting chunk decides, and only if no chunk votes is the
        item the default, at its best confidence. Output shows "(N chunks, best
        lines A-B)". Because any one chunk can make an item pass, ask positive
        questions ("does it contain X?"), not "does it lack X?".

PROVIDERS  ~/.quicksilver/providers.json ($QUICKSILVER_HOME/providers.json;
        never read from the working directory) lists providers in priority
        order: {"version": 1, "providers": [{"name": "openrouter", "api_key":
        "$OPENROUTER_API_KEY"}, {"name": "typesafe"}, ...]}. Built-in, in this
        default order: openrouter, typesafe, compatible (needs a base_url),
        cloudflare, vercel. With a file, its entries are the whole chain, in
        file order: a built-in it does not name is never used, and one it names
        supplies the fields the entry leaves out. Entry fields: name, enabled,
        base_url, path, adapter, api_key, account_id, model, model_pattern,
        cost_field, usd_per_mtok, verify, headers, key_url; any other field is
        an error. A provider that is not built in needs base_url, path,
        adapter, api_key, model; "adapter" is one of system-one,
        cloudflare-ai-run, vercel-evaluation. "api_key" is "$VAR", "${VAR}", a
        literal key (file must be chmod 600), or an array of these (the first
        one set wins); a provider whose key is unset is skipped. "enabled" is
        on when absent; it takes a JSON boolean, 1, 0 or a word,
        case-insensitive: on = true, enabled, enable, 1, yes, y, active, on;
        off = false, disabled, disable, 0, no, n, inactive, off. Any other
        value is a config error (exit 1). A request that fails on a rejected
        key, no credits, an unavailable model, 429 or 5xx/network after retries
        moves to the next provider (never on a 400/422), and the receipt says
        so; the failed provider is skipped for the rest of the run. Until a
        provider has answered once, the run's other requests wait for its first
        one, so a bad key costs one request, not one per item. If every
        provider fails, each failure is listed (exit 3 if any was a key or
        credit problem). --provider NAME pins one provider, no fallback; with a
        file, NAME must be one of its entries. Each error is logged to
        errors.log next to providers.json (kept 72 hours, keys masked). Run
        status to see the chain. Example with every field:
        providers.example.json in the skill folder (one level above this
        script).

OPTIONS
 input    --lines             each non-empty line is an item (logs, lists)
          --ext ts,tsx        only these file extensions
          --chunk-chars 60000 chunk size, 1000-90000 (fits Jev's 32k context)
          --limit 5000        refuse to run on more items than this
          --max-bytes N       per-file/stdin/--items size cap (opt-in; at most
                              104857600, the 100 MB hard cap)
          --no-secrets-guard  also send secret-looking files
          --follow-symlinks   read symlink targets (default: skip and list
                              them); the secret guard also checks the target's
                              path
 output   --json              JSON on stdout, receipt on stderr
          --save FILE         every per-item result to FILE (filter, classify)
          --top N | --all     rank: show N (10) or all; find: show N (5)
          --verbose           classify: every item with its confidence
          --no-collapse       with --lines: don't merge repeated log patterns
          --width 160         clip printed item text to this many chars
 accuracy --threshold 0.5     filter: the yes cutoff
          --band 0.15         filter: cutoff ± band is borderline, printed as ?
          --labels "a:hint,b" classify, ask --choice: text after : is a hint
          --labels-json J|@f  classify: {"label": "description", ...}
          --default LABEL     classify, ask --choice: the catch-all label
                              (default: the last one); see CHUNKS
          --question "..."    classify: ask this instead of "which label?"
          --min-confidence 0.6  classify: below this is printed as ?
          --only a,b          classify: print only these labels
          --min-score 0.05    find: drop hits scoring below this
          --chunk 150         find: lines per request, 1-250
 ask      --state @file|text|-  the content to judge
          --choice "a,b,c"    answer with one of these labels, not yes/no
          --score "low|mid|high"  rate on this scale, not yes/no
 speed    --concurrency 16    parallel requests
          --fast              pack small items per request: ~10x faster, less
                              accurate (obvious needles in huge logs only)
          --pack-items 1      items per request (40 with --fast)
          --pack-tokens 3000  estimated tokens per packed request
 provider --provider NAME     use only this provider (default: the chain)
          --model NAME        used where it fits the provider's model ids;
                              setup --model saves it on that entry

ENVIRONMENT
  OPENROUTER_API_KEY       openrouter key
  JEV_API_KEY, TYPESAFE_API_KEY
                           typesafe key (the first one set wins)
  JEV_GATEWAY_API_KEY      compatible key, with a base_url in providers.json
  JEV_CLOUDFLARE_API_TOKEN, CLOUDFLARE_API_TOKEN
                           cloudflare key (the first one set wins)
  CLOUDFLARE_ACCOUNT_ID    cloudflare account id
  AI_GATEWAY_API_KEY       vercel key
  QUICKSILVER_PROVIDER     same as --provider
  QUICKSILVER_MODEL        model, used when --model is absent
  QUICKSILVER_HOME         directory of providers.json, stats and errors.log,
                           an absolute path (default ~/.quicksilver)
  QUICKSILVER_FOLLOW_SYMLINKS=1
                           same as --follow-symlinks
  QUICKSILVER_MAX_BYTES    same as --max-bytes (the flag wins)
  QUICKSILVER_CHUNK_CHARS  same as --chunk-chars (the flag wins)
  QUICKSILVER_API_BASE     removed: refused while set (set "base_url" on the
                           typesafe entry instead)

EXIT CODES  0 ok · 1 usage, input or config error ·
            3 key missing, rejected or out of credits (re-run setup) ·
            4 request or model rejected ·
            5 request failed after retries, or an unexpected error ·
            130 setup prompt interrupted

EXAMPLES
  qs filter "Does this file handle user sessions?" src --ext ts,tsx
  qs filter "Does this line report a failure (not a warning)?" app.log --lines
  qs classify --labels "bug,feature,question" --items issues.jsonl --save r.json
  qs classify --labels "flaky:Intermittent,infra:CI setup,bug:Code" ci-logs/
  git log --format=%s | qs classify --labels "fix,feat,docs,chore" --lines -
  qs rank "where do we issue refunds?" src --top 5
  qs find "the retry backoff logic" huge_module.py --top 3
  qs ask "Does this contract allow termination without notice?" --state @c.txt
  qs ask "How severe is this?" --state @incident.md --score "minor|major|fatal"
  qs filter "Does this file build SQL from user input?" src --json
  qs status

USE CASES
  which files handle X?   filter    │  security review shortlist   filter
  triage log errors       --lines   │  CI failure triage           classify
  route tickets           classify  │  code in a huge file         find
  yes/no on a long doc    ask       │  best matches for a query    rank
```
<!-- qs-help:end -->
