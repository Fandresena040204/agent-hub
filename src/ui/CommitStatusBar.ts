// Barre d'état : permission de commit de l'agent principal, QuickPick de bascule incluse.
import * as vscode from 'vscode';
import type { OrchestratorApi } from '../core/orchestratorApi';
import type { CommitPermission } from '../core/types';
import { COMMIT_WORDS, commitStatusBarText, commitStatusBarTooltip, permissionFromWord } from './presentation';
import type { CommitWord } from './presentation';

const COMMAND_ID = 'agentHub.toggleCommitPermission';

interface WordItem extends vscode.QuickPickItem {
  word: CommitWord;
}

export class CommitStatusBar implements vscode.Disposable {
  private item: vscode.StatusBarItem | undefined;
  private subs: vscode.Disposable[] = [];
  private disposed = false;

  constructor(private readonly orch: OrchestratorApi) {}

  /** Crée l'item, s'abonne aux changements et enregistre la commande de bascule.
   *  NOTE : la commande `agentHub.toggleCommitPermission` est enregistrée ici (déjà déclarée
   *  dans package.json) ; ne pas la réenregistrer ailleurs. */
  register(context: vscode.ExtensionContext): void {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    item.name = 'Agent Hub — Commits';
    item.command = { command: COMMAND_ID, title: 'Agent Hub: Changer la permission de commit' };
    this.item = item;
    this.subs.push(new vscode.Disposable(this.orch.onDidChangeCommitPermission(() => this.update())));
    this.update();

    const cmd = vscode.commands.registerCommand(COMMAND_ID, () => void this.toggle());
    this.subs.push(cmd);
    context.subscriptions.push(item, cmd, this);
  }

  /** QuickPick off/ask/on -> orch.setCommitPermission. Annulation = aucun changement. */
  async toggle(): Promise<void> {
    const items: WordItem[] = COMMIT_WORDS.map((w) => ({
      label: `$(git-commit) Commits : ${w}`,
      word: w,
    }));
    items[0].description = 'deny — aucun commit autorisé';
    items[1].description = 'ask — confirme chaque commit de l\u2019agent';
    items[2].description = 'allow — commits autorisés sans confirmation';
    const pick = await vscode.window.showQuickPick(items, {
      title: 'Agent Hub — permission de commit',
      placeHolder: 'Permission de commit de l\u2019agent principal',
    });
    if (pick) this.orch.setCommitPermission(permissionFromWord(pick.word));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const d of this.subs.splice(0)) d.dispose();
    this.item?.dispose();
    this.item = undefined;
  }

  private update(): void {
    if (!this.item) return;
    const p: CommitPermission = this.orch.getCommitPermission();
    this.item.text = commitStatusBarText(p, this.orch.isGitRepo);
    this.item.tooltip = new vscode.MarkdownString(commitStatusBarTooltip(p, this.orch.isGitRepo));
    this.item.show();
  }
}
