// Runs every situation through Quicksilver exactly as Claude would (human-readable output),
// scores it against ground truth, and records Jev cost + the tokens Claude would have to read.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// fileURLToPath decodes %20 and non-ASCII; URL.pathname kept them percent-encoded (audit m8).
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const QS = path.join(ROOT, '..', 'skills', 'quicksilver', 'scripts', 'qs.mjs');
const SKILL_TOKENS = Math.ceil(fs.readFileSync(path.join(ROOT, '..', 'skills', 'quicksilver', 'SKILL.md'), 'utf8').length / 4);
const TOOL_CALL_OVERHEAD = 40; // tokens for the tool-call wrapper around each command
const tok = (s) => Math.ceil(s.length / 4);
const only = process.argv.slice(2);

const statsFile = path.join(process.env.QUICKSILVER_HOME || path.join(process.env.HOME || process.env.USERPROFILE, '.quicksilver'), 'stats.json');
const jevTotal = () => { try { return JSON.parse(fs.readFileSync(statsFile, 'utf8')).jev_input_tokens; } catch { return 0; } };

// withSave: also write full per-item results via --save so scoring doesn't depend on the display format.
// Claude is charged only for the display output it would actually read.
const SAVE = path.join(ROOT, 'results', '.last-save.json');
function qs(dir, args, withSave = false) {
  const t0 = Date.now(), before = jevTotal();
  if (withSave) fs.rmSync(SAVE, { force: true });
  let r;
  for (let attempt = 1; attempt <= 3; attempt++) {
    r = spawnSync(process.execPath, [QS, ...args, ...(withSave ? ['--save', SAVE] : [])], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status === 0) break;
    console.error(`attempt ${attempt} failed (status ${r.status}, signal ${r.signal}): ${r.stderr || r.error}`);
  }
  if (r.status !== 0) throw new Error(`qs ${args.join(' ')} failed: ${r.stderr}`);
  const out = r.stdout.replace(/\n— full results saved to .*/, '');
  const cmd = `node qs.mjs ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`;
  const saved = withSave ? JSON.parse(fs.readFileSync(SAVE, 'utf8')) : null;
  return { out, saved, ms: Date.now() - t0, jev: jevTotal() - before, claudeTokens: tok(cmd) + tok(out) + TOOL_CALL_OVERHEAD };
}

const rows = (out) => out.split('\n').filter((l) => /^[ ?]?\d\.\d\d {2}/.test(l));
const idOf = (line) => line.replace(/^[ ?]?\d\.\d\d {2}/, '').split('  ')[0].replace(/~$/, '');
const lineNo = (id) => Number(id.split(':').pop());

function prf(pred, truth, neutral = []) {
  const T = new Set(truth.map(String)), N = new Set(neutral.map(String));
  const P = pred.map(String).filter((p) => !N.has(p));
  const tp = P.filter((p) => T.has(p)).length;
  const precision = P.length ? tp / P.length : 1, recall = T.size ? tp / T.size : 1;
  return { precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0, predicted: P.length, tp };
}

fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
const file = path.join(ROOT, 'results', 'quicksilver.json');
const results = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
for (const id of fs.readdirSync(path.join(ROOT, 'data')).filter((d) => /^s\d+$/.test(d)).sort()) {
  if (only.length && !only.includes(id)) continue;
  const dir = path.join(ROOT, 'data', id);
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'truth', id + '.json'), 'utf8'));
  const runs = [];
  let score;
  if (m.kind === 'filter-lines' || m.kind === 'filter-items' || m.kind === 'filter-files') {
    const args = ['filter', m.question, ...(m.kind === 'filter-items' ? ['--items', m.input] : [m.input]), ...(m.kind === 'filter-lines' ? ['--lines'] : [])];
    const r = qs(dir, args, true); runs.push(r);
    const matched = r.saved.filter((x) => x.p >= 0.5).map((x) => x.id);
    const pred = m.kind === 'filter-lines' ? matched.map(lineNo) : matched;
    score = prf(pred, m.truth, m.neutral);
    score.metric = 'F1';
    score.value = score.f1;
  } else if (m.kind === 'classify') {
    const labels = m.labelDescriptions
      ? Object.entries(m.labelDescriptions).map(([k, v]) => `${k}:${v.replace(/,/g, ';')}`).join(',')
      : m.labels.join(',');
    const r = qs(dir, ['classify', '--labels', labels, '--question', m.question, '--items', m.input], true); runs.push(r);
    const pred = Object.fromEntries(r.saved.map((x) => [x.id, x.label]));
    const ids = Object.keys(m.truth);
    const correct = ids.filter((k) => pred[k] === m.truth[k]).length;
    score = { metric: 'accuracy', value: correct / ids.length, correct, total: ids.length };
  } else if (m.kind === 'find') {
    let hits1 = 0, hits5 = 0;
    for (const [name, q] of Object.entries(m.queries)) {
      const r = qs(dir, ['find', q, m.input, '--top', '5']); runs.push(r);
      const [lo, hi] = m.truth[name];
      const got = rows(r.out).map((l) => lineNo(idOf(l)));
      const inRange = got.map((n) => n >= lo && n <= hi);
      if (inRange[0]) hits1++;
      if (inRange.some(Boolean)) hits5++;
    }
    const n = Object.keys(m.queries).length;
    score = { metric: 'hit@5', value: hits5 / n, hit1: hits1 / n, hit5: hits5 / n };
  } else if (m.kind === 'rank') {
    let hits1 = 0, hits3 = 0;
    for (const [qid, q] of Object.entries(m.queries)) {
      const r = qs(dir, ['rank', q, m.input, '--top', '3']); runs.push(r);
      const got = rows(r.out).map(idOf);
      if (m.truth[qid].includes(got[0])) hits1++;
      if (got.some((g) => m.truth[qid].includes(g))) hits3++;
    }
    const n = Object.keys(m.queries).length;
    score = { metric: 'hit@3', value: hits3 / n, hit1: hits1 / n, hit3: hits3 / n };
  }
  const inputTokens = fs.readdirSync(dir, { recursive: true })
    .map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).isFile())
    .reduce((a, f) => a + tok(fs.readFileSync(f, 'utf8')), 0);
  results[id] = {
    title: m.title, kind: m.kind, score,
    inputTokens, // what Claude would have to read to do it itself
    claudeTokens: SKILL_TOKENS + runs.reduce((a, r) => a + r.claudeTokens, 0),
    seconds: runs.reduce((a, r) => a + r.ms, 0) / 1000,
    jevTokens: runs.reduce((a, r) => a + r.jev, 0),
    jevUsd: runs.reduce((a, r) => a + r.jev, 0) * 0.042 / 1e6,
    calls: runs.length,
    sampleOutput: runs[0].out.split('\n').slice(0, 12).join('\n'),
  };
  const r = results[id];
  fs.writeFileSync(file, JSON.stringify(results, null, 2));
  console.log(`${id}  ${score.metric} ${(score.value * 100).toFixed(1)}%  claude ${r.claudeTokens} tok vs ${r.inputTokens} input tok  ${r.seconds.toFixed(1)}s  jev $${r.jevUsd.toFixed(4)}`);
}

