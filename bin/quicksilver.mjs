#!/usr/bin/env node
// npx installer for the Quicksilver Claude Code skill.
//   npx github:Emasoft/quicksilver            install skill + set Jev key once
//   npx github:Emasoft/quicksilver uninstall  remove the skill
//   npx github:Emasoft/quicksilver <cmd>      run any qs command (status, filter, classify, ...)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(PKG, 'skills', 'quicksilver');
const CLAUDE = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const DEST = path.join(CLAUDE, 'skills', 'quicksilver');
const QS = path.join(DEST, 'scripts', 'qs.mjs');

const c = (code, s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const run = (args, opts = {}) => spawnSync(process.execPath, [QS, ...args], { stdio: 'inherit', ...opts }).status ?? 1;

const [cmd = 'install', ...rest] = process.argv.slice(2);

if (cmd === 'install') {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 18) { console.error('Quicksilver needs Node 18 or newer.'); process.exit(1); }
  // Replace, not overlay: cpSync over an old copy left files a newer version deleted. DEST is the installer's
  // own skills/quicksilver folder, so emptying it touches nothing else.
  const replaced = fs.existsSync(DEST);
  fs.rmSync(DEST, { recursive: true, force: true });
  fs.cpSync(SRC, DEST, { recursive: true });
  console.log(`${c('36', '☿ quicksilver')} skill installed → ${DEST}${replaced ? ' (previous copy replaced)' : ''}`);

  const keyFlag = rest.find((a) => a.startsWith('--key='))?.slice(6) || (rest.includes('--key') ? rest[rest.indexOf('--key') + 1] : '');
  // --provider X / --provider=X are forwarded to every qs call, so status and setup judge the same provider.
  const providerArgs = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--provider=')) providerArgs.push(rest[i]);
    else if (rest[i] === '--provider' && rest[i + 1] && !rest[i + 1].startsWith('--')) providerArgs.push(rest[i], rest[++i]);
  }
  // An exported key is the primary path: report it and never prompt. `status` names the provider that will
  // actually be used (OPENROUTER_API_KEY wins unless --provider/QUICKSILVER_PROVIDER says otherwise) and the
  // env var it read; setup is skipped even if the check fails, since setup would not override the env var.
  const envKey = ['OPENROUTER_API_KEY', 'JEV_API_KEY', 'TYPESAFE_API_KEY'].find((n) => process.env[n]);
  if (keyFlag) run(['setup', keyFlag, ...providerArgs]);
  else if (envKey) {
    console.log('\nFound an API key exported in your environment; no setup needed:');
    run(['status', ...providerArgs]);
  } else if (spawnSync(process.execPath, [QS, 'status', ...providerArgs], { stdio: 'ignore' }).status !== 0) {
    if (process.stdin.isTTY) {
      // No provider named here: setup's own prompt names the provider it resolved and where to get its key.
      console.log('\nNo API key exported (JEV_API_KEY, TYPESAFE_API_KEY or OPENROUTER_API_KEY). One-time setup instead:');
      if (run(['setup', ...providerArgs]) !== 0) console.log(`\nNo key saved. Run later: npx github:Emasoft/quicksilver setup`);
    } else {
      console.log(`\nNext: export JEV_API_KEY (key from https://console.typesafe.ai) or OPENROUTER_API_KEY (key from https://openrouter.ai/settings/keys) in your shell profile; Quicksilver detects it. Without one, run: npx github:Emasoft/quicksilver setup`);
    }
  } else run(['status', ...providerArgs]);
  console.log(`\n${c('32', 'Done.')} Restart Claude Code (or start a new session). Claude now delegates bulk judgment calls to Jev automatically.`);
  console.log(`Try asking: "which files in this repo handle auth?" or "find the errors in app.log".`);
} else if (cmd === 'uninstall') {
  fs.rmSync(DEST, { recursive: true, force: true });
  console.log(`Removed ${DEST}. Your key stays in ~/.quicksilver/config.json. Delete that folder to remove it.`);
} else {
  if (!fs.existsSync(QS)) {
    const local = path.join(SRC, 'scripts', 'qs.mjs');
    process.exit(spawnSync(process.execPath, [local, cmd, ...rest], { stdio: 'inherit' }).status ?? 1);
  }
  process.exit(run([cmd, ...rest]));
}
