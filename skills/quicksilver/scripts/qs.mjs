#!/usr/bin/env node
// Quicksilver: hand Claude's bulk judgment calls to Jev (TypeSafe System One).
// Zero dependencies. Node 18+.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

// Same API on both providers, but keys are not interchangeable: each provider reads only its own env vars.
const PROVIDERS = {
  typesafe: { base: 'https://api.typesafe.ai', verify: '/v1/models', model: 'jev-latest', keyUrl: 'https://console.typesafe.ai', env: ['JEV_API_KEY', 'TYPESAFE_API_KEY'] },
  openrouter: { base: 'https://openrouter.ai/api', verify: '/v1/key', model: '~typesafe/jev-latest', keyUrl: 'https://openrouter.ai/settings/keys', env: ['OPENROUTER_API_KEY'] },
};
const HOME = process.env.QUICKSILVER_HOME || path.join(os.homedir(), '.quicksilver');
const CONFIG = path.join(HOME, 'config.json');
const STATS = path.join(HOME, 'stats.json');
let PROVIDER, API; // resolved once from flags/env/config by resolveProvider()
// PRICE_PER_TOKEN is the fallback when a response carries no `usage.cost` (typesafe direct).
const PRICE_PER_TOKEN = 0.042 / 1e6;
const costOf = (u) => u?.cost ?? (u?.input_tokens || 0) * PRICE_PER_TOKEN;

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit',
  'target', 'vendor', '__pycache__', '.venv', 'venv', 'coverage', '.turbo', '.cache', '.idea', '.vscode']);
// Matched against the input-relative path. Beyond dotenv files, keys and certs it covers direnv, git, docker,
// kube, postgres and htpasswd credentials, terraform vars/state, App Store .p8 and PuTTY keys, KeePass vaults,
// VPN profiles, GPG files and cloud service-account keys: all were sent before (audit M2).
const SECRET_RE = /(^|[/\\])(\.env(\..*)?|\.envrc|.*\.(pem|key|p12|pfx|keystore|jks|crt|cer|p8|ppk|kdbx|ovpn|gpg|tfvars|tfstate(\.backup)?)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.pgpass|\.htpasswd|\.dockercfg|kubeconfig|\.docker[/\\]config\.json|service-account[^/\\]*\.json|credentials(\.json)?|secrets?\.(json|ya?ml|toml))$/i;
// Per-input byte cap for files, stdin and --items: larger inputs are skipped (scanned files) or refused.
const MAX_BYTES = 2 * 1024 * 1024;
const LOCK_RE = /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|composer\.lock|\.min\.(js|css)|\.map)$/i;

// ---------- args ----------

function parseArgs(argv) {
  const pos = [], flags = {};
  const bools = new Set(['lines', 'json', 'all', 'remove', 'help', 'fast', 'verbose', 'no-collapse', 'no-secrets-guard']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const name = a.slice(2);
      if (bools.has(name) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) flags[name] = true;
      else flags[name] = argv[++i];
    } else if (a === '-h') flags.help = true;
    else pos.push(a);
  }
  return { pos, flags };
}

const die = (msg, code = 1) => { process.stderr.write(`quicksilver: ${msg}\n`); process.exit(code); };
// Numeric flags are validated once, before any work, by checkNums(): unchecked, NaN or 0 silently broke
// runs (--concurrency 0 started no workers and printed "(no matches)", --limit abc disabled the cap).
// [min, max, integer]
const NUM_FLAGS = {
  concurrency: [1, Infinity, true], limit: [1, Infinity, true], top: [1, Infinity, true], chunk: [1, Infinity, true],
  width: [1, Infinity, true], 'max-chars': [1, Infinity, true], 'pack-items': [1, Infinity, true], 'pack-tokens': [1, Infinity, true],
  threshold: [0, 1], band: [0, 1], 'min-confidence': [0, 1], 'min-score': [0, 1],
};
function checkNums(flags) {
  for (const [name, [min, max, int]] of Object.entries(NUM_FLAGS)) {
    const v = flags[name];
    if (v === undefined) continue;
    const n = v === true || !v.trim() ? NaN : Number(v);
    if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) {
      die(`--${name} needs ${int ? 'a whole number' : 'a number'} ${max === Infinity ? `>= ${min}` : `from ${min} to ${max}`}, got "${v === true ? '' : v}"`);
    }
    flags[name] = n;
  }
}
const num = (v, d) => v ?? d; // v is already a checked number (checkNums) or undefined
// Malformed user JSON is a usage error (exit 1), not an "unexpected error" stack with exit 5 (audit m4).
const parseJson = (text, what) => { try { return JSON.parse(text); } catch (e) { return die(`${what} is not valid JSON: ${e.message}`); } };
const estTokens = (s) => Math.ceil(s.length / 4);
const rel = (p) => path.relative(process.cwd(), p).split(path.sep).join('/') || '.';
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const f2 = (x) => x.toFixed(2);

// ---------- config / stats ----------

