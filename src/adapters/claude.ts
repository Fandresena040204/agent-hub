// Adaptateur Claude Code : `claude -p … --output-format stream-json --verbose`.

import type { AgentCapabilities, AgentAdapter, AgentRun, StartOptions, NativeSession, NativeSessionContent } from './AgentAdapter';
import { InvalidOptionError } from './AgentAdapter';
import type { AgentId } from '../core/types';
import { runCli } from './process';
import { listClaudeSessions, readClaudeSession } from './sessions/claudeSessions';
import {
  CliAgentRun,
  TurnContext,
  asRecord,
  asString,
  asNumber,
  checkCliAvailable,
  type CliLaunchConfig,
} from './base';

export interface ClaudeAdapterConfig {
  command: string;
  prefixArgs?: string[];
  /** Script Node du hook PreToolUse (garde-fou scope + git). */
  guardScript?: string;
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit']);

/** Extrait les niveaux d'effort de `claude --help` (option --effort suivie de « (low, …) »). */
export function parseClaudeEfforts(help: string): string[] {
  const lines = help.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^\s*--effort\s+<level>/.test(l));
  if (idx < 0) return [];
  const section: string[] = [lines[idx]];
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^\s+--?\S/.test(lines[i])) break;
    section.push(lines[i]);
    if (/\)/.test(lines[i])) break;
  }
  const m = /\(([^)]*)\)/.exec(section.join('\n'));
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z][\w-]*$/.test(s));
}

/** Extrait les alias de modèles de l'aide de `--model` (« e.g. 'fable', 'opus', or 'sonnet' »). */
export function parseClaudeModelAliases(help: string): string[] {
  const lines = help.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^\s*--model\s+<model>/.test(l));
  if (idx < 0) return [];
  const section: string[] = [lines[idx]];
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^\s+--?\S/.test(lines[i])) break;
    section.push(lines[i]);
  }
  const aliases = [...section.join('\n').matchAll(/'([^']+)'/g)].map((m) => m[1].trim());
  return [...new Set(aliases.filter((a) => /^[a-z][a-z0-9._-]*$/i.test(a)))];
}

async function discoverClaude(command: string, prefixArgs: string[]): Promise<AgentCapabilities> {
  const help = await runCli(command, [...prefixArgs, '--help']);
  if (help.code !== 0) return { models: 'free-text', effortLevels: null };
  const text = help.stdout || help.stderr;
  const aliases = parseClaudeModelAliases(text);
  const efforts = parseClaudeEfforts(text);
  return {
    models: aliases.length > 0 ? aliases.map((id) => ({ id })) : 'free-text',
    effortLevels: efforts.length > 0 ? efforts.map((id) => ({ id })) : null,
  };
}

/** Valide model/effort pour Claude : alias de l'aide ou id complet `claude-…`. */
// L'aide ne cite que des exemples d'alias (« e.g. 'fable', 'opus', or 'sonnet' ») : un alias d'un seul mot
// non listé (ex. `haiku`, `opus[1m]`) est accepté et c'est le CLI qui tranche.
const CLAUDE_ALIAS = /^[a-z][a-z0-9-]*(\[[a-z0-9]+\])?$/;

function validateClaudeCaps(caps: AgentCapabilities, model?: string, effort?: string): void {
  if (model && Array.isArray(caps.models) && !caps.models.some((m) => m.id === model) && !model.startsWith('claude-') && !CLAUDE_ALIAS.test(model)) {
    throw new InvalidOptionError('model', model, [...caps.models.map((m) => m.id), 'un autre alias', 'ou un id complet claude-…']);
  }
  if (effort) {
    if (!caps.effortLevels) throw new InvalidOptionError('effort', effort, []);
    if (!caps.effortLevels.some((e) => e.id === effort)) {
      throw new InvalidOptionError('effort', effort, caps.effortLevels.map((e) => e.id));
    }
  }
}

class ClaudeRun extends CliAgentRun {
  constructor(
    private readonly cfg: ClaudeAdapterConfig,
    opts: StartOptions,
    environment: NodeJS.ProcessEnv,
    private readonly caps: () => Promise<AgentCapabilities>,
  ) {
    super({ id: 'claude', command: cfg.command, prefixArgs: cfg.prefixArgs, env: environment } satisfies CliLaunchConfig, opts);
  }

  protected fetchCaps(): Promise<AgentCapabilities> {
    return this.caps();
  }

  /** Claude accepte un alias de l'aide ou tout id complet `claude-…`. */
  protected override validateCaps(caps: AgentCapabilities): void {
    validateClaudeCaps(caps, this.opts.model, this.opts.effort);
  }

