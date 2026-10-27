// Serveur MCP local (Streamable HTTP, réponses JSON) exposant les outils de délégation à l'agent principal.
import * as crypto from 'crypto';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { createLogger, type Logger } from '../core/log';
import type { CommitPreview, OrchestratorApi } from '../core/orchestratorApi';
import type { StoredEvent } from '../core/events';
import type { AgentId, ThreadInfo } from '../core/types';
import { AGENT_IDS } from '../core/types';

export interface DelegateServerOptions {
  confirmCommit: (p: CommitPreview) => Promise<boolean>;
  allowedModels: () => string[];
  /** Agents autorisés à la délégation ; liste vide = tous. */
  allowedAgents: () => AgentId[];
  log?: Logger;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
}

type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string } };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, parentId: string) => Promise<unknown>;
}

/** Erreur de validation d'entrée d'un outil (renvoyée en isError). */
class ToolInputError extends Error {}

const DEFAULT_PROTOCOL = '2025-06-18';
const MAX_BODY = 4 * 1024 * 1024;
const MAX_WAIT_SEC = 1800;

const INSTRUCTIONS =
  "Outils Agent Hub pour déléguer des sous-tâches à d'autres agents de codage. Flux : list_agents (modèles et efforts valides) → delegate → read_thread / wait_thread → merge_thread (threads worktree) → commit (si l'utilisateur l'autorise). Ne lance jamais git commit/push/reset/rebase toi-même.";

export class DelegateServer {
  private server?: http.Server;
  private port = 0;
  /** token → threadId du thread principal */
  private readonly tokens = new Map<string, string>();
  private readonly tools: ToolDef[];
  private readonly log: Logger;