function readJson(file, fallback) {
  // Only a missing file means "use the fallback". A corrupt file used to read as {} too, and `setup --remove`
  // then overwrote it, losing the saved provider and model (audit m6).
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
  try { return JSON.parse(raw); } catch (e) { return die(`${file} is not valid JSON (${e.message}); fix or delete it`); }
}

// The directory holds the API key, so it is created 0700. Writing a fresh temp file and renaming it over the
// target is atomic (same directory, same filesystem): a crash never leaves a truncated config, and the new
// file always gets `mode`, which also made the old best-effort chmod of an existing file unnecessary.
function writeJson(file, obj, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode });
  fs.renameSync(tmp, file);
}

function apiKey() {
  const name = PROVIDERS[PROVIDER].env.find((n) => process.env[n]);
  if (name) return process.env[name];
  const cfg = readJson(CONFIG, {});
  return (cfg.provider || 'typesafe') === PROVIDER ? cfg.api_key || '' : '';
}

function resolveProvider(flags) {
  const cfg = readJson(CONFIG, {});
  const e = process.env;
  // user requirement: an OpenRouter key in the env always wins unless a provider is named explicitly
  if (flags.provider === true) die('--provider needs a value (typesafe|openrouter)');
  PROVIDER = flags.provider || e.QUICKSILVER_PROVIDER || (e.OPENROUTER_API_KEY ? 'openrouter' : '') || cfg.provider || 'typesafe';
  if (!PROVIDERS[PROVIDER]) die(`unknown provider "${PROVIDER}" (use ${Object.keys(PROVIDERS).join('|')})`);
  // QUICKSILVER_API_BASE is a TypeSafe-proxy override only: an OPENROUTER_API_KEY in env switches provider
  // automatically, so a provider-agnostic override would send the OpenRouter key to a TypeSafe proxy.
  API = ((PROVIDER === 'typesafe' && e.QUICKSILVER_API_BASE) || PROVIDERS[PROVIDER].base).replace(/\/$/, '');
  // The key rides in the Authorization header, so plain http is allowed only to this machine (audit m2).
  if (API !== PROVIDERS[PROVIDER].base) {
    let u;
    try { u = new URL(API); } catch { die(`QUICKSILVER_API_BASE is not a valid URL: ${API}`); }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) {
      die(`QUICKSILVER_API_BASE must use https (plain http only for localhost, 127.0.0.1 or [::1]), got ${u.origin}`);
    }
  }
}

function modelName(flags) {
  const cfg = readJson(CONFIG, {});
  const cfgModel = (cfg.provider || 'typesafe') === PROVIDER ? cfg.model : undefined;
  return flags.model || process.env.QUICKSILVER_MODEL || cfgModel || PROVIDERS[PROVIDER].model;
}

function recordStats(run) {
  const s = readJson(STATS, { since: new Date().toISOString(), runs: 0, requests: 0, items: 0, jev_input_tokens: 0, claude_tokens_saved: 0 });
  s.jev_cost_usd ??= s.jev_input_tokens * PRICE_PER_TOKEN;
  s.runs += 1;
  s.requests += run.requests;
  s.items += run.items;
  s.jev_input_tokens += run.jevTokens;
  s.jev_cost_usd += run.cost;
  s.claude_tokens_saved += Math.max(0, run.saved);
  // Stats are best-effort, but a failed write is reported, not swallowed.
  try { writeJson(STATS, s); } catch (e) { process.stderr.write(`quicksilver: warning: could not save ${STATS}: ${e.message}\n`); }
}

// ---------- HTTP ----------