  protected buildArgs(ctx: TurnContext): string[] {
    const o = this.opts;
    const args = ['-p', ctx.text, '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none'];
    if (o.model) args.push('--model', o.model);
    if (o.effort) args.push('--effort', o.effort);
    if (ctx.sessionId) args.push('--resume', ctx.sessionId);
    if (o.systemPromptAppend && !ctx.sessionId) args.push('--append-system-prompt', o.systemPromptAppend);
    if (o.mcpServerUrl) {
      const server: Record<string, unknown> = { type: 'http', url: o.mcpServerUrl };
      if (o.mcpToken) server.headers = { Authorization: `Bearer ${o.mcpToken}` };
      args.push('--mcp-config', JSON.stringify({ mcpServers: { agenthub: server } }));
      // Sans cela, --permission-prompts none refuse les outils MCP (aucune invite possible).
      args.push('--allowedTools', 'mcp__agenthub');
    }

    const disallowed = new Set<string>();
    if (o.permissionMode === 'readonly') {
      args.push('--permission-mode', 'default');
      for (const tool of ['Edit', 'Write', 'NotebookEdit']) disallowed.add(tool);
    } else if (o.permissionMode === 'edit') {
      args.push('--permission-mode', 'acceptEdits');
    } else {
      args.push('--permission-mode', 'bypassPermissions');
    }
    for (const cmd of o.gitPolicy.forbidden) {
      disallowed.add(`Bash(git ${cmd}:*)`);
      disallowed.add(`PowerShell(git ${cmd}:*)`);
    }
    if (disallowed.size > 0) args.push('--disallowedTools', ...[...disallowed]);

    if (this.cfg.guardScript) {
      const settings = {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Edit|Write|NotebookEdit|Bash|PowerShell',
              hooks: [{ type: 'command', command: `node "${this.cfg.guardScript}"` }],
            },
          ],
        },
      };
      args.push('--settings', JSON.stringify(settings));
    }
    return args;
  }

  protected parseLine(line: string, ctx: TurnContext): void {
    const obj = this.parseJson(line);
    if (!obj) return;

    if (obj.type === 'system' && obj.subtype === 'init') {
      const id = asString(obj.session_id);
      if (id) ctx.setSessionId(id);
      return;
    }

    if (obj.type === 'assistant') {
      const message = asRecord(obj.message);
      const content = message?.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        const b = asRecord(block);
        if (!b) continue;
        if (b.type === 'text') {
          const text = asString(b.text) ?? '';
          ctx.lastText = text;
          ctx.emit({ type: 'assistant_text', text, partial: false });
        } else if (b.type === 'tool_use') {
          const id = asString(b.id);
          const name = asString(b.name) ?? 'outil';
          ctx.toolCalls.set(id ?? '', { name, input: b.input });
          ctx.emit({ type: 'tool_call', id, name, input: b.input });
        }
      }
      return;
    }

    if (obj.type === 'user') {
      const message = asRecord(obj.message);
      const content = message?.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        const b = asRecord(block);
        if (!b || b.type !== 'tool_result') continue;
        const id = asString(b.tool_use_id);
        const call = id ? ctx.toolCalls.get(id) : undefined;
        const name = call?.name ?? 'outil';
        const isError = b.is_error === true;
        ctx.emit({ type: 'tool_result', id, name, output: b.content, isError });
        if (!isError && WRITE_TOOLS.has(name)) {
          const input = asRecord(call?.input);
          const filePath = asString(input?.file_path) ?? asString(input?.notebook_path);
          if (filePath) ctx.emit({ type: 'file_changed', path: filePath });
        }
      }
      return;
    }

    if (obj.type === 'result') {
      const usage = asRecord(obj.usage);
      const tokens = asNumber(usage?.input_tokens) + asNumber(usage?.output_tokens);
      const cost = typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined;
      ctx.emit({ type: 'usage', tokens, cost });
      const summary = asString(obj.result) ?? ctx.lastText;
      ctx.outcome = obj.is_error === true
        ? { type: 'error', message: summary || 'Erreur Claude Code' }
        : { type: 'done', summary };
    }
  }
}

export class ClaudeAdapter implements AgentAdapter {
  readonly id: AgentId = 'claude';
  readonly label = 'Claude Code';
  private caps?: Promise<AgentCapabilities>;

  constructor(private readonly cfg: ClaudeAdapterConfig) {}

  isAvailable(): Promise<{ ok: boolean; detail?: string }> {
    return checkCliAvailable(this.cfg.command, this.cfg.prefixArgs);
  }

  getCapabilities(): Promise<AgentCapabilities> {
    this.caps ??= discoverClaude(this.cfg.command, this.cfg.prefixArgs ?? []);
    return this.caps;
  }

  /** Validation publique utilisée par l'Orchestrator avant `start`. */
  async validate(model?: string, effort?: string): Promise<void> {
    validateClaudeCaps(await this.getCapabilities(), model, effort);
  }

  start(opts: StartOptions): AgentRun {
    const env: NodeJS.ProcessEnv = {};
    if (this.cfg.guardScript) {
      env.AGENT_HUB_FORBIDDEN_GIT = JSON.stringify(opts.gitPolicy.forbidden);
      if (opts.allowedPaths !== undefined) env.AGENT_HUB_ALLOWED_PATHS = JSON.stringify(opts.allowedPaths);
    }
    return new ClaudeRun(this.cfg, opts, env, () => this.getCapabilities());
  }

  /** Sessions natives du dossier (fichiers JSONL de `~/.claude/projects`). */
  listSessions(cwd: string): Promise<NativeSession[]> {
    return listClaudeSessions(cwd);
  }

  /** Historique d'une session native converti en événements communs. */
  readSession(sessionId: string, cwd: string): Promise<NativeSessionContent> {
    return readClaudeSession(sessionId, cwd);
  }
}
