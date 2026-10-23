// Base commune aux adaptateurs qui pilotent un CLI (un processus par tour).

import type { ChildProcess } from 'child_process';
import type { AgentEvent } from '../core/events';
import type { AgentId } from '../core/types';
import { createLogger, type Logger } from '../core/log';
import type { AgentCapabilities, AgentRun, StartOptions } from './AgentAdapter';
import { validateOptions } from './AgentAdapter';
import { AsyncQueue, killTree, parseJsonLine, runCli, spawnCli } from './process';

export interface CliLaunchConfig {
  id: AgentId;
  command: string;
  prefixArgs?: string[];
  /** Variables d'environnement ajoutées au processus CLI (jamais de secret logué). */
  env?: NodeJS.ProcessEnv;
}

export type RawLineCallback = (stream: 'stdout' | 'stderr', line: string) => void;

/** État d'un tour (un processus CLI) transmis aux parseurs des adaptateurs. */
export class TurnContext {
  readonly toolCalls = new Map<string, { name: string; input: unknown }>();
  readonly stderr: string[] = [];
  lastText = '';
  spawnFailed = false;
  /** Événement final produit par le parseur (result, erreur…), émis à la sortie du processus. */
  outcome?: AgentEvent;

  constructor(
    readonly opts: StartOptions,
    readonly text: string,
    readonly index: number,
    private readonly emitFn: (e: AgentEvent) => void,
    private readonly adoptSession: (id: string) => void,
    private readonly currentSession: () => string | undefined,
  ) {}

  emit(event: AgentEvent): void {
    this.emitFn(event);
  }

  setSessionId(id: string): void {
    this.adoptSession(id);
  }

  get sessionId(): string | undefined {
    return this.currentSession();
  }
}

/**
 * Implémentation générique d'AgentRun.
 * Les sous-classes ne fournissent que les args d'un tour et le parseur de lignes.
 */
export abstract class CliAgentRun implements AgentRun {
  readonly events: AsyncIterable<AgentEvent>;
  readonly onRawLine = (cb: RawLineCallback): void => {
    this.rawCallbacks.push(cb);
  };

  protected readonly log: Logger;

  private readonly queue = new AsyncQueue<AgentEvent>();
  private readonly rawCallbacks: RawLineCallback[] = [];
  private readonly pending: string[] = [];
  private current?: ChildProcess;
  private draining = false;
  private closed = false;
  private session?: string;
  private turnIndex = 0;

  constructor(protected readonly launch: CliLaunchConfig, protected readonly opts: StartOptions) {
    this.events = this.queue;
    this.log = createLogger(`adapter:${launch.id}`);
    this.session = opts.sessionId;
    // Différé : les champs des sous-classes sont initialisés après super().
    void Promise.resolve()
      .then(() => this.bootstrap())
      .catch((err: unknown) => {
        this.push({ type: 'error', message: `démarrage impossible : ${err instanceof Error ? err.message : String(err)}` });
        this.closed = true;
        this.queue.close();
      });
  }

  /** Construit les arguments d'un tour (sans prefixArgs). */
  protected abstract buildArgs(ctx: TurnContext): string[];

  /** Traite une ligne stdout JSON du CLI. */
  protected abstract parseLine(line: string, ctx: TurnContext): void;

  /** Validation spécifique au CLI ; lève InvalidOptionError. */
  protected validateCaps(caps: AgentCapabilities): void {
    validateOptions(caps, this.opts.model, this.opts.effort);
  }

  /** Événement de fin de tour quand le parseur n'a rien produit d'explicite. */
  protected onExit(ctx: TurnContext, code: number | null, stderr: string[]): AgentEvent {
    if (ctx.spawnFailed) return { type: 'error', message: this.notFoundMessage() };
    if (code !== 0) {
      const tail = stderr.filter((l) => l.trim() !== '').slice(-5).join(' | ').slice(0, 500);
      return {
        type: 'error',
        message: `CLI ${this.launch.id} a échoué (code ${code === null ? 'signal' : code})${tail ? ` : ${tail}` : ''}`,
      };
    }
    return { type: 'done', summary: ctx.lastText.trim() || 'Tâche terminée' };
  }

