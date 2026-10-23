// Assistants : brique commune agent -> modèle -> effort, réutilisée par la création,
// la délégation manuelle et le changement d'agent.
import * as vscode from 'vscode';
import type { AgentCapabilities } from '../adapters/AgentAdapter';
import type { AgentRef } from '../core/events';
import type {
  AgentDescriptor, ChangeAgentRequest, DelegateRequest, MainThreadRequest, OrchestratorApi,
} from '../core/orchestratorApi';
import type { AgentId, IsolationMode, PermissionMode, ThreadInfo } from '../core/types';
import { defaultModelChoice, effortChoice } from './presentation';

/** Étape : ok=false = annulation (l'assistant s'arrête) ; value peut être '' / undefined. */
type Step<T> = { ok: true; value: T } | { ok: false };

const UNAVAILABLE_SUFFIX = 'CLI introuvable ou non fonctionnel';

export type IsolationPolicy = 'agent-decides' | 'always-worktree' | 'always-shared';

const MODES: { id: PermissionMode; label: string; detail: string }[] = [
  { id: 'readonly', label: 'readonly — lecture seule', detail: "L'agent ne modifie aucun fichier." },
  { id: 'edit', label: 'edit — édition', detail: "L'agent peut modifier les fichiers du workspace." },
  { id: 'full', label: 'full — accès complet', detail: "L'agent peut tout faire (édition, commandes)." },
];

const ISOLATIONS: { id: IsolationMode; label: string; detail: string }[] = [
  {
    id: 'shared',
    label: 'shared — workspace partagé',
    detail: 'Travaille directement dans le workspace ; écritures limitées au périmètre (globs obligatoires).',
  },
  {
    id: 'worktree',
    label: 'worktree — branche git isolée',
    detail: 'Copie isolée du dépôt sur une branche ; appliqué au workspace quand tu le valides.',
  },
];

/** Défaut des réglages agentHub.<agent>.defaultModel|defaultEffort (chaîne vide = non défini). */
function configDefault(agent: AgentId, key: string): string | undefined {
  return vscode.workspace.getConfiguration('agentHub').get<string>(`${agent}.${key}`) || undefined;
}

/** QuickPick des agents ; indisponibles affichés (détail) mais non sélectionnables ; actuel en tête + présélectionné. */
async function pickAgent(agents: AgentDescriptor[], title: string, current?: AgentId): Promise<AgentDescriptor | undefined> {
  const qp = vscode.window.createQuickPick<vscode.QuickPickItem>();
  const byItem = new Map<vscode.QuickPickItem, AgentDescriptor>();
  let currentItem: vscode.QuickPickItem | undefined;
  qp.items = agents.map((a) => {
    const isCurrent = a.id === current;
    const item: vscode.QuickPickItem = {
      label: a.available ? (isCurrent ? `${a.label} (actuel)` : a.label) : `$(circle-slash) ${a.label}`,
      description: a.id,
      detail: a.available ? undefined : (a.detail ?? UNAVAILABLE_SUFFIX),
    };
    byItem.set(item, a);
    if (isCurrent) currentItem = item;
    return item;
  });
  qp.title = title;
  qp.placeholder = "Choisir l'agent";
  return new Promise<AgentDescriptor | undefined>((resolve) => {
    let resolved = false;
    // Agents indisponibles affichés (avec le détail) mais jamais sélectionnables.
    qp.onDidChangeActive((items) => {
      if (items.length && items.every((i) => byItem.get(i)?.available !== true)) {
        qp.activeItems = qp.items.filter((i) => byItem.get(i)?.available === true);
      }
    });
    qp.onDidAccept(() => {
      const agent = byItem.get(qp.activeItems[0]);
      if (!agent || !agent.available) return;
      resolved = true;
      qp.hide();
      resolve(agent);
    });
    qp.onDidHide(() => {
      qp.dispose();
      if (!resolved) resolve(undefined);
    });
    if (currentItem) qp.activeItems = [currentItem];
    qp.show();
  });
}

