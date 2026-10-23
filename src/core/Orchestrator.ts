// Orchestrateur : assemble les threads, les adaptateurs, les worktrees et les garde-fous git.
// Aucune dépendance à `vscode` : utilisable dans les tests et le serveur MCP.

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentAdapter, AgentRun, StartOptions } from '../adapters/AgentAdapter';
import { validateOptions } from '../adapters/AgentAdapter';
import type { AgentEvent, AgentRef, StoredEvent } from './events';
import { buildHandoff } from './handoff';
import {
  commitPaths,
  diffSummary,
  filesWithConflictMarkers,
  getHead,
  HeadWatcher,
  mergeInProgress,
  snapshotFiles,
  statusPaths,
} from './GitGuard';
import { git, gitBuffer } from './git';
import { createLogger } from './log';
import type {
  AgentDescriptor,
  ApplyResult,
  ChangeAgentRequest,
  ChangedFile,
  CommitPreview,
  CommitRequest,
  DelegateRequest,
  MainThreadRequest,
  OrchestratorApi,
  Unsubscribe,
} from './orchestratorApi';
import { isInScope } from './scopeGlob';
import { ScopeRegistry } from './ScopeRegistry';
import type { ThreadStore } from './ThreadStore';
import type { AgentId, CommitPermission, IsolationMode, PermissionMode, ThreadInfo, ThreadStatus } from './types';
import { defaultGitPolicy } from './types';
import { Worktrees } from './Worktrees';

const log = createLogger('Orchestrator');

export interface OrchestratorConfig {
  maxActiveThreads: number;
  threadTimeoutSec: number;
  isolationPolicy: 'agent-decides' | 'always-worktree' | 'always-shared';
  includeUncommitted: boolean;
  linkPaths: string[];
  mainAgentCommit: CommitPermission;
  defaults: Partial<Record<AgentId, { model?: string; effort?: string }>>;
}

export interface McpBinding {
  url(): string;
  /** Enregistre un thread principal et renvoie son jeton. */
  registerMainThread(threadId: string): string;
  unregister(threadId: string): void;
}

export interface OrchestratorDeps {
  workspaceRoot: string;
  storageDir: string;
  adapters: Partial<Record<AgentId, AgentAdapter>>;
  store: ThreadStore;
  config: () => OrchestratorConfig;
}

interface ThreadRuntime {
  run?: AgentRun;
  watcher?: HeadWatcher;
  watcherCwd?: string;
  dirtyAtStart: Set<string>;
  snapshot: Map<string, string | undefined>;
  /** HEAD au démarrage (mode shared) : base du diff, même si un commit intervient ensuite. */
  baseHead?: string;
  fileChanged: Set<string>;
  reportedScopeViolations: Set<string>;
  timeout?: ReturnType<typeof setTimeout>;
  interrupting: boolean;
  runToken: number;
  mcpToken?: string;
  /** Dossier de passation à préfixer au prochain message (puis effacé). */
  pendingHandoff?: string;
}

/** Consigne système du thread principal. */
const MAIN_SYSTEM_PROMPT = [
  "Tu es l'agent principal d'AgentHub. Tu disposes des outils MCP agent-hub : list_agents (à appeler AVANT delegate), read_thread, wait_thread, message_thread, merge_thread, commit.",
  "Ne lance JAMAIS git commit, push, reset, rebase, merge, add, checkout, stash, cherry-pick, branch, tag ni clean toi-même.",
  "Tout commit passe par l'outil commit, soumis à la permission de l'utilisateur.",
].join('\n');

/** Consigne système d'un sous-agent. */
function subSystemPrompt(mode: PermissionMode, scope?: string[]): string {
  const parts = [
    "Tu es un sous-agent d'AgentHub. Ne commite pas, ne modifie pas l'état git (commit, add, reset, checkout, stash, rebase, merge, push…) ; l'agent principal s'en charge. Tu ne peux pas déléguer.",
  ];
  if (mode === 'readonly') parts.push('Mode lecture seule : ne modifie aucun fichier.');
  else if (scope && scope.length > 0) parts.push(`Tu ne peux modifier QUE les fichiers correspondant à : ${scope.join(', ')}.`);
  return parts.join('\n');
}

const HANDOFF_PROMPT = [
  '[Agent Hub] Passation : tu vas être remplacé par un autre agent.',
  "Écris un résumé de passation autonome : objectif, état d'avancement, décisions prises,",
  'fichiers concernés, threads délégués et ce qu\'il reste à faire. Ne fais aucune autre action.',
].join(' ');

function isActive(status: ThreadStatus): boolean {
  return status === 'starting' || status === 'running';
}

function normalizeRel(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function titleOf(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').trim().slice(0, 60);
}

function readIfExists(abs: string): string | undefined {
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return undefined;
  }
}

function readBufferIfExists(abs: string): Buffer | undefined {
  try {
    return fs.readFileSync(abs);
  } catch {
    return undefined;
  }
}

function buffersEqual(a: Buffer | undefined, b: Buffer | undefined): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return a.equals(b);
}

interface LineStats {
  additions?: number;
  deletions?: number;
}

/** Lit une sortie `git diff --numstat` (une ligne) ; '-' = fichier binaire. */
function parseNumstat(out: string): LineStats | undefined {
  const line = out.split(/\r?\n/).find((l) => l.trim().length > 0);
  if (!line) return undefined;
  const [added, removed] = line.split('\t');
  if (added === undefined || removed === undefined) return undefined;
  if (added === '-' || removed === '-') return { additions: undefined, deletions: undefined };
  const additions = Number.parseInt(added, 10);
  const deletions = Number.parseInt(removed, 10);
  if (Number.isNaN(additions) || Number.isNaN(deletions)) return undefined;
  return { additions, deletions };
}

interface CreateThreadOptions {
  id: string;
  parentId?: string;
  agent: AgentId;
  model?: string;
  effort?: string;
  permissionMode: PermissionMode;
  isolation: IsolationMode;
  scope?: string[];
  cwd: string;
  title: string;
}

export class Orchestrator implements OrchestratorApi {
  readonly workspaceRoot: string;
  isGitRepo = false;

  private readonly storageDir: string;
  private readonly adapters: Partial<Record<AgentId, AgentAdapter>>;
  private readonly store: ThreadStore;
  private readonly configFn: () => OrchestratorConfig;
  private readonly threads = new Map<string, ThreadInfo>();
  private readonly runtimes = new Map<string, ThreadRuntime>();
  private readonly scopeRegistry = new ScopeRegistry();
  private worktrees?: Worktrees;
  private mcp?: McpBinding;
  private commitPermission: CommitPermission;
  private readonly threadListeners: ((t: ThreadInfo) => void)[] = [];
  private readonly eventListeners: ((id: string, e: StoredEvent) => void)[] = [];
  private readonly permListeners: ((p: CommitPermission) => void)[] = [];
  private fsTimer?: ReturnType<typeof setTimeout>;
  private readonly pendingFs = new Set<string>();

