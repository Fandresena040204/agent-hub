// Adaptateur Codex : `codex exec --json` (JSONL sur stdout, un processus par tour).
// Flags issus de la documentation Codex : NON VÉRIFIÉS sur la machine de développement (CLI absent).

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentCapabilities, AgentAdapter, AgentRun, StartOptions, NativeSession, NativeSessionContent } from './AgentAdapter';
import type { AgentId } from '../core/types';
import { runCli } from './process';
import { listCodexSessions, readCodexSession } from './sessions/codexSessions';
import {
  CliAgentRun,
  TurnContext,
  asNumber,
  asRecord,
  asString,
  checkCliAvailable,
  type CliLaunchConfig,
} from './base';

export interface CodexAdapterConfig {
  command: string;
  prefixArgs?: string[];
}

const NOT_FOUND = 'CLI codex introuvable (réglage agentHub.codex.path)';

/** Section d'aide d'une option (`--model`, `--effort`…), jusqu'à l'option suivante. */
function optionSection(help: string, flag: RegExp): string {
  const lines = help.split(/\r?\n/);
  const idx = lines.findIndex((l) => flag.test(l));
  if (idx < 0) return '';
  const out: string[] = [lines[idx]];
  for (let i = idx + 1; i < lines.length && out.length < 15; i++) {
    if (/^\s{0,6}(?:-[A-Za-z],?\s+)?--[A-Za-z]/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

/** Découpe une liste d'identifiants (`a, b`, `{a,b}`, `'a'`…). */
function splitValues(raw: string): string[] {
  const out = new Set<string>();
  for (const part of raw.split(/[,|]/)) {
    const v = part
      .trim()
      .replace(/[`'"]/g, '')
      .replace(/^[{[(]+/, '')
      .replace(/[}\])]+$/, '')
      .replace(/[.;]+$/, '');
    if (/^[A-Za-z][\w./:-]*$/.test(v)) out.add(v);
  }
  return [...out];
}

/** Extrait des identifiants d'une section d'aide : `{a, b}`, `valeur : a, b`, `'a'`… */
function valuesFromSection(section: string): string[] {
  if (!section) return [];
  const out = new Set<string>();
  const add = (raw: string): void => {
    for (const v of splitValues(raw)) out.add(v);
  };
  for (const m of section.matchAll(/[[{]([^\]}\n]+)[\]}]/g)) add(m[1]);
  for (const line of section.split(/\r?\n/)) {
    const m = /[:：]\s*(.+)$/.exec(line);
    if (m) add(m[1]);
  }
  for (const m of section.matchAll(/'([^']+)'|"([^"]+)"/g)) add(m[1] ?? m[2]);
  return [...out];
}

/**
 * Niveaux de `model_reasoning_effort` trouvés dans l'aide (doc : minimal, low, medium, high, xhigh).
 * Aucune liste n'est codée en dur : sans source, renvoie [] (→ effortLevels null).
 */
export function parseCodexEfforts(help: string): string[] {
  const direct = /model_reasoning_effort[^\n]*(?:values?|valeurs?|niveaux?)\s*[:=]\s*([^\n]+)/i.exec(help);
  if (direct) {
    const values = splitValues(direct[1]);
    if (values.length > 0) return values;
  }
  // Énumération sur la même ligne que la clé (évite de capter l'énumération d'une autre option voisine).
  const keyLine = help.split(/\r?\n/).find((l) => l.includes('model_reasoning_effort') && /[[{(][^\]})]+[\]})]/.test(l));
  if (keyLine) {
    const braced = /[[{]([^\]}\n]+)[\]}]/.exec(keyLine);
    if (braced) {
      const values = splitValues(braced[1]);
      if (values.length > 0) return values;
    }
  }
  return valuesFromSection(optionSection(help, /^\s{0,6}(?:-[A-Za-z],?\s*)?--(?:reasoning-)?effort\b/));
}

/** Modèles éventuellement listés dans l'aide (`--model <MODEL>`). */
export function parseCodexModels(help: string): string[] {
  return valuesFromSection(optionSection(help, /^\s{0,6}(?:-m,\s*)?--model\b/));
}

/** Vrai si l'aide mentionne une sous-commande de liste des modèles (`codex models`). */
export function codexHasModelsCommand(help: string): boolean {
  return help.split(/\r?\n/).some((l) => /^\s{2,}models?\s{2,}.+(?:model)/i.test(l));
}

/** Clés `model` et `model_reasoning_effort` de `~/.codex/config.toml` (lecture tolérante). */
export function parseCodexConfig(text: string): { model?: string; effort?: string } {
  const model = /^\s*model\s*=\s*["']([^"']+)["']/m.exec(text)?.[1];
  const effort = /^\s*model_reasoning_effort\s*=\s*["']([^"']+)["']/m.exec(text)?.[1];
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

function codexHome(): string {
  const fromEnv = process.env.CODEX_HOME?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : path.join(os.homedir(), '.codex');
}

function readLocalConfig(): { model?: string; effort?: string } {
  try {
    return parseCodexConfig(fs.readFileSync(path.join(codexHome(), 'config.toml'), 'utf8'));
  } catch {
    return {};
  }
}

function parseModelLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((l) => l.replace(/\u001b\[[0-9;]*m/g, '').trim())
    .filter((l) => /^[A-Za-z0-9][\w./:-]*$/.test(l));
}

async function discoverCodex(command: string, prefixArgs: string[]): Promise<AgentCapabilities> {
  const local = readLocalConfig();
  const top = await runCli(command, [...prefixArgs, '--help']);
  const exec = await runCli(command, [...prefixArgs, 'exec', '--help']);
  const topText = top.stdout || top.stderr;
  const help = [topText, exec.stdout, exec.stderr].join('\n');

  let models: string[] = [];
  if (top.code === 0 && codexHasModelsCommand(topText)) {
    const listed = await runCli(command, [...prefixArgs, 'models']);
    if (listed.code === 0) models = parseModelLines(listed.stdout);
  }
  if (models.length === 0) models = parseCodexModels(help);
  const efforts = parseCodexEfforts(help);

  return {
    models: models.length > 0 ? models.map((id) => ({ id })) : 'free-text',
    ...(local.model ? { defaultModel: local.model } : {}),
    effortLevels: efforts.length > 0 ? efforts.map((id) => ({ id })) : null,
    ...(local.effort ? { defaultEffort: local.effort } : {}),
  };
}

class CodexRun extends CliAgentRun {
  private warnedAllowedPaths = false;

  constructor(
    cfg: CodexAdapterConfig,
    opts: StartOptions,
    environment: NodeJS.ProcessEnv,
    private readonly caps: () => Promise<AgentCapabilities>,
  ) {
    super({ id: 'codex', command: cfg.command, prefixArgs: cfg.prefixArgs, env: environment } satisfies CliLaunchConfig, opts);
  }

  protected fetchCaps(): Promise<AgentCapabilities> {
    return this.caps();
  }

  protected buildArgs(ctx: TurnContext): string[] {
    const o = this.opts;
    const args = ['exec'];
    if (ctx.sessionId) args.push('resume', ctx.sessionId);
    args.push('--json', '--skip-git-repo-check');

    if (o.model) args.push('-m', o.model);
    if (o.effort) args.push('-c', `model_reasoning_effort=${o.effort}`);

    args.push('--sandbox', o.permissionMode === 'readonly' ? 'read-only' : 'workspace-write');
    if (o.permissionMode === 'full') args.push('-c', 'sandbox_workspace_write.network_access=true');
    // Aucune approbation interactive : les tours sont pilotés par l'extension.
    args.push('-c', 'approval_policy=never');

    if (o.mcpServerUrl) {
      args.push('-c', `mcp_servers.agenthub.url=${o.mcpServerUrl}`);
      // Le token n'apparaît jamais dans les arguments : Codex lit cette variable d'environnement.
      if (o.mcpToken) args.push('-c', 'mcp_servers.agenthub.bearer_token_env_var=AGENT_HUB_MCP_TOKEN');
    }

    // Codex n'a pas de mécanisme natif de portée : la restriction est portée par le prompt (Orchestrator).
    if (o.allowedPaths !== undefined && !this.warnedAllowedPaths) {
      this.log.info(`allowedPaths non transmis à Codex (pas de mécanisme natif) : ${o.allowedPaths.length} glob(s)`);
      this.warnedAllowedPaths = true;
    }

    const message = o.systemPromptAppend && ctx.index === 0
      ? `${o.systemPromptAppend}\n\n${ctx.text}`
      : ctx.text;
    args.push(message);
    return args;
  }

  protected parseLine(line: string, ctx: TurnContext): void {
    const obj = this.parseJson(line);
    if (!obj) return;

    switch (obj.type) {
      case 'thread.started': {
        const id = asString(obj.thread_id) ?? asString(obj.threadId);
        if (id) ctx.setSessionId(id);
        return;
      }
      case 'item.started':
      case 'item.completed': {
        const item = asRecord(obj.item);
        if (!item) return;
        this.parseItem(item, obj.type === 'item.completed', ctx);
        return;
      }
      case 'turn.completed': {
        const usage = asRecord(obj.usage);
        const tokens = asNumber(usage?.input_tokens) + asNumber(usage?.output_tokens);
        ctx.emit({ type: 'usage', tokens });
        ctx.outcome = { type: 'done', summary: ctx.lastText.trim() || 'Tâche terminée' };
        return;
      }
      case 'turn.failed': {
        const err = asRecord(obj.error);
        const message = asString(err?.message) ?? asString(obj.message) ?? 'Erreur Codex';
        ctx.outcome = { type: 'error', message };
        return;
      }
      case 'error': {
        const err = asRecord(obj.error);
        ctx.outcome = {
          type: 'error',
          message: asString(obj.message) ?? asString(err?.message) ?? 'Erreur Codex',
        };
        return;
      }
      default:
        return;
    }
  }

  private parseItem(item: Record<string, unknown>, completed: boolean, ctx: TurnContext): void {
    const type = asString(item.type) ?? '';
    const id = asString(item.id);

    switch (type) {
      case 'agent_message': {
        if (!completed) return;
        const text = asString(item.text) ?? '';
        if (text === '' || text === ctx.lastText) return;
        ctx.lastText = text;
        ctx.emit({ type: 'assistant_text', text, partial: false });
        return;
      }
      case 'reasoning':
      case 'todo_list':
        return;
      case 'command_execution': {
        const command = asString(item.command) ?? '';
        if (!completed) {
          if (id) ctx.toolCalls.set(id, { name: 'command_execution', input: { command } });
          ctx.emit({ type: 'tool_call', id, name: 'command_execution', input: { command } });
          return;
        }
        const exitCode = typeof item.exit_code === 'number' ? item.exit_code : undefined;
        const isError = asString(item.status) === 'failed' || (exitCode !== undefined && exitCode !== 0);
        ctx.emit({
          type: 'tool_result',
          id,
          name: 'command_execution',
          output: item.aggregated_output ?? '',
          isError,
        });
        return;
      }
      case 'file_change': {
        // `changes` n'est complet qu'à item.completed ; on évite les doublons de item.started.
        if (!completed) return;
        const changes = Array.isArray(item.changes) ? item.changes : [];
        for (const change of changes) {
          const filePath = asString(asRecord(change)?.path) ?? asString(change);
          if (filePath) ctx.emit({ type: 'file_changed', path: filePath });
        }
        return;
      }
      case 'mcp_tool_call': {
        const server = asString(item.server);
        const tool = asString(item.tool) ?? 'outil';
        const name = server ? `${server}.${tool}` : tool;
        const input = item.arguments;
        if (!completed) {
          if (id) ctx.toolCalls.set(id, { name, input });
          ctx.emit({ type: 'tool_call', id, name, input });
          return;
        }
        if (!id || !ctx.toolCalls.has(id)) ctx.emit({ type: 'tool_call', id, name, input });
        const isError = item.error !== undefined || asString(item.status) === 'failed';
        ctx.emit({ type: 'tool_result', id, name, output: isError ? item.error : item.result, isError });
        return;
      }
      default:
        return;
    }
  }
}

export class CodexAdapter implements AgentAdapter {
  readonly id: AgentId = 'codex';
  readonly label = 'Codex';
  private caps?: Promise<AgentCapabilities>;

  constructor(private readonly cfg: CodexAdapterConfig) {}

  async isAvailable(): Promise<{ ok: boolean; detail?: string }> {
    const result = await checkCliAvailable(this.cfg.command, this.cfg.prefixArgs);
    if (result.ok) return result;
    const cause = result.detail && !/ENOENT|not found|introuvable/i.test(result.detail) ? ` : ${result.detail}` : '';
    return { ok: false, detail: `${NOT_FOUND}${cause}` };
  }

  getCapabilities(): Promise<AgentCapabilities> {
    this.caps ??= discoverCodex(this.cfg.command, this.cfg.prefixArgs ?? []);
    return this.caps;
  }

  start(opts: StartOptions): AgentRun {
    const env: NodeJS.ProcessEnv = {};
    if (opts.mcpServerUrl && opts.mcpToken) env.AGENT_HUB_MCP_TOKEN = opts.mcpToken;
    return new CodexRun(this.cfg, opts, env, () => this.getCapabilities());
  }

  /** Sessions natives du dossier (`$CODEX_HOME/sessions`, format documenté non vérifié). */
  listSessions(cwd: string): Promise<NativeSession[]> {
    return listCodexSessions(cwd);
  }

  /** Contenu d'une session native converti en événements communs. */
  readSession(sessionId: string, cwd: string): Promise<NativeSessionContent> {
    return readCodexSession(sessionId, cwd);
  }
}
