// Builds the 12 benchmark situations: inputs + ground truth, under bench/data/sNN/.
// Real data: Loghub BGL, Banking77, SMS Spam, SST-2, honojs/hono, lodash. Synthetic where no labelled set exists.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// fileURLToPath decodes %20 and non-ASCII; URL.pathname kept them percent-encoded (audit m8).
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const RAW = path.join(ROOT, 'data', 'raw');
const HONO = path.join(RAW, 'hono');

let seed = 42;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
const pick = (a) => a[Math.floor(rand() * a.length)];
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

function out(id, files, meta) {
  const dir = path.join(ROOT, 'data', id);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [f, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), content);
  }
  fs.mkdirSync(path.join(ROOT, 'truth'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'truth', id + '.json'), JSON.stringify(meta, null, 2));
  console.log(`${id}  ${meta.title}`);
}

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

async function hfRows(dataset, config, split, n) {
  const rows = [];
  for (let off = 0; rows.length < n; off += 100) {
    const u = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(dataset)}&config=${config}&split=${split}&offset=${off}&length=100`;
    const cache = path.join(RAW, `${dataset.replace('/', '_')}_${split}_${off}.json`);
    let j;
    if (fs.existsSync(cache)) j = JSON.parse(fs.readFileSync(cache, 'utf8'));
    else { j = await (await fetch(u)).json(); fs.writeFileSync(cache, JSON.stringify(j)); }
    if (!j.rows?.length) break;
    rows.push(...j.rows.map((r) => ({ ...r.row, _labels: j.features.find((f) => f.name === 'label')?.type?.names })));
  }
  return rows;
}

// ---------- S01 real production log anomalies (Loghub BGL) ----------
{
  const rows = parseCsv(fs.readFileSync(path.join(RAW, 'bgl.csv'), 'utf8')).slice(1).filter((r) => r.length > 10);
  const lines = rows.map((r) => `${r[3]} ${r[4]} ${r[5]} ${r[7]} ${r[8]} ${r[9]} ${r[10]}`);
  const truth = rows.map((r, i) => (r[1] !== '-' ? i + 1 : null)).filter(Boolean);
  out('s01', { 'bgl.log': lines.join('\n') + '\n' }, {
    title: 'Real log triage — BlueGene/L supercomputer log (Loghub), 2,000 lines',
    kind: 'filter-lines', input: 'bgl.log',
    question: 'Does this log line report a failure, fault, or fatal error that needs attention (not a corrected error or routine informational message)?',
    truth, source: 'https://github.com/logpai/loghub (BGL_2k, expert-labelled alerts)',
  });
}

// ---------- S02 needles in a noisy service log (synthetic) ----------
{
  const svc = ['api', 'worker', 'cron', 'gateway'];
  const noise = [
    (i) => `INFO request handled path=/v1/items/${i} status=200 ms=${20 + (i % 80)}`,
    (i) => `INFO cache hit key=user:${i % 997} ttl=300`,
    (i) => `DEBUG memory usage ${30 + (i % 40)}% heap=${200 + (i % 300)}MB`,
    (i) => `INFO connection pool size=${10 + (i % 5)} idle=${i % 7}`,
    (i) => `WARN deprecated header X-Api-Version used by client ${i % 50}`,
    () => `INFO retrying idempotent GET /v1/feed after 1 transient 502 (attempt 1/3) succeeded`,
    () => `INFO disk usage /var/lib/data 41% (ok)`,
    () => `INFO TLS certificate valid for 62 more days`,
  ];
  const needles = {
    413: 'ERROR process killed: JavaScript heap out of memory (allocation failed - scavenge)',
    977: 'FATAL write failed: ENOSPC no space left on device /var/lib/data/segments/0003.log',
    1520: 'ERROR TLS handshake with payments.internal:443 failed: certificate has expired',
    2011: 'ERROR worker exited with signal SIGSEGV (segmentation fault) in native module sharp',
    2604: 'ERROR connect ECONNREFUSED 10.0.3.12:5432 — database unreachable, 3 queries dropped',
    2890: 'CRITICAL container OOMKilled: exceeded memory limit 512Mi, restarting (restart count 4)',
  };
  const lines = [];
  for (let i = 1; i <= 3000; i++) {
    const ts = `2026-09-25T10:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z ${svc[i % 4]}`;
    lines.push(`${ts} ${needles[i] || noise[i % noise.length](i)}`);
  }
  out('s02', { 'service.log': lines.join('\n') + '\n' }, {
    title: 'Needles in a noisy service log — 3,000 lines, 6 real incidents, decoys mentioning memory/disk/TLS/retries',
    kind: 'filter-lines', input: 'service.log',
    question: 'Does this log line report an actual failure or crash (not a routine status, metric, warning, or successful retry)?',
    truth: Object.keys(needles).map(Number), source: 'synthetic',
  });
}

// ---------- S03 support ticket routing (Banking77) ----------
{
  const intents = ['card_arrival', 'lost_or_stolen_card', 'exchange_rate', 'pending_top_up', 'request_refund',
    'passcode_forgotten', 'declined_card_payment', 'transfer_not_received_by_recipient'];
  const rows = await hfRows('legacy-datasets/banking77', 'default', 'test', 3080);
  const names = rows[0]._labels;
  const byIntent = Object.fromEntries(intents.map((k) => [k, []]));
  for (const r of rows) { const k = names[r.label]; if (byIntent[k] && byIntent[k].length < 25) byIntent[k].push(r.text); }
  const items = shuffle(intents.flatMap((k) => byIntent[k].map((text) => ({ text, label: k })))).map((r, i) => ({ id: `T${i + 1}`, ...r }));
  out('s03', { 'tickets.jsonl': jsonl(items.map(({ id, text }) => ({ id, text }))) }, {
    title: 'Support ticket routing — Banking77, 200 real customer messages, 8 intents',
    kind: 'classify', input: 'tickets.jsonl', labels: intents,
    question: 'Which support queue should handle this customer message?',
    truth: Object.fromEntries(items.map((r) => [r.id, r.label])), source: 'https://huggingface.co/datasets/legacy-datasets/banking77',
  });
}

// ---------- S04 spam filtering (UCI SMS Spam) ----------
{
  const rows = (await hfRows('ucirvine/sms_spam', 'plain_text', 'train', 300)).slice(0, 300);
  const items = rows.map((r, i) => ({ id: `M${i + 1}`, text: r.sms.trim(), spam: r.label === 1 }));
  out('s04', { 'messages.jsonl': jsonl(items.map(({ id, text }) => ({ id, text }))) }, {
    title: 'Spam filtering — UCI SMS Spam Collection, 300 real messages',
    kind: 'filter-items', input: 'messages.jsonl',
    question: 'Is this SMS message spam (unsolicited advertising, prize/lottery claims, premium-rate or phishing bait)?',
    truth: items.filter((r) => r.spam).map((r) => r.id), source: 'https://huggingface.co/datasets/ucirvine/sms_spam',
  });
}

// ---------- S05 sentiment (SST-2) ----------
{
  const rows = (await hfRows('stanfordnlp/sst2', 'default', 'validation', 200)).slice(0, 200);
  const items = rows.map((r, i) => ({ id: `R${i + 1}`, text: r.sentence.trim(), label: r.label === 1 ? 'positive' : 'negative' }));
  out('s05', { 'reviews.jsonl': jsonl(items.map(({ id, text }) => ({ id, text }))) }, {
    title: 'Review sentiment — SST-2, 200 real movie-review sentences',
    kind: 'classify', input: 'reviews.jsonl', labels: ['positive', 'negative'],
    question: 'Is the sentiment of this movie review sentence positive or negative?',
    truth: Object.fromEntries(items.map((r) => [r.id, r.label])), source: 'https://huggingface.co/datasets/stanfordnlp/sst2',
  });
}

// ---------- hono source (S06, S10, S11) ----------
const honoFiles = execFileSync('git', ['ls-files', 'src'], { cwd: HONO, encoding: 'utf8' }).split('\n')
  .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$|\.d\.ts$|test-utils/.test(f));
const honoTree = Object.fromEntries(honoFiles.map((f) => [f, fs.readFileSync(path.join(HONO, f), 'utf8')]));

out('s06', honoTree, {
  title: `Codebase discovery — honojs/hono, ${honoFiles.length} real source files: which implement request authentication?`,
  kind: 'filter-files', input: 'src',
  question: 'Is this file a middleware that authenticates incoming requests by verifying credentials or tokens (for example passwords, bearer tokens, or JWTs)?',
  truth: ['src/middleware/basic-auth/index.ts', 'src/middleware/bearer-auth/index.ts', 'src/middleware/jwt/jwt.ts', 'src/middleware/jwk/jwk.ts'],
  neutral: ['src/middleware/jwt/index.ts', 'src/middleware/jwk/index.ts', 'src/utils/basic-auth.ts', 'src/middleware/csrf/index.ts',
    'src/middleware/ip-restriction/index.ts', ...honoFiles.filter((f) => f.startsWith('src/utils/jwt/'))],
  source: 'https://github.com/honojs/hono',
});

// ---------- S07 security shortlist (synthetic, planted vulns + look-alike safe code) ----------
{
  const vuln = {
    'api/users.ts': `export async function findUser(req, res) {\n  const rows = await db.query("SELECT * FROM users WHERE email = '" + req.query.email + "'");\n  res.json(rows);\n}\n`,
    'api/convert.ts': `import { exec } from 'node:child_process';\nexport function convert(req, res) {\n  exec(\`convert uploads/\${req.body.file} -resize 200x200 out.png\`, (err) => res.send(err ? 'fail' : 'ok'));\n}\n`,
    'api/download.ts': `import path from 'node:path';\nexport function download(req, res) {\n  const file = path.join(__dirname, 'files', req.params.name);\n  res.sendFile(file);\n}\n`,
    'web/comments.ts': `export function renderComment(el: HTMLElement, comment: { author: string; body: string }) {\n  el.innerHTML = \`<b>\${comment.author}</b>: \${comment.body}\`;\n}\n`,
    'config/aws.ts': `export const s3 = new S3Client({\n  region: 'us-east-1',\n  credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },\n});\n`,
    'jobs/import.py': `import pickle, base64\nfrom flask import request\n\ndef import_job():\n    job = pickle.loads(base64.b64decode(request.form['payload']))\n    return run(job)\n`,
    'api/preview.ts': `export async function preview(req, res) {\n  const r = await fetch(req.query.url as string);\n  res.send(await r.text());\n}\n`,
    'auth/password.ts': `import crypto from 'node:crypto';\nexport function hashPassword(pw: string) {\n  return crypto.createHash('md5').update(pw).digest('hex');\n}\n`,
  };
  const safe = {
    'api/users_safe.ts': `export async function findUser(req, res) {\n  const rows = await db.query('SELECT * FROM users WHERE email = $1', [req.query.email]);\n  res.json(rows);\n}\n`,
    'api/convert_safe.ts': `import { execFile } from 'node:child_process';\nconst NAME = /^[a-z0-9_-]+\\.png$/i;\nexport function convert(req, res) {\n  if (!NAME.test(req.body.file)) return res.status(400).end();\n  execFile('convert', ['uploads/' + req.body.file, '-resize', '200x200', 'out.png'], (err) => res.send(err ? 'fail' : 'ok'));\n}\n`,
    'api/download_safe.ts': `import path from 'node:path';\nconst BASE = path.join(__dirname, 'files');\nexport function download(req, res) {\n  const file = path.resolve(BASE, req.params.name);\n  if (!file.startsWith(BASE + path.sep)) return res.status(403).end();\n  res.sendFile(file);\n}\n`,
    'web/comments_safe.ts': `export function renderComment(el: HTMLElement, comment: { author: string; body: string }) {\n  const b = document.createElement('b');\n  b.textContent = comment.author;\n  el.replaceChildren(b, document.createTextNode(': ' + comment.body));\n}\n`,
    'config/aws_safe.ts': `export const s3 = new S3Client({ region: process.env.AWS_REGION });\n`,
    'jobs/import_safe.py': `import json\nfrom flask import request\n\ndef import_job():\n    job = json.loads(request.form['payload'])\n    return run(validate(job))\n`,
    'api/preview_safe.ts': `const ALLOWED = new Set(['example.com', 'docs.example.com']);\nexport async function preview(req, res) {\n  const u = new URL(req.query.url as string);\n  if (u.protocol !== 'https:' || !ALLOWED.has(u.hostname)) return res.status(400).end();\n  res.send(await (await fetch(u)).text());\n}\n`,
    'auth/password_safe.ts': `import argon2 from 'argon2';\nexport const hashPassword = (pw: string) => argon2.hash(pw);\n`,
    'lib/math.ts': `export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));\n`,
    'lib/date.ts': `export const isoDay = (d: Date) => d.toISOString().slice(0, 10);\n`,
    'lib/slug.ts': `export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');\n`,
    'lib/retry.ts': `export async function retry<T>(fn: () => Promise<T>, n = 3): Promise<T> {\n  try { return await fn(); } catch (e) { if (n <= 1) throw e; return retry(fn, n - 1); }\n}\n`,
    'ui/Button.tsx': `export const Button = ({ children, onClick }) => <button className="btn" onClick={onClick}>{children}</button>;\n`,
    'ui/Avatar.tsx': `export const Avatar = ({ src, name }) => <img src={src} alt={name} width={32} height={32} />;\n`,
    'ui/Markdown.tsx': `import DOMPurify from 'dompurify';\nimport { marked } from 'marked';\nexport const Markdown = ({ md }) => <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked(md)) }} />;\n`,
    'api/health.ts': `export const health = (_req, res) => res.json({ ok: true, uptime: process.uptime() });\n`,
    'api/logout.ts': `export function logout(req, res) {\n  req.session.destroy(() => res.clearCookie('sid', { httpOnly: true, secure: true, sameSite: 'lax' }).redirect('/'));\n}\n`,
    'api/rate_limit.ts': `const hits = new Map<string, number>();\nexport function rateLimit(req, res, next) {\n  const n = (hits.get(req.ip) ?? 0) + 1;\n  hits.set(req.ip, n);\n  n > 100 ? res.status(429).end() : next();\n}\n`,
    'db/migrate.ts': `export async function migrate(db) {\n  await db.query('CREATE TABLE IF NOT EXISTS users (id serial primary key, email text unique not null)');\n}\n`,
    'db/pool.ts': `export const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: true } });\n`,
    'auth/session.ts': `import crypto from 'node:crypto';\nexport async function createSession(userId: string) {\n  const token = crypto.randomBytes(32).toString('hex');\n  await redis.set('sess:' + token, userId, { EX: 3600 });\n  return token;\n}\n`,
    'auth/csrf.ts': `import crypto from 'node:crypto';\nexport const verifyCsrf = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));\n`,
    'jobs/cleanup.py': `import os, time\n\ndef cleanup(dirpath, max_age=86400):\n    for f in os.listdir(dirpath):\n        p = os.path.join(dirpath, f)\n        if time.time() - os.path.getmtime(p) > max_age:\n            os.remove(p)\n`,
    'jobs/report.py': `import csv\n\ndef write_report(rows, path='report.csv'):\n    with open(path, 'w', newline='') as f:\n        csv.writer(f).writerows(rows)\n`,
    'web/search.ts': `export function showQuery(el: HTMLElement, q: string) {\n  el.textContent = 'Results for ' + q;\n}\n`,
    'web/analytics.ts': `export const track = (event: string, props: Record<string, string>) => navigator.sendBeacon('/t', JSON.stringify({ event, props }));\n`,
    'config/cors.ts': `export const corsOptions = { origin: ['https://app.example.com'], credentials: true };\n`,
    'config/env.ts': `import { z } from 'zod';\nexport const env = z.object({ DATABASE_URL: z.string().url(), SESSION_SECRET: z.string().min(32) }).parse(process.env);\n`,
    'lib/hash.ts': `import crypto from 'node:crypto';\nexport const etag = (body: string) => crypto.createHash('md5').update(body).digest('hex'); // cache key only, not security\n`,
  };
  const files = {};
  for (const [f, c] of Object.entries({ ...vuln, ...safe })) files[`app/${f}`] = c;
  out('s07', files, {
    title: `Security review shortlist — 40 files, 8 planted vulnerabilities next to safe look-alikes`,
    kind: 'filter-files', input: 'app',
    question: 'Does this code contain an exploitable security vulnerability (such as injection, path traversal, XSS, SSRF, unsafe deserialization, hardcoded secrets, or weak password hashing)?',
    truth: Object.keys(vuln).map((f) => `app/${f}`), source: 'synthetic',
  });
}

// ---------- S08 CI failure triage (synthetic) ----------
{
  const tests = ['checkout.spec.ts', 'auth/login.test.ts', 'test_orders.py', 'api/users.test.js', 'cart.e2e.ts', 'billing_test.go', 'search.spec.tsx', 'test_invoice.py'];
  const gen = {
    infra_flaky: [
      () => `thrown: "Exceeded timeout of 5000 ms for a test."\n  at ${pick(tests)}:${10 + Math.floor(rand() * 90)}`,
      () => `Error: socket hang up\n    at connResetException (node:internal/errors:720:14)\n  while fetching https://registry.npmjs.org/${pick(['react', 'zod', 'vite'])}`,
      () => `The runner has received a shutdown signal. This can happen when the runner service is stopped, or a manually started runner is canceled.`,
      () => `Error: read ECONNRESET\n    at TCP.onStreamRead — ${pick(tests)} passed on retry 2/3`,
      () => `TimeoutError: page.waitForSelector: Timeout 30000ms exceeded.\n  waiting for locator('[data-test=${pick(['submit', 'cart', 'toast'])}]') — passes locally`,
      () => `docker: Error response from daemon: toomanyrequests: You have reached your pull rate limit.`,
      () => `fatal: unable to access 'https://github.com/org/repo.git/': Could not resolve host: github.com`,
    ],
    assertion: [
      () => `expect(received).toBe(expected) // Object.is equality\n\nExpected: ${Math.floor(rand() * 10)}\nReceived: ${10 + Math.floor(rand() * 10)}\n  at ${pick(tests)}`,
      () => `AssertionError: expected [ 'a', 'b' ] to deeply equal [ 'a', 'b', 'c' ]\n  in ${pick(tests)}`,
      () => `FAIL ${pick(tests)}\n  › 1 snapshot failed.\n  - Snapshot  - 1\n  + Received  + 1\n  -   "total": "$12.00"\n  +   "total": "$12.50"`,
      () => `assert response.status_code == 200\nE   assert 500 == 200\n${pick(tests)}:44: AssertionError`,
      () => `--- FAIL: TestApplyDiscount (0.00s)\n    billing_test.go:31: got 90, want 85`,
      () => `Error: expect(jest.fn()).toHaveBeenCalledTimes(expected)\nExpected number of calls: 1\nReceived number of calls: 2`,
      () => `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n'pending' !== 'paid'`,
    ],
    config_env: [
      () => `Error: Missing required environment variable: ${pick(['STRIPE_SECRET_KEY', 'DATABASE_URL', 'JWT_SECRET', 'SENTRY_DSN'])}`,
      () => `KeyError: '${pick(['DATABASE_URL', 'REDIS_URL', 'AWS_REGION'])}'\n  File "settings.py", line 12, in <module>\n    DB = os.environ['${pick(['DATABASE_URL', 'REDIS_URL'])}']`,
      () => `Invalid configuration object. Webpack has been initialized using a configuration object that does not match the API schema.\n - configuration.output.path: The provided value "dist" is not an absolute path!`,
      () => `Error: EACCES: permission denied, open '/etc/app/config.yml'`,
      () => `error TS5023: Unknown compiler option 'verbatimModuleSyntx'. (tsconfig.json)`,
      () => `ValidationError: "port" must be a number. Check config/${pick(['production', 'staging'])}.json`,
      () => `Error: secretOrPrivateKey must have a value — JWT_SECRET is empty in the CI environment`,
    ],
    dependency: [
      () => `Error: Cannot find module '${pick(['lodash', 'dayjs', '@aws-sdk/client-s3', 'sharp'])}'\nRequire stack:\n- /app/src/${pick(['util', 'upload', 'date'])}.js`,
      () => `ModuleNotFoundError: No module named '${pick(['requests', 'pydantic', 'boto3', 'numpy'])}'`,
      () => `npm ERR! code ERESOLVE\nnpm ERR! ERESOLVE unable to resolve dependency tree\nnpm ERR! peer react@"^18" from react-dom@18.3.1`,
      () => `ImportError: cannot import name '${pick(['BaseSettings', 'soft_unicode', 'url_quote'])}' from '${pick(['pydantic', 'markupsafe', 'werkzeug.urls'])}'`,
      () => `SyntaxError: The requested module 'chalk' does not provide an export named 'default' (chalk@5 is ESM-only)`,
      () => `go: github.com/org/lib@v1.4.0: reading github.com/org/lib/go.mod at revision v1.4.0: unknown revision v1.4.0`,
      () => `error: package \`serde v1.0.210\` cannot be built because it requires rustc 1.81 or newer`,
    ],
  };
  const items = shuffle(Object.entries(gen).flatMap(([label, fs_]) => Array.from({ length: 20 }, () => ({ label, text: pick(fs_)() }))))
    .map((r, i) => ({ id: `F${i + 1}`, ...r }));
  out('s08', { 'failures.jsonl': jsonl(items.map(({ id, text }) => ({ id, text }))) }, {
    title: 'CI failure triage — 80 failure logs into infra-flaky / assertion / config-env / dependency',
    kind: 'classify', input: 'failures.jsonl', labels: Object.keys(gen),
    labelDescriptions: {
      infra_flaky: 'Flaky or infrastructure problem: timeouts, network resets, runner or registry outages; not a code bug',
      assertion: 'A test assertion failed: the code returned a wrong value (logic bug)',
      config_env: 'Missing or invalid configuration, environment variable, or permission',
      dependency: 'A package or module is missing, incompatible, or failed to install/import',
    },
    question: 'What is the root cause category of this CI failure?',
    truth: Object.fromEntries(items.map((r) => [r.id, r.label])), source: 'synthetic',
  });
}

// ---------- S09 semantic find in a huge file (lodash.js, 17k lines) ----------
{
  const src = fs.readFileSync(path.join(RAW, 'lodash.js'), 'utf8');
  const lines = src.split('\n');
  const queries = {
    debounce: 'delays calling a function until a wait period has passed since the last time it was called',
    throttle: 'invokes a function at most once per every wait milliseconds',
    cloneDeep: 'creates a recursive deep copy of a value',
    isEqual: 'performs a deep comparison between two values to determine whether they are equivalent',
    chunk: 'splits an array into groups of a given size',
    once: 'restricts a function so it can only run one time, returning the first result on repeated calls',
    memoize: 'caches the results of a function keyed by its arguments',
    kebabCase: 'converts a string into lowercase words joined by dashes',
    get: 'reads the value at a property path of an object, returning a default when the result is undefined',
    flattenDeep: 'recursively flattens a nested array all the way down',
  };
  const truth = {};
  for (const name of Object.keys(queries)) {
    const def = lines.findIndex((l) => new RegExp(`^\\s*(function ${name}\\(|var ${name} = )`).test(l));
    let doc = def; while (doc > 0 && !lines[doc].includes('/**')) doc--;
    truth[name] = [doc + 1, def + 1 + 30];
  }
  out('s09', { 'lodash.js': src }, {
    title: 'Semantic search in a huge file — lodash.js (17,209 lines), 10 behaviour-described lookups',
    kind: 'find', input: 'lodash.js', queries, truth, source: 'https://github.com/lodash/lodash/blob/4.17.21/lodash.js',
  });
}

// ---------- S10 relevance ranking over a repo ----------
{
  const queries = {
    q1: 'Where are cross-origin resource sharing (CORS) response headers configured?',
    q2: 'Where is the maximum allowed request body size enforced?',
    q3: 'Where are responses gzip/deflate compressed?',
    q4: 'Where is the ETag header computed for responses?',
    q5: 'Where are requests allowed or denied based on the client IP address?',
    q6: 'Where is a unique identifier generated for each incoming request?',
    q7: 'Where are headers such as Content-Security-Policy and X-Frame-Options set?',
    q8: 'Where is a request aborted when the handler takes too long?',
    q9: 'Where is the Server-Timing header produced?',
    q10: 'Where are cookies parsed from and serialized into headers?',
  };
  const truth = {
    q1: ['src/middleware/cors/index.ts'], q2: ['src/middleware/body-limit/index.ts'], q3: ['src/middleware/compress/index.ts'],
    q4: ['src/middleware/etag/index.ts', 'src/middleware/etag/digest.ts'], q5: ['src/middleware/ip-restriction/index.ts'],
    q6: ['src/middleware/request-id/request-id.ts', 'src/middleware/request-id/index.ts'],
    q7: ['src/middleware/secure-headers/secure-headers.ts', 'src/middleware/secure-headers/index.ts'],
    q8: ['src/middleware/timeout/index.ts'], q9: ['src/middleware/timing/timing.ts', 'src/middleware/timing/index.ts'],
    q10: ['src/utils/cookie.ts', 'src/helper/cookie/index.ts'],
  };
  out('s10', honoTree, {
    title: `Relevance ranking — 10 "where is X?" questions over ${honoFiles.length} hono source files`,
    kind: 'rank', input: 'src', queries, truth, source: 'https://github.com/honojs/hono',
  });
}

// ---------- S11 commit classification (hono history, conventional-commit prefix removed) ----------
{
  const log = execFileSync('git', ['log', '--format=%H%x09%s', '-n', '1500'], { cwd: HONO, encoding: 'utf8' }).split('\n');
  const types = ['feat', 'fix', 'docs', 'chore', 'perf', 'refactor', 'test'];
  const per = Object.fromEntries(types.map((t) => [t, []]));
  for (const l of log) {
    const [sha, subj] = l.split('\t');
    const m = /^(\w+)(\([^)]*\))?!?:\s*(.+)$/.exec(subj || '');
    if (m && per[m[1]] && per[m[1]].length < 40) per[m[1]].push({ id: sha.slice(0, 8), text: m[3].replace(/\s*\(#\d+\)$/, ''), label: m[1] });
  }
  const items = shuffle(Object.values(per).flat());
  out('s11', { 'commits.jsonl': jsonl(items.map(({ id, text }) => ({ id, text }))) }, {
    title: `Commit classification — ${items.length} real hono commit subjects, type prefix stripped`,
    kind: 'classify', input: 'commits.jsonl', labels: types,
    labelDescriptions: {
      feat: 'Adds a new feature or capability', fix: 'Fixes a bug', docs: 'Documentation only', chore: 'Tooling, dependencies, release, CI, housekeeping',
      perf: 'Improves performance', refactor: 'Restructures code without changing behaviour', test: 'Adds or changes tests only',
    },
    question: 'What kind of change does this commit message describe?',
    truth: Object.fromEntries(items.map((r) => [r.id, r.label])), distribution: Object.fromEntries(types.map((t) => [t, per[t].length])),
    source: 'https://github.com/honojs/hono',
  });
}

// ---------- S12 negative control: numeric threshold (what Jev is NOT for) ----------
{
  const lines = [], truth = [];
  for (let i = 1; i <= 200; i++) {
    const ms = Math.floor(40 + rand() * 460);
    lines.push(`2026-09-25T11:${String(i % 60).padStart(2, '0')}:00Z api GET /v1/orders/${1000 + i} status=200 latency=${ms}ms`);
    if (ms > 250) truth.push(i);
  }
  out('s12', { 'latency.log': lines.join('\n') + '\n' }, {
    title: 'Numeric threshold stress test — "latency above 250ms?" on 200 lines (a documented Jev weak spot)',
    kind: 'filter-lines', input: 'latency.log',
    question: 'Is the latency in this log line greater than 250ms?',
    truth, codeBaseline: `awk -F'latency=' '{ if ($2+0 > 250) print NR }' latency.log`, source: 'synthetic',
  });
}