  constructor(private readonly orch: OrchestratorApi, private readonly opts: DelegateServerOptions) {
    this.log = opts.log ?? createLogger('mcp');
    this.tools = this.buildTools();
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    this.port = (server.address() as AddressInfo).port;
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  registerMainThread(threadId: string): string {
    for (const [tok, id] of this.tokens) if (id === threadId) return tok;
    const token = crypto.randomBytes(24).toString('hex');
    this.tokens.set(token, threadId);
    return token;
  }

  unregister(threadId: string): void {
    for (const [tok, id] of this.tokens) if (id === threadId) this.tokens.delete(tok);
  }

  // ---------------------------------------------------------------- HTTP

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/mcp') return this.send(res, 404, { error: 'not found' });
      const parentId = this.authenticate(req.headers.authorization);
      if (!parentId) return this.send(res, 401, { error: 'unauthorized' });
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return this.send(res, 405, { error: 'method not allowed' });
      }

      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return this.send(res, 200, rpcError(null, -32700, 'JSON invalide'));
      }

      const batch = Array.isArray(body);
      const messages = (batch ? body : [body]) as JsonRpcRequest[];
      const responses: JsonRpcResponse[] = [];
      let initialized = false;
      for (const msg of messages) {
        const r = await this.dispatch(msg, parentId);
        if (r) responses.push(r);
        if (msg && typeof msg === 'object' && msg.method === 'initialize') initialized = true;
      }
      if (responses.length === 0) {
        res.writeHead(202);
        res.end();
        return;
      }
      if (initialized) res.setHeader('Mcp-Session-Id', crypto.randomUUID());
      this.send(res, 200, batch ? responses : responses[0]);
    } catch (err) {
      this.log.error(`requête MCP : ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) this.send(res, 500, rpcError(null, -32603, 'erreur interne'));
    }
  }

  private authenticate(header: string | undefined): string | undefined {
    const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
    if (!m) return undefined;
    const given = Buffer.from(m[1]);
    for (const [tok, threadId] of this.tokens) {
      const expected = Buffer.from(tok);
      if (expected.length === given.length && crypto.timingSafeEqual(expected, given)) return threadId;
    }
    return undefined;
  }

  private send(res: http.ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  }

  // ------------------------------------------------------------- JSON-RPC

  private async dispatch(msg: JsonRpcRequest, parentId: string): Promise<JsonRpcResponse | undefined> {
    if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') {
      return rpcError(msg && typeof msg === 'object' ? (msg.id ?? null) : null, -32600, 'requête invalide');
    }
    const isNotification = msg.id === undefined;
    if (isNotification) return undefined;
    const id = msg.id ?? null;
    const params = asObject(msg.params);

    switch (msg.method) {
      case 'initialize':
        return rpcResult(id, {
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: 'agent-hub', version: '0.1.0' },
          instructions: INSTRUCTIONS,
        });
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, {
          tools: this.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        });
      case 'tools/call':
        return rpcResult(id, await this.callTool(params, parentId));
      default:
        return rpcError(id, -32601, `méthode inconnue : ${msg.method}`);
    }
  }

  private async callTool(params: Record<string, unknown>, parentId: string): Promise<unknown> {
    const tool = this.tools.find((t) => t.name === params.name);
    if (!tool) return toolError(`Outil inconnu : ${String(params.name)}`);
    try {
      const result = await tool.handler(asObject(params.arguments), parentId);
      return { content: [{ type: 'text', text: JSON.stringify(result ?? { ok: true }, null, 2) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`outil ${tool.name} : ${message}`);
      return toolError(message);
    }
  }

  // ---------------------------------------------------------------- Outils

  /** Thread enfant du thread principal appelant, sinon erreur. */
  private ownThread(threadId: string, parentId: string): ThreadInfo {
    const t = this.orch.getThread(threadId);
    if (!t || t.parentId !== parentId) {
      throw new ToolInputError('Thread inconnu ou n\'appartenant pas à ce thread principal : ' + threadId);
    }
    return t;
  }

  private async threadReport(t: ThreadInfo): Promise<Record<string, unknown>> {
    let changedFiles = t.changedFiles;
    try {
      changedFiles = (await this.orch.changedFiles(t.id)).map((f) => f.path);
    } catch {
      // garde la dernière liste connue
    }
    return {
      threadId: t.id,
      title: t.title,
      status: t.status,
      agent: t.agent,
      model: t.model,
      effort: t.effort,
      isolation: t.isolation,
      scope: t.scope,
      changedFiles,
      violations: { scope_violation: t.violations.scope, commit_violation: t.violations.commits },
      summary: t.summary,
      error: t.error,
      lastActivity: t.lastActivity,
      durationSec: durationSecOf(t),
    };
  }

  private buildTools(): ToolDef[] {
    const str = (description: string) => ({ type: 'string', description });
    const threadIdProp = { threadId: str('Identifiant du thread délégué.') };

    return [
      {
        name: 'list_agents',
        description:
          'Liste les agents de codage disponibles avec leurs modèles, niveaux d\'effort et valeurs par défaut. À appeler AVANT de déléguer pour connaître les modèles et niveaux d\'effort valides. ' +
          'Si `effortLevelsByModel` est présent, les efforts valides dépendent du modèle.',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => {
          const allowedModels = this.opts.allowedModels();
          const allowedAgents = this.opts.allowedAgents();
          const agents = (await this.orch.listAgents()).filter(
            (a) => allowedAgents.length === 0 || allowedAgents.includes(a.id),
          );
          return agents.map((a) => {
            const caps = a.capabilities;
            if (!caps || allowedModels.length === 0) return a;
            const models = Array.isArray(caps.models)
              ? caps.models.filter((m) => allowedModels.includes(m.id))
              : allowedModels.map((id) => ({ id }));
            return { ...a, capabilities: { ...caps, models } };
          });
        },
      },
      {
        name: 'delegate',
        description:
          "Délègue une sous-tâche à un agent (crée un thread enfant visible par l'utilisateur). Appelle list_agents d'abord. " +
          "Si `effortLevelsByModel` est présent, les efforts valides dépendent du modèle. " +
          "isolation — shared : le sous-agent travaille directement dans le workspace sur des fichiers distincts ; `scope` (globs des fichiers qu'il peut modifier) est obligatoire en mode edit, et refusé s'il chevauche le scope d'un thread actif. Rapide, pas d'étape d'application. " +
          "worktree : copie isolée (git worktree détaché, sans branche ni commit) ; plusieurs sous-agents peuvent toucher les mêmes fichiers ; il faut ensuite appeler merge_thread pour appliquer le travail (conflits possibles). " +
          'Choisir worktree quand les tâches se recouvrent ou sont risquées, shared pour des fichiers bien séparés. Les sous-agents ne commitent jamais. ' +
          'Retourne { threadId }, ou le résultat final si wait: true.',
        inputSchema: {
          type: 'object',
          properties: {
            agent: { type: 'string', enum: [...AGENT_IDS], description: 'Agent à utiliser.' },
            model: str('Modèle (doit figurer dans list_agents).'),
            effort: str("Niveau d'effort (doit figurer dans list_agents)."),
            prompt: str('Consigne complète et autonome pour le sous-agent.'),
            mode: { type: 'string', enum: ['readonly', 'edit'], description: 'readonly : lecture seule ; edit : peut modifier des fichiers.' },
            isolation: { type: 'string', enum: ['shared', 'worktree'], description: 'Voir la description de l\'outil.' },
            scope: { type: 'array', items: { type: 'string' }, description: 'Globs des fichiers modifiables (obligatoire pour edit + shared).' },
            wait: { type: 'boolean', description: 'Attendre la fin du thread et renvoyer son résultat.' },
          },
          required: ['agent', 'prompt', 'mode'],
        },
        handler: async (args, parentId) => {
          const agent = reqString(args, 'agent') as AgentId;
          if (!AGENT_IDS.includes(agent)) throw new ToolInputError(`agent invalide : "${agent}". Valeurs valides : ${AGENT_IDS.join(', ')}`);
          const allowedAgents = this.opts.allowedAgents();
          if (allowedAgents.length > 0 && !allowedAgents.includes(agent)) {
            throw new ToolInputError(
              `Agent non autorisé pour la délégation : "${agent}". Agents autorisés (agentHub.delegation.allowedAgents) : ${allowedAgents.join(', ')}`,
            );
          }
          const mode = reqString(args, 'mode');
          if (mode !== 'readonly' && mode !== 'edit') throw new ToolInputError('mode doit valoir "readonly" ou "edit"');
          const isolation = optString(args, 'isolation');
          if (isolation !== undefined && isolation !== 'shared' && isolation !== 'worktree') {
            throw new ToolInputError('isolation doit valoir "shared" ou "worktree"');
          }
          const model = optString(args, 'model');
          const allowed = this.opts.allowedModels();
          if (model && allowed.length > 0 && !allowed.includes(model)) {
            throw new ToolInputError(`Modèle non autorisé : "${model}". Modèles autorisés (agentHub.delegation.allowedModels) : ${allowed.join(', ')}`);
          }
          const thread = await this.orch.delegate(parentId, {
            agent,
            model,
            effort: optString(args, 'effort'),
            prompt: reqString(args, 'prompt'),
            mode,
            isolation,
            scope: optStringArray(args, 'scope'),
          });
          if (args.wait === true) return this.threadReport(await this.orch.waitThread(thread.id, MAX_WAIT_SEC));
          return { threadId: thread.id };
        },
      },
      {
        name: 'read_thread',
        description: 'Lit un thread délégué : statut, fichiers modifiés, violations (scope_violation, commit_violation), résumé et derniers événements.',
        inputSchema: {
          type: 'object',
          properties: { ...threadIdProp, last_n: { type: 'number', description: 'Nombre de derniers événements (défaut 20).' } },
          required: ['threadId'],
        },
        handler: async (args, parentId) => {
          const t = this.ownThread(reqString(args, 'threadId'), parentId);
          const lastN = typeof args.last_n === 'number' && args.last_n > 0 ? Math.floor(args.last_n) : 20;
          return { ...(await this.threadReport(t)), events: this.orch.getEvents(t.id, lastN).map(simplifyEvent) };
        },
      },
      {
        name: 'message_thread',
        description:
          'Seul moyen d\'envoyer un message de suivi à un sous-agent : les threads délégués sont en lecture seule pour l\'utilisateur.',
        inputSchema: { type: 'object', properties: { ...threadIdProp, text: str('Message.') }, required: ['threadId', 'text'] },
        handler: async (args, parentId) => {
          const t = this.ownThread(reqString(args, 'threadId'), parentId);
          await this.orch.sendMessage(t.id, reqString(args, 'text'), { from: 'agent' });
          return { ok: true };
        },
      },
      {
        name: 'wait_thread',
        description: 'Attend la fin d\'un thread délégué (ou le délai) et renvoie son état final et son résumé.',
        inputSchema: {
          type: 'object',
          properties: { ...threadIdProp, timeoutSec: { type: 'number', description: `Délai max en secondes (défaut 600, max ${MAX_WAIT_SEC}).` } },
          required: ['threadId'],
        },
        handler: async (args, parentId) => {
          const t = this.ownThread(reqString(args, 'threadId'), parentId);
          const timeout = typeof args.timeoutSec === 'number' && args.timeoutSec > 0 ? Math.min(args.timeoutSec, MAX_WAIT_SEC) : 600;
          return this.threadReport(await this.orch.waitThread(t.id, timeout));
        },
      },
      {
        name: 'list_threads',
        description: 'Liste les threads délégués par ce thread principal et leurs statuts.',
        inputSchema: { type: 'object', properties: {} },
        handler: async (_args, parentId) =>
          this.orch
            .listThreads()
            .filter((t) => t.parentId === parentId)
            .map((t) => ({
              threadId: t.id,
              title: t.title,
              agent: t.agent,
              status: t.status,
              isolation: t.isolation,
              changedFiles: t.changedFiles.length,
              lastActivity: t.lastActivity,
              durationSec: durationSecOf(t),
            })),
      },
      {
        name: 'interrupt_thread',
        description: 'Interrompt un thread délégué.',
        inputSchema: { type: 'object', properties: threadIdProp, required: ['threadId'] },
        handler: async (args, parentId) => {
          const t = this.ownThread(reqString(args, 'threadId'), parentId);
          await this.orch.interrupt(t.id);
          return { ok: true };
        },
      },
      {
        name: 'merge_thread',
        description: "Applique au workspace le travail d'un thread worktree terminé, SANS le commiter. En cas de conflit, l'utilisateur résout dans l'éditeur de fusion.",
        inputSchema: { type: 'object', properties: threadIdProp, required: ['threadId'] },
        handler: async (args, parentId) => {
          const t = this.ownThread(reqString(args, 'threadId'), parentId);
          const result = await this.orch.mergeThread(t.id);
          return { ...result, note: 'Rien n\'a été commité : les modifications sont non commitées dans le workspace.' };
        },
      },
      {
        name: 'commit',
        description:
          "Réservé à l'agent principal, soumis à la permission de commit de l'utilisateur (off/ask/on). Ne commite que les fichiers désignés : fournir threadIds (travail de ces threads) ou paths. Refusé si un fichier appartient à un thread actif ou si un thread worktree n'a pas été appliqué (merge_thread).",
        inputSchema: {
          type: 'object',
          properties: {
            message: str('Message de commit.'),
            threadIds: { type: 'array', items: { type: 'string' }, description: 'Threads dont il faut commiter le travail.' },
            paths: { type: 'array', items: { type: 'string' }, description: 'Chemins relatifs au workspace.' },
          },
          required: ['message'],
        },
        handler: async (args, parentId) => {
          const message = reqString(args, 'message');
          const threadIds = optStringArray(args, 'threadIds');
          const paths = optStringArray(args, 'paths');
          if (!threadIds?.length && !paths?.length) throw new ToolInputError('Fournissez threadIds ou paths : le commit ne porte jamais sur tout le workspace.');
          for (const id of threadIds ?? []) this.ownThread(id, parentId);
          return this.orch.commit({ callerThreadId: parentId, message, threadIds, paths }, this.opts.confirmCommit);
        },
      },
    ];
  }
}

// ---------------------------------------------------------------- utilitaires

function rpcResult(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolError(message: string): unknown {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function reqString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.trim() === '') throw new ToolInputError(`Paramètre "${key}" requis (chaîne non vide).`);
  return v;
}

function optString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new ToolInputError(`Paramètre "${key}" : chaîne attendue.`);
  return v;
}

function optStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new ToolInputError(`Paramètre "${key}" : tableau de chaînes attendu.`);
  return v as string[];
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Durée du thread en secondes : jusqu'à la fin du dernier tour, sinon jusqu'à maintenant. */
function durationSecOf(t: ThreadInfo): number {
  const end = t.finishedAt ?? Date.now();
  return Math.max(0, Math.round((end - t.createdAt) / 1000));
}

function simplifyEvent(e: StoredEvent): Record<string, unknown> {
  const ev = e.event;
  switch (ev.type) {
    case 'assistant_text':
    case 'user_text':
      return { type: ev.type, text: truncate(ev.text, 2000) };
    case 'tool_call':
      return { type: ev.type, name: ev.name };
    case 'tool_result':
      return { type: ev.type, name: ev.name, isError: ev.isError ?? false };
    default:
      return { ...ev };
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('corps trop volumineux'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
