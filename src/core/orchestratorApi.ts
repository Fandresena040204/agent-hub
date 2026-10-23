// Contrat de l'Orchestrator, partagé par l'UI et le serveur MCP.
import type { AgentCapabilities } from '../adapters/AgentAdapter';
import type { StoredEvent } from './events';
import type { AgentId, CommitPermission, IsolationMode, PermissionMode, ThreadInfo } from './types';

export interface AgentDescriptor {
  id: AgentId;
  label: string;
  available: boolean;
  detail?: string;
  capabilities?: AgentCapabilities;
}

export interface MainThreadRequest {
  agent: AgentId;
  model?: string;
  effort?: string;
  permissionMode: PermissionMode;
  prompt: string;
}

export interface DelegateRequest {
  agent: AgentId;
  model?: string;
  effort?: string;
  prompt: string;
  mode: 'readonly' | 'edit';
  isolation?: IsolationMode;
  scope?: string[];
}

/** Changement d'agent / modèle / effort d'un thread existant (principal ou délégué). */
export interface ChangeAgentRequest {
  agent: AgentId;
  model?: string;
  effort?: string;
  /** Autre CLI seulement : demander d'abord un résumé de passation à l'agent sortant (coûte un tour). */
  handoffSummary?: boolean;
  /** Message envoyé tout de suite au nouvel agent ; sinon le contexte part avec le prochain message. */
  message?: string;
}

export interface ApplyResult {
  status: 'applied' | 'conflict' | 'empty';
  files: string[];
  conflicted: string[];
  detail?: string;
}

export interface CommitRequest {
  /** Thread principal qui demande le commit (reçoit l'événement commit_made). */
  callerThreadId?: string;
  message: string;
  threadIds?: string[];
  paths?: string[];
}

/** Aperçu présenté à l'utilisateur en mode `ask`. */
export interface CommitPreview {
  message: string;
  paths: string[];
  diffSummary: string;
}

export interface ChangedFile {
  /** Chemin relatif au workspace. */
  path: string;
  /** Chemin absolu de la version modifiée (workspace ou worktree). */
  absPath: string;
  status: 'added' | 'modified' | 'deleted';
  /** Lignes ajoutées / supprimées par rapport à la base du thread (undefined pour un fichier binaire). */
  additions?: number;
  deletions?: number;
}

export type Unsubscribe = () => void;

export interface OrchestratorApi {
  readonly workspaceRoot: string;
  readonly isGitRepo: boolean;

  onDidChangeThread(cb: (thread: ThreadInfo) => void): Unsubscribe;
  onDidAppendEvent(cb: (threadId: string, event: StoredEvent) => void): Unsubscribe;

  listAgents(): Promise<AgentDescriptor[]>;
  listThreads(): ThreadInfo[];
  getThread(threadId: string): ThreadInfo | undefined;
  getEvents(threadId: string, lastN?: number): StoredEvent[];

  startMainThread(req: MainThreadRequest): Promise<ThreadInfo>;
  /** Lève une Error au message explicite (modèle/effort invalide, scope en conflit, limite de threads…). */
  delegate(parentId: string, req: DelegateRequest): Promise<ThreadInfo>;
  sendMessage(threadId: string, text: string): Promise<void>;
  /**
   * Change l'agent, le modèle ou l'effort d'un thread inactif, en gardant le même thread
   * (id, historique, threads délégués, jeton MCP). Même CLI : reprise de la session native ;
   * autre CLI : nouvelle session amorcée par un dossier de passation. Lève une Error si le thread est actif.
   */
  changeAgent(threadId: string, req: ChangeAgentRequest): Promise<ThreadInfo>;
  interrupt(threadId: string): Promise<void>;
  waitThread(threadId: string, timeoutSec: number): Promise<ThreadInfo>;

  changedFiles(threadId: string): Promise<ChangedFile[]>;
  /** Contenu de base du fichier pour ce thread (undefined si le fichier n'existait pas). */
  baseContent(threadId: string, relPath: string): Promise<string | undefined>;

  /**
   * Annule les modifications du thread sur ces fichiers (base du thread restaurée ; fichier créé → supprimé).
   * shared : dans le workspace ; worktree : dans le worktree (avant application). Refusé si le thread est actif.
   */
  revertFiles(threadId: string, relPaths: string[]): Promise<void>;

  mergeThread(threadId: string): Promise<ApplyResult>;
  removeWorktree(threadId: string): Promise<void>;

  getCommitPermission(): CommitPermission;
  setCommitPermission(p: CommitPermission): void;
  onDidChangeCommitPermission(cb: (p: CommitPermission) => void): Unsubscribe;
  /** `confirm` est appelé en mode `ask` ; renvoie false = refus sans effet. */
  commit(req: CommitRequest, confirm: (preview: CommitPreview) => Promise<boolean>): Promise<{ sha: string; paths: string[] }>;

  dispose(): Promise<void>;
}
