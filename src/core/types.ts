// Types partagés entre core, adaptateurs, MCP et UI.

export type AgentId = 'claude' | 'codex' | 'opencode' | 'agy';
export const AGENT_IDS: readonly AgentId[] = ['claude', 'codex', 'opencode', 'agy'];

export type PermissionMode = 'readonly' | 'edit' | 'full';
export type IsolationMode = 'shared' | 'worktree';
export type CommitPermission = 'deny' | 'ask' | 'allow';

/** Sous-commandes git qui modifient l'état du dépôt. */
export const GIT_MUTATING_COMMANDS = [
  'commit', 'push', 'add', 'reset', 'checkout', 'switch', 'restore', 'stash',
  'rebase', 'merge', 'cherry-pick', 'branch', 'tag', 'clean',
] as const;

/** Sous-commandes git en lecture, toujours autorisées. */
export const GIT_READONLY_COMMANDS = ['status', 'diff', 'log', 'show'] as const;

export interface GitPolicy {
  /** Sous-commandes git interdites à l'agent (toujours au moins GIT_MUTATING_COMMANDS). */
  forbidden: string[];
  /** Rôle de l'agent : un sous-agent ne commite jamais ; le principal passe par l'outil MCP `commit`. */
  role: 'main' | 'sub';
}

export function defaultGitPolicy(role: 'main' | 'sub'): GitPolicy {
  return { forbidden: [...GIT_MUTATING_COMMANDS], role };
}

export type ThreadStatus =
  | 'starting'
  | 'running'
  | 'idle'          // tour terminé, session reprenable (thread principal)
  | 'done'
  | 'error'
  | 'interrupted'
  | 'conflict'
  | 'applied';      // worktree appliqué au workspace

export interface AgentSegment {
  agent: AgentId;
  model?: string;
  effort?: string;
  sessionId?: string;
  /** Horodatage du début de ce segment. */
  since: number;
  /** Comment ce segment a commencé. */
  mode: 'start' | 'resume' | 'handoff';
}

export interface ThreadInfo {
  id: string;
  parentId?: string;            // absent = thread principal
  agent: AgentId;
  model?: string;
  effort?: string;
  permissionMode: PermissionMode;
  isolation: IsolationMode;
  scope?: string[];             // globs relatifs au workspace (mode shared/edit)
  cwd: string;                  // workspace ou chemin du worktree
  worktreePath?: string;
  sessionId?: string;
  title: string;
  status: ThreadStatus;
  createdAt: number;
  updatedAt: number;
  changedFiles: string[];       // chemins relatifs au workspace
  violations: { scope: string[]; commits: { oldHead: string; newHead: string }[] };
  /** Agents successifs du thread (le dernier est l'agent courant) ; absent = jamais changé. */
  agentHistory?: AgentSegment[];
  summary?: string;
  error?: string;
  /** Dernière activité lisible (début de la dernière réponse ou « outil <nom> »), pour les cartes de sous-agents. */
  lastActivity?: string;
  /** Fin du dernier tour (done/error/interrupted), pour la durée affichée. */
  finishedAt?: number;
}
