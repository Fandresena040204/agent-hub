// Dossier de passation : contexte autonome remis à un nouvel agent qui reprend un thread.

import type { StoredEvent } from './events';
import type { CommitPermission, ThreadInfo } from './types';

const DEFAULT_MAX_CHARS = 12_000;
const MAX_ASSISTANT_CHARS = 1500;

export interface HandoffInput {
  thread: ThreadInfo;
  events: StoredEvent[];
  children: ThreadInfo[];
  uncommitted: string[];
  commitPermission: CommitPermission;
  summary?: string;
  maxChars?: number;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** Une ligne par événement retenu pour la section « Derniers échanges ». */
function exchangeLine(stored: StoredEvent): string | undefined {
  const e = stored.event;
  switch (e.type) {
    case 'user_text':
      return `- Utilisateur : ${oneLine(e.text)}`;
    case 'assistant_text':
      if (e.partial) return undefined;
      return `- Agent : ${truncate(oneLine(e.text), MAX_ASSISTANT_CHARS)}`;
    case 'tool_call':
      return `- outil ${e.name}`;
    case 'commit_made':
      return `- Commit ${shortSha(e.sha)} : ${oneLine(e.message)}`;
    case 'scope_violation':
      return `- Violation de scope : ${e.path}`;
    case 'commit_violation':
      return `- Violation git : commit non autorisé (${shortSha(e.oldHead)} → ${shortSha(e.newHead)})`;
    default:
      return undefined;
  }
}

function agentLabel(thread: ThreadInfo): string {
  return `${thread.agent}${thread.model ? `/${thread.model}` : ''}`;
}

function childSection(children: ThreadInfo[]): string {
  const lines = ['## Threads délégués', ''];
  if (children.length === 0) {
    lines.push('Aucun thread délégué.');
    return lines.join('\n');
  }
  for (const child of children) {
    const model = child.model ? `/${child.model}` : '';
    lines.push(
      `- ${child.id} — « ${child.title} » — ${child.agent}${model} — statut ${child.status} — isolation ${child.isolation}`,
    );
    lines.push(`  - fichiers modifiés : ${child.changedFiles.length > 0 ? child.changedFiles.join(', ') : '(aucun)'}`);
    const violations: string[] = [];
    if (child.violations.scope.length > 0) violations.push(`scope ${child.violations.scope.join(', ')}`);
    if (child.violations.commits.length > 0) violations.push(`${child.violations.commits.length} commit(s) non autorisé(s)`);
    if (violations.length > 0) lines.push(`  - violations : ${violations.join(' ; ')}`);
    if (child.isolation === 'worktree' && child.status === 'done') {
      lines.push('  - à appliquer avec merge_thread (worktree terminé, non appliqué).');
    }
  }
  return lines.join('\n');
}

function uncommittedSection(paths: string[]): string {
  const lines = ['## Fichiers modifiés non commités', ''];
  if (paths.length === 0) lines.push('Aucun.');
  else for (const p of paths) lines.push(`- ${p}`);
  return lines.join('\n');
}

function permissionLabel(p: CommitPermission): string {
  return p === 'deny' ? 'off' : p === 'allow' ? 'on' : 'ask';
}

/**
 * Construit le dossier de passation (Markdown, français) transmis au nouvel agent.
 * Les échanges les plus anciens sont tronqués en premier pour tenir dans `maxChars`.
 */
/** Marqueurs du dossier (utilisés par l'UI pour le replier). */
export const HANDOFF_PREFIX = 'Dossier de passation Agent Hub';
export const HANDOFF_TAIL = 'Continue le travail à partir de cet état. Relis les fichiers si besoin.';

export function buildHandoff(input: HandoffInput): string {
  const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;
  const thread = input.thread;

  const header =
    `${HANDOFF_PREFIX} — tu reprends ce thread à la place de ${agentLabel(thread)}.`;

  const firstUser = input.events.find(
    (e) => e.event.type === 'user_text' && e.event.text.trim() !== '',
  );
  const origin = [
    "## Demande d'origine",
    '',
    firstUser && firstUser.event.type === 'user_text' ? oneLine(firstUser.event.text) : '(inconnue)',
  ].join('\n');

  const summarySection = input.summary?.trim()
    ? ['## Résumé de l\'agent sortant', '', truncate(input.summary.trim(), maxChars)].join('\n')
    : undefined;

  const tail = HANDOFF_TAIL;

  const fixedParts = [header, origin];
  if (summarySection) fixedParts.push(summarySection);
  fixedParts.push(childSection(input.children));
  fixedParts.push(uncommittedSection(input.uncommitted));
  fixedParts.push(['## Permission de commit', '', permissionLabel(input.commitPermission)].join('\n'));
  fixedParts.push(tail);

  const fixed = fixedParts.join('\n\n');

  const lines = input.events
    .map(exchangeLine)
    .filter((l): l is string => l !== undefined);

  if (lines.length === 0) {
    const out = `${fixed}`;
    return out.length > maxChars ? out.slice(0, maxChars) : out;
  }

  const exchangesHeader = '## Derniers échanges\n\n';
  const overhead = fixed.length + exchangesHeader.length + 2;
  const budget = Math.max(0, maxChars - overhead);

  const chosen: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = lines[i].length + 1;
    if (used + cost > budget) break;
    chosen.push(lines[i]);
    used += cost;
  }
  chosen.reverse();

  if (chosen.length === 0) {
    return fixed.length > maxChars ? fixed.slice(0, maxChars) : fixed;
  }

  // Insertion avant la fin : les échanges précèdent les sections d'état.
  const exchanges = exchangesHeader + chosen.join('\n');
  const suffixIndex = fixed.lastIndexOf('\n\n## Threads délégués');
  const out = suffixIndex >= 0
    ? `${fixed.slice(0, suffixIndex)}\n\n${exchanges}${fixed.slice(suffixIndex)}`
    : `${fixed}\n\n${exchanges}`;
  return out.length > maxChars ? out.slice(0, maxChars) : out;
}
