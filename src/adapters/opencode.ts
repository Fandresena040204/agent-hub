// Adaptateur OpenCode v2 : `opencode run --format json --standalone`.

import type { AgentCapabilities, AgentAdapter, AgentRun, StartOptions } from './AgentAdapter';
import type { AgentId } from '../core/types';
import { runCli } from './process';
import { normalizeRel } from '../core/glob';
import {
  CliAgentRun,
  TurnContext,
  asNumber,
  asRecord,
  asString,
  checkCliAvailable,
  type CliLaunchConfig,
} from './base';

export interface OpenCodeAdapterConfig {
  command: string;
  prefixArgs?: string[];
}

const WRITE_TOOLS = new Set(['write', 'edit', 'patch', 'multiedit']);

interface PermissionRule {
  action: string;
  resource: string;
  effect: 'allow' | 'deny';
}

/** Liste les modèles (`opencode models`, une ligne `provider/model`). */
function parseModels(stdout: string): { id: string }[] {
  return stdout
    .split(/\r?\n/)
    .map((l) => l.replace(/\u001b\[[0-9;]*m/g, '').trim())
    .filter((l) => l.includes('/') && !l.includes(' '))
    .map((id) => ({ id }));
}

/** Variantes (#effort) exposées par `GET /api/model`, union sur tous les modèles. */
export function parseVariants(json: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const obj = asRecord(parsed);
  const data = Array.isArray(parsed) ? parsed : Array.isArray(obj?.data) ? obj.data : undefined;
  if (!data) return null;
  const out = new Set<string>();
  for (const item of data) {
    const model = asRecord(item);
    const variants = model?.variants;
    if (!Array.isArray(variants)) continue;
    for (const v of variants) {
      const id = asString(asRecord(v)?.id) ?? asString(v);
      if (id) out.add(id);
    }
  }
  return out.size > 0 ? [...out] : null;
}

/** Clé `provider/model` telle que listée par `opencode models`. */
function modelKey(model: Record<string, unknown>): string | undefined {
  const provider = asString(model.providerID);
  const modelId = asString(model.modelID);
  if (provider && modelId) return `${provider}/${modelId}`;
  return asString(model.id);
}

/**
 * Variantes par modèle (`GET /api/model` réel : `{providerID, modelID, variants}`).
 * Un modèle sans variante vaut `[]` (aucun effort possible pour lui).
 */
export function parseVariantsByModel(json: string): Record<string, { id: string }[]> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const obj = asRecord(parsed);
  const data = Array.isArray(parsed) ? parsed : Array.isArray(obj?.data) ? obj.data : undefined;
  if (!data) return null;
  const out: Record<string, { id: string }[]> = {};
  for (const item of data) {
    const model = asRecord(item);
    if (!model) continue;
    const key = modelKey(model);
    if (!key) continue;
    const variants = Array.isArray(model.variants) ? model.variants : [];
    const levels: { id: string }[] = [];
    for (const v of variants) {
      const id = asString(asRecord(v)?.id) ?? asString(v);
      if (id && !levels.some((l) => l.id === id)) levels.push({ id });
    }
    out[key] = levels;
  }
  return Object.keys(out).length > 0 ? out : null;
}

async function discoverOpenCode(command: string, prefixArgs: string[]): Promise<AgentCapabilities> {
  const modelsResult = await runCli(command, [...prefixArgs, 'models']);
  const models = modelsResult.code === 0 ? parseModels(modelsResult.stdout) : [];
  let effortLevels: { id: string }[] | null = null;
  let effortLevelsByModel: Record<string, { id: string }[]> | undefined;
  try {
    const api = await runCli(command, [...prefixArgs, 'api', '--standalone', 'GET', '/api/model']);
    if (api.code === 0) {
      const byModel = parseVariantsByModel(api.stdout);
      if (byModel) {
        effortLevelsByModel = byModel;
        const union = new Set<string>();
        for (const levels of Object.values(byModel)) for (const l of levels) union.add(l.id);
        if (union.size > 0) effortLevels = [...union].map((id) => ({ id }));
      }
    }
  } catch {
    effortLevels = null;
  }
  return {
    models: models.length > 0 ? models : 'free-text',
    effortLevels,
    ...(effortLevelsByModel ? { effortLevelsByModel } : {}),
  };
}

/** Règles de permission OpenCode v2 (la dernière règle qui matche gagne). */
function buildPermissions(opts: StartOptions): PermissionRule[] {
  const rules: PermissionRule[] = [];
  const scoped = opts.allowedPaths !== undefined;
  if (opts.permissionMode === 'readonly') {
    rules.push({ action: 'edit', resource: '*', effect: 'deny' });
    rules.push({ action: 'shell', resource: '*', effect: 'deny' });
    rules.push({ action: 'execute', resource: '*', effect: 'deny' });
    return rules;
  }

  if (scoped) {
    rules.push({ action: 'edit', resource: '*', effect: 'deny' });
    for (const raw of opts.allowedPaths ?? []) {
      const glob = normalizeRel(raw);
      if (!glob) continue;
      rules.push({ action: 'edit', resource: glob, effect: 'allow' });
      if (!/[*?]/.test(glob)) rules.push({ action: 'edit', resource: `${glob}/**`, effect: 'allow' });
    }
    // Le bac à sable `execute` accède au fs : il contournerait la portée.
    rules.push({ action: 'execute', resource: '*', effect: 'deny' });
  }

  for (const cmd of opts.gitPolicy.forbidden) {
    rules.push({ action: 'shell', resource: `*git*${cmd}*`, effect: 'deny' });
  }
  return rules;
}