const outOfCredits = () => `${PROVIDER}: out of credits (402). Top up at ${PROVIDERS[PROVIDER].keyUrl.replace(/\/keys$/, '/credits')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(method, route, body, { retries = 5 } = {}) {
  const key = apiKey();
  if (!key) die(`no ${PROVIDER} API key. Get one at ${PROVIDERS[PROVIDER].keyUrl}, then run: node qs.mjs setup --provider ${PROVIDER}`, 3);
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetch(API + route, {
        method,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      lastErr = `network error: ${e.message}`;
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (res.ok) return res.json();
    const text = await res.text();
    if (res.status === 401 || res.status === 403) die(`${PROVIDER} rejected the API key (${res.status}). Get a new one at ${PROVIDERS[PROVIDER].keyUrl} and run: node qs.mjs setup --provider ${PROVIDER}`, 3);
    // exit 3 = account/key problem the user must fix (SKILL.md contract)
    if (res.status === 402) die(outOfCredits(), 3);
    if (res.status === 422 || res.status === 400) die(`${PROVIDER} rejected the request (${res.status}): ${clip(text, 800)}`, 4);
    lastErr = `HTTP ${res.status}: ${clip(text, 300)}`;
    if (![408, 409, 429, 500, 502, 503, 504, 529].includes(res.status)) break;
    const ra = Number(res.headers.get('retry-after'));
    await sleep(ra > 0 ? ra * 1000 : 500 * 2 ** attempt + Math.random() * 250);
  }
  die(`${PROVIDER} request failed: ${lastErr}`, 5);
}

async function pool(tasks, n) {
  const out = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => {
    while (next < tasks.length) { const i = next++; out[i] = await tasks[i](); }
  }));
  return out;
}

// ---------- inputs ----------

function gitFiles(dir) {
  try {
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z', '--', '.'], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024,
    });
    return out.split('\0').filter(Boolean).map((f) => path.join(dir, f));
  } catch { return null; }
}

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!IGNORE_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), acc); }
    else if (e.isFile()) acc.push(path.join(dir, e.name));
  }
  return acc;
}

// A symlink is returned as-is (lstat, not stat) so collect() reports it instead of following it:
// stat would read the target, e.g. notes.txt -> ~/.aws/credentials from inside the repo.
const fileOrLink = (f) => { try { const st = fs.lstatSync(f); return st.isFile() || st.isSymbolicLink(); } catch { return false; } };

function expand(spec) {
  if (/[*?[\]{}]/.test(spec)) {
    if (!fs.globSync) die('glob patterns need Node 22+; pass a directory instead');
    return fs.globSync(spec, { exclude: (p) => IGNORE_DIRS.has(path.basename(p)) }).filter(fileOrLink);
  }
  if (!fs.existsSync(spec)) die(`no such file or directory: ${spec}`);
  const st = fs.lstatSync(spec);
  if (st.isFile() || st.isSymbolicLink()) return [spec];
  // Walk only outside git (null). An empty list means "inside git, everything ignored": walking it
  // would send exactly the gitignored files .gitignore is documented to keep out (audit m1).
  return (gitFiles(spec) ?? walk(spec)).filter(fileOrLink);
}

function readText(file, maxBytes) {
  const st = fs.statSync(file);
  if (st.size > maxBytes) return null;
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 8192).includes(0)) return null; // binary
  return buf.toString('utf8');
}

// Read in chunks and stop past MAX_BYTES: readFileSync(0) buffered any amount of piped input (audit m5).
function readStdin() {
  const chunks = [], buf = Buffer.alloc(65536);
  let total = 0;
  for (;;) {
    let n;
    try { n = fs.readSync(0, buf, 0, buf.length, null); } catch (e) {
      if (e.code === 'EAGAIN') continue; // non-blocking TTY: no data yet
      if (e.code === 'EOF') break; // Windows pipe end
      throw e;
    }
    if (n === 0) break;
    total += n;
    if (total > MAX_BYTES) die(`stdin is over ${MAX_BYTES / 1048576} MB; pass files instead, or split the input`);
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

// A file the user named for --items, --state @f, ask spec.json or --labels-json @f. Naming a file is not
// consent to send a credential: same secret guard as scanned files, on the name and the symlink target (audit m7).
function readInputFile(file, flags) {
  if (!flags['no-secrets-guard'] && [file, fs.realpathSync(file)].some((p) => SECRET_RE.test(p))) {
    die(`${file} looks like a secret file and is never sent (--no-secrets-guard overrides)`);
  }
  if (fs.statSync(file).size > MAX_BYTES) die(`${file} is over ${MAX_BYTES / 1048576} MB; split it`);
  return fs.readFileSync(file, 'utf8');
}

// Returns [{id, text, truncated}] plus a list of skipped paths.
function collect(pos, flags) {
  const maxChars = num(flags['max-chars'], 60000);
  const exts = flags.ext ? String(flags.ext).split(',').map((e) => '.' + e.replace(/^\./, '').toLowerCase()) : null;
  const items = [], skipped = [];
  const limit = num(flags.limit, 5000);
  const push = (id, text) => {
    // Checked per item, so a run over --limit stops before reading the rest of the input (audit m5).
    if (items.length >= limit) die(`more than ${limit} items (--limit ${limit}). Narrow the input or raise --limit.`);
    const truncated = text.length > maxChars;
    items.push({ id, text: truncated ? text.slice(0, maxChars) : text, truncated });
  };
  const pushLines = (name, text) => text.split(/\r?\n/).forEach((l, i) => { if (l.trim()) push(`${name}:${i + 1}`, l); });

  if (flags.items) {
    const raw = flags.items === '-' ? readStdin() : readInputFile(flags.items, flags);
    for (const [i, line] of raw.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      // A line that opens an object must be valid JSON: falling back to plain text (as before) silently
      // sent a broken record as text. Lines not starting with { are plain items, as documented.
      if (line.trimStart().startsWith('{')) {
        const { id, text, content, ...rest } = parseJson(line, `--items line ${i + 1}`);
        const body = text ?? content ?? JSON.stringify(rest);
        push(String(id ?? i + 1), typeof body === 'string' ? body : JSON.stringify(body));
      } else push(String(i + 1), line);
    }
  }

  const files = [];
  for (const spec of pos) {
    if (spec === '-') { const t = readStdin(); flags.lines ? pushLines('stdin', t) : push('stdin', t); continue; }
    files.push(...expand(spec));
  }
  const seen = new Set();
  for (const f of files) {
    const abs = path.resolve(f);
    if (seen.has(abs)) continue;
    seen.add(abs);
    const r = rel(abs);
    if (exts && !exts.includes(path.extname(f).toLowerCase())) continue;
    // Never follow a symlink, wherever it came from (git listing, glob, explicit path): its target can
    // sit outside the input tree, and SECRET_RE only sees the link's own name.
    if (fs.lstatSync(abs).isSymbolicLink()) { skipped.push(`${r} (symlink, never followed)`); continue; }
    if (!flags['no-secrets-guard'] && SECRET_RE.test(r)) { skipped.push(`${r} (secret-like, never sent)`); continue; }
    if (LOCK_RE.test(r)) continue;
    const text = readText(abs, MAX_BYTES);
    if (text === null) { skipped.push(`${r} (binary or >2MB)`); continue; }
    if (!text.trim()) continue;
    flags.lines ? pushLines(r, text) : push(r, text);
  }
  return { items, skipped };
}

// One item per request by default: packing items into a shared state measurably hurts accuracy
// (bench: CI triage 76% packed vs 100% unpacked). --fast packs small items for throughput.
function batches(items, flags) {
  const budget = num(flags['pack-tokens'], 3000), maxN = num(flags['pack-items'], flags.fast ? 40 : 1);
  const out = [];
  let cur = [], tok = 0;
  for (const it of items) {
    const t = estTokens(it.text) + 20;
    if (cur.length && (tok + t > budget || cur.length >= maxN)) { out.push(cur); cur = []; tok = 0; }
    cur.push(it); tok += t;
  }
  if (cur.length) out.push(cur);
  return out;
}

// Run one question per item. makeQ(ref, packed) builds the question; ref is how the item is addressed in state.
async function runPerItem(items, flags, makeQ) {
  const model = modelName(flags);
  const groups = batches(items, flags);
  const stats = { requests: groups.length, jevTokens: 0, cost: 0 };
  const results = await pool(groups.map((g) => async () => {
    const packed = g.length > 1;
    const state = packed
      ? { items: Object.fromEntries(g.map((it, j) => [`i${j}`, { source: it.id, content: it.text }])) }
      : { source: g[0].id, content: g[0].text };
    const questions = Object.fromEntries(g.map((_, j) => [`q${j}`, makeQ(packed ? `\`items.i${j}\`` : '`content`', packed)]));
    const res = await http('POST', '/v1/systemone', { model, state, questions });
    stats.jevTokens += res.usage?.input_tokens || 0;
    stats.cost += costOf(res.usage);
    stats.model = res.model;
    return g.map((it, j) => ({ item: it, answer: res.answers[`q${j}`] }));
  }), num(flags.concurrency, 16));
  return { rows: results.flat(), stats };
}

