// End-to-end tests: qs.mjs (and the bin installer) run as real child processes against a local
// mock of the System One API. No network, no real key: provider typesafe, QUICKSILVER_API_BASE
// points at the mock, OPENROUTER_API_KEY is never passed to the child.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QS = path.join(ROOT, 'skills', 'quicksilver', 'scripts', 'qs.mjs');
const BIN = path.join(ROOT, 'bin', 'quicksilver.mjs');
const KEY = 'sk-fake-test-key';

const reqs = []; // every request the mock received: { method, url, auth, body }
let verifyStatus = 200; // status the mock returns on the key-verify GET
let postStatus = 200; // status the mock returns on POST /v1/systemone
let server, port, BASE, TMP, QHOME;

function mockAnswer(body) {
  const answers = {};
  // Chunking tests mark their content CHUNKTEST: then a request whose state holds NEEDLE says yes (and label a),
  // any other part of the same item says no (and label b), so the aggregation over chunks is observable.
  const state = JSON.stringify(body.state ?? '');
  const chunkTest = state.includes('CHUNKTEST');
  const hit = state.includes('NEEDLE');
  for (const [k, q] of Object.entries(body.questions || {})) {
    // choice answers must name real criteria keys (find looks the chosen line number up)
    const [c0, c1] = q.criteria && !Array.isArray(q.criteria) ? Object.keys(q.criteria) : ['a', 'b'];
    answers[k] = { type: q.type, noul: 0.9, choice: c0, confidence: 0.9, probabilities: { [c0]: 0.9, [c1]: 0.1 }, score: 3 };
    if (chunkTest) {
      answers[k] = hit
        ? { type: q.type, noul: 0.95, choice: c0, confidence: 0.9, probabilities: { [c0]: 0.9, [c1]: 0.1 }, score: 4 }
        : { type: q.type, noul: 0.05, choice: c1, confidence: 0.8, probabilities: { [c0]: 0.2, [c1]: 0.8 }, score: 0 };
    }
  }
  return { answers, usage: { input_tokens: 10 }, model: 'mock' };
}

before(async () => {
  server = http.createServer((q, r) => {
    let b = '';
    q.on('data', (c) => (b += c));
    q.on('end', () => {
      reqs.push({ method: q.method, url: q.url, auth: q.headers.authorization || '', body: b });
      r.setHeader('content-type', 'application/json');
      if (q.method === 'GET') { r.statusCode = verifyStatus; return r.end('{"data":[]}'); }
      if (postStatus !== 200) { r.statusCode = postStatus; return r.end('{"error":"mock"}'); }
      r.end(JSON.stringify(mockAnswer(JSON.parse(b))));
    });
  });
  // '::' is dual-stack, so the mock is also reachable as an IPv4-mapped IPv6 address (the m2 test).
  await new Promise((res) => server.listen(0, '::', res));
  port = server.address().port;
  BASE = `http://127.0.0.1:${port}`;
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-test-'));
});

after(() => {
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// providers.json in the test home. Mode 0600 by default, since a file holding a literal key must be private.
function writeProviders(providers, { mode = 0o600, home = QHOME, raw } = {}) {
  const file = path.join(home, 'providers.json');
  fs.writeFileSync(file, raw ?? JSON.stringify({ version: 1, providers }));
  fs.chmodSync(file, mode);
}
const readProviders = () => JSON.parse(fs.readFileSync(path.join(QHOME, 'providers.json'), 'utf8'));

beforeEach(() => {
  reqs.length = 0;
  verifyStatus = 200;
  postStatus = 200;
  QHOME = fs.mkdtempSync(path.join(TMP, 'home-'));
  // typesafe points at the mock; no other provider has a key in childEnv, so the chain is just typesafe.
  writeProviders([{ name: 'typesafe', base_url: BASE }]);
});

// Minimal child env, built from scratch so the developer's real keys never reach the child.
function childEnv(extra) {
  const env = { PATH: process.env.PATH, HOME: QHOME, QUICKSILVER_HOME: QHOME, JEV_API_KEY: KEY, ...extra };
  return Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined));
}

function runNode(script, args, { env, cwd = TMP, input = '' } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, env: childEnv(env) });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}
const qs = (args, opts) => runNode(QS, args, opts);
const sent = () => reqs.map((r) => r.body).join('\n');

function mkdir(files, { git = false } = {}) {
  const dir = fs.mkdtempSync(path.join(TMP, 'd-'));
  if (git) execFileSync('git', ['init', '-q'], { cwd: dir });
  for (const [f, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), content);
  }
  return dir;
}

