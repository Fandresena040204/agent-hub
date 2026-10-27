import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Orchestrator, type McpBinding, type OrchestratorConfig } from '../src/core/Orchestrator';
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentRun,
  NativeSession,
  NativeSessionContent,
  StartOptions,
} from '../src/adapters/AgentAdapter';
import type { AgentEvent } from '../src/core/events';
import { AsyncQueue } from '../src/adapters/process';
import { ThreadStore } from '../src/core/ThreadStore';
import { git } from '../src/core/git';
import type { AgentId } from '../src/core/types';

// ── Faux adaptateur scriptable ─────────────────────────────────────────

type Action =
  | { kind: 'write'; path: string; content: string }
  | { kind: 'commit'; message: string }
  | { kind: 'emit'; event: AgentEvent };

interface Turn {
  steps: Action[];
  summary?: string;
}

interface FakeOptions {
  available?: boolean;
  detail?: string;
  caps?: AgentCapabilities;
  turns?: Turn[];
  /** Présent = l'adaptateur sait lister les sessions natives. */
  sessions?: NativeSession[];
  /** Contenu par session native ; absent = session vide. */
  contents?: Record<string, NativeSessionContent>;
  /** Simule un CLI qui échoue à lister ses sessions. */
  listSessionsError?: string;
}

const DEFAULT_CAPS: AgentCapabilities = {
  models: [{ id: 'm1' }, { id: 'm2' }],
  effortLevels: [{ id: 'low' }, { id: 'high' }],
};

class FakeAdapter implements AgentAdapter {
  readonly received: string[] = [];
  readonly starts: StartOptions[] = [];
  readonly readCalls: string[] = [];
  listSessions?: (cwd: string) => Promise<NativeSession[]>;
  readSession?: (sessionId: string, cwd: string) => Promise<NativeSessionContent>;
  gate?: Promise<void>;
  private turns: Turn[];

  constructor(
    readonly id: AgentId,
    readonly label: string,
    private readonly opts: FakeOptions = {},
  ) {
    this.turns = [...(opts.turns ?? [])];
    if (opts.sessions) {
      this.listSessions = async (cwd: string) => {
        if (opts.listSessionsError) throw new Error(opts.listSessionsError);
        return opts.sessions!.map((s) => ({ ...s, cwd: s.cwd ?? cwd }));
      };
      this.readSession = async (sessionId: string) => {
        this.readCalls.push(sessionId);
        return opts.contents?.[sessionId] ?? { events: [] };
      };
    }
  }

  async isAvailable(): Promise<{ ok: boolean; detail?: string }> {
    if (this.opts.available === false) return { ok: false, detail: this.opts.detail ?? 'indisponible' };
    return { ok: true, detail: 'fake' };
  }

  async getCapabilities(): Promise<AgentCapabilities> {
    return this.opts.caps ?? DEFAULT_CAPS;
  }

  start(options: StartOptions): AgentRun {
    this.starts.push(options);
    this.received.push(options.prompt);
    const queue = new AsyncQueue<AgentEvent>();
    let raw: ((stream: 'stdout' | 'stderr', line: string) => void) | undefined;
    const sessionId = options.sessionId ?? `sess-${this.id}-${this.starts.length}`;

    const runTurn = async (text: string): Promise<void> => {
      // Laisse l'Orchestrateur s'abonner avant le premier événement.
      await new Promise((resolve) => setTimeout(resolve, 0));
      queue.push({ type: 'session_started', sessionId });
      raw?.('stdout', `ligne brute ${text}`);
      const turn = this.turns.shift() ?? { steps: [] };
      for (const step of turn.steps) {
        if (step.kind === 'emit') {
          queue.push(step.event);
        } else if (step.kind === 'write') {
          const abs = path.resolve(options.cwd, step.path);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, step.content, 'utf8');
          queue.push({ type: 'file_changed', path: abs });
        } else {
          await git(options.cwd, ['add', '-A']);
          await git(options.cwd, ['commit', '-m', step.message]);
        }
      }
      if (this.gate) await this.gate;
      queue.push({ type: 'done', summary: turn.summary ?? `fini ${text}` });
    };

    void runTurn(options.prompt);
    return {
      events: queue,
      onRawLine: (cb) => {
        raw = cb;
      },
      sendMessage: async (text: string) => {
        this.received.push(text);
        queue.push({ type: 'user_text', text });
        void runTurn(text);
      },
      interrupt: async () => {
        queue.close();
      },
    };
  }
}

