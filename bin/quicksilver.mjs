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
// The package's own copy (same code as the installed one): hints name providers and variables from its table.
import { BUILTINS, installHint, varNames } from '../skills/quicksilver/scripts/qs.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(PKG, 'skills', 'quicksilver');
const CLAUDE = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const DEST = path.join(CLAUDE, 'skills', 'quicksilver');
const QS = path.join(DEST, 'scripts', 'qs.mjs');
// The real home, as qs.mjs resolves it: a QUICKSILVER_HOME user would otherwise be pointed at the wrong folder.
const HOME = process.env.QUICKSILVER_HOME || path.join(os.homedir(), '.quicksilver');
const NPX = 'npx github:Emasoft/quicksilver';

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
  // An exported key is the primary path: report it and never prompt. `status` lists the provider chain from
  // providers.json in order, with the variable each provider read; setup is skipped even if a check fails,
  // since the user chose the exported key. The names are the built-in providers' variables.
  const allVars = BUILTINS.flatMap((b) => varNames(b.api_key));
  const envKey = allVars.find((n) => process.env[n]);
  // The provider setup targets (--provider, else QUICKSILVER_PROVIDER, else the chain head), for the hints.
  const pin = providerArgs.at(-1)?.replace(/^--provider=/, '') || process.env.QUICKSILVER_PROVIDER;
  const hint = () => installHint(pin);
  if (keyFlag) {
    // An explicit --key is a request to set up: a rejected key must fail the install (setup's own exit code,
    // 3 for a key problem), not fall through to the success lines. The skill files stay installed.
    const status = run(['setup', keyFlag, ...providerArgs]);
    if (status !== 0) {
      // User preference: keys come from the exported environment, never a command line, so the hint names the
      // variables to export (or the hidden prompt) and never shows a key in a command.
      const h = hint();
      console.error(`\nSetup failed: the key was not saved. ${h.vars.length ? `Export ${h.vars.join(' or ')} in your shell profile, or run: ${NPX} setup --provider ${h.name} (hidden prompt)` : `Run: ${NPX} setup --provider NAME (hidden prompt)`}.${h.exported ? ` Your exported ${h.exported} is still in use.` : ''} The skill is installed; ${NPX} uninstall removes it.`);
      process.exit(status);
    }
  } else if (envKey) {
    console.log('\nFound an API key exported in your environment; no setup needed:');
    run(['status', ...providerArgs]);
  } else if (spawnSync(process.execPath, [QS, 'status', ...providerArgs], { stdio: 'ignore' }).status !== 0) {
    if (process.stdin.isTTY) {
      // No provider named here: setup's own prompt names the provider it resolved and where to get its key.
      console.log(`\nNo API key exported (${allVars.join(', ')}). One-time setup instead:`);
      if (run(['setup', ...providerArgs]) !== 0) console.log(`\nNo key saved. Run later: ${NPX} setup (add --provider NAME to choose a provider)`);
    } else {
      const h = hint();
      // Unpinned, any chain provider's key works, so name them all in chain order: naming only the head read as
      // "OpenRouter only" to a user holding a TypeSafe, Cloudflare or Vercel key. Pinned, only that provider's.
      const per = (p) => `${p.vars.join(' or ')}${p.acct?.length ? `, plus ${p.acct.join(' or ')}` : ''}${p.key_url ? ` (key from ${p.key_url})` : ''}`;
      const what = pin || !h.chain.length
        ? `export ${h.vars.length ? per(h) : allVars.join(' or ')} in your shell profile; Quicksilver detects it.`
        : `export one provider's key in your shell profile; Quicksilver detects it and tries them in this order: ${h.chain.map((p) => `${p.name}: ${per(p)}`).join('; ')}.`;
      console.log(`\nNext: ${what} Without one, run: ${NPX} setup (add --provider NAME to choose a provider). Providers and their order: ${path.join(HOME, 'providers.json')} (example: ${path.join(DEST, 'providers.example.json')})`);
    }
  } else run(['status', ...providerArgs]);
  console.log(`\n${c('32', 'Done.')} Restart Claude Code (or start a new session). Claude now delegates bulk judgment calls to Jev automatically.`);
  console.log(`Try asking: "which files in this repo handle auth?" or "find the errors in app.log".`);
} else if (cmd === 'uninstall') {
  fs.rmSync(DEST, { recursive: true, force: true });
  console.log(`Removed ${DEST}. Saved keys stay in ${path.join(HOME, 'providers.json')}. Delete that folder to remove them.`);
} else {
  if (!fs.existsSync(QS)) {
    const local = path.join(SRC, 'scripts', 'qs.mjs');
    process.exit(spawnSync(process.execPath, [local, cmd, ...rest], { stdio: 'inherit' }).status ?? 1);
  }
  process.exit(run([cmd, ...rest]));
}
