// Logique de présentation pure (aucun import vscode) : partagée entre les vues, testable.

import type { AgentEvent, AgentRef } from '../core/events';
import { effortLevelsFor, type AgentCapabilities } from '../adapters/AgentAdapter';
import type { CommitPreview } from '../core/orchestratorApi';
import { HANDOFF_PREFIX, HANDOFF_TAIL } from '../core/handoff';
import type { AgentId, AgentSegment, CommitPermission, ThreadInfo, ThreadStatus } from '../core/types';

// ---------------------------------------------------------------- utils HTML

/** Échappe &, <, >, ", ' pour tout insertion dans du HTML (texte ou attribut). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&#38;')
    .replace(/</g, '&#60;')
    .replace(/>/g, '&#62;')
    .replace(/"/g, '&#34;')
    .replace(/'/g, '&#39;');
}

/** Tronque la chaîne à `max` caractères au total (suffixe inclus). */
export function truncate(s: string, max: number, suffix = '…'): string {
  if (max <= 0) return s.length ? suffix : '';
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + suffix;
}

// ---------------------------------------------------------------- threads

export interface ThreadStatusMeta {
  icon: string;
  label: string;
}

/** Icône (codicon) et libellé FR par statut de thread. */
export const THREAD_STATUS: Record<ThreadStatus, ThreadStatusMeta> = {
  starting: { icon: 'loading~spin', label: 'démarrage' },
  running: { icon: 'loading~spin', label: 'en cours' },
  idle: { icon: 'debug-pause', label: 'en attente' },
  done: { icon: 'check', label: 'terminé' },
  applied: { icon: 'check', label: 'appliqué' },
  error: { icon: 'error', label: 'erreur' },
  conflict: { icon: 'warning', label: 'conflit' },
  interrupted: { icon: 'circle-slash', label: 'interrompu' },
};

export function threadIconId(status: ThreadStatus): string {
  return THREAD_STATUS[status].icon;
}

export function threadStatusText(status: ThreadStatus): string {
  return THREAD_STATUS[status].label;
}

/** Un thread « running » démarre ou tourne ; tout autre statut est « finished ». */
export function isThreadRunning(status: ThreadStatus): boolean {
  return status === 'starting' || status === 'running';
}

/** Mot de statut pour contextValue : `running` | `idle` | `finished`. */
export function threadStatusWord(status: ThreadStatus): string {
  return isThreadRunning(status) ? 'running' : status === 'idle' ? 'idle' : 'finished';
}

/**
 * contextValue : `thread running|idle|finished main|sub shared|worktree[-done]`.
 * `running` = démarrage/tour en cours ; `idle` = en attente ; `finished` = fini.
 * `worktree-done` = isolation worktree ET statut done.
 */
export function threadContextValue(info: ThreadInfo): string {
  const parts = ['thread', threadStatusWord(info.status), info.parentId ? 'sub' : 'main'];
  if (info.isolation === 'worktree') {
    parts.push('worktree');
    if (info.status === 'done') parts.push('worktree-done');
  } else {
    parts.push('shared');
  }
  return parts.join(' ');
}

/** Description : `agent · modèle · effort · isolation · N fichiers` (+ badges de violation). */
export function threadDescription(info: ThreadInfo): string {
  const parts: string[] = [info.agent];
  if (info.model) parts.push(info.model);
  if (info.effort) parts.push(info.effort);
  parts.push(info.isolation);
  const n = info.changedFiles?.length ?? 0;
  if (n > 0) parts.push(`${n} fichier${n > 1 ? 's' : ''}`);
  if ((info.violations?.scope?.length ?? 0) > 0) parts.push('⚠ scope');
  if ((info.violations?.commits?.length ?? 0) > 0) parts.push('⚠ commit');
  return parts.join(' · ');
}