// ---------- output ----------

function footer(t0, items, extra, stats, outText, skipped) {
  const contentTok = items.reduce((a, it) => a + estTokens(it.text), 0);
  const saved = contentTok - estTokens(outText);
  const parts = [`${items.length} scanned`, ...extra, `${((Date.now() - t0) / 1000).toFixed(1)}s`,
    `jev ${fmtK(stats.jevTokens)} tok ($${stats.cost.toFixed(4)})`,
    `~${fmtK(Math.max(0, saved))} Claude tokens not read`];
  let s = `— ${parts.join(' · ')}`;
  if (skipped.length) s += `\n— skipped ${skipped.length}: ${clip(skipped.join(', '), 400)}`;
  recordStats({ requests: stats.requests, items: items.length, jevTokens: stats.jevTokens, cost: stats.cost, saved });
  return s;
}

const fmtK = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));

function emit(flags, jsonObj, lines, foot) {
  if (flags.json) { process.stdout.write(JSON.stringify(jsonObj, null, 2) + '\n'); process.stderr.write(foot + '\n'); return; }
  const body = lines.join('\n');
  process.stdout.write((body ? body + '\n' : '') + foot + '\n');
}

function label(it, flags) {
  const t = it.truncated ? '~' : '';
  return flags.lines || flags.items ? `${it.id}${t}  ${clip(it.text.trim().replace(/\s+/g, ' '), num(flags.width, 160))}` : `${it.id}${t}`;
}

function requireInputs(items, cmd) {
  if (!items.length) die(`nothing to ${cmd}: pass files, directories, globs, --items FILE, or - for stdin`);
}

// ---------- commands ----------

// Log lines repeat with different numbers/ids; collapse them so Claude reads each pattern once.
const template = (t) => t.replace(/0x[0-9a-f]+/gi, '#').replace(/[0-9a-f]{8,}/gi, '#').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

// [3,4,5,9] -> "3-5,9"; stops after `max` numbers and points at --save for the rest.
function ranges(nums, max) {
  const parts = [];
  let shown = 0;
  for (let i = 0; i < nums.length && shown < max; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    parts.push(j > i ? `${nums[i]}-${nums[j]}` : `${nums[i]}`);
    shown += j - i + 1;
    i = j;
  }
  return parts.join(',') + (shown < nums.length ? `,… (+${nums.length - shown}; use --save for all)` : '');
}