// ── Utilitaires ────────────────────────────────────────────────────────

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function createRepo(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-test-'));
  await git(dir, ['init']);
  await git(dir, ['config', 'user.email', 'test@test.com']);
  await git(dir, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n');
  await git(dir, ['add', 'README.md']);
  await git(dir, ['commit', '-m', 'Initial commit']);
  return dir;
}

const ACTIVE = ['starting', 'running'];

const MCP_URL = 'http://127.0.0.1:4321/mcp';

/** Faux binding MCP : jetons stables par thread et trace des révocations. */
function mcpBinding(): { binding: McpBinding; tokens: Map<string, string>; unregistered: string[] } {
  const tokens = new Map<string, string>();
  const unregistered: string[] = [];
  let n = 0;
  return {
    tokens,
    unregistered,
    binding: {
      url: () => MCP_URL,
      registerMainThread: (id: string) => {
        let token = tokens.get(id);
        if (!token) {
          token = `jeton-${++n}`;
          tokens.set(id, token);
        }
        return token;
      },
      unregister: (id: string) => {
        unregistered.push(id);
        tokens.delete(id);
      },
    },
  };
}

describe('Orchestrator', () => {
  let repoDir: string;
  let storageDir: string;
  let store: ThreadStore;
  let cfg: OrchestratorConfig;
  let orch: Orchestrator | undefined;

  beforeEach(async () => {
    repoDir = await createRepo();
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-storage-'));
    store = new ThreadStore(storageDir);
    cfg = {
      maxActiveThreads: 3,
      threadTimeoutSec: 30,
      isolationPolicy: 'agent-decides',
      includeUncommitted: false,
      linkPaths: [],
      mainAgentCommit: 'deny',
      readOnlyChildren: true,
      defaults: {},
    };
  });

  afterEach(async () => {
    await orch?.dispose();
    orch = undefined;
    for (const dir of [repoDir, storageDir]) {
      if (!dir || !fs.existsSync(dir)) continue;
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        // Nettoyage best-effort : dossiers temporaires, jamais bloquant.
      }
    }
  });

  function build(adapters: Partial<Record<AgentId, AgentAdapter>>): Orchestrator {
    orch = new Orchestrator({
      workspaceRoot: repoDir,
      storageDir,
      adapters,
      store,
      config: () => cfg,
    });
    return orch;
  }

  function mainAdapter(turns: Turn[] = [{ steps: [] }]): FakeAdapter {
    return new FakeAdapter('claude', 'Claude', { turns });
  }

  it('thread principal : événements stockés, statut idle, sendMessage relance', async () => {
    const claude = mainAdapter([
      {
        steps: [{ kind: 'emit', event: { type: 'assistant_text', text: 'Bonjour', partial: false } }],
        summary: 'fini',
      },
    ]);
    const o = build({ claude });
    await o.init();

    const thread = await o.startMainThread({ agent: 'claude', prompt: 'Fais un truc', permissionMode: 'edit' });
    const done = await o.waitThread(thread.id, 10);
    expect(done.status).toBe('idle');

    const events = o.getEvents(thread.id);
    expect(events[0].event).toMatchObject({ type: 'user_text', text: 'Fais un truc' });
    const types = events.map((e) => e.event.type);
    expect(types).toContain('assistant_text');
    expect(types).toContain('done');

    await o.sendMessage(thread.id, 'encore');
    const again = await o.waitThread(thread.id, 10);
    expect(again.status).toBe('idle');
    expect(claude.received).toEqual(['Fais un truc', 'encore']);
    expect(o.getEvents(thread.id).filter((e) => e.event.type === 'user_text')).toHaveLength(2);
  });

  it('delegate : effort invalide listé, agent indisponible', async () => {
    const claude = mainAdapter();
    const codex = new FakeAdapter('codex', 'Codex', { available: false, detail: 'CLI absent' });
    const o = build({ claude, codex });
    await o.init();

    const main = await o.startMainThread({ agent: 'claude', prompt: 'main', permissionMode: 'edit' });
    await o.waitThread(main.id, 10);

    await expect(
      o.delegate(main.id, { agent: 'claude', prompt: 'x', mode: 'readonly', effort: 'turbo' }),
    ).rejects.toThrow(/low, high/);
    await expect(
      o.delegate(main.id, { agent: 'codex', prompt: 'x', mode: 'readonly' }),
    ).rejects.toThrow(/indisponible.*CLI absent/);
  });

  it('delegate : profondeur maximale et limite de threads actifs', async () => {
    const claude = mainAdapter();
    const codex = new FakeAdapter('codex', 'Codex', { turns: [{ steps: [] }] });
    const o = build({ claude, codex });
    await o.init();

    const main = await o.startMainThread({ agent: 'claude', prompt: 'main', permissionMode: 'edit' });
    await o.waitThread(main.id, 10);

    const sub = await o.delegate(main.id, { agent: 'codex', prompt: 'sub', mode: 'readonly' });
    await o.waitThread(sub.id, 10);
    await expect(
      o.delegate(sub.id, { agent: 'codex', prompt: 'x', mode: 'readonly' }),
    ).rejects.toThrow(/Profondeur de délégation maximale/);

    cfg.maxActiveThreads = 1;
    const gate = deferred();
    claude.gate = gate.promise;
    const running = await o.delegate(main.id, { agent: 'claude', prompt: 'long', mode: 'readonly' });
    expect(ACTIVE).toContain(running.status);
    await expect(
      o.delegate(main.id, { agent: 'codex', prompt: 'y', mode: 'readonly' }),
    ).rejects.toThrow(/Limite de threads délégués actifs atteinte \(1\)/);
    gate.resolve();
    await o.waitThread(running.id, 10);
  });

  it('delegate : scopes qui se chevauchent refusés en nommant le premier thread', async () => {
    const claude = mainAdapter();
    const codex = new FakeAdapter('codex', 'Codex', { turns: [{ steps: [] }] });
    const o = build({ claude, codex });
    await o.init();

    const main = await o.startMainThread({ agent: 'claude', prompt: 'main', permissionMode: 'edit' });
    await o.waitThread(main.id, 10);

    const gate = deferred();
    claude.gate = gate.promise;
    const first = await o.delegate(main.id, {
      agent: 'claude',
      prompt: 'a',
      mode: 'edit',
      isolation: 'shared',
      scope: ['src/**'],
    });
    await expect(
      o.delegate(main.id, {
        agent: 'codex',
        prompt: 'b',
        mode: 'edit',
        isolation: 'shared',
        scope: ['src/a.ts'],
      }),
    ).rejects.toThrow(new RegExp(first.id));
    // La délégation refusée ne laisse aucune carte orpheline dans le parent.
    const cards = o.getEvents(main.id).filter((e) => e.event.type === 'subagent_started');
    expect(cards.map((e) => (e.event as { threadId: string }).threadId)).toEqual([first.id]);
    gate.resolve();
    await o.waitThread(first.id, 10);
  });

  it('delegate : subagent_started émis dans le parent (store + notification), pas dans l’enfant', async () => {
    const claude = mainAdapter();
    const codex = new FakeAdapter('codex', 'Codex', { turns: [{ steps: [] }] });
    const o = build({ claude, codex });
    await o.init();

    const main = await o.startMainThread({ agent: 'claude', prompt: 'main', permissionMode: 'edit' });
    await o.waitThread(main.id, 10);

    const notified: [string, string][] = [];
    o.onDidAppendEvent((threadId, stored) => {
      if (stored.event.type === 'subagent_started') notified.push([threadId, stored.event.threadId]);
    });

    const sub = await o.delegate(main.id, { agent: 'codex', prompt: 'sub', mode: 'readonly' });
    await o.waitThread(sub.id, 10);

    const started = o
      .getEvents(main.id)
      .filter((e) => e.event.type === 'subagent_started')
      .map((e) => (e.event.type === 'subagent_started' ? e.event.threadId : ''));
    expect(started).toEqual([sub.id]);
    expect(notified).toEqual([[main.id, sub.id]]);
    expect(o.getEvents(sub.id).some((e) => e.event.type === 'subagent_started')).toBe(false);
  });

  it('sendMessage : thread délégué en lecture seule pour l’utilisateur, ouvert à l’agent principal', async () => {
    const claude = mainAdapter();
    const codex = new FakeAdapter('codex', 'Codex', { turns: [{ steps: [] }, { steps: [] }, { steps: [] }] });
    const o = build({ claude, codex });
    await o.init();

    const main = await o.startMainThread({ agent: 'claude', prompt: 'Objectif parent', permissionMode: 'edit' });
    await o.waitThread(main.id, 10);
    const sub = await o.delegate(main.id, { agent: 'codex', prompt: 'sub', mode: 'readonly' });
    await o.waitThread(sub.id, 10);

    await expect(o.sendMessage(sub.id, 'coucou')).rejects.toThrow(
      /lecture seule : écrivez au thread principal \(Objectif parent\), qui pilote ses sous-agents/,
    );
    expect(codex.received).toEqual(['sub']);

    // L'agent principal (outil MCP message_thread) passe from: 'agent'.
    await o.sendMessage(sub.id, 'suivi agent', { from: 'agent' });
    await o.waitThread(sub.id, 10);
    expect(codex.received).toEqual(['sub', 'suivi agent']);

    // Réglage désactivé : l'utilisateur reprend la main sur les threads enfants.
    cfg.readOnlyChildren = false;
    await o.sendMessage(sub.id, 'coucou utilisateur');
    await o.waitThread(sub.id, 10);
    expect(codex.received.at(-1)).toBe('coucou utilisateur');
  });

  it('changeAgent : refusé sur un thread délégué en lecture seule, accepté si le réglage est off', async () => {
    const claude = mainAdapter();
    const codex = new FakeAdapter('codex', 'Codex', { turns: [{ steps: [] }] });
    const o = build({ claude, codex });
    await o.init();

    const main = await o.startMainThread({ agent: 'claude', prompt: 'Objectif parent', permissionMode: 'edit' });
    await o.waitThread(main.id, 10);
    const sub = await o.delegate(main.id, { agent: 'codex', prompt: 'sub', mode: 'readonly' });
    await o.waitThread(sub.id, 10);

    await expect(
      o.changeAgent(sub.id, { agent: 'claude', model: 'm2', effort: 'high' }),
    ).rejects.toThrow(/lecture seule/);
    expect(o.getThread(sub.id)!.agent).toBe('codex');

    cfg.readOnlyChildren = false;
    const switched = await o.changeAgent(sub.id, { agent: 'claude', model: 'm2', effort: 'high' });
    expect(switched.agent).toBe('claude');
  });

  it('lastActivity : première ligne du texte, puis outil (préfixe mcp retiré), tronqué à 140', async () => {
    const long = 'x'.repeat(200);
    const claude = mainAdapter([
      {
        steps: [
          {
            kind: 'emit',
            event: { type: 'assistant_text', text: '\n  Analyse en cours\nsuite ignorée', partial: false },
          },
        ],
      },
      {
        steps: [
          { kind: 'emit', event: { type: 'assistant_text', text: 'brouillon partiel', partial: true } },
          { kind: 'emit', event: { type: 'tool_call', id: 't1', name: 'mcp__agenthub__read_thread', input: {} } },
        ],
      },
      { steps: [{ kind: 'emit', event: { type: 'assistant_text', text: long, partial: false } }] },
    ]);
    const o = build({ claude });
    await o.init();

    const main = await o.startMainThread({ agent: 'claude', prompt: 'main', permissionMode: 'edit' });
    await o.waitThread(main.id, 10);
    expect(o.getThread(main.id)!.lastActivity).toBe('Analyse en cours');
    // Sauvegardé avec le thread.
    expect(store.loadThreads().find((t) => t.id === main.id)?.lastActivity).toBe('Analyse en cours');

    await o.sendMessage(main.id, 'suite');
    await o.waitThread(main.id, 10);
    // Le texte partiel est ignoré : c'est l'appel d'outil qui reste.
    expect(o.getThread(main.id)!.lastActivity).toBe('outil read_thread');

    await o.sendMessage(main.id, 'encore');
    await o.waitThread(main.id, 10);
    const activity = o.getThread(main.id)!.lastActivity!;
    expect(activity).toHaveLength(140);
    expect(activity.endsWith('…')).toBe(true);
  });

  it('finishedAt : posé à la fin du tour, effacé au tour suivant, posé à l’interruption', async () => {
    const claude = mainAdapter([{ steps: [] }, { steps: [] }]);
    const o = build({ claude });
    await o.init();

    const main = await o.startMainThread({ agent: 'claude', prompt: 'main', permissionMode: 'edit' });
    await o.waitThread(main.id, 10);
    const first = o.getThread(main.id)!;
    expect(typeof first.finishedAt).toBe('number');
    expect(first.finishedAt!).toBeGreaterThanOrEqual(first.createdAt);

    // Tour suivant : le gate retient la fin du tour.
    const gate = deferred();
    claude.gate = gate.promise;
    await o.sendMessage(main.id, 'encore');
    expect(o.getThread(main.id)!.status).toBe('running');
    expect(o.getThread(main.id)!.finishedAt).toBeUndefined();
    gate.resolve();
    await o.waitThread(main.id, 10);
    expect(typeof o.getThread(main.id)!.finishedAt).toBe('number');

    // Interruption : le tour est bien terminé.
    const gate2 = deferred();
    claude.gate = gate2.promise;
    await o.sendMessage(main.id, 'long');
    await o.interrupt(main.id);
    expect(o.getThread(main.id)!.status).toBe('interrupted');
    expect(typeof o.getThread(main.id)!.finishedAt).toBe('number');
    gate2.resolve();
  });

  it('shared : écriture hors scope → scope_violation', async () => {
    const claude = mainAdapter();
    const codex = new FakeAdapter('codex', 'Codex', {
      turns: [{ steps: [{ kind: 'write', path: 'docs/out.txt', content: 'x' }] }],
    });
    const o = build({ claude, codex });
    await o.init();

    const main = await o.startMainThread({ agent: 'claude', prompt: 'main', permissionMode: 'edit' });
    await o.waitThread(main.id, 10);
    const sub = await o.delegate(main.id, {
      agent: 'codex',
      prompt: 'sub',
      mode: 'edit',
      isolation: 'shared',
      scope: ['src/**'],
    });
    const done = await o.waitThread(sub.id, 10);
    expect(done.status).toBe('done');
    expect(done.violations.scope).toContain('docs/out.txt');
    expect(
      o.getEvents(sub.id).some(
        (e) => e.event.type === 'scope_violation' && e.event.path === 'docs/out.txt',
      ),
    ).toBe(true);
  });

  it('sous-agent qui lance git commit → commit_violation', async () => {
    const claude = mainAdapter();
    const codex = new FakeAdapter('codex', 'Codex', {
      turns: [
        {
          steps: [
            { kind: 'write', path: 'src/a.ts', content: 'a' },
            { kind: 'commit', message: 'triche' },
          ],
        },
      ],
    });
    const o = build({ claude, codex });
    await o.init();

    const main = await o.startMainThread({ agent: 'claude', prompt: 'main', permissionMode: 'edit' });
    await o.waitThread(main.id, 10);
    const sub = await o.delegate(main.id, {
      agent: 'codex',
      prompt: 'sub',
      mode: 'edit',
      isolation: 'shared',
      scope: ['src/**'],
    });
    const done = await o.waitThread(sub.id, 10);
    expect(done.violations.commits).toHaveLength(1);
    expect(o.getEvents(sub.id).some((e) => e.event.type === 'commit_violation')).toBe(true);
  });

  it('worktree : workspace intact avant merge, fichier appliqué non commité après', async () => {
    const claude = mainAdapter();
    const codex = new FakeAdapter('codex', 'Codex', {
      turns: [{ steps: [{ kind: 'write', path: 'src/wt.ts', content: 'wt' }] }],
    });
    const o = build({ claude, codex });
    await o.init();

    const main = await o.startMainThread({ agent: 'claude', prompt: 'main', permissionMode: 'edit' });
    await o.waitThread(main.id, 10);

    const headBefore = (await git(repoDir, ['rev-parse', 'HEAD'])).stdout.trim();
    const branchesBefore = (await git(repoDir, ['branch', '--list'])).stdout;

    const sub = await o.delegate(main.id, {
      agent: 'codex',
      prompt: 'worktree',
      mode: 'edit',
      isolation: 'worktree',
    });
    const done = await o.waitThread(sub.id, 10);
    expect(done.status).toBe('done');

    expect(fs.existsSync(path.join(repoDir, 'src', 'wt.ts'))).toBe(false);
    expect((await git(repoDir, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(headBefore);
    expect((await git(repoDir, ['branch', '--list'])).stdout).toBe(branchesBefore);

    const files = await o.changedFiles(sub.id);
    expect(files.map((f) => f.path)).toContain('src/wt.ts');
    expect(files.find((f) => f.path === 'src/wt.ts')!.status).toBe('added');

    const result = await o.mergeThread(sub.id);
    expect(result.status).toBe('applied');
    expect(fs.existsSync(path.join(repoDir, 'src', 'wt.ts'))).toBe(true);
    expect((await git(repoDir, ['status', '--porcelain', '-uall'])).stdout).toContain('src/wt.ts');
    expect((await git(repoDir, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(headBefore);
    expect(o.getThread(sub.id)!.status).toBe('applied');
  });

  it('commit : deny refuse clairement', async () => {
    cfg.mainAgentCommit = 'deny';
    const claude = mainAdapter();
    const o = build({ claude });
    await o.init();
    const main = await o.startMainThread({ agent: 'claude', prompt: 'main', permissionMode: 'edit' });
    await o.waitThread(main.id, 10);

    await expect(
      o.commit({ callerThreadId: main.id, message: 'm', paths: ['README.md'] }, async () => true),
    ).rejects.toThrow(/permission de commit/);
  });

  it('commit : ask + refus utilisateur ne change pas HEAD', async () => {
    cfg.mainAgentCommit = 'ask';
    const claude = mainAdapter();
    const o = build({ claude });
    await o.init();
    const main = await o.startMainThread({ agent: 'claude', prompt: 'main', permissionMode: 'edit' });
    await o.waitThread(main.id, 10);

    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'src', 'a.ts'), 'a');
    const headBefore = (await git(repoDir, ['rev-parse', 'HEAD'])).stdout.trim();

    let previewed = false;
    await expect(
      o.commit({ callerThreadId: main.id, message: 'm', paths: ['src/a.ts'] }, async (preview) => {
        previewed = true;
        expect(preview.paths).toContain('src/a.ts');
        return false;
      }),
    ).rejects.toThrow(/refusé par l'utilisateur/);
    expect(previewed).toBe(true);
    expect((await git(repoDir, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(headBefore);
  });

  it('commit : allow crée le commit, émet commit_made, aucun commit_violation', async () => {
    cfg.mainAgentCommit = 'allow';
    const gate = deferred();
    const claude = mainAdapter();
    claude.gate = gate.promise;
    const codex = new FakeAdapter('codex', 'Codex', {
      turns: [{ steps: [{ kind: 'write', path: 'src/a.ts', content: 'a' }] }],
    });
    const o = build({ claude, codex });
    await o.init();

    const main = await o.startMainThread({ agent: 'claude', prompt: 'main', permissionMode: 'edit' });
    const sub = await o.delegate(main.id, {
      agent: 'codex',
      prompt: 'sub',
      mode: 'edit',
      isolation: 'shared',
      scope: ['src/**'],
    });
    await o.waitThread(sub.id, 10);

    const headBefore = (await git(repoDir, ['rev-parse', 'HEAD'])).stdout.trim();
    const result = await o.commit(
      { callerThreadId: main.id, message: 'feat: ajout', threadIds: [sub.id] },
      async () => true,
    );
    expect(result.paths).toEqual(['src/a.ts']);
    expect(result.sha).toMatch(/^[0-9a-f]{7,40}$/);

    const headAfter = (await git(repoDir, ['rev-parse', 'HEAD'])).stdout.trim();
    expect(headAfter).not.toBe(headBefore);
    expect((await git(repoDir, ['log', '-1', '--format=%s'])).stdout.trim()).toBe('feat: ajout');

    expect(o.getEvents(main.id).some((e) => e.event.type === 'commit_made')).toBe(true);

    // Le thread principal reprend après le commit : son watcher doit avoir été aligné.
    gate.resolve();
    await o.waitThread(main.id, 10);
    expect(o.getThread(main.id)!.violations.commits).toHaveLength(0);
    expect(o.getEvents(main.id).some((e) => e.event.type === 'commit_violation')).toBe(false);
  });

  it('commit : refuse un thread encore actif', async () => {
    cfg.mainAgentCommit = 'allow';
    const claude = mainAdapter();
    const gate = deferred();
    const codex = new FakeAdapter('codex', 'Codex', { turns: [{ steps: [] }] });
    codex.gate = gate.promise;
    const o = build({ claude, codex });
    await o.init();

    const main = await o.startMainThread({ agent: 'claude', prompt: 'main', permissionMode: 'edit' });
    await o.waitThread(main.id, 10);
    const sub = await o.delegate(main.id, {
      agent: 'codex',
      prompt: 'sub',
      mode: 'edit',
      isolation: 'shared',
      scope: ['src/**'],
    });

    await expect(
      o.commit({ callerThreadId: main.id, message: 'm', threadIds: [sub.id] }, async () => true),
    ).rejects.toThrow(/encore actif/);
    gate.resolve();
    await o.waitThread(sub.id, 10);
  });

  it('commit : refuse un worktree non appliqué', async () => {
    cfg.mainAgentCommit = 'allow';
    const claude = mainAdapter();
    const codex = new FakeAdapter('codex', 'Codex', {
      turns: [{ steps: [{ kind: 'write', path: 'src/wt.ts', content: 'wt' }] }],
    });
    const o = build({ claude, codex });
    await o.init();

    const main = await o.startMainThread({ agent: 'claude', prompt: 'main', permissionMode: 'edit' });
    await o.waitThread(main.id, 10);
    const sub = await o.delegate(main.id, {
      agent: 'codex',
      prompt: 'wt',
      mode: 'edit',
      isolation: 'worktree',
    });
    await o.waitThread(sub.id, 10);

    await expect(
      o.commit({ callerThreadId: main.id, message: 'm', threadIds: [sub.id] }, async () => true),
    ).rejects.toThrow(/merge_thread/);
  });

  it('changedFiles shared : base correcte malgré une modification préalable', async () => {
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'src', 'a.ts'), 'base');
    await git(repoDir, ['add', '.']);
    await git(repoDir, ['commit', '-m', 'src initial']);

    // Modifications non commitées AVANT le démarrage du thread.
    fs.writeFileSync(path.join(repoDir, 'src', 'a.ts'), 'pre');
    fs.writeFileSync(path.join(repoDir, 'src', 'other.ts'), 'pre2');

    const claude = mainAdapter();
    const codex = new FakeAdapter('codex', 'Codex', {
      turns: [{ steps: [{ kind: 'write', path: 'src/a.ts', content: 'thread' }] }],
    });
    const o = build({ claude, codex });
    await o.init();

    const main = await o.startMainThread({ agent: 'claude', prompt: 'main', permissionMode: 'edit' });
    await o.waitThread(main.id, 10);
    const sub = await o.delegate(main.id, {
      agent: 'codex',
      prompt: 'sub',
      mode: 'edit',
      isolation: 'shared',
      scope: ['src/**'],
    });
    await o.waitThread(sub.id, 10);

    const files = await o.changedFiles(sub.id);
    expect(files.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(files[0].status).toBe('modified');
    expect(await o.baseContent(sub.id, 'src/a.ts')).toBe('pre');
  });

  // ── Changement d'agent ─────────────────────────────────────────────────

  it('changeAgent même CLI : agent_switched resume, session conservée, nouveau modèle/effort', async () => {
    const claude = mainAdapter();
    const o = build({ claude });
    await o.init();

    const main = await o.startMainThread({
      agent: 'claude', model: 'm1', effort: 'low', prompt: 'main', permissionMode: 'edit',
    });
    await o.waitThread(main.id, 10);
    expect(o.getThread(main.id)!.sessionId).toBe('sess-claude-1');

    const switched = await o.changeAgent(main.id, { agent: 'claude', model: 'm2', effort: 'high' });
    expect(switched.agent).toBe('claude');
    expect(switched.model).toBe('m2');
    expect(switched.effort).toBe('high');
    expect(switched.sessionId).toBe('sess-claude-1');
    expect(switched.agentHistory).toMatchObject([
      { agent: 'claude', model: 'm1', effort: 'low', sessionId: 'sess-claude-1', mode: 'start' },
      { agent: 'claude', model: 'm2', effort: 'high', mode: 'resume' },
    ]);
    expect(
      o.getEvents(main.id).some(
        (e) => e.event.type === 'agent_switched' && e.event.mode === 'resume' &&
          e.event.from.agent === 'claude' && e.event.to.model === 'm2',
      ),
    ).toBe(true);
    expect(claude.starts).toHaveLength(1);

    await o.sendMessage(main.id, 'suite');
    await o.waitThread(main.id, 10);
    expect(claude.starts[1].sessionId).toBe('sess-claude-1');
    expect(claude.starts[1].model).toBe('m2');
    expect(claude.starts[1].effort).toBe('high');
  });

  it('changeAgent autre CLI : mode handoff, session vidée, dossier préfixé au message', async () => {
    const claude = mainAdapter([
      { steps: [{ kind: 'emit', event: { type: 'assistant_text', text: 'État initial', partial: false } }] },
    ]);
    const codex = new FakeAdapter('codex', 'Codex', { turns: [{ steps: [] }] });
    const o = build({ claude, codex });
    await o.init();

    const main = await o.startMainThread({
      agent: 'claude', model: 'm1', effort: 'low', prompt: 'Objectif initial', permissionMode: 'edit',
    });
    await o.waitThread(main.id, 10);

    const switched = await o.changeAgent(main.id, {
      agent: 'codex',
      model: 'm1',
      effort: 'high',
      message: 'Continue le projet',
    });
    expect(switched.agent).toBe('codex');
    expect(switched.sessionId).toBeUndefined();
    expect(switched.agentHistory).toMatchObject([
      { agent: 'claude', mode: 'start' },
      { agent: 'codex', model: 'm1', effort: 'high', mode: 'handoff' },
    ]);
    expect(
      o.getEvents(main.id).some((e) => e.event.type === 'agent_switched' && e.event.mode === 'handoff'),
    ).toBe(true);

    await o.waitThread(main.id, 10);
    const prompt = codex.starts[0].prompt;
    expect(prompt.startsWith('Dossier de passation')).toBe(true);
    expect(prompt).toContain('Continue le projet');
    expect(prompt).toContain('Objectif initial');
    expect(prompt).toContain('thread à la place de claude/m1');
    expect(o.getThread(main.id)!.sessionId).toBe('sess-codex-1');
    expect(o.getThread(main.id)!.agentHistory?.at(-1)?.sessionId).toBe('sess-codex-1');
  });

  it('changeAgent avec handoffSummary : tour supplémentaire sur l\'ancien agent, résumé dans le dossier', async () => {
    const claude = mainAdapter([
      { steps: [] },
      {
        steps: [
          { kind: 'emit', event: { type: 'assistant_text', text: 'RÉSUMÉ DE PASSATION COMPLET', partial: false } },
        ],
      },
    ]);
    const codex = new FakeAdapter('codex', 'Codex', { turns: [{ steps: [] }] });
    const o = build({ claude, codex });
    await o.init();

    const main = await o.startMainThread({
      agent: 'claude', model: 'm1', effort: 'low', prompt: 'main', permissionMode: 'edit',
    });
    await o.waitThread(main.id, 10);

    await o.changeAgent(main.id, {
      agent: 'codex',
      model: 'm1',
      effort: 'low',
      handoffSummary: true,
    });

    expect(claude.starts).toHaveLength(2);
    expect(claude.received[1]).toContain('Passation');
    expect(claude.received[1]).toContain('résumé de passation');

    await o.sendMessage(main.id, 'reprends');
    await o.waitThread(main.id, 10);
    const prompt = codex.starts[0].prompt;
    expect(prompt).toContain('RÉSUMÉ DE PASSATION COMPLET');
    expect(prompt).toContain('## Résumé de l\'agent sortant');
  });

  it('changeAgent refuse un thread en cours', async () => {
    const claude = mainAdapter();
    const gate = deferred();
    claude.gate = gate.promise;
    const o = build({ claude });
    await o.init();

    const main = await o.startMainThread({ agent: 'claude', prompt: 'long', permissionMode: 'edit' });
    await expect(
      o.changeAgent(main.id, { agent: 'claude', model: 'm2', effort: 'high' }),
    ).rejects.toThrow(/est en cours.*attendez la fin du tour/);

    gate.resolve();
    await o.waitThread(main.id, 10);
  });

  it('changeAgent refuse un effort invalide pour le modèle, en listant ses valeurs', async () => {
    const caps: AgentCapabilities = {
      models: [{ id: 'm1' }, { id: 'm2' }],
      effortLevels: [{ id: 'low' }, { id: 'high' }],
      effortLevelsByModel: { m1: [{ id: 'low' }], m2: [{ id: 'high' }] },
    };
    const claude = new FakeAdapter('claude', 'Claude', { caps });
    const o = build({ claude });
    await o.init();

    const main = await o.startMainThread({
      agent: 'claude', model: 'm1', effort: 'low', prompt: 'main', permissionMode: 'edit',
    });
    await o.waitThread(main.id, 10);

    await expect(
      o.changeAgent(main.id, { agent: 'claude', model: 'm2', effort: 'low' }),
    ).rejects.toThrow(/Niveau d'effort invalide.*Valeurs valides : high/);
    expect(o.getThread(main.id)!.model).toBe('m1');
    expect(o.getThread(main.id)!.agentHistory).toBeUndefined();
  });

  it('changeAgent thread principal : le nouvel adaptateur reçoit le même jeton MCP', async () => {
    const claude = mainAdapter();
    const codex = new FakeAdapter('codex', 'Codex', { turns: [{ steps: [] }] });
    const o = build({ claude, codex });
    await o.init();

    const url = 'http://127.0.0.1:4321/mcp';
    const tokens = new Map<string, string>();
    let n = 0;
    o.setMcp({
      url: () => url,
      registerMainThread: (id: string) => {
        let tok = tokens.get(id);
        if (!tok) {
          tok = `jeton-${++n}`;
          tokens.set(id, tok);
        }
        return tok;
      },
      unregister: (id: string) => {
        tokens.delete(id);
      },
    });

    const main = await o.startMainThread({
      agent: 'claude', model: 'm1', effort: 'low', prompt: 'main', permissionMode: 'edit',
    });
    await o.waitThread(main.id, 10);
    expect(claude.starts[0].mcpToken).toBe('jeton-1');

    await o.changeAgent(main.id, { agent: 'codex', model: 'm1', effort: 'low' });
    await o.sendMessage(main.id, 'suite');
    await o.waitThread(main.id, 10);

    expect(codex.starts[0].mcpServerUrl).toBe(url);
    expect(codex.starts[0].mcpToken).toBe('jeton-1');
  });

  it('changeAgent du parent n\'interrompt pas un thread délégué en cours', async () => {
    const claude = mainAdapter();
    const codex = new FakeAdapter('codex', 'Codex', { turns: [{ steps: [] }] });
    const o = build({ claude, codex });
    await o.init();

    const main = await o.startMainThread({
      agent: 'claude', model: 'm1', effort: 'low', prompt: 'main', permissionMode: 'edit',
    });
    await o.waitThread(main.id, 10);

    const gate = deferred();
    codex.gate = gate.promise;
    const sub = await o.delegate(main.id, { agent: 'codex', prompt: 'sub', mode: 'readonly' });
    expect(ACTIVE).toContain(o.getThread(sub.id)!.status);

    await o.changeAgent(main.id, { agent: 'codex', model: 'm1', effort: 'low' });
    expect(o.getThread(main.id)!.agent).toBe('codex');
    expect(ACTIVE).toContain(o.getThread(sub.id)!.status);
    expect(codex.starts).toHaveLength(1);

    gate.resolve();
    const done = await o.waitThread(sub.id, 10);
    expect(done.status).toBe('done');
  });

  it('changeAgent sur un thread délégué : garde scope, isolation et gitPolicy sub, sans MCP', async () => {
    cfg.readOnlyChildren = false;
    const claude = mainAdapter();
    const codex = new FakeAdapter('codex', 'Codex', { turns: [{ steps: [] }] });
    const o = build({ claude, codex });
    await o.init();

    const main = await o.startMainThread({
      agent: 'claude', model: 'm1', effort: 'low', prompt: 'main', permissionMode: 'edit',
    });
    await o.waitThread(main.id, 10);
    const sub = await o.delegate(main.id, {
      agent: 'codex',
      prompt: 'sub',
      mode: 'edit',
      isolation: 'shared',
      scope: ['src/**'],
    });
    await o.waitThread(sub.id, 10);

    await o.changeAgent(sub.id, { agent: 'claude', model: 'm2', effort: 'high', message: 'reprends' });
    await o.waitThread(sub.id, 10);

    const opts = claude.starts[1];
    expect(opts.cwd).toBe(repoDir);
    expect(opts.permissionMode).toBe('edit');
    expect(opts.allowedPaths).toEqual(['src/**']);
    expect(opts.gitPolicy).toEqual({ forbidden: expect.any(Array), role: 'sub' });
    expect(opts.mcpServerUrl).toBeUndefined();
    expect(opts.mcpToken).toBeUndefined();
    expect(opts.prompt.startsWith('Dossier de passation')).toBe(true);

    const switched = o.getThread(sub.id)!;
    expect(switched.isolation).toBe('shared');
    expect(switched.scope).toEqual(['src/**']);
    expect(switched.agentHistory).toMatchObject([
      { agent: 'codex', mode: 'start' },
      { agent: 'claude', model: 'm2', effort: 'high', mode: 'handoff' },
    ]);
  });

  it('changeAgent sans changement réel → erreur', async () => {
    const claude = mainAdapter();
    const o = build({ claude });
    await o.init();
    const main = await o.startMainThread({
      agent: 'claude', model: 'm1', effort: 'low', prompt: 'main', permissionMode: 'edit',
    });
    await o.waitThread(main.id, 10);

    await expect(
      o.changeAgent(main.id, { agent: 'claude', model: 'm1', effort: 'low' }),
    ).rejects.toThrow(/Aucun changement/);
  });

  // ── Statistiques +/− et annulation par fichier ─────────────────────────

  it('stats shared : +N/−N par rapport à la base du thread', async () => {
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'src', 'a.ts'), 'ligne1\nligne2\nligne3\n');
    await git(repoDir, ['add', '.']);
    await git(repoDir, ['commit', '-m', 'src initial']);

    const claude = mainAdapter();
    const codex = new FakeAdapter('codex', 'Codex', {
      turns: [
        {
          steps: [
            { kind: 'write', path: 'src/a.ts', content: 'ligne1\nMODIFIÉE\nligne3\n' },
            { kind: 'write', path: 'src/new.ts', content: 'x\ny\n' },
          ],
        },
      ],
    });
    const o = build({ claude, codex });
    await o.init();

    const main = await o.startMainThread({ agent: 'claude', prompt: 'main', permissionMode: 'edit' });
    await o.waitThread(main.id, 10);
    const sub = await o.delegate(main.id, {
      agent: 'codex',
      prompt: 'sub',
      mode: 'edit',
      isolation: 'shared',
      scope: ['src/**'],
    });
    await o.waitThread(sub.id, 10);

    const files = await o.changedFiles(sub.id);
    const modified = files.find((f) => f.path === 'src/a.ts');
    expect(modified?.status).toBe('modified');
    expect(modified?.additions).toBe(1);
    expect(modified?.deletions).toBe(1);

    const created = files.find((f) => f.path === 'src/new.ts');
    expect(created?.status).toBe('added');
    expect(created?.additions).toBe(2);
    expect(created?.deletions).toBe(0);
  });

  it('stats worktree : +N/−N entre baseTree et worktree', async () => {
    const claude = mainAdapter();
    const codex = new FakeAdapter('codex', 'Codex', {
      turns: [
        {
          steps: [
            { kind: 'write', path: 'README.md', content: '# Agent\n' },
            { kind: 'write', path: 'src/wt.ts', content: 'a\nb\n' },
          ],
        },
      ],
    });
    const o = build({ claude, codex });
    await o.init();

    const main = await o.startMainThread({ agent: 'claude', prompt: 'main', permissionMode: 'edit' });
    await o.waitThread(main.id, 10);
    const sub = await o.delegate(main.id, {
      agent: 'codex',
      prompt: 'wt',
      mode: 'edit',
      isolation: 'worktree',
    });
    await o.waitThread(sub.id, 10);

    const files = await o.changedFiles(sub.id);
    const modified = files.find((f) => f.path === 'README.md');
    expect(modified?.status).toBe('modified');
    expect(modified?.additions).toBe(1);
    expect(modified?.deletions).toBe(1);

    const created = files.find((f) => f.path === 'src/wt.ts');
    expect(created?.status).toBe('added');
    expect(created?.additions).toBe(2);
    expect(created?.deletions).toBe(0);
  });

  it('revertFiles shared : base restaurée, fichier créé supprimé, HEAD/index intacts', async () => {
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'src', 'a.ts'), 'base\n');
    await git(repoDir, ['add', '.']);
    await git(repoDir, ['commit', '-m', 'src initial']);
    const headBefore = (await git(repoDir, ['rev-parse', 'HEAD'])).stdout.trim();

    const claude = mainAdapter();
    const codex = new FakeAdapter('codex', 'Codex', {
      turns: [
        {
          steps: [
            { kind: 'write', path: 'src/a.ts', content: 'modifié\n' },
            { kind: 'write', path: 'src/new.ts', content: 'nouveau\n' },
          ],
        },
      ],
    });
    const o = build({ claude, codex });
    await o.init();

    const main = await o.startMainThread({ agent: 'claude', prompt: 'main', permissionMode: 'edit' });
    await o.waitThread(main.id, 10);
    const sub = await o.delegate(main.id, {
      agent: 'codex',
      prompt: 'sub',
      mode: 'edit',
      isolation: 'shared',
      scope: ['src/**'],
    });
    await o.waitThread(sub.id, 10);
    expect(fs.readFileSync(path.join(repoDir, 'src', 'a.ts'), 'utf8')).toBe('modifié\n');

    const before = o.getEvents(sub.id).length;
    await o.revertFiles(sub.id, ['src/a.ts', 'src/new.ts']);

    expect(fs.readFileSync(path.join(repoDir, 'src', 'a.ts'), 'utf8').replace(/\r\n/g, '\n')).toBe('base\n');
    expect(fs.existsSync(path.join(repoDir, 'src', 'new.ts'))).toBe(false);
    expect((await git(repoDir, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(headBefore);
    expect((await git(repoDir, ['diff', '--cached', '--name-only'])).stdout.trim()).toBe('');

    const status = (await git(repoDir, ['status', '--porcelain', '-uall'])).stdout;
    expect(status).not.toContain('src/a.ts');
    expect(status).not.toContain('src/new.ts');

    const added = o.getEvents(sub.id).slice(before);
    expect(
      added.some(
        (e) =>
          e.event.type === 'assistant_text' &&
          !e.event.partial &&
          e.event.text === '[Agent Hub] Modifications annulées : src/a.ts, src/new.ts',
      ),
    ).toBe(true);

    expect(await o.changedFiles(sub.id)).toEqual([]);
  });

  it('revertFiles worktree non appliqué : workspace intact, worktree restauré', async () => {
    const claude = mainAdapter();
    const codex = new FakeAdapter('codex', 'Codex', {
      turns: [
        {
          steps: [
            { kind: 'write', path: 'README.md', content: '# Agent\n' },
            { kind: 'write', path: 'src/wt.ts', content: 'wt\n' },
          ],
        },
      ],
    });
    const o = build({ claude, codex });
    await o.init();

    const main = await o.startMainThread({ agent: 'claude', prompt: 'main', permissionMode: 'edit' });
    await o.waitThread(main.id, 10);
    const sub = await o.delegate(main.id, {
      agent: 'codex',
      prompt: 'wt',
      mode: 'edit',
      isolation: 'worktree',
    });
    await o.waitThread(sub.id, 10);

    const wtPath = o.getThread(sub.id)!.worktreePath!;
    expect(fs.existsSync(path.join(repoDir, 'src', 'wt.ts'))).toBe(false);

    await o.revertFiles(sub.id, ['README.md', 'src/wt.ts']);

    // Worktree revenu à la base.
    expect(fs.readFileSync(path.join(wtPath, 'README.md'), 'utf8').replace(/\r\n/g, '\n')).toBe('# Test\n');
    expect(fs.existsSync(path.join(wtPath, 'src', 'wt.ts'))).toBe(false);
    // Workspace jamais touché.
    expect(fs.existsSync(path.join(repoDir, 'src', 'wt.ts'))).toBe(false);
    expect(fs.readFileSync(path.join(repoDir, 'README.md'), 'utf8').replace(/\r\n/g, '\n')).toBe('# Test\n');

    expect(await o.changedFiles(sub.id)).toEqual([]);
  });

  it('revertFiles worktree appliqué : revert dans le workspace avec la base du worktree', async () => {
    const claude = mainAdapter();
    const codex = new FakeAdapter('codex', 'Codex', {
      turns: [{ steps: [{ kind: 'write', path: 'src/wt.ts', content: 'wt\n' }] }],
    });
    const o = build({ claude, codex });
    await o.init();

    const main = await o.startMainThread({ agent: 'claude', prompt: 'main', permissionMode: 'edit' });
    await o.waitThread(main.id, 10);
    const sub = await o.delegate(main.id, {
      agent: 'codex',
      prompt: 'wt',
      mode: 'edit',
      isolation: 'worktree',
    });
    await o.waitThread(sub.id, 10);

    const merged = await o.mergeThread(sub.id);
    expect(merged.status).toBe('applied');
    expect(fs.existsSync(path.join(repoDir, 'src', 'wt.ts'))).toBe(true);
    const headBefore = (await git(repoDir, ['rev-parse', 'HEAD'])).stdout.trim();

    await o.revertFiles(sub.id, ['src/wt.ts']);

    expect(fs.existsSync(path.join(repoDir, 'src', 'wt.ts'))).toBe(false);
    expect((await git(repoDir, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(headBefore);
    expect((await git(repoDir, ['diff', '--cached', '--name-only'])).stdout.trim()).toBe('');
  });

  it('revertFiles refuse un thread en cours', async () => {
    const claude = mainAdapter();
    const gate = deferred();
    claude.gate = gate.promise;
    const o = build({ claude });
    await o.init();

    const main = await o.startMainThread({ agent: 'claude', prompt: 'long', permissionMode: 'edit' });
    await expect(o.revertFiles(main.id, ['README.md'])).rejects.toThrow(
      /est en cours : interrompez-le avant d'annuler des modifications/,
    );

    gate.resolve();
    await o.waitThread(main.id, 10);
  });

  it('revertFiles refuse un fichier non modifié par le thread', async () => {
    const claude = mainAdapter();
    const codex = new FakeAdapter('codex', 'Codex', {
      turns: [{ steps: [{ kind: 'write', path: 'src/a.ts', content: 'a\n' }] }],
    });
    const o = build({ claude, codex });
    await o.init();

    const main = await o.startMainThread({ agent: 'claude', prompt: 'main', permissionMode: 'edit' });
    await o.waitThread(main.id, 10);
    const sub = await o.delegate(main.id, {
      agent: 'codex',
      prompt: 'sub',
      mode: 'edit',
      isolation: 'shared',
      scope: ['src/**'],
    });
    await o.waitThread(sub.id, 10);

    await expect(o.revertFiles(sub.id, ['README.md'])).rejects.toThrow(
      /README\.md n'a pas été modifié par ce thread/,
    );
  });

  it('revertFiles : thread inconnu', async () => {
    const claude = mainAdapter();
    const o = build({ claude });
    await o.init();
    await expect(o.revertFiles('inconnu', ['README.md'])).rejects.toThrow(/Thread introuvable/);
  });

  // ── Import de sessions natives ─────────────────────────────────────────

  const NATIVE_CONTENT: NativeSessionContent = {
    title: 'Session native',
    model: 'm2',
    effort: 'high',
    events: [
      { ts: 1_000, event: { type: 'user_text', text: 'Objectif importé' } },
      { ts: 2_000, event: { type: 'assistant_text', text: 'Réponse native', partial: false } },
      { ts: 3_000, event: { type: 'tool_call', id: 't1', name: 'read_file', input: {} } },
    ],
  };

  function importingAdapter(extra: Partial<FakeOptions> = {}): FakeAdapter {
    return new FakeAdapter('claude', 'Claude', {
      sessions: [{ id: 'native-1', title: 'Session native', updatedAt: 3_000 }],
      contents: { 'native-1': NATIVE_CONTENT },
      turns: [{ steps: [] }],
      ...extra,
    });
  }

  it('listImportableSessions : agent absent, sans listSessions, indisponible ou en échec', async () => {
    const claude = mainAdapter();
    const codex = new FakeAdapter('codex', 'Codex', { available: false, detail: 'CLI absent', sessions: [] });
    const opencode = new FakeAdapter('opencode', 'OpenCode', {
      sessions: [],
      listSessionsError: 'dossier illisible',
    });
    const o = build({ claude, codex, opencode });
    await o.init();

    await expect(o.listImportableSessions('agy')).rejects.toThrow('Agent agy non configuré.');
    await expect(o.listImportableSessions('claude')).rejects.toThrow(
      "L'import de sessions n'est pas encore pris en charge pour Claude.",
    );
    await expect(o.importSession('claude', 'native-1')).rejects.toThrow(
      "L'import de sessions n'est pas encore pris en charge pour Claude.",
    );
    await expect(o.listImportableSessions('codex')).rejects.toThrow(/Agent codex indisponible : CLI absent/);
    await expect(o.listImportableSessions('opencode')).rejects.toThrow(
      /Sessions OpenCode indisponibles : dossier illisible/,
    );
  });

  it('listImportableSessions : marque les sessions déjà suivies (créée par Agent Hub et importée)', async () => {
    const claude = new FakeAdapter('claude', 'Claude', {
      sessions: [
        { id: 'sess-claude-1', title: 'Créée par Agent Hub', updatedAt: 3 },
        { id: 'native-2', title: 'Importée', updatedAt: 2 },
        { id: 'libre', title: 'Libre', updatedAt: 1 },
      ],
      contents: {
        'native-2': { title: 'Importée', events: [{ ts: 5, event: { type: 'user_text', text: 'salut' } }] },
      },
    });
    const o = build({ claude });
    await o.init();

    const main = await o.startMainThread({ agent: 'claude', prompt: 'main', permissionMode: 'edit' });
    await o.waitThread(main.id, 10);
    expect(main.sessionId).toBe('sess-claude-1');
    const imported = await o.importSession('claude', 'native-2');

    const sessions = await o.listImportableSessions('claude');
    expect(sessions.map((s) => s.id)).toEqual(['sess-claude-1', 'native-2', 'libre']);
    expect(sessions[0].importedThreadId).toBe(main.id);
    expect(sessions[1].importedThreadId).toBe(imported.id);
    expect(sessions[2].importedThreadId).toBeUndefined();
  });

  it('importSession : thread principal idle, historique horodaté, segment import, message final', async () => {
    const claude = importingAdapter();
    const o = build({ claude });
    await o.init();

    const notified: number[] = [];
    o.onDidAppendEvent((id, stored) => {
      expect(id).toBeTypeOf('string');
      notified.push(stored.ts);
    });

    const thread = await o.importSession('claude', 'native-1');
    expect(thread.parentId).toBeUndefined();
    expect(thread.status).toBe('idle');
    expect(thread.agent).toBe('claude');
    expect(thread.model).toBe('m2');
    expect(thread.effort).toBe('high');
    expect(thread.sessionId).toBe('native-1');
    expect(thread.permissionMode).toBe('edit');
    expect(thread.isolation).toBe('shared');
    expect(thread.cwd).toBe(repoDir);
    expect(thread.title).toBe('Session native');
    expect(thread.createdAt).toBe(1_000);
    expect(thread.agentHistory).toMatchObject([
      { agent: 'claude', model: 'm2', effort: 'high', sessionId: 'native-1', since: 1_000, mode: 'import' },
    ]);
    // Aucun tour lancé : la session native reprendra au prochain message.
    expect(claude.starts).toHaveLength(0);

    const stored = o.getEvents(thread.id);
    expect(stored).toHaveLength(4);
    expect(stored.slice(0, 3).map((e) => e.ts)).toEqual([1_000, 2_000, 3_000]);
    expect(stored.slice(0, 3).map((e) => e.event)).toEqual(NATIVE_CONTENT.events.map((e) => e.event));
    expect(stored[3].event).toEqual({
      type: 'assistant_text',
      text: '[Agent Hub] Session Claude importée (native-1). Le prochain message reprend cette session.',
      partial: false,
    });
    expect(notified.slice(0, 3)).toEqual([1_000, 2_000, 3_000]);
    expect(notified).toHaveLength(4);
    expect(store.loadThreads().find((t) => t.id === thread.id)?.status).toBe('idle');

    // Second import de la même session : même thread, aucune relecture.
    const again = await o.importSession('claude', 'native-1');
    expect(again.id).toBe(thread.id);
    expect(claude.readCalls).toEqual(['native-1']);
    expect(o.getEvents(thread.id)).toHaveLength(4);
  });

  it('importSession : titre repris du premier user_text à défaut de titre', async () => {
    const claude = new FakeAdapter('claude', 'Claude', {
      sessions: [{ id: 'sans-titre', title: '', updatedAt: 10 }],
      contents: {
        'sans-titre': {
          events: [{ ts: 10, event: { type: 'user_text', text: '  Corrige   le bug  ' } }],
        },
      },
    });
    const o = build({ claude });
    await o.init();

    const thread = await o.importSession('claude', 'sans-titre');
    expect(thread.title).toBe('Corrige le bug');
    expect(thread.model).toBeUndefined();
    expect(thread.createdAt).toBe(10);
  });

  it('importSession : le message suivant reprend la session native avec le serveur MCP principal', async () => {
    const claude = importingAdapter();
    const o = build({ claude });
    const mcp = mcpBinding();
    o.setMcp(mcp.binding);
    await o.init();

    const thread = await o.importSession('claude', 'native-1');
    await o.sendMessage(thread.id, 'continue');
    await o.waitThread(thread.id, 10);

    const start = claude.starts[0];
    expect(start.sessionId).toBe('native-1');
    expect(start.mcpServerUrl).toBe(MCP_URL);
    expect(start.mcpToken).toBe(mcp.tokens.get(thread.id));
    expect(start.systemPromptAppend).toContain('agent principal');
    expect(start.permissionMode).toBe('edit');
    expect(start.gitPolicy.role).toBe('main');
    expect(o.getThread(thread.id)!.sessionId).toBe('native-1');
    expect(o.getThread(thread.id)!.status).toBe('idle');
  });

  it('sendMessage après rechargement depuis le disque : session et jeton MCP conservés', async () => {
    const claude = mainAdapter();
    const first = build({ claude });
    const mcp1 = mcpBinding();
    first.setMcp(mcp1.binding);
    await first.init();
    const main = await first.startMainThread({ agent: 'claude', prompt: 'main', permissionMode: 'edit' });
    await first.waitThread(main.id, 10);
    await first.dispose();

    const claude2 = mainAdapter();
    const second = build({ claude: claude2 });
    const mcp2 = mcpBinding();
    second.setMcp(mcp2.binding);
    await second.init();

    await second.sendMessage(main.id, 'reprends');
    await second.waitThread(main.id, 10);

    const start = claude2.starts[0];
    expect(start.sessionId).toBe('sess-claude-1');
    expect(start.mcpServerUrl).toBe(MCP_URL);
    expect(start.mcpToken).toBe(mcp2.tokens.get(main.id));
    expect(start.systemPromptAppend).toContain('agent principal');
  });

  // ── Suppression de threads ─────────────────────────────────────────────

  it('deleteThread : principal avec deux enfants (en cours, worktree) → tout est supprimé', async () => {
    const claude = mainAdapter();
    const codex = new FakeAdapter('codex', 'Codex', {
      turns: [{ steps: [{ kind: 'write', path: 'src/wt.ts', content: 'wt' }] }, { steps: [] }],
    });
    const o = build({ claude, codex });
    const mcp = mcpBinding();
    o.setMcp(mcp.binding);
    await o.init();

    const main = await o.startMainThread({ agent: 'claude', prompt: 'main', permissionMode: 'edit' });
    await o.waitThread(main.id, 10);
    expect(mcp.tokens.get(main.id)).toBeDefined();

    const wtChild = await o.delegate(main.id, {
      agent: 'codex',
      prompt: 'worktree',
      mode: 'edit',
      isolation: 'worktree',
    });
    await o.waitThread(wtChild.id, 10);
    const wtPath = o.getThread(wtChild.id)!.worktreePath!;
    expect(fs.existsSync(wtPath)).toBe(true);

    const gate = deferred();
    codex.gate = gate.promise;
    const runningChild = await o.delegate(main.id, {
      agent: 'codex',
      prompt: 'long',
      mode: 'edit',
      isolation: 'shared',
      scope: ['src/**'],
    });
    expect(ACTIVE).toContain(o.getThread(runningChild.id)!.status);

    const removed: string[] = [];
    // Un callback fautif ne doit pas empêcher les autres notifications.
    o.onDidRemoveThread(() => {
      throw new Error('callback cassé');
    });
    o.onDidRemoveThread((id) => removed.push(id));

    await o.deleteThread(main.id);
    gate.resolve();

    for (const id of [main.id, wtChild.id, runningChild.id]) {
      expect(o.getThread(id)).toBeUndefined();
      expect(o.listThreads().some((t) => t.id === id)).toBe(false);
      expect(store.loadThreads().some((t) => t.id === id)).toBe(false);
      expect(store.loadEvents(id)).toEqual([]);
    }
    expect(removed).toEqual([wtChild.id, runningChild.id, main.id]);
    expect(fs.existsSync(wtPath)).toBe(false);
    expect(mcp.unregistered).toContain(main.id);
    expect(mcp.tokens.has(main.id)).toBe(false);

    // Verrou de scope libéré : une nouvelle délégation sur le même scope passe.
    const other = await o.startMainThread({ agent: 'claude', prompt: 'autre', permissionMode: 'edit' });
    await o.waitThread(other.id, 10);
    codex.gate = undefined;
    const again = await o.delegate(other.id, {
      agent: 'codex',
      prompt: 'reprise',
      mode: 'edit',
      isolation: 'shared',
      scope: ['src/**'],
    });
    const done = await o.waitThread(again.id, 10);
    expect(done.status).toBe('done');
  });

  it('deleteThread : un enfant seul laisse le parent et son historique intacts', async () => {
    const claude = mainAdapter();
    const codex = new FakeAdapter('codex', 'Codex', { turns: [{ steps: [] }, { steps: [] }] });
    const o = build({ claude, codex });
    await o.init();

    const main = await o.startMainThread({ agent: 'claude', prompt: 'main', permissionMode: 'edit' });
    await o.waitThread(main.id, 10);
    const sub = await o.delegate(main.id, { agent: 'codex', prompt: 'sub', mode: 'readonly' });
    await o.waitThread(sub.id, 10);

    const parentEvents = o.getEvents(main.id);
    expect(parentEvents.some((e) => e.event.type === 'subagent_started')).toBe(true);
    const removed: string[] = [];
    o.onDidRemoveThread((id) => removed.push(id));

    await o.deleteThread(sub.id);

    expect(o.getThread(sub.id)).toBeUndefined();
    expect(o.getThread(main.id)).toBeDefined();
    // La carte « thread supprimé » s'appuie sur l'historique du parent, laissé tel quel.
    expect(o.getEvents(main.id)).toEqual(parentEvents);
    expect(removed).toEqual([sub.id]);
    expect(store.loadEvents(sub.id)).toEqual([]);

    // Le parent reste utilisable.
    await o.sendMessage(main.id, 'suite');
    await o.waitThread(main.id, 10);
    expect(o.getThread(main.id)!.status).toBe('idle');
    expect(claude.received).toEqual(['main', 'suite']);

    await expect(o.deleteThread('inconnu')).rejects.toThrow(/Thread introuvable/);
  });
});
