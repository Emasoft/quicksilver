// The docs cannot drift from the code. HELP is built from qs.mjs's own constants; SKILL.md embeds HELP verbatim
// (scripts/sync-skill-help.mjs); and every option, environment variable and exit code that HELP, README.md or
// SKILL.md names is checked here against what qs.mjs actually accepts, reads and returns.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HELP, OPTIONS, BUILTINS, FIELDS, TRUE_WORDS, FALSE_WORDS, EXIT, EXIT_MEANING } from '../skills/quicksilver/scripts/qs.mjs';
import { render, liveHelp, SKILL } from '../scripts/sync-skill-help.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QS = path.join(ROOT, 'skills', 'quicksilver', 'scripts', 'qs.mjs');
const README = path.join(ROOT, 'README.md');
const read = (f) => fs.readFileSync(f, 'utf8');
const SRC = read(QS);
const DOCS = { 'README.md': read(README), 'SKILL.md': read(SKILL) };

// --name at a word start: not "one--liner" in a badge URL, not the bare "--" that ends options.
const flagsIn = (text) => new Set([...text.matchAll(/(?<![\w-])--([a-z][a-z0-9-]*)/g)].map((m) => m[1]));
// An environment-variable-shaped name: capitals and digits with at least one underscore.
const envIn = (text) => new Set(text.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? []);
const minus = (a, b) => [...a].filter((x) => !b.has(x)).sort();
const varsOf = (cred) => [cred].flat().filter((s) => typeof s === 'string' && s.startsWith('$')).map((s) => s.replace(/^\$\{?|\}$/g, ''));

// Names the docs use that belong to another program, each found in that program's own source (or, for null, an
// example that is not a variable or flag of any program).
const INSTALLER = read(path.join(ROOT, 'install-dev.sh')) + read(path.join(ROOT, 'bin', 'quicksilver.mjs'));
const FOREIGN_FLAGS = { 'dry-run': INSTALLER, key: INSTALLER, format: null /* `git log --format=%s` in an example */ };
const FOREIGN_ENV = {
  QUICKSILVER_DEV_DIR: INSTALLER,
  MY_PROXY_KEY: null, // README: a user's own $VAR in the providers.json example
  YOUR_JEV_KEY: null, // README: the placeholder in `install --key YOUR_JEV_KEY`
};

// Every environment variable qs.mjs reads: process.env.X, the names flagOrEnv() is given, and the $VARs of the
// built-in providers (resolveCred reads process.env[name] for them).
function envRead() {
  const names = new Set([...SRC.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]));
  for (const m of SRC.matchAll(/flagOrEnv\([^)]*'([A-Z][A-Z0-9_]*)'/g)) names.add(m[1]);
  for (const b of BUILTINS) for (const v of [...varsOf(b.api_key), ...varsOf(b.account_id)]) names.add(v);
  return names;
}

// The top-level arguments of every call `name(...)` in src. Strings, template literals (with nested ${...}) and
// brackets are tracked, so a comma inside a message or in clip(text, 300) never splits or ends an argument: a
// line regex cannot tell die(`...${clip(x, 400)}`) from die(msg, 4).
function callArgs(src, name) {
  const calls = [];
  for (const m of src.matchAll(new RegExp(`(?<![\\w.])${name.replace('.', '\\.')}\\(`, 'g'))) {
    const args = [], stack = [')'];
    let arg = '';
    for (let i = m.index + m[0].length; i < src.length && stack.length; i++) {
      const c = src[i], top = stack.at(-1);
      if (top === "'" || top === '"' || top === '`') {
        if (c === '\\') { arg += c + src[++i]; continue; }
        if (c === top) stack.pop();
        else if (top === '`' && c === '$' && src[i + 1] === '{') { stack.push('}'); arg += '${'; i++; continue; }
      } else if (c === top) { stack.pop(); if (!stack.length) break; }
      else if (c === "'" || c === '"' || c === '`') stack.push(c);
      else if (c === '(') stack.push(')');
      else if (c === '[') stack.push(']');
      else if (c === '{') stack.push('}');
      else if (c === ',' && stack.length === 1) { args.push(arg.trim()); arg = ''; continue; }
      arg += c;
    }
    if (arg.trim()) args.push(arg.trim());
    calls.push(args);
  }
  return calls;
}

