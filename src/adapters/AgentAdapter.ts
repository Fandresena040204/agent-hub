import type { AgentEvent } from '../core/events';
import type { AgentId, GitPolicy, PermissionMode } from '../core/types';

export interface AgentCapabilities {
  // Modèles : liste découverte via le CLI, ou saisie libre si le CLI ne sait pas les lister
  models: { id: string; label?: string }[] | 'free-text';
  defaultModel?: string;
  // Niveaux d'effort exposés exactement comme le CLI les accepte ; null si le CLI n'en propose pas
  effortLevels: { id: string; label?: string }[] | null;
  defaultEffort?: string;
  /** Efforts propres à certains modèles (ex. variantes OpenCode) ; prioritaire sur effortLevels pour ces modèles. */
  effortLevelsByModel?: Record<string, { id: string; label?: string }[]>;
}

/** Efforts valides pour un modèle donné (liste propre au modèle si connue, sinon liste globale). */
export function effortLevelsFor(caps: AgentCapabilities, model?: string): { id: string; label?: string }[] | null {
  if (model && caps.effortLevelsByModel && model in caps.effortLevelsByModel) {
    const levels = caps.effortLevelsByModel[model];
    return levels.length ? levels : null;
  }
  return caps.effortLevels;
}

export interface StartOptions {
  prompt: string;
  cwd: string;
  model?: string;
  effort?: string;                // doit appartenir à effortLevels, sinon InvalidOptionError
  sessionId?: string;             // reprise de session
  mcpServerUrl?: string;          // agent principal uniquement
  mcpToken?: string;
  permissionMode: PermissionMode;
  allowedPaths?: string[];        // portée d'écriture (globs relatifs à cwd)
  gitPolicy: GitPolicy;
  /** Consigne ajoutée au prompt système (scope, règles git…), construite par l'Orchestrator. */
  systemPromptAppend?: string;
}

export interface AgentRun {
  events: AsyncIterable<AgentEvent>;
  /** Lignes brutes du CLI (stdout/stderr) pour le ThreadStore. */
  onRawLine?: (cb: (stream: 'stdout' | 'stderr', line: string) => void) => void;
  sendMessage(text: string): Promise<void>;
  interrupt(): Promise<void>;
}

/** Session native d'un CLI (hors Agent Hub), importable. */
export interface NativeSession {
  id: string;
  title: string;
  /** Horodatages en ms. */
  createdAt?: number;
  updatedAt: number;
  cwd?: string;
  model?: string;
  messageCount?: number;
}

export interface NativeSessionContent {
  /** Historique converti dans le schéma commun (user_text, assistant_text, tool_call, tool_result, file_changed…). */
  events: { ts: number; event: AgentEvent }[];
  title?: string;
  model?: string;
  effort?: string;
  cwd?: string;
}

export interface AgentAdapter {
  id: AgentId;
  label: string;
  isAvailable(): Promise<{ ok: boolean; detail?: string }>;
  getCapabilities(): Promise<AgentCapabilities>;
  /** Validation propre au CLI (sinon validateOptions sur les capabilities) ; lève InvalidOptionError. */
  validate?(model?: string, effort?: string): Promise<void>;
  start(opts: StartOptions): AgentRun;
  /** Sessions natives du CLI pour ce dossier, les plus récentes d'abord (absent = import non supporté). */
  listSessions?(cwd: string): Promise<NativeSession[]>;
  /** Contenu d'une session native, converti en événements communs. */
  readSession?(sessionId: string, cwd: string): Promise<NativeSessionContent>;
}

/** Erreur levée quand un modèle ou un effort n'est pas valide ; le message liste les valeurs valides. */
export class InvalidOptionError extends Error {
  constructor(public readonly option: 'model' | 'effort', value: string, valid: string[]) {
    super(`${option === 'model' ? 'Modèle' : "Niveau d'effort"} invalide : "${value}". Valeurs valides : ${valid.length ? valid.join(', ') : '(aucune)'}`);
  }
}

/** Valide model/effort contre les capabilities ; lève InvalidOptionError. */
export function validateOptions(caps: AgentCapabilities, model?: string, effort?: string): void {
  if (model && Array.isArray(caps.models) && !caps.models.some((m) => m.id === model)) {
    throw new InvalidOptionError('model', model, caps.models.map((m) => m.id));
  }
  if (effort) {
    const levels = effortLevelsFor(caps, model);
    if (!levels) throw new InvalidOptionError('effort', effort, []);
    if (!levels.some((e) => e.id === effort)) {
      throw new InvalidOptionError('effort', effort, levels.map((e) => e.id));
    }
  }
}