  constructor(deps: OrchestratorDeps) {
    this.workspaceRoot = path.resolve(deps.workspaceRoot);
    this.storageDir = deps.storageDir;
    this.adapters = deps.adapters;
    this.store = deps.store;
    this.configFn = deps.config;
    // Permission de commit : initialisée à la construction (une par session VS Code).
    this.commitPermission = deps.config().mainAgentCommit;
  }

  /** Détecte le dépôt git et recharge les threads persistés. */
  async init(): Promise<void> {
    this.isGitRepo = await Worktrees.isGitRepo(this.workspaceRoot);
    if (this.isGitRepo) this.worktrees = new Worktrees(this.workspaceRoot, this.storageDir);
    for (const info of this.store.loadThreads()) {
      if (isActive(info.status)) {
        info.status = 'interrupted';
        info.updatedAt = Date.now();
        try {
          this.store.saveThread(info);
        } catch (err) {
          log.error(`Échec sauvegarde thread ${info.id} : ${messageOf(err)}`);
        }
      }
      this.threads.set(info.id, info);
    }
  }

  setMcp(binding: McpBinding): void {
    this.mcp = binding;
  }

  /** Appelé par le FileSystemWatcher : vérifie les scopes après un debounce de 1 s. */
  notifyFsChange(absPath: string): void {
    this.pendingFs.add(absPath);
    if (this.fsTimer) return;
    this.fsTimer = setTimeout(() => {
      this.fsTimer = undefined;
      this.pendingFs.clear();
      void this.checkScopes().catch((err: unknown) => log.warn(`Vérification scope : ${messageOf(err)}`));
    }, 1000);
    this.fsTimer.unref?.();
  }

  // ── Abonnements ───────────────────────────────────────────────────────

  onDidChangeThread(cb: (thread: ThreadInfo) => void): Unsubscribe {
    this.threadListeners.push(cb);
    return () => {
      const i = this.threadListeners.indexOf(cb);
      if (i >= 0) this.threadListeners.splice(i, 1);
    };
  }

  onDidAppendEvent(cb: (threadId: string, event: StoredEvent) => void): Unsubscribe {
    this.eventListeners.push(cb);
    return () => {
      const i = this.eventListeners.indexOf(cb);
      if (i >= 0) this.eventListeners.splice(i, 1);
    };
  }

  onDidChangeCommitPermission(cb: (p: CommitPermission) => void): Unsubscribe {
    this.permListeners.push(cb);
    return () => {
      const i = this.permListeners.indexOf(cb);
      if (i >= 0) this.permListeners.splice(i, 1);
    };
  }

  // ── Lecture ──────────────────────────────────────────────────────────

