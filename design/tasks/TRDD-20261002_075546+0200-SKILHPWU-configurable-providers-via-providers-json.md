---
trdd-id: SKILHPWU
title: Configurable providers via providers.json
column: human_review
status: tasked
created: 2026-10-02T07:55:46+0200
updated: 2026-10-02T08:28:22+0200
current-owner: main-agent@quicksilver
created-by: main-agent@quicksilver
task-type: feature
min-approval-requirement: none
assignee: main-agent@quicksilver
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@quicksilver
approval-datetime: 2026-10-02T07:55:46+0200
implementation-commits: [7956979, 0756a7c, fc075dd, 8c9ff26, d196d2d, 72e77e9, 0c50ccd, aa05fcd]
---

# Configurable providers via providers.json

## Approval log

- 2026-10-02T07:55:46+0200 — MANDATE issued by main-agent@quicksilver (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Spec

Provider configuration moves into one git-free, user-owned file, `~/.quicksilver/providers.json` (or `$QUICKSILVER_HOME/providers.json`), whose `providers` array is the priority and fallback chain.

### User decisions (verbatim, 2026-10-02)

1. "make it configurable in a ~/.jgrep/providers.json  and ~/.quicksilver/providers.json configuration files"
2. "no, the keys must accept both the string of the actual key and the env var name. for example to configure openrouter: "api_key": "$OPENROUTER_API_KEY""
3. Adapters: "Both now" (Cloudflare + Vercel in both forks).
4. Config home: "Yes, one file per tool (Recommended)" — quicksilver ~/.quicksilver/providers.json holds default provider, models, keys (config.json folded in, stats.json stays); old files not converted silently, tool says once what to move.
5. "you can also make that the order in which the providers are written in the providers.json providers array, is the exact order of priority and fallback of the providers. put the openrouter provider as the first, and typesafe as the second, and so on for the remaining ones. any change or addition to the providers will reflect the fallback in case of errors, exhausted credits, or missing env var."
6. "yes. and for errors a log must be updated (truncated at 72 hours) in ~/.jgrep/errors.log and ~/.quicksilver/errors.log . note that simple absence of env var when scanning the providers must not be considered error. Also add to each provider entry in the providers.json array a "enabled": "true|false" field, to disable a provider if the user wants to. make sure to accept also equivalent values (true=enabled,true,1,yes,active,on,etc..; false=disabled,false,0,no,inactive,off, etc.)"
7. "yes" to a --max-bytes option for large inputs (quicksilver).

### File and schema (version 1)

```json
{ "version": 1, "providers": [ { "name": "openrouter", "api_key": "$OPENROUTER_API_KEY" }, { "name": "typesafe" } ] }
```

- Location: only `$QUICKSILVER_HOME/providers.json` (must be an absolute path) or `~/.quicksilver/providers.json`. Never the working directory, a project directory or `./.env`. A missing file means the built-in chain.
- Top level: `version` (must be 1) and `providers` (array). Any other key is an error.
- Chain: the file's entries in file order, then every built-in the file does not name, in built-in order. Built-in order: openrouter, typesafe, compatible, cloudflare, vercel. An entry whose name is a built-in overrides that built-in field by field; any other name adds a provider and must give `base_url`, `path`, `adapter`, `api_key` and `model`.
- Entry fields (unknown field = error):
  - `name` — `^[a-z][a-z0-9-]{1,31}$`, unique.
  - `enabled` — absent = enabled. true-set: JSON true, 1, and case-insensitive "true", "enabled", "enable", "1", "yes", "y", "active", "on". false-set: JSON false, 0, "false", "disabled", "disable", "0", "no", "n", "inactive", "off". Anything else is an error naming the provider and the value.
  - `base_url` — `https:` URL, or `http:` only to localhost, 127.0.0.1 or [::1]; no credentials, query or fragment.
  - `path` — starts with `/`; the only placeholder is `{account_id}`.
  - `adapter` — `system-one` | `cloudflare-ai-run` | `vercel-evaluation` (closed set, implemented in code).
  - `api_key` — string or array of strings. `$NAME` or `${NAME}` (NAME = `^[A-Za-z_][A-Za-z0-9_]*$`) reads the process environment; any other non-empty string is the literal key. In an array the first non-empty value wins.
  - `account_id` — same forms as `api_key`; required when `path` holds `{account_id}`; the resolved value must match `^[A-Za-z0-9]{1,64}$`.
  - `model` — default model id; must match `model_pattern` and the base id rule `^[A-Za-z0-9~][A-Za-z0-9._:/~-]{0,127}$`.
  - `model_pattern` — regex a model id must match to be used with this provider. `--model` / `QUICKSILVER_MODEL` / an ask spec's model are used for a provider only when they match; otherwise that provider uses its own `model` and a warning is printed.
  - `cost_field` — dotted path in the response holding the cost in USD (e.g. `usage.cost`), or null.
  - `usd_per_mtok` — fallback price per million input tokens, or null (unknown: the footer says the cost is incomplete).
  - `verify` — path of a free GET key check, or null (no free check; status says "not verified").
  - `headers` — static non-secret headers; names `authorization`, `cookie`, `proxy-authorization`, `x-api-key` and anything ending in `-key` or `-token` are refused.
  - `key_url` — https URL shown in hints.
- Security invariants (exit 1 naming the file and field): malformed JSON reports only line and column (never the parser message, which can quote a literal key); a literal `api_key` in a file that is group/world accessible or owned by another user is refused with the exact `chmod 600` fix; one `$VAR` may be referenced by at most one enabled provider; a literal key is never printed (status shows `$VAR` or "literal key in providers.json"); upstream text echoed in an error has the active key redacted; every request uses `redirect: "error"`.
- Writes (`setup`): directory 0700, file 0600, temp file + rename.

### Chain behaviour

- A provider is skipped silently (not an error, not logged) when disabled, when its key resolves to nothing, when its account id resolves to nothing, or when it has no `base_url`.
- Per request: on 401/403, 402 or an "insufficient credits" body, model unavailable (404, or a 400/422 body naming an unknown or unavailable model), 429 and 5xx after retries, a network error after retries, or an unusable response (Cloudflare `success:false`, non-Completed state, answers missing), the request moves to the next provider and the failed provider is skipped for the rest of the run. 400/422 request-shape errors stop the run (exit 4) with no fallback.
- `--provider X` or `QUICKSILVER_PROVIDER=X` pins X: no fallback; a disabled X is an error (exit 1); X with no key exits 3 naming every variable tried.
- The old rule "OPENROUTER_API_KEY in the environment auto-selects openrouter" is removed: openrouter is simply first.
- The run footer names the providers and models that answered, and how many requests fell back, from which provider, and why.
- `status` lists the chain in order with each entry's state: disabled, key missing (variables tried), not configured, ready, rejected, no credits, unreachable, ready (not verified).

### config.json and QUICKSILVER_API_BASE

- `config.json` is no longer read. If it exists, every command exits 1 with one message naming what it holds (provider, model, which providers have saved keys, never the key values) and where each goes in providers.json. No silent conversion. `stats.json` stays.
- `QUICKSILVER_API_BASE` is removed: a TypeSafe proxy is the typesafe entry's `base_url`. If it is set, commands exit 1 saying so (it would otherwise send requests to api.typesafe.ai instead of the proxy).

### Adapters

- `system-one`: POST `{model, state, questions}`, response `{answers, usage:{input_tokens}, model}`.
- `cloudflare-ai-run`: POST `{model, input:{state, questions}}` to `/accounts/{account_id}/ai/run`; response v4 envelope, `success:false` is an error, `result.state` other than "Completed" is an error, the payload is `result.result` (else `result`). Built-in model `typesafe/jev`, pattern `^typesafe/`.
- `vercel-evaluation`: POST `{state, questions}` (no model; noul questions sent as boolean; only type, instructions, criteria kept) with headers `ai-model-id: <model>`, `ai-gateway-protocol-version: 0.0.1`, `ai-gateway-auth-method: api-key`, `ai-evaluation-model-specification-version: 4`. Answers: boolean → `{type:"noul", noul: probability}`; choice/score confidence from `providerMetadata.typesafe.confidence[id]`, else null. Usage is camelCase `inputTokens`. Built-in model `typesafe-ai/jev`, pattern `^typesafe-ai/`.
- A null confidence prints as "n/a" and counts as low confidence in classify.

### errors.log

`$QUICKSILVER_HOME/errors.log`: one line per provider error event — ISO timestamp with offset, tool version, provider, model, error kind, HTTP status, short message (key redacted), and whether it fell back and to which provider. On every write, entries older than 72 hours are dropped and the file is rewritten atomically (temp + rename), mode 0600. A missing env var is never logged. A failed log write prints one stderr warning per run and never breaks the run.

### --max-bytes

User, verbatim (2026-10-02, supersedes the line that was here): "remove the input limit, make it opt-in only if --max-bytes is used. otherwise both tools must read any file size. add an hard limit of 100MB just to prevent system hungs."

- No default cap: any file, stdin stream or `--items` file is read, up to a fixed 100 MB (104857600 bytes) per input that cannot be raised.
- `--max-bytes N` (or `QUICKSILVER_MAX_BYTES`, the flag wins) sets a lower opt-in cap; a value above 100 MB exits 1. An over-the-cap file is listed as skipped; an over-the-cap stdin or `--items` file exits 1 naming the cap.

### Chunking (replaces --max-chars)

User, verbatim (2026-10-02): "max char is for jev context limit? it should still process any amount of chars, but just chunk them into jev context appropriate sized chunks to avoid overflowing the context size."
User, verbatim (2026-10-02, overrides any averaging): "cutting short is bad. it should chunk the files in parts and evaluate those parts separatedly, and if the command was a per file judgement, it should consider the higest scored chunk to decide if the file passes or not or to give a rating."

- Nothing sent to Jev is truncated. An item longer than `--chunk-chars N` (or `QUICKSILVER_CHUNK_CHARS`; 1000-90000, default 60000, sized for Jev's 32k-token context) is split at line ends (hard split only inside one over-long line) with a 500-char overlap. `--max-chars` is removed, with no alias.
- Each chunk is its own request (packing still applies to small units). The highest-scoring chunk decides: filter and ask yes/no by the highest probability, rank and ask --score by the highest score, classify and ask --choice by the most confident chunk (ties: the earliest). The deciding chunk is reported: `(N chunks, best lines A-B)` in text, `chunks` / `best_lines` in JSON.
- find sends whole lines (no 400-char clip); a line longer than a chunk is split into numbered pieces, and each request holds at most `--chunk` lines and `--chunk-chars` chars.
- ask chunks a string state the same way; a JSON object/array state larger than a chunk is split into groups of whole top-level entries, and one entry larger than a chunk exits 1.

### Example file

`skills/quicksilver/providers.example.json` lists every jev-mcp provider (openrouter first, typesafe second, then compatible, cloudflare, vercel, and a disabled local entry), keys as `$VAR`.

### setup and the default provider

There is no separate default-provider field: the default provider is the first usable entry of the chain, so the file order is the only source. `setup [KEY] [--provider X] [--model M]` verifies the key (when the provider has a free check) and stores it as a literal `api_key` on entry X (X = the pinned provider, else the chain head). If providers.json does not exist yet, setup writes every built-in by name in built-in order, so the whole chain is visible and editable; an entry missing from an existing file is appended to the file list. `setup --remove` deletes the `api_key` field of that entry.
