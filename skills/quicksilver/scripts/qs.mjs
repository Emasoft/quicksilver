#!/usr/bin/env node
// Quicksilver: hand Claude's bulk judgment calls to Jev (TypeSafe System One).
// Zero dependencies. Node 18+.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const VERSION = '0.3.0'; // keep equal to package.json (a test checks); written into errors.log
// The config home. Provider settings and keys are read only from here, never from the working directory.
const HOME = process.env.QUICKSILVER_HOME || path.join(os.homedir(), '.quicksilver');
const PROVIDERS_FILE = path.join(HOME, 'providers.json');
const LEGACY_CONFIG = path.join(HOME, 'config.json'); // no longer read: its presence stops every command
const STATS = path.join(HOME, 'stats.json');
const ERRORS_LOG = path.join(HOME, 'errors.log');
// Converts the token count of stats files written before jev_cost_usd existed.
const PRICE_PER_TOKEN = 0.042 / 1e6;

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit',
  'target', 'vendor', '__pycache__', '.venv', 'venv', 'coverage', '.turbo', '.cache', '.idea', '.vscode']);
// Matched against the input-relative path. Beyond dotenv files, keys and certs it covers direnv, git, docker,
// kube, postgres and htpasswd credentials, terraform vars/state, App Store .p8 and PuTTY keys, KeePass vaults,
// VPN profiles, GPG files and cloud service-account keys: all were sent before (audit M2).
const SECRET_RE = /(^|[/\\])(\.env(\..*)?|\.envrc|.*\.(pem|key|p12|pfx|keystore|jks|crt|cer|p8|ppk|kdbx|ovpn|gpg|tfvars|tfstate(\.backup)?)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.pgpass|\.htpasswd|\.dockercfg|kubeconfig|\.docker[/\\]config\.json|service-account[^/\\]*\.json|credentials(\.json)?|secrets?\.(json|ya?ml|toml))$/i;
// Per-input byte cap for files, stdin and --items: larger inputs are skipped (scanned files) or refused.
// User decision: no default limit, any size is read; --max-bytes / QUICKSILVER_MAX_BYTES is an opt-in lower
// cap. The fixed 100 MB ceiling only keeps one huge input from hanging the machine and cannot be raised.
const HARD_MAX_BYTES = 100 * 1024 * 1024;
let MAX_BYTES = HARD_MAX_BYTES; // set per command from --max-bytes / QUICKSILVER_MAX_BYTES
const fmtBytes = (n) => (n % 1048576 === 0 ? `${n / 1048576} MB` : `${n} bytes`);
// User decision: nothing sent to Jev is truncated. An item longer than one chunk is split into chunks that fit
// Jev's 32k-token context next to the question, state wrapper and schema: 60k chars is about 15-20k tokens, and
// the 90k ceiling stays under the context even at ~3 chars per token (dense code or JSON).
const CHUNK_CHARS_MAX = 90000;
const CHUNK_OVERLAP = 500; // repeated at each boundary, so a match that straddles it is whole in one chunk
let CHUNK_CHARS = 60000; // set per command from --chunk-chars / QUICKSILVER_CHUNK_CHARS
const LOCK_RE = /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|composer\.lock|\.min\.(js|css)|\.map)$/i;

// ---------- args ----------

function parseArgs(argv) {
  const pos = [], flags = {};
  const bools = new Set(['lines', 'json', 'all', 'remove', 'help', 'fast', 'verbose', 'no-collapse', 'no-secrets-guard', 'follow-symlinks']);
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
  width: [1, Infinity, true], 'chunk-chars': [1000, CHUNK_CHARS_MAX, true], 'pack-items': [1, Infinity, true], 'pack-tokens': [1, Infinity, true],
  'max-bytes': [1, HARD_MAX_BYTES, true],
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
// A numeric flag (already checked) beats its environment variable, which is validated here with the same bounds.
function flagOrEnv(flags, name, env, fallback) {
  if (flags[name] !== undefined) return flags[name];
  const v = process.env[env];
  if (v === undefined || v === '') return fallback;
  const [min, max] = NUM_FLAGS[name];
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) die(`${env} needs a whole number from ${min} to ${max}, got "${v}"`);
  return n;
}
// Malformed user JSON is a usage error (exit 1), not an "unexpected error" stack with exit 5 (audit m4).
const parseJson = (text, what) => { try { return JSON.parse(text); } catch (e) { return die(`${what} is not valid JSON: ${e.message}`); } };
const estTokens = (s) => Math.ceil(s.length / 4);
const rel = (p) => path.relative(process.cwd(), p).split(path.sep).join('/') || '.';
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
// A confidence can be null (the Vercel gateway may not report one): it prints as n/a instead of crashing.
const f2 = (x) => (typeof x === 'number' ? x.toFixed(2) : 'n/a');

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
function writeFileAtomic(file, text, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
}
const writeJson = (file, obj) => writeFileAtomic(file, `${JSON.stringify(obj, null, 2)}\n`);

// ---------- providers ----------

// Built-in providers, in the providers.json entry schema and validated like a user entry. Their order is the
// default fallback chain (user decision: openrouter first, typesafe second). compatible has no base_url until the
// user gives one, so it joins the chain only once configured. A key is only ever sent to the URL of the provider
// that owns it: each provider reads its own variables, and one $VAR may belong to one provider only.
const BUILTINS = [
  { name: 'openrouter', base_url: 'https://openrouter.ai/api', path: '/v1/systemone', adapter: 'system-one', api_key: '$OPENROUTER_API_KEY',
    model: '~typesafe/jev-latest', model_pattern: '/', cost_field: 'usage.cost', usd_per_mtok: 0.042, verify: '/v1/key', key_url: 'https://openrouter.ai/settings/keys' },
  { name: 'typesafe', base_url: 'https://api.typesafe.ai', path: '/v1/systemone', adapter: 'system-one', api_key: ['$JEV_API_KEY', '$TYPESAFE_API_KEY'],
    model: 'jev-latest', model_pattern: '^[^/]+$', cost_field: 'usage.cost', usd_per_mtok: 0.042, verify: '/v1/models', key_url: 'https://console.typesafe.ai' },
  { name: 'compatible', path: '/v1/systemone', adapter: 'system-one', api_key: '$JEV_GATEWAY_API_KEY', model: 'jev-latest', cost_field: 'usage.cost' },
  // Workers AI serves Jev only as the unpinned alias typesafe/jev; Cloudflare bills it in its own dashboard, so
  // the price is unknown here (usd_per_mtok null: the receipt says the cost is incomplete).
  { name: 'cloudflare', base_url: 'https://api.cloudflare.com/client/v4', path: '/accounts/{account_id}/ai/run', adapter: 'cloudflare-ai-run',
    api_key: ['$JEV_CLOUDFLARE_API_TOKEN', '$CLOUDFLARE_API_TOKEN'], account_id: '$CLOUDFLARE_ACCOUNT_ID', model: 'typesafe/jev', model_pattern: '^typesafe/',
    cost_field: null, usd_per_mtok: null, verify: '/user/tokens/verify', key_url: 'https://dash.cloudflare.com/profile/api-tokens' },
  // The gateway replaces any model outside typesafe-ai/ with typesafe-ai/jev, so the pattern keeps ids honest. It
  // has no free key check (verify null) and no published per-token price here.
  { name: 'vercel', base_url: 'https://ai-gateway.vercel.sh', path: '/v4/ai/evaluation-model', adapter: 'vercel-evaluation', api_key: '$AI_GATEWAY_API_KEY',
    model: 'typesafe-ai/jev', model_pattern: '^typesafe-ai/', cost_field: null, usd_per_mtok: null, verify: null },
];
const FIELDS = ['name', 'enabled', 'base_url', 'path', 'adapter', 'api_key', 'account_id', 'model', 'model_pattern', 'cost_field', 'usd_per_mtok', 'verify', 'headers', 'key_url'];
const REQUIRED = ['base_url', 'path', 'adapter', 'api_key', 'model']; // for a provider that is not built in
const NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;
const VAR_RE = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/;
const MODEL_RE = /^[A-Za-z0-9~][A-Za-z0-9._:/~-]{0,127}$/; // also keeps a model id safe inside a header
const FIELD_PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const HEADER_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const SECRET_HEADER_RE = /^(authorization|cookie|proxy-authorization|x-api-key)$|-(key|token)$/i;
// User decision: "enabled" accepts these words, case-insensitive; anything else is an error.
const TRUE_WORDS = new Set(['true', 'enabled', 'enable', '1', 'yes', 'y', 'active', 'on']);
const FALSE_WORDS = new Set(['false', 'disabled', 'disable', '0', 'no', 'n', 'inactive', 'off']);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
let ALL = [], CHAIN = [], PINNED = false, FLAGS = {}; // set per command by resolveProvider() and the command wrapper

