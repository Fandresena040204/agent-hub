// Sessions natives Claude Code : fichiers ~/.claude/projects/<cwd encodé>/<sessionId>.jsonl.

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
  streamJsonLines,
} from './util';

export interface ClaudeSessionsOptions {
  /** Dossier personnel (défaut os.homedir()) ; ignoré si `CLAUDE_CONFIG_DIR` est défini. */
  homeDir?: string;
  /** Remplace `~/.claude` (prioritaire sur `homeDir` et l'environnement). */
  configDir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ClaudeSessionData {
  events: { ts: number; event: AgentEvent }[];
  title?: string;
  cwd?: string;
  model?: string;
  createdAt?: number;
  updatedAt?: number;
  messageCount: number;
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit']);
const TECHNICAL_PREFIXES = ['<command-', '<local-command'];
const TITLE_TYPES = new Set(['summary', 'custom-title', 'ai-title']);

/** Encoding Claude du cwd : chaque caractère non alphanumérique devient `-`. */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Dossier de configuration Claude (`CLAUDE_CONFIG_DIR`, sinon `$HOME/.claude`). */
export function claudeConfigDir(opts: ClaudeSessionsOptions = {}): string {
  const env = opts.env ?? process.env;
  const fromEnv = opts.configDir ?? env.CLAUDE_CONFIG_DIR?.trim();
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return path.join(opts.homeDir ?? os.homedir(), '.claude');
}

/** Vrai pour un message utilisateur purement technique (commande locale, rappel système…). */
export function isTechnicalUserText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (TECHNICAL_PREFIXES.some((p) => trimmed.startsWith(p))) return true;
  // Un message qui n'est qu'un (ou plusieurs) <system-reminder> est ignoré.
  const withoutReminders = trimmed.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  return withoutReminders === '';
}

class ClaudeParser {
  private readonly events: { ts: number; event: AgentEvent }[] = [];
  private readonly tools = new Map<string, { name: string; input: unknown }>();
  private explicitTitle?: string;
  private firstUserText?: string;
  private cwd?: string;
  private model?: string;
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
    const ts = parseTimestamp(obj.timestamp);
    if (ts !== undefined) {
      this.firstTs ??= ts;
      this.lastTs = ts;
    }
    const at = ts ?? this.lastTs ?? this.fallbackTs;

    const type = asString(obj.type) ?? '';
    if (TITLE_TYPES.has(type)) {
      const title = asString(obj.title) ?? asString(obj.customTitle) ?? asString(obj.aiTitle) ?? asString(obj.summary);
      if (title && title.trim() !== '') this.explicitTitle = title.trim();
      return;
    }
    if (obj.isSidechain === true) return;

    const cwd = asString(obj.cwd);
    if (cwd) this.cwd = cwd;

    if (type === 'user') this.pushUser(asRecord(obj.message), at);
    else if (type === 'assistant') this.pushAssistant(asRecord(obj.message), at);
  }

  result(): ClaudeSessionData {
    const fallback = this.firstUserText ? oneLineTitle(this.firstUserText) : undefined;
    const title = this.explicitTitle ?? (fallback && fallback !== '' ? fallback : undefined);
    return {
      events: this.events,
      title,
      cwd: this.cwd,
      model: this.model,
      createdAt: this.firstTs,
      updatedAt: this.lastTs ?? this.fallbackTs,
      messageCount: this.messageCount,
    };
  }

  private pushUser(message: Record<string, unknown> | undefined, at: number): void {
    const content = message?.content;
    if (typeof content === 'string') {
      this.addUserText(content, at);
      return;
    }
    if (!Array.isArray(content)) return;
    for (const raw of content) {
      const block = asRecord(raw);
      if (!block) continue;
      if (block.type === 'text') {
        this.addUserText(asString(block.text) ?? '', at);
        continue;
      }
      if (block.type !== 'tool_result') continue;

      const id = asString(block.tool_use_id);
      const call = id ? this.tools.get(id) : undefined;
      const name = call?.name ?? 'outil';
      const isError = block.is_error === true;
      this.pushEvent({ ts: at, event: { type: 'tool_result', id, name, output: flattenText(block.content) ?? block.content, isError } });
      if (!isError && WRITE_TOOLS.has(name)) {
        const input = asRecord(call?.input);
        const filePath = asString(input?.file_path) ?? asString(input?.notebook_path);
        if (filePath) this.pushEvent({ ts: at, event: { type: 'file_changed', path: filePath } });
      }
    }
  }

