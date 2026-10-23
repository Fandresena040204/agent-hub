// Boîte de confirmation d'un commit (mode « ask »).
import * as vscode from 'vscode';
import type { CommitPreview } from '../core/orchestratorApi';
import { commitPreviewDetail } from './presentation';

/** Message modale : message proposé + fichiers + résumé du diff (tronqué à ~3000 caractères). */
export async function confirmCommit(preview: CommitPreview): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    'Confirmer le commit ?',
    { modal: true, detail: commitPreviewDetail(preview) },
    'Accepter',
    'Refuser',
  );
  return choice === 'Accepter';
}
