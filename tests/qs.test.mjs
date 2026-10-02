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
let server, port, BASE, TMP, QHOME;

function mockAnswer(body) {
  const answers = {};
  for (const [k, q] of Object.entries(body.questions || {})) {
    // choice answers must name real criteria keys (find looks the chosen line number up)
    const [c0, c1] = q.criteria && !Array.isArray(q.criteria) ? Object.keys(q.criteria) : ['a', 'b'];
    answers[k] = { type: q.type, noul: 0.9, choice: c0, confidence: 0.9, probabilities: { [c0]: 0.9, [c1]: 0.1 }, score: 3 };
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

beforeEach(() => {
  reqs.length = 0;
  verifyStatus = 200;
  QHOME = fs.mkdtempSync(path.join(TMP, 'home-'));
});

// Minimal child env, built from scratch so the developer's real keys never reach the child.
function childEnv(extra) {
  const env = {
    PATH: process.env.PATH, HOME: QHOME, QUICKSILVER_HOME: QHOME,
    JEV_API_KEY: KEY, QUICKSILVER_API_BASE: BASE, QUICKSILVER_PROVIDER: 'typesafe', ...extra,
  };
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
    ['--threshold', 'abc'], ['--threshold', '1.5'], ['--band', '-0.1'], ['--max-chars', '0'], ['--width', 'x'],
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

describe('m2: QUICKSILVER_API_BASE must be https off localhost', () => {
  test('plain http to a non-localhost host exits 1 before sending the key', async () => {
    const dir = mkdir({ 'a.txt': 'hello-a' });
    const r = await qs(['filter', 'q?', 'a.txt'], { cwd: dir, env: { QUICKSILVER_API_BASE: `http://[::ffff:127.0.0.1]:${port}` } });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /QUICKSILVER_API_BASE/);
    assert.equal(reqs.length, 0);
  });

  test('plain http to localhost is allowed', async () => {
    const dir = mkdir({ 'a.txt': 'hello-a' });
    const r = await qs(['filter', 'q?', 'a.txt'], { cwd: dir, env: { QUICKSILVER_API_BASE: `http://localhost:${port}` } });
    assert.equal(r.code, 0, r.stderr);
  });
});

describe('m3: the installer detects an exported key instead of asking for one', () => {
  test('exported JEV_API_KEY: install reports it and skips setup, even if the key check fails', async () => {
    verifyStatus = 401;
    const claude = fs.mkdtempSync(path.join(TMP, 'claude-'));
    const r = await runNode(BIN, ['install', '--provider', 'typesafe'], { env: { CLAUDE_CONFIG_DIR: claude } });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout + r.stderr, /env JEV_API_KEY/);
    assert.doesNotMatch(r.stdout, /set your Jev key|paste your/i);
    assert.equal(fs.existsSync(path.join(QHOME, 'config.json')), false);
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
  test('corrupt config.json exits 1 before any request', async () => {
    fs.writeFileSync(path.join(QHOME, 'config.json'), '{bad');
    const dir = mkdir({ 'a.txt': 'hello-a' });
    const r = await qs(['filter', 'q?', 'a.txt'], { cwd: dir });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /config\.json/);
    assert.equal(reqs.length, 0);
  });

  test('setup --remove refuses to overwrite a corrupt config', async () => {
    fs.writeFileSync(path.join(QHOME, 'config.json'), '{bad');
    const r = await qs(['setup', '--remove']);
    assert.equal(r.code, 1);
    assert.equal(fs.readFileSync(path.join(QHOME, 'config.json'), 'utf8'), '{bad');
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
