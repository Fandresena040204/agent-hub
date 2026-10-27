// Sessions natives Codex : $CODEX_HOME/sessions/**/rollout-*.jsonl.
// Format issu de la documentation Codex : NON VÉRIFIÉ sur cette machine (CLI absent).

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentEvent } from '../../core/events';
import type { NativeSession, NativeSessionContent } from '../AgentAdapter';
import { asRecord, asString } from '../base';
import { parseJsonLine } from '../process';
import {
  fileMtimeMs,
  flattenText,
  oneLineTitle,
  parseTimestamp,
  readFirstLine,
  sameCwd,
  streamJsonLines,
} from './util';

export interface CodexSessionsOptions {
  /** Dossier personnel (défaut os.homedir()) ; ignoré si `CODEX_HOME` est défini. */
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface CodexSessionData {
  sessionId?: string;
  events: { ts: number; event: AgentEvent }[];
  title?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  createdAt?: number;
  updatedAt?: number;
  messageCount: number;
}

const TECHNICAL_PREFIXES = ['<environment_context>', '<user_instructions>'];

/** Dossier des rollouts (`$CODEX_HOME/sessions`, sinon `$HOME/.codex/sessions`). */
export function codexSessionsDir(opts: CodexSessionsOptions = {}): string {
  const env = opts.env ?? process.env;
  const home = env.CODEX_HOME?.trim() || path.join(opts.homeDir ?? os.homedir(), '.codex');
  return path.join(home, 'sessions');
}

function isTechnicalUserText(text: string): boolean {
  const trimmed = text.trim();
  return TECHNICAL_PREFIXES.some((p) => trimmed.startsWith(p));
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

class CodexParser {
  private readonly events: { ts: number; event: AgentEvent }[] = [];
  private readonly tools = new Map<string, { name: string; input: unknown }>();
  private sessionId?: string;
  private explicitTitle?: string;
  private firstUserText?: string;
  private cwd?: string;
  private model?: string;
  private effort?: string;
  private firstTs?: number;
  private lastTs?: number;
  private messageCount = 0;

  constructor(
    private readonly fallbackTs: number,
    private readonly collectEvents: boolean,
  ) {}

  push(line: string): void {
    if (line.trim() === '') return;
    const obj = parseJsonLine(line);
    if (!obj) return;
    const payload = asRecord(obj.payload);
    const ts = parseTimestamp(obj.timestamp) ?? parseTimestamp(payload?.timestamp);
    if (ts !== undefined) {
      this.firstTs ??= ts;
      this.lastTs = ts;
    }
    const at = ts ?? this.lastTs ?? this.fallbackTs;

    switch (asString(obj.type)) {
      case 'session_meta':
        this.sessionId = asString(payload?.id) ?? this.sessionId;
        this.cwd = asString(payload?.cwd) ?? this.cwd;
        this.explicitTitle = asString(payload?.title)?.trim() || this.explicitTitle;
        return;
      case 'turn_context':
        this.model = asString(payload?.model) ?? this.model;
        this.effort = asString(payload?.effort) ?? asString(payload?.reasoning_effort) ?? this.effort;
        return;
      case 'response_item':
        if (payload) this.pushResponseItem(payload, at);
        return;
      default:
        return;
    }
  }

  result(): CodexSessionData {
    const fallback = this.firstUserText ? oneLineTitle(this.firstUserText) : undefined;
    const title = this.explicitTitle ?? (fallback && fallback !== '' ? fallback : undefined);
    return {
      sessionId: this.sessionId,
      events: this.events,
      title,
      cwd: this.cwd,
      model: this.model,
      effort: this.effort,
      createdAt: this.firstTs,
      updatedAt: this.lastTs ?? this.fallbackTs,
      messageCount: this.messageCount,
    };
  }

  private pushResponseItem(payload: Record<string, unknown>, at: number): void {
    switch (asString(payload.type)) {
      case 'message':
        this.pushMessage(payload, at);
        return;
      case 'function_call': {
        const id = asString(payload.call_id);
        const name = asString(payload.name) ?? 'outil';
        const input = parseArguments(payload.arguments);
        if (id) this.tools.set(id, { name, input });
        this.pushEvent({ ts: at, event: { type: 'tool_call', id, name, input } });
        return;
      }
      case 'function_call_output': {
        const id = asString(payload.call_id);
        const call = id ? this.tools.get(id) : undefined;
        const isError = payload.success === false || asString(payload.status) === 'failed';
        this.pushEvent({
          ts: at,
          event: { type: 'tool_result', id, name: call?.name ?? 'outil', output: payload.output, isError },
        });
        return;
      }
      default:
        return;
    }
  }

  private pushMessage(payload: Record<string, unknown>, at: number): void {
    const role = asString(payload.role);
    const blocks = Array.isArray(payload.content) ? payload.content : [];
    const parts: string[] = [];
    for (const raw of blocks) {
      const block = asRecord(raw);
      if (!block) continue;
      const text = asString(block.text) ?? flattenText(block.content);
      if (text !== undefined) parts.push(text);
    }
    const text = parts.join('\n');
    if (text.trim() === '') return;

    if (role === 'user') {
      if (isTechnicalUserText(text)) return;
      this.firstUserText ??= text;
      this.messageCount++;
      this.pushEvent({ ts: at, event: { type: 'user_text', text } });
    } else if (role === 'assistant') {
      this.messageCount++;
      this.pushEvent({ ts: at, event: { type: 'assistant_text', text, partial: false } });
    }
  }

  private pushEvent(entry: { ts: number; event: AgentEvent }): void {
    if (this.collectEvents) this.events.push(entry);
  }
}

/** Convertit les lignes JSONL d'un rollout Codex (lignes invalides et types inconnus ignorés). */
export function parseCodexSessionLines(
  lines: Iterable<string>,
  opts: { fallbackTs?: number; collectEvents?: boolean } = {},
): CodexSessionData {
  const parser = new CodexParser(opts.fallbackTs ?? 0, opts.collectEvents ?? true);
  for (const line of lines) parser.push(line);
  return parser.result();
}

async function parseCodexFile(
  filePath: string,
  opts: { fallbackTs: number; collectEvents: boolean },
): Promise<CodexSessionData> {
  const parser = new CodexParser(opts.fallbackTs, opts.collectEvents);
  await streamJsonLines(filePath, (line) => parser.push(line));
  return parser.result();
}

/** Tous les `rollout-*.jsonl` sous `dir` (arborescence YYYY/MM/DD), profondeur bornée. */
async function findRolloutFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > 8) return [];
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await findRolloutFiles(full, depth + 1)));
    else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) out.push(full);
  }
  return out;
}

