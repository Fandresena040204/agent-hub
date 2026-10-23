// Adaptateur Antigravity (`agy`) : `agy -p … --output-format stream-json --non-interactive`.
// Flags et format de flux issus de la documentation : NON VÉRIFIÉS (CLI absent sur la machine de dev).

import type { AgentCapabilities, AgentAdapter, AgentRun, StartOptions } from './AgentAdapter';
import type { AgentId } from '../core/types';
import { runCli } from './process';
import {
  CliAgentRun,
  TurnContext,
  asNumber,
  asRecord,
  asString,
  checkCliAvailable,
  type CliLaunchConfig,
} from './base';

export interface AgyAdapterConfig {
  command: string;
  prefixArgs?: string[];
}

const NOT_FOUND = 'CLI agy introuvable (réglage agentHub.agy.path)';
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit', 'write', 'edit']);

/** Ce que l'adaptateur a pu découvrir dans `agy --help`. */
export interface AgyDiscovery {
  caps: AgentCapabilities;
  /** Option d'effort réellement exposée (`--effort` ou `--thinking`), absente sinon. */
  effortFlag?: string;
  /** `--mcp-config` accepté (même format que Claude Code). */
  supportsMcp: boolean;
  /** Option d'outils interdits, si le CLI en expose une. */
  disallowedToolsFlag?: string;
}

/** Section d'aide d'une option, jusqu'à l'option suivante. */
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

