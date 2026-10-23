import { spawn, execFile, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** File asynchrone simple : push() côté producteur, for-await côté consommateur. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/** Processus enfants vivants, tués à la désactivation de l'extension. */
const liveChildren = new Set<ChildProcess>();

export interface SpawnedCli {
  child: ChildProcess;
  /** Résolu au code de sortie (null si tué par signal). */
  exited: Promise<number | null>;
}

/**
 * Résout un nom de commande en exécutable lançable sans shell.
 * Sur Windows, suit les shims npm (.cmd) jusqu'au .exe ou au script .js qu'ils appellent,
 * pour éviter cmd.exe (qui casse les arguments multi-lignes).
 */
export function resolveCommand(command: string): { file: string; prefixArgs: string[]; shell: boolean } {
  if (process.platform !== 'win32') return { file: command, prefixArgs: [], shell: false };
  const exts = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase());
  const hasExt = path.extname(command) !== '';
  const dirs = path.isAbsolute(command) || command.includes('\\') || command.includes('/')
    ? ['']
    : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of hasExt ? [''] : ['.exe', '.cmd', '.bat', ...exts]) {
      const candidate = dir ? path.join(dir, command + ext) : command + ext;
      if (!fs.existsSync(candidate) || fs.statSync(candidate).isDirectory()) continue;
      const lower = candidate.toLowerCase();
      if (lower.endsWith('.exe')) return { file: candidate, prefixArgs: [], shell: false };
      if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
        const text = fs.readFileSync(candidate, 'utf8');
        const m = /"%(?:dp0|~dp0)%\\?([^"]+\.(exe|js|cjs|mjs))"/i.exec(text);
        if (m) {
          const target = path.join(path.dirname(candidate), m[1]);
          if (fs.existsSync(target)) {
            return m[2].toLowerCase() === 'exe'
              ? { file: target, prefixArgs: [], shell: false }
              : { file: 'node', prefixArgs: [target], shell: false };
          }
        }
        return { file: candidate, prefixArgs: [], shell: true };
      }
    }
  }
  return { file: command, prefixArgs: [], shell: false };
}

/**
 * Lance un CLI et découpe stdout/stderr en lignes.
 * Sur Windows, les shims npm sont résolus (resolveCommand) ; le shell n'est utilisé qu'en dernier recours.
 */
export function spawnCli(
  command: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; stdin?: 'pipe' | 'ignore' },
  onLine: (stream: 'stdout' | 'stderr', line: string) => void,
): SpawnedCli {
  const isWin = process.platform === 'win32';
  const resolved = resolveCommand(command);
  const fullArgs = [...resolved.prefixArgs, ...args];
  const child = spawn(resolved.shell ? quoteWin(resolved.file) : resolved.file, resolved.shell ? fullArgs.map(quoteWin) : fullArgs, {
    cwd: opts.cwd,
    // PWD hérité du parent ferait travailler certains CLI (OpenCode/Bun) dans le mauvais dossier.
    env: { ...(opts.env ?? process.env), PWD: opts.cwd },
    shell: resolved.shell,
    windowsHide: true,
    detached: !isWin,
    stdio: [opts.stdin ?? 'ignore', 'pipe', 'pipe'],
  });
  liveChildren.add(child);

  for (const stream of ['stdout', 'stderr'] as const) {
    let buf = '';
    child[stream]?.setEncoding('utf8');
    child[stream]?.on('data', (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line.length) onLine(stream, line);
      }
    });
    child[stream]?.on('end', () => {
      if (buf.length) onLine(stream, buf.replace(/\r$/, ''));
      buf = '';
    });
  }

  const exited = new Promise<number | null>((resolve) => {
    child.on('error', (err) => {
      liveChildren.delete(child);
      onLine('stderr', `spawn error: ${err.message}`);
      resolve(-1);
    });
    child.on('close', (code) => {
      liveChildren.delete(child);
      resolve(code);
    });
  });

  return { child, exited };
}

/** Tue le processus et toute son arborescence (taskkill /T sur Windows, groupe de processus ailleurs). */
export function killTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.pid === undefined) return resolve();
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => resolve());
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
      resolve();
    }
  });
}

export async function killAllChildren(): Promise<void> {
  await Promise.all([...liveChildren].map(killTree));
}

/** Exécute un CLI jusqu'au bout et renvoie stdout (pour --help, listes de modèles…). */
export function runCli(command: string, args: string[], cwd?: string, timeoutMs = 30000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const out: string[] = [];
    const err: string[] = [];
    const { child, exited } = spawnCli(command, args, { cwd: cwd ?? process.cwd() }, (s, l) => (s === 'stdout' ? out : err).push(l));
    const timer = setTimeout(() => void killTree(child), timeoutMs);
    void exited.then((code) => {
      clearTimeout(timer);
      resolve({ code, stdout: out.join('\n'), stderr: err.join('\n') });
    });
  });
}

function quoteWin(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"&|<>^%()!]/.test(arg)) return arg;
  // Dernier recours (shell cmd.exe) : les retours à la ligne ne passent pas, on les remplace.
  return `"${arg.replace(/\r?\n/g, ' ').replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/** Parse une ligne JSON ; renvoie undefined (et logue) si invalide. */
export function parseJsonLine(line: string, log?: (msg: string) => void): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(line);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  } catch {
    log?.(`ligne JSON invalide ignorée : ${line.slice(0, 200)}`);
    return undefined;
  }
}