function renderRows(rs, flags, score) {
  if (!flags.lines || flags['no-collapse']) return rs.map((r) => `${f2(score(r))}  ${label(r.item, flags)}`);
  const groups = new Map();
  for (const r of rs) {
    const k = template(r.item.text);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups.values()].map((g) => {
    if (g.length === 1) return `${f2(score(g[0]))}  ${label(g[0].item, flags)}`;
    const rest = g.slice(1).map((r) => Number(r.item.id.split(':').pop())).sort((a, b) => a - b);
    return `${f2(score(g[0]))}  ×${g.length}  ${label(g[0].item, flags)}\n        also lines ${ranges(rest, 300)}`;
  });
}

function save(flags, data) {
  if (!flags.save) return '';
  fs.writeFileSync(flags.save, JSON.stringify(data, null, 2));
  return `\n— full results saved to ${flags.save}`;
}

async function cmdFilter({ pos, flags }) {
  const question = pos.shift();
  if (!question) die('usage: filter "<yes/no question>" <paths...>');
  const t0 = Date.now();
  const { items, skipped } = collect(pos, flags);
  requireInputs(items, 'filter');
  const thr = num(flags.threshold, 0.5), band = num(flags.band, 0.15);
  const { rows, stats } = await runPerItem(items, flags, (ref, packed) => ({
    type: 'noul',
    instructions: packed ? { question, answer_about: `Answer only about ${ref}; ignore the other items.` } : question,
  }));
  rows.sort((a, b) => b.answer.noul - a.answer.noul);
  const p = (r) => r.answer.noul;
  const hits = rows.filter((r) => p(r) >= thr);
  const sure = rows.filter((r) => p(r) >= thr + band);
  const unsure = rows.filter((r) => Math.abs(p(r) - thr) < band);
  const lines = [
    ...renderRows(sure, flags, p),
    ...(unsure.length ? [`? borderline (${f2(thr - band)}–${f2(thr + band)}) — check these yourself:`, ...renderRows(unsure, flags, p)] : []),
  ];
  if (!sure.length && !unsure.length) lines.push('(no matches)');
  const saved = save(flags, rows.map((r) => ({ id: r.item.id, p: p(r) })));
  const foot = footer(t0, items, [`${hits.length} matched`, `${unsure.length} borderline`], stats, lines.join('\n'), skipped) + saved;
  emit(flags, { matched: hits.map((r) => ({ id: r.item.id, p: p(r) })), borderline: unsure.map((r) => ({ id: r.item.id, p: p(r) })) }, lines, foot);
}

function parseLabels(flags) {
  if (flags['labels-json']) {
    const raw = String(flags['labels-json']);
    return parseJson(raw.startsWith('@') ? readInputFile(raw.slice(1), flags) : raw, '--labels-json');
  }
  if (!flags.labels) die('classify needs --labels "a,b,c" or --labels-json \'{"a":"description"}\'');
  return Object.fromEntries(String(flags.labels).split(',').map((s) => s.trim()).filter(Boolean).map((l) => {
    const [k, ...d] = l.split(':');
    return [k.trim(), d.length ? d.join(':').trim() : null];
  }));
}

async function cmdClassify({ pos, flags }) {
  const criteria = parseLabels(flags);
  const n = Object.keys(criteria).length;
  if (n < 2 || n > 255) die('classify needs 2–255 labels');
  const question = flags.question || 'Which label best describes this item?';
  const t0 = Date.now();
  const { items, skipped } = collect(pos, flags);
  requireInputs(items, 'classify');
  const minConf = num(flags['min-confidence'], 0.6);
  const { rows, stats } = await runPerItem(items, flags, (ref, packed) => ({
    type: 'choice',
    instructions: packed ? { question, answer_about: `Answer only about ${ref}; ignore the other items.` } : question,
    criteria,
  }));
  const groups = {};
  for (const r of rows) (groups[r.answer.choice] ||= []).push(r);
  const only = flags.only ? new Set(String(flags.only).split(',')) : null;
  const low = rows.filter((r) => r.answer.confidence < minConf);
  const lines = [Object.keys(criteria).map((k) => `${k} ${groups[k]?.length || 0}`).join(' · ')];
  for (const k of Object.keys(criteria)) {
    if (!groups[k] || (only && !only.has(k))) continue;
    const g = groups[k].sort((a, b) => b.answer.confidence - a.answer.confidence);
    if (flags.verbose) {
      lines.push(`[${k}]`);
      for (const r of g) lines.push(`${r.answer.confidence < minConf ? '?' : ' '}${f2(r.answer.confidence)}  ${label(r.item, flags)}`);
    } else {
      const ok = g.filter((r) => r.answer.confidence >= minConf).map((r) => r.item.id);
      if (ok.length) lines.push(`[${k}] ${ok.join(' ')}`);
    }
  }
  if (!flags.verbose && low.length) {
    lines.push('? low confidence — check these yourself:');
    for (const r of low.filter((r) => !only || only.has(r.answer.choice))) {
      const [second] = Object.entries(r.answer.probabilities).sort((a, b) => b[1] - a[1]).slice(1);
      lines.push(`?${f2(r.answer.confidence)}  ${r.answer.choice} (or ${second?.[0]})  ${r.item.id}  ${clip(r.item.text.trim().replace(/\s+/g, ' '), num(flags.width, 160))}`);
    }
  }
  const saved = save(flags, rows.map((r) => ({ id: r.item.id, label: r.answer.choice, confidence: r.answer.confidence })));
  const foot = footer(t0, items, [`${low.length} low-confidence (?)`], stats, lines.join('\n'), skipped) + saved;
  emit(flags, rows.map((r) => ({ id: r.item.id, label: r.answer.choice, confidence: r.answer.confidence, probabilities: r.answer.probabilities })), lines, foot);
}

