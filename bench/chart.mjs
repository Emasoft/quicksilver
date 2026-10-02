// Renders results/results.json into assets/benchmark.svg for the README.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath decodes %20 and non-ASCII; URL.pathname kept them percent-encoded (audit m8).
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const { rows, all } = JSON.parse(fs.readFileSync(path.join(ROOT, 'results', 'results.json'), 'utf8'));

const W = 960, rowH = 34, top = 118, left = 300, barW = 400;
const H = top + rows.length * rowH + 64;
const max = Math.max(...rows.map((r) => r.baseTokens));
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
const pct = (x) => `${Math.round(x * 100)}%`;

let body = '';
rows.forEach((r, i) => {
  const y = top + i * rowH;
  const bw = (r.baseTokens / max) * barW, qw = Math.max(2, (r.qsTokens / max) * barW);
  const name = esc(r.title.split(' — ')[0]);
  const parity = r.qsScore >= r.baseScore - 0.02;
  body += `
  <text x="${left - 14}" y="${y + 15}" text-anchor="end" class="lbl">${name}</text>
  <rect x="${left}" y="${y + 3}" width="${bw.toFixed(1)}" height="9" rx="2" class="base"/>
  <rect x="${left}" y="${y + 14}" width="${qw.toFixed(1)}" height="9" rx="2" class="qs"/>
  <text x="${left + bw + 8}" y="${y + 12}" class="dim">${k(r.baseTokens)}</text>
  <text x="${left + qw + 8}" y="${y + 23}" class="qsl">${k(r.qsTokens)}</text>
  <text x="${left + barW + 110}" y="${y + 18}" text-anchor="end" class="cut">−${pct(r.tokenReduction)}</text>
  <text x="${left + barW + 200}" y="${y + 18}" text-anchor="end" class="${parity ? 'ok' : 'warn'}">${pct(r.baseScore)} → ${pct(r.qsScore)}</text>
  <text x="${W - 24}" y="${y + 18}" text-anchor="end" class="dim">${r.speedup >= 1.5 ? r.speedup.toFixed(0) + '×' : '≈'}</text>`;
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="ui-sans-serif, -apple-system, Segoe UI, Helvetica, Arial, sans-serif">
  <style>
    .lbl { font-size: 13px; fill: #d6dbe4 }
    .dim { font-size: 11px; fill: #7d8796 }
    .qsl { font-size: 11px; fill: #9fe8ff; font-weight: 600 }
    .cut { font-size: 14px; fill: #9fe8ff; font-weight: 700 }
    .ok { font-size: 12px; fill: #8ee6a6 }
    .warn { font-size: 12px; fill: #f2c46d }
    .h { font-size: 11px; fill: #7d8796; letter-spacing: .06em; text-transform: uppercase }
    .base { fill: #3a4252 }
    .qs { fill: url(#hg) }
  </style>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0d1117"/><stop offset="1" stop-color="#161b26"/></linearGradient>
    <linearGradient id="hg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#e8edf5"/><stop offset="1" stop-color="#5fd4ff"/></linearGradient>
  </defs>
  <rect width="${W}" height="${H}" rx="14" fill="url(#bg)"/>
  <text x="28" y="44" font-size="22" font-weight="700" fill="#f2f5fa">Claude tokens per task: alone vs with Quicksilver</text>
  <text x="28" y="68" font-size="13" fill="#9aa4b2">12 benchmark tasks · measured Claude Code subagents vs Quicksilver · ${pct(all.tokenReduction)} fewer tokens overall · quality ${pct(all.baseScore)} → ${pct(all.qsScore)}</text>
  <rect x="${left}" y="86" width="12" height="8" rx="2" class="base"/><text x="${left + 18}" y="94" class="dim">Claude alone</text>
  <rect x="${left + 110}" y="86" width="12" height="8" rx="2" class="qs"/><text x="${left + 128}" y="94" class="dim">Claude + Quicksilver</text>
  <text x="${left + barW + 110}" y="94" text-anchor="end" class="h">tokens</text>
  <text x="${left + barW + 200}" y="94" text-anchor="end" class="h">quality</text>
  <text x="${W - 24}" y="94" text-anchor="end" class="h">speed</text>
  ${body}
  <text x="28" y="${H - 24}" class="dim">Quality: F1 / accuracy / hit@k against ground truth. Green = within 2 pts of Claude alone. Reproduce: bench/README.md</text>
</svg>
`;
fs.mkdirSync(path.join(ROOT, '..', 'assets'), { recursive: true });
fs.writeFileSync(path.join(ROOT, '..', 'assets', 'benchmark.svg'), svg);
console.log('wrote assets/benchmark.svg');
