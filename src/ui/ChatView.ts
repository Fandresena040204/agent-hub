// Vue « Chat » de la barre latérale secondaire : même rendu que le Chat de VS Code,
// avec un bloc « N fichiers modifiés » (Conserver / Annuler) au-dessus de la zone de saisie.
import * as vscode from 'vscode';
import type { ChangedFile, OrchestratorApi, Unsubscribe } from '../core/orchestratorApi';
import type { StoredEvent } from '../core/events';
import type { ThreadInfo } from '../core/types';
import { createLogger } from '../core/log';
import { baseContentUri } from './ChangesView';
import {
  breaksSubagentGroup, buildChatHtml, getNonce, isThreadRunning, lineageHtml, renderEventHtml,
  renderEventPatch, threadStatusText,
} from './presentation';
import {
  cardsBlockHtml, chatThreadOptions, fileSignature, filesTotals, pendingFiles, readOnlyForThread,
  renderFilesBlockHtml, subagentGroupHeaderText, threadSubtitle,
} from './chatViewModel';
import type { FilesTotals, SubagentCardMember } from './chatViewModel';
import { fallbackThreadAfterRemoval } from './threadLifecycle';

const log = createLogger('ui.chatview');

/** Clé workspaceState du thread affiché. */
const CURRENT_KEY = 'agentHub.chat.currentThread';
/** Déclencheurs entraînant un rafraîchissement debounced du bloc fichiers. */
const FILE_DEBOUNCE_MS = 500;
const FLUSH_MS = 50;
/** Debounce du rafraîchissement d'une carte de sous-agent (statut, activité, totaux). */
const CARD_DEBOUNCE_MS = 250;

type DisposableOrUnsub = vscode.Disposable | Unsubscribe;

function asDisposable(d: DisposableOrUnsub): vscode.Disposable {
  return d instanceof vscode.Disposable ? d : new vscode.Disposable(d);
}

/** Mise à jour de carte en attente d'envoi (webview remplace `[data-thread=…]`). */
interface CardMsg { threadId: string; html: string; groupId?: string; header?: string }

/** Groupe de délégations consécutives en cours de remplissage. */
interface OpenGroup {
  groupId: string;
  /** Bloc de la première carte : cible du correctif qui transforme la carte seule en groupe. */
  block0: string;
  members: { id: string; blockId: string }[];
  /** Index du bloc dans la reconstruction en cours (mis à jour en place) ; -1 en mode incrémental. */
  anchorIndex: number;
}

/** Clé workspaceState des signatures « conservées » d'un thread. */
function keptKey(threadId: string): string {
  return `agentHub.kept.${threadId}`;
}

/** Message webview → extension (contenu typé : t obligatoire, texte/id/chemin chaînes). */
interface ViewMessage { t: string; text?: string; id?: string; path?: string; }

function asMessage(raw: unknown): ViewMessage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const m = raw as { t?: unknown; text?: unknown; id?: unknown; path?: unknown };
  if (typeof m.t !== 'string') return undefined;
  const out: ViewMessage = { t: m.t };
  if (m.text !== undefined) { if (typeof m.text !== 'string') return undefined; out.text = m.text; }
  if (m.id !== undefined) { if (typeof m.id !== 'string') return undefined; out.id = m.id; }
  if (m.path !== undefined) { if (typeof m.path !== 'string') return undefined; out.path = m.path; }
  return out;
}

export class ChatView implements vscode.WebviewViewProvider {
  static readonly viewId = 'agentHub.chat';

  private view: vscode.WebviewView | undefined;
  private ready = false;
  private subs: vscode.Disposable[] = [];
  private currentId: string | undefined;
  /** Pli des blocs partiels : id du dernier bloc partiel affiché (null = aucun). */
  private openPartial: string | null = null;
  private pending: { target: string | null; html: string }[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private fileTimer: ReturnType<typeof setTimeout> | undefined;
  private seq = 0;
  /** Fichiers du dernier changedFiles() du thread courant (source des signatures et diffs). */
  private lastFiles: ChangedFile[] = [];
  /** Blocs de la reconstruction en cours (le bloc de groupe est mis à jour en place). */
  private blocks: { html: string }[] = [];
  /** Groupe de sous-agents en cours de remplissage (délégations consécutives). */
  private openGroup: OpenGroup | undefined;
  /** Groupes affichés dans la vue courante : id de groupe -> membres. */
  private groupMembers = new Map<string, { id: string; blockId: string }[]>();
  /** Sous-agents affichés en carte : threadId -> id de groupe (mise à jour en direct). */
  private cardGroups = new Map<string, string>();
  /** Sous-agents dont le thread a été supprimé (cartes grisées) pour le thread affiché. */
  private removedCards = new Set<string>();
  /** Parent du thread affiché (repli après suppression). */
  private currentParent: string | undefined;
  /** Totaux de fichiers connus par sous-agent (cache des reconstructions). */
  private cardTotals = new Map<string, FilesTotals>();
  /** Dernière carte envoyée par sous-agent : déduplication (html + en-tête de groupe). */
  private lastCardPost = new Map<string, string>();
  /** Mises à jour de cartes en attente d'envoi (après les correctifs d'événements). */
  private pendingCards = new Map<string, CardMsg>();
  /** Minutiers de debounce par sous-agent. */
  private cardTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly orch: OrchestratorApi,
  ) {
    // Restauration du thread affiché entre les sessions.
    this.currentId = ctx.workspaceState.get<string>(CURRENT_KEY);
  }

  // ---------------------------------------------------------------- cycle de vie

  resolveWebviewView(view: vscode.WebviewView): void {
    if (this.view) this.detach();
    this.view = view;
    this.ready = false;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    this.subs.push(
      asDisposable(view.webview.onDidReceiveMessage((m) => this.onMessage(m))),
      view.onDidDispose(() => this.detach()),
      asDisposable(this.orch.onDidAppendEvent((tid, stored) => this.onEvent(tid, stored))),
      asDisposable(this.orch.onDidChangeThread((t) => this.onThreadChanged(t))),
      // Thread supprimé : repli de la vue, purge du bloc fichiers et cartes grisées.
      asDisposable(this.orch.onDidRemoveThread((tid) => this.onThreadRemoved(tid))),
      // Réglage de lecture seule des enfants : l'en-tête pilote bandeau et zone de saisie.
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('agentHub.delegation.readOnlyChildren')) this.postHeader();
      }),
    );
    view.webview.html = buildChatHtml(getNonce());
  }

  /** Sélectionne le thread affiché et révèle la vue (câblage depuis l'arborescence). */
  showThread(threadId: string): void {
    if (!this.orch.getThread(threadId)) {
      void vscode.window.showErrorMessage(`Thread introuvable : ${threadId}`);
      return;
    }
    this.selectThread(threadId, true);
  }

  /** Id du thread affiché (notifications de sous-agents). */
  currentThreadId(): string | undefined {
    return this.currentId;
  }

  /** Nettoyage (context.subscriptions). */
  dispose(): void {
    this.detach();
  }

  private detach(): void {
    for (const d of this.subs.splice(0)) d.dispose();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.fileTimer) clearTimeout(this.fileTimer);
    this.flushTimer = undefined;
    this.fileTimer = undefined;
    this.view = undefined;
    this.ready = false;
    this.pending = [];
    this.openPartial = null;
    this.resetCards();
  }

  // ---------------------------------------------------------------- thread courant

  private selectThread(threadId: string, focus: boolean): void {
    if (!threadId) return;
    this.currentId = threadId;
    this.currentParent = this.orch.getThread(threadId)?.parentId;
    void this.ctx.workspaceState.update(CURRENT_KEY, threadId);
    this.pending = [];
    this.openPartial = null;
    this.seq = this.orch.getEvents(threadId).length;
    this.lastFiles = [];
    this.resetCards();
    if (focus) void vscode.commands.executeCommand('agentHub.chat.focus');
    if (this.ready) this.onReady();
  }

  /** Retour à l'écran d'accueil (thread courant supprimé et aucun thread restant). */
  private clearThread(): void {
    this.currentId = undefined;
    this.currentParent = undefined;
    void this.ctx.workspaceState.update(CURRENT_KEY, undefined);
    this.pending = [];
    this.openPartial = null;
    this.lastFiles = [];
    if (this.ready) this.onReady();
  }

  /** Thread supprimé : la vue bascule (parent > principal le plus récent > accueil) ou grise ses cartes. */
  private onThreadRemoved(threadId: string): void {
    if (threadId === this.currentId) {
      const fallback = fallbackThreadAfterRemoval(this.orch.listThreads(), this.currentParent, threadId);
      if (fallback) this.selectThread(fallback, false);
      else this.clearThread();
      return;
    }
    // Sous-agent affiché en carte dans le thread courant : version grisée « Sous-agent supprimé ».
    if (!this.cardGroups.has(threadId)) return;
    this.removedCards.add(threadId);
    void this.sendCard(threadId);
  }

  // ---------------------------------------------------------------- cartes de sous-agents

  /** Vidage complet des structures de cartes (changement de thread ou fermeture). */
  private resetCards(): void {
    this.resetCardRender();
    this.cardTotals.clear();
    this.lastCardPost.clear();
    this.removedCards.clear();
  }

  /** Début d'une reconstruction : rendu repart de zéro, les caches (totaux) restent. */
  private resetCardRender(): void {
    this.blocks = [];
    this.openGroup = undefined;
    this.groupMembers.clear();
    this.cardGroups.clear();
    this.pendingCards.clear();
    for (const t of this.cardTimers.values()) clearTimeout(t);
    this.cardTimers.clear();
  }

  /** Enregistre la carte d'un sous-agent dans le groupe ouvert et pousse son rendu. */
  private appendSubagent(threadId: string, blockId: string, live: boolean): void {
    const removed = this.removedCards.has(threadId);
    const child = this.orch.getThread(threadId);
    if (!child && !removed) return; // thread inconnu : aucune carte visible
    if (!this.openGroup) {
      const anchorIndex = live ? -1 : this.blocks.length;
      this.openGroup = { groupId: `sg-${blockId}`, block0: blockId, members: [], anchorIndex };
      if (!live) this.blocks.push({ html: '' }); // bloc ancré à la place de la première carte
    }
    const g = this.openGroup;
    g.members.push({ id: threadId, blockId });
    this.groupMembers.set(g.groupId, g.members.map((m) => ({ id: m.id, blockId: m.blockId })));
    this.cardGroups.set(threadId, g.groupId);
    const block = cardsBlockHtml(this.cardData(g.members), g.groupId);
    if (!live) {
      this.blocks[g.anchorIndex].html = block.html;
    } else if (block.single) {
      this.queuePatch(null, block.html); // première carte seule, ajoutée à la fin
    } else if (g.members.length === 2) {
      this.queuePatch(g.block0, block.html); // la carte seule précédente devient un groupe repliable
    } else {
      this.queuePatch(g.groupId, block.html); // le groupe existant est reconstruit avec sa carte
    }
    this.scheduleCard(threadId); // totaux de fichiers (asynchrone)
  }

  /** Données de cartes des membres (threads vivants, plus ceux supprimés → carte grisée). */
  private cardData(members: { id: string; blockId: string }[]): SubagentCardMember[] {
    const out: SubagentCardMember[] = [];
    for (const m of members) {
      if (this.removedCards.has(m.id)) {
        out.push({ blockId: m.blockId, removedId: m.id });
        continue;
      }
      const t = this.orch.getThread(m.id);
      if (t) out.push({ thread: t, blockId: m.blockId, totals: this.cardTotals.get(m.id) });
    }
    return out;
  }

  /** Programmé le rafraîchissement d'une carte (statut, activité, totaux). */
  private scheduleCard(threadId: string): void {
    if (!this.cardGroups.has(threadId) || this.cardTimers.has(threadId)) return;
    this.cardTimers.set(threadId, setTimeout(() => {
      this.cardTimers.delete(threadId);
      void this.sendCard(threadId);
    }, CARD_DEBOUNCE_MS));
  }

  /** Rafraîchit la carte d'un sous-agent affiché (HTML + en-tête de groupe) après ses changements. */
  private async sendCard(threadId: string): Promise<void> {
    const viewed = this.currentId;
    const groupId = this.cardGroups.get(threadId);
    if (!this.ready || !groupId) return;
    const members = this.groupMembers.get(groupId) ?? [];
    const me = members.find((m) => m.id === threadId);
    if (!me) return;
    const removed = this.removedCards.has(threadId);
    try {
      const files = await this.orch.changedFiles(threadId);
      this.cardTotals.set(threadId, filesTotals(files));
    } catch {
      // thread momentanément indisponible : garde les totaux précédents
    }
    if (!this.ready || this.currentId !== viewed || this.cardGroups.get(threadId) !== groupId) return;
    const thread = this.orch.getThread(threadId);
    if (!thread && !removed) return;
    // Carte vivante, ou grisée si le thread a été supprimé entre-temps.
    const member: SubagentCardMember = thread
      ? { thread, blockId: me.blockId, totals: this.cardTotals.get(threadId) }
      : { blockId: me.blockId, removedId: threadId };
    const html = cardsBlockHtml([member], groupId).html;
    let header: string | undefined;
    let gid: string | undefined;
    if (members.length >= 2) {
      const live: ThreadInfo[] = [];
      let removedCount = 0;
      for (const m of members) {
        if (this.removedCards.has(m.id)) { removedCount++; continue; }
        const t = this.orch.getThread(m.id);
        if (t) live.push(t);
      }
      header = subagentGroupHeaderText(live, removedCount);
      gid = groupId;
    }
    const key = `${header ?? ''}\u0000${html}`;
    if (this.lastCardPost.get(threadId) === key) return;
    this.lastCardPost.set(threadId, key);
    this.queueCard({ threadId, html, groupId: gid, header });
  }

  /** File une mise à jour de carte ; envoyée après les correctifs d'événements au flush. */
  private queueCard(msg: CardMsg): void {
    if (!this.ready) return; // reconstruction en cours : les cartes seront rendues à jour
    this.pendingCards.set(msg.threadId, msg);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  /** Réglage : threads délégués en lecture seule (vrai par défaut). */
  private readOnlyChildren(): boolean {
    return vscode.workspace.getConfiguration('agentHub').get<boolean>('delegation.readOnlyChildren', true);
  }

  // ---------------------------------------------------------------- flux d'événements

  /** File un correctif pré-rendu ; coalescé (~50 ms) puis envoyé. */
  private queuePatch(target: string | null, html: string): void {
    this.pending.push({ target, html });
    if (this.ready && !this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  private onEvent(threadId: string, stored: StoredEvent): void {
    if (threadId !== this.currentId) return;
    if (stored.event.type === 'file_changed' || stored.event.type === 'done') this.scheduleFiles();
    const id = `b${++this.seq}`;
    if (stored.event.type === 'subagent_started') {
      this.appendSubagent(stored.event.threadId, id, true);
      return;
    }
    // Un message (utilisateur ou agent) ferme le groupe de sous-agents en cours.
    if (breaksSubagentGroup(stored.event)) this.openGroup = undefined;
    const patch = renderEventPatch(this.openPartial, stored.event, id);
    if (!patch.html) return;
    this.openPartial = patch.openPartialId;
    this.queuePatch(patch.target, patch.html);
  }

  private flush(): void {
    this.flushTimer = undefined;
    if (!this.ready) {
      this.pending = [];
      this.pendingCards.clear();
      return;
    }
    const patches = this.pending.splice(0);
    if (patches.length) void this.post({ type: 'events', patches });
    // Les cartes sont remplacées après les correctifs : le DOM est déjà en place.
    const cards = [...this.pendingCards.values()];
    this.pendingCards.clear();
    for (const c of cards) {
      void this.post({ type: 'card', threadId: c.threadId, html: c.html, groupId: c.groupId, header: c.header });
    }
  }

  private onThreadChanged(thread: ThreadInfo): void {
    if (!this.ready) return; // ce qui est affiché sera reconstruit au message 'ready'
    this.postHeader(); // la liste du sélecteur et ses pastilles suivent tous les threads
    if (thread.id === this.currentId) this.scheduleFiles();
    // Un sous-agent affiché en carte dans la vue courante : rafraîchissement en direct.
    if (this.cardGroups.has(thread.id)) this.scheduleCard(thread.id);
  }

  /** Reconstruction complète : historique fait foi . */
  private onReady(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = undefined; }
    this.ready = true;
    const id = this.currentId;
    const thread = id ? this.orch.getThread(id) : undefined;
    if (!id || !thread) {
      this.seq = 0;
      this.openPartial = null;
      this.resetCards();
      void this.post({ type: 'init', html: '' });
      this.postHeader();
      void this.post({ type: 'files', html: '' });
      return;
    }
    const events = this.orch.getEvents(id);
    this.seq = events.length;
    this.openPartial = null;
    this.resetCardRender();
    for (let i = 0; i < events.length; i++) {
      const ev = events[i].event;
      const id2 = `b${i + 1}`;
      if (ev.type === 'subagent_started') {
        this.appendSubagent(ev.threadId, id2, false);
        continue;
      }
      // Un message (utilisateur ou agent) ferme le groupe de sous-agents en cours.
      if (breaksSubagentGroup(ev)) this.openGroup = undefined;
      const patch = renderEventPatch(this.openPartial, ev, id2);
      if (!patch.html) continue;
      this.openPartial = patch.openPartialId;
      this.blocks.push({ html: patch.html });
    }
    this.pending = [];
    void this.post({ type: 'init', html: this.blocks.map((b) => b.html).join('') });
    this.postHeader();
    void this.sendFiles();
    // Les cartes affichées sont rafraîchies une fois le rendu en place (totaux, activités).
    for (const tid of [...this.cardGroups.keys()]) this.scheduleCard(tid);
  }

  /** En-tête : options du sélecteur, sous-titre, statut, lignée, état des boutons. */
  private postHeader(): void {
    const id = this.currentId;
    const thread = id ? this.orch.getThread(id) : undefined;
    const parentId = thread?.parentId ?? '';
    void this.post({
      type: 'header',
      options: chatThreadOptions(this.orch.listThreads()),
      selected: id ?? '',
      subtitle: thread ? threadSubtitle(thread) : '',
      statusText: thread ? threadStatusText(thread.status) : '',
      statusClass: thread ? `st-${thread.status}` : '',
      running: thread ? isThreadRunning(thread.status) : false,
      isMain: thread ? !thread.parentId : false,
      // Fil d'Ariane et lecture seule des threads délégués.
      parentId,
      readOnly: readOnlyForThread(thread, this.readOnlyChildren()),
      lineage: thread ? lineageHtml(thread, parentId ? this.orch.getThread(parentId) : undefined) : '',
      hasThread: !!thread,
      agentName: thread?.agent ?? '',
    });
    if (this.view) this.view.title = thread ? thread.title : 'Chat';
  }

  // ---------------------------------------------------------------- bloc fichiers modifiés

  private scheduleFiles(): void {
    if (this.fileTimer) clearTimeout(this.fileTimer);
    this.fileTimer = setTimeout(() => { this.fileTimer = undefined; void this.sendFiles(); }, FILE_DEBOUNCE_MS);
  }

  private async sendFiles(): Promise<void> {
    if (!this.ready) return;
    const id = this.currentId;
    const thread = id ? this.orch.getThread(id) : undefined;
    if (!id || !thread) return;
    let files: ChangedFile[] = [];
    try {
      files = await this.orch.changedFiles(id);
    } catch {
      return; // thread fermé ou indisponible : réessaie au prochain déclencheur
    }
    if (this.currentId !== id || !this.ready) return;
    this.lastFiles = files;
    const pending = pendingFiles(files, this.keptSignatures(id));
    void this.post({ type: 'files', html: pending.length ? renderFilesBlockHtml(thread, pending) : '' });
  }

  private keptSignatures(threadId: string): string[] {
    const v = this.ctx.workspaceState.get<string[]>(keptKey(threadId));
    return Array.isArray(v) ? v : [];
  }

  private addKept(threadId: string, signatures: string[]): void {
    const merged = [...this.keptSignatures(threadId)];
    for (const s of signatures) if (!merged.includes(s)) merged.push(s);
    void this.ctx.workspaceState.update(keptKey(threadId), merged);
  }

  private fileByPath(path: string): ChangedFile | undefined {
    return this.lastFiles.find((f) => f.path === path);
  }

  /** « Conserver » : le fichier sort de la liste, signaturé pour réapparaître s'il change. */
  private keep(path: string): void {
    const id = this.currentId;
    if (!id) return;
    const file = this.fileByPath(path);
    if (!file) { void this.sendFiles(); return; }
    this.addKept(id, [fileSignature(file)]);
    void this.sendFiles();
  }

  private keepAll(): void {
    const id = this.currentId;
    if (!id || !this.lastFiles.length) return;
    this.addKept(id, this.lastFiles.map((f) => fileSignature(f)));
    void this.sendFiles();
  }

  /** Diff base du thread <-> fichier courant (document vide pour un fichier supprimé). */
  private openDiff(path: string): void {
    const id = this.currentId;
    const file = id ? this.fileByPath(path) : undefined;
    if (!id || !file) { void this.sendFiles(); return; }
    const base = baseContentUri(id, file.path, false);
    const right = file.status === 'deleted'
      ? baseContentUri(id, file.path, true)
      : vscode.Uri.file(file.absPath);
    const title = this.orch.getThread(id)?.title ?? id;
    void vscode.commands.executeCommand('vscode.diff', base, right, `${file.path} (thread ${title})`, { preview: true });
  }

  private async revertOne(path: string): Promise<void> {
    const id = this.currentId;
    if (!id) return;
    const choix = await vscode.window.showWarningMessage(
      `Annuler les modifications de ${path} faites par ce thread ?`,
      { modal: true },
      'Annuler les modifications',
    );
    if (choix !== 'Annuler les modifications') return;
    try {
      await this.orch.revertFiles(id, [path]);
      this.lastFiles = this.lastFiles.filter((f) => f.path !== path);
      void this.sendFiles();
    } catch (err) {
      this.reportFail(err, 'Annulation des modifications');
    }
  }

  private async revertAll(): Promise<void> {
    const id = this.currentId;
    if (!id) return;
    const pending = pendingFiles(this.lastFiles, this.keptSignatures(id));
    if (!pending.length) return;
    const n = pending.length;
    const choix = await vscode.window.showWarningMessage(
      `Annuler les modifications de ${n} fichier${n > 1 ? 's' : ''} faites par ce thread ?`,
      { modal: true, detail: pending.map((f) => f.path).join('\n') },
      'Tout annuler',
    );
    if (choix !== 'Tout annuler') return;
    try {
      await this.orch.revertFiles(id, pending.map((f) => f.path));
      void this.sendFiles();
    } catch (err) {
      this.reportFail(err, 'Annulation des modifications');
    }
  }

  // ---------------------------------------------------------------- messages du webview

  private async onMessage(raw: unknown): Promise<void> {
    const m = asMessage(raw);
    if (!m) return;
    switch (m.t) {
      case 'ready': if (!this.ready) this.onReady(); break;
      case 'send': if (m.text !== undefined) await this.sendText(m.text); break;
      case 'stop': await this.interruptCurrent(); break;
      case 'selectThread': if (m.id) this.selectThread(m.id, false); break;
      // Cartes de sous-agents (boutons du pied de carte).
      case 'openThread': if (m.id) this.showThread(m.id); break;
      case 'stopThread': if (m.id) await this.interruptThread(m.id); break;
      case 'applyThread': if (m.id) void vscode.commands.executeCommand('agentHub.applyWorktree', m.id); break;
      // Boutons délégués aux commandes globales (câblées dans extension.ts).
      case 'newThread': void vscode.commands.executeCommand('agentHub.newMainThread'); break;
      case 'importSession': void vscode.commands.executeCommand('agentHub.importSession'); break;
      case 'deleteThread': if (this.currentId) void vscode.commands.executeCommand('agentHub.deleteThread', this.currentId); break;
      case 'delegate': if (this.currentId) void vscode.commands.executeCommand('agentHub.delegateManual', this.currentId); break;
      case 'changeAgent': if (this.currentId) void vscode.commands.executeCommand('agentHub.changeAgent', this.currentId); break;
      case 'apply': if (this.currentId) void vscode.commands.executeCommand('agentHub.applyWorktree', this.currentId); break;
      case 'openDiff': if (m.path) this.openDiff(m.path); break;
      case 'keep': if (m.path) this.keep(m.path); break;
      case 'keepAll': this.keepAll(); break;
      case 'revert': if (m.path) await this.revertOne(m.path); break;
      case 'revertAll': await this.revertAll(); break;
      default: break;
    }
  }

  private async sendText(text: string): Promise<void> {
    const id = this.currentId;
    if (!id) return;
    void this.post({ type: 'clear-error' });
    try {
      await this.orch.sendMessage(id, text);
    } catch (err) {
      this.showErrInChat(err, 'envoi');
    }
  }

  private async interruptCurrent(): Promise<void> {
    await this.interruptThread(this.currentId);
  }

  private async interruptThread(threadId: string | undefined): Promise<void> {
    if (!threadId) return;
    try {
      await this.orch.interrupt(threadId);
    } catch (err) {
      this.showErrInChat(err, 'interruption');
    }
  }

  /** Bandeau d'erreur dans la vue (HTML pré-échappé). Aucune clé d'API dans les logs. */
  private showErrInChat(err: unknown, action: string): void {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`${action} échouée : ${message}`);
    void this.post({ type: 'error', html: renderEventHtml({ type: 'error', message }, `b${++this.seq}`) });
  }

  /** Erreur visible dans VS Code (annulations) + log. */
  private reportFail(err: unknown, action: string): void {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`${action} échouée : ${message}`);
    void vscode.window.showErrorMessage(`${action} impossible : ${message}`, 'OK').then((r) => r, () => undefined);
  }

  private post(message: unknown): Thenable<boolean> {
    if (!this.view) return Promise.resolve(false);
    return this.view.webview.postMessage(message).then(() => true, () => false);
  }
}