/** Passage le défaut en tête de liste (QuickPick présélectionne le premier item). */
function reorderDefault<T extends { id: string }>(list: T[], def: string | undefined): T[] {
  const i = def ? list.findIndex((x) => x.id === def) : -1;
  return i > 0 ? [list[i], ...list.slice(0, i), ...list.slice(i + 1)] : list;
}

/** Choix du modèle : liste des capabilities (matchOnDescription) + saisie libre, ou saisie libre seule. */
async function pickModel(caps: AgentCapabilities, def: string | undefined): Promise<Step<string | undefined>> {
  if (caps.models === 'free-text') {
    const value = await vscode.window.showInputBox({
      title: 'Agent Hub — modèle',
      prompt: 'Modèle (saisie libre) ; Entrée : passer cette étape, Échap : annuler',
      value: def,
    });
    return value === undefined ? { ok: false } : { ok: true, value: value.trim() || undefined };
  }
  const items: vscode.QuickPickItem[] = reorderDefault(caps.models, def).map((m) => ({
    label: m.label ?? m.id,
    description: m.label ? m.id : undefined, // l'id exact reste cherchable
  }));
  const freeEntry: vscode.QuickPickItem = { label: '$(pencil) Saisir un autre modèle…', detail: 'Modèle non listé par le CLI' };
  items.push(freeEntry);
  const pick = await vscode.window.showQuickPick(items, {
    title: 'Agent Hub — modèle',
    placeHolder: 'Choisir un modèle, ou saisir une autre valeur via la dernière entrée',
    matchOnDescription: true,
  });
  if (!pick) return { ok: false };
  if (pick === freeEntry) {
    const value = await vscode.window.showInputBox({
      title: 'Agent Hub — modèle',
      prompt: 'Identifiant exact du modèle (tel que le CLI l\u2019attend)',
      placeHolder: 'p.ex. gpt-5-mini',
    });
    return value === undefined ? { ok: false } : { ok: true, value: value.trim() || undefined };
  }
  return { ok: true, value: pick.description ?? pick.label };
}

/** Choix de l'effort pour le modèle retenu ; étape transparente si aucun niveau ne s'applique. */
async function pickEffort(agent: AgentId, caps: AgentCapabilities, model: string | undefined): Promise<Step<string | undefined>> {
  const { levels, def } = effortChoice(caps, model, configDefault(agent, 'defaultEffort'));
  if (!levels || levels.length === 0) return { ok: true, value: undefined };
  const items: vscode.QuickPickItem[] = reorderDefault(levels, def).map((e) => ({
    label: e.label ?? e.id,
    description: e.label ? e.id : undefined,
  }));
  const cliDefault: vscode.QuickPickItem = { label: '(par défaut du CLI)', detail: "Ne pas passer de niveau d'effort au CLI" };
  items.push(cliDefault);
  const pick = await vscode.window.showQuickPick(items, {
    title: 'Agent Hub — niveau d\u2019effort',
    placeHolder: "Choisir le niveau d'effort",
    matchOnDescription: true,
  });
  if (!pick) return { ok: false };
  if (pick === cliDefault) return { ok: true, value: undefined };
  return { ok: true, value: pick.description ?? pick.label };
}

/** Choix du mode de permission (readonly présélectionné, le plus sûr). */
async function pickMode(): Promise<Step<PermissionMode>> {
  const pick = await vscode.window.showQuickPick(
    MODES.map((m): vscode.QuickPickItem => ({ label: m.label, detail: m.detail, description: m.id })),
    { title: 'Agent Hub — mode de permission', placeHolder: 'Mode de permission du thread principal' },
  );
  if (!pick) return { ok: false };
  const mode = MODES.find((m) => m.id === pick.description) ?? MODES[0];
  return { ok: true, value: mode.id };
}