  private pushAssistant(message: Record<string, unknown> | undefined, at: number): void {
    const model = asString(message?.model);
    if (model) this.model = model;

    const content = message?.content;
    if (typeof content === 'string') {
      this.addAssistantText(content, at);
      return;
    }
    if (!Array.isArray(content)) return;
    for (const raw of content) {
      const block = asRecord(raw);
      if (!block) continue;
      // Les blocs `thinking` (et tout type inconnu) sont ignorés.
      if (block.type === 'text') {
        this.addAssistantText(asString(block.text) ?? '', at);
      } else if (block.type === 'tool_use') {
        const id = asString(block.id);
        const name = asString(block.name) ?? 'outil';
        const input = block.input;
        if (id) this.tools.set(id, { name, input });
        this.pushEvent({ ts: at, event: { type: 'tool_call', id, name, input } });
      }
    }
  }

  private addUserText(text: string, at: number): void {
    if (text.trim() === '' || isTechnicalUserText(text)) return;
    this.firstUserText ??= text;
    this.messageCount++;
    this.pushEvent({ ts: at, event: { type: 'user_text', text } });
  }

  private addAssistantText(text: string, at: number): void {
    if (text.trim() === '') return;
    this.messageCount++;
    this.pushEvent({ ts: at, event: { type: 'assistant_text', text, partial: false } });
  }

  private pushEvent(entry: { ts: number; event: AgentEvent }): void {
    if (this.collectEvents) this.events.push(entry);
  }
}

/** Convertit les lignes JSONL d'une session Claude (lignes invalides ignorées). */
export function parseClaudeSessionLines(
  lines: Iterable<string>,
  opts: { fallbackTs?: number; collectEvents?: boolean } = {},
): ClaudeSessionData {
  const parser = new ClaudeParser(opts.fallbackTs ?? 0, opts.collectEvents ?? true);
  for (const line of lines) parser.push(line);
  return parser.result();
}

async function parseClaudeFile(
  filePath: string,
  opts: { fallbackTs: number; collectEvents: boolean },
): Promise<ClaudeSessionData> {
  const parser = new ClaudeParser(opts.fallbackTs, opts.collectEvents);
  await streamJsonLines(filePath, (line) => parser.push(line));
  return parser.result();
}

function projectDir(cwd: string, opts: ClaudeSessionsOptions): string {
  return path.join(claudeConfigDir(opts), 'projects', encodeClaudeProjectDir(cwd));
}

/** Sessions Claude du dossier `cwd`, les plus récentes d'abord. */
export async function listClaudeSessions(cwd: string, opts: ClaudeSessionsOptions = {}): Promise<NativeSession[]> {
  const dir = projectDir(cwd, opts);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const sessions: NativeSession[] = [];
  for (const entry of entries) {
    // Les sous-dossiers (memory, …) ne contiennent pas de session.
    if (!entry.isFile() || !/\.jsonl$/i.test(entry.name)) continue;
    const id = entry.name.slice(0, -'.jsonl'.length);
    if (!id) continue;
    const filePath = path.join(dir, entry.name);
    const mtime = await fileMtimeMs(filePath);
    let data: ClaudeSessionData;
    try {
      data = await parseClaudeFile(filePath, { fallbackTs: mtime, collectEvents: false });
    } catch {
      continue;
    }
    sessions.push({
      id,
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

function checkSessionId(sessionId: string): string {
  const id = sessionId.trim();
  if (id === '' || !/^[A-Za-z0-9._-]+$/.test(id) || id.includes('..')) {
    throw new Error(`Identifiant de session Claude invalide : "${sessionId}"`);
  }
  return id;
}

/** Contenu converti d'une session Claude. */
export async function readClaudeSession(
  sessionId: string,
  cwd: string,
  opts: ClaudeSessionsOptions = {},
): Promise<NativeSessionContent> {
  const id = checkSessionId(sessionId);
  const dir = projectDir(cwd, opts);
  const filePath = path.join(dir, `${id}.jsonl`);
  if (!fs.existsSync(filePath)) throw new Error(`Session Claude introuvable : "${id}" (${dir})`);
  const mtime = await fileMtimeMs(filePath);

  let data: ClaudeSessionData;
  try {
    data = await parseClaudeFile(filePath, { fallbackTs: mtime, collectEvents: true });
  } catch (err) {
    throw new Error(`Impossible de lire la session Claude "${id}" : ${err instanceof Error ? err.message : String(err)}`);
  }
  return {
    events: data.events,
    ...(data.title ? { title: data.title } : {}),
    ...(data.model ? { model: data.model } : {}),
    ...(data.cwd ? { cwd: data.cwd } : {}),
  };
}