  listThreads(): ThreadInfo[] {
    return [...this.threads.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  getThread(threadId: string): ThreadInfo | undefined {
    return this.threads.get(threadId);
  }

  getEvents(threadId: string, lastN?: number): StoredEvent[] {
    return this.store.loadEvents(threadId, lastN);
  }

  async listAgents(): Promise<AgentDescriptor[]> {
    const entries = Object.entries(this.adapters).filter(
      (e): e is [AgentId, AgentAdapter] => e[1] !== undefined,
    );
    return Promise.all(
      entries.map(async ([id, adapter]) => {
        try {
          const avail = await adapter.isAvailable();
          if (!avail.ok) return { id, label: adapter.label, available: false, detail: avail.detail };
          try {
            const capabilities = await adapter.getCapabilities();
            return { id, label: adapter.label, available: true, detail: avail.detail, capabilities };
          } catch (err) {
            return { id, label: adapter.label, available: false, detail: messageOf(err) };
          }
        } catch (err) {
          return { id, label: adapter.label, available: false, detail: messageOf(err) };
        }
      }),
    );
  }

  // ── Cycle de vie ────────────────────────────────────────────────────

  async startMainThread(req: MainThreadRequest): Promise<ThreadInfo> {
    const adapter = this.adapters[req.agent];
    if (!adapter) throw new Error(`Agent ${req.agent} non configuré.`);
    const avail = await adapter.isAvailable();
    if (!avail.ok) throw new Error(`Agent ${req.agent} indisponible${avail.detail ? ` : ${avail.detail}` : '.'}`);
    const caps = await adapter.getCapabilities();
    const defaults = this.configFn().defaults[req.agent];
    const model = req.model ?? defaults?.model ?? caps.defaultModel;
    const effort = req.effort ?? defaults?.effort ?? caps.defaultEffort;
    if (adapter.validate) await adapter.validate(model, effort);
    else validateOptions(caps, model, effort);

    const thread = this.createThread({
      id: this.newId(),
      agent: req.agent,
      model,
      effort,
      permissionMode: req.permissionMode,
      isolation: 'shared',
      cwd: this.workspaceRoot,
      title: titleOf(req.prompt),
    });
    this.touch(thread);
    this.storeEvent(thread.id, { type: 'user_text', text: req.prompt });

    const rt = this.runtime(thread.id);
    const watcher = new HeadWatcher(this.workspaceRoot);
    if (this.isGitRepo) {
      try {
        await watcher.start();
      } catch (err) {
        log.warn(`HeadWatcher indisponible : ${messageOf(err)}`);
      }
    }
    rt.watcher = watcher;
    rt.watcherCwd = this.workspaceRoot;

    const opts: StartOptions = {
      prompt: req.prompt,
      cwd: this.workspaceRoot,
      model,
      effort,
      permissionMode: req.permissionMode,
      gitPolicy: defaultGitPolicy('main'),
      systemPromptAppend: MAIN_SYSTEM_PROMPT,
    };
    if (this.mcp) {
      const token = this.mcp.registerMainThread(thread.id);
      rt.mcpToken = token;
      opts.mcpServerUrl = this.mcp.url();
      opts.mcpToken = token;
    }
    await this.launch(thread, opts);
    return thread;
  }

  async delegate(parentId: string, req: DelegateRequest): Promise<ThreadInfo> {
    const parent = this.threads.get(parentId);
    if (!parent || parent.parentId !== undefined) {
      throw new Error('Profondeur de délégation maximale atteinte : un sous-agent ne peut pas déléguer.');
    }

    const cfg = this.configFn();
    const active = [...this.threads.values()].filter(
      (t) => t.parentId !== undefined && isActive(t.status),
    );
    if (active.length >= cfg.maxActiveThreads) {
      const list = active.map((t) => `${t.id} (${t.title})`).join(', ');
      throw new Error(`Limite de threads délégués actifs atteinte (${cfg.maxActiveThreads}). Threads actifs : ${list}.`);
    }

    const adapter = this.adapters[req.agent];
    if (!adapter) throw new Error(`Agent ${req.agent} non configuré.`);
    const avail = await adapter.isAvailable();
    if (!avail.ok) throw new Error(`Agent ${req.agent} indisponible${avail.detail ? ` : ${avail.detail}` : '.'}`);

    if (adapter.validate) await adapter.validate(req.model, req.effort);
    else validateOptions(await adapter.getCapabilities(), req.model, req.effort);

    const scope = req.mode === 'readonly'
      ? undefined
      : req.scope && req.scope.length > 0 ? req.scope.map(normalizeRel) : undefined;

    let isolation: IsolationMode;
    if (req.mode === 'readonly') isolation = 'shared';
    else if (cfg.isolationPolicy === 'always-worktree') isolation = 'worktree';
    else if (cfg.isolationPolicy === 'always-shared') isolation = 'shared';
    else isolation = req.isolation ?? ((req.mode === 'edit' && !scope) ? 'worktree' : 'shared');

    let forcedSharedWarning = false;
    if (!this.isGitRepo && isolation === 'worktree') {
      isolation = 'shared';
      forcedSharedWarning = true;
    }

    if (isolation === 'shared' && req.mode === 'edit' && !scope) {
      throw new Error('scope est obligatoire pour mode edit + isolation shared.');
    }

    const thread = this.createThread({
      id: this.newId(),
      parentId,
      agent: req.agent,
      model: req.model,
      effort: req.effort,
      permissionMode: req.mode,
      isolation,
      scope,
      cwd: this.workspaceRoot,
      title: titleOf(req.prompt),
    });

    const rt = this.runtime(thread.id);
    let cwd = this.workspaceRoot;

    // Acquisition du scope AVANT tout démarrage : l'erreur remonte telle quelle.
    if (isolation === 'shared' && req.mode === 'edit' && scope) {
      try {
        this.scopeRegistry.acquire(thread.id, scope);
      } catch (err) {
        this.threads.delete(thread.id);
        throw err;
      }
      try {
        const dirty = await statusPaths(this.workspaceRoot);
        rt.dirtyAtStart = new Set(dirty.map(normalizeRel));
        rt.snapshot = snapshotFiles(this.workspaceRoot, [...rt.dirtyAtStart].filter((p) => isInScope(p, scope)));
        rt.baseHead = await getHead(this.workspaceRoot);
      } catch (err) {
        log.warn(`État initial git indisponible : ${messageOf(err)}`);
      }
    }

    try {
      if (isolation === 'worktree') {
        if (!this.worktrees) throw new Error("Worktree indisponible : le workspace n'est pas un dépôt git.");
        const created = await this.worktrees.create(thread.id, {
          includeUncommitted: cfg.includeUncommitted,
          linkPaths: cfg.linkPaths,
        });
        cwd = created.path;
        thread.worktreePath = created.path;
        thread.cwd = created.path;
        if (created.warning) {
          this.storeEvent(thread.id, {
            type: 'assistant_text',
            text: `[Agent Hub] ${created.warning}`,
            partial: false,
          });
        }
      }
    } catch (err) {
      this.scopeRegistry.release(thread.id);
      this.threads.delete(thread.id);
      throw err;
    }

    this.touch(thread);
    this.storeEvent(thread.id, { type: 'user_text', text: req.prompt });
    if (forcedSharedWarning) {
      this.storeEvent(thread.id, {
        type: 'assistant_text',
        text: "[Agent Hub] Le workspace n'est pas un dépôt git : isolation shared forcée.",
        partial: false,
      });
    }

    const watcher = new HeadWatcher(cwd);
    if (this.isGitRepo) {
      try {
        await watcher.start();
      } catch (err) {
        log.warn(`HeadWatcher indisponible : ${messageOf(err)}`);
      }
    }
    rt.watcher = watcher;
    rt.watcherCwd = cwd;

    const opts: StartOptions = {
      prompt: req.prompt,
      cwd,
      model: req.model,
      effort: req.effort,
      permissionMode: req.mode,
      allowedPaths: isolation === 'shared' && req.mode === 'edit' ? scope : undefined,
      gitPolicy: defaultGitPolicy('sub'),
      systemPromptAppend: subSystemPrompt(req.mode, scope),
    };
    await this.launch(thread, opts);
    return thread;
  }

  async sendMessage(threadId: string, text: string): Promise<void> {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`Thread introuvable : ${threadId}`);
    const rt = this.runtime(threadId);

    // Dossier de passation : préfixé au premier message suivant un changement d'agent.
    if (rt.pendingHandoff) {
      text = `${rt.pendingHandoff}\n\n${text}`;
      rt.pendingHandoff = undefined;
    }

    if (rt.run) {
      thread.status = 'running';
      thread.error = undefined;
      this.touch(thread);
      await rt.run.sendMessage(text);
      return;
    }

    const adapter = this.adapters[thread.agent];
    if (!adapter) throw new Error(`Agent ${thread.agent} non configuré.`);

    // Reprise : le scope doit être réacquis et l'état de départ recalculé.
    if (thread.isolation === 'shared' && thread.permissionMode === 'edit' && thread.scope?.length) {
      this.scopeRegistry.acquire(threadId, thread.scope);
      try {
        const dirty = await statusPaths(this.workspaceRoot);
        rt.dirtyAtStart = new Set(dirty.map(normalizeRel));
        rt.snapshot = snapshotFiles(this.workspaceRoot, [...rt.dirtyAtStart].filter((p) => isInScope(p, thread.scope!)));
        rt.baseHead ??= await getHead(this.workspaceRoot);
      } catch (err) {
        log.warn(`État initial git indisponible : ${messageOf(err)}`);
      }
    }
    rt.reportedScopeViolations.clear();
    rt.fileChanged.clear();

    thread.status = 'running';
    thread.error = undefined;
    this.touch(thread);
    // Le prompt de reprise n'est pas émis par l'adaptateur : on l'enregistre ici.
    this.storeEvent(threadId, { type: 'user_text', text });

    const opts: StartOptions = {
      prompt: text,
      cwd: thread.cwd,
      model: thread.model,
      effort: thread.effort,
      sessionId: thread.sessionId,
      permissionMode: thread.permissionMode,
      allowedPaths: thread.isolation === 'shared' && thread.permissionMode === 'edit' ? thread.scope : undefined,
      gitPolicy: defaultGitPolicy(thread.parentId ? 'sub' : 'main'),
      systemPromptAppend: thread.parentId
        ? subSystemPrompt(thread.permissionMode, thread.scope)
        : MAIN_SYSTEM_PROMPT,
    };
    if (!thread.parentId && this.mcp) {
      const token = this.mcp.registerMainThread(threadId);
      rt.mcpToken = token;
      opts.mcpServerUrl = this.mcp.url();
      opts.mcpToken = token;
    }
    await this.launch(thread, opts);
  }

  /**
   * Change l'agent, le modèle ou l'effort d'un thread inactif en conservant le même thread.
   * Même CLI : reprise de la session native ; autre CLI : nouvelle session + dossier de passation.
   */
  async changeAgent(threadId: string, req: ChangeAgentRequest): Promise<ThreadInfo> {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`Thread introuvable : ${threadId}`);
    if (isActive(thread.status)) {
      throw new Error(
        `Le thread ${threadId} est en cours : interrompez-le ou attendez la fin du tour avant de changer d'agent.`,
      );
    }

    const adapter = this.adapters[req.agent];
    if (!adapter) throw new Error(`Agent ${req.agent} non configuré.`);
    const avail = await adapter.isAvailable();
    if (!avail.ok) throw new Error(`Agent ${req.agent} indisponible${avail.detail ? ` : ${avail.detail}` : '.'}`);

    // Même CLI : ce qui n'est pas précisé reste tel quel ; autre CLI : défauts des réglages.
    const defaults = req.agent === thread.agent
      ? { model: thread.model, effort: thread.effort }
      : this.configFn().defaults[req.agent];
    const model = req.model ?? defaults?.model;
    const effort = req.effort ?? defaults?.effort;
    if (adapter.validate) await adapter.validate(model, effort);
    else validateOptions(await adapter.getCapabilities(), model, effort);

    const from: AgentRef = { agent: thread.agent, model: thread.model, effort: thread.effort };
    const to: AgentRef = { agent: req.agent, model, effort };
    if (from.agent === to.agent && from.model === to.model && from.effort === to.effort) {
      throw new Error(
        `Aucun changement : le thread ${threadId} utilise déjà ${from.agent}${from.model ? `/${from.model}` : ''}${from.effort ? `#${from.effort}` : ''}.`,
      );
    }

    if (!thread.agentHistory?.length) {
      thread.agentHistory = [{
        ...from,
        sessionId: thread.sessionId,
        since: thread.createdAt,
        mode: 'start',
      }];
    }

    const rt = this.runtime(threadId);
    const sameCli = req.agent === thread.agent;
    const mode: 'resume' | 'handoff' = sameCli ? 'resume' : 'handoff';

    // Un run résiduel (thread déjà marqué inactif) ne doit pas recevoir le tour de passation.
    await this.closeIdleRun(threadId);

    let summary: string | undefined;
    // Un résumé n'a de sens que si l'ancien agent a une session à reprendre.
    if (!sameCli && req.handoffSummary && thread.sessionId) {
      summary = await this.summarizeForHandoff(threadId);
      // Le tour de résumé vient de se terminer : ferme son run avant le nouvel agent.
      await this.closeIdleRun(threadId);
    }

    if (sameCli) {
      // La session native reste valide : prochaine reprise avec le nouveau modèle/effort.
      thread.model = model;
      thread.effort = effort;
    } else {
      thread.agent = req.agent;
      thread.model = model;
      thread.effort = effort;
      thread.sessionId = undefined;

      let uncommitted: string[] = [];
      if (this.isGitRepo) {
        try {
          uncommitted = (await statusPaths(this.workspaceRoot)).map(normalizeRel);
        } catch (err) {
          log.warn(`statusPaths pour la passation : ${messageOf(err)}`);
        }
      }
      const children = [...this.threads.values()].filter((t) => t.parentId === threadId);
      rt.pendingHandoff = buildHandoff({
        // En-tête : l'agent qui sort, pas celui qui arrive.
        thread: { ...thread, agent: from.agent, model: from.model },
        events: this.getEvents(threadId),
        children,
        uncommitted,
        commitPermission: this.commitPermission,
        summary,
      });
    }

    thread.agentHistory = [
      ...(thread.agentHistory ?? []),
      { ...to, since: Date.now(), mode },
    ];
    // Le nouveau couple agent/modèle repart d'un état propre, même après un résumé en échec.
    if (thread.status === 'error') {
      thread.status = thread.parentId ? 'done' : 'idle';
      thread.error = undefined;
    }
    this.storeEvent(threadId, { type: 'agent_switched', from, to, mode });
    this.touch(thread);

    if (req.message) await this.sendMessage(threadId, req.message);
    return thread;
  }

