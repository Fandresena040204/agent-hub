// Assistant d'import d'une session native d'un CLI comme thread Agent Hub.
import * as vscode from 'vscode';
import type { NativeSession } from '../adapters/AgentAdapter';
import type { AgentDescriptor, OrchestratorApi } from '../core/orchestratorApi';
import type { ThreadInfo } from '../core/types';
import { createLogger } from '../core/log';
import { isUnsupportedError, nativeSessionItem } from './nativeSessions';

const log = createLogger('ui.sessionImport');

/** Session native enrichie du thread Agent Hub qui la suit déjà, le cas échéant. */
type ImportableSession = NativeSession & { importedThreadId?: string };

/** Item de session : champs du QuickPick + ids pour l'import. */
interface SessionPickItem extends vscode.QuickPickItem {
  sessionId: string;
  importedId?: string;
}

const UNAVAILABLE_DETAIL = 'CLI introuvable ou non fonctionnel';

/**
 * QuickPick de l'agent à importer. Les agents indisponibles et ceux dont l'import a déjà
 * échoué (« non pris en charge »…) sont affichés avec leur détail mais jamais sélectionnables.
 */
function pickImportAgent(
  agents: AgentDescriptor[],
  rejected: Map<string, string>,
): Promise<AgentDescriptor | undefined> {
  const byItem = new Map<vscode.QuickPickItem, AgentDescriptor>();
  const items: vscode.QuickPickItem[] = agents.map((a) => {
    const failure = rejected.get(a.id);
    const blocked = !a.available || failure !== undefined;
    const item: vscode.QuickPickItem = {
      label: blocked ? `$(circle-slash) ${a.label}` : a.label,
      description: a.id,
      detail: !a.available ? (a.detail ?? UNAVAILABLE_DETAIL) : failure,
    };
    byItem.set(item, a);
    return item;
  });
  const qp = vscode.window.createQuickPick<vscode.QuickPickItem>();
  qp.items = items;
  qp.title = 'Agent Hub — importer une session native';
  qp.placeholder = "Choisir l'agent";
  // Les agents bloqués restent visibles (avec la raison) mais jamais sélectionnables.
  const blocked = (i: vscode.QuickPickItem): boolean => {
    const a = byItem.get(i);
    return !a || !a.available || rejected.has(a.id);
  };
  return new Promise<AgentDescriptor | undefined>((resolve) => {
    let ok = false;
    qp.onDidChangeActive((active) => {
      if (active.length && active.every(blocked)) {
        qp.activeItems = qp.items.filter((i) => !blocked(i));
      }
    });
    qp.onDidAccept(() => {
      const agent = byItem.get(qp.activeItems[0]);
      if (!agent || blocked(qp.activeItems[0])) return;
      ok = true;
      qp.hide();
      resolve(agent);
    });
    qp.onDidHide(() => {
      qp.dispose();
      if (!ok) resolve(undefined);
    });
    qp.show();
  });
}

/**
 * Assistant : agent -> sessions natives de ce dossier -> import.
 * Renvoie le thread lié à la session choisie (thread existant si la session est déjà suivie),
 * undefined à la moindre annulation.
 */
export async function runImportSessionWizard(orch: OrchestratorApi): Promise<ThreadInfo | undefined> {
  const agents = await orch.listAgents();
  if (!agents.some((a) => a.available)) {
    void vscode.window.showErrorMessage(
      "Aucun agent disponible : vérifiez l'installation des CLI (réglages agentHub.<agent>.path).",
      'OK',
    ).then((r) => r, () => undefined);
    return undefined;
  }
  // Agents dont l'import a échoué : signalés avec ce détail au prochain tour (l'appel a lieu au moment du choix).
  const rejected = new Map<string, string>();
  for (;;) {
    const agent = await pickImportAgent(agents, rejected);
    if (!agent) return undefined;

    // QuickPick des sessions : ouvert tout de suite, busy pendant le chargement.
    const qp = vscode.window.createQuickPick<SessionPickItem>();
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    qp.title = `Agent Hub — sessions ${agent.label} à importer`;
    qp.placeholder = 'Chargement des sessions…';
    qp.busy = true;
    qp.show();
    let sessions: ImportableSession[] | undefined;
    let loadError: string | undefined;
    try {
      sessions = await orch.listImportableSessions(agent.id);
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    }
    // Erreur de chargement : « non pris en charge » → agent signalé au prochain tour ; sinon message.
    if (loadError) {
      qp.hide();
      qp.dispose();
      if (isUnsupportedError(loadError)) {
        rejected.set(agent.id, loadError);
      } else {
        log.error(`Sessions ${agent.id} indisponibles : ${loadError}`);
        void vscode.window.showErrorMessage(`Sessions ${agent.label} indisponibles : ${loadError}`, 'OK')
          .then((r) => r, () => undefined);
      }
      continue;
    }
    if (!sessions || sessions.length === 0) {
      qp.hide();
      qp.dispose();
      void vscode.window.showInformationMessage(`Aucune session ${agent.label} trouvée pour ce dossier.`);
      continue;
    }
    qp.busy = false;
    qp.placeholder = 'Choisir une session native à importer (Échap : annuler)';
    qp.items = sessions.map((s) => {
      const t = nativeSessionItem(s, s.importedThreadId, Date.now());
      return {
        label: t.label,
        description: t.description,
        detail: t.detail,
        sessionId: s.id,
        importedId: s.importedThreadId,
      };
    });
    const chosen = await new Promise<SessionPickItem | undefined>((resolve) => {
      let ok = false;
      qp.onDidAccept(() => {
        ok = true;
        const item = qp.activeItems[0];
        qp.hide();
        resolve(item);
      });
      qp.onDidHide(() => {
        qp.dispose();
        if (!ok) resolve(undefined);
      });
    });
    if (!chosen) continue;
    // Session déjà suivie : renvoie le thread existant sans réimporter.
    if (chosen.importedId) {
      const existing = orch.getThread(chosen.importedId);
      if (existing) return existing;
    }
    try {
      return await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Import de la session…' },
        () => orch.importSession(agent.id, chosen.sessionId),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Import de la session ${chosen.sessionId} (${agent.id}) échoué : ${msg}`);
      void vscode.window.showErrorMessage(`Import de la session impossible : ${msg}`, 'OK')
        .then((r) => r, () => undefined);
      continue;
    }
  }
}