/** Threads triés par date de création (stables à date égale). */
export function sortThreads(threads: ThreadInfo[]): ThreadInfo[] {
  return [...threads].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** Escape puis place dans un code inline markdown ; les backticks internes sont neutralisés. */
function mdCode(v: string): string {
  return '`' + escapeHtml(String(v)).replace(/`/g, "'") + '`';
}

/** Escape une valeur pour une chaîne markdown. */
function md(v: string | number): string {
  return escapeHtml(String(v));
}

/** Tooltip markdown d'un thread : tous les détails (statut, scope, violations, worktree…). */
export function threadTooltip(info: ThreadInfo): string {
  const lines: string[] = [`**Statut :** ${threadStatusText(info.status)}`];
  const head = [`**Agent :** ${md(info.agent)}`];
  if (info.model) head.push(`**Modèle :** ${md(info.model)}`);
  if (info.effort) head.push(`**Effort :** ${md(info.effort)}`);
  lines.push(head.join(' · '));
  lines.push(`**Permission :** ${md(info.permissionMode)} · **Isolation :** ${md(info.isolation)}`);
  const hist = agentHistoryLines(info);
  if (hist) lines.push(`**Agents successifs :**\n\n${hist.map(md).join('\n\n')}`);
  if (info.worktreePath) lines.push(`**Worktree :** ${mdCode(info.worktreePath)}`);
  if (info.sessionId) lines.push(`**Session :** ${md(info.sessionId.length > 8 ? info.sessionId.slice(0, 8) + '…' : info.sessionId)}`);
  if (info.scope?.length) lines.push(`**Périmètre :** ${info.scope.map(mdCode).join(', ')}`);
  lines.push(`**Fichiers modifiés :** ${info.changedFiles?.length ?? 0}`);
  const vScope = info.violations?.scope ?? [];
  if (vScope.length) {
    lines.push(`**Violations de périmètre :** ${vScope.map(mdCode).join(', ')}`);
  }
  const vCommit = info.violations?.commits ?? [];
  if (vCommit.length) {
    lines.push(`**Commits interdits :** ${vCommit.map((c) => mdCode(`${c.oldHead.slice(0, 8)} → ${c.newHead.slice(0, 8)}`)).join(', ')}`);
  }
  if (info.summary) lines.push(`**Résumé :** ${md(info.summary)}`);
  if (info.error) lines.push(`**Erreur :** ${md(info.error)}`);
  return lines.join('\n\n');
}

// ---------------------------------------------------------------- cartes de sous-agents

/** Phase d'une carte de sous-agent : en cours / terminée / en erreur (pastille et résumé de groupe). */
export function cardPhase(status: ThreadStatus): 'run' | 'done' | 'fail' {
  if (isThreadRunning(status)) return 'run';
  if (status === 'error' || status === 'conflict') return 'fail';
  return 'done';
}

/** Durée d'un thread en ms : (fin du tour ?? dernière mise à jour) − création, bornée à 0. */
export function cardDurationMs(info: ThreadInfo, now: number): number {
  const end = isThreadRunning(info.status) ? now : (info.finishedAt ?? info.updatedAt);
  return Math.max(0, end - info.createdAt);
}

/** Durée lisible `mm:ss` (minutes non bornées, jamais négative). */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** En-tête d'un groupe de cartes : `3 sous-agents · 2 terminés · 1 en cours`. */
export function groupHeaderText(threads: ThreadInfo[]): string {
  let running = 0;
  let failed = 0;
  for (const t of threads) {
    const p = cardPhase(t.status);
    if (p === 'run') running++;
    else if (p === 'fail') failed++;
  }
  const done = threads.length - running - failed;
  const parts = [`${threads.length} sous-agent${threads.length > 1 ? 's' : ''}`];
  if (done) parts.push(`${done} terminé${done > 1 ? 's' : ''}`);
  if (running) parts.push(`${running} en cours`);
  if (failed) parts.push(`${failed} en erreur`);
  return parts.join(' · ');
}

/**
 * Un groupe de sous-agents ne s'étend que sur des délégations consécutives :
 * un message de l'utilisateur ou de l'agent ferme le groupe (les autres événements l'excitent).
 */
export function breaksSubagentGroup(ev: AgentEvent): boolean {
  return ev.type === 'user_text' || ev.type === 'assistant_text';
}

/** Fil d'Ariane d'un thread délégué : `← parent › enfant` (clic sur ← sélectionne le parent) ; '' pour un principal. */
export function lineageHtml(child: ThreadInfo, parent: ThreadInfo | undefined): string {
  if (!child.parentId) return '';
  const pTitle = parent ? truncate(parent.title, 48) : 'thread parent';
  return (
    `<button type="button" class="lcrumb" data-id="${escapeHtml(child.parentId)}" title="Revenir au thread parent">← ${escapeHtml(pTitle)}</button>`
    + `<span class="lgsep">›</span><span class="lgcur">${escapeHtml(truncate(child.title, 48))}</span>`
  );
}

/** Statuts de fin d'un tour de sous-agent qui déclenchent une notification. */
export const SUBAGENT_END_STATUSES: readonly ThreadStatus[] = ['done', 'error', 'interrupted'];

/** Texte de la notification de fin : `Sous-agent terminé : <titre> (<agent>/<modèle>, mm:ss)`. */
export function subagentNotificationText(info: ThreadInfo, now = Date.now()): string {
  const ref = agentRefText({ agent: info.agent, model: info.model, effort: info.effort });
  return `Sous-agent terminé : ${truncate(info.title, 60)} (${ref}, ${formatDuration(cardDurationMs(info, now))})`;
}

// ---------------------------------------------------------------- agents successifs / relais

/** Réf lisible « agent/modèle · effort » (champs absents omis). */
export function agentRefText(ref: AgentRef): string {
  // Un id OpenCode commence souvent par le nom du fournisseur « opencode/… » : pas de doublon.
  let s = !ref.model ? ref.agent : ref.model.startsWith(`${ref.agent}/`) ? ref.model : `${ref.agent}/${ref.model}`;
  if (ref.effort) s += ` · ${ref.effort}`;
  return s;
}

/** Texte du mode d'une transition d'agent (segment d'historique ou bandeau de relais). */
const AGENT_MODE_TEXT: Record<AgentSegment['mode'], string> = {
  start: 'démarrage',
  resume: 'session reprise',
  handoff: 'passation',
  import: 'session importée',
};

/** Texte neutre du bandeau de relais d'un `agent_switched`. */
export function agentSwitchText(ev: { from: AgentRef; to: AgentRef; mode: 'resume' | 'handoff' }): string {
  return `relais : ${agentRefText(ev.from)} → ${agentRefText(ev.to)} (${AGENT_MODE_TEXT[ev.mode]})`;
}

/** Heure locale HH:MM d'un horodatage. */
function hhmm(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Ligne d'infobulle d'un segment d'historique : `HH:MM · agent/modèle · effort — mode`. */
export function agentSegmentLine(seg: AgentSegment): string {
  return `${hhmm(seg.since)} · ${agentRefText(seg)} — ${AGENT_MODE_TEXT[seg.mode]}`;
}

/** Lignes « agents successifs » pour l'infobulle (null si 0 ou 1 segment). */
export function agentHistoryLines(info: ThreadInfo): string[] | null {
  const hist = info.agentHistory ?? [];
  if (hist.length <= 1) return null;
  return hist.map((seg) => `• ${agentSegmentLine(seg)}`);
}

// ---------------------------------------------------------------- barre d'état commits

export const COMMIT_WORDS = ['off', 'ask', 'on'] as const;
export type CommitWord = (typeof COMMIT_WORDS)[number];

const WORD_OF_PERMISSION: Record<CommitPermission, CommitWord> = { deny: 'off', ask: 'ask', allow: 'on' };
const PERMISSION_OF_WORD: Record<CommitWord, CommitPermission> = { off: 'deny', ask: 'ask', on: 'allow' };

export function commitWord(p: CommitPermission): CommitWord {
  return WORD_OF_PERMISSION[p];
}

export function permissionFromWord(w: CommitWord): CommitPermission {
  return PERMISSION_OF_WORD[w];
}

/** Texte de la barre d'état : `$(git-commit) Commits : off|ask|on` (ou `n/a` hors git). */
export function commitStatusBarText(p: CommitPermission, isGitRepo: boolean): string {
  return isGitRepo ? `$(git-commit) Commits : ${commitWord(p)}` : '$(git-commit) Commits : n/a';
}

const COMMIT_EXPLAIN: Record<CommitPermission, string> = {
  deny: "aucun commit autorisé pour l'agent principal.",
  ask: "l'agent principal demande une confirmation avant chaque commit.",
  allow: "l'agent principal peut commiter sans confirmation.",
};

/** Tooltip (markdown) explicatif de la barre d'état. */
export function commitStatusBarTooltip(p: CommitPermission, isGitRepo: boolean): string {
  if (!isGitRepo) return "Le workspace n'est pas un dépôt git : les commits sont indisponibles.";
  return `**Commits : ${commitWord(p)}** — ${COMMIT_EXPLAIN[p]}\n\nModifier via la commande « Agent Hub: Changer la permission de commit ».`;
}

// ---------------------------------------------------------------- fichiers modifiés

export type FileStatus = 'added' | 'modified' | 'deleted';

/** Codicon par statut de fichier. */
export function fileIconId(status: FileStatus): string {
  return status === 'added' ? 'diff-added' : status === 'modified' ? 'diff-modified' : 'diff-removed';
}

export function fileStatusText(status: FileStatus): string {
  return status === 'added' ? 'ajouté' : status === 'modified' ? 'modifié' : 'supprimé';
}

/** Sépare un chemin relatif (séparateurs / ou \) en dossier + nom de fichier. */
export function fileParts(relPath: string): { dir: string; name: string } {
  const norm = relPath.replace(/\\/g, '/');
  const i = norm.lastIndexOf('/');
  return i < 0 ? { dir: '', name: norm } : { dir: norm.slice(0, i), name: norm.slice(i + 1) };
}

// ---------------------------------------------------------------- assistant de création

/**
 * Défaut de modèle/effort : réglage utilisateur > défaut des capabilities > premier de la liste.
 * `list === 'free-text'` : pas de liste, renvoie le défaut tel quel.
 */
export function resolveDefaultOption(
  list: { id: string }[] | 'free-text',
  capDefault: string | undefined,
  settingDefault: string | undefined,
): string | undefined {
  const d = (settingDefault || capDefault || '') || undefined;
  if (list === 'free-text') return d;
  if (!d) return list[0]?.id;
  return list.some((x) => x.id === d) ? d : list[0]?.id;
}

// ---------------------------------------------------------------- assistants (choix modèle / effort)

export interface ModelDefaultParams {
  caps: AgentCapabilities;
  /** Agent réellement choisi dans le wizard. */
  agentId: AgentId;
  /** Réglage utilisateur agentHub.<agent>.defaultModel. */
  setting?: string;
  /** Réf courante du thread (défaut de modèle si même agent que agentId). */
  current?: AgentRef;
}

/** Défaut de modèle : ref courante (même agent) > réglage utilisateur > défaut des capabilities > premier. */
export function defaultModelChoice(p: ModelDefaultParams): string | undefined {
  const cur = p.current && p.current.agent === p.agentId ? p.current.model : undefined;
  return resolveDefaultOption(p.caps.models, p.caps.defaultModel, cur || p.setting);
}

export interface EffortChoice {
  /** Niveaux applicables au modèle (effortLevelsFor) ; null ou vide = étape sautée. */
  levels: { id: string; label?: string }[] | null;
  /** Défaut (réglage utilisateur > défaut des capabilities > premier de la liste). */
  def: string | undefined;
}

/** Niveaux d'effort pour un modèle donné (effortLevelsFor, priorité aux niveaux propres au modèle). */
export function effortChoice(caps: AgentCapabilities, model: string | undefined, setting?: string): EffortChoice {
  const levels = effortLevelsFor(caps, model);
  if (!levels || levels.length === 0) return { levels: null, def: undefined };
  return { levels, def: resolveDefaultOption(levels, caps.defaultEffort, setting) };
}

// ---------------------------------------------------------------- panneau de chat

/** Valeur `unknown` → chaîne lisible : string tel quel, sinon JSON indenté. */
export function formatValue(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}

/** Regroupe les milliers (séparateur espace insécable fin, rendu identique partout). */
function groupDigits(n: number): string {
  return String(Math.max(0, Math.floor(n))).replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f');
}

export function formatUsage(tokens: number, cost?: number): string {
  const base = `${groupDigits(tokens)} tokens`;
  return cost === undefined ? base : `${base} · ${cost.toFixed(4)} $`;
}

function shortSha(sha: string): string {
  return sha.length > 8 ? sha.slice(0, 8) + '…' : sha;
}

/** Corps d'entrée/sortie d'outil pour un <pre> : échappé, tronqué à 4000 caractères affichés. */
export function formatToolBody(v: unknown): string {
  return truncate(escapeHtml(formatValue(v)), 4000);
}

/** HTML d'un bloc d'événement avec l'id de bloc donné. Tout contenu est échappé. */
export function renderEventHtml(ev: AgentEvent, id: string): string {
  const aid = escapeHtml(id);
  switch (ev.type) {
    case 'user_text': {
      // Un message précédé d'un dossier de passation : le dossier est replié, le message reste visible.
      const end = ev.text.startsWith(HANDOFF_PREFIX) ? ev.text.indexOf(HANDOFF_TAIL) : -1;
      if (end >= 0) {
        const dossier = ev.text.slice(0, end + HANDOFF_TAIL.length);
        const message = ev.text.slice(end + HANDOFF_TAIL.length).trim();
        return `<div id="${aid}" class="row user"><div class="bubble user"><details class="handoff"><summary>Dossier de passation</summary><pre>${escapeHtml(dossier)}</pre></details>${message ? escapeHtml(message) : ''}</div></div>`;
      }
      return `<div id="${aid}" class="row user"><div class="bubble user">${escapeHtml(ev.text)}</div></div>`;
    }
    case 'assistant_text':
      return `<div id="${aid}" class="row"><div class="bubble assistant">${escapeHtml(ev.text)}</div></div>`;
    case 'tool_call':
      return `<details id="${aid}" class="row"><summary>${escapeHtml(ev.name)} — appel</summary><pre>${formatToolBody(ev.input)}</pre></details>`;
    case 'tool_result':
      return `<details id="${aid}" class="row"><summary>${escapeHtml(ev.name)}${ev.isError ? ' — erreur' : ' — résultat'}</summary><pre class="${ev.isError ? 'bad' : ''}">${formatToolBody(ev.output)}</pre></details>`;
    case 'file_changed':
      return `<div id="${aid}" class="fileline">&#9998; <code>${escapeHtml(ev.path)}</code></div>`;
    case 'scope_violation':
      return `<div id="${aid}" class="banner err">&#9888; Sortie du périmètre : <code>${escapeHtml(ev.path)}</code></div>`;
    case 'commit_violation':
      return `<div id="${aid}" class="banner err">&#9888; Commit interdit : <code>${escapeHtml(shortSha(ev.oldHead))}</code> → <code>${escapeHtml(shortSha(ev.newHead))}</code></div>`;
    case 'commit_made':
      return `<div id="${aid}" class="banner ok">&#10003; Commit <code>${escapeHtml(shortSha(ev.sha))}</code>${ev.message ? ` — ${escapeHtml(ev.message)}` : ''}</div>`;
    case 'error':
      return `<div id="${aid}" class="banner err">&#10006; ${escapeHtml(ev.message)}</div>`;
    case 'done':
      // Le résumé reprend le dernier message de l'agent, déjà affiché : simple séparateur de fin de tour.
      return `<div id="${aid}" class="sep"><div class="rule"></div><div class="sum">fin du tour</div></div>`;
    case 'usage':
      return `<div id="${aid}" class="usage">${escapeHtml(formatUsage(ev.tokens, ev.cost))}</div>`;
    case 'session_started':
      return `<div id="${aid}" class="usage">session ${escapeHtml(shortSha(ev.sessionId))}</div>`;
    case 'agent_switched':
      // Bandeau neutre centré, ex. « — relais : claude/opus → opencode/glm-5.3 (passation) — ».
      return `<div id="${aid}" class="banner switch">— ${escapeHtml(agentSwitchText(ev))} —</div>`;
    case 'subagent_started':
      // Rendu spécial : la vue (ChatView) construit la carte vivante à partir de l'état du thread enfant.
      return '';
    default:
      return '';
  }
}

/**
 * Pli des textes partiels : un `assistant_text` partiel remplace le dernier bloc partiel ;
 * le texte final le remplace aussi ; tout autre événement ferme le bloc partiel en cours.
 * `target` = id du bloc à remplacer (null = ajouter à la fin).
 */
export function renderEventPatch(
  openPartialId: string | null,
  ev: AgentEvent,
  nextId: string,
): { target: string | null; html: string; openPartialId: string | null } {
  const html = renderEventHtml(ev, nextId);
  if (!html) return { target: null, html: '', openPartialId: null };
  if (ev.type === 'assistant_text') {
    return {
      target: openPartialId,
      html,
      openPartialId: ev.partial ? nextId : null,
    };
  }
  return { target: null, html, openPartialId: null };
}

// ---------------------------------------------------------------- aperçu de commit

export const COMMIT_DIFF_MAX = 3000;

/** Détail de la boîte de confirmation : message proposé + fichiers + résumé tronqué. */
export function commitPreviewDetail(preview: CommitPreview, diffMax = COMMIT_DIFF_MAX): string {
  const files = preview.paths.length
    ? preview.paths.map((p) => `• ${p}`).join('\n')
    : '(aucun fichier listé)';
  return [preview.message.trim() || '(message vide)', 'Fichiers :', files, preview.diffSummary ? truncate(preview.diffSummary, diffMax) : ''].join('\n');
}


// ---------------------------------------------------------------- shell du webview (commun)

/** CSP stricte + helpers communs : scroll épinglé, application des correctifs, bandeau d'erreur. */
const CHAT_JS_CORE = `
'use strict';
const vs = acquireVsCodeApi();
const out = document.getElementById('out');
const errbar = document.getElementById('errbar');
let pinned = true;
out.addEventListener('scroll', () => { pinned = out.scrollTop + out.clientHeight >= out.scrollHeight - 24; });
function stick() { if (pinned) out.scrollTop = out.scrollHeight; }
function apply(patch) {
  if (!patch.html) return;
  const el = patch.target ? document.getElementById(patch.target) : null;
  if (el) {
    // Conserver l'état plié d'un groupe de sous-agents reconstruit.
    if (el.classList.contains('sagroup') && !el.open) patch.html = patch.html.replace(/^(<details[^>]*)\sopen/, '$1');
    el.outerHTML = patch.html;
  } else { out.insertAdjacentHTML('beforeend', patch.html); }
  stick();
}
function showErr(html) { errbar.innerHTML = html; stick(); }
`;

/** CSS commun : bulles, outils repliables, bandeaux, usage, classes de statut. */
const CHAT_CSS_CORE = `
.handoff { margin-bottom: 4px; } .handoff summary { cursor: pointer; opacity: .85; font-size: 12px; } .handoff pre { white-space: pre-wrap; font-size: 11px; max-height: 240px; overflow: auto; margin: 4px 0 0; }
html, body { height: 100%; margin: 0; }
body { display: flex; flex-direction: column; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family, sans-serif); font-size: var(--vscode-font-size, 13px); }
[hidden] { display: none !important; }
#out { flex: 1 1 auto; overflow-y: auto; overflow-x: hidden; }
#errbar:empty { display: none; }
#errbar { margin: 6px 10px 0; }
.row { margin: 8px 0; display: flex; }
.row.user { justify-content: flex-end; }
.bubble { max-width: 85%; padding: 7px 11px; border-radius: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
.bubble.user { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.bubble.assistant { background: transparent; padding-left: 0; max-width: 95%; }
details.row { flex-direction: column; border: 1px solid var(--vscode-editorWidget-border, var(--vscode-editor-foreground)) ; border-radius: 6px; padding: 4px 8px; background: var(--vscode-notifications-background, transparent); }
details.row[open] { padding-bottom: 8px; }
summary { cursor: pointer; color: var(--vscode-descriptionForeground); user-select: none; }
pre { margin: 6px 0 0; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
pre.bad { color: var(--vscode-errorForeground); }
.fileline { margin: 4px 0; font-size: 12px; color: var(--vscode-descriptionForeground); }
.fileline code { color: var(--vscode-textLink-foreground); overflow-wrap: anywhere; }
.banner { margin: 8px 0; padding: 6px 10px; border-radius: 4px; font-size: 12px; }
.banner.err { color: var(--vscode-errorForeground); border-left: 2px solid var(--vscode-errorForeground); background: var(--vscode-inputValidation-errorBackground, transparent); }
.banner.ok { color: var(--vscode-testingIconPassed, var(--vscode-charts-green, inherit)); border-left: 2px solid var(--vscode-testingIconPassed, var(--vscode-charts-green, currentColor)); background: var(--vscode-inputValidation-infoBackground, transparent); }
.banner.switch { text-align: center; padding: 2px 0; color: var(--vscode-descriptionForeground); background: transparent; }
.sep { margin: 14px 0 6px; }
.sep .rule { border-top: 1px dashed var(--vscode-editor-foreground); opacity: .3; }
.sep .sum { margin-top: 4px; font-size: 12px; color: var(--vscode-descriptionForeground); }
.usage { margin: 2px 0; font-size: 11px; color: var(--vscode-descriptionForeground); }
.bad { color: var(--vscode-errorForeground); }
.st-starting, .st-running { color: var(--vscode-charts-yellow, inherit); }
.st-done, .st-applied { color: var(--vscode-testingIconPassed, var(--vscode-charts-green, inherit)); }
.st-error { color: var(--vscode-errorForeground); }
.st-conflict { color: var(--vscode-listWarningForeground, var(--vscode-charts-orange, inherit)); }
.st-interrupted { color: var(--vscode-charts-purple, inherit); }
.st-idle { color: var(--vscode-descriptionForeground); }
button { cursor: pointer; border: none; border-radius: 2px; padding: 5px 12px; font-family: inherit; font-size: var(--vscode-font-size, 13px); }
`;

/** JS spécifique au panneau (onglet d'éditeur). */
const CHAT_JS_VIEW = `
const sel = document.getElementById('tsel');
const sub = document.getElementById('subline');
const stchip = document.getElementById('tstatus');
const filesblk = document.getElementById('filesblk');
const lignee = document.getElementById('lignee');
const robar = document.getElementById('robar');
const btnGoMain = document.getElementById('btnGoMain');
const ta = document.getElementById('vta');
const sendB = document.getElementById('vsend');
const btnNew = document.getElementById('btnNew');
const btnDel = document.getElementById('btnDelegate');
const btnAg = document.getElementById('btnAgent');
const btnStop = document.getElementById('btnStop');
const btnImport = document.getElementById('btnImport');
const btnDelThread = document.getElementById('btnDelThread');
let running = false, hasThread = false, isMain = false, ro = false, mainId = '';
function sync() {
  document.body.classList.toggle('empty', !hasThread);
  sendB.textContent = running ? '⏹ Arrêter' : 'Envoyer';
  sendB.className = running ? 'stop' : '';
  sendB.title = running ? "Interrompre l'exécution en cours" : 'Envoyer (Entrée)';
  btnStop.style.display = running ? '' : 'none';
  btnDel.style.display = hasThread && isMain ? '' : 'none';
  btnDel.disabled = running;
  // Changer d'agent : threads principaux seulement ; lecture seule des enfants : bandeau à la place de la saisie.
  btnAg.style.display = hasThread && isMain ? '' : 'none';
  btnAg.disabled = !hasThread || running;
  const roChild = hasThread && !isMain && ro;
  robar.hidden = !roChild;
  document.getElementById('vinput').style.display = roChild ? 'none' : '';
  // Suppression : toujours disponible tant qu'un thread est affiché (la confirmation prévient).
  btnDelThread.style.display = hasThread ? '' : 'none';
}
// Durée mm:ss d'une carte en cours (minuteur local, chaque seconde, à partir de data-start).
function mmss(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}
setInterval(function () {
  for (const c of out.querySelectorAll('.sacard[data-running]')) {
    const dur = c.querySelector('.sa-dur');
    if (dur) dur.textContent = mmss(Date.now() - Number(c.dataset.start || 0));
  }
}, 1000);
function fit() {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
}
window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'init') { out.innerHTML = m.html; errbar.textContent = ''; stick(); }
  else if (m.type === 'events') { for (const p of m.patches) apply(p); }
  else if (m.type === 'header') {
    hasThread = !!m.hasThread; running = !!m.running; isMain = !!m.isMain;
    ro = !!m.readOnly; mainId = m.parentId || '';
    lignee.innerHTML = m.lineage || '';
    lignee.hidden = !m.lineage;
    sel.textContent = '';
    if (!hasThread) {
      const ph = document.createElement('option');
      ph.value = ''; ph.textContent = 'Aucun thread'; ph.selected = true;
      sel.append(ph);
    } else if (m.options) {
      for (const o of m.options) {
        const el = document.createElement('option');
        el.value = o.id; el.textContent = o.label;
        if (o.id === m.selected) el.selected = true;
        sel.append(el);
      }
    }
    sub.textContent = m.subtitle || '';
    stchip.textContent = m.statusText || '';
    stchip.className = m.statusClass || '';
    if (m.agentName) {
      ta.placeholder = 'Message à ' + m.agentName + '… (Entrée pour envoyer, Maj+Entrée pour une nouvelle ligne)';
    }
    sync();
  }
  else if (m.type === 'files') { filesblk.innerHTML = m.html || ''; }
  else if (m.type === 'card') {
    // Carte de sous-agent : remplacement de l'element [data-thread=...] + en-tête de groupe en direct.
    let el = null;
    for (const c of out.querySelectorAll('.sacard')) { if (c.dataset.thread === m.threadId) { el = c; break; } }
    if (el) el.outerHTML = m.html;
    if (m.groupId && m.header) {
      const gd = document.getElementById(m.groupId);
      const txt = gd ? gd.querySelector('.sgtext') : null;
      if (txt) txt.innerHTML = m.header;
    }
    stick();
  }
  else if (m.type === 'error') { showErr(m.html); }
  else if (m.type === 'clear-error') { errbar.textContent = ''; }
});
ta.addEventListener('input', fit);
ta.addEventListener('keydown', function (e) {
  if (e.key !== 'Enter' || e.shiftKey) return;
  e.preventDefault();
  if (running) return;
  const text = ta.value;
  if (!text.trim()) return;
  ta.value = ''; fit(); errbar.textContent = '';
  vs.postMessage({ t: 'send', text: text });
});
sendB.addEventListener('click', () => { if (running) vs.postMessage({ t: 'stop' }); });
sel.addEventListener('change', () => { if (sel.value) vs.postMessage({ t: 'selectThread', id: sel.value }); });
btnNew.addEventListener('click', () => vs.postMessage({ t: 'newThread' }));
btnImport.addEventListener('click', () => vs.postMessage({ t: 'importSession' }));
btnDelThread.addEventListener('click', () => vs.postMessage({ t: 'deleteThread' }));
btnDel.addEventListener('click', () => vs.postMessage({ t: 'delegate' }));
btnAg.addEventListener('click', () => vs.postMessage({ t: 'changeAgent' }));
btnStop.addEventListener('click', () => vs.postMessage({ t: 'stop' }));
document.getElementById('wbtn').addEventListener('click', () => vs.postMessage({ t: 'newThread' }));
document.getElementById('wimport').addEventListener('click', () => vs.postMessage({ t: 'importSession' }));
// Fil d'Ariane : clic sur « ← parent » pour revenir au thread principal.
lignee.addEventListener('click', function (e) {
  const b = e.target.closest('[data-id]');
  if (b) { e.preventDefault(); vs.postMessage({ t: 'selectThread', id: b.dataset.id }); }
});
btnGoMain.addEventListener('click', function () { if (mainId) vs.postMessage({ t: 'selectThread', id: mainId }); });
// Boutons du pied des cartes de sous-agents (Ouvrir / Stop / Appliquer).
out.addEventListener('click', function (e) {
  const b = e.target.closest('[data-cact]');
  if (b) { e.preventDefault(); vs.postMessage({ t: b.dataset.cact, id: b.dataset.id }); }
});
filesblk.addEventListener('click', function (e) {
  const btn = e.target.closest('[data-act]');
  if (btn) {
    e.preventDefault();
    e.stopPropagation();
    const row = e.target.closest('[data-path]');
    vs.postMessage({ t: btn.dataset.act, path: row ? row.dataset.path : undefined });
    return;
  }
  const row = e.target.closest('.frow');
  if (row) vs.postMessage({ t: 'openDiff', path: row.dataset.path });
});
fit();
vs.postMessage({ t: 'ready' });
`;

/** CSS spécifique à la vue latérale (barre étroite, ≥ 280 px). */
const CHAT_CSS_VIEW = `
.view .bubble { max-width: 96%; }
.view .bubble.user { background: var(--vscode-chat-requestBackground, var(--vscode-input-background)); color: var(--vscode-editor-foreground, inherit); }
#thead { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; padding: 6px 8px; border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-editorWidget-border, transparent)); }
#tsel { flex: 1 1 120px; min-width: 0; box-sizing: border-box; padding: 3px 4px; border-radius: 2px; background: var(--vscode-dropdown-background, var(--vscode-input-background)); color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground)); border: 1px solid var(--vscode-dropdown-border, transparent); font-family: inherit; font-size: var(--vscode-font-size, 13px); text-overflow: ellipsis; }
#tstatus { font-size: 11px; font-weight: 600; white-space: nowrap; }
#tacts { display: flex; gap: 3px; margin-left: auto; }
#tacts button, .fbtn { background: transparent; color: var(--vscode-foreground, inherit); }
#tacts button { font-size: 13px; line-height: 1; padding: 3px 6px; border-radius: 3px; }
#tacts button:hover:not(:disabled), .fbtn:not(.apply):hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.18)); }
#tacts button:disabled, .fbtn:disabled { opacity: .4; cursor: default; }
#thead button:focus-visible, #wbtn:focus-visible, #vsend:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
#subline { padding: 2px 10px 4px; font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#out { padding: 4px 8px 10px; }
#filesblk { margin: 6px 8px 0; border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,.25)); border-radius: 4px; font-size: 12px; background: var(--vscode-sideBar-background, transparent); }
#filesblk:empty { display: none; }
#filesblk summary { display: flex; flex-wrap: wrap; gap: 4px 6px; align-items: center; padding: 4px 8px; list-style: none; }
#filesblk summary::-webkit-details-marker { display: none; }
.farrow { display: inline-block; transition: transform .1s; }
#fileshdr[open] .farrow { transform: rotate(90deg); }
.ftitle { font-weight: 600; white-space: nowrap; }
.fspacer { flex: 1 1 auto; }
.fnum { font-variant-numeric: tabular-nums; font-size: 11px; }
.fnum.add { color: var(--vscode-charts-green, green); }
.fnum.del { color: var(--vscode-errorForeground, red); }
.fbtn { font-size: 11px; padding: 2px 7px; border-radius: 3px; white-space: nowrap; }
.fbtn.apply { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.fbtn.apply:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
.fbadge { background: var(--vscode-badge-background, rgba(128,128,128,.35)); color: var(--vscode-badge-foreground, inherit); border-radius: 3px; padding: 1px 6px; font-size: 11px; }
.frow { display: flex; align-items: center; gap: 8px; padding: 3px 8px; border-top: 1px solid rgba(128,128,128,.15); cursor: pointer; }
.frow:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.15)); }
.fstat { width: 14px; text-align: center; font-weight: 700; }
.fstat.added { color: var(--vscode-charts-green, green); }
.fstat.modified { color: var(--vscode-charts-blue, blue); }
.fstat.deleted { color: var(--vscode-errorForeground, red); }
.fpath { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.fdir { color: var(--vscode-descriptionForeground); }
.fname { font-weight: 600; }
.fact { display: flex; gap: 2px; opacity: 0; transition: opacity .1s; }
.frow:hover .fact { opacity: 1; }
.fact button { font-size: 11px; padding: 1px 4px; }
/* Zone de saisie façon Chat : boîte encadrée, texte sur toute la largeur, bouton en bas à droite. */
#vinput { display: flex; flex-direction: column; gap: 4px; margin: 6px 8px 8px; padding: 6px; border: 1px solid var(--vscode-input-border, var(--vscode-editorWidget-border, rgba(128,128,128,.35))); border-radius: 6px; background: var(--vscode-input-background); }
#vinput:focus-within { border-color: var(--vscode-focusBorder); }
#vta { width: 100%; box-sizing: border-box; resize: none; min-height: calc(2.8em + 4px); max-height: 200px; padding: 2px 2px; border: none; background: transparent; color: var(--vscode-input-foreground); font-family: inherit; font-size: var(--vscode-font-size, 13px); }
#vta:focus { outline: none; }
#vsend { align-self: flex-end; background: var(--vscode-button-background); color: var(--vscode-button-foreground); padding: 3px 10px; }
#vsend.stop { background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground)); }
#vsend:hover { background: var(--vscode-button-hoverBackground); }
#welcome { display: none; flex: 1 1 auto; flex-direction: column; justify-content: center; align-items: center; gap: 10px; padding: 24px; text-align: center; color: var(--vscode-descriptionForeground); }
body.empty #thead, body.empty #subline, body.empty #out, body.empty #filesblk, body.empty #vinput { display: none; }
body.empty #welcome { display: flex; }
#welcome h2 { margin: 0; font-size: 14px; color: inherit; font-weight: 600; }
#welcome p { margin: 0; max-width: 34em; }
#wbtn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); padding: 5px 14px; }
#wbtn:hover { background: var(--vscode-button-hoverBackground); }
#wimport { background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground, inherit)); padding: 5px 14px; }
/* Fil d'Ariane des threads délégués : ← parent › enfant. */
#lignee { display: flex; align-items: center; gap: 4px; padding: 3px 10px 0; font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; }
#lignee .lcrumb { background: transparent; color: var(--vscode-textLink-foreground); font-size: 11px; padding: 0 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 55%; }
#lignee .lcrumb:hover { text-decoration: underline; }
#lignee .lgsep { flex: none; }
#lignee .lgcur { overflow: hidden; text-overflow: ellipsis; }
/* Bandeau de lecture seule des threads délégués (à la place de la zone de saisie). */
#robar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; margin: 6px 8px 8px; padding: 8px 10px; border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,.35)); border-radius: 6px; font-size: 12px; color: var(--vscode-descriptionForeground); background: var(--vscode-input-background); }
#robar span { flex: 1 1 180px; min-width: 0; }
#robar button { flex: none; background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground, inherit)); padding: 3px 10px; white-space: nowrap; }
#robar button:hover { background: var(--vscode-button-hoverBackground); }
/* Cartes de sous-agents dans la conversation du parent. */
.sacard { margin: 4px 0; padding: 6px 9px; border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,.3)); border-radius: 6px; background: var(--vscode-notifications-background, transparent); }
.sacard .sa-l1 { display: flex; align-items: center; gap: 6px; min-width: 0; }
.sacard .sdot { width: 9px; height: 9px; border-radius: 50%; background: var(--vscode-descriptionForeground); flex: none; }
.sacard.sa-run .sdot { background: var(--vscode-charts-yellow, #db0); animation: sacard-pulse 1.2s ease-in-out infinite; }
.sacard.sa-done .sdot { background: var(--vscode-testingIconPassed, var(--vscode-charts-green, green)); }
.sacard.sa-fail .sdot { background: var(--vscode-errorForeground, red); }
@keyframes sacard-pulse { 50% { opacity: .3; } }
.sacard .sa-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sacard .sa-l2 { font-size: 11px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sacard .sa-l3 { font-size: 12px; margin-top: 2px; white-space: pre-wrap; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.sacard .sa-l3.act { color: var(--vscode-descriptionForeground); font-style: italic; white-space: nowrap; display: block; }
.sacard .sa-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 4px; font-size: 11px; color: var(--vscode-descriptionForeground); }
.sacard .sa-dur, .sacard .sa-files { font-variant-numeric: tabular-nums; }
.sabadge { color: var(--vscode-listWarningForeground, var(--vscode-charts-orange, orange)); }
.sacard .sa-acts { margin-left: auto; display: flex; gap: 3px; }
.sacard .sa-acts button { font-size: 11px; padding: 1px 7px; border-radius: 3px; background: transparent; color: var(--vscode-foreground, inherit); }
.sacard .sa-acts button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.18)); }
.sacard .sa-acts button.apply { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.sacard .sa-acts button.apply:hover { background: var(--vscode-button-hoverBackground); }
/* Carte grisée d'un sous-agent supprimé. */
.sacard.sa-gone { opacity: .55; }
/* Groupe de cartes : en-tête repliable « N sous-agents · … ». */
.sagroup { margin: 8px 0; border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,.3)); border-radius: 6px; }
.sagroup > summary { display: flex; align-items: center; gap: 5px; padding: 4px 8px; font-size: 11px; color: var(--vscode-descriptionForeground); list-style: none; }
.sagroup > summary::-webkit-details-marker { display: none; }
.sagroup .sarrow { display: inline-block; transition: transform .1s; }
.sagroup[open] .sarrow { transform: rotate(90deg); }
.sagroup .sacards { display: flex; flex-direction: column; }
.sagroup .sacard { margin: 0; border-left: none; border-right: none; border-bottom: none; border-radius: 0; }
`;

const CHAT_HTML_VIEW = `
<div id="welcome">
<h2>Nouvelle conversation</h2>
<p>Sélectionnez un thread dans la liste ci-dessus, ou démarrez un nouveau thread principal pour discuter avec un agent de code (Claude, Codex, OpenCode, Agy) depuis la barre latérale secondaire.</p>
<button id="wbtn" type="button">＋ Nouveau thread</button>
<button id="wimport" type="button" title="Importer une session native d'un CLI comme thread">Importer une session…</button>
</div>
<div id="thead">
<select id="tsel" aria-label="Thread affiché" title="Thread affiché"></select>
<span id="tstatus" class="st-idle"></span>
<div id="tacts">
<button id="btnNew" type="button" title="Nouveau thread (agent principal)">＋</button>
<button id="btnImport" type="button" title="Importer une session native">⤓</button>
<button id="btnDelegate" type="button" title="Déléguer à un sous-agent" style="display:none">⑂</button>
<button id="btnAgent" type="button" title="Changer d'agent, de modèle ou d'effort" disabled>⇄</button>
<button id="btnStop" type="button" title="Interrompre l'exécution en cours" style="display:none">⏹</button>
<button id="btnDelThread" type="button" title="Supprimer ce thread" style="display:none">🗑</button>
</div>
</div>
<div id="subline"></div>
<div id="lignee" hidden></div>
<div id="errbar"></div>
<div id="out"></div>
<div id="filesblk"></div>
<div id="robar" hidden>
<span>Thread délégué en lecture seule — écrivez au thread principal, qui pilote ses sous-agents.</span>
<button id="btnGoMain" type="button" title="Afficher le thread principal">Aller au thread principal</button>
</div>
<div id="vinput">
<textarea id="vta" rows="1" aria-label="Message à l'agent" placeholder="Message à l'agent… (Entrée pour envoyer, Maj+Entrée pour une nouvelle ligne)"></textarea>
<button id="vsend" type="button" title="Envoyer (Entrée)">Envoyer</button>
</div>
`;

/** Nonce aléatoire pour la CSP. */
export function getNonce(): string {
  let nonce = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  return nonce;
}

/** Page de la vue de chat latérale : CSP stricte avec nonce, tout inline. */
export function buildChatHtml(nonce: string): string {
  const n = escapeHtml(nonce);
  const css = CHAT_CSS_CORE + CHAT_CSS_VIEW;
  const js = CHAT_JS_CORE + CHAT_JS_VIEW;
  const body = CHAT_HTML_VIEW;
  const bodyCls = ' class="view empty"';
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${n}'; style-src 'nonce-${n}'; img-src data:;">
<style nonce="${n}">${css}</style>
</head>
<body${bodyCls}>
${body}
<script nonce="${n}">${js}</script>
</body>
</html>`;
}
