// Sessions natives OpenCode : `session list` et `session export` (v2.0.32, vérifié sur cette machine).

import type { AgentEvent } from '../../core/events';
import type { NativeSession, NativeSessionContent } from '../AgentAdapter';
import { asNumber, asRecord, asString } from '../base';
import { runCli } from '../process';
import { errorExcerpt, flattenText, sameCwd } from './util';

export interface OpenCodeSessionRef {
  command: string;
  prefixArgs?: string[];
}

const WRITE_TOOLS = new Set(['write', 'edit', 'patch', 'multiedit']);

/** `provider/id` (+ `effort` si la variante n'est pas « default »). */
function modelRef(value: unknown): { model?: string; effort?: string } {
  const rec = asRecord(value);
  if (!rec) return {};
  const id = asString(rec.id);
  const provider = asString(rec.providerID);
  const model = provider && id ? `${provider}/${id}` : id;
  const variant = asString(rec.variant);
  return {
    ...(model ? { model } : {}),
    ...(variant && variant !== 'default' ? { effort: variant } : {}),
  };
}

/** Liste JSON → sessions du dossier `cwd` (filtre sur `directory`), plus récentes d'abord. */
export function parseOpenCodeSessionList(json: string, cwd: string): NativeSession[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const sessions: NativeSession[] = [];
  for (const raw of parsed) {
    const obj = asRecord(raw);
    if (!obj) continue;
    const id = asString(obj.id);
    if (!id) continue;
    const directory = asString(obj.directory);
    if (directory && !sameCwd(directory, cwd)) continue;
    const created = asNumber(obj.created);
    sessions.push({
      id,
      title: asString(obj.title)?.trim() || 'Session sans titre',
      ...(created > 0 ? { createdAt: created } : {}),
      updatedAt: asNumber(obj.updated),
      ...(directory ? { cwd: directory } : {}),
    });
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

/** Export JSON d'une session → événements communs ; `undefined` si la réponse est invalide. */
export function parseOpenCodeExport(json: string): NativeSessionContent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  const root = asRecord(parsed);
  const info = asRecord(root?.info);
  if (!info || !root) return undefined;

  const fallbackModel = modelRef(info.model);
  let model = fallbackModel.model;
  let effort = fallbackModel.effort;

  const events: { ts: number; event: AgentEvent }[] = [];
  let ts = asNumber(asRecord(info.time)?.created);
  const messages = Array.isArray(root.messages) ? root.messages : [];

  for (const raw of messages) {
    const message = asRecord(raw);
    if (!message) continue;
    const created = asNumber(asRecord(message.time)?.created);
    if (created > 0) ts = created;

    const type = asString(message.type);
    if (type === 'user') {
      const text = asString(message.text) ?? flattenText(message.content);
      if (text && text.trim() !== '') events.push({ ts, event: { type: 'user_text', text } });
      continue;
    }
    if (type !== 'assistant') continue;

    const ref = modelRef(message.model);
    if (ref.model) {
      model = ref.model;
      effort = ref.effort;
    }

    const content = Array.isArray(message.content) ? message.content : [];
    for (const rawBlock of content) {
      const block = asRecord(rawBlock);
      if (!block) continue;
      if (block.type === 'text') {
        const text = asString(block.text) ?? '';
        if (text.trim() !== '') events.push({ ts, event: { type: 'assistant_text', text, partial: false } });
        continue;
      }
      if (block.type !== 'tool') continue;

      const id = asString(block.id);
      const name = asString(block.name) ?? 'outil';
      const state = asRecord(block.state);
      const input = state?.input;
      events.push({ ts, event: { type: 'tool_call', id, name, input } });

      const status = asString(state?.status);
      if (status !== 'completed' && status !== 'error') continue;
      const isError = status === 'error';
      const output = isError
        ? (state?.error ?? state?.output ?? flattenText(state?.content))
        : (flattenText(state?.content) ?? state?.output);
      events.push({ ts, event: { type: 'tool_result', id, name, output, isError } });
      if (!isError && WRITE_TOOLS.has(name.toLowerCase())) {
        const inputRec = asRecord(input);
        const filePath = asString(inputRec?.path) ?? asString(inputRec?.filePath) ?? asString(inputRec?.file_path);
        if (filePath) events.push({ ts, event: { type: 'file_changed', path: filePath } });
      }
    }
  }

  const location = asRecord(info.location);
  const title = asString(info.title)?.trim();
  const directory = asString(location?.directory);
  return {
    events,
    ...(title ? { title } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(directory ? { cwd: directory } : {}),
  };
}

/** `opencode session list --format json -n 200 --standalone`, filtré sur `cwd`. */
export async function listOpenCodeSessions(cwd: string, ref: OpenCodeSessionRef): Promise<NativeSession[]> {
  const args = [...(ref.prefixArgs ?? []), 'session', 'list', '--format', 'json', '-n', '200', '--standalone'];
  const res = await runCli(ref.command, args, cwd);
  if (res.code !== 0) {
    throw new Error(`Liste des sessions OpenCode impossible${errorExcerpt(res.stdout, res.stderr)}`);
  }
  return parseOpenCodeSessionList(res.stdout, cwd);
}

/** `opencode session export <id> --standalone` converti en événements communs. */
export async function readOpenCodeSession(
  sessionId: string,
  cwd: string,
  ref: OpenCodeSessionRef,
): Promise<NativeSessionContent> {
  const id = sessionId.trim();
  if (id === '') throw new Error('Identifiant de session OpenCode vide');
  const args = [...(ref.prefixArgs ?? []), 'session', 'export', id, '--standalone'];
  const res = await runCli(ref.command, args, cwd);
  if (res.code !== 0) {
    throw new Error(`Export de la session OpenCode "${id}" impossible${errorExcerpt(res.stdout, res.stderr)}`);
  }
  const content = parseOpenCodeExport(res.stdout);
  if (!content) throw new Error(`Réponse OpenCode invalide pour la session "${id}"`);
  return content;
}
