// Vue « Fichiers modifiés » : fichiers du thread sélectionné + diff base <-> courant.
import * as vscode from 'vscode';
import type { ChangedFile, OrchestratorApi, Unsubscribe } from '../core/orchestratorApi';
import type { ThreadInfo } from '../core/types';
import { fileIconId, fileParts, fileStatusText } from './presentation';

/** Schéma du document virtuel servi par baseContent(). */
const SCHEME = 'agenthub-base';

const DEBOUNCE_MS = 500;

export class ChangesView implements vscode.TreeDataProvider<ChangedFile> {
  private readonly emitter = new vscode.EventEmitter<ChangedFile | undefined | null>();
  readonly onDidChangeTreeData: vscode.Event<ChangedFile | undefined | null> = this.emitter.event;

  private threadId: string | undefined;
  private title = '';
  private unsub: Unsubscribe | undefined;
  private unsubRemoved: Unsubscribe | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly orch: OrchestratorApi) {
    // Thread suivi supprimé : la vue passe vide (désélection).
    this.unsubRemoved = orch.onDidRemoveThread((threadId) => {
      if (threadId === this.threadId) this.setThread(undefined);
    });
  }

  /** Sélectionne le thread suivi (désélection = undefined) ; déclenche un rafraîchissement. */
  setThread(threadId: string | undefined): void {
    this.threadId = threadId;
    this.title = threadId ? (this.orch.getThread(threadId)?.title ?? '') : '';
    this.unsub?.();
    this.unsub = threadId ? this.orch.onDidChangeThread((t) => this.onThread(t)) : undefined;
    this.emitter.fire(undefined);
  }

  /** Edition directe du thread suivi ; rafraîchissement debounced. */
  refresh(): void {
    this.emitter.fire(undefined);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.unsub?.();
    this.unsubRemoved?.();
    this.emitter.dispose();
  }

  getChildren(): Thenable<ChangedFile[]> {
    if (!this.threadId) return Promise.resolve([]);
    return this.orch.changedFiles(this.threadId).then(
      (files) => files,
      () => [], // thread fermé ou temporairement indisponible : vue vide
    );
  }

  getTreeItem(file: ChangedFile): vscode.TreeItem {
    const { dir, name } = fileParts(file.path);
    const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
    if (dir) item.description = dir;
    item.iconPath = new vscode.ThemeIcon(fileIconId(file.status));
    item.tooltip = `${file.path} — ${fileStatusText(file.status)}`;
    item.id = `${this.threadId ?? ''}:${file.path}:${file.status}`;
    item.resourceUri = vscode.Uri.file(file.absPath);
    if (this.threadId) {
      item.command = {
        command: 'vscode.diff',
        title: 'Voir le diff',
        arguments: this.diffArgs(file),
      };
    }
    return item;
  }

  /** Diff base (document virtuel) <-> fichier courant ; supprimé = base <-> document vide. */
  private diffArgs(file: ChangedFile): [vscode.Uri, vscode.Uri, string, { preview: boolean }] | undefined {
    if (!this.threadId) return undefined;
    const base = baseContentUri(this.threadId, file.path, false);
    const right = file.status === 'deleted'
      ? baseContentUri(this.threadId, file.path, true) // supprimé : côté droit = document vide
      : vscode.Uri.file(file.absPath);
    const title = `${file.path} (thread ${this.title || this.threadId})`;
    return [base, right, title, { preview: true }];
  }

  private onThread(t: ThreadInfo): void {
    if (t.id !== this.threadId) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.emitter.fire(undefined), DEBOUNCE_MS);
  }
}

/** URI du document virtuel de contenu de base : `agenthub-base:/<relPath>?thread=<id>`. */
export function baseContentUri(threadId: string, relPath: string, empty = false): vscode.Uri {
  return vscode.Uri.from({
    scheme: SCHEME,
    path: `/${relPath.replace(/\\/g, '/')}`,
    query: `thread=${threadId}${empty ? '&empty=1' : ''}`,
  });
}

class BaseContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): Thenable<string> {
    if (uri.query.includes('empty=1')) return Promise.resolve('');
    const threadId = new URLSearchParams(uri.query).get('thread') ?? '';
    const relPath = uri.path.replace(/^\//, '');
    return this.orch.baseContent(threadId, relPath).then((content) => content ?? '');
  }

  constructor(private readonly orch: OrchestratorApi) {}
}

/** Enregistre le fournisseur du schéma `agenthub-base` (à pousser dans context.subscriptions). */
export function registerBaseContentProvider(ctx: vscode.ExtensionContext, orch: OrchestratorApi): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(SCHEME, new BaseContentProvider(orch));
}
