// Notification de fin d'un sous-agent : l'utilisateur, ailleurs, apprend le résultat sans ouvrir la vue.
import * as vscode from 'vscode';
import type { OrchestratorApi } from '../core/orchestratorApi';
import { createLogger } from '../core/log';
import { SUBAGENT_END_STATUSES, isThreadRunning, subagentNotificationText } from './presentation';

const log = createLogger('ui.subagent');

/** Ce que le notificateur demande à la vue : thread affiché + ouverture d'un thread. */
export interface ChatViewLike {
  /** Id du thread affiché (undefined si aucun). */
  currentThreadId(): string | undefined;
  /** Sélectionne le thread et révèle la vue. */
  showThread(threadId: string): void;
}

/** Action proposée sur la notification. */
const OPEN_ACTION = 'Ouvrir';

/**
 * Notifie la fin d'un thread délégué qui n'est pas affiché dans la vue : information
 * (avertissement en cas d'erreur). Un tour = une notification ; le bouton Ouvrir sélectionne le thread.
 */
export function registerSubagentNotifications(
  _ctx: vscode.ExtensionContext,
  orch: OrchestratorApi,
  chatView: ChatViewLike,
): vscode.Disposable {
  // Enfants déjà actifs à l'enregistrement (threads restaurés d'une session précédente).
  const active = new Set<string>(
    orch.listThreads().filter((t) => t.parentId && isThreadRunning(t.status)).map((t) => t.id),
  );
  const ended: readonly string[] = SUBAGENT_END_STATUSES;
  const unsub = orch.onDidChangeThread((t) => {
    if (!t.parentId) return; // thread principal : rien à annoncer
    if (isThreadRunning(t.status)) {
      active.add(t.id);
      return;
    }
    if (!active.has(t.id)) return; // pas d'état « en cours » connu : rien à annoncer
    active.delete(t.id);
    if (!ended.includes(t.status)) return;
    if (chatView.currentThreadId() === t.id) return; // déjà visible dans la vue
    const text = subagentNotificationText(t);
    log.info(`Sous-agent ${t.id} : ${t.status}, notification affichée`);
    void (t.status === 'error'
      ? vscode.window.showWarningMessage(text, OPEN_ACTION)
      : vscode.window.showInformationMessage(text, OPEN_ACTION)
    ).then(
      (choice) => { if (choice === OPEN_ACTION) chatView.showThread(t.id); },
      () => undefined,
    );
  });
  return new vscode.Disposable(unsub);
}
