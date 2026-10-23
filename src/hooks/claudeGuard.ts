// Garde-fou Claude Code (hook PreToolUse) : portée d'écriture + git interdits.
// Script autonome : lit {tool_name, tool_input, cwd} sur stdin, exit 2 = refus (raison sur stderr).

import * as path from 'path';
import { matchesAny, normalizeRel } from '../core/glob';

export interface GuardInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
}

export interface GuardEnv {
  AGENT_HUB_ALLOWED_PATHS?: string;
  AGENT_HUB_FORBIDDEN_GIT?: string;
}

export interface GuardDecision {
  allow: boolean;
  reason?: string;
}

const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

/**
 * Liste JSON depuis l'environnement.
 * Absente/vide → undefined (pas de restriction) ; JSON invalide → [] (tout refuser).
 */
function parseList(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Décision pure, testable sans processus. */
export function decide(input: GuardInput, env: GuardEnv): GuardDecision {
  const tool = input.tool_name ?? '';
  const toolInput = input.tool_input ?? {};

  if (WRITE_TOOLS.has(tool)) return decideWrite(toolInput, input.cwd, env);
  if (SHELL_TOOLS.has(tool)) return decideShell(toolInput, env);
  return { allow: true };
}

function decideWrite(toolInput: Record<string, unknown>, cwdInput: string | undefined, env: GuardEnv): GuardDecision {
  const allowed = parseList(env.AGENT_HUB_ALLOWED_PATHS);
  if (!allowed) return { allow: true };

  const raw = toolInput.file_path ?? toolInput.notebook_path;
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { allow: false, reason: 'écriture sans chemin identifiable' };
  }
  const cwd = cwdInput && cwdInput.trim() !== '' ? cwdInput : process.cwd();
  const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(cwd, raw);
  const relRaw = path.relative(cwd, abs);
  if (relRaw === '..' || relRaw.startsWith('..' + path.sep) || path.isAbsolute(relRaw)) {
    return { allow: false, reason: `écriture hors du workspace : ${raw}` };
  }
  const rel = relRaw === '' ? '.' : normalizeRel(relRaw);
  if (!matchesAny(rel, allowed)) {
    return { allow: false, reason: `écriture hors périmètre : ${rel}` };
  }
  return { allow: true };
}

function decideShell(toolInput: Record<string, unknown>, env: GuardEnv): GuardDecision {
  const command = typeof toolInput.command === 'string' ? toolInput.command : '';
  if (!command.trim()) return { allow: true };
  const forbidden = parseList(env.AGENT_HUB_FORBIDDEN_GIT) ?? [];
  if (forbidden.length === 0) return { allow: true };
  const hit = findForbiddenGit(command, forbidden);
  return hit ? { allow: false, reason: `commande git interdite : git ${hit}` } : { allow: true };
}

/** Découpe une ligne de commande en segments (respecte les guillemets). */
function splitSegments(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === ';' || c === '|' || c === '&' || c === '\n' || c === '\r') {
      out.push(cur);
      cur = '';
      if ((c === '&' || c === '|') && (cmd[i + 1] === c)) i++;
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

function tokenize(segment: string): string[] {
  const out: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|([^\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment)) !== null) {
    if (m[1] !== undefined) out.push(m[1].replace(/\\(["\\])/g, '$1'));
    else if (m[2] !== undefined) out.push(m[2]);
    else out.push(m[3]);
  }
  return out;
}

/** Options globales de git qui prennent une valeur séparée. */
const GIT_OPTS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix']);

function baseName(token: string): string {
  // Retire la ponctuation de shell autour du nom ($(git, commit), "git", …).
  const clean = token.replace(/^[^A-Za-z0-9_./\\-]+/, '').replace(/[^A-Za-z0-9_./\\-]+$/, '');
  const base = clean.split(/[\\/]/).pop() ?? clean;
  return base.replace(/\.exe$/i, '').toLowerCase();
}

/** Nettoie un sous-commande tokenisée (`commit)`, `commit;` → `commit`). */
function cleanSub(token: string): string {
  return token.replace(/^[^A-Za-z0-9_-]+/, '').replace(/[^A-Za-z0-9_-]+$/, '').toLowerCase();
}

/** Cherche `git <sous-commande interdite>` dans une commande shell. */
function findForbiddenGit(command: string, forbidden: string[]): string | undefined {
  const banned = new Set(forbidden.map((f) => f.toLowerCase()));
  for (const segment of splitSegments(command)) {
    const tokens = tokenize(segment);
    for (let i = 0; i < tokens.length; i++) {
      if (baseName(tokens[i]) !== 'git') continue;
      let j = i + 1;
      while (j < tokens.length) {
        const t = tokens[j];
        if (GIT_OPTS_WITH_VALUE.has(t)) {
          j += 2;
          continue;
        }
        if (t.startsWith('-')) {
          j++;
          continue;
        }
        if (banned.has(cleanSub(t))) return cleanSub(t);
        break;
      }
    }
  }
  return undefined;
}

/** Point d'entrée du hook : lit stdin, décide, écrit la raison sur stderr et sort avec 2 si refus. */
function main(): void {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (data += chunk));
  process.stdin.on('end', () => {
    let decision: GuardDecision;
    try {
      const parsed = JSON.parse(data) as GuardInput;
      decision = decide(parsed, process.env);
    } catch (err) {
      decision = { allow: false, reason: `garde-fou : entrée invalide (${err instanceof Error ? err.message : String(err)})` };
    }
    if (!decision.allow) {
      process.stderr.write(`${decision.reason ?? 'action refusée'}\n`);
      process.exit(2);
    }
    process.exit(0);
  });
}

if (typeof require !== 'undefined' && require.main === module) main();