// Line-by-line difference, so a stale block names the lines to look at instead of two walls of text.
function lineDiff(have, want) {
  const a = have.split('\n'), b = want.split('\n'), out = [];
  for (let i = 0; i < Math.max(a.length, b.length) && out.length < 40; i++) {
    if (a[i] !== b[i]) out.push(`line ${i + 1}\n  - ${a[i] ?? '(missing)'}\n  + ${b[i] ?? '(missing)'}`);
  }
  return out.join('\n');
}

const run = (args, env = {}) => spawnSync(process.execPath, [QS, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });

describe('SKILL.md embeds the live qs help', () => {
  test('the block between the qs-help markers is exactly `node qs.mjs help`', () => {
    const skill = read(SKILL), want = render(skill, liveHelp());
    if (skill !== want) assert.fail(`SKILL.md's qs help block is stale; run: npm run sync-docs\n${lineDiff(skill, want)}`);
  });

  test('the imported HELP is the printed help, and syncing twice changes nothing', () => {
    assert.equal(liveHelp(), HELP);
    const once = render(read(SKILL), HELP);
    assert.equal(render(once, HELP), once);
  });

  test('a missing or doubled marker is an error, not a guess', () => {
    assert.throws(() => render('no markers here', HELP), /exactly once \(found 0\)/);
    assert.throws(() => render('<!-- qs-help:begin -->\n<!-- qs-help:begin -->\n<!-- qs-help:end -->', HELP), /found 2/);
  });
});

describe('HELP against the code', () => {
  test('HELP names exactly the options parseArgs accepts', () => {
    const named = flagsIn(HELP), accepted = new Set(Object.keys(OPTIONS));
    // HELP's examples may use another program's flag (`git log --format=%s`), never the installer's
    const other = new Set(Object.keys(FOREIGN_FLAGS).filter((f) => !FOREIGN_FLAGS[f]));
    assert.deepEqual(minus(accepted, named), [], 'accepted but missing from HELP');
    assert.deepEqual(minus(minus(named, accepted), other), [], 'in HELP but not accepted');
  });

  test("HELP's ENVIRONMENT names exactly the variables qs.mjs reads", () => {
    // A new dynamic read (process.env[x]) must be added to envRead() above, or it would go unchecked.
    assert.deepEqual([...new Set(SRC.match(/process\.env\[[^\]]*\]/g))].sort(), ['process.env[env]', 'process.env[name]']);
    const section = HELP.slice(HELP.indexOf('\nENVIRONMENT\n'), HELP.indexOf('\nEXIT CODES'));
    const named = envIn(section), readSet = envRead();
    assert.deepEqual(minus(readSet, named), [], 'read but missing from ENVIRONMENT');
    assert.deepEqual(minus(named, readSet), [], 'in ENVIRONMENT but never read');
  });

  test('every exit goes through EXIT, and HELP gives the meaning of each code', () => {
    // the exit code is die's 2nd argument, fail's 4th (kind, status, message, exit, hint), process.exit's 1st
    const sites = [['die', 1], ['fail', 3], ['process.exit', 0]].flatMap(([fn, at]) => callArgs(SRC, fn).map((a) => [fn, a[at]]));
    assert.ok(sites.length >= 30, `found only ${sites.length} exit sites: the scanner is broken`);
    assert.deepEqual(sites.filter(([, code]) => /^\d+$/.test(code ?? '')), [], 'a numeric exit code outside EXIT');
    assert.deepEqual(Object.keys(EXIT_MEANING).map(Number).sort((a, b) => a - b), Object.values(EXIT).sort((a, b) => a - b));
    for (const [code, what] of Object.entries(EXIT_MEANING)) assert.ok(HELP.includes(`${code} ${what}`), `EXIT CODES lacks ${code}`);
  });

  test('every line fits an 80-column terminal', () => {
    const wide = HELP.split('\n').filter((l) => l.length > 80);
    assert.deepEqual(wide, []);
  });
});