// A key rides in the Authorization header, so plain http is allowed only to this machine (audit m2), and
// nothing in the URL may carry a credential or point a query somewhere else.
function checkUrl(v, where) {
  let u;
  try { u = new URL(v); } catch { return die(`${where} is not a valid URL`); }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) {
    die(`${where} must use https (plain http only for localhost, 127.0.0.1 or [::1]), got ${u.origin}`);
  }
  if (u.username || u.password || u.search || u.hash) die(`${where} must not hold a user name, password, query or fragment`);
}

// User decision: a credential is "$NAME" / "${NAME}" (read from the environment) or the literal value; an
// array lists fallbacks and the first one that is set wins. An unset variable is not an error: the provider is
// just not ready (and is skipped without a word unless it was pinned).
const credList = (v) => [].concat(v ?? []);
function checkCred(v, where) {
  const list = credList(v);
  if (!list.length || list.some((s) => typeof s !== 'string')) die(`${where} must be a string or a non-empty array of strings`);
  for (const s of list) if (s.startsWith('$') && !VAR_RE.test(s)) die(`${where}: a value starting with $ must be $NAME or \${NAME} (letters, digits, _)`);
}
function resolveCred(v) {
  const tried = [];
  for (const s of credList(v)) {
    const m = VAR_RE.exec(s);
    if (!m) { if (s) return { value: s, source: 'literal in providers.json' }; continue; }
    const name = m[1] || m[2];
    tried.push(`$${name}`);
    if (process.env[name]) return { value: process.env[name], source: `$${name}` };
  }
  return { value: '', tried };
}