/** Mode de permission d'un sous-agent : readonly / edit seulement. */
async function pickDelegateMode(): Promise<Step<'readonly' | 'edit'>> {
  const pick = await vscode.window.showQuickPick(
    MODES.filter((m) => m.id !== 'full').map((m): vscode.QuickPickItem => ({ label: m.label, detail: m.detail, description: m.id })),
    { title: 'Agent Hub — mode de permission', placeHolder: 'Mode de permission du sous-agent' },
  );
  if (!pick) return { ok: false };
  return { ok: true, value: pick.description as 'readonly' | 'edit' };
}

/** Isolation du sous-agent en mode edit (détails explicatifs dans la liste). */
async function pickIsolation(): Promise<Step<IsolationMode>> {
  const pick = await vscode.window.showQuickPick(
    ISOLATIONS.map((m): vscode.QuickPickItem => ({ label: m.label, detail: m.detail, description: m.id })),
    { title: 'Agent Hub — isolation', placeHolder: 'Isolation du sous-agent' },
  );
  if (!pick) return { ok: false };
  return { ok: true, value: pick.description as IsolationMode };
}

/**
 * Brique commune : agent (indisponibles signalés, actuel présélectionné « (actuel) ») ->
 * modèle (défauts : ref courante si même agent > réglages agentHub.<agent>.defaultModel > capabilities)
 * -> effort via effortLevelsFor(caps, modèle) (étape sautée si aucun niveau ; « (par défaut du CLI) » = ne pas en passer).
 */
export async function pickAgentModelEffort(
  orch: OrchestratorApi,
  opts: { title: string; current?: AgentRef; allowedAgents?: AgentId[] },
): Promise<AgentRef | undefined> {
  let agents = await orch.listAgents();
  if (opts.allowedAgents) agents = agents.filter((a) => opts.allowedAgents!.includes(a.id));
  if (!agents.some((a) => a.available)) {
    void vscode.window.showErrorMessage(
      "Aucun agent disponible : vérifiez l'installation des CLI (réglages agentHub.<agent>.path).",
    );
    return undefined;
  }
  const agent = await pickAgent(agents, opts.title, opts.current?.agent);
  if (!agent) return undefined;
  const caps: AgentCapabilities = agent.capabilities ?? { models: 'free-text', effortLevels: null };

  const modelDef = defaultModelChoice({
    caps,
    agentId: agent.id,
    setting: configDefault(agent.id, 'defaultModel'),
    current: opts.current,
  });
  const model = await pickModel(caps, modelDef);
  if (!model.ok) return undefined;
  const effort = await pickEffort(agent.id, caps, model.value);
  if (!effort.ok) return undefined;
  return { agent: agent.id, model: model.value || undefined, effort: effort.value || undefined };
}

/** Assistant de création d'un thread principal. Renvoie undefined à la moindre annulation. */
export async function runNewThreadWizard(orch: OrchestratorApi): Promise<MainThreadRequest | undefined> {
  const ref = await pickAgentModelEffort(orch, { title: 'Agent Hub — nouvel agent principal' });
  if (!ref) return undefined;
  const mode = await pickMode();
  if (!mode.ok) return undefined;

  const prompt = await vscode.window.showInputBox({
    title: 'Agent Hub — prompt initial',
    placeHolder: "Première consigne pour l'agent…",
    prompt: "Consigne envoyée à l'agent au démarrage",
    validateInput: (v) => (v.trim() ? null : 'Au moins un caractère'),
  });
  if (prompt === undefined) return undefined;

  return { agent: ref.agent, model: ref.model, effort: ref.effort, permissionMode: mode.value, prompt };
}