/** Sessions Codex du dossier `cwd`, les plus récentes d'abord. */
export async function listCodexSessions(cwd: string, opts: CodexSessionsOptions = {}): Promise<NativeSession[]> {
  const files = await findRolloutFiles(codexSessionsDir(opts));
  const sessions: NativeSession[] = [];
  for (const file of files) {
    const mtime = await fileMtimeMs(file);
    let data: CodexSessionData;
    try {
      data = await parseCodexFile(file, { fallbackTs: mtime, collectEvents: false });
    } catch {
      continue;
    }
    if (data.cwd && !sameCwd(data.cwd, cwd)) continue;
    sessions.push({
      id: data.sessionId ?? path.basename(file, '.jsonl'),
      title: data.title ?? 'Session sans titre',
      ...(data.createdAt !== undefined ? { createdAt: data.createdAt } : {}),
      updatedAt: data.updatedAt ?? mtime,
      ...(data.cwd ? { cwd: data.cwd } : {}),
      ...(data.model ? { model: data.model } : {}),
      messageCount: data.messageCount,
    });
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

/** Contenu converti d'une session Codex (recherche par id de métadonnées). */
export async function readCodexSession(
  sessionId: string,
  cwd: string,
  opts: CodexSessionsOptions = {},
): Promise<NativeSessionContent> {
  const id = sessionId.trim();
  if (id === '') throw new Error('Identifiant de session Codex vide');
  const files = await findRolloutFiles(codexSessionsDir(opts));
  for (const file of files) {
    let first: string;
    try {
      first = await readFirstLine(file);
    } catch {
      continue;
    }
    const meta = asRecord(parseJsonLine(first)?.payload);
    const metaId = asString(meta?.id);
    if (metaId !== id && !path.basename(file).includes(id)) continue;

    const mtime = await fileMtimeMs(file);
    let data: CodexSessionData;
    try {
      data = await parseCodexFile(file, { fallbackTs: mtime, collectEvents: true });
    } catch (err) {
      throw new Error(`Impossible de lire la session Codex "${id}" : ${err instanceof Error ? err.message : String(err)}`);
    }
    return {
      events: data.events,
      ...(data.title ? { title: data.title } : {}),
      ...(data.model ? { model: data.model } : {}),
      ...(data.effort ? { effort: data.effort } : {}),
      cwd: data.cwd ?? cwd,
    };
  }
  throw new Error(`Session Codex introuvable : "${id}"`);
}
