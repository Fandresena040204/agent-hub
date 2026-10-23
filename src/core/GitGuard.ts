import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from './log';
import { git } from './git';

const log = createLogger('GitGuard');

/**
 * Obtient le HEAD actuel (sha du commit) ou undefined si pas de commit.
 */
export async function getHead(cwd: string): Promise<string | undefined> {
  const result = await git(cwd, ['rev-parse', 'HEAD'], { allowFail: true });
  if (result.code !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

/**
 * Watcher de changement de HEAD.
 * check() ne signale chaque changement qu'une fois.
 */
export class HeadWatcher {
  private currentHead: string | undefined;
  private readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /**
   * Initialise la référence actuelle.
   */
  async start(): Promise<void> {
    this.currentHead = await getHead(this.cwd);
    log.info(`HeadWatcher démarré sur ${this.cwd} : HEAD = ${this.currentHead ?? '(aucun commit)'}`);
  }

  /**
   * Aligne la référence sans signaler de violation (commit fait par l'Orchestrator).
   */
  acknowledge(head: string): void {
    this.currentHead = head;
  }

  /**
   * Vérifie si HEAD a changé depuis le dernier check().
   * @returns { oldHead, newHead } si changé, undefined sinon.
   */
  async check(): Promise<{ oldHead: string; newHead: string } | undefined> {
    const newHead = await getHead(this.cwd);
    if (newHead !== this.currentHead && this.currentHead !== undefined && newHead !== undefined) {
      const oldHead = this.currentHead;
      this.currentHead = newHead;
      log.info(`HEAD changé : ${oldHead.slice(0, 8)} -> ${newHead.slice(0, 8)}`);
      return { oldHead, newHead };
    }
    if (newHead !== undefined) {
      this.currentHead = newHead;
    }
    return undefined;
  }
}

/**
 * Résout le chemin du répertoire git réel.
 */
async function getGitDir(repo: string): Promise<string> {
  const result = await git(repo, ['rev-parse', '--git-dir'], { allowFail: true });
  if (result.code === 0) {
    const gitDir = result.stdout.trim();
    return path.isAbsolute(gitDir) ? gitDir : path.join(repo, gitDir);
  }
  return path.join(repo, '.git');
}

/**
 * Vérifie si une fusion/rebase/cherry-pick est en cours.
 */
export async function mergeInProgress(repo: string): Promise<boolean> {
  const gitDir = await getGitDir(repo);

  // Vérifier les fichiers de référence git
  const checks = [
    'MERGE_HEAD',
    'REBASE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'BISECT_LOG',
  ];

  for (const ref of checks) {
    const refPath = path.join(gitDir, ref);
    if (fs.existsSync(refPath)) return true;
  }

  // Vérifier s'il y a des fichiers non fusionnés
  const unmerged = await git(repo, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true });
  if (unmerged.code === 0 && unmerged.stdout.trim()) return true;

  return false;
}

/**
 * Détecte les fichiers contenant des marqueurs de conflit parmi une liste de chemins.
 */
export async function filesWithConflictMarkers(repo: string, paths: string[]): Promise<string[]> {
  const conflicted: string[] = [];
  const markers = ['<<<<<<< ', '=======', '>>>>>>> '];

  for (const relPath of paths) {
    const fullPath = path.join(repo, relPath);
    if (!fs.existsSync(fullPath)) continue;

    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      for (const marker of markers) {
        if (content.includes(marker)) {
          conflicted.push(relPath);
          break;
        }
      }
    } catch {
      // Ignorer erreurs de lecture
    }
  }
  return conflicted;
}

/**
 * Génère un résumé de diff pour une liste de chemins.
 */
export async function diffSummary(repo: string, paths: string[]): Promise<string> {
  if (paths.length === 0) return '(aucun fichier)';

  // Diff stat pour les fichiers suivis
  const diffResult = await git(repo, ['diff', 'HEAD', '--stat', '--', ...paths], { allowFail: true });
  let summary = diffResult.stdout.trim();

  // Fichiers non suivis parmi paths
  const untracked: string[] = [];
  for (const p of paths) {
    const full = path.join(repo, p);
    if (fs.existsSync(full)) {
      const tracked = await git(repo, ['ls-files', '--error-unmatch', p], { allowFail: true });
      if (tracked.code !== 0) {
        untracked.push(p);
      }
    }
  }

  if (untracked.length > 0) {
    const untrackedStr = untracked.map(p => `  ${p} (non suivi)`).join('\n');
    summary = summary ? `${summary}\n${untrackedStr}` : untrackedStr;
  }

  return summary || '(aucune modification)';
}

/**
 * Commit les chemins spécifiés avec un message.
 * JAMAIS de -a, --amend, push.
 */
export async function commitPaths(
  repo: string,
  paths: string[],
  message: string,
): Promise<{ sha: string }> {
  if (paths.length === 0) {
    throw new Error('commitPaths: liste de chemins vide');
  }

  // git add -- <paths>
  await git(repo, ['add', '--', ...paths]);

  // git commit -m <message> --only -- <paths>
  const result = await git(repo, ['commit', '-m', message, '--only', '--', ...paths]);
  // Output format: "[branchName commitSha] message" or "commitSha message"
  const match = result.stdout.match(/\[(?:[^\]]+\s+)?([0-9a-f]{7,40})\]|\b([0-9a-f]{7,40})\b/);
  const sha = match?.[1] || match?.[2];
  if (!sha) {
    throw new Error(`Impossible de récupérer le SHA du commit : ${result.stdout}`);
  }
  return { sha };
}

/**
 * Capture l'état (contenu ou undefined si absent) d'une liste de fichiers.
 * Utilisé pour le diff par thread en mode shared.
 */
export function snapshotFiles(repo: string, relPaths: string[]): Map<string, string | undefined> {
  const snapshot = new Map<string, string | undefined>();
  for (const relPath of relPaths) {
    const fullPath = path.join(repo, relPath);
    try {
      snapshot.set(relPath, fs.readFileSync(fullPath, 'utf8'));
    } catch {
      snapshot.set(relPath, undefined);
    }
  }
  return snapshot;
}

/**
 * Retourne la liste des chemins modifiés/ajoutés/supprimés/non suivis (relatifs au repo).
 * Utilise git status --porcelain -z -uall.
 */
export async function statusPaths(repo: string): Promise<string[]> {
  const result = await git(repo, ['status', '--porcelain', '-z', '-uall']);
  const entries = result.stdout.split('\0').filter(Boolean);
  const paths: string[] = [];

  for (const entry of entries) {
    // Format porcelain: XY path (ou XY path1 -> path2 pour renommage)
    if (entry.length < 3) continue;
    const statusPath = entry.slice(3);
    // Gérer les renommages (path1 -> path2)
    const arrowIdx = statusPath.indexOf(' -> ');
    const finalPath = arrowIdx >= 0 ? statusPath.slice(arrowIdx + 4) : statusPath;
    paths.push(finalPath);
  }

  return paths;
}