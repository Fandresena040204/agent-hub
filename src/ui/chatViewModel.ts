// Logique pure de la vue de chat latérale (aucun import vscode) : testable.
import type { ChangedFile } from '../core/orchestratorApi';
import type { ThreadInfo } from '../core/types';
import { escapeHtml, fileParts, fileStatusText, isThreadRunning, sortThreads } from './presentation';
import type { FileStatus } from './presentation';

// ---------------------------------------------------------------- sélecteur de thread

export interface ChatThreadOption {
  id: string;
  /** Libellé complet : pastille de statut + indentation (délégués) + titre. */
  label: string;
}

const DOT_BUSY = '◐'; // thread en cours (démarrage / tour actif)
const DOT_IDLE = '●'; // thread au repos

/** Options du sélecteur : threads principaux triés, puis leurs délégués indentés « ↳ ». */
export function chatThreadOptions(threads: ThreadInfo[]): ChatThreadOption[] {
  const mains = sortThreads(threads.filter((t) => !t.parentId));
  const subsByParent = new Map<string, ThreadInfo[]>();
  for (const s of sortThreads(threads.filter((t) => t.parentId))) {
    const key = s.parentId as string;
    const arr = subsByParent.get(key) ?? [];
    arr.push(s);
    subsByParent.set(key, arr);
  }
  const mainIds = new Set(mains.map((m) => m.id));
  const out: ChatThreadOption[] = [];
  const push = (t: ThreadInfo, depth: 0 | 1): void => {
    const dot = isThreadRunning(t.status) ? DOT_BUSY : DOT_IDLE;
    out.push({ id: t.id, label: `${dot} ${depth ? '↳ ' : ''}${t.title}` });
  };
  for (const m of mains) {
    push(m, 0);
    for (const d of subsByParent.get(m.id) ?? []) push(d, 1);
  }
  // Délégués orphelins (parent absent de la liste) : en fin de liste.
  for (const [pid, ds] of subsByParent) if (!mainIds.has(pid)) for (const d of ds) push(d, 1);
  return out;
}

/** Sous-titre d'en-tête : `agent · modèle · effort · isolation` (champs absents omis). */
export function threadSubtitle(info: ThreadInfo): string {
  const parts: string[] = [info.agent];
  if (info.model) parts.push(info.model);
  if (info.effort) parts.push(info.effort);
  parts.push(info.isolation);
  return parts.join(' · ');
}

// ---------------------------------------------------------------- bloc fichiers modifiés

export interface FilesTotals {
  count: number;
  /** Total des ajouts connus (omis si aucun fichier ne l'expose, ex. binaire). */
  additions?: number;
  deletions?: number;
}

export function filesTotals(files: ChangedFile[]): FilesTotals {
  let additions: number | undefined;
  let deletions: number | undefined;
  for (const f of files) {
    if (f.additions !== undefined) additions = (additions ?? 0) + f.additions;
    if (f.deletions !== undefined) deletions = (deletions ?? 0) + f.deletions;
  }
  return { count: files.length, additions, deletions };
}

/** Signature d'un fichier modifié : `chemin:additions:deletions` (champs absents = ''). */
export function fileSignature(f: { path: string; additions?: number; deletions?: number }): string {
  return `${f.path}:${f.additions ?? ''}:${f.deletions ?? ''}`;
}

/** Fichiers « en attente de décision » : tout sauf les signatures conservées. */
export function pendingFiles(files: ChangedFile[], kept: readonly string[]): ChangedFile[] {
  return files.filter((f) => !kept.includes(fileSignature(f)));
}

export interface FilesActions {
  /** Worktree déjà appliqué au workspace : badge « appliqué », aucune action. */
  applied: boolean;
  /** Bouton « Appliquer » (thread worktree non appliqué). */
  apply: boolean;
  /** En-tête : « Tout conserver » (thread shared). */
  keepAll: boolean;
  /** En-tête : « Tout annuler ». */
  revertAll: boolean;
  /** Ligne : boutons ✓ Conserver / ↶ Annuler. */
  keep: boolean;
  revert: boolean;
  /** Thread actif : les actions sont momentanément désactivées. */
  busy: boolean;
}

