// Vue « Threads » : arbre des threads principaux + threads délégués.
import * as vscode from 'vscode';
import type { OrchestratorApi } from '../core/orchestratorApi';
import type { ThreadInfo } from '../core/types';
import { sortThreads, threadContextValue, threadDescription, threadIconId, threadTooltip } from './presentation';

/** Commande exécutée au clic sur un thread (signature attendue : openThread(threadId: string)). */
const OPEN_COMMAND = 'agentHub.openThread';

export class ThreadsTreeProvider implements vscode.TreeDataProvider<ThreadInfo> {
  private readonly subs: vscode.Disposable[] = [];
  private readonly emitter = new vscode.EventEmitter<ThreadInfo | undefined | null>();
  /** Cache des éléments : la même instance est réutilisée pour préserver l'état d'expansion. */
  private readonly cache = new Map<string, ThreadInfo>();

  readonly onDidChangeTreeData: vscode.Event<ThreadInfo | undefined | null> = this.emitter.event;

  constructor(private readonly orch: OrchestratorApi) {
    // Toute mise à jour de thread redessine l'arbre (accès occasionnel : la liste est petite).
    this.subs.push(new vscode.Disposable(this.orch.onDidChangeThread(() => this.emitter.fire(undefined))));
    // Thread supprimé : purge du cache puis redessin.
    this.subs.push(new vscode.Disposable(this.orch.onDidRemoveThread((id) => this.onThreadRemoved(id))));
  }

  getTreeItem(thread: ThreadInfo): vscode.TreeItem {
    const hasChildren = this.hasChildren(thread);
    const item = new vscode.TreeItem(
      thread.title,
      hasChildren ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
    );
    // VS Code mémorise l'état de dépliage par id : l'id change quand les premiers enfants apparaissent,
    // sinon un thread affiché d'abord sans enfant resterait replié.
    item.id = hasChildren ? `${thread.id}:parent` : thread.id;
    item.description = threadDescription(thread);
    item.iconPath = new vscode.ThemeIcon(threadIconId(thread.status));
    item.tooltip = new vscode.MarkdownString(threadTooltip(thread));
    item.contextValue = threadContextValue(thread);
    item.command = { command: OPEN_COMMAND, title: 'Ouvrir le thread', arguments: [thread.id] };
    return item;
  }

  getChildren(element?: ThreadInfo): ThreadInfo[] {
    const all = this.orch.listThreads();
    if (!element) {
      const mains = sortThreads(all.filter((t) => !t.parentId));
      this.prune(mains);
      return mains.map((t) => this.upsert(t));
    }
    return sortThreads(all.filter((t) => t.parentId === element.id)).map((t) => this.upsert(t));
  }

  dispose(): void {
    this.cache.clear();
    for (const d of this.subs.splice(0)) d.dispose();
    this.emitter.dispose();
  }

  private hasChildren(thread: ThreadInfo): boolean {
    return this.orch.listThreads().some((t) => t.parentId === thread.id);
  }

  /** Met à jour la version en cache (même objet, champs rafraîchis) pour garder l'expansion. */
  private upsert(thread: ThreadInfo): ThreadInfo {
    const cached = this.cache.get(thread.id);
    if (cached) {
      Object.assign(cached, thread);
      return cached;
    }
    this.cache.set(thread.id, thread);
    return thread;
  }

  /** Thread supprimé : purge du thread et, par précaution, de tout descendant resté en cache. */
  private onThreadRemoved(rootId: string): void {
    const gone = new Set<string>([rootId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [id, t] of this.cache) {
        if (!gone.has(id) && t.parentId && gone.has(t.parentId)) {
          gone.add(id);
          grew = true;
        }
      }
    }
    for (const id of gone) this.cache.delete(id);
    this.emitter.fire(undefined);
  }

  private prune(kept: ThreadInfo[]): void {
    const live = new Set(kept.map((t) => t.id));
    live.add(''); // sécurité : un id vide n'est jamais un thread réel
    for (const id of [...this.cache.keys()]) {
      if (!live.has(id)) this.cache.delete(id);
    }
  }
}
