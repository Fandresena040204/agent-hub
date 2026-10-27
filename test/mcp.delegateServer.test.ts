import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DelegateServer } from '../src/mcp/DelegateServer';
import type { ChangeAgentRequest, CommitRequest, DelegateRequest, OrchestratorApi } from '../src/core/orchestratorApi';
import type { AgentId, ThreadInfo } from '../src/core/types';

function thread(id: string, parentId?: string): ThreadInfo {
  return {
    id, parentId, agent: 'opencode', permissionMode: 'edit', isolation: 'shared', cwd: '/ws', title: `t-${id}`,
    status: 'done', createdAt: 1_000_000, updatedAt: 1_060_000, changedFiles: ['a.ts'], violations: { scope: [], commits: [] },
    lastActivity: 'outil read_thread', finishedAt: 1_060_000,
  };
}

/** Faux orchestrator en mémoire : seules les méthodes utilisées par le serveur sont réalistes. */
function fakeOrch() {
  const threads = new Map<string, ThreadInfo>([['main1', thread('main1')], ['main2', thread('main2')], ['c2', thread('c2', 'main2')]]);
  const calls = {
    delegate: [] as [string, DelegateRequest][],
    commit: [] as CommitRequest[],
    sendMessage: [] as [string, string, { from?: 'user' | 'agent' } | undefined][],
  };
  let n = 0;
  const orch = {
    workspaceRoot: '/ws',
    isGitRepo: true,
    onDidChangeThread: () => () => undefined,
    onDidAppendEvent: () => () => undefined,
    onDidChangeCommitPermission: () => () => undefined,
    listAgents: async () => [
      { id: 'opencode', label: 'OpenCode', available: true, capabilities: { models: [{ id: 'a/x' }, { id: 'a/y' }], effortLevels: null } },
      { id: 'claude', label: 'Claude', available: true, capabilities: { models: 'free-text', effortLevels: [{ id: 'low' }] } },
    ],
    listThreads: () => [...threads.values()],
    getThread: (id: string) => threads.get(id),
    getEvents: () => [{ ts: 1, event: { type: 'assistant_text', text: 'salut', partial: false } }],
    startMainThread: async () => thread('x'),
    delegate: async (parentId: string, req: DelegateRequest) => {
      calls.delegate.push([parentId, req]);
      if (req.effort === 'bad') throw new Error("Niveau d'effort invalide : \"bad\". Valeurs valides : low, high");
      const t = thread(`c${++n}x`, parentId);
      threads.set(t.id, t);
      return t;
    },
    sendMessage: async (id: string, text: string, opts?: { from?: 'user' | 'agent' }) => {
      calls.sendMessage.push([id, text, opts]);
    },
    changeAgent: async (id: string, _req: ChangeAgentRequest) => threads.get(id)!,
    interrupt: async () => undefined,
    waitThread: async (id: string) => threads.get(id)!,
    changedFiles: async () => [{ path: 'a.ts', absPath: '/ws/a.ts', status: 'modified' as const }],
    baseContent: async () => undefined,
    mergeThread: async () => ({ status: 'applied' as const, files: ['a.ts'], conflicted: [] }),
    removeWorktree: async () => undefined,
    getCommitPermission: () => 'deny' as const,
    setCommitPermission: () => undefined,
    commit: async (req: CommitRequest) => {
      calls.commit.push(req);
      return { sha: 'abc', paths: req.paths ?? [] };
    },
    dispose: async () => undefined,
  } as unknown as OrchestratorApi;
  return { orch, calls };
}