const RANK_LEVELS = [
  'Unrelated to the query',
  'Shares a topic with the query but does not help answer it',
  'Partially relevant: contains some useful information for the query',
  'Relevant: substantially addresses the query',
  'Directly and specifically answers or matches the query',
];

async function cmdRank({ pos, flags }) {
  const query = pos.shift();
  if (!query) die('usage: rank "<query>" <paths...> [--top 10]');
  const t0 = Date.now();
  const { items, skipped } = collect(pos, flags);
  requireInputs(items, 'rank');
  const { rows, stats } = await runPerItem(items, flags, (ref, packed) => ({
    type: 'score',
    instructions: { query, question: `How relevant is ${ref} to \`query\`?${packed ? ' Ignore the other items.' : ''}` },
    criteria: RANK_LEVELS,
  }));
  const top = num(flags.top, 10), max = RANK_LEVELS.length - 1;
  rows.sort((a, b) => b.answer.score - a.answer.score);
  const shown = flags.all ? rows : rows.slice(0, top);
  const lines = shown.map((r) => `${f2(r.answer.score / max)}  ${label(r.item, flags)}`);
  const foot = footer(t0, items, [`top ${shown.length}`], stats, lines.join('\n'), skipped);
  emit(flags, shown.map((r) => ({ id: r.item.id, relevance: r.answer.score / max, confidence: r.answer.confidence })), lines, foot);
}

async function cmdFind({ pos, flags }) {
  const query = pos.shift();
  if (!query || !pos.length) die('usage: find "<what you are looking for>" <files...> [--top 5]');
  const t0 = Date.now();
  const model = modelName(flags);
  const chunkLines = Math.min(num(flags.chunk, 150), 250);
  const { items: files, skipped } = collect(pos, { ...flags, lines: false, 'max-chars': Infinity });
  requireInputs(files, 'find');
  const chunks = [];
  for (const f of files) {
    const all = f.text.split(/\r?\n/).map((t, i) => [String(i + 1), t]).filter(([, t]) => t.trim());
    for (let i = 0; i < all.length; i += chunkLines) chunks.push({ file: f.id, lines: all.slice(i, i + chunkLines) });
  }
  const stats = { requests: chunks.length, jevTokens: 0, cost: 0 };
  const perChunk = await pool(chunks.map((c) => async () => {
    const lines = Object.fromEntries(c.lines.map(([n, t]) => [n, clip(t, 400)]));
    const res = await http('POST', '/v1/systemone', {
      model,
      state: { query, lines },
      questions: {
        where: {
          type: 'choice',
          instructions: 'Which line number in `lines` best matches `query`?',
          criteria: { ...Object.fromEntries(c.lines.map(([n]) => [n, null])), none: 'No line matches `query`' },
        },
        exists: { type: 'noul', instructions: 'Does any line in `lines` match `query`?' },
      },
    });
    stats.jevTokens += res.usage?.input_tokens || 0;
    stats.cost += costOf(res.usage);
    const ex = res.answers.exists.noul;
    return Object.entries(res.answers.where.probabilities)
      .filter(([n]) => n !== 'none')
      .map(([n, p]) => ({ file: c.file, line: n, text: lines[n], score: p * ex }));
  }), num(flags.concurrency, 16));
  const top = num(flags.top, 5), minScore = num(flags['min-score'], 0.05);
  const hits = perChunk.flat().filter((h) => h.score >= minScore).sort((a, b) => b.score - a.score).slice(0, top);
  const out = hits.map((h) => `${f2(h.score)}  ${h.file}:${h.line}  ${clip(h.text.trim(), num(flags.width, 160))}`);
  if (!out.length) out.push('(no matching lines)');
  const foot = footer(t0, files, [`${chunks.length} chunks`], stats, out.join('\n'), skipped);
  emit(flags, hits, out, foot);
}

function fmtAnswer(id, a) {
  if (a.type === 'noul') return `${id}  noul ${f2(a.noul)}`;
  if (a.type === 'choice') return `${id}  choice ${a.choice} (conf ${f2(a.confidence)})`;
  if (a.type === 'score') {
    const lvl = a.legend?.[String(Math.round(a.score))];
    return `${id}  score ${f2(a.score)}/${Object.keys(a.legend || {}).length - 1}${lvl ? ` "${clip(lvl, 60)}"` : ''} (conf ${f2(a.confidence)})`;
  }
  return `${id}  ${JSON.stringify(a)}`;
}

function readStateArg(v, flags) {
  if (v === undefined) return undefined;
  if (v === '-') return readStdin();
  if (typeof v === 'string' && v.startsWith('@')) return readInputFile(v.slice(1), flags);
  return v;
}

