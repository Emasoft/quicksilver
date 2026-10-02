// Scores the Claude-native baseline, merges it with the Quicksilver run, and writes results.md + results.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath decodes %20 and non-ASCII; URL.pathname kept them percent-encoded (audit m8).
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const R = path.join(ROOT, 'results');
const qs = JSON.parse(fs.readFileSync(path.join(R, 'quicksilver.json'), 'utf8'));
const usage = JSON.parse(fs.readFileSync(path.join(R, 'baseline', 'usage.json'), 'utf8'));
// Fixed floor every subagent pays (system prompt + tools), measured with a trivial control task.
const FLOOR = usage.control;

function prf(pred, truth, neutral = []) {
  const T = new Set(truth.map(String)), N = new Set(neutral.map(String));
  const P = [...new Set(pred.map(String))].filter((p) => !N.has(p));
  const tp = P.filter((p) => T.has(p)).length;
  const precision = P.length ? tp / P.length : 1, recall = T.size ? tp / T.size : 1;
  return { precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0 };
}

function scoreBaseline(id, m) {
  const f = path.join(R, 'baseline', `${id}.json`);
  if (!fs.existsSync(f)) return null;
  const a = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (m.kind.startsWith('filter')) {
    const s = prf(m.kind === 'filter-lines' ? a.lines : a.ids, m.truth, m.neutral);
    return { metric: 'F1', value: s.f1, ...s };
  }
  if (m.kind === 'classify') {
    const ids = Object.keys(m.truth);
    const correct = ids.filter((k) => a.labels?.[k] === m.truth[k]).length;
    return { metric: 'accuracy', value: correct / ids.length };
  }
  if (m.kind === 'find') {
    let h1 = 0, h5 = 0;
    for (const [name, [lo, hi]] of Object.entries(m.truth)) {
      const got = (a.hits?.[name] || []).slice(0, 5).map(Number).map((n) => n >= lo && n <= hi);
      if (got[0]) h1++; if (got.some(Boolean)) h5++;
    }
    const n = Object.keys(m.truth).length;
    return { metric: 'hit@5', value: h5 / n, hit1: h1 / n };
  }
  if (m.kind === 'rank') {
    let h1 = 0, h3 = 0;
    for (const [q, t] of Object.entries(m.truth)) {
      const got = (a.top3?.[q] || []).slice(0, 3);
      if (t.includes(got[0])) h1++; if (got.some((g) => t.includes(g))) h3++;
    }
    const n = Object.keys(m.truth).length;
    return { metric: 'hit@3', value: h3 / n, hit1: h1 / n };
  }
}

const pct = (x) => `${(x * 100).toFixed(0)}%`;
const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const rows = [];
for (const id of Object.keys(qs).sort()) {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'truth', `${id}.json`), 'utf8'));
  const q = qs[id], b = scoreBaseline(id, m), u = usage[id];
  if (!b || !u) { console.warn(`missing baseline for ${id}`); continue; }
  rows.push({
    id, title: m.title, metric: q.score.metric,
    qsScore: q.score.value, baseScore: b.value,
    baseTokens: u.tokens - FLOOR.tokens, qsTokens: q.claudeTokens,
    tokenReduction: 1 - q.claudeTokens / (u.tokens - FLOOR.tokens),
    baseSeconds: u.seconds - FLOOR.seconds, qsSeconds: q.seconds, speedup: (u.seconds - FLOOR.seconds) / q.seconds,
    jevUsd: q.jevUsd, baseToolCalls: u.toolUses,
  });
}

const sum = (f, rs = rows) => rs.reduce((a, r) => a + f(r), 0);
const good = rows;
const agg = (rs) => ({
  n: rs.length,
  tokenReduction: 1 - sum((r) => r.qsTokens, rs) / sum((r) => r.baseTokens, rs),
  medianTokenReduction: rs.map((r) => r.tokenReduction).sort((a, b) => a - b)[Math.floor(rs.length / 2)],
  speedup: sum((r) => r.baseSeconds, rs) / sum((r) => r.qsSeconds, rs),
  qsScore: sum((r) => r.qsScore, rs) / rs.length,
  baseScore: sum((r) => r.baseScore, rs) / rs.length,
  jevUsd: sum((r) => r.jevUsd, rs),
  baseTokens: sum((r) => r.baseTokens, rs), qsTokens: sum((r) => r.qsTokens, rs),
});
const all = agg(rows), fit = agg(good);

let md = `| # | Situation | Metric | Claude alone | Quicksilver | Claude tokens (alone → QS) | Token cut | Time (alone → QS) | Speed-up | Jev cost |\n|---|---|---|---|---|---|---|---|---|---|\n`;
for (const r of rows) {
  md += `| ${r.id.slice(1)} | ${r.title.split(' — ')[0]} | ${r.metric} | ${pct(r.baseScore)} | ${pct(r.qsScore)} | ${k(r.baseTokens)} → ${k(r.qsTokens)} | **${pct(r.tokenReduction)}** | ${r.baseSeconds.toFixed(0)}s → ${r.qsSeconds.toFixed(1)}s | ${r.speedup.toFixed(1)}× | $${r.jevUsd.toFixed(4)} |\n`;
}
md += `\n**All 12 situations:** ${pct(fit.tokenReduction)} fewer Claude tokens overall (median ${pct(fit.medianTokenReduction)}), ${fit.speedup.toFixed(1)}× faster, avg quality ${pct(fit.qsScore)} vs ${pct(fit.baseScore)} for Claude alone, total Jev spend $${fit.jevUsd.toFixed(3)}.\n`;
fs.writeFileSync(path.join(R, 'results.md'), md);
fs.writeFileSync(path.join(R, 'results.json'), JSON.stringify({ rows, all, fit }, null, 2));
console.log(md);
console.log(JSON.stringify({ all, fit }, null, 2));