describe('README.md and SKILL.md against the code', () => {
  test('every --flag they mention is a qs option (or a named installer/git flag)', () => {
    for (const [name, text] of Object.entries(DOCS)) {
      const stray = minus(flagsIn(text), new Set([...Object.keys(OPTIONS), ...Object.keys(FOREIGN_FLAGS)]));
      assert.deepEqual(stray, [], `${name} mentions options qs does not accept`);
    }
    for (const [f, src] of Object.entries(FOREIGN_FLAGS)) if (src) assert.ok(src.includes(`--${f}`), `--${f} is not an installer flag any more`);
  });

  test('every environment variable they mention is one qs reads (or a named installer/example one)', () => {
    const known = new Set([...envRead(), ...Object.keys(FOREIGN_ENV)]);
    for (const [name, text] of Object.entries(DOCS)) assert.deepEqual(minus(envIn(text), known), [], `${name} mentions variables qs never reads`);
    for (const [v, src] of Object.entries(FOREIGN_ENV)) if (src) assert.ok(src.includes(v), `${v} is not read by the installer any more`);
  });

  test('every exit code they mention exists', () => {
    for (const [name, text] of Object.entries(DOCS)) {
      for (const m of text.matchAll(/\bexit(?: code)? (\d+)/gi)) assert.ok(m[1] in EXIT_MEANING, `${name}: "${m[0]}" is not an exit code`);
    }
  });

  test('README provider table: the built-ins in chain order, each with its variables in reading order', () => {
    const rows = [...DOCS['README.md'].matchAll(/^\| `([a-z][a-z0-9-]*)` \| ([^|]*) \|/gm)].filter((m) => BUILTINS.some((b) => b.name === m[1]));
    assert.deepEqual(rows.map((m) => m[1]), BUILTINS.map((b) => b.name));
    for (const [, name, cell] of rows) {
      const b = BUILTINS.find((x) => x.name === name);
      assert.deepEqual([...cell.matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map((m) => m[1]), [...varsOf(b.api_key), ...varsOf(b.account_id)], name);
    }
  });

  test('README field table: exactly the providers.json entry fields', () => {
    const lines = DOCS['README.md'].split('\n');
    const start = lines.indexOf('| Field | Meaning |');
    assert.ok(start >= 0, 'README has no "| Field | Meaning |" table');
    const rows = [];
    for (let i = start + 2; lines[i]?.startsWith('|'); i++) rows.push(lines[i].split('|')[1]);
    const named = new Set(rows.flatMap((c) => [...c.matchAll(/`([a-z_]+)`/g)].map((m) => m[1])));
    assert.deepEqual([...named].sort(), [...FIELDS].sort());
  });
});

describe('the option list is the contract', () => {
  test('an unknown option exits 1 naming it (a stale --max-chars no longer runs on defaults)', () => {
    const r = run(['filter', 'q?', 'a.txt', '--max-chars', '5']);
    assert.equal(r.status, EXIT.USAGE, r.stderr);
    assert.match(r.stderr, /unknown option --max-chars/);
  });

  test('--chunk above its documented maximum exits 1 instead of being cut silently', () => {
    const r = run(['find', 'q', 'a.txt', '--chunk', '251']);
    assert.equal(r.status, EXIT.USAGE, r.stderr);
    assert.match(r.stderr, /--chunk needs a whole number from 1 to 250/);
  });

  test('every "enabled" word HELP lists switches a provider on or off, in any case', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-docs-'));
    try {
      for (const [words, want] of [[TRUE_WORDS, 'key missing'], [FALSE_WORDS, 'disabled']]) {
        for (const w of [...words].flatMap((x) => [x, x.toUpperCase()])) {
          fs.writeFileSync(path.join(home, 'providers.json'), JSON.stringify({ version: 1, providers: [{ name: 'typesafe', base_url: 'https://127.0.0.1:9', enabled: w }] }));
          // no key in the environment: an enabled provider is "key missing" without any request being made
          const r = run(['status'], { HOME: home, QUICKSILVER_HOME: home });
          assert.match(r.stdout, new RegExp(`^1\\. typesafe +${want}`, 'm'), `enabled: ${w}\n${r.stdout}${r.stderr}`);
        }
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