async function cmdAsk({ pos, flags }) {
  const t0 = Date.now();
  let body;
  const first = pos[0];
  if (first && (first === '-' || first.endsWith('.json')) && !flags.state) {
    body = parseJson(first === '-' ? readStdin() : readInputFile(first, flags), first === '-' ? 'ask spec on stdin' : first);
  } else {
    const question = pos.join(' ');
    if (!question) die('usage: ask "<question>" --state @file|text|- [--choice "a,b" | --score "low|mid|high"]  or  ask spec.json');
    const state = readStateArg(flags.state, flags);
    if (state === undefined) die('ask needs --state (@file, literal text, or - for stdin)');
    let q = { type: 'noul', instructions: question };
    if (flags.choice) q = { type: 'choice', instructions: question, criteria: parseLabels({ labels: flags.choice }) };
    if (flags.score) q = { type: 'score', instructions: question, criteria: String(flags.score).split('|').map((s) => s.trim()) };
    body = { state, questions: { answer: q } };
  }
  body.model ||= modelName(flags);
  if (!body.state || !body.questions) die('spec needs "state" and "questions"');
  const res = await http('POST', '/v1/systemone', body);
  const lines = Object.entries(res.answers).map(([id, a]) => fmtAnswer(id, a));
  const stateText = typeof body.state === 'string' ? body.state : JSON.stringify(body.state);
  const foot = footer(t0, [{ text: stateText }], [], { requests: 1, jevTokens: res.usage?.input_tokens || 0, cost: costOf(res.usage) }, lines.join('\n'), []);
  emit(flags, res, lines, foot.replace('1 scanned · ', ''));
}

async function promptHidden(q) {
  if (!process.stdin.isTTY) return readStdin().trim();
  process.stderr.write(q);
  return new Promise((resolve) => {
    let s = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', function onData(ch) {
      for (const c of ch) {
        if (c === '\r' || c === '\n' || c === '\u0004') {
          process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onData);
          process.stderr.write('\n'); return resolve(s.trim());
        }
        if (c === '\u0003') { process.stderr.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') { if (s.length) { s = s.slice(0, -1); process.stderr.write('\b \b'); } continue; }
        s += c; process.stderr.write('*');
      }
    });
  });
}

async function cmdSetup({ pos, flags }) {
  const { keyUrl, verify } = PROVIDERS[PROVIDER];
  if (flags.remove) {
    const cfg = readJson(CONFIG, {});
    delete cfg.api_key;
    writeJson(CONFIG, cfg, 0o600);
    return console.log(`Removed saved key from ${CONFIG}`);
  }
  const key = (pos[0] || (await promptHidden(`Paste your ${PROVIDER} API key (from ${keyUrl}): `))).trim();
  if (!key) die(`no key given. Get one at ${keyUrl}`);
  const res = await fetch(API + verify, { headers: { Authorization: `Bearer ${key}` } }).catch((e) => die(`network error: ${e.message}`));
  if (res.status === 401 || res.status === 403) {
    const auto = PROVIDER === 'openrouter' && !flags.provider && !process.env.QUICKSILVER_PROVIDER && process.env.OPENROUTER_API_KEY;
    die(`that key was rejected by ${PROVIDER} (${res.status}). Double-check it at ${keyUrl}` + (auto ? ' (OPENROUTER_API_KEY is set, so setup assumed openrouter; for a Jev/TypeSafe key add --provider typesafe)' : ''), 3);
  }
  // Every provider-side refusal is exit 3 (key or account problem, re-run setup), as for normal commands.
  if (res.status === 402) die(outOfCredits(), 3);
  if (!res.ok) die(`could not verify the key: ${PROVIDER} answered HTTP ${res.status}`, 3);
  const cfg = readJson(CONFIG, {});
  // A model name saved for the other provider is meaningless here (different id), so drop it.
  if ((cfg.provider || 'typesafe') !== PROVIDER && !flags.model) delete cfg.model;
  cfg.provider = PROVIDER;
  cfg.api_key = key;
  if (flags.model) cfg.model = flags.model;
  writeJson(CONFIG, cfg, 0o600);
  console.log(`✓ ${PROVIDER} key verified and saved to ${CONFIG}. Quicksilver is ready.`);
  const envName = PROVIDERS[PROVIDER].env.find((n) => process.env[n]);
  if (envName) console.error(`note: ${envName} is set and overrides the saved key for ${PROVIDER}`);
}

async function cmdStatus() {
  const { keyUrl, verify, env: envNames } = PROVIDERS[PROVIDER];
  const env = envNames.find((n) => process.env[n]) || null;
  const key = apiKey();
  if (!key) { console.log(`not configured (provider ${PROVIDER}) — get a key at ${keyUrl}, then run: node qs.mjs setup --provider ${PROVIDER}`); process.exit(3); }
  const res = await fetch(API + verify, { headers: { Authorization: `Bearer ${key}` } }).catch(() => null);
  const s = readJson(STATS, null);
  const src = env ? `env ${env}` : CONFIG;
  if (!res) console.log(`key found (${src}) but ${PROVIDER} is unreachable right now`);
  else if (!res.ok) { console.log(`key found (${src}) but rejected (HTTP ${res.status}) — run setup with a fresh key from ${keyUrl}`); process.exit(3); }
  else console.log(`ready · provider ${PROVIDER} · key from ${src} · model ${modelName({})}`);
  if (s) console.log(`since ${s.since.slice(0, 10)}: ${s.runs} runs · ${fmtK(s.items)} items judged · jev ${fmtK(s.jev_input_tokens)} tok ($${(s.jev_cost_usd ?? s.jev_input_tokens * PRICE_PER_TOKEN).toFixed(4)}) · ~${fmtK(s.claude_tokens_saved)} Claude tokens not read`);
}

