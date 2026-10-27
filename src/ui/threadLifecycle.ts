// Logique pure du cycle de vie des threads (aucun import vscode) : confirmation de
// suppression, repli après suppression, carte grisée d'un sous-agent supprimé.
import type { ThreadInfo } from '../core/types';
import { escapeHtml, isThreadRunning } from './presentation';

// ---------------------------------------------------------------- confirmation de suppression

/** Comptes du sous-arbre concerné par une suppression (le thread lui-même inclus). */
export interface ThreadSubtreeCounts {
  /** Threads délégués du sous-arbre, le thread principal exclu. */
  childCount: number;
  /** Threads du sous-arbre (lui-même inclus) en cours de tour. */
  runningCount: number;
  /** Threads du sous-arbre (lui-même inclus) en isolation worktree non appliquée. */
  unappliedWorktrees: number;
}

/**
 * Comptes du sous-arbre d'un thread supprimé : tous les descendants (la suppression d'un
 * principal emporte ses délégués), statut, isolation pris en compte.
 */
export function subtreeDeleteInfo(threads: ThreadInfo[], root: ThreadInfo): ThreadSubtreeCounts {
  const byParent = new Map<string, ThreadInfo[]>();
  for (const t of threads) {
    if (!t.parentId) continue;
    const arr = byParent.get(t.parentId);
    if (arr) arr.push(t);
    else byParent.set(t.parentId, [t]);
  }
  const descendants: ThreadInfo[] = [];
  const seen = new Set([root.id]);
  const queue = [...(byParent.get(root.id) ?? [])];
  while (queue.length) {
    const t = queue.shift() as ThreadInfo;
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    descendants.push(t);
    queue.push(...(byParent.get(t.id) ?? []));
  }
  const counts: ThreadSubtreeCounts = { childCount: descendants.length, runningCount: 0, unappliedWorktrees: 0 };
  for (const t of [root, ...descendants]) {
    if (isThreadRunning(t.status)) counts.runningCount++;
    if (t.isolation === 'worktree' && t.status !== 'applied') counts.unappliedWorktrees++;
  }
  return counts;
}

/** Données du texte de confirmation d'une suppression. */
export interface DeleteConfirmation extends ThreadSubtreeCounts {
  /** Le thread supprimé est un thread principal (ses délégués partent aussi). */
  isMain: boolean;
  agent: string;
}

/**
 * Détail de la boîte de confirmation : délégués (principal), tours en cours,
 * worktrees non appliqués, et toujours la session native du CLI conservée.
 */
export function deleteConfirmDetail(d: DeleteConfirmation): string {
  const lines: string[] = [];
  if (d.isMain && d.childCount > 0) {
    lines.push(
      d.childCount > 1
        ? `Ses ${d.childCount} threads délégués seront aussi supprimés.`
        : 'Son thread délégué sera aussi supprimé.',
    );
  }
  if (d.runningCount > 0) {
    lines.push(
      d.runningCount > 1
        ? `${d.runningCount} sont en cours et seront interrompus.`
        : '1 est en cours et sera interrompu.',
    );
  }
  if (d.unappliedWorktrees > 0) {
    lines.push(
      d.unappliedWorktrees > 1
        ? `Les modifications non appliquées de ${d.unappliedWorktrees} worktrees seront perdues.`
        : 'Les modifications non appliquées d\u2019un worktree seront perdues.',
    );
  }
  lines.push(`La session native du CLI (${d.agent}) n'est pas supprimée.`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- repli après suppression

/**
 * Thread affiché après la suppression d'un thread : son parent s'il existe encore,
 * sinon le thread principal le plus récent, sinon undefined (écran d'accueil).
 * `threads` = liste restante après la suppression ; `parentId` = parent du thread supprimé.
 */
export function fallbackThreadAfterRemoval(
  threads: ThreadInfo[],
  parentId: string | undefined,
  removedId: string,
): string | undefined {
  if (parentId && parentId !== removedId && threads.some((t) => t.id === parentId)) return parentId;
  const mains = threads.filter((t) => !t.parentId);
  if (!mains.length) return undefined;
  const newest = mains.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
  return newest.id;
}

// ---------------------------------------------------------------- carte « Sous-agent supprimé »

/** Carte grisée d'une délégation dont le thread n'existe plus. Ids et contenu échappés. */
export function subagentRemovedCardHtml(threadId: string, blockId: string): string {
  const eid = escapeHtml(threadId);
  return (
    `<div id="${escapeHtml(blockId)}" class="sacard sa-gone" data-thread="${eid}" title="Sous-agent supprimé de Agent Hub">`
    + '<div class="sa-l1"><span class="sdot"></span><span class="sa-title">Sous-agent supprimé</span></div>'
    + '</div>'
  );
}