describe('baseline', () => {
  test('help prints usage and exits 0', async () => {
    const r = await qs(['help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^quicksilver: hand bulk/);
  });

  test('filter sends a file with the key and prints the match', async () => {
    const dir = mkdir({ 'a.txt': 'hello-a' });
    const r = await qs(['filter', 'q?', 'a.txt'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /0\.90 {2}a\.txt/);
    assert.match(sent(), /hello-a/);
    assert.equal(reqs[0].auth, `Bearer ${KEY}`);
  });

  test('classify, rank and find run against the mock', async () => {
    const dir = mkdir({ 'a.txt': 'alpha\nbeta\n' });
    assert.equal((await qs(['classify', '--labels', 'a,b', 'a.txt'], { cwd: dir })).code, 0);
    assert.equal((await qs(['rank', 'q', 'a.txt'], { cwd: dir })).code, 0);
    assert.equal((await qs(['find', 'q', 'a.txt'], { cwd: dir })).code, 0);
  });
});

describe('M1: symlinks are never followed', () => {
  let outside, repo;
  before(() => {
    outside = mkdir({ 'secret.txt': 'OUTSIDE-SECRET', 'sub/inner.txt': 'OUTSIDE-DIR-SECRET' });
    repo = mkdir({ 'a.txt': 'inside-a' }, { git: true });
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(repo, 'notes.txt'));
    fs.symlinkSync(path.join(outside, 'sub'), path.join(repo, 'linkdir'));
  });

  test('directory scan of a git repo skips a symlinked file', async () => {
    const r = await qs(['filter', 'q?', '.'], { cwd: repo });
    assert.equal(r.code, 0, r.stderr);
    assert.match(sent(), /inside-a/);
    assert.doesNotMatch(sent(), /OUTSIDE/);
    assert.match(r.stdout, /notes\.txt \(symlink, never followed\)/);
  });

  test('explicitly named symlink is skipped', async () => {
    const r = await qs(['filter', 'q?', 'a.txt', 'notes.txt'], { cwd: repo });
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(sent(), /OUTSIDE/);
    assert.match(r.stdout, /notes\.txt \(symlink, never followed\)/);
  });

  test('glob match on a symlink is skipped', async () => {
    const r = await qs(['filter', 'q?', '*.txt'], { cwd: repo });
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(sent(), /OUTSIDE/);
  });

  test('explicitly named symlinked directory is not entered', async () => {
    const r = await qs(['filter', 'q?', 'a.txt', 'linkdir'], { cwd: repo });
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(sent(), /OUTSIDE/);
    assert.match(r.stdout, /linkdir \(symlink, never followed\)/);
  });
});

describe('M2: secret guard covers common credential files', () => {
  const names = ['.envrc', '.git-credentials', '.pgpass', '.htpasswd', '.dockercfg', 'kubeconfig', 'prod.tfvars',
    'terraform.tfstate', 'terraform.tfstate.backup', 'AuthKey_X.p8', 'k.ppk', 'db.kdbx', 'vpn.ovpn', 'notes.gpg',
    'service-account-prod.json', '.docker/config.json'];

  for (const name of names) {
    test(`${name} is never sent`, async () => {
      const repo = mkdir({ 'a.txt': 'inside-a', [name]: 'CREDENTIAL-CONTENT' }, { git: true });
      const r = await qs(['filter', 'q?', '.'], { cwd: repo });
      assert.equal(r.code, 0, r.stderr);
      assert.match(sent(), /inside-a/);
      assert.doesNotMatch(sent(), /CREDENTIAL-CONTENT/);
      assert.match(r.stdout, /secret-like, never sent/);
    });
  }

  test('ordinary json and config names are still sent', async () => {
    const repo = mkdir({ 'config.json': 'ok-config', 'service.json': 'ok-service', 'docker/config.json': 'ok-docker' }, { git: true });
    const r = await qs(['filter', 'q?', '.'], { cwd: repo });
    assert.equal(r.code, 0, r.stderr);
    assert.match(sent(), /ok-config/);
    assert.match(sent(), /ok-service/);
    assert.match(sent(), /ok-docker/);
  });
});

describe('M3: numeric flags are validated before any request', () => {
  const bad = [
    ['--concurrency', '0'], ['--concurrency', 'abc'], ['--concurrency', '2.5'], ['--limit', 'abc'], ['--limit', '0'],
    ['--threshold', 'abc'], ['--threshold', '1.5'], ['--band', '-0.1'], ['--chunk-chars', '0'], ['--width', 'x'],
    ['--pack-items', '0'], ['--pack-tokens', 'NaN'],
  ];
  for (const [flag, value] of bad) {
    test(`${flag} ${value} exits 1 naming the flag`, async () => {
      const dir = mkdir({ 'a.txt': 'hello-a' });
      const r = await qs(['filter', 'q?', 'a.txt', flag, value], { cwd: dir });
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.match(r.stderr, new RegExp(flag));
      assert.equal(reqs.length, 0);
    });
  }

  test('rank --top 0, classify --min-confidence 2 and find --chunk 0 exit 1', async () => {
    const dir = mkdir({ 'a.txt': 'hello-a' });
    for (const args of [['rank', 'q', 'a.txt', '--top', '0'], ['classify', '--labels', 'a,b', 'a.txt', '--min-confidence', '2'],
      ['find', 'q', 'a.txt', '--chunk', '0'], ['find', 'q', 'a.txt', '--min-score', 'abc']]) {
      const r = await qs(args, { cwd: dir });
      assert.equal(r.code, 1, args.join(' ') + r.stderr);
    }
    assert.equal(reqs.length, 0);
  });

  test('valid values still run', async () => {
    const dir = mkdir({ 'a.txt': 'hello-a' });
    const r = await qs(['filter', 'q?', 'a.txt', '--concurrency', '1', '--threshold', '0.7', '--band', '0', '--limit', '1'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /a\.txt/);
  });
});

describe('m1: .gitignore is respected even when nothing is left', () => {
  test('a git directory holding only ignored files sends nothing', async () => {
    const repo = mkdir({ '.gitignore': 'ign/\n', 'ign/x.txt': 'IGNORED-CONTENT' }, { git: true });
    const r = await qs(['filter', 'q?', 'ign'], { cwd: repo });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /nothing to filter/);
    assert.equal(reqs.length, 0);
  });

  test('a non-git directory is still walked', async () => {
    const dir = mkdir({ 'x/y.txt': 'walked-content' });
    const r = await qs(['filter', 'q?', 'x'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.match(sent(), /walked-content/);
  });
});

describe('m2: a provider base_url must be https off localhost', () => {
  test('plain http to a non-localhost host exits 1 before sending the key', async () => {
    writeProviders([{ name: 'typesafe', base_url: `http://[::ffff:127.0.0.1]:${port}` }]);
    const dir = mkdir({ 'a.txt': 'hello-a' });
    const r = await qs(['filter', 'q?', 'a.txt'], { cwd: dir });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /base_url.*https/);
    assert.equal(reqs.length, 0);
  });

  test('plain http to localhost is allowed', async () => {
    writeProviders([{ name: 'typesafe', base_url: `http://localhost:${port}` }]);
    const dir = mkdir({ 'a.txt': 'hello-a' });
    const r = await qs(['filter', 'q?', 'a.txt'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
  });

  test('QUICKSILVER_API_BASE is refused instead of being ignored', async () => {
    const dir = mkdir({ 'a.txt': 'hello-a' });
    const r = await qs(['filter', 'q?', 'a.txt'], { cwd: dir, env: { QUICKSILVER_API_BASE: BASE } });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /QUICKSILVER_API_BASE .*base_url/);
    assert.equal(reqs.length, 0);
  });
});

describe('m3: the installer detects an exported key instead of asking for one', () => {
  test('exported JEV_API_KEY: install reports it and skips setup, even if the key check fails', async () => {
    verifyStatus = 401;
    const claude = fs.mkdtempSync(path.join(TMP, 'claude-'));
    const r = await runNode(BIN, ['install', '--provider', 'typesafe'], { env: { CLAUDE_CONFIG_DIR: claude } });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout + r.stderr, /\$JEV_API_KEY/);
    assert.doesNotMatch(r.stdout, /set your Jev key|paste your/i);
    assert.deepEqual(readProviders(), { version: 1, providers: [{ name: 'typesafe', base_url: BASE }] });
    assert.ok(fs.existsSync(path.join(claude, 'skills', 'quicksilver', 'scripts', 'qs.mjs')));
  });
});

describe('m4: malformed user JSON is a usage error (exit 1), not a crash', () => {
  test('--labels-json with invalid JSON', async () => {
    const dir = mkdir({ 'a.txt': 'hello-a' });
    const r = await qs(['classify', '--labels-json', '{bad', 'a.txt'], { cwd: dir });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /--labels-json/);
    assert.doesNotMatch(r.stderr, /unexpected error/);
  });

  test('ask spec file with invalid JSON', async () => {
    const dir = mkdir({ 'spec.json': '{bad' });
    const r = await qs(['ask', 'spec.json'], { cwd: dir });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /spec\.json/);
    assert.doesNotMatch(r.stderr, /unexpected error/);
  });

  test('--items line that starts an object but is not valid JSON', async () => {
    const dir = mkdir({ 'i.jsonl': '{"id": 1, "text": "ok"}\n{"id": 2, "text":\n' });
    const r = await qs(['filter', 'q?', '--items', 'i.jsonl'], { cwd: dir });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /line 2/);
    assert.equal(reqs.length, 0);
  });

  test('--items plain lines and valid objects still work', async () => {
    const dir = mkdir({ 'i.jsonl': '{"id": "x", "text": "obj-text"}\nplain line\n' });
    const r = await qs(['filter', 'q?', '--items', 'i.jsonl'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.match(sent(), /obj-text/);
    assert.match(sent(), /plain line/);
  });
});

describe('m6: a corrupt config or stats file is reported, not silently reset', () => {
  test('corrupt providers.json exits 1 before any request, with only a line and column', async () => {
    writeProviders(null, { raw: '{bad' });
    const dir = mkdir({ 'a.txt': 'hello-a' });
    const r = await qs(['filter', 'q?', 'a.txt'], { cwd: dir });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /providers\.json is not valid JSON at line 1, column 2/);
    assert.equal(reqs.length, 0);
  });

  test('a parse error never quotes the file, which may hold a literal key', async () => {
    writeProviders(null, { raw: '{"version": 1, "providers": [{"name": "typesafe", "api_key": "sk-SECRET-123" }' });
    const r = await qs(['status']);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /not valid JSON/);
    assert.doesNotMatch(r.stdout + r.stderr, /SECRET/);
  });

  test('setup --remove refuses to overwrite a corrupt providers.json', async () => {
    writeProviders(null, { raw: '{bad' });
    const r = await qs(['setup', '--remove']);
    assert.equal(r.code, 1);
    assert.equal(fs.readFileSync(path.join(QHOME, 'providers.json'), 'utf8'), '{bad');
  });

  test('corrupt stats.json exits 1 and is left untouched', async () => {
    fs.writeFileSync(path.join(QHOME, 'stats.json'), '{bad');
    const dir = mkdir({ 'a.txt': 'hello-a' });
    const r = await qs(['filter', 'q?', 'a.txt'], { cwd: dir });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /stats\.json/);
    assert.equal(fs.readFileSync(path.join(QHOME, 'stats.json'), 'utf8'), '{bad');
  });
});