function buildConfig(opts: StartOptions): Record<string, unknown> {
  const config: Record<string, unknown> = { permissions: buildPermissions(opts) };
  if (opts.mcpServerUrl) {
    const server: Record<string, unknown> = { type: 'remote', url: opts.mcpServerUrl };
    if (opts.mcpToken) server.headers = { Authorization: `Bearer ${opts.mcpToken}` };
    config.mcp = { servers: { agenthub: server } };
  }
  return config;
}

function effortModel(model: string | undefined, effort: string | undefined): string | undefined {
  if (!model) return undefined;
  return effort ? `${model}#${effort}` : model;
}

class OpenCodeRun extends CliAgentRun {
  constructor(
    cfg: OpenCodeAdapterConfig,
    opts: StartOptions,
    private readonly caps: () => Promise<AgentCapabilities>,
  ) {
    const env: NodeJS.ProcessEnv = { OPENCODE_CONFIG_CONTENT: JSON.stringify(buildConfig(opts)) };
    super({ id: 'opencode', command: cfg.command, prefixArgs: cfg.prefixArgs, env } satisfies CliLaunchConfig, opts);
  }

  protected fetchCaps(): Promise<AgentCapabilities> {
    return this.caps();
  }

  protected buildArgs(ctx: TurnContext): string[] {
    const o = this.opts;
    const args = ['run', '--format', 'json', '--standalone'];
    const model = effortModel(o.model, o.effort);
    if (model) args.push('-m', model);
    if (ctx.sessionId) args.push('--session', ctx.sessionId);
    if (o.permissionMode !== 'readonly') args.push('--auto');
    const message = o.systemPromptAppend && ctx.index === 0
      ? `${o.systemPromptAppend}\n\n${ctx.text}`
      : ctx.text;
    args.push(message);
    return args;
  }
  protected parseLine(line: string, ctx: TurnContext): void {
    const obj = this.parseJson(line);
    if (!obj) return;

    const part = asRecord(obj.part);
    const sessionId = asString(obj.sessionID) ?? asString(part?.sessionID);
    if (sessionId) ctx.setSessionId(sessionId);

    switch (obj.type) {
      case 'text': {
        const text = asString(part?.text) ?? '';
        ctx.lastText = text;
        ctx.emit({ type: 'assistant_text', text, partial: false });
        return;
      }
      case 'tool_use': {
        const name = asString(part?.tool) ?? 'outil';
        const id = asString(part?.id) ?? asString(part?.callID);
        const state = asRecord(part?.state);
        const input = state?.input;
        ctx.emit({ type: 'tool_call', id, name, input });
        const status = asString(state?.status);
        if (status === 'completed' || status === 'error') {
          const isError = status === 'error';
          ctx.emit({
            type: 'tool_result',
            id,
            name,
            output: isError ? (state?.error ?? state?.output) : state?.output,
            isError,
          });
          if (!isError && WRITE_TOOLS.has(name.toLowerCase())) {
            const inputRec = asRecord(input);
            const filePath = asString(inputRec?.path) ?? asString(inputRec?.filePath) ?? asString(inputRec?.file_path);
            if (filePath) ctx.emit({ type: 'file_changed', path: filePath });
          }
        }
        return;
      }
      case 'step_finish': {
        const tokens = asRecord(part?.tokens);
        const total = asNumber(tokens?.input) + asNumber(tokens?.output) + asNumber(tokens?.reasoning);
        const cost = typeof part?.cost === 'number' ? part.cost : undefined;
        ctx.emit({ type: 'usage', tokens: total, cost });
        return;
      }
      case 'error': {
        const err = asRecord(part?.error) ?? asRecord(obj.error);
        const message = asString(err?.message)
          ?? asString(part?.message)
          ?? asString(obj.message)
          ?? 'Erreur OpenCode';
        ctx.outcome = { type: 'error', message };
        return;
      }
      default:
        return;
    }
  }
}

export class OpenCodeAdapter implements AgentAdapter {
  readonly id: AgentId = 'opencode';
  readonly label = 'OpenCode';
  private caps?: Promise<AgentCapabilities>;

  constructor(private readonly cfg: OpenCodeAdapterConfig) {}

  isAvailable(): Promise<{ ok: boolean; detail?: string }> {
    return checkCliAvailable(this.cfg.command, this.cfg.prefixArgs);
  }

  getCapabilities(): Promise<AgentCapabilities> {
    this.caps ??= discoverOpenCode(this.cfg.command, this.cfg.prefixArgs ?? []);
    return this.caps;
  }

  start(opts: StartOptions): AgentRun {
    return new OpenCodeRun(this.cfg, opts, () => this.getCapabilities());
  }
}