/** Assistant de délégation manuelle d'un thread principal vers un sous-agent. */
export async function runDelegateWizard(
  orch: OrchestratorApi,
  _parent: ThreadInfo,
  policy: IsolationPolicy,
): Promise<DelegateRequest | undefined> {
  const ref = await pickAgentModelEffort(orch, { title: 'Agent Hub — déléguer' });
  if (!ref) return undefined;

  const mode = await pickDelegateMode();
  if (!mode.ok) return undefined;

  // Isolation : choix seulement en edit + policy agent-decides + dépôt git ; sinon imposée.
  let isolation: IsolationMode | undefined;
  if (mode.value === 'edit' && policy === 'agent-decides' && orch.isGitRepo) {
    const iso = await pickIsolation();
    if (!iso.ok) return undefined;
    isolation = iso.value;
  }

  // Périmètre obligatoire en edit + shared (les écritures ne sont plus bornées par un worktree).
  let scope: string[] | undefined;
  if (mode.value === 'edit') {
    isolation = isolation ?? (policy === 'always-worktree' ? 'worktree' : 'shared');
    if (isolation === 'shared') {
      const raw = await vscode.window.showInputBox({
        title: "Agent Hub — périmètre du sous-agent",
        prompt: 'Globs séparés par des virgules (ex. src/api/**, docs/x.md)',
        placeHolder: 'src/api/**, docs/x.md',
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim() ? null : 'Au moins un motif'),
      });
      if (raw === undefined) return undefined;
      scope = raw.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }

  const prompt = await vscode.window.showInputBox({
    title: 'Agent Hub — consigne du sous-agent',
    placeHolder: 'Ce que le sous-agent doit faire…',
    prompt: "Consigne envoyée au sous-agent au démarrage",
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? null : 'Au moins un caractère'),
  });
  if (prompt === undefined) return undefined;

  return {
    agent: ref.agent,
    model: ref.model,
    effort: ref.effort,
    prompt,
    mode: mode.value,
    isolation,
    scope,
  };
}

/** Passation pour un changement vers un autre CLI : résumé par l'agent sortant (1 tour) ou dossier brut. */
async function pickHandoff(): Promise<Step<boolean>> {
  const withSummary: vscode.QuickPickItem = {
    label: "Résumé par l'agent sortant (recommandé, coûte un tour)",
    detail: 'L\u2019agent actuel écrit un résumé de passation pour amorcer la nouvelle session.',
  };
  const rawOnly: vscode.QuickPickItem = {
    label: 'Extrait de la conversation seulement',
    detail: 'Aucun tour supplémentaire ; le nouvel agent reçoit un dossier de la conversation.',
  };
  const pick = await vscode.window.showQuickPick([withSummary, rawOnly], {
    title: 'Agent Hub — passation',
    placeHolder: 'Préparer le relais vers le nouvel agent',
  });
  if (!pick) return { ok: false };
  return { ok: true, value: pick === withSummary };
}

/** Assistant de changement d'agent / modèle / effort d'un thread existant. */
export async function runChangeAgentWizard(orch: OrchestratorApi, thread: ThreadInfo): Promise<ChangeAgentRequest | undefined> {
  const ref = await pickAgentModelEffort(orch, {
    title: `Agent Hub — Changer d'agent — ${thread.title}`,
    current: { agent: thread.agent, model: thread.model, effort: thread.effort },
  });
  if (!ref) return undefined;

  // Autre CLI : la session ne peut pas être reprise telle quelle → choix de la passation.
  let handoffSummary: boolean | undefined;
  if (ref.agent !== thread.agent) {
    const h = await pickHandoff();
    if (!h.ok) return undefined;
    handoffSummary = h.value;
  }

  const message = await vscode.window.showInputBox({
    title: 'Agent Hub — message pour le nouvel agent',
    prompt: 'Message pour le nouvel agent (vide = au prochain message)',
    ignoreFocusOut: true,
  });
  if (message === undefined) return undefined;

  return {
    agent: ref.agent,
    model: ref.model,
    effort: ref.effort,
    handoffSummary,
    message: message.trim() || undefined,
  };
}