const NO_ACTIONS: FilesActions = {
  applied: false, apply: false, keepAll: false, revertAll: false, keep: false, revert: false, busy: false,
};

/** Actions disponibles selon l'isolation et le statut du thread. */
export function filesActions(info: ThreadInfo): FilesActions {
  if (info.isolation !== 'worktree') {
    return {
      ...NO_ACTIONS, busy: isThreadRunning(info.status),
      keepAll: true, revertAll: true, keep: true, revert: true,
    };
  }
  if (info.status === 'applied') return { ...NO_ACTIONS, applied: true }; // worktree appliqué : plus rien à décider
  return {
    ...NO_ACTIONS, busy: isThreadRunning(info.status),
    apply: true, revertAll: true, keep: true, revert: true,
  };
}

const STATUS_LETTER: Record<FileStatus, string> = { added: 'A', modified: 'M', deleted: 'D' };

const DISABLED_ATTR = (busy: boolean): string => (busy ? ' disabled' : '');

function fileRowHtml(f: ChangedFile, acts: FilesActions): string {
  const { dir, name } = fileParts(f.path);
  let nums = '';
  if (f.additions !== undefined) nums += `<span class="fnum add">+${f.additions}</span>`;
  if (f.deletions !== undefined) nums += `<span class="fnum del">−${f.deletions}</span>`;
  const btns: string[] = [];
  if (acts.keep) {
    btns.push(`<button type="button" class="fbtn" data-act="keep" title="Conserver" aria-label="Conserver ce fichier"${DISABLED_ATTR(acts.busy)}>✓</button>`);
  }
  if (acts.revert) {
    btns.push(`<button type="button" class="fbtn" data-act="revert" title="Annuler" aria-label="Annuler ce fichier"${DISABLED_ATTR(acts.busy)}>↶</button>`);
  }
  const dirHtml = dir ? `<span class="fdir">${escapeHtml(dir)}/</span>` : '';
  return (
    `<div class="frow" data-path="${escapeHtml(f.path)}" title="${escapeHtml(`${f.path} — ${fileStatusText(f.status)}`)}">`
    + `<span class="fstat fstat-${f.status}">${STATUS_LETTER[f.status]}</span>`
    + `<span class="fpath">${dirHtml}<span class="fname">${escapeHtml(name)}</span></span>`
    + nums
    + `<span class="fact">${btns.join('')}</span>`
    + '</div>'
  );
}

/** HTML du bloc « N fichiers modifiés » (au-dessus de la zone de saisie), tout échappé. */
export function renderFilesBlockHtml(info: ThreadInfo, files: ChangedFile[]): string {
  const acts = filesActions(info);
  const tot = filesTotals(files);
  const n = tot.count;
  let head = `<span class="farrow">▸</span><span class="ftitle">${n} fichier${n > 1 ? 's' : ''} modifié${n > 1 ? 's' : ''}</span>`;
  if (tot.additions !== undefined) head += `<span class="fnum add">+${tot.additions}</span>`;
  if (tot.deletions !== undefined) head += `<span class="fnum del">−${tot.deletions}</span>`;
  const off = DISABLED_ATTR(acts.busy);
  const right: string[] = [];
  if (acts.apply) {
    right.push(`<button type="button" class="fbtn apply" data-act="apply" title="Appliquer le worktree au workspace"${off}>Appliquer</button>`);
  }
  if (acts.keepAll) right.push(`<button type="button" class="fbtn" data-act="keepAll" title="Tout conserver"${off}>Tout conserver</button>`);
  if (acts.revertAll) right.push(`<button type="button" class="fbtn" data-act="revertAll" title="Tout annuler"${off}>Tout annuler</button>`);
  if (acts.applied) right.push('<span class="fbadge">appliqué</span>');
  return (
    `<details id="fileshdr" open><summary>${head}<span class="fspacer"></span>${right.join('')}</summary>`
    + `<div class="frows">${files.map((f) => fileRowHtml(f, acts)).join('')}</div></details>`
  );
}
