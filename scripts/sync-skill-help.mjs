#!/usr/bin/env node
// Regenerates the `qs help` reference that SKILL.md embeds between its qs-help marker lines, from the live
// `node qs.mjs help` output, so the skill's reference cannot drift from the CLI. Run: npm run sync-docs.
// tests/docs.test.mjs fails, with a line diff, whenever the embedded block differs from the live output.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SKILL = path.join(ROOT, 'skills', 'quicksilver', 'SKILL.md');
export const QS = path.join(ROOT, 'skills', 'quicksilver', 'scripts', 'qs.mjs');
export const BEGIN = '<!-- qs-help:begin -->';
export const END = '<!-- qs-help:end -->';

// The help screen exactly as a user gets it: a child process, not an import, so what is embedded is what runs.
export const liveHelp = () => execFileSync(process.execPath, [QS, 'help'], { encoding: 'utf8' }).trimEnd();

// SKILL.md text with the block between the markers replaced by `help` in a text fence. Each marker must stand
// alone on its line exactly once: a missing or doubled marker is an error, never a guess about where to write.
export function render(skill, help) {
  const lines = skill.split('\n');
  const at = (m) => {
    const hits = lines.flatMap((l, i) => (l === m ? [i] : []));
    if (hits.length !== 1) throw new Error(`${SKILL} must hold the line ${m} exactly once (found ${hits.length})`);
    return hits[0];
  };
  const b = at(BEGIN), e = at(END);
  if (e < b) throw new Error(`${SKILL}: ${END} comes before ${BEGIN}`);
  if (help.includes('```')) throw new Error('the help text holds a ``` fence, which would end the code block early');
  return [...lines.slice(0, b + 1), '```text', help, '```', ...lines.slice(e)].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const before = fs.readFileSync(SKILL, 'utf8');
  const after = render(before, liveHelp());
  if (after === before) console.log(`${path.relative(ROOT, SKILL)}: the qs help block is up to date`);
  else {
    fs.writeFileSync(SKILL, after);
    console.log(`${path.relative(ROOT, SKILL)}: the qs help block was regenerated`);
  }
}
