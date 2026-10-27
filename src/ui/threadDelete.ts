// Suppression d'un thread : confirmation modale puis orch.deleteThread.
import * as vscode from 'vscode';
import type { OrchestratorApi } from '../core/orchestratorApi';
import { createLogger } from '../core/log';
import { deleteConfirmDetail, subtreeDeleteInfo } from './threadLifecycle';

const log = createLogger('ui.threadDelete');

/**
 * Modale de confirmation puis suppression. Renvoie vrai si le thread a été supprimé.
 * Pour un principal, ses threads délégués partent aussi ; la session native du CLI n'est pas touchée.
 */
export async function confirmAndDeleteThread(orch: OrchestratorApi, threadId: string): Promise<boolean> {
  const info = orch.getThread(threadId);
  if (!info) {
    log.warn(`Thread introuvable : ${threadId}`);
    void vscode.window.showErrorMessage(`Thread introuvable : ${threadId}`, 'OK').then((r) => r, () => undefined);
    return false;
  }
  const detail = deleteConfirmDetail({
    isMain: !info.parentId,
    agent: info.agent,
    ...subtreeDeleteInfo(orch.listThreads(), info),
  });
  const choice = await vscode.window.showWarningMessage(
    `Supprimer le thread « ${info.title} » ?`,
    { modal: true, detail },
    'Supprimer',
  );
  if (choice !== 'Supprimer') return false;
  try {
    await orch.deleteThread(threadId);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Suppression du thread ${threadId} échouée : ${msg}`);
    void vscode.window.showErrorMessage(`Suppression impossible : ${msg}`, 'OK').then((r) => r, () => undefined);
    return false;
  }
}