  sendMessage(text: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.queue.push({ type: 'user_text', text });
    this.pending.push(text);
    void this.drain();
    return Promise.resolve();
  }

  async interrupt(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.pending.length = 0;
    const child = this.current;
    this.current = undefined;
    this.queue.close();
    if (child) await killTree(child);
  }

  /** Pousse un événement dans le flux (sauf si déjà fermé). */
  protected push(event: AgentEvent): void {
    if (!this.closed) this.queue.push(event);
  }

  private async bootstrap(): Promise<void> {
    let caps: AgentCapabilities;
    try {
      caps = await this.fetchCaps();
    } catch (err) {
      this.log.warn(`capabilities indisponibles : ${err instanceof Error ? err.message : String(err)}`);
      caps = { models: 'free-text', effortLevels: null };
    }
    try {
      this.validateCaps(caps);
    } catch (err) {
      this.push({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      this.closed = true;
      this.queue.close();
      return;
    }
    this.pending.push(this.opts.prompt);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.closed && this.pending.length > 0) {
        const text = this.pending.shift()!;
        try {
          await this.runTurn(text);
        } catch (err) {
          this.push({ type: 'error', message: `tour interrompu : ${err instanceof Error ? err.message : String(err)}` });
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async runTurn(text: string): Promise<void> {
    if (this.closed) return;
    const ctx = new TurnContext(
      this.opts,
      text,
      this.turnIndex++,
      (e) => this.push(e),
      (id) => this.adoptSession(id),
      () => this.session,
    );
    let args: string[];
    try {
      args = this.buildArgs(ctx);
    } catch (err) {
      this.push({ type: 'error', message: `arguments du CLI invalides : ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    try {
      const { child, exited } = spawnCli(
        this.launch.command,
        [...(this.launch.prefixArgs ?? []), ...args],
        { cwd: this.opts.cwd, env: { ...process.env, ...this.launch.env } },
        (stream, line) => {
          this.emitRaw(stream, line);
          if (stream === 'stderr') {
            if (/^spawn error:/i.test(line)) ctx.spawnFailed = true;
            ctx.stderr.push(line);
            return;
          }
          try {
            this.parseLine(line, ctx);
          } catch (err) {
            this.log.warn(`parseur : ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      );
      this.current = child;
      const code = await exited;
      this.current = undefined;
      if (this.closed) return;
      const event = ctx.outcome ?? this.onExit(ctx, code, ctx.stderr);
      this.push(event);
    } catch (err) {
      this.current = undefined;
      if (this.closed) return;
      this.push({
        type: 'error',
        message: `impossible de lancer le CLI ${this.launch.id} : ${err instanceof Error ? err.message : String(err)} (réglage agentHub.${this.launch.id}.path)`,
      });
    }
  }

  private adoptSession(id: string): void {
    if (this.session === id) return;
    this.session = id;
    this.push({ type: 'session_started', sessionId: id });
  }

  private emitRaw(stream: 'stdout' | 'stderr', line: string): void {
    for (const cb of this.rawCallbacks) {
      try {
        cb(stream, line);
      } catch (err) {
        this.log.warn(`callback ligne brute : ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private notFoundMessage(): string {
    return `CLI ${this.launch.id} introuvable (réglage agentHub.${this.launch.id}.path)`;
  }

  /** Découverte des capabilities (généralement déléguée à l'adaptateur, qui met en cache). */
  protected abstract fetchCaps(): Promise<AgentCapabilities>;

  protected parseJson(line: string): Record<string, unknown> | undefined {
    return parseJsonLine(line, (msg) => this.log.warn(msg));
  }
}

/** Lance `<cli> --version` ; ne lève jamais. */
export async function checkCliAvailable(
  command: string,
  prefixArgs: string[] = [],
): Promise<{ ok: boolean; detail?: string }> {
  try {
    const r = await runCli(command, [...prefixArgs, '--version']);
    const detail = (r.stdout.trim() || r.stderr.trim()).split(/\r?\n/)[0] ?? '';
    return r.code === 0 ? { ok: true, detail } : { ok: false, detail: detail || `code ${r.code}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function asNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