describe('m5: stdin and --items reads are bounded', () => {
  // The default bound is the 100 MB hard cap (tested under --max-bytes); a 2 MB --max-bytes keeps these fast.
  const big = 'x'.repeat(2 * 1024 * 1024 + 1);

  test('stdin over --max-bytes exits 1 without a request', async () => {
    const r = await qs(['filter', 'q?', '-', '--max-bytes', String(2 * 1024 * 1024)], { input: big });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /stdin/);
    assert.equal(reqs.length, 0);
  });

  test('--items file over --max-bytes exits 1 without a request', async () => {
    const dir = mkdir({ 'i.txt': big });
    const r = await qs(['filter', 'q?', '--items', 'i.txt', '--max-bytes', String(2 * 1024 * 1024)], { cwd: dir });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /i\.txt/);
    assert.equal(reqs.length, 0);
  });

  test('--limit stops before reading the files past the limit', async () => {
    const dir = mkdir({ 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' }, { git: true });
    fs.chmodSync(path.join(dir, 'c.txt'), 0o000); // reading it would crash with EACCES
    const r = await qs(['filter', 'q?', '.', '--limit', '1'], { cwd: dir });
    fs.chmodSync(path.join(dir, 'c.txt'), 0o644);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /--limit 1/);
    assert.equal(reqs.length, 0);
  });
});

describe('m7: explicitly named input files get the secret guard too', () => {
  const cases = [
    ['--items .env', ['filter', 'q?', '--items', '.env']],
    ['ask --state @.env', ['ask', 'q?', '--state', '@.env']],
    ['ask secrets.json', ['ask', 'secrets.json']],
    ['--labels-json @credentials.json', ['classify', '--labels-json', '@credentials.json', 'a.txt']],
  ];
  for (const [name, args] of cases) {
    test(`${name} exits 1 without a request`, async () => {
      const dir = mkdir({ '.env': 'TOKEN=CREDENTIAL-CONTENT', 'secrets.json': '{"state":"CREDENTIAL-CONTENT","questions":{"a":{"type":"noul","instructions":"q"}}}',
        'credentials.json': '{"a":"CREDENTIAL-CONTENT","b":null}', 'a.txt': 'hello-a' });
      const r = await qs(args, { cwd: dir });
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /secret/);
      assert.equal(reqs.length, 0);
    });
  }

  test('--no-secrets-guard sends an explicitly named secret file', async () => {
    const dir = mkdir({ '.env': 'TOKEN=CREDENTIAL-CONTENT' });
    const r = await qs(['filter', 'q?', '--items', '.env', '--no-secrets-guard'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.match(sent(), /CREDENTIAL-CONTENT/);
  });
});

describe('nits: config and stats files', () => {
  test('a failed stats write warns on stderr instead of being swallowed', async () => {
    const dir = mkdir({ 'a.txt': 'hello-a' });
    fs.chmodSync(QHOME, 0o500);
    const r = await qs(['filter', 'q?', 'a.txt'], { cwd: dir });
    fs.chmodSync(QHOME, 0o700);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /warning: .*stats\.json/);
  });

  test('setup writes providers.json 0600, atomically', async () => {
    writeProviders([{ name: 'typesafe', base_url: BASE }], { mode: 0o644 }); // no literal key yet, so 0644 is allowed
    const r = await qs(['setup', '--provider', 'typesafe'], { env: { JEV_API_KEY: undefined }, input: 'ts-key\n' });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fs.statSync(path.join(QHOME, 'providers.json')).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(QHOME), ['providers.json']); // atomic write leaves no temp file behind
  });
});

describe('review 1 and 7: provider errors map to exit 3', () => {
  for (const [status, msg] of [[402, /credits/], [403, /rejected/]]) {
    test(`filter on HTTP ${status} exits 3`, async () => {
      postStatus = status;
      const dir = mkdir({ 'a.txt': 'hello-a' });
      const r = await qs(['filter', 'q?', 'a.txt'], { cwd: dir });
      assert.equal(r.code, 3, r.stderr);
      assert.match(r.stderr, msg);
    });
  }
  for (const [status, msg] of [[402, /credits/], [403, /rejected/], [500, /HTTP 500/]]) {
    test(`setup on HTTP ${status} exits 3`, async () => {
      verifyStatus = status;
      const r = await qs(['setup'], { env: { JEV_API_KEY: undefined }, input: 'ts-key\n' });
      assert.equal(r.code, 3, r.stderr);
      assert.match(r.stderr, msg);
      assert.deepEqual(readProviders().providers, [{ name: 'typesafe', base_url: BASE }]);
    });
  }
});

