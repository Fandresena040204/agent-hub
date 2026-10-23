import { execFile } from 'child_process';
import { createLogger } from './log';

const log = createLogger('git');

/** Résultat d'une commande git. */
export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Résultat d'une commande git avec stdout en Buffer (pour patchs binaires). */
export interface GitBufferResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/** Options pour l'exécution de git. */
export interface GitOptions {
  /** Entrée à passer sur stdin. */
  input?: string | Buffer;
  /** Si true, ne lève pas d'erreur sur code non-zéro. */
  allowFail?: boolean;
  /** Variables d'environnement additionnelles. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Exécute une commande git et renvoie le résultat.
 * @param cwd Répertoire de travail.
 * @param args Arguments git (ex: ['status', '--porcelain']).
 * @param opts Options d'exécution.
 * @returns Résultat avec code, stdout (string) et stderr.
 * @throws Erreur si code ≠ 0 et allowFail n'est pas true.
 */
export function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024, // 64 Mo
      env: { ...process.env, ...opts.env },
    });

    let stdout = '';
    let stderr = '';

    if (opts.input !== undefined) {
      if (typeof opts.input === 'string') {
        child.stdin?.write(opts.input);
      } else {
        child.stdin?.write(opts.input);
      }
      child.stdin?.end();
    }

    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });

    child.on('close', (code) => {
      if (code !== 0 && !opts.allowFail) {
        const msg = `git ${args.join(' ')} a échoué (code ${code}) : ${stderr.trim()}`;
        log.error(msg);
        reject(new Error(msg));
      } else {
        resolve({ code: code ?? 0, stdout, stderr });
      }
    });

    child.on('error', (err) => {
      const msg = `Impossible de lancer git ${args.join(' ')} : ${err.message}`;
      log.error(msg);
      reject(new Error(msg));
    });
  });
}

/**
 * Exécute une commande git et renvoie stdout en Buffer (pour patchs binaires).
 * @param cwd Répertoire de travail.
 * @param args Arguments git.
 * @param opts Options d'exécution.
 * @returns Résultat avec code, stdout (Buffer) et stderr.
 * @throws Erreur si code ≠ 0 et allowFail n'est pas true.
 */
export function gitBuffer(cwd: string, args: string[], opts: GitOptions = {}): Promise<GitBufferResult> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024, // 64 Mo
      env: { ...process.env, ...opts.env },
    });

    const chunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    if (opts.input !== undefined) {
      if (typeof opts.input === 'string') {
        child.stdin?.write(opts.input);
      } else {
        child.stdin?.write(opts.input);
      }
      child.stdin?.end();
    }

    child.stdout?.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.stderr?.on('data', (chunk: Buffer | string) => stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));

    child.on('close', (code) => {
      const stdout = Buffer.concat(chunks);
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code !== 0 && !opts.allowFail) {
        const msg = `git ${args.join(' ')} a échoué (code ${code}) : ${stderr.trim()}`;
        log.error(msg);
        reject(new Error(msg));
      } else {
        resolve({ code: code ?? 0, stdout, stderr });
      }
    });

    child.on('error', (err) => {
      const msg = `Impossible de lancer git ${args.join(' ')} : ${err.message}`;
      log.error(msg);
      reject(new Error(msg));
    });
  });
}