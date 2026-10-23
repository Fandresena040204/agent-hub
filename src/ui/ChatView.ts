// Vue « Chat » de la barre latérale secondaire : même rendu que le Chat de VS Code,
// avec un bloc « N fichiers modifiés » (Conserver / Annuler) au-dessus de la zone de saisie.
import * as vscode from 'vscode';
import type { ChangedFile, OrchestratorApi, Unsubscribe } from '../core/orchestratorApi';
import type { StoredEvent } from '../core/events';
import type { ThreadInfo } from '../core/types';
import { createLogger } from '../core/log';
import { baseContentUri } from './ChangesView';
import {
  buildChatHtml, getNonce, isThreadRunning, renderEventHtml, renderEventPatch, threadStatusText,
} from './presentation';
import {
  chatThreadOptions, fileSignature, pendingFiles, renderFilesBlockHtml, threadSubtitle,
} from './chatViewModel';

const log = createLogger('ui.chatview');

/** Clé workspaceState du thread affiché. */
const CURRENT_KEY = 'agentHub.chat.currentThread';
/** Déclencheurs entraînant un rafraîchissement debounced du bloc fichiers. */
const FILE_DEBOUNCE_MS = 500;
const FLUSH_MS = 50;

type DisposableOrUnsub = vscode.Disposable | Unsubscribe;

function asDisposable(d: DisposableOrUnsub): vscode.Disposable {
  return d instanceof vscode.Disposable ? d : new vscode.Disposable(d);
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
  }

  // ---------------------------------------------------------------- thread courant

  private selectThread(threadId: string, focus: boolean): void {
    if (!threadId) return;
    this.currentId = threadId;
    void this.ctx.workspaceState.update(CURRENT_KEY, threadId);
    this.pending = [];
    this.openPartial = null;
    this.seq = this.orch.getEvents(threadId).length;
    this.lastFiles = [];
    if (focus) void vscode.commands.executeCommand('agentHub.chat.focus');
    if (this.ready) this.onReady();
  }

  // ---------------------------------------------------------------- flux d'événements

  /** Correctifs pré-rendus, coalescés (~50 ms) puis envoyés. */
  private onEvent(threadId: string, stored: StoredEvent): void {
    if (threadId !== this.currentId) return;
    if (stored.event.type === 'file_changed' || stored.event.type === 'done') this.scheduleFiles();
    const patch = renderEventPatch(this.openPartial, stored.event, `b${++this.seq}`);
    if (!patch.html) return;
    this.openPartial = patch.openPartialId;
    this.pending.push({ target: patch.target, html: patch.html });
    if (this.ready && !this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  private flush(): void {
    this.flushTimer = undefined;
    if (!this.ready || !this.pending.length) return;
    const patches = this.pending.splice(0);
    void this.post({ type: 'events', patches });
  }

  private onThreadChanged(thread: ThreadInfo): void {
    if (!this.ready) return; // ce qui est affiché sera reconstruit au message 'ready'
    this.postHeader(); // la liste du sélecteur et ses pastilles suivent tous les threads
    if (thread.id === this.currentId) this.scheduleFiles();
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
      void this.post({ type: 'init', html: '' });
      this.postHeader();
      void this.post({ type: 'files', html: '' });
      return;
    }
    const events = this.orch.getEvents(id);
    this.seq = events.length;
    this.openPartial = null;
    const blocks: string[] = [];
    for (let i = 0; i < events.length; i++) {
      const patch = renderEventPatch(this.openPartial, events[i].event, `b${i + 1}`);
      if (!patch.html) continue;
      this.openPartial = patch.openPartialId;
      blocks.push(patch.html);
    }
    this.pending = [];
    void this.post({ type: 'init', html: blocks.join('') });
    this.postHeader();
    void this.sendFiles();
  }

  /** En-tête : options du sélecteur, sous-titre, statut, état des boutons. */
  private postHeader(): void {
    const id = this.currentId;
    const thread = id ? this.orch.getThread(id) : undefined;
    void this.post({
      type: 'header',
      options: chatThreadOptions(this.orch.listThreads()),
      selected: id ?? '',
      subtitle: thread ? threadSubtitle(thread) : '',
      statusText: thread ? threadStatusText(thread.status) : '',
      statusClass: thread ? `st-${thread.status}` : '',
      running: thread ? isThreadRunning(thread.status) : false,
      isMain: thread ? !thread.parentId : false,
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
      // Boutons délégués aux commandes globales (câblées dans extension.ts).
      case 'newThread': void vscode.commands.executeCommand('agentHub.newMainThread'); break;
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
    const id = this.currentId;
    if (!id) return;
    try {
      await this.orch.interrupt(id);
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