describe('review 2: --help/-h only as a real flag', () => {
  test('-h as the value of --state is sent, not treated as help', async () => {
    const r = await qs(['ask', 'q?', '--state', '-h']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(sent(), /"state":"-h"/);
  });

  test('-h after -- is an input path, not help', async () => {
    const r = await qs(['filter', 'q?', '--', '-h']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no such file or directory: -h/);
  });

  test('--labels -h is a label value, not help', async () => {
    const r = await qs(['classify', '--labels', '-h', 'x']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /2–255 labels/);
  });

  test('filter --help and filter -h still print help', async () => {
    for (const h of ['--help', '-h']) {
      const r = await qs(['filter', h]);
      assert.equal(r.code, 0);
      assert.match(r.stdout, /^quicksilver: hand bulk/);
    }
  });
});

describe('review 3: --provider= with no value', () => {
  test('exits 1', async () => {
    const dir = mkdir({ 'a.txt': 'hello-a' });
    const r = await qs(['filter', 'q?', 'a.txt', '--provider='], { cwd: dir });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /--provider needs a value/);
    assert.equal(reqs.length, 0);
  });
});

describe('review 4: installer passes --provider to its status pre-check', () => {
  test('a saved typesafe key does not count as ready for --provider openrouter', async () => {
    writeProviders([{ name: 'typesafe', base_url: BASE, api_key: KEY }]);
    const claude = fs.mkdtempSync(path.join(TMP, 'claude-'));
    const r = await runNode(BIN, ['install', '--provider', 'openrouter'], { env: { CLAUDE_CONFIG_DIR: claude, JEV_API_KEY: undefined } });
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /provider typesafe/);
    assert.match(r.stdout, /OPENROUTER_API_KEY/);
  });
});