/** Extrait des identifiants d'une section d'aide : `{a, b}`, `valeurs : a, b`, `'a'`… */
function valuesFromSection(section: string): string[] {
  if (!section) return [];
  const out = new Set<string>();
  const add = (raw: string): void => {
    for (const part of raw.split(/[,|]/)) {
      const v = part
        .trim()
        .replace(/[`'"]/g, '')
        .replace(/^[{[(]+/, '')
        .replace(/[}\])]+$/, '')
        .replace(/[.;]+$/, '');
      if (/^[A-Za-z][\w./:-]*$/.test(v)) out.add(v);
    }
  };
  for (const m of section.matchAll(/[[{]([^\]}\n]+)[\]}]/g)) add(m[1]);
  for (const line of section.split(/\r?\n/)) {
    const m = /[:：]\s*(.+)$/.exec(line);
    if (m) add(m[1]);
  }
  for (const m of section.matchAll(/'([^']+)'|"([^"]+)"/g)) add(m[1] ?? m[2]);
  return [...out];
}

/** Modèles listés dans l'aide de `--model` (valeurs énumérées ou entre quotes). */
export function parseAgyModels(help: string): string[] {
  return valuesFromSection(optionSection(help, /^\s{0,6}(?:-m,\s*)?--model\b/));
}

/** Option d'effort exposée par l'aide (`--effort`/`--thinking`) et ses valeurs. */
export function parseAgyEffort(help: string): { flag: string; levels: string[] } | null {
  for (const flag of ['--effort', '--thinking']) {
    const lineRe = new RegExp(`^\\s{0,6}(?:-[A-Za-z],\\s*)?${flag}\\b`, 'm');
    if (!lineRe.test(help)) continue;
    return { flag, levels: valuesFromSection(optionSection(help, lineRe)) };
  }
  return null;
}

/** Vrai si l'aide mentionne une sous-commande de liste des modèles (`agy models`). */
export function agyHasModelsCommand(help: string): boolean {
  return help.split(/\r?\n/).some((l) => /^\s{2,}models?\s{2,}.+(?:model)/i.test(l));
}

function parseModelLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((l) => l.replace(/\u001b\[[0-9;]*m/g, '').trim())
    .filter((l) => /^[A-Za-z0-9][\w./:-]*$/.test(l));
}

function helpOption(help: string, flag: string): boolean {
  return new RegExp(`^\\s{0,6}(?:-[A-Za-z],\\s*)?${flag}\\b`, 'm').test(help);
}

async function discoverAgy(command: string, prefixArgs: string[]): Promise<AgyDiscovery> {
  const result = await runCli(command, [...prefixArgs, '--help']);
  const help = result.code === 0 ? result.stdout || result.stderr : '';

  let models = parseAgyModels(help);
  if (models.length === 0 && agyHasModelsCommand(help)) {
    const listed = await runCli(command, [...prefixArgs, 'models']);
    if (listed.code === 0) models = parseModelLines(listed.stdout);
  }
  const effort = parseAgyEffort(help);
  const disallowed = /^\s{0,6}(--disallowed[-_]?tools)\b/m.exec(help);

  return {
    caps: {
      models: models.length > 0 ? models.map((id) => ({ id })) : 'free-text',
      effortLevels: effort && effort.levels.length > 0 ? effort.levels.map((id) => ({ id })) : null,
    },
    ...(effort ? { effortFlag: effort.flag } : {}),
    supportsMcp: helpOption(help, '--mcp-config'),
    ...(disallowed ? { disallowedToolsFlag: disallowed[1] } : {}),
  };
}

class AgyRun extends CliAgentRun {
  private disc?: AgyDiscovery;
  private warnedMcp = false;

  constructor(
    cfg: AgyAdapterConfig,
    opts: StartOptions,
    private readonly caps: () => Promise<AgyDiscovery>,
  ) {
    super({ id: 'agy', command: cfg.command, prefixArgs: cfg.prefixArgs } satisfies CliLaunchConfig, opts);
  }

  protected async fetchCaps(): Promise<AgentCapabilities> {
    this.disc = await this.caps();
    return this.disc.caps;
  }

  protected buildArgs(ctx: TurnContext): string[] {
    const o = this.opts;
    const message = o.systemPromptAppend && ctx.index === 0
      ? `${o.systemPromptAppend}\n\n${ctx.text}`
      : ctx.text;

    const args = ['-p', message, '--output-format', 'stream-json', '--non-interactive'];
    if (o.model) args.push('--model', o.model);
    if (o.effort && this.disc?.effortFlag) args.push(this.disc.effortFlag, o.effort);
    args.push('--mode', o.permissionMode === 'readonly' ? 'plan' : 'accept-edits');
    // `--resume <id>` est supposé (fallback documenté) quand l'aide ne le mentionne pas.
    if (ctx.sessionId) args.push('--resume', ctx.sessionId);

    if (o.mcpServerUrl) {
      if (this.disc?.supportsMcp) {
        const server: Record<string, unknown> = { type: 'http', url: o.mcpServerUrl };
        if (o.mcpToken) server.headers = { Authorization: `Bearer ${o.mcpToken}` };
        args.push('--mcp-config', JSON.stringify({ mcpServers: { agenthub: server } }));
      } else if (!this.warnedMcp) {
        this.log.warn('MCP non supporté par ce CLI agy (option --mcp-config absente de l’aide) : mcpServerUrl ignoré');
        this.warnedMcp = true;
      }
    }

    // Couche 1 uniquement si le CLI expose une option d'outils interdits (format supposé Claude).
    if (this.disc?.disallowedToolsFlag && o.gitPolicy.forbidden.length > 0) {
      const tools = o.gitPolicy.forbidden.flatMap((cmd) => [
        `Bash(git ${cmd}:*)`,
        `PowerShell(git ${cmd}:*)`,
      ]);
      args.push(this.disc.disallowedToolsFlag, ...tools);
    }
    return args;
  }

  protected parseLine(line: string, ctx: TurnContext): void {
    const obj = this.parseJson(line);
    if (!obj) return;

    const type = asString(obj.type) ?? '';
    const subtype = asString(obj.subtype) ?? '';
    const sessionId = asString(obj.session_id) ?? asString(obj.sessionId) ?? asString(asRecord(obj.session)?.id);
    if (sessionId) ctx.setSessionId(sessionId);

    if (type === 'result') {
      const usage = asRecord(obj.usage);
      const total = asNumber(usage?.total_tokens);
      const tokens = total > 0 ? total : asNumber(usage?.input_tokens) + asNumber(usage?.output_tokens);
      const cost = typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined;
      ctx.emit({ type: 'usage', tokens, cost });
      const summary = asString(obj.result) ?? asString(obj.response) ?? ctx.lastText;
      ctx.outcome = obj.is_error === true || subtype === 'error'
        ? { type: 'error', message: summary || 'Erreur Antigravity' }
        : { type: 'done', summary };
      return;
    }

    if (type === 'error') {
      const err = asRecord(obj.error);
      ctx.outcome = {
        type: 'error',
        message: asString(obj.message) ?? asString(err?.message) ?? 'Erreur Antigravity',
      };
      return;
    }

    if (type === 'system' && subtype === 'init') return;

    if (type === 'assistant' || type === 'message') {
      const content = asRecord(obj.message)?.content ?? obj.content;
      if (typeof content === 'string') {
        this.emitText(ctx, content);
        return;
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = asRecord(block);
          if (!b) continue;
          if (b.type === 'text') {
            this.emitText(ctx, asString(b.text) ?? '');
          } else if (b.type === 'tool_use') {
            const id = asString(b.id);
            const name = asString(b.name) ?? 'outil';
            ctx.toolCalls.set(id ?? '', { name, input: b.input });
            ctx.emit({ type: 'tool_call', id, name, input: b.input });
          }
        }
        return;
      }
      // Forme tolérante : `{type:'assistant', text:'…'}`.
      this.emitText(ctx, asString(obj.text) ?? '');
      return;
    }

    if (type === 'user') {
      const content = asRecord(obj.message)?.content ?? obj.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        const b = asRecord(block);
        if (!b || b.type !== 'tool_result') continue;
        const id = asString(b.tool_use_id) ?? asString(b.toolUseId);
        const call = id ? ctx.toolCalls.get(id) : undefined;
        const name = call?.name ?? 'outil';
        const isError = b.is_error === true || asString(b.status) === 'error';
        ctx.emit({ type: 'tool_result', id, name, output: b.content, isError });
        if (!isError && WRITE_TOOLS.has(name)) {
          const input = asRecord(call?.input);
          const filePath = asString(input?.file_path) ?? asString(input?.notebook_path) ?? asString(input?.path);
          if (filePath) ctx.emit({ type: 'file_changed', path: filePath });
        }
      }
      return;
    }

    // Tolérance : tout objet portant du texte (delta ou forme inconnue) → assistant_text.
    const text = asString(obj.text) ?? asString(asRecord(obj.delta)?.text);
    if (text) this.emitText(ctx, text);
  }

  private emitText(ctx: TurnContext, text: string): void {
    if (text === '' || text === ctx.lastText) return;
    ctx.lastText = text;
    ctx.emit({ type: 'assistant_text', text, partial: false });
  }
}

export class AgyAdapter implements AgentAdapter {
  readonly id: AgentId = 'agy';
  readonly label = 'Antigravity';
  private discovery?: Promise<AgyDiscovery>;

  constructor(private readonly cfg: AgyAdapterConfig) {}

  async isAvailable(): Promise<{ ok: boolean; detail?: string }> {
    const result = await checkCliAvailable(this.cfg.command, this.cfg.prefixArgs);
    if (result.ok) return result;
    const cause = result.detail && !/ENOENT|not found|introuvable/i.test(result.detail) ? ` : ${result.detail}` : '';
    return { ok: false, detail: `${NOT_FOUND}${cause}` };
  }

  getCapabilities(): Promise<AgentCapabilities> {
    return this.discover().then((d) => d.caps);
  }

  private discover(): Promise<AgyDiscovery> {
    this.discovery ??= discoverAgy(this.cfg.command, this.cfg.prefixArgs ?? []);
    return this.discovery;
  }

  start(opts: StartOptions): AgentRun {
    return new AgyRun(this.cfg, opts, () => this.discover());
  }
}