  /** Demande un résumé de passation à l'agent sortant ; renvoie undefined si indisponible. */
  private async summarizeForHandoff(threadId: string): Promise<string | undefined> {
    const before = this.getEvents(threadId).length;
    let reason: string | undefined;
    try {
      await this.sendMessage(threadId, HANDOFF_PROMPT);
      const done = await this.waitThread(threadId, 600);
      if (isActive(done.status)) reason = 'délai dépassé';
    } catch (err) {
      reason = messageOf(err);
    }
    const after = this.getEvents(threadId).slice(before);
    for (let i = after.length - 1; i >= 0; i--) {
      const event = after[i].event;
      if (event.type === 'assistant_text' && !event.partial && event.text.trim()) {
        return event.text.trim();
      }
    }
    this.storeEvent(threadId, {
      type: 'assistant_text',
      text: `[Agent Hub] Résumé de passation indisponible : ${reason ?? 'aucun résumé produit'} ; passation par extrait.`,
      partial: false,
    });
    return undefined;
  }

  /** Ferme le run en mémoire d'un thread inactif (aucun tour en cours à tuer). */
  private async closeIdleRun(threadId: string): Promise<void> {
    const rt = this.runtime(threadId);
    const run = rt.run;
    rt.run = undefined;
    rt.runToken += 1;
    if (!run) return;
    try {
      await run.interrupt();
    } catch (err) {
      log.warn(`Fermeture du run ${threadId} : ${messageOf(err)}`);
    }
  }