describe('review 5: a model id is used only with the provider it fits', () => {
  test('an OpenRouter-style QUICKSILVER_MODEL is ignored on typesafe, with a warning', async () => {
    const dir = mkdir({ 'a.txt': 'hello-a' });
    const r = await qs(['filter', 'q?', 'a.txt'], { cwd: dir, env: { QUICKSILVER_MODEL: '~typesafe/jev-latest' } });
    assert.equal(r.code, 0, r.stderr);
    assert.match(sent(), /"model":"jev-latest"/);
    assert.match(r.stderr, /QUICKSILVER_MODEL/);
  });

  test('a providers.json model that does not fit the provider exits 1 naming the field', async () => {
    writeProviders([{ name: 'typesafe', base_url: BASE, model: 'vendor/other-model' }]);
    const dir = mkdir({ 'a.txt': 'hello-a' });
    const r = await qs(['filter', 'q?', 'a.txt'], { cwd: dir });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /"model" .*vendor\/other-model.*model_pattern/);
    assert.equal(reqs.length, 0);
  });

  test('a providers.json model that fits is sent', async () => {
    writeProviders([{ name: 'typesafe', base_url: BASE, model: 'jev-saved' }]);
    const dir = mkdir({ 'a.txt': 'hello-a' });
    const r = await qs(['filter', 'q?', 'a.txt'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.match(sent(), /"model":"jev-saved"/);
  });

  test('a fitting QUICKSILVER_MODEL is used silently', async () => {
    const dir = mkdir({ 'a.txt': 'hello-a' });
    const r = await qs(['filter', 'q?', 'a.txt'], { cwd: dir, env: { QUICKSILVER_MODEL: 'jev-fast' } });
    assert.equal(r.code, 0, r.stderr);
    assert.match(sent(), /"model":"jev-fast"/);
    assert.doesNotMatch(r.stderr, /warning/);
  });
});

describe('review 6: one saved key per provider, in providers.json', () => {
  test('setup stores a literal key on its own entry and keeps the other entries', async () => {
    writeProviders([{ name: 'typesafe', base_url: BASE }, { name: 'openrouter', api_key: 'or-key' }]);
    const r = await qs(['setup', '--provider', 'typesafe'], { env: { JEV_API_KEY: undefined }, input: 'ts-key\n' });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(readProviders(), { version: 1, providers: [{ name: 'typesafe', base_url: BASE, api_key: 'ts-key' }, { name: 'openrouter', api_key: 'or-key' }] });
    assert.doesNotMatch(r.stdout + r.stderr, /ts-key/);
  });

  test('setup --model saves the model on that entry; a model that does not fit is refused', async () => {
    const ok = await qs(['setup', '--provider', 'typesafe', '--model', 'jev-pinned'], { env: { JEV_API_KEY: undefined }, input: 'ts-key\n' });
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(readProviders().providers[0].model, 'jev-pinned');
    const bad = await qs(['setup', '--provider', 'typesafe', '--model', 'vendor/x'], { env: { JEV_API_KEY: undefined }, input: 'ts-key2\n' });
    assert.equal(bad.code, 1, bad.stderr);
    assert.equal(readProviders().providers[0].api_key, 'ts-key');
  });

  test('setup --remove removes only that entry\'s api_key', async () => {
    writeProviders([{ name: 'typesafe', base_url: BASE, api_key: 'ts-key' }, { name: 'openrouter', api_key: 'or-key' }]);
    const r = await qs(['setup', '--remove', '--provider', 'typesafe']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(readProviders().providers, [{ name: 'typesafe', base_url: BASE }, { name: 'openrouter', api_key: 'or-key' }]);
  });

  test('a saved literal key is used, and status names its source but never prints it', async () => {
    writeProviders([{ name: 'typesafe', base_url: BASE, api_key: 'ts-key' }]);
    const dir = mkdir({ 'a.txt': 'hello-a' });
    const r = await qs(['filter', 'q?', 'a.txt'], { cwd: dir, env: { JEV_API_KEY: undefined } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(reqs[0].auth, 'Bearer ts-key');
    const s = await qs(['status'], { env: { JEV_API_KEY: undefined } });
    assert.match(s.stdout, /typesafe +ready · key literal in providers\.json/);
    assert.doesNotMatch(s.stdout + s.stderr, /ts-key/);
  });
});

describe('--follow-symlinks: opt-in, still guarded', () => {
  let outside, repo;
  before(() => {
    outside = mkdir({ 'shared.txt': 'OUTSIDE-SHARED', 'id_rsa': 'PRIVATE-KEY-CONTENT' });
    repo = mkdir({ 'a.txt': 'inside-a' }, { git: true });
    fs.symlinkSync(path.join(outside, 'shared.txt'), path.join(repo, 'notes.txt'));
    fs.symlinkSync(path.join(outside, 'id_rsa'), path.join(repo, 'harmless.txt'));
    fs.symlinkSync(path.join(repo, 'a.txt'), path.join(repo, 'alias.txt'));
  });

  test('a link to a normal outside file is sent with the flag', async () => {
    const r = await qs(['filter', 'q?', '.', '--follow-symlinks'], { cwd: repo });
    assert.equal(r.code, 0, r.stderr);
    assert.match(sent(), /OUTSIDE-SHARED/);
  });

  test('QUICKSILVER_FOLLOW_SYMLINKS=1 works like the flag', async () => {
    const r = await qs(['filter', 'q?', '.'], { cwd: repo, env: { QUICKSILVER_FOLLOW_SYMLINKS: '1' } });
    assert.equal(r.code, 0, r.stderr);
    assert.match(sent(), /OUTSIDE-SHARED/);
  });

  test('a link whose target looks like a secret is still refused', async () => {
    const r = await qs(['filter', 'q?', '.', '--follow-symlinks'], { cwd: repo });
    assert.doesNotMatch(sent(), /PRIVATE-KEY-CONTENT/);
    assert.match(r.stdout, /harmless\.txt \(secret-like, never sent\)/);
  });

  test('a link and its target are sent once', async () => {
    await qs(['filter', 'q?', '.', '--follow-symlinks'], { cwd: repo });
    assert.equal(sent().match(/inside-a/g).length, 1);
  });

  test('a symlink loop terminates', async () => {
    const dir = mkdir({ 'sub/x.txt': 'loop-content' });
    fs.symlinkSync(dir, path.join(dir, 'sub', 'back'));
    const r = await qs(['filter', 'q?', 'sub', '--follow-symlinks'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(sent().match(/loop-content/g).length, 1);
  });
});

describe('installer: stale files and dev install script', () => {
  test('install replaces the old skill copy, so stale files do not linger', async () => {
    const claude = fs.mkdtempSync(path.join(TMP, 'claude-'));
    const stale = path.join(claude, 'skills', 'quicksilver', 'scripts', 'stale.mjs');
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, '');
    const r = await runNode(BIN, ['install'], { env: { CLAUDE_CONFIG_DIR: claude } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fs.existsSync(stale), false);
    assert.ok(fs.existsSync(path.join(claude, 'skills', 'quicksilver', 'scripts', 'qs.mjs')));
  });

  const devInstall = (dir, args = []) => new Promise((resolve) => {
    const child = spawn('sh', [path.join(ROOT, 'install-dev.sh'), '--dry-run', ...args], { env: { PATH: process.env.PATH, HOME: QHOME, QUICKSILVER_DEV_DIR: dir } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });
  const clone = (origin, branch) => {
    const dir = mkdir({ 'f.txt': 'x' }, { git: true });
    const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, stdio: 'ignore' });
    g('checkout', '-q', '-b', branch); g('add', 'f.txt'); g('commit', '-q', '-m', 'x'); g('remote', 'add', 'origin', origin);
    return dir;
  };

  test('install-dev.sh accepts an SSH clone of the fork', async () => {
    const r = await devInstall(clone('git@github.com:Emasoft/quicksilver.git', 'main'));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /would run: git .* pull --ff-only/);
  });

  test('install-dev.sh refuses a clone that is not on main', async () => {
    const r = await devInstall(clone('https://github.com/Emasoft/quicksilver.git', 'feature'));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /not on main/);
  });
});

describe('nit: a scanned repo cannot run code through its own git config', () => {
  test('core.fsmonitor in the scanned repo is not executed', async () => {
    const repo = mkdir({ 'a.txt': 'inside-a' }, { git: true });
    const marker = path.join(repo, 'PWNED');
    const hook = path.join(TMP, `fsmonitor-${path.basename(repo)}.sh`);
    fs.writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
    execFileSync('git', ['config', 'core.fsmonitor', hook], { cwd: repo });
    const r = await qs(['filter', 'q?', '.'], { cwd: repo });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fs.existsSync(marker), false);
  });
});

describe('--max-bytes: the per-input cap is configurable', () => {
  test('--max-bytes 10 refuses an 11-byte stdin without a request', async () => {
    const r = await qs(['filter', 'q?', '-', '--max-bytes', '10'], { input: 'x'.repeat(11) });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /stdin is over 10 bytes/);
    assert.equal(reqs.length, 0);
  });

  test('without --max-bytes a stdin over the old 2 MB cap is read, all of it', async () => {
    const n = 2 * 1024 * 1024 + 1;
    const r = await qs(['filter', 'q?', '-'], { input: 'x'.repeat(n) });
    assert.equal(r.code, 0, r.stderr);
    // one line, so hard 60000-char chunks that each restart 500 chars back
    assert.equal(reqs.length, Math.ceil((n - 500) / 59500));
  });

  test('a stdin over the 100 MB hard cap exits 1 without a request', async () => {
    const r = await qs(['filter', 'q?', '-'], { input: Buffer.alloc(100 * 1024 * 1024 + 1, 120) });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /stdin is over 100 MB/);
    assert.equal(reqs.length, 0);
  });

  test('--max-bytes and QUICKSILVER_MAX_BYTES above the 100 MB hard cap exit 1', async () => {
    const dir = mkdir({ 'a.txt': 'hello-a' });
    const a = await qs(['filter', 'q?', 'a.txt', '--max-bytes', String(100 * 1024 * 1024 + 1)], { cwd: dir });
    assert.equal(a.code, 1, a.stderr);
    assert.match(a.stderr, /--max-bytes .*104857600/);
    const b = await qs(['filter', 'q?', 'a.txt'], { cwd: dir, env: { QUICKSILVER_MAX_BYTES: String(100 * 1024 * 1024 + 1) } });
    assert.equal(b.code, 1, b.stderr);
    assert.match(b.stderr, /QUICKSILVER_MAX_BYTES .*104857600/);
    assert.equal(reqs.length, 0);
  });

  test('--max-bytes beats QUICKSILVER_MAX_BYTES, and a scanned file over it is skipped', async () => {
    const dir = mkdir({ 'a.txt': 'small', 'b.txt': 'x'.repeat(50) });
    const r = await qs(['filter', 'q?', 'a.txt', 'b.txt', '--max-bytes', '20'], { cwd: dir, env: { QUICKSILVER_MAX_BYTES: '1000' } });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /b\.txt \(binary or over 20 bytes\)/);
    assert.equal(reqs.length, 1);
  });

  test('invalid --max-bytes and QUICKSILVER_MAX_BYTES exit 1 naming them', async () => {
    const dir = mkdir({ 'a.txt': 'hello-a' });
    const a = await qs(['filter', 'q?', 'a.txt', '--max-bytes', '0'], { cwd: dir });
    assert.equal(a.code, 1);
    assert.match(a.stderr, /--max-bytes/);
    const b = await qs(['filter', 'q?', 'a.txt'], { cwd: dir, env: { QUICKSILVER_MAX_BYTES: 'lots' } });
    assert.equal(b.code, 1);
    assert.match(b.stderr, /QUICKSILVER_MAX_BYTES/);
    assert.equal(reqs.length, 0);
  });
});