describe('DelegateServer', () => {
  let server: DelegateServer;
  let calls: ReturnType<typeof fakeOrch>['calls'];
  let allowed: string[];
  let allowedAgents: AgentId[];
  let token: string;
  let id = 0;

  const rpc = async (method: string, params?: unknown, tok: string | null = token, notification = false) => {
    const res = await fetch(server.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(notification ? {} : { id: ++id }) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    const result = r.body.result as { content: { text: string }[]; isError?: boolean };
    let data: unknown = result.content[0].text;
    try {
      data = JSON.parse(result.content[0].text);
    } catch {
      // texte brut (erreur)
    }
    return { isError: result.isError === true, data };
  };

  beforeEach(async () => {
    const f = fakeOrch();
    calls = f.calls;
    allowed = [];
    allowedAgents = [];
    server = new DelegateServer(f.orch, {
      confirmCommit: async () => true,
      allowedModels: () => allowed,
      allowedAgents: () => allowedAgents,
    });
    await server.start();
    token = server.registerMainThread('main1');
  });
  afterEach(async () => {
    await server.stop();
  });

  it('401 sans token ou avec un token inconnu', async () => {
    expect((await rpc('ping', {}, null)).status).toBe(401);
    expect((await rpc('ping', {}, 'faux')).status).toBe(401);
  });

  it('initialize renvoie les capacités et un Mcp-Session-Id', async () => {
    const r = await rpc('initialize', { protocolVersion: '2025-03-26' });
    expect(r.body.result.protocolVersion).toBe('2025-03-26');
    expect(r.body.result.capabilities.tools).toBeDefined();
    expect(r.headers.get('mcp-session-id')).toBeTruthy();
  });

  it('notification → 202, méthode inconnue → -32601, JSON invalide → -32700', async () => {
    expect((await rpc('notifications/initialized', undefined, token, true)).status).toBe(202);
    expect((await rpc('foo/bar')).body.error.code).toBe(-32601);
    const res = await fetch(server.url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: '{oops' });
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32700);
  });

  it('tools/list contient les 9 outils', async () => {
    const names = (await rpc('tools/list')).body.result.tools.map((t: { name: string }) => t.name);
    expect(names.sort()).toEqual(
      ['commit', 'delegate', 'interrupt_thread', 'list_agents', 'list_threads', 'merge_thread', 'message_thread', 'read_thread', 'wait_thread'],
    );
  });

  it('list_agents filtre selon allowedModels', async () => {
    allowed = ['a/y'];
    const { data } = await call('list_agents');
    expect((data as { capabilities: { models: { id: string }[] } }[])[0].capabilities.models).toEqual([{ id: 'a/y' }]);
  });

  it('list_agents ne renvoie que les agents autorisés', async () => {
    const all = await call('list_agents');
    expect((all.data as { id: string }[]).map((a) => a.id)).toEqual(['opencode', 'claude']);

    allowedAgents = ['claude'];
    const filtered = await call('list_agents');
    expect((filtered.data as { id: string }[]).map((a) => a.id)).toEqual(['claude']);
  });

  it('delegate refuse un agent non autorisé', async () => {
    allowedAgents = ['opencode'];
    const r = await call('delegate', { agent: 'claude', prompt: 'x', mode: 'readonly' });
    expect(r.isError).toBe(true);
    expect(String(r.data)).toContain('Agent non autorisé pour la délégation : "claude"');
    expect(String(r.data)).toContain('agentHub.delegation.allowedAgents');
    expect(calls.delegate).toHaveLength(0);
  });

  it('delegate transmet le parentId du token et renvoie le threadId', async () => {
    const { isError, data } = await call('delegate', { agent: 'opencode', prompt: 'fais x', mode: 'edit', scope: ['src/**'] });
    expect(isError).toBe(false);
    expect((data as { threadId: string }).threadId).toBeTruthy();
    expect(calls.delegate[0][0]).toBe('main1');
    expect(calls.delegate[0][1].scope).toEqual(['src/**']);
  });

  it('erreur métier → isError avec le message', async () => {
    const r = await call('delegate', { agent: 'opencode', prompt: 'x', mode: 'edit', effort: 'bad' });
    expect(r.isError).toBe(true);
    expect(String(r.data)).toContain('Valeurs valides : low, high');
  });

  it('modèle hors allowedModels refusé', async () => {
    allowed = ['a/x'];
    const r = await call('delegate', { agent: 'opencode', prompt: 'x', mode: 'readonly', model: 'a/y' });
    expect(r.isError).toBe(true);
    expect(String(r.data)).toContain('a/x');
    expect(calls.delegate).toHaveLength(0);
  });

  it('commit sans threadIds ni paths → isError', async () => {
    const r = await call('commit', { message: 'm' });
    expect(r.isError).toBe(true);
    expect(calls.commit).toHaveLength(0);
  });

  it('commit transmet callerThreadId', async () => {
    const r = await call('commit', { message: 'm', paths: ['a.ts'] });
    expect(r.isError).toBe(false);
    expect(calls.commit[0].callerThreadId).toBe('main1');
  });

  it("accès au thread d'un autre thread principal refusé", async () => {
    const r = await call('read_thread', { threadId: 'c2' });
    expect(r.isError).toBe(true);
    expect(String(r.data)).toContain('Thread inconnu');
  });

  it('read_thread renvoie statut, fichiers et événements', async () => {
    const { data } = await call('delegate', { agent: 'opencode', prompt: 'x', mode: 'readonly' });
    const r = await call('read_thread', { threadId: (data as { threadId: string }).threadId });
    expect(r.isError).toBe(false);
    expect((r.data as { changedFiles: string[] }).changedFiles).toEqual(['a.ts']);
    expect((r.data as { events: unknown[] }).events).toHaveLength(1);
  });

  it("message_thread transmet from:'agent' et se présente comme le seul canal vers un sous-agent", async () => {
    const tools = (await rpc('tools/list')).body.result.tools as { name: string; description: string }[];
    expect(tools.find((t) => t.name === 'message_thread')!.description).toContain(
      'Seul moyen d\'envoyer un message de suivi à un sous-agent',
    );

    const { data } = await call('delegate', { agent: 'opencode', prompt: 'x', mode: 'readonly' });
    const id = (data as { threadId: string }).threadId;
    const r = await call('message_thread', { threadId: id, text: 'continue' });
    expect(r.isError).toBe(false);
    expect(calls.sendMessage).toEqual([[id, 'continue', { from: 'agent' }]]);
  });

  it('read_thread, wait_thread et list_threads exposent lastActivity et durationSec', async () => {
    const { data } = await call('delegate', { agent: 'opencode', prompt: 'x', mode: 'readonly' });
    const id = (data as { threadId: string }).threadId;

    const read = (await call('read_thread', { threadId: id })).data as {
      lastActivity?: string;
      durationSec?: number;
    };
    expect(read.lastActivity).toBe('outil read_thread');
    expect(read.durationSec).toBe(60);

    const waited = (await call('wait_thread', { threadId: id, timeoutSec: 1 })).data as {
      lastActivity?: string;
      durationSec?: number;
    };
    expect(waited.lastActivity).toBe('outil read_thread');
    expect(waited.durationSec).toBe(60);

    const list = (await call('list_threads')).data as {
      threadId: string;
      lastActivity?: string;
      durationSec?: number;
    }[];
    const entry = list.find((t) => t.threadId === id)!;
    expect(entry.lastActivity).toBe('outil read_thread');
    expect(entry.durationSec).toBe(60);
  });
});
