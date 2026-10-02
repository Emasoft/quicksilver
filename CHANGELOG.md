# Changelog

## 0.3.0

### Added
- `~/.quicksilver/providers.json` (or `$QUICKSILVER_HOME/providers.json`, never
  the working directory): the `providers` array is the priority and fallback
  order. Entries override built-ins field by field or add new providers.
  `api_key` is `"$VAR"`, `"${VAR}"`, a literal key (file must be `chmod 600`) or
  an array of these; `enabled` accepts true/false, yes/no, on/off, 1/0,
  enabled/disabled, active/inactive. See `skills/quicksilver/providers.example.json`.
- Built-in providers, in default order: openrouter, typesafe, compatible (any
  System One server, with a `base_url`), cloudflare (Workers AI), vercel (AI
  Gateway). A provider whose key is not set is skipped silently.
- Per-request fallback: a rejected key, no credits, an unavailable model, or
  429/5xx/network after retries moves the request to the next provider. 400/422
  still stop the run. The receipt names the providers used and every fallback.
- `~/.quicksilver/errors.log`: one line per provider error, keys masked,
  entries older than 72 hours dropped.
- `status` lists the whole chain with each provider's state.
- `--max-bytes N` / `QUICKSILVER_MAX_BYTES`: an opt-in size cap per input.
- `--chunk-chars N` / `QUICKSILVER_CHUNK_CHARS` (default 60000, max 90000).

### Changed
- No default 2 MB input cap: any size is read, up to a fixed 100 MB per input.
- Nothing is truncated: long items are split into overlapping chunks, and the
  highest-scoring chunk decides the verdict (reported as `(N chunks, best lines
  A-B)`). `find` sends whole lines. A null confidence prints as `n/a`.
- `OPENROUTER_API_KEY` no longer switches the provider by itself: openrouter is
  simply first in the default chain.
- A model from `--model` / `QUICKSILVER_MODEL` is used only by providers whose
  `model_pattern` it matches.
- An unknown option (a typo, or the removed `--max-chars`) exits 1 naming it,
  instead of being ignored.
- `find --chunk` above 250 exits 1 instead of being cut to 250 silently.
- `qs help` is built from the constants the code runs on, and SKILL.md embeds
  it verbatim (`npm run sync-docs` regenerates it; a test fails when it is
  stale).

### Removed
- `--max-chars` (replaced by chunking).
- `~/.quicksilver/config.json`: no longer read. While it exists, commands stop
  and say what to move into `providers.json`; nothing is converted silently.
- `QUICKSILVER_API_BASE`: set `base_url` on the `typesafe` entry instead. It is
  refused while set, so requests never go somewhere you did not expect.
