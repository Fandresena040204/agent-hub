#!/usr/bin/env node
'use strict';

// Faux CLI générique pour les tests d'adaptateurs.
// Usage : node mockCli.js <fixture.jsonl> [args du CLI…]
//   - enregistre ses argv JSON dans MOCK_ARGS_FILE (une ligne par appel)
//   - enregistre les variables d'env OPENCODE_*/AGENT_HUB_* dans MOCK_ENV_FILE
//   - --version → « mock 1.0.0 », --help → MOCK_HELP_FILE, « models » → MOCK_MODELS_FILE,
//     « api » → MOCK_API_FILE, « session list » → MOCK_SESSION_LIST_FILE,
//     « session export » → MOCK_SESSION_EXPORT_FILE
//   - sinon rejoue la fixture ligne par ligne sur stdout (MOCK_DELAY_MS, défaut 1)
//   - code de sortie : MOCK_EXIT_CODE (défaut 0)

const fs = require('fs');

const argv = process.argv.slice(2);
const fixture = argv[0];
const args = argv.slice(1);

function append(file, text) {
  if (!file) return;
  try {
    fs.appendFileSync(file, text);
  } catch {
    // fichier de trace indisponible : on continue
  }
}

append(process.env.MOCK_ARGS_FILE, JSON.stringify(argv) + '\n');

if (process.env.MOCK_ENV_FILE) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('OPENCODE_') || k.startsWith('AGENT_HUB_') || k.startsWith('MOCK_')) env[k] = v;
  }
  append(process.env.MOCK_ENV_FILE, JSON.stringify(env) + '\n');
}

function readFile(file, fallback) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

function write(text) {
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}

function finish(text, code) {
  if (text) write(text);
  process.exit(code);
}

if (args.includes('--version')) {
  finish('mock 1.0.0', 0);
}

if (args.includes('--help')) {
  finish(readFile(process.env.MOCK_HELP_FILE, 'usage: mock [options]'), 0);
}

if (args[0] === 'models') {
  finish(readFile(process.env.MOCK_MODELS_FILE, ''), 0);
}

if (args[0] === 'api') {
  if (!process.env.MOCK_API_FILE) finish('mock: pas de MOCK_API_FILE', 1);
  finish(readFile(process.env.MOCK_API_FILE, '{}'), 0);
}

if (args[0] === 'session' && args[1] === 'list') {
  if (!process.env.MOCK_SESSION_LIST_FILE) finish('mock: pas de MOCK_SESSION_LIST_FILE', 1);
  finish(readFile(process.env.MOCK_SESSION_LIST_FILE, '[]'), 0);
}

if (args[0] === 'session' && args[1] === 'export') {
  if (!process.env.MOCK_SESSION_EXPORT_FILE) finish('mock: pas de MOCK_SESSION_EXPORT_FILE', 1);
  finish(readFile(process.env.MOCK_SESSION_EXPORT_FILE, '{}'), 0);
}

if (!fixture) finish('mock: fixture manquante', 1);

let lines;
try {
  lines = fs.readFileSync(fixture, 'utf8').split(/\r?\n/).filter((l, i, all) => l.length > 0 || i === all.length - 1);
} catch (err) {
  process.stderr.write(`mock: fixture introuvable ${fixture}\n`);
  process.exit(1);
}

const delay = Math.max(0, Number.parseInt(process.env.MOCK_DELAY_MS || '1', 10) || 0);
const exitCode = Number.parseInt(process.env.MOCK_EXIT_CODE || '0', 10) || 0;

(async () => {
  for (const line of lines) {
    if (line.length === 0) continue;
    process.stdout.write(line + '\n');
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  }
  if (process.env.MOCK_STDERR_FILE) {
    const err = readFile(process.env.MOCK_STDERR_FILE, '');
    if (err) process.stderr.write(err.endsWith('\n') ? err : err + '\n');
  }
  process.exit(exitCode);
})();