describe('chunking: a long item is split, never truncated', () => {
  // 100 numbered lines of 50 chars = 5000 chars; with --chunk-chars 2000 and the 500-char overlap that is 3 chunks.
  const lines = (marker = '') => Array.from({ length: 100 }, (_, i) => `CHUNKTEST line ${String(i + 1).padStart(3, '0')} ${i === 49 ? marker.padEnd(26, '.') : '.'.repeat(26)}`);
  const contents = () => reqs.map((r) => JSON.parse(r.body).state).map((s) => (typeof s === 'string' ? s : JSON.stringify(s))).join('\n');

  test('filter: only the middle of 3 chunks matches, the item is found once, every line is sent', async () => {
    const dir = mkdir({ 'big.txt': lines('NEEDLE').join('\n') });
    const r = await qs(['filter', 'q?', 'big.txt', '--chunk-chars', '2000', '--json'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(reqs.length, 3);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.matched.map((m) => [m.id, m.p, m.chunks]), [['big.txt', 0.95, 3]]);
    for (const l of lines('NEEDLE')) assert.ok(contents().includes(l), `not sent: ${l}`);
    for (const r2 of reqs) assert.ok(JSON.parse(r2.body).state.content.length <= 2000);
  });

  test('filter text output names the chunk count and the best line range', async () => {
    const dir = mkdir({ 'big.txt': lines('NEEDLE').join('\n') });
    const r = await qs(['filter', 'q?', 'big.txt', '--chunk-chars', '2000'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^0\.95 {2}big\.txt \(3 chunks, best lines \d+-\d+\)$/m);
  });

  test('a 70k-char item is sent whole in 2 chunks at the default chunk size', async () => {
    const text = Array.from({ length: 1400 }, (_, i) => `row ${i} ${'y'.repeat(45)}`).join('\n');
    const dir = mkdir({ 'a.txt': text });
    const r = await qs(['filter', 'q?', 'a.txt', '--json'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(reqs.length, 2);
    assert.ok(contents().includes('row 0 ') && contents().includes('row 1399 '));
    assert.equal(JSON.parse(r.stdout).matched[0].chunks, 2);
  });

  // 60 lines (2 chunks at --chunk-chars 2000); NEEDLE, when given, only in line 2, i.e. only in the first chunk.
  const sixty = (needle) => Array.from({ length: 60 }, (_, i) => `CHUNKTEST line ${String(i + 1).padStart(3, '0')} ${i === 1 && needle ? 'NEEDLE'.padEnd(26, '.') : '.'.repeat(26)}`).join('\n');

  test('classify: the most confident chunk decides the label, and its line range is reported', async () => {
    // second chunk: second-to-last line, so the deciding chunk is the later one
    const text = sixty(false).split('\n').map((l, i) => (i === 58 ? l.replace('.'.repeat(6), 'NEEDLE') : l)).join('\n');
    const dir = mkdir({ 'a.txt': text });
    const r = await qs(['classify', '--labels', 'a,b', 'a.txt', '--chunk-chars', '2000', '--json'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(reqs.length, 2);
    const [row] = JSON.parse(r.stdout);
    // chunk 1 says b at 0.8, chunk 2 (with NEEDLE) says a at 0.9: the more confident chunk wins, no averaging
    assert.deepEqual([row.label, row.confidence, row.probabilities, row.chunks], ['a', 0.9, { a: 0.9, b: 0.1 }, 2]);
    assert.ok(row.best_lines[0] > 1 && row.best_lines[1] === 60, String(row.best_lines));
  });

  test('classify: equally confident chunks go to the earliest one', async () => {
    const dir = mkdir({ 'a.txt': sixty(false) });
    const r = await qs(['classify', '--labels', 'a,b', 'a.txt', '--chunk-chars', '2000', '--json'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    const [row] = JSON.parse(r.stdout);
    assert.equal(row.label, 'b');
    assert.equal(row.best_lines[0], 1);
  });

  test('ask --score: the highest-scoring chunk decides', async () => {
    const dir = mkdir({ 'doc.txt': sixty(true) });
    const r = await qs(['ask', 'q?', '--state', '@doc.txt', '--score', 'low|mid|high|max|top', '--chunk-chars', '2000', '--json'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.answers.answer.score, 4);
    assert.equal(out.answers.answer.best_lines[0], 1);
  });

  test('rank: relevance is the max over chunks', async () => {
    const dir = mkdir({ 'big.txt': lines('NEEDLE').join('\n') });
    const r = await qs(['rank', 'q', 'big.txt', '--chunk-chars', '2000', '--json'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).map((x) => [x.id, x.relevance, x.chunks]), [['big.txt', 1, 3]]);
  });

  test('ask --state over a long document is chunked; noul is the max over chunks', async () => {
    const dir = mkdir({ 'doc.txt': lines('NEEDLE').join('\n') });
    const r = await qs(['ask', 'q?', '--state', '@doc.txt', '--chunk-chars', '2000', '--json'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(reqs.length, 3);
    const out = JSON.parse(r.stdout);
    assert.equal(out.answers.answer.noul, 0.95);
    assert.equal(out.chunks, 3);
  });

  test('ask spec with a large array state is split into groups of whole elements', async () => {
    const state = Array.from({ length: 3 }, (_, i) => `CHUNKTEST element ${i} ${'z'.repeat(800)}`);
    const dir = mkdir({ 'spec.json': JSON.stringify({ state, questions: { q: { type: 'noul', instructions: 'q?' } } }) });
    const r = await qs(['ask', 'spec.json', '--chunk-chars', '2000', '--json'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(reqs.length, 2);
    assert.ok(reqs.every((q) => Array.isArray(JSON.parse(q.body).state)));
    assert.equal(JSON.parse(r.stdout).chunks, 2);
  });

  test('ask spec whose single JSON field is larger than a chunk exits 1', async () => {
    const dir = mkdir({ 'spec.json': JSON.stringify({ state: { doc: 'w'.repeat(3000) }, questions: { q: { type: 'noul', instructions: 'q?' } } }) });
    const r = await qs(['ask', 'spec.json', '--chunk-chars', '2000'], { cwd: dir });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /chunk/);
    assert.equal(reqs.length, 0);
  });

  test('find: a line longer than a chunk is split, and no request exceeds the chunk size', async () => {
    const dir = mkdir({ 'm.js': `short line\n${'q'.repeat(5000)}\nlast line` });
    const r = await qs(['find', 'q', 'm.js', '--chunk-chars', '2000'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    let sentQ = 0;
    for (const q of reqs) {
      const ls = Object.values(JSON.parse(q.body).state.lines);
      assert.ok(ls.join('').length <= 2000);
      sentQ += ls.join('').split('q').length - 1;
    }
    assert.ok(sentQ >= 5000, `only ${sentQ} of 5000 chars sent`);
  });

  test('--chunk-chars outside 1000..90000 and a bad QUICKSILVER_CHUNK_CHARS exit 1', async () => {
    const dir = mkdir({ 'a.txt': 'hello-a' });
    for (const v of ['999', '90001']) {
      const r = await qs(['filter', 'q?', 'a.txt', '--chunk-chars', v], { cwd: dir });
      assert.equal(r.code, 1, r.stderr);
      assert.match(r.stderr, /--chunk-chars/);
    }
    const b = await qs(['filter', 'q?', 'a.txt'], { cwd: dir, env: { QUICKSILVER_CHUNK_CHARS: '100' } });
    assert.equal(b.code, 1);
    assert.match(b.stderr, /QUICKSILVER_CHUNK_CHARS/);
    assert.equal(reqs.length, 0);
  });
});

// A second System One provider served by the same mock, told apart by its key and model.
const mock2 = (extra = {}) => ({ name: 'mock2', base_url: BASE, path: '/v1/systemone', adapter: 'system-one', api_key: '$MOCK2_KEY', model: 'm2', ...extra });

describe('providers.json: the array order is the chain', () => {
  test('no file: the built-in chain is openrouter, typesafe, compatible; keys missing means exit 3', async () => {
    fs.rmSync(path.join(QHOME, 'providers.json'));
    const r = await qs(['status'], { env: { JEV_API_KEY: undefined } });
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /^1\. openrouter +key missing \(\$OPENROUTER_API_KEY\)$/m);
    assert.match(r.stdout, /^2\. typesafe +key missing \(\$JEV_API_KEY, \$TYPESAFE_API_KEY\)$/m);
    assert.match(r.stdout, /^3\. compatible +not configured \(no base_url\)$/m);
  });

  test('file entries come first, in file order, then the built-ins the file does not name', async () => {
    writeProviders([mock2(), { name: 'typesafe', base_url: BASE }]);
    const r = await qs(['status'], { env: { MOCK2_KEY: 'k2' } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^1\. mock2 +ready \(key not verified: no free check\) · key \$MOCK2_KEY · model m2$/m);
    assert.match(r.stdout, /^2\. typesafe +ready · key \$JEV_API_KEY · model jev-latest$/m);
    assert.match(r.stdout, /^3\. openrouter /m);
    assert.match(r.stdout, /^4\. compatible /m);
  });

  test('requests go to the first ready provider', async () => {
    writeProviders([mock2(), { name: 'typesafe', base_url: BASE }]);
    const dir = mkdir({ 'a.txt': 'hello-a' });
    const r = await qs(['filter', 'q?', 'a.txt'], { cwd: dir, env: { MOCK2_KEY: 'k2' } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(reqs[0].auth, 'Bearer k2');
    assert.match(sent(), /"model":"m2"/);
    assert.match(r.stdout, /via mock2 \(mock\)/);
  });

  test('a provider whose key variable is unset is skipped silently', async () => {
    writeProviders([mock2(), { name: 'typesafe', base_url: BASE }]);
    const dir = mkdir({ 'a.txt': 'hello-a' });
    const r = await qs(['filter', 'q?', 'a.txt'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.equal(reqs[0].auth, `Bearer ${KEY}`);
    assert.equal(fs.existsSync(path.join(QHOME, 'errors.log')), false);
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal ${NAME} reference is what is tested
  test('${VAR} works, and in an array the first set value wins', async () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: same
    writeProviders([mock2({ api_key: ['$UNSET_ONE', '${MOCK2_KEY}'] })]);
    const dir = mkdir({ 'a.txt': 'hello-a' });
    const r = await qs(['filter', 'q?', 'a.txt'], { cwd: dir, env: { MOCK2_KEY: 'k2' } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(reqs[0].auth, 'Bearer k2');
  });

  test('OPENROUTER_API_KEY no longer jumps the queue: the file order decides', async () => {
    writeProviders([{ name: 'typesafe', base_url: BASE }, { name: 'openrouter', base_url: BASE }]);
    const dir = mkdir({ 'a.txt': 'hello-a' });
    const r = await qs(['filter', 'q?', 'a.txt'], { cwd: dir, env: { OPENROUTER_API_KEY: 'sk-or-x' } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(reqs[0].auth, `Bearer ${KEY}`);
  });

  test('--provider and QUICKSILVER_PROVIDER pin one provider', async () => {
    writeProviders([{ name: 'openrouter', base_url: BASE }, { name: 'typesafe', base_url: BASE }]);
    const dir = mkdir({ 'a.txt': 'hello-a' });
    await qs(['filter', 'q?', 'a.txt'], { cwd: dir, env: { OPENROUTER_API_KEY: 'sk-or-x' } });
    await qs(['filter', 'q?', 'a.txt', '--provider', 'typesafe'], { cwd: dir, env: { OPENROUTER_API_KEY: 'sk-or-x' } });
    await qs(['filter', 'q?', 'a.txt'], { cwd: dir, env: { OPENROUTER_API_KEY: 'sk-or-x', QUICKSILVER_PROVIDER: 'typesafe' } });
    assert.deepEqual(reqs.map((q) => q.auth), ['Bearer sk-or-x', `Bearer ${KEY}`, `Bearer ${KEY}`]);
  });

  test('a pinned provider without a key exits 3 naming every variable tried', async () => {
    writeProviders([mock2({ api_key: ['$MOCK2_KEY', '$MOCK2_ALT'] }), { name: 'typesafe', base_url: BASE }]);
    const dir = mkdir({ 'a.txt': 'hello-a' });
    for (const opts of [{ args: ['--provider', 'mock2'] }, { env: { QUICKSILVER_PROVIDER: 'mock2' } }]) {
      const r = await qs(['filter', 'q?', 'a.txt', ...(opts.args || [])], { cwd: dir, env: opts.env });
      assert.equal(r.code, 3, r.stderr);
      assert.match(r.stderr, /mock2.*\$MOCK2_KEY, \$MOCK2_ALT/);
    }
    assert.equal(reqs.length, 0);
  });

  test('a pinned disabled provider and an unknown provider exit 1', async () => {
    writeProviders([{ name: 'typesafe', base_url: BASE, enabled: false }]);
    const dir = mkdir({ 'a.txt': 'hello-a' });
    const d = await qs(['filter', 'q?', 'a.txt', '--provider', 'typesafe'], { cwd: dir });
    assert.equal(d.code, 1, d.stderr);
    assert.match(d.stderr, /typesafe.*disabled/);
    const u = await qs(['filter', 'q?', 'a.txt', '--provider', 'nope'], { cwd: dir });
    assert.equal(u.code, 1, u.stderr);
    assert.match(u.stderr, /unknown provider "nope"/);
    assert.equal(reqs.length, 0);
  });

  test('no usable provider at all exits 3 with what to set', async () => {
    const dir = mkdir({ 'a.txt': 'hello-a' });
    const r = await qs(['filter', 'q?', 'a.txt'], { cwd: dir, env: { JEV_API_KEY: undefined } });
    assert.equal(r.code, 3, r.stderr);
    assert.match(r.stderr, /no provider is ready.*\$OPENROUTER_API_KEY/s);
    assert.equal(reqs.length, 0);
  });
});

describe('providers.json: "enabled" and its synonyms', () => {
  const on = [true, 1, 'true', 'TRUE', 'enabled', 'enable', '1', 'yes', 'y', 'Active', 'on'];
  const off = [false, 0, 'false', 'disabled', 'disable', '0', 'no', 'N', 'inactive', 'OFF'];
  for (const [vals, want] of [[on, 'ready'], [off, 'disabled']]) {
    test(`${vals.map(String).join(', ')} mean ${want}`, async () => {
      for (const v of vals) {
        writeProviders([{ name: 'typesafe', base_url: BASE, enabled: v }]);
        const r = await qs(['status']);
        assert.match(r.stdout, new RegExp(`^1\\. typesafe +${want}`, 'm'), `enabled: ${JSON.stringify(v)}\n${r.stdout}${r.stderr}`);
      }
    });
  }

  test('any other value exits 1 naming the provider and the value', async () => {
    writeProviders([{ name: 'typesafe', base_url: BASE, enabled: 'maybe' }]);
    const r = await qs(['status']);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /"typesafe".*"enabled".*"maybe"/);
  });
});

describe('providers.json: strict validation, exit 1 naming the field', () => {
  // thunks: BASE (inside mock2) is only known once the mock server listens
  const cases = [
    ['version 2', () => ({ version: 2, providers: [] }), /"version" must be 1/],
    ['unknown top-level field', () => ({ version: 1, providers: [], extra: 1 }), /unknown field "extra"/],
    ['providers not an array', () => ({ version: 1, providers: {} }), /"providers" must be an array/],
    ['unknown entry field', () => [{ name: 'typesafe', colour: 'red' }], /"typesafe".*unknown field "colour"/],
    ['bad adapter', () => [mock2({ adapter: 'soap' })], /"adapter" must be one of/],
    ['new provider without a model', () => [{ name: 'x1', base_url: BASE, path: '/p', adapter: 'system-one', api_key: '$X' }], /"x1".*"model" is required/],
    ['duplicate name', () => [{ name: 'typesafe' }, { name: 'typesafe' }], /duplicate name "typesafe"/],
    ['bad name', () => [{ name: 'Bad Name' }], /"name" must be/],
    ['bad $ reference', () => [mock2({ api_key: '$1BAD' })], /"api_key".*\$NAME/],
    ['empty api_key array', () => [mock2({ api_key: [] })], /"api_key" must be/],
    ['secret header', () => [mock2({ headers: { 'X-Api-Key': 'v' } })], /header "X-Api-Key"/],
    ['same $VAR in two providers', () => [mock2({ api_key: '$JEV_API_KEY' })], /\$JEV_API_KEY.*"mock2".*"typesafe"/],
    ['invalid model_pattern', () => [mock2({ model_pattern: '(' })], /"model_pattern"/],
    ['path without a leading slash', () => [mock2({ path: 'v1' })], /"path" must start with \//],
    ['negative usd_per_mtok', () => [mock2({ usd_per_mtok: -1 })], /"usd_per_mtok"/],
    ['base_url with a query', () => [mock2({ base_url: `${BASE}?x=1` })], /"base_url" must not hold/],
  ];
  for (const [name, make, re] of cases) {
    test(name, async () => {
      const doc = make();
      writeProviders(null, { raw: JSON.stringify(Array.isArray(doc) ? { version: 1, providers: doc } : doc) });
      const dir = mkdir({ 'a.txt': 'hello-a' });
      const r = await qs(['filter', 'q?', 'a.txt'], { cwd: dir, env: { MOCK2_KEY: 'k2' } });
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.match(r.stderr, re);
      assert.equal(reqs.length, 0);
    });
  }
});

describe('providers.json: where it is read from, and what replaced config.json', () => {
  test('a literal key in a file other users can read is refused with the chmod fix', async () => {
    writeProviders([{ name: 'typesafe', base_url: BASE, api_key: 'sk-literal-1' }], { mode: 0o644 });
    const r = await qs(['status']);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /chmod 600 .*providers\.json/);
    assert.doesNotMatch(r.stdout + r.stderr, /sk-literal-1/);
  });

  test('providers.json in the working directory is never read', async () => {
    const dir = mkdir({ 'a.txt': 'hello-a', 'providers.json': JSON.stringify({ version: 1, providers: [{ name: 'typesafe', enabled: false }] }) });
    const r = await qs(['filter', 'q?', 'a.txt'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(reqs.length, 1);
  });

  test('a relative QUICKSILVER_HOME exits 1', async () => {
    const r = await qs(['status'], { env: { QUICKSILVER_HOME: 'rel/home' } });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /QUICKSILVER_HOME must be an absolute path/);
  });

  test('an old config.json exits 1 saying what to move, without printing the key', async () => {
    fs.writeFileSync(path.join(QHOME, 'config.json'), JSON.stringify({ provider: 'typesafe', model: 'jev-x', keys: { typesafe: 'sk-LEGACY-SECRET' } }));
    const dir = mkdir({ 'a.txt': 'hello-a' });
    const r = await qs(['filter', 'q?', 'a.txt'], { cwd: dir });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /config\.json is no longer read/);
    assert.match(r.stderr, /providers\.json/);
    assert.match(r.stderr, /key.* typesafe/);
    assert.match(r.stderr, /model "jev-x"/);
    assert.doesNotMatch(r.stderr, /SECRET/);
    assert.equal(reqs.length, 0);
  });

  test('status: a rejected key and an empty wallet are named, and exit 3 when nothing is ready', async () => {
    for (const [code, want] of [[401, /typesafe +rejected \(HTTP 401\)/], [402, /typesafe +no credits \(HTTP 402\)/]]) {
      verifyStatus = code;
      const r = await qs(['status']);
      assert.equal(r.code, 3, r.stdout + r.stderr);
      assert.match(r.stdout, want);
    }
  });
});