function parseEnabled(v, where) {
  if (v === undefined || v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  const w = typeof v === 'string' ? v.trim().toLowerCase() : null;
  if (TRUE_WORDS.has(w)) return true;
  if (FALSE_WORDS.has(w)) return false;
  return die(`${where}: "enabled" must be true/false (or yes/no, on/off, 1/0, enabled/disabled, active/inactive), got ${JSON.stringify(v)}`);
}

// One merged entry (built-in fields overridden by the file's) -> the validated provider. Every problem exits 1
// naming the entry and the field: a malformed file never falls back to defaults.
function checkEntry(e, where) {
  for (const k of Object.keys(e)) if (!FIELDS.includes(k)) die(`${where}: unknown field "${k}"`);
  const bad = (k, want) => die(`${where}: "${k}" must ${want}`);
  for (const k of ['base_url', 'path', 'adapter', 'model', 'model_pattern', 'key_url']) if (e[k] !== undefined && typeof e[k] !== 'string') bad(k, 'be a string');
  for (const k of ['verify', 'cost_field']) if (e[k] != null && typeof e[k] !== 'string') bad(k, 'be a string or null');
  if (e.base_url !== undefined) checkUrl(e.base_url, `${where}: "base_url"`);
  if (e.key_url !== undefined) checkUrl(e.key_url, `${where}: "key_url"`);
  if (!e.path.startsWith('/') || /[?#]/.test(e.path)) bad('path', 'start with / and hold no ? or #');
  if (/\{(?!account_id\})/.test(e.path)) bad('path', 'hold no placeholder other than {account_id}');
  if (e.verify != null && (!e.verify.startsWith('/') || /[?#{]/.test(e.verify))) bad('verify', 'be a path starting with / (no ?, # or {), or null');
  if (!ADAPTERS[e.adapter]) bad('adapter', `be one of ${Object.keys(ADAPTERS).join(', ')}`);
  checkCred(e.api_key, `${where}: "api_key"`);
  if (e.path.includes('{account_id}')) checkCred(e.account_id, `${where}: "account_id"`);
  else if (e.account_id !== undefined) bad('account_id', 'be used only with a path holding {account_id}');
  let modelRe = /(?:)/;
  if (e.model_pattern !== undefined) { try { modelRe = new RegExp(e.model_pattern); } catch { bad('model_pattern', 'be a valid regular expression'); } }
  if (!MODEL_RE.test(e.model)) bad('model', `be a model id (${MODEL_RE.source})`);
  if (!modelRe.test(e.model)) die(`${where}: "model" "${e.model}" does not match its "model_pattern" ${e.model_pattern}`);
  if (e.cost_field != null && !FIELD_PATH_RE.test(e.cost_field)) bad('cost_field', 'be a dotted field path like usage.cost, or null');
  if (e.usd_per_mtok != null && !(typeof e.usd_per_mtok === 'number' && Number.isFinite(e.usd_per_mtok) && e.usd_per_mtok >= 0)) bad('usd_per_mtok', 'be a number >= 0, or null');
  const headers = e.headers ?? {};
  if (!isObj(headers)) bad('headers', 'be an object of name: value strings');
  for (const [h, v] of Object.entries(headers)) {
    if (!HEADER_RE.test(h) || typeof v !== 'string' || /[\r\n]/.test(v)) bad('headers', 'be an object of name: value strings');
    if (SECRET_HEADER_RE.test(h)) die(`${where}: header "${h}" looks like a credential; credentials go in "api_key" only`);
  }
  return { ...e, enabled: parseEnabled(e.enabled, where), headers, modelRe };
}

// Never echo the parser's message: newer V8 messages quote the input around the error, and the file may hold a
// literal key. Only the position is reported, as line and column.
function parseConfigJson(raw, file) {
  try { return JSON.parse(raw); } catch (e) {
    const lc = /line (\d+) column (\d+)/.exec(e.message), pos = /position (\d+)/.exec(e.message);
    let at = '';
    if (lc) at = ` at line ${lc[1]}, column ${lc[2]}`;
    else if (pos) { const before = raw.slice(0, Number(pos[1])); at = ` at line ${before.split('\n').length}, column ${before.length - before.lastIndexOf('\n')}`; }
    return die(`${file} is not valid JSON${at}`);
  }
}

// The user decided config.json is folded into providers.json and not converted silently: name what it holds
// (never a key value) and where each piece goes, then stop.
function checkLegacyConfig() {
  let raw;
  try { raw = fs.readFileSync(LEGACY_CONFIG, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  let cfg = {};
  try { cfg = JSON.parse(raw); } catch { /* unreadable: it still has to go, and the message below says so */ }
  const owner = cfg.provider || 'typesafe';
  const keyed = Object.keys({ ...(isObj(cfg.keys) ? cfg.keys : {}), ...(cfg.api_key ? { [owner]: 1 } : {}) });
  const moves = [
    ...(keyed.length ? [`the saved key of ${keyed.join(' and ')} -> "api_key" on that provider's entry`] : []),
    ...(cfg.model ? [`model "${cfg.model}" -> "model" on the ${owner} entry`] : []),
    ...(cfg.provider ? [`default provider ${cfg.provider} -> put its entry first in "providers"`] : []),
  ];
  die(`${LEGACY_CONFIG} is no longer read; settings and keys now live in ${PROVIDERS_FILE}.\n`
    + `  Move: ${moves.join('; ') || 'nothing (it holds no settings)'}.\n`
    + `  Example: {"version": 1, "providers": [{"name": "${owner}", "api_key": "<your key>"}]} (then chmod 600 it).\n`
    + '  Then delete config.json. (Or delete it now and run setup again.)');
}

// The file as written (for setup) or null. Reading it checks the location rules and the JSON, not the schema.
function readProvidersFile() {
  if (!path.isAbsolute(HOME)) die(`QUICKSILVER_HOME must be an absolute path, got "${HOME}"`);
  // Removed in favour of the typesafe entry's base_url. Ignoring it would send requests to api.typesafe.ai
  // instead of the proxy the user set, so it is refused.
  if (process.env.QUICKSILVER_API_BASE !== undefined) die(`QUICKSILVER_API_BASE was removed: set "base_url" on the typesafe entry in ${PROVIDERS_FILE} instead`);
  checkLegacyConfig();
  let raw;
  try { raw = fs.readFileSync(PROVIDERS_FILE, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  return parseConfigJson(raw, PROVIDERS_FILE);
}

// doc -> the merged chain: the file's entries in file order, then each built-in the file does not name. A built-in
// named in the file is overridden field by field; any other name is a new provider and must be complete.
function buildProviders(doc) {
  const where = PROVIDERS_FILE;
  if (!isObj(doc)) die(`${where} must hold a JSON object`);
  for (const k of Object.keys(doc)) if (!['version', 'providers'].includes(k)) die(`${where}: unknown field "${k}"`);
  if (doc.version !== 1) die(`${where}: "version" must be 1`);
  if (!Array.isArray(doc.providers)) die(`${where}: "providers" must be an array`);
  const builtin = new Map(BUILTINS.map((b) => [b.name, b]));
  const seen = new Set(), out = [];
  for (const [i, e] of doc.providers.entries()) {
    const at = `${where} providers[${i}]`;
    if (!isObj(e)) die(`${at} must be an object`);
    if (typeof e.name !== 'string' || !NAME_RE.test(e.name)) die(`${at}: "name" must be ${NAME_RE.source}`);
    if (seen.has(e.name)) die(`${at}: duplicate name "${e.name}"`);
    seen.add(e.name);
    const base = builtin.get(e.name);
    if (!base) for (const f of REQUIRED) if (e[f] === undefined) die(`${at} ("${e.name}"): "${f}" is required for a provider that is not built in`);
    out.push(checkEntry({ ...base, ...e }, `${at} ("${e.name}")`));
  }
  for (const b of BUILTINS) if (!seen.has(b.name)) out.push(checkEntry({ ...b }, `built-in provider "${b.name}"`));
  // One $VAR, one provider: otherwise a key exported for one service would be sent to another one's URL.
  const owner = new Map();
  for (const p of out.filter((x) => x.enabled)) {
    for (const s of [...credList(p.api_key), ...credList(p.account_id)]) {
      const m = VAR_RE.exec(s);
      if (!m) continue;
      const v = `$${m[1] || m[2]}`;
      if (owner.has(v) && owner.get(v) !== p.name) die(`${where}: ${v} is used by both "${owner.get(v)}" and "${p.name}"; a key may belong to one provider only (rename one, or disable one)`);
      owner.set(v, p.name);
    }
  }
  return out;
}

// A provider with everything resolved: url, key and state (ready | disabled | no-url | no-key | no-account).
function prepare(p) {
  const key = resolveCred(p.api_key);
  const acct = p.path.includes('{account_id}') ? resolveCred(p.account_id) : null;
  if (acct?.value && !/^[A-Za-z0-9]{1,64}$/.test(acct.value)) die(`provider "${p.name}": the account id from ${acct.source} must be 1-64 letters or digits`);
  const state = !p.enabled ? 'disabled' : !p.base_url ? 'no-url' : !key.value ? 'no-key' : acct && !acct.value ? 'no-account' : 'ready';
  const base = (p.base_url || '').replace(/\/$/, '');
  return { ...p, key: key.value, keySource: key.source, tried: key.tried, acctTried: acct?.tried, state, base, url: base + p.path.replace('{account_id}', acct?.value ?? '') };
}

function resolveProvider(flags) {
  // `--provider=` (empty) must not fall through to the default chain silently.
  if (flags.provider === true || flags.provider === '') die('--provider needs a value');
  for (const [src, m] of [['--model', flags.model], ['QUICKSILVER_MODEL', process.env.QUICKSILVER_MODEL]]) {
    if (m !== undefined && m !== '' && (typeof m !== 'string' || !MODEL_RE.test(m))) die(`${src} must be a model id (${MODEL_RE.source})`);
  }
  const doc = readProvidersFile();
  ALL = buildProviders(doc ?? { version: 1, providers: [] }).map(prepare);
  if (doc) checkFileMode(doc);
  const pin = flags.provider || process.env.QUICKSILVER_PROVIDER;
  PINNED = Boolean(pin);
  if (!pin) { CHAIN = ALL.filter((p) => p.state === 'ready'); return; }
  const p = ALL.find((x) => x.name === pin);
  if (!p) die(`unknown provider "${pin}" (configured: ${ALL.map((x) => x.name).join(', ')})`);
  if (!p.enabled) die(`provider "${pin}" is disabled ("enabled" in ${PROVIDERS_FILE}); enable it or pick another provider`);
  CHAIN = [p];
}

// A literal key in a file others can read is refused (not silently chmod-ed: the file is the user's).
function checkFileMode(doc) {
  const literal = doc.providers.some((e) => credList(e.api_key).some((s) => s && !s.startsWith('$')));
  if (!literal || process.platform === 'win32') return;
  const st = fs.statSync(PROVIDERS_FILE);
  if ((st.mode & 0o077) || st.uid !== process.getuid()) die(`${PROVIDERS_FILE} holds a literal api_key but other users can read it (or it is not yours); run: chmod 600 ${PROVIDERS_FILE}`);
}

// Which provider a command that needs a key uses when it is pinned or the chain has one (exit 3 otherwise:
// a key problem the user fixes, as the SKILL.md exit-code contract says).
function requireReady() {
  if (PINNED) {
    const p = CHAIN[0];
    if (p.state === 'no-url') die(`provider "${p.name}" has no "base_url"; set it in ${PROVIDERS_FILE}`);
    if (p.state === 'no-key') die(`no ${p.name} API key: ${p.tried.join(', ') || 'no api_key'} ${p.tried.length > 1 ? 'are' : 'is'} unset or empty${p.key_url ? `. Get one at ${p.key_url}` : ''}, then export it or run: node qs.mjs setup --provider ${p.name}`, 3);
    if (p.state === 'no-account') die(`no ${p.name} account id: ${p.acctTried.join(', ')} unset or empty`, 3);
    return;
  }
  if (CHAIN.length) return;
  const wants = ALL.filter((p) => p.enabled && p.base_url).map((p) => `${p.name} (${(p.state === 'no-account' ? p.acctTried : p.tried).join(' or ')})`);
  die(`no provider is ready: export a key for one of ${wants.join(', ')}, or run: node qs.mjs setup --provider NAME`, 3);
}

// A model id belongs to one provider (OpenRouter ids are "vendor/model", TypeSafe ids have no "/"). --model,
// QUICKSILVER_MODEL or an ask spec's model is used for a provider only when it matches its model_pattern, so a
// chain of different providers can share one run; otherwise that provider's own model is used, with a warning.
const warned = new Set();
function modelFor(p, specModel) {
  for (const [src, m] of [['the ask spec\'s model', specModel], ['--model', FLAGS.model], ['QUICKSILVER_MODEL', process.env.QUICKSILVER_MODEL]]) {
    if (!m) continue;
    if (p.modelRe.test(m)) return m;
    if (!warned.has(src + p.name)) { warned.add(src + p.name); process.stderr.write(`quicksilver: warning: ignoring ${src} "${m}" for ${p.name}: not a ${p.name} model id\n`); }
  }
  return p.model;
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Upstream text echoed in a message never carries the key that was sent.
const redact = (s, p) => (p.key ? String(s).split(p.key).join('***') : String(s));
const getPath = (o, dotted) => dotted.split('.').reduce((v, k) => (isObj(v) ? v[k] : undefined), o);

// The request and response shape of each adapter kind. Only these exist: a JSON file cannot describe an envelope
// rewrite safely, so providers.json can name an adapter but never define one.
const ADAPTERS = {
  'system-one': {
    encode: (model, state, questions) => ({ body: { model, state, questions } }),
    decode: (j) => j,
  },
  // Cloudflare Workers AI (jev-agent-tools transports/cloudflare.ts): the System One request goes inside "input",
  // and the reply is the v4 envelope, nested twice (result.result). success:false, or a run state other than
  // Completed, is an unusable reply even with HTTP 200.
  'cloudflare-ai-run': {
    encode: (model, state, questions) => ({ body: { model, input: { state, questions } } }),
    decode: (j) => {
      if (!isObj(j) || j.success === false) throw new Error('Cloudflare reported success: false');
      const outer = j.result;
      if (typeof outer?.state === 'string' && outer.state !== 'Completed') throw new Error(`Cloudflare run state is ${JSON.stringify(clip(outer.state, 40))}, not "Completed"`);
      return outer?.result ?? outer;
    },
  },
  // Vercel AI Gateway evaluation model (jev-agent-tools transports/vercel.ts): the model rides in the ai-model-id
  // header, not the body; noul questions are called "boolean" and only type, instructions and criteria are sent.
  // A boolean answer comes back as a probability; a choice or score confidence lives in providerMetadata and may
  // be missing (null); usage is camelCase.
  'vercel-evaluation': {
    encode: (model, state, questions) => ({
      body: { state, questions: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, { type: q.type === 'noul' ? 'boolean' : q.type, instructions: q.instructions, criteria: q.criteria }])) },
      headers: { 'ai-model-id': model, 'ai-gateway-protocol-version': '0.0.1', 'ai-gateway-auth-method': 'api-key', 'ai-evaluation-model-specification-version': '4' },
    }),
    decode: (j) => {
      const conf = j?.providerMetadata?.typesafe?.confidence ?? {};
      const adapt = (id, a) => (a?.type === 'boolean' ? { type: 'noul', noul: a.probability }
        : a?.type === 'choice' || a?.type === 'score' ? { ...a, confidence: typeof conf[id] === 'number' ? conf[id] : null } : a);
      const answers = isObj(j?.answers) ? Object.fromEntries(Object.entries(j.answers).map(([id, a]) => [id, adapt(id, a)])) : j?.answers;
      return { ...j, answers, usage: { input_tokens: j?.usage?.inputTokens } };
    },
  },
};

// Totals of the whole run, across providers, for the footer and stats.json.
const RUN = { requests: 0, jevTokens: 0, cost: 0, costUnknown: false, used: {}, fallbacks: {}, lastError: null };
const DEAD = new Set(); // providers that failed in this run: skipped by every later request
const REASONS = { 'key-rejected': 'key rejected', 'no-credits': 'out of credits', 'model-unavailable': 'model unavailable',
  'rate-limited': 'rate limited', 'server-error': 'server error', network: 'network error', 'bad-response': 'unusable reply' };

// One judgment request through the chain. Returns { answers, usage: { input_tokens }, model }.
// User decision: the providers array is the fallback order "in case of errors, exhausted credits, or missing env
// var". A key, credit, model, rate-limit, server or network failure moves this request to the next provider and
// takes the failed one out for the rest of the run. A request-shape error (400/422) would fail on every provider,
// so it stops the run instead. A pinned chain has one provider, so nothing falls back.
async function jev(state, questions, specModel) {
  requireReady();
  for (const [i, p] of CHAIN.entries()) {
    if (DEAD.has(p.name)) continue;
    const model = modelFor(p, specModel);
    let r;
    try { r = await callProvider(p, model, state, questions); } catch (e) {
      if (!e.kind) throw e;
      const stop = e.kind === 'request-rejected';
      const next = stop ? null : CHAIN.slice(i + 1).find((x) => !DEAD.has(x.name));
      logError(p, model, e, stop ? 'no' : next?.name ?? 'none-left');
      if (stop) die(e.message, e.exit);
      DEAD.add(p.name);
      RUN.lastError = e;
      if (next) {
        const k = `${p.name} → ${next.name} (${REASONS[e.kind]}${e.status ? `, HTTP ${e.status}` : ''})`;
        RUN.fallbacks[k] = (RUN.fallbacks[k] || 0) + 1;
      }
      continue;
    }
    RUN.requests += 1;
    RUN.jevTokens += r.usage.input_tokens;
    if (r.cost == null) RUN.costUnknown = true;
    else RUN.cost += r.cost;
    const used = `${p.name} (${r.model || model})`;
    RUN.used[used] = (RUN.used[used] || 0) + 1;
    return r;
  }
  const e = RUN.lastError;
  return die(CHAIN.length > 1 ? `every provider failed; the last one: ${withHint(e)} (all of them in ${ERRORS_LOG})` : withHint(e), e.exit);
}

// ISO 8601 local time with its offset, e.g. 2026-10-02T08:30:00+02:00 (Date.parse reads it back).
function isoNow(d = new Date()) {
  const off = -d.getTimezoneOffset(), pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  return `${new Date(d.getTime() + off * 60000).toISOString().slice(0, 19)}${off < 0 ? '-' : '+'}${pad(off / 60)}:${pad(off % 60)}`;
}

// User decision: every provider error goes to errors.log, which is "truncated at 72 hours". A provider skipped
// for an unset variable is not an error and never reaches here. The message is our own text plus a redacted
// snippet, so no key is written. Entries older than 72 hours are dropped on every write, and the file is
// rewritten whole (temp + rename, 0600). ponytail: two quicksilver processes logging at the same instant can
// drop one line (last rename wins); a lock file is the upgrade if that ever matters. A failed write must not
// end the run: it is reported once on stderr.
let logWarned = false;
function logError(p, model, e, fallback) {
  const line = `${isoNow()} quicksilver/${VERSION} provider=${p.name} model=${model} kind=${e.kind} status=${e.status || '-'} fallback=${fallback} msg=${JSON.stringify(redact(e.message, p))}${e.hint ? ` hint=${JSON.stringify(e.hint)}` : ''}\n`;
  try {
    const cutoff = Date.now() - 72 * 3600e3;
    let old = '';
    try { old = fs.readFileSync(ERRORS_LOG, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    const kept = old.split('\n').filter((l) => Date.parse(l.slice(0, l.indexOf(' '))) >= cutoff);
    writeFileAtomic(ERRORS_LOG, kept.map((l) => `${l}\n`).join('') + line);
  } catch (err) {
    if (!logWarned) process.stderr.write(`quicksilver: warning: could not write ${ERRORS_LOG}: ${err.message}\n`);
    logWarned = true;
  }
}

// A provider failure: kind and HTTP status for the log, the exit code if it ends the run. The message is one
// complete sentence; what the user should do goes in `hint`, its own field in errors.log. Gluing the two into
// one string produced "X rejected the API key (401) and run: ..." when the provider had no key_url.
const fail = (kind, status, message, exit, hint) => Object.assign(new Error(message), { kind, status, exit, hint });
const withHint = (e) => (e.hint ? `${e.message}. ${e.hint}` : e.message);
const outOfCredits = (p, s) => `${p.name}: out of credits (${s})${p.key_url ? `. Top up at ${p.key_url.replace(/\/keys$/, '/credits')}` : ''}`;

async function callProvider(p, model, state, questions, { retries = 5 } = {}) {
  const adapter = ADAPTERS[p.adapter];
  const { body, headers } = adapter.encode(model, state, questions);
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res, text;
    try {
      // redirect: 'error' -- a 3xx must never carry the Authorization header to another host.
      res = await fetch(p.url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000), body: JSON.stringify(body),
        headers: { ...p.headers, Authorization: `Bearer ${p.key}`, 'Content-Type': 'application/json', ...headers },
      });
      text = await res.text();
    } catch (e) {
      last = fail('network', 0, `${p.name} request failed: network error: ${redact(e.cause?.message || e.message, p)}`, 5);
      await sleep(500 * 2 ** attempt);
      continue;
    }
    const s = res.status;
    if (res.ok) return decodeReply(p, adapter, text, questions);
    // exit 3 = account/key problem the user must fix (SKILL.md contract)
    if (s === 402 || /insufficient (credits|balance|funds)/i.test(text)) throw fail('no-credits', s, outOfCredits(p, s), 3);
    if (s === 401 || s === 403) throw fail('key-rejected', s, `${p.name} rejected the API key (${s})`, 3, `${p.key_url ? `Get a new one at ${p.key_url}, then run` : 'Run'}: node qs.mjs setup --provider ${p.name}`);
    // ponytail: providers word "no such model" differently; a 400/422 naming the model as not found or
    // unavailable is read as model-unavailable (falls back) rather than a bad request. Extend the words as seen.
    if (s === 404 || ((s === 400 || s === 422) && /model/i.test(text) && /not found|not available|unavailable|unknown|not supported|not a valid|no endpoints|does not exist/i.test(text))) {
      throw fail('model-unavailable', s, `${p.name} cannot serve model "${model}" (${s}): ${redact(clip(text, 300), p)}`, 4);
    }
    if (s === 400 || s === 422) throw fail('request-rejected', s, `${p.name} rejected the request (${s}): ${redact(clip(text, 800), p)}`, 4);
    if (!(s === 408 || s === 409 || s === 429 || s >= 500)) throw fail('request-rejected', s, `${p.name} rejected the request (${s}): ${redact(clip(text, 300), p)}`, 4);
    last = fail(s === 429 ? 'rate-limited' : 'server-error', s, `${p.name} request failed: HTTP ${s}: ${redact(clip(text, 300), p)}`, 5);
    const ra = Number(res.headers.get('retry-after'));
    await sleep(ra > 0 ? ra * 1000 : 500 * 2 ** attempt + Math.random() * 250);
  }
  throw last;
}

// Adapter-decoded reply -> { answers, usage, model, cost }, refusing a reply the commands could not use.
function decodeReply(p, adapter, text, questions) {
  let payload;
  try { payload = adapter.decode(JSON.parse(text)); } catch (e) {
    throw fail('bad-response', 200, `${p.name} sent an unusable reply: ${e instanceof SyntaxError ? 'not JSON' : redact(e.message, p)}`, 5);
  }
  const answers = payload?.answers;
  if (!isObj(answers) || Object.keys(questions).some((id) => !isObj(answers[id]))) throw fail('bad-response', 200, `${p.name} sent a reply without an answer for every question`, 5);
  const input = Number(payload.usage?.input_tokens) || 0;
  const reported = p.cost_field ? getPath(payload, p.cost_field) : undefined;
  const cost = typeof reported === 'number' ? reported : p.usd_per_mtok != null ? (input * p.usd_per_mtok) / 1e6 : null;
  return { answers, usage: { input_tokens: input }, model: typeof payload.model === 'string' ? payload.model : undefined, cost };
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
    // The scanned directory's own .git/config is untrusted input (e.g. an unpacked archive): core.fsmonitor
    // there names a program that `git ls-files` would run. Pin it off.
    const out = execFileSync('git', ['-c', 'core.fsmonitor=false', 'ls-files', '-co', '--exclude-standard', '-z', '--', '.'], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024,
    });
    return out.split('\0').filter(Boolean).map((f) => path.join(dir, f));
  } catch { return null; }
}

function walk(dir, acc = [], follow = false, visited = new Set()) {
  if (follow) {
    // A followed link can point back up the tree: walk each real directory once, so loops terminate.
    const real = fs.realpathSync(dir);
    if (visited.has(real)) return acc;
    visited.add(real);
  }
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    let st = e; // without follow a link is neither file nor directory, so it is never read
    if (follow && e.isSymbolicLink()) { try { st = fs.statSync(p); } catch { acc.push(p); continue; } } // broken: collect() reports it
    if (st.isDirectory()) { if (!IGNORE_DIRS.has(e.name) && !e.name.startsWith('.')) walk(p, acc, follow, visited); }
    else if (st.isFile()) acc.push(p);
  }
  return acc;
}

// One path from a glob, a git listing or the command line, to the files it stands for. By default a symlink is
// returned as-is (lstat, not stat) so collect() reports it instead of reading it: stat would read the target,
// e.g. notes.txt -> ~/.aws/credentials from inside the repo (audit M1). With --follow-symlinks a link to a
// file is kept and a link to a directory is walked (outside git, so without .gitignore).
function entries(f, follow) {
  let st;
  try { st = fs.lstatSync(f); } catch { return []; }
  if (st.isFile()) return [f];
  if (!st.isSymbolicLink()) return [];
  if (!follow) return [f];
  try { st = fs.statSync(f); } catch { return [f]; } // broken link: collect() reports it
  return st.isDirectory() ? walk(f, [], true) : st.isFile() ? [f] : [];
}

function expand(spec, follow) {
  if (/[*?[\]{}]/.test(spec)) {
    if (!fs.globSync) die('glob patterns need Node 22+; pass a directory instead');
    return fs.globSync(spec, { exclude: (p) => IGNORE_DIRS.has(path.basename(p)) }).flatMap((f) => entries(f, follow));
  }
  if (!fs.existsSync(spec)) die(`no such file or directory: ${spec}`);
  if (!fs.lstatSync(spec).isDirectory()) return entries(spec, follow);
  // Walk only outside git (null). An empty list means "inside git, everything ignored": walking it
  // would send exactly the gitignored files .gitignore is documented to keep out (audit m1).
  return (gitFiles(spec) ?? walk(spec, [], follow)).flatMap((f) => entries(f, follow));
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
    if (total > MAX_BYTES) die(`stdin is over ${fmtBytes(MAX_BYTES)}; pass files instead, or split the input`);
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
  if (fs.statSync(file).size > MAX_BYTES) die(`${file} is over ${fmtBytes(MAX_BYTES)}; split it`);
  return fs.readFileSync(file, 'utf8');
}

// Returns [{id, text}] plus a list of skipped paths. Texts are whole: runPerItem chunks the long ones.
function collect(pos, flags) {
  const exts = flags.ext ? String(flags.ext).split(',').map((e) => '.' + e.replace(/^\./, '').toLowerCase()) : null;
  const items = [], skipped = [];
  const limit = num(flags.limit, 5000);
  const push = (id, text) => {
    // Checked per item, so a run over --limit stops before reading the rest of the input (audit m5).
    if (items.length >= limit) die(`more than ${limit} items (--limit ${limit}). Narrow the input or raise --limit.`);
    items.push({ id, text });
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

  const follow = Boolean(flags['follow-symlinks']) || process.env.QUICKSILVER_FOLLOW_SYMLINKS === '1';
  const files = [];
  for (const spec of pos) {
    if (spec === '-') { const t = readStdin(); flags.lines ? pushLines('stdin', t) : push('stdin', t); continue; }
    files.push(...expand(spec, follow));
  }
  const seen = new Set();
  for (const f of files) {
    const abs = path.resolve(f);
    const r = rel(abs);
    if (exts && !exts.includes(path.extname(f).toLowerCase())) continue;
    let real = abs;
    if (follow) {
      // Followed: dedupe by target, and the secret guard below also checks the target's own path,
      // since a link named notes.txt can point at ~/.ssh/id_rsa.
      try { real = fs.realpathSync(abs); } catch { skipped.push(`${r} (broken symlink)`); continue; }
    } else if (fs.lstatSync(abs).isSymbolicLink()) {
      // Not followed, wherever it came from (git listing, glob, explicit path): the target can sit outside
      // the input tree, and SECRET_RE would only see the link's own name.
      skipped.push(`${r} (symlink, never followed)`);
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    if (!flags['no-secrets-guard'] && (SECRET_RE.test(r) || (real !== abs && SECRET_RE.test(real)))) { skipped.push(`${r} (secret-like, never sent)`); continue; }
    if (LOCK_RE.test(r)) continue;
    const text = readText(abs, MAX_BYTES);
    if (text === null) { skipped.push(`${r} (binary or over ${fmtBytes(MAX_BYTES)})`); continue; }
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

const countNl = (s, from, to) => { let n = 0; for (let i = s.indexOf('\n', from); i !== -1 && i < to; i = s.indexOf('\n', i + 1)) n++; return n; };

// Splits text into pieces of at most CHUNK_CHARS chars, each cut after a newline when one lies past the overlap
// (only a single over-long line is split mid-line). Every piece after the first restarts CHUNK_OVERLAP chars
// before the previous end, at a line start when possible. from/to are the 1-based lines a piece covers.
function chunkText(text) {
  const out = [];
  let start = 0, line = 1;
  for (;;) {
    let end = Math.min(start + CHUNK_CHARS, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end - 1);
      if (nl >= start + CHUNK_OVERLAP) end = nl + 1;
    }
    out.push({ text: text.slice(start, end), from: line, to: line + countNl(text, start, end - 1) });
    if (end >= text.length) return out;
    let next = end - CHUNK_OVERLAP; // end - start > CHUNK_OVERLAP, so every step moves forward
    const nl = text.indexOf('\n', next);
    if (nl !== -1 && nl < end - 1) next = nl + 1;
    line += countNl(text, start, next);
    start = next;
  }
}

// User decision: the highest-scoring chunk decides a per-item judgement, never an average ("it should consider
// the higest scored chunk to decide if the file passes or not or to give a rating"): yes/no by the highest
// probability, a score by the highest score, a label by the most confident chunk. Ties go to the earliest chunk
// (strict >). The deciding chunk is reported as best_chunk and, for text, best_lines.
function mergeChunks(parts) {
  if (parts.length === 1) return parts[0].answer;
  const key = { noul: 'noul', score: 'score' }[parts[0].answer.type] ?? 'confidence';
  const val = (p) => p.answer[key] ?? -Infinity; // a null confidence never beats a real one
  const best = parts.reduce((x, y) => (val(y) > val(x) ? y : x));
  return { ...best.answer, best_chunk: parts.indexOf(best) + 1, ...(best.from ? { best_lines: [best.from, best.to] } : {}) };
}

// Run one question per item, or per chunk of a long item, then merge the chunk answers back into one row per
// item. makeQ(ref, packed) builds the question; ref is how the unit is addressed in state.
async function runPerItem(items, flags, makeQ) {
  const units = items.flatMap((item) => {
    const cs = chunkText(item.text);
    item.chunks = cs.length;
    return cs.map((c) => ({ item, ...c, source: cs.length > 1 ? `${item.id} (lines ${c.from}-${c.to})` : item.id }));
  });
  const groups = batches(units, flags);
  const answered = await pool(groups.map((g) => async () => {
    const packed = g.length > 1;
    const state = packed
      ? { items: Object.fromEntries(g.map((u, j) => [`i${j}`, { source: u.source, content: u.text }])) }
      : { source: g[0].source, content: g[0].text };
    const questions = Object.fromEntries(g.map((_, j) => [`q${j}`, makeQ(packed ? `\`items.i${j}\`` : '`content`', packed)]));
    const res = await jev(state, questions);
    return g.map((u, j) => ({ u, answer: res.answers[`q${j}`] }));
  }), num(flags.concurrency, 16));
  const parts = new Map(); // item -> its chunk answers, in chunk order (pool keeps the order of groups)
  for (const { u, answer } of answered.flat()) {
    if (!parts.has(u.item)) parts.set(u.item, []);
    parts.get(u.item).push({ answer, from: u.from, to: u.to });
  }
  return [...parts].map(([item, ps]) => ({ item, answer: mergeChunks(ps) }));
}

// ---------- output ----------

function footer(t0, items, extra, outText, skipped) {
  const contentTok = items.reduce((a, it) => a + estTokens(it.text), 0);
  const saved = contentTok - estTokens(outText);
  const parts = [`${items.length} scanned`, ...extra, `${((Date.now() - t0) / 1000).toFixed(1)}s`,
    `jev ${fmtK(RUN.jevTokens)} tok ($${RUN.cost.toFixed(4)}${RUN.costUnknown ? ' + n/a' : ''})`,
    ...(Object.keys(RUN.used).length ? [`via ${Object.entries(RUN.used).map(([k, n]) => (Object.keys(RUN.used).length > 1 ? `${k} ×${n}` : k)).join(', ')}`] : []),
    `~${fmtK(Math.max(0, saved))} Claude tokens not read`];
  let s = `— ${parts.join(' · ')}`;
  const fb = Object.entries(RUN.fallbacks);
  if (fb.length) s += `\n— fell back ${fb.reduce((a, [, n]) => a + n, 0)}×: ${fb.map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join('; ')} (see ${ERRORS_LOG})`;
  if (skipped.length) s += `\n— skipped ${skipped.length}: ${clip(skipped.join(', '), 400)}`;
  recordStats({ requests: RUN.requests, items: items.length, jevTokens: RUN.jevTokens, cost: RUN.cost, saved });
  return s;
}

const fmtK = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));

function emit(flags, jsonObj, lines, foot) {
  if (flags.json) { process.stdout.write(JSON.stringify(jsonObj, null, 2) + '\n'); process.stderr.write(foot + '\n'); return; }
  const body = lines.join('\n');
  process.stdout.write((body ? body + '\n' : '') + foot + '\n');
}

// A chunked item names how many chunks it had and which lines decided its verdict (see mergeChunks).
const chunkNote = (r) => (r.item.chunks > 1 ? ` (${r.item.chunks} chunks, best lines ${r.answer.best_lines.join('-')})` : '');
const chunkJson = (r) => ({ chunks: r.item.chunks, ...(r.answer.best_lines ? { best_lines: r.answer.best_lines } : {}) });

function label(r, flags) {
  const it = r.item;
  return flags.lines || flags.items ? `${it.id}${chunkNote(r)}  ${clip(it.text.trim().replace(/\s+/g, ' '), num(flags.width, 160))}` : `${it.id}${chunkNote(r)}`;
}

// When every input was skipped, say which and why (the same list the footer prints), not just "pass files".
function requireInputs(items, cmd, skipped) {
  if (items.length) return;
  if (skipped.length) die(`nothing to ${cmd}: ${skipped.length} input${skipped.length > 1 ? 's' : ''} skipped (${clip(skipped.join(', '), 400)})`);
  die(`nothing to ${cmd}: pass files, directories, globs, --items FILE, or - for stdin`);
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
  if (!flags.lines || flags['no-collapse']) return rs.map((r) => `${f2(score(r))}  ${label(r, flags)}`);
  const groups = new Map();
  for (const r of rs) {
    const k = template(r.item.text);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups.values()].map((g) => {
    if (g.length === 1) return `${f2(score(g[0]))}  ${label(g[0], flags)}`;
    const rest = g.slice(1).map((r) => Number(r.item.id.split(':').pop())).sort((a, b) => a - b);
    return `${f2(score(g[0]))}  ×${g.length}  ${label(g[0], flags)}\n        also lines ${ranges(rest, 300)}`;
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
  requireInputs(items, 'filter', skipped);
  const thr = num(flags.threshold, 0.5), band = num(flags.band, 0.15);
  const rows = await runPerItem(items, flags, (ref, packed) => ({
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
  const saved = save(flags, rows.map((r) => ({ id: r.item.id, p: p(r), ...chunkJson(r) })));
  const foot = footer(t0, items, [`${hits.length} matched`, `${unsure.length} borderline`], lines.join('\n'), skipped) + saved;
  emit(flags, { matched: hits.map((r) => ({ id: r.item.id, p: p(r), ...chunkJson(r) })), borderline: unsure.map((r) => ({ id: r.item.id, p: p(r), ...chunkJson(r) })) }, lines, foot);
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
  requireInputs(items, 'classify', skipped);
  const minConf = num(flags['min-confidence'], 0.6);
  const rows = await runPerItem(items, flags, (ref, packed) => ({
    type: 'choice',
    instructions: packed ? { question, answer_about: `Answer only about ${ref}; ignore the other items.` } : question,
    criteria,
  }));
  const groups = {};
  for (const r of rows) {
    groups[r.answer.choice] ??= [];
    groups[r.answer.choice].push(r);
  }
  const only = flags.only ? new Set(String(flags.only).split(',')) : null;
  // A null confidence is unknown, so it is listed for review with the low ones (null >= x is false).
  const isLow = (r) => !(r.answer.confidence >= minConf);
  const low = rows.filter(isLow);
  const lines = [Object.keys(criteria).map((k) => `${k} ${groups[k]?.length || 0}`).join(' · ')];
  for (const k of Object.keys(criteria)) {
    if (!groups[k] || (only && !only.has(k))) continue;
    const g = groups[k].sort((a, b) => (b.answer.confidence ?? -1) - (a.answer.confidence ?? -1));
    if (flags.verbose) {
      lines.push(`[${k}]`);
      for (const r of g) lines.push(`${isLow(r) ? '?' : ' '}${f2(r.answer.confidence)}  ${label(r, flags)}`);
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
  const saved = save(flags, rows.map((r) => ({ id: r.item.id, label: r.answer.choice, confidence: r.answer.confidence, ...chunkJson(r) })));
  const foot = footer(t0, items, [`${low.length} low-confidence (?)`], lines.join('\n'), skipped) + saved;
  emit(flags, rows.map((r) => ({ id: r.item.id, label: r.answer.choice, confidence: r.answer.confidence, probabilities: r.answer.probabilities, ...chunkJson(r) })), lines, foot);
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
  requireInputs(items, 'rank', skipped);
  const rows = await runPerItem(items, flags, (ref, packed) => ({
    type: 'score',
    instructions: { query, question: `How relevant is ${ref} to \`query\`?${packed ? ' Ignore the other items.' : ''}` },
    criteria: RANK_LEVELS,
  }));
  const top = num(flags.top, 10), max = RANK_LEVELS.length - 1;
  rows.sort((a, b) => b.answer.score - a.answer.score);
  const shown = flags.all ? rows : rows.slice(0, top);
  const lines = shown.map((r) => `${f2(r.answer.score / max)}  ${label(r, flags)}`);
  const foot = footer(t0, items, [`top ${shown.length}`], lines.join('\n'), skipped);
  emit(flags, shown.map((r) => ({ id: r.item.id, relevance: r.answer.score / max, confidence: r.answer.confidence, ...chunkJson(r) })), lines, foot);
}

async function cmdFind({ pos, flags }) {
  const query = pos.shift();
  if (!query || !pos.length) die('usage: find "<what you are looking for>" <files...> [--top 5]');
  const t0 = Date.now();
  const chunkLines = Math.min(num(flags.chunk, 150), 250);
  const { items: files, skipped } = collect(pos, { ...flags, lines: false });
  requireInputs(files, 'find', skipped);
  const chunks = [];
  for (const f of files) {
    // Every non-blank line is sent whole (it used to be clipped to 400 chars). A line longer than a chunk is
    // split into pieces keyed 12, 12.2, 12.3, ..., and a request holds at most --chunk lines and CHUNK_CHARS
    // chars, so no request can overflow Jev's context.
    const all = [];
    for (const [i, t] of f.text.split(/\r?\n/).entries()) {
      if (t.trim()) for (const [k, c] of chunkText(t).entries()) all.push([k ? `${i + 1}.${k + 1}` : String(i + 1), c.text]);
    }
    let cur = [], size = 0;
    for (const l of all) {
      if (cur.length && (cur.length >= chunkLines || size + l[1].length > CHUNK_CHARS)) { chunks.push({ file: f.id, lines: cur }); cur = []; size = 0; }
      cur.push(l);
      size += l[1].length;
    }
    if (cur.length) chunks.push({ file: f.id, lines: cur });
  }
  const perChunk = await pool(chunks.map((c) => async () => {
    const lines = Object.fromEntries(c.lines);
    const res = await jev({ query, lines }, {
      where: {
        type: 'choice',
        instructions: 'Which line number in `lines` best matches `query`?',
        criteria: { ...Object.fromEntries(c.lines.map(([n]) => [n, null])), none: 'No line matches `query`' },
      },
      exists: { type: 'noul', instructions: 'Does any line in `lines` match `query`?' },
    });
    const ex = res.answers.exists.noul;
    return Object.entries(res.answers.where.probabilities)
      .filter(([n]) => n !== 'none')
      .map(([n, p]) => ({ file: c.file, line: n.split('.')[0], text: lines[n], score: p * ex }));
  }), num(flags.concurrency, 16));
  const top = num(flags.top, 5), minScore = num(flags['min-score'], 0.05);
  const seen = new Set(); // pieces of one split line, and overlapping pieces, report that line once (best first)
  const hits = perChunk.flat().filter((h) => h.score >= minScore).sort((a, b) => b.score - a.score)
    .filter((h) => !seen.has(`${h.file}:${h.line}`) && seen.add(`${h.file}:${h.line}`)).slice(0, top);
  const out = hits.map((h) => `${f2(h.score)}  ${h.file}:${h.line}  ${clip(h.text.trim(), num(flags.width, 160))}`);
  if (!out.length) out.push('(no matching lines)');
  const foot = footer(t0, files, [`${chunks.length} chunks`], out.join('\n'), skipped);
  emit(flags, hits, out, foot);
}

function fmtAnswer(id, a) {
  // the chunk that decided a chunked answer (mergeChunks)
  const by = a.best_chunk ? ` [chunk ${a.best_chunk}${a.best_lines ? `, lines ${a.best_lines.join('-')}` : ''}]` : '';
  if (a.type === 'noul') return `${id}  noul ${f2(a.noul)}${by}`;
  if (a.type === 'choice') return `${id}  choice ${a.choice} (conf ${f2(a.confidence)})${by}`;
  if (a.type === 'score') {
    const lvl = a.legend?.[String(Math.round(a.score))];
    return `${id}  score ${f2(a.score)}/${Object.keys(a.legend || {}).length - 1}${lvl ? ` "${clip(lvl, 60)}"` : ''} (conf ${f2(a.confidence)})${by}`;
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
  if (!body.state || !body.questions) die('spec needs "state" and "questions"');
  if (body.model !== undefined && (typeof body.model !== 'string' || !MODEL_RE.test(body.model))) die(`the ask spec's "model" must be a model id (${MODEL_RE.source})`);
  const states = chunkState(body.state);
  const replies = await pool(states.map((s) => () => jev(s.state, body.questions, body.model)), num(flags.concurrency, 16));
  const answers = Object.fromEntries(Object.keys(body.questions).map((id) => [id, mergeChunks(replies.map((res, i) => ({ ...states[i], answer: res.answers[id] })))]));
  const usage = { input_tokens: replies.reduce((a, res) => a + (res.usage?.input_tokens || 0), 0) };
  const lines = Object.entries(answers).map(([id, a]) => fmtAnswer(id, a));
  const stateText = typeof body.state === 'string' ? body.state : JSON.stringify(body.state);
  const foot = footer(t0, [{ text: stateText }], states.length > 1 ? [`${states.length} chunks`] : [], lines.join('\n'), []);
  emit(flags, { answers, usage, model: replies[0].model, chunks: states.length }, lines, foot.replace('1 scanned · ', ''));
}

// The ask state as the list of states to send, each fitting one chunk. A string is chunked like any item. A JSON
// object or array larger than a chunk is split into groups of whole top-level entries; one entry larger than a
// chunk cannot be split without breaking the field references in the questions, so that is an error.
function chunkState(state) {
  if (typeof state === 'string') return chunkText(state).map((c) => ({ state: c.text, from: c.from, to: c.to }));
  const size = (v) => JSON.stringify(v).length;
  if (size(state) <= CHUNK_CHARS) return [{ state }];
  const isArr = Array.isArray(state);
  if (state === null || typeof state !== 'object') die(`the ask state is larger than one chunk (--chunk-chars ${CHUNK_CHARS})`);
  const groups = [];
  let cur = [], len = 2;
  for (const [i, e] of (isArr ? state : Object.entries(state)).entries()) {
    const n = isArr ? size(e) : size(e[0]) + 1 + size(e[1]);
    if (n + 2 > CHUNK_CHARS) die(`the ask state's ${isArr ? `element ${i}` : `field "${e[0]}"`} is ${n} chars, larger than one chunk (--chunk-chars ${CHUNK_CHARS}); pass the document as a string state, or split it`);
    if (cur.length && len + n + 1 > CHUNK_CHARS) { groups.push(cur); cur = []; len = 2; }
    cur.push(e);
    len += n + 1;
  }
  groups.push(cur);
  return groups.map((g) => ({ state: isArr ? g : Object.fromEntries(g) }));
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

// A free GET key check -> the HTTP status, or 0 when the provider is unreachable.
async function verifyKey(p, key) {
  const res = await fetch(p.base + p.verify, { redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { ...p.headers, Authorization: `Bearer ${key}` } }).catch(() => null);
  return res ? res.status : 0;
}

// setup saves a literal key on one entry of providers.json: the pinned provider, else the head of the chain. It
// never reorders the file (the order is the user's fallback chain). With no file yet it writes every built-in by
// name, in built-in order, so the whole chain is visible and editable.
async function cmdSetup({ pos, flags }) {
  const p = PINNED ? CHAIN[0] : ALL.find((x) => x.enabled && x.base_url);
  if (!p) die('no enabled provider with a base_url to set up');
  const doc = readProvidersFile() ?? { version: 1, providers: BUILTINS.map((b) => ({ name: b.name })) };
  let entry = doc.providers.find((e) => e.name === p.name);
  if (flags.remove) {
    if (!BUILTINS.some((b) => b.name === p.name)) die(`"${p.name}" is not built in, so its api_key cannot be removed; edit it in ${PROVIDERS_FILE}`);
    if (entry?.api_key === undefined) return console.log(`No saved ${p.name} key in ${PROVIDERS_FILE}`);
    delete entry.api_key; // only this entry's key: the other entries stay as they are
    writeJson(PROVIDERS_FILE, doc);
    return console.log(`Removed the saved ${p.name} key from ${PROVIDERS_FILE}`);
  }
  const key = (pos[0] || (await promptHidden(`Paste your ${p.name} API key${p.key_url ? ` (from ${p.key_url})` : ''}: `))).trim();
  if (!key) die(`no key given${p.key_url ? `. Get one at ${p.key_url}` : ''}`);
  if (key.startsWith('$')) die(`setup saves a literal key; to read the key from a variable, put "api_key": "${key}" on the ${p.name} entry of ${PROVIDERS_FILE}`);
  if (!entry) {
    entry = { name: p.name };
    doc.providers.push(entry);
  }
  entry.api_key = key;
  if (flags.model) entry.model = flags.model;
  buildProviders(doc); // validated before anything is sent or written: the next run must accept this file
  if (p.verify) {
    const s = await verifyKey(p, key);
    if (s === 0) die(`network error: could not reach ${p.name} to verify the key`);
    if (s === 401 || s === 403) die(`that key was rejected by ${p.name} (${s}). Double-check it${p.key_url ? ` at ${p.key_url}` : ''}; for another provider's key add --provider NAME`, 3);
    // Every provider-side refusal is exit 3 (key or account problem, re-run setup), as for normal commands.
    if (s === 402) die(outOfCredits(p, s), 3);
    if (s < 200 || s >= 300) die(`could not verify the key: ${p.name} answered HTTP ${s}`, 3);
  }
  writeJson(PROVIDERS_FILE, doc);
  console.log(`✓ ${p.name} key ${p.verify ? 'verified and ' : ''}saved to ${PROVIDERS_FILE}. Quicksilver is ready.`);
  if (p.keySource?.startsWith('$')) console.error(`note: ${p.name} now uses the saved key instead of ${p.keySource}`);
}

// The chain in order, each entry with its state; a ready key is checked with the provider's free GET route.
async function cmdStatus() {
  const why = { disabled: 'disabled', 'no-url': 'not configured (no base_url)' };
  const rows = await Promise.all((PINNED ? CHAIN : ALL).map(async (p) => {
    if (p.state === 'no-key') return { p, text: `key missing (${p.tried.join(', ') || 'no api_key'})` };
    if (p.state === 'no-account') return { p, text: `account id missing (${p.acctTried.join(', ')})` };
    if (p.state !== 'ready') return { p, text: why[p.state] };
    let st = 'ready (key not verified: no free check)';
    if (p.verify) {
      const s = await verifyKey(p, p.key);
      st = s === 0 ? 'unreachable' : s === 401 || s === 403 ? `rejected (HTTP ${s})` : s === 402 ? `no credits (HTTP ${s})` : s < 300 ? 'ready' : `check failed (HTTP ${s})`;
    }
    const ready = st.startsWith('ready');
    // unreachable still counts: the key is there, and setup would not fix the network
    return { p, ok: ready || st === 'unreachable', text: `${st} · key ${p.keySource}${ready ? ` · model ${modelFor(p)}` : ''}` };
  }));
  const w = Math.max(...rows.map((r) => r.p.name.length));
  console.log(`providers, in fallback order (${fs.existsSync(PROVIDERS_FILE) ? PROVIDERS_FILE : 'built-in: no providers.json yet'}):`);
  for (const [i, r] of rows.entries()) console.log(`${i + 1}. ${r.p.name.padEnd(w)}  ${r.text}`);
  const s = readJson(STATS, null);
  if (s) console.log(`since ${s.since.slice(0, 10)}: ${s.runs} runs · ${fmtK(s.items)} items judged · jev ${fmtK(s.jev_input_tokens)} tok ($${(s.jev_cost_usd ?? s.jev_input_tokens * PRICE_PER_TOKEN).toFixed(4)}) · ~${fmtK(s.claude_tokens_saved)} Claude tokens not read`);
  if (!rows.some((r) => r.ok)) process.exit(3);
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
  setup [KEY] [--remove]                verify + save a key in providers.json
                                        (prompts if none; prefer an env var)
  status                                the provider chain and each one's
                                        state, plus lifetime savings
  help, --help, -h                      this screen

INPUTS  files, directories (.gitignore respected), globs (Node 22+), - (stdin),
        --items FILE.jsonl|- (one {"id","text"} object or plain line each).
        Secret-like files (.env*, .envrc, keys, certs, credentials, kubeconfig,
        terraform vars/state, ...) are never sent, even when named explicitly.
        Symlinks are skipped unless --follow-symlinks. Binary files are
        skipped. Any size is read up to a 100 MB hard cap per input; with
        --max-bytes N a larger file is skipped and a larger stdin or --items
        file is refused.

CHUNKS  Nothing is truncated. An item longer than --chunk-chars is split at
        line ends into overlapping chunks (500 chars), each judged on its own;
        the highest-scoring chunk decides the item: filter and ask yes/no take
        the highest probability, rank and ask --score the highest score,
        classify and ask --choice the most confident chunk's label. Output
        shows "(N chunks, best lines A-B)". Because any one chunk can make an
        item pass, ask positive questions ("does it contain X?"), not "does it
        lack X?".

PROVIDERS  ~/.quicksilver/providers.json ($QUICKSILVER_HOME/providers.json;
        never read from the working directory) lists providers in priority
        order: {"version": 1, "providers": [{"name": "openrouter",
        "api_key": "$OPENROUTER_API_KEY"}, {"name": "typesafe"}, ...]}.
        Built-in, in this default order: openrouter, typesafe, compatible
        (needs a base_url), cloudflare (Workers AI; also needs
        CLOUDFLARE_ACCOUNT_ID), vercel (AI Gateway). The file's entries come
        first, in file order,
        then the built-ins it does not name. "api_key" is "$VAR", "\${VAR}",
        a literal key (file must be chmod 600), or an array of these; a
        provider whose key is unset is skipped. "enabled": false (or no,
        off, 0, disabled, inactive) turns one off. A request that fails on a
        rejected key, no credits, an unavailable model, 429 or 5xx/network
        after retries moves to the next provider (never on a 400/422), and
        the receipt says so; each error is logged to errors.log next to
        providers.json (kept 72 hours, keys masked). Run status to see the
        chain. Example with every field: providers.example.json in the
        skill folder (one level above this script).

OPTIONS
 input    --lines             each non-empty line is an item (logs, lists)
          --ext ts,tsx        only these file extensions
          --chunk-chars 60000 chunk size, 1000-90000 (fits Jev's 32k context)
          --limit 5000        refuse to run on more items than this
          --max-bytes N       per-file/stdin/--items size cap (opt-in; at
                              most 104857600, the 100 MB hard cap)
          --no-secrets-guard  also send secret-looking files
          --follow-symlinks   read symlink targets (default: skip and list them);
                              the secret guard also checks the target's path
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
 provider --provider NAME     use only this provider (default: the chain)
          --model NAME        used where it fits the provider's model ids;
                              setup --model saves it on that entry

ENVIRONMENT
  OPENROUTER_API_KEY    openrouter key (built-in "$OPENROUTER_API_KEY")
  JEV_API_KEY, TYPESAFE_API_KEY  typesafe key
  JEV_GATEWAY_API_KEY   compatible key (with a base_url in providers.json)
  CLOUDFLARE_API_TOKEN (or JEV_CLOUDFLARE_API_TOKEN) + CLOUDFLARE_ACCOUNT_ID
                        cloudflare token and account
  AI_GATEWAY_API_KEY    vercel key
  QUICKSILVER_PROVIDER  same as --provider
  QUICKSILVER_MODEL     model, used when --model is absent
  QUICKSILVER_HOME      providers.json + stats directory, absolute path
                        (default ~/.quicksilver)
  QUICKSILVER_FOLLOW_SYMLINKS=1  same as --follow-symlinks
  QUICKSILVER_MAX_BYTES  same as --max-bytes (the flag wins)
  QUICKSILVER_CHUNK_CHARS  same as --chunk-chars (the flag wins)

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
  qs status

USE CASES
  which files handle X?   filter    │  security review shortlist   filter
  triage log errors       --lines   │  CI failure triage           classify
  route tickets           classify  │  code in a huge file         find
  yes/no on a long doc    ask       │  best matches for a query    rank`;

// Every command validates its numeric flags and resolves the provider first, from its parsed flags.
const COMMANDS = Object.fromEntries(Object.entries({ setup: cmdSetup, status: cmdStatus, filter: cmdFilter, classify: cmdClassify, rank: cmdRank, find: cmdFind, ask: cmdAsk })
  .map(([name, fn]) => [name, (args) => {
    checkNums(args.flags);
    FLAGS = args.flags;
    MAX_BYTES = flagOrEnv(args.flags, 'max-bytes', 'QUICKSILVER_MAX_BYTES', HARD_MAX_BYTES);
    CHUNK_CHARS = flagOrEnv(args.flags, 'chunk-chars', 'QUICKSILVER_CHUNK_CHARS', CHUNK_CHARS);
    resolveProvider(args.flags);
    return fn(args);
  }]));

process.on('unhandledRejection', (e) => die(`unexpected error: ${e?.stack || e}`, 5));
process.on('uncaughtException', (e) => die(`unexpected error: ${e?.stack || e}`, 5));

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
// `qs <command> --help` must show help too, not fail on the missing arguments. Help comes from the parsed
// flags, so a flag's value (`--state -h`, `--labels -h`) or anything after `--` never triggers it.
if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.flags.help) { console.log(HELP); process.exit(0); }
if (!COMMANDS[cmd]) die(`unknown command "${cmd}"\n\n${HELP}`);
await COMMANDS[cmd](args);