const HELP = `quicksilver: hand bulk yes/no, label, rank and find calls to Jev

usage: node qs.mjs <command> [args] [options]      (written "qs" below)

COMMANDS
  filter "<yes/no question>" <inputs>   keep the items where the answer is yes
  classify --labels "a,b,c" <inputs>    put each item under exactly one label
  rank "<query>" <inputs>               order items by relevance
  find "<what>" <files>                 locate the matching lines in big files
  ask "<question>" --state @f|text|-    one judgment over one document
  ask spec.json|-                       raw {state, questions} request
  setup [KEY] [--remove]                verify + save a key (prompts if none)
  status                                check the key, show lifetime savings
  help, --help, -h                      this screen

INPUTS  files, directories (.gitignore respected), globs (Node 22+), - (stdin),
        --items FILE.jsonl|- (one {"id","text"} object or plain line each).
        .env*, keys, certs, credentials never sent; binary or >2 MB skipped.

OPTIONS
 input    --lines             each non-empty line is an item (logs, lists)
          --ext ts,tsx        only these file extensions
          --max-chars 60000   truncate each item (marked ~ in the output)
          --limit 5000        refuse to run on more items than this
          --no-secrets-guard  also send secret-looking files
 output   --json              JSON on stdout, receipt on stderr
          --save FILE         every per-item result to FILE (filter, classify)
          --top N | --all     rank: show N (10) or all; find: show N (5)
          --verbose           classify: every item with its confidence
          --no-collapse       with --lines: don't merge repeated log patterns
          --width 160         clip printed item text to this many chars
 accuracy --threshold 0.5 --band 0.15   filter: yes cutoff; cutoff±band = ?
          --labels "a:hint,b" classify, ask --choice: text after : is a hint
          --labels-json J|@f  classify: {"label": "description", ...}
          --question "..."    classify: ask this instead of "which label?"
          --min-confidence 0.6  classify: below this is printed as ?
          --only a,b          classify: print only these labels
          --min-score 0.05 --chunk 150  find: drop weaker hits; lines/request
 ask      --state @file|text|-  the content to judge
          --choice "a,b,c" | --score "low|mid|high"  label or scale, not y/n
 speed    --concurrency 16    parallel requests
          --fast              pack small items per request: ~10x faster, less
                              accurate (obvious needles in huge logs only)
          --pack-items N --pack-tokens 3000  packing limits (N: 1, --fast 40)
 provider --provider typesafe|openrouter   default: see ENVIRONMENT
          --model NAME        default per provider; setup --model saves it

ENVIRONMENT
  JEV_API_KEY, TYPESAFE_API_KEY  typesafe key (beats the saved key)
  OPENROUTER_API_KEY    openrouter key; when set, openrouter is the default
  QUICKSILVER_PROVIDER  typesafe|openrouter, used when --provider is absent
  QUICKSILVER_MODEL     model, used when --model is absent
  QUICKSILVER_API_BASE  typesafe-only API base URL (proxies)
  QUICKSILVER_HOME      config + stats directory (default ~/.quicksilver)

EXIT CODES  0 ok · 1 usage/input error · 3 key missing, rejected or out of
            credits (re-run setup) · 4 request rejected · 5 request failed

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
  qs status --provider openrouter

USE CASES
  which files handle X?   filter    │  security review shortlist   filter
  triage log errors       --lines   │  CI failure triage           classify
  route tickets           classify  │  code in a huge file         find
  yes/no on a long doc    ask       │  best matches for a query    rank`;

// Every command validates its numeric flags and resolves the provider first, from its parsed flags.
const COMMANDS = Object.fromEntries(Object.entries({ setup: cmdSetup, status: cmdStatus, filter: cmdFilter, classify: cmdClassify, rank: cmdRank, find: cmdFind, ask: cmdAsk })
  .map(([name, fn]) => [name, (args) => { checkNums(args.flags); resolveProvider(args.flags); return fn(args); }]));

process.on('unhandledRejection', (e) => die(`unexpected error: ${e?.stack || e}`, 5));
process.on('uncaughtException', (e) => die(`unexpected error: ${e?.stack || e}`, 5));

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
// `qs <command> --help` must show help too, not fail on the missing arguments. Help comes from the parsed
// flags, so a flag's value (`--state -h`, `--labels -h`) or anything after `--` never triggers it.
if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.flags.help) { console.log(HELP); process.exit(0); }
if (!COMMANDS[cmd]) die(`unknown command "${cmd}"\n\n${HELP}`);
await COMMANDS[cmd](args);