  async interrupt(threadId: string): Promise<void> {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`Thread introuvable : ${threadId}`);
    const rt = this.runtime(threadId);
    rt.interrupting = true;
    this.clearThreadTimeout(rt);
    const run = rt.run;
    rt.run = undefined;
    rt.runToken += 1;
    if (run) {
      try {
        await run.interrupt();
      } catch (err) {
        log.warn(`Interruption du run ${threadId} : ${messageOf(err)}`);
      }
    }
    if (isActive(thread.status)) {
      thread.status = 'interrupted';
      this.scopeRegistry.release(threadId);
    }
    this.touch(thread);
  }

  waitThread(threadId: string, timeoutSec: number): Promise<ThreadInfo> {
    const thread = this.threads.get(threadId);
    if (!thread) return Promise.reject(new Error(`Thread introuvable : ${threadId}`));
    if (!isActive(thread.status)) return Promise.resolve(thread);
    return new Promise<ThreadInfo>((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout>;
      const unsub = this.onDidChangeThread((t) => {
        if (done || t.id !== threadId || isActive(t.status)) return;
        done = true;
        clearTimeout(timer);
        unsub();
        resolve(this.threads.get(threadId) ?? t);
      });
      timer = setTimeout(() => {
        if (done) return;
        done = true;
        unsub();
        resolve(this.threads.get(threadId) ?? thread);
      }, Math.max(0, timeoutSec) * 1000);
      timer.unref?.();
    });
  }

  async dispose(): Promise<void> {
    if (this.fsTimer) {
      clearTimeout(this.fsTimer);
      this.fsTimer = undefined;
    }
    const waits: Promise<void>[] = [];
    for (const [id, rt] of this.runtimes) {
      this.clearThreadTimeout(rt);
      const run = rt.run;
      rt.run = undefined;
      rt.interrupting = true;
      rt.runToken += 1;
      if (run) {
        waits.push(
          run.interrupt().catch((err: unknown) => log.warn(`Interruption ${id} : ${messageOf(err)}`)),
        );
      }
      if (rt.mcpToken && this.mcp) {
        try {
          this.mcp.unregister(id);
        } catch (err) {
          log.warn(`Désenregistrement MCP ${id} : ${messageOf(err)}`);
        }
        rt.mcpToken = undefined;
      }
    }
    await Promise.all(waits);
  }

  // ── Exécution d'un run ──────────────────────────────────────────────

  private async launch(thread: ThreadInfo, opts: StartOptions): Promise<void> {
    const adapter = this.adapters[thread.agent];
    if (!adapter) {
      await this.handleEvent(thread.id, { type: 'error', message: `Agent ${thread.agent} non configuré.` });
      return;
    }
    const rt = this.runtime(thread.id);
    rt.interrupting = false;
    let run: AgentRun;
    try {
      run = adapter.start(opts);
    } catch (err) {
      await this.handleEvent(thread.id, { type: 'error', message: `Démarrage impossible : ${messageOf(err)}` });
      return;
    }
    rt.run = run;
    const token = ++rt.runToken;
    run.onRawLine?.((stream, line) => {
      try {
        this.store.appendRaw(thread.id, { ts: Date.now(), stream, line });
      } catch (err) {
        log.warn(`Échec append raw ${thread.id} : ${messageOf(err)}`);
      }
    });
    void this.consume(thread.id, run, token);
    this.armTimeout(thread);
  }

  private async consume(threadId: string, run: AgentRun, token: number): Promise<void> {
    const rt = this.runtime(threadId);
    try {
      for await (const event of run.events) {
        if (rt.runToken !== token) break;
        await this.handleEvent(threadId, event);
      }
    } catch (err) {
      if (rt.runToken === token) {
        await this.handleEvent(threadId, { type: 'error', message: messageOf(err) });
      }
    } finally {
      if (rt.runToken === token) {
        rt.run = undefined;
        this.finishRun(threadId);
      }
    }
  }

  private finishRun(threadId: string): void {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    const rt = this.runtime(threadId);
    this.clearThreadTimeout(rt);
    if (rt.interrupting) {
      rt.interrupting = false;
      return;
    }
    if (isActive(thread.status)) {
      thread.status = thread.parentId ? 'done' : 'idle';
      this.scopeRegistry.release(threadId);
      this.touch(thread);
    }
  }

  private async handleEvent(threadId: string, event: AgentEvent): Promise<void> {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    const rt = this.runtime(threadId);
    if (thread.status === 'starting') thread.status = 'running';

    let newViolations: string[] = [];
    switch (event.type) {
      case 'session_started':
        thread.sessionId = event.sessionId;
        if (thread.agentHistory?.length) {
          thread.agentHistory[thread.agentHistory.length - 1].sessionId = event.sessionId;
        }
        break;
      case 'assistant_text':
        if (!event.partial && event.text.trim()) thread.summary = event.text.trim();
        break;
      case 'file_changed':
        newViolations = this.applyFileChanged(thread, rt, event.path);
        break;
      case 'scope_violation':
        this.addScopeViolation(thread, event.path);
        break;
      case 'commit_violation':
        this.addCommitViolation(thread, event.oldHead, event.newHead);
        break;
      case 'done':
        thread.status = thread.parentId ? 'done' : 'idle';
        thread.summary = event.summary;
        this.clearThreadTimeout(rt);
        break;
      case 'error':
        thread.status = 'error';
        thread.error = event.message;
        this.clearThreadTimeout(rt);
        break;
      default:
        break;
    }

    this.storeEvent(threadId, event);
    for (const rel of newViolations) this.emitScopeViolation(thread, rel);

    if (event.type === 'tool_result' || event.type === 'done') {
      await this.checkHead(thread, rt);
      if (thread.isolation === 'shared' && thread.permissionMode === 'edit' && thread.scope?.length) {
        await this.checkScopes(thread.id);
      }
    }
    if (event.type === 'done' || event.type === 'error') {
      this.scopeRegistry.release(threadId);
    }
    if (event.type === 'done') {
      try {
        await this.changedFiles(threadId);
      } catch (err) {
        log.warn(`changedFiles(${threadId}) : ${messageOf(err)}`);
      }
    }
    this.touch(thread);
  }

  // ── Fichiers modifiés et diff ───────────────────────────────────────

  async changedFiles(threadId: string): Promise<ChangedFile[]> {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`Thread introuvable : ${threadId}`);
    const files = thread.isolation === 'worktree'
      ? await this.worktreeChanged(thread)
      : await this.sharedChanged(thread);
    thread.changedFiles = files.map((f) => f.path);
    return files;
  }

  async baseContent(threadId: string, relPath: string): Promise<string | undefined> {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`Thread introuvable : ${threadId}`);
    const rel = normalizeRel(relPath);
    if (thread.isolation === 'worktree') {
      if (!this.worktrees || !this.worktrees.exists(thread.id)) return undefined;
      try {
        return await this.worktrees.fileAtBase(thread.id, rel);
      } catch (err) {
        log.warn(`fileAtBase(${threadId}, ${rel}) : ${messageOf(err)}`);
        return undefined;
      }
    }
    if (thread.permissionMode === 'readonly') return undefined;
    return this.baseFor(this.runtime(thread.id), rel);
  }

  /**
   * Annule les modifications du thread sur ces fichiers.
   * shared : dans le workspace ; worktree non appliqué : dans le worktree ;
   * worktree appliqué : dans le workspace avec la base de départ du worktree.
   * Ne touche jamais à l'index ni aux commits.
   */
  async revertFiles(threadId: string, relPaths: string[]): Promise<void> {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`Thread introuvable : ${threadId}`);
    if (isActive(thread.status)) {
      throw new Error(
        `Le thread ${threadId} est en cours : interrompez-le avant d'annuler des modifications.`,
      );
    }

    const known = new Set((await this.changedFiles(threadId)).map((f) => f.path));
    const rels: string[] = [];
    for (const raw of relPaths) {
      const rel = normalizeRel(raw);
      if (!rel || rel === '.' || rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`Chemin hors du workspace : ${raw}.`);
      }
      if (!known.has(rel)) throw new Error(`${rel} n'a pas été modifié par ce thread.`);
      if (!rels.includes(rel)) rels.push(rel);
    }
    if (rels.length === 0) return;

    if (thread.isolation === 'worktree' && thread.status !== 'applied') {
      if (!this.worktrees || !this.worktrees.exists(thread.id)) {
        throw new Error(`Worktree introuvable pour le thread ${threadId} : impossible d'annuler.`);
      }
      for (const rel of rels) await this.worktrees.restoreFile(thread.id, rel);
    } else {
      for (const rel of rels) {
        const base = thread.isolation === 'worktree'
          ? await this.worktreeBaseBytes(thread, rel)
          : await this.baseBytesFor(this.runtime(thread.id), rel);
        this.writeWorkspaceFile(rel, base);
      }
    }

    this.storeEvent(threadId, {
      type: 'assistant_text',
      text: `[Agent Hub] Modifications annulées : ${rels.join(', ')}`,
      partial: false,
    });
    try {
      await this.changedFiles(threadId);
    } catch (err) {
      log.warn(`changedFiles(${threadId}) : ${messageOf(err)}`);
    }
    this.touch(thread);
  }

  /** Base de départ du worktree en octets (repli sur la base du workspace si le worktree a été supprimé). */
  private async worktreeBaseBytes(thread: ThreadInfo, rel: string): Promise<Buffer | undefined> {
    if (this.worktrees && this.worktrees.exists(thread.id)) {
      try {
        return await this.worktrees.fileAtBaseBuffer(thread.id, rel);
      } catch (err) {
        log.warn(`fileAtBaseBuffer(${thread.id}, ${rel}) : ${messageOf(err)}`);
      }
    }
    return this.baseBytesFor(this.runtime(thread.id), rel);
  }

  /** Réécrit (ou supprime) un fichier du workspace sans toucher à l'index. */
  private writeWorkspaceFile(rel: string, content: Buffer | undefined): void {
    const abs = path.join(this.workspaceRoot, rel);
    if (content === undefined) {
      try {
        fs.unlinkSync(abs);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      return;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  // ── Worktrees ───────────────────────────────────────────────────────

  async mergeThread(threadId: string): Promise<ApplyResult> {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`Thread introuvable : ${threadId}`);
    if (thread.isolation !== 'worktree') {
      throw new Error(`Le thread ${threadId} n'est pas en isolation worktree.`);
    }
    if (isActive(thread.status)) {
      throw new Error(`Le thread ${threadId} est encore actif : attendez la fin (wait_thread).`);
    }
    if (!this.worktrees) throw new Error("Application impossible : le workspace n'est pas un dépôt git.");

    const result = await this.worktrees.apply(threadId);
    thread.status = result.status === 'conflict' ? 'conflict' : 'applied';
    if (result.status === 'conflict') {
      const detail = result.conflicted.length > 0 ? result.conflicted : [result.detail ?? 'inconnus'];
      this.storeEvent(threadId, {
        type: 'assistant_text',
        text: `[Agent Hub] Conflits lors de l'application : ${detail.join(', ')}`,
        partial: false,
      });
    } else {
      this.storeEvent(threadId, {
        type: 'assistant_text',
        text: `[Agent Hub] Appliqué au workspace (non commité) : ${result.files.length > 0 ? result.files.join(', ') : '(aucun fichier)'}`,
        partial: false,
      });
    }
    try {
      await this.changedFiles(threadId);
    } catch (err) {
      log.warn(`changedFiles(${threadId}) : ${messageOf(err)}`);
    }
    this.touch(thread);
    return result;
  }

  async removeWorktree(threadId: string): Promise<void> {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`Thread introuvable : ${threadId}`);
    if (isActive(thread.status)) {
      throw new Error(`Le thread ${threadId} est encore actif : attendez la fin (wait_thread).`);
    }
    if (this.worktrees) await this.worktrees.remove(threadId);
    thread.worktreePath = undefined;
    thread.cwd = this.workspaceRoot;
    this.touch(thread);
  }

  // ── Commit ──────────────────────────────────────────────────────────

  getCommitPermission(): CommitPermission {
    return this.commitPermission;
  }

  setCommitPermission(p: CommitPermission): void {
    if (this.commitPermission === p) return;
    this.commitPermission = p;
    for (const cb of this.permListeners) {
      try {
        cb(p);
      } catch (err) {
        log.warn(`Callback permission : ${messageOf(err)}`);
      }
    }
  }

  async commit(
    req: CommitRequest,
    confirm: (preview: CommitPreview) => Promise<boolean>,
  ): Promise<{ sha: string; paths: string[] }> {
    if (!this.isGitRepo) {
      throw new Error("Commit indisponible : le workspace n'est pas un dépôt git.");
    }
    if (this.commitPermission === 'deny') {
      throw new Error(
        "Commit refusé : la permission de commit est sur « off » (agentHub.git.mainAgentCommit = deny). L'utilisateur peut la changer via la barre d'état « Commits ».",
      );
    }
    if (!req.threadIds?.length && !req.paths?.length) {
      throw new Error('Commit refusé : indiquez au moins un thread (threadIds) ou des fichiers (paths).');
    }

    const paths = new Set<string>();
    for (const tid of req.threadIds ?? []) {
      const thread = this.threads.get(tid);
      if (!thread) throw new Error(`Thread introuvable : ${tid}.`);
      if (req.callerThreadId && thread.parentId !== req.callerThreadId) {
        throw new Error(`Le thread ${tid} n'est pas un thread délégué par ${req.callerThreadId}.`);
      }
      if (isActive(thread.status)) {
        throw new Error(
          `Le thread ${tid} (${thread.title}) est encore actif : appelez wait_thread ou interrupt_thread avant de commiter.`,
        );
      }
      if (thread.isolation === 'worktree' && thread.status !== 'applied') {
        throw new Error(
          `Le thread ${tid} est en mode worktree et n'a pas été appliqué : appelez merge_thread d'abord.`,
        );
      }
      for (const f of await this.changedFiles(tid)) paths.add(f.path);
    }

    for (const raw of req.paths ?? []) {
      const rel = normalizeRel(
        path.isAbsolute(raw) ? path.relative(this.workspaceRoot, raw) : raw,
      );
      if (!rel || rel === '.' || rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`Chemin hors du workspace : ${raw}.`);
      }
      const owner = this.scopeRegistry.ownerOf(rel);
      if (owner) {
        const other = this.threads.get(owner);
        if (other && isActive(other.status)) {
          throw new Error(
            `Le chemin ${rel} appartient au thread ${owner} (${other.title}) encore actif : appelez wait_thread ou interrupt_thread avant de commiter.`,
          );
        }
      }
      paths.add(rel);
    }

    if (await mergeInProgress(this.workspaceRoot)) {
      throw new Error('Commit refusé : une fusion ou un rebase est en cours dans le workspace.');
    }
    const list = [...paths];
    const conflicted = await filesWithConflictMarkers(this.workspaceRoot, list);
    if (conflicted.length > 0) {
      throw new Error(`Commit refusé : marqueurs de conflit dans ${conflicted.join(', ')}.`);
    }
    if (list.length === 0) throw new Error('Aucun fichier à commiter.');

    if (this.commitPermission === 'ask') {
      const ok = await confirm({
        message: req.message,
        paths: list,
        diffSummary: await diffSummary(this.workspaceRoot, list),
      });
      if (!ok) throw new Error("Commit refusé par l'utilisateur.");
    }

    const { sha } = await commitPaths(this.workspaceRoot, list, req.message);
    // HEAD complet : commitPaths ne renvoie qu'un SHA court.
    const head = (await getHead(this.workspaceRoot)) ?? sha;
    this.acknowledgeWorkspace(head);
    if (req.callerThreadId) {
      const caller = this.threads.get(req.callerThreadId);
      if (caller) {
        this.storeEvent(caller.id, { type: 'commit_made', sha: head, message: req.message, paths: list });
        this.touch(caller);
      }
    }
    return { sha: head, paths: list };
  }

  // ── Helpers internes ────────────────────────────────────────────────

  private createThread(o: CreateThreadOptions): ThreadInfo {
    const now = Date.now();
    const thread: ThreadInfo = {
      id: o.id,
      parentId: o.parentId,
      agent: o.agent,
      model: o.model,
      effort: o.effort,
      permissionMode: o.permissionMode,
      isolation: o.isolation,
      scope: o.scope,
      cwd: o.cwd,
      title: o.title,
      status: 'starting',
      createdAt: now,
      updatedAt: now,
      changedFiles: [],
      violations: { scope: [], commits: [] },
    };
    this.threads.set(thread.id, thread);
    return thread;
  }

  private newId(): string {
    let id = randomUUID().slice(0, 8);
    while (this.threads.has(id)) id = randomUUID().slice(0, 8);
    return id;
  }

  private runtime(id: string): ThreadRuntime {
    let rt = this.runtimes.get(id);
    if (!rt) {
      rt = {
        dirtyAtStart: new Set(),
        snapshot: new Map(),
        fileChanged: new Set(),
        reportedScopeViolations: new Set(),
        interrupting: false,
        runToken: 0,
      };
      this.runtimes.set(id, rt);
    }
    return rt;
  }

  private touch(thread: ThreadInfo): void {
    thread.updatedAt = Date.now();
    try {
      this.store.saveThread(thread);
    } catch (err) {
      log.error(`Échec sauvegarde thread ${thread.id} : ${messageOf(err)}`);
    }
    for (const cb of this.threadListeners) {
      try {
        cb(thread);
      } catch (err) {
        log.warn(`Callback thread : ${messageOf(err)}`);
      }
    }
  }

  private storeEvent(threadId: string, event: AgentEvent): StoredEvent {
    const stored: StoredEvent = { ts: Date.now(), event };
    try {
      this.store.appendEvent(threadId, stored);
    } catch (err) {
      log.error(`Échec append event ${threadId} : ${messageOf(err)}`);
    }
    for (const cb of this.eventListeners) {
      try {
        cb(threadId, stored);
      } catch (err) {
        log.warn(`Callback event : ${messageOf(err)}`);
      }
    }
    return stored;
  }

  private armTimeout(thread: ThreadInfo): void {
    if (!thread.parentId) return;
    const sec = this.configFn().threadTimeoutSec;
    if (!sec || sec <= 0) return;
    const rt = this.runtime(thread.id);
    this.clearThreadTimeout(rt);
    rt.timeout = setTimeout(() => {
      void this.onTimeout(thread.id);
    }, sec * 1000);
    rt.timeout.unref?.();
  }

  private clearThreadTimeout(rt: ThreadRuntime): void {
    if (rt.timeout) {
      clearTimeout(rt.timeout);
      rt.timeout = undefined;
    }
  }

  private async onTimeout(threadId: string): Promise<void> {
    const thread = this.threads.get(threadId);
    if (!thread || !isActive(thread.status)) return;
    const rt = this.runtime(threadId);
    rt.interrupting = true;
    this.clearThreadTimeout(rt);
    const run = rt.run;
    rt.run = undefined;
    rt.runToken += 1;
    if (run) {
      try {
        await run.interrupt();
      } catch (err) {
        log.warn(`Interruption ${threadId} : ${messageOf(err)}`);
      }
    }
    await this.handleEvent(threadId, { type: 'error', message: 'Délai dépassé' });
  }

  private toRel(thread: ThreadInfo, rawPath: string): string {
    const abs = path.isAbsolute(rawPath) ? rawPath : path.resolve(thread.cwd, rawPath);
    return normalizeRel(path.relative(this.workspaceRoot, abs));
  }

  /** Applique un `file_changed` ; renvoie les chemins hors scope à signaler. */
  private applyFileChanged(thread: ThreadInfo, rt: ThreadRuntime, rawPath: string): string[] {
    if (thread.isolation !== 'shared') return [];
    const rel = this.toRel(thread, rawPath);
    if (!rel || rel === '.' || rel.startsWith('../') || path.isAbsolute(rel)) return [];
    if (rel === '.git' || rel.startsWith('.git/')) return [];
    if (thread.scope?.length && !isInScope(rel, thread.scope)) {
      if (rt.reportedScopeViolations.has(rel)) return [];
      rt.reportedScopeViolations.add(rel);
      return [rel];
    }
    rt.fileChanged.add(rel);
    if (!thread.changedFiles.includes(rel)) thread.changedFiles.push(rel);
    return [];
  }

  private addScopeViolation(thread: ThreadInfo, rel: string): void {
    const p = normalizeRel(rel);
    if (!thread.violations.scope.includes(p)) thread.violations.scope.push(p);
  }

  private emitScopeViolation(thread: ThreadInfo, rel: string): void {
    this.addScopeViolation(thread, rel);
    this.storeEvent(thread.id, { type: 'scope_violation', path: rel });
  }

  private addCommitViolation(thread: ThreadInfo, oldHead: string, newHead: string): void {
    thread.violations.commits.push({ oldHead, newHead });
  }

  private async checkHead(thread: ThreadInfo, rt: ThreadRuntime): Promise<void> {
    if (!rt.watcher) return;
    try {
      const change = await rt.watcher.check();
      if (!change) return;
      this.addCommitViolation(thread, change.oldHead, change.newHead);
      this.storeEvent(thread.id, {
        type: 'commit_violation',
        oldHead: change.oldHead,
        newHead: change.newHead,
      });
    } catch (err) {
      log.warn(`HeadWatcher(${thread.id}) : ${messageOf(err)}`);
    }
  }

  /**
   * Vérifie les modifications apparues hors scope depuis le démarrage.
   * Attribution uniquement s'il n'y a qu'un seul thread délégué shared/edit et que le principal est au repos.
   */
  private async checkScopes(preferredId?: string): Promise<void> {
    if (!this.isGitRepo) return;
    const sharedEdit = (t: ThreadInfo): boolean =>
      t.parentId !== undefined &&
      t.isolation === 'shared' &&
      t.permissionMode === 'edit' &&
      (t.scope?.length ?? 0) > 0;
    const mainRunning = [...this.threads.values()].some(
      (t) => t.parentId === undefined && isActive(t.status),
    );
    if (mainRunning) return;
    const candidates = [...this.threads.values()].filter(
      (t) => sharedEdit(t) && (isActive(t.status) || t.id === preferredId),
    );
    if (candidates.length !== 1) return;
    const target = candidates[0];
    const rt = this.runtime(target.id);
    let current: string[];
    try {
      current = await statusPaths(this.workspaceRoot);
    } catch (err) {
      log.warn(`statusPaths : ${messageOf(err)}`);
      return;
    }
    for (const raw of current) {
      const rel = normalizeRel(raw);
      if (!rel || rel === '.git' || rel.startsWith('.git/')) continue;
      if (rt.dirtyAtStart.has(rel)) continue;
      if (isInScope(rel, target.scope!)) continue;
      if (this.ownedByOtherActive(rel, target.id)) continue;
      if (rt.reportedScopeViolations.has(rel)) continue;
      rt.reportedScopeViolations.add(rel);
      this.emitScopeViolation(target, rel);
    }
    this.touch(target);
  }

  private ownedByOtherActive(rel: string, exceptId: string): boolean {
    for (const t of this.threads.values()) {
      if (t.id === exceptId || !t.scope?.length || !isActive(t.status)) continue;
      if (isInScope(rel, t.scope)) return true;
    }
    return false;
  }

  private async worktreeChanged(thread: ThreadInfo): Promise<ChangedFile[]> {
    const wtPath = thread.worktreePath ?? (this.worktrees ? this.worktrees.path(thread.id) : undefined);
    if (!this.worktrees || !wtPath || !this.worktrees.exists(thread.id)) {
      return thread.changedFiles.map((p) => {
        const abs = path.join(this.workspaceRoot, p);
        return {
          path: p,
          absPath: abs,
          status: fs.existsSync(abs) ? 'modified' : 'deleted',
        } as ChangedFile;
      });
    }
    let rels: string[];
    try {
      rels = await this.worktrees.changedFiles(thread.id);
    } catch (err) {
      log.warn(`changedFiles worktree ${thread.id} : ${messageOf(err)}`);
      return [];
    }
    let stats = new Map<string, LineStats>();
    try {
      stats = await this.worktrees.numstat(thread.id);
    } catch (err) {
      // Worktree supprimé ou illisible : pas de statistiques.
      log.warn(`numstat worktree ${thread.id} : ${messageOf(err)}`);
    }
    const out: ChangedFile[] = [];
    for (const raw of rels) {
      const rel = normalizeRel(raw);
      const abs = path.join(wtPath, rel);
      let base: string | undefined;
      try {
        base = await this.worktrees.fileAtBase(thread.id, rel);
      } catch {
        base = undefined;
      }
      const status: ChangedFile['status'] = !fs.existsSync(abs)
        ? 'deleted'
        : base === undefined
          ? 'added'
          : 'modified';
      const file: ChangedFile = { path: rel, absPath: abs, status };
      const lineStats = stats.get(rel);
      if (lineStats) {
        file.additions = lineStats.additions;
        file.deletions = lineStats.deletions;
      }
      out.push(file);
    }
    return out;
  }

  private async sharedChanged(thread: ThreadInfo): Promise<ChangedFile[]> {
    if (thread.permissionMode === 'readonly') return [];
    const scope = thread.scope ?? [];
    if (scope.length === 0) return [];
    const rt = this.runtime(thread.id);
    const candidates = new Set<string>(rt.fileChanged);
    if (this.isGitRepo) {
      try {
        for (const raw of await statusPaths(this.workspaceRoot)) {
          const rel = normalizeRel(raw);
          if (isInScope(rel, scope)) candidates.add(rel);
        }
        // Fichiers du scope déjà commités depuis le démarrage du thread.
        if (rt.baseHead) {
          const committed = await git(this.workspaceRoot, ['diff', '--name-only', rt.baseHead, 'HEAD'], { allowFail: true });
          for (const raw of committed.stdout.split(/\r?\n/).filter(Boolean)) {
            const rel = normalizeRel(raw);
            if (isInScope(rel, scope)) candidates.add(rel);
          }
        }
      } catch (err) {
        log.warn(`statusPaths : ${messageOf(err)}`);
      }
    }
    const out: ChangedFile[] = [];
    for (const rel of candidates) {
      const abs = path.join(this.workspaceRoot, rel);
      const current = readIfExists(abs);
      const base = await this.baseFor(rt, rel);
      if (current === base) continue;
      out.push({
        path: rel,
        absPath: abs,
        status: base === undefined ? 'added' : current === undefined ? 'deleted' : 'modified',
      });
    }
    out.sort((a, b) => a.path.localeCompare(b.path));
    if (out.length > 0) {
      try {
        const stats = await this.numstatShared(rt, out.map((f) => f.path));
        for (const file of out) {
          const lineStats = stats.get(file.path);
          if (!lineStats) continue;
          file.additions = lineStats.additions;
          file.deletions = lineStats.deletions;
        }
      } catch (err) {
        log.warn(`numstat shared ${thread.id} : ${messageOf(err)}`);
      }
    }
    return out;
  }

  /** Statistiques +N/−N entre la base du thread et le contenu actuel (mode shared). */
  private async numstatShared(rt: ThreadRuntime, rels: string[]): Promise<Map<string, LineStats>> {
    const out = new Map<string, LineStats>();
    if (!this.isGitRepo || rels.length === 0) return out;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-numstat-'));
    try {
      for (let i = 0; i < rels.length; i++) {
        const rel = rels[i];
        const base = await this.baseBytesFor(rt, rel);
        const current = readBufferIfExists(path.join(this.workspaceRoot, rel));
        if (buffersEqual(base, current)) {
          out.set(rel, { additions: 0, deletions: 0 });
          continue;
        }
        // Fichier absent d'un côté : fichier temporaire vide.
        const basePath = path.join(tmpDir, `${i}.base`);
        const currentPath = path.join(tmpDir, `${i}.cur`);
        fs.writeFileSync(basePath, base ?? Buffer.alloc(0));
        fs.writeFileSync(currentPath, current ?? Buffer.alloc(0));
        // --no-index : code 1 = différences (normal).
        const result = await git(
          this.workspaceRoot,
          ['diff', '--no-index', '--numstat', '--', basePath, currentPath],
          { allowFail: true },
        );
        if (result.code !== 0 && result.code !== 1) continue;
        const lineStats = parseNumstat(result.stdout);
        if (lineStats) out.set(rel, lineStats);
      }
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Nettoyage best-effort de fichiers temporaires.
      }
    }
    return out;
  }

  private async baseFor(rt: ThreadRuntime, rel: string): Promise<string | undefined> {
    if (rt.snapshot.has(rel)) return rt.snapshot.get(rel);
    return this.headContent(rel, rt.baseHead ?? 'HEAD');
  }

  /** Base du thread en octets (snapshot ou objet git), pour comparer/restaurer sans perte. */
  private async baseBytesFor(rt: ThreadRuntime, rel: string): Promise<Buffer | undefined> {
    if (rt.snapshot.has(rel)) {
      const snap = rt.snapshot.get(rel);
      return snap === undefined ? undefined : Buffer.from(snap, 'utf8');
    }
    return this.headContentBytes(rel, rt.baseHead ?? 'HEAD');
  }

  private async headContent(rel: string, rev = 'HEAD'): Promise<string | undefined> {
    if (!this.isGitRepo) return undefined;
    const result = await git(this.workspaceRoot, ['show', `${rev}:${rel}`], { allowFail: true });
    return result.code === 0 ? result.stdout : undefined;
  }

  private async headContentBytes(rel: string, rev = 'HEAD'): Promise<Buffer | undefined> {
    if (!this.isGitRepo) return undefined;
    const result = await gitBuffer(this.workspaceRoot, ['show', `${rev}:${rel}`], { allowFail: true });
    return result.code === 0 ? result.stdout : undefined;
  }

  /** Aligne les watchers du workspace après un commit de l'Orchestrator. */
  private acknowledgeWorkspace(sha: string): void {
    const root = path.resolve(this.workspaceRoot);
    for (const rt of this.runtimes.values()) {
      if (rt.watcher && rt.watcherCwd && path.resolve(rt.watcherCwd) === root) {
        rt.watcher.acknowledge(sha);
      }
    }
  }
}
