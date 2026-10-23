import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createLogger } from './log';
import { git, gitBuffer } from './git';

const log = createLogger('Worktrees');

/** Métadonnées d'un worktree stockées sur disque. */
interface WorktreeMeta {
  threadId: string;
  path: string;
  baseTree: string;
  linkPaths: string[];
  createdAt: number;
}

/** Résultat de la création d'un worktree. */
export interface CreateWorktreeResult {
  path: string;
  baseTree: string;
  warning?: string;
}

/**
 * Gestion des worktrees git pour le mode isolation 'worktree'.
 * AUCUNE branche, AUCUN commit créés par ce module.
 */
export class Worktrees {
  private readonly repoRoot: string;
  private readonly worktreesDir: string;

  /**
   * @param repoRoot Racine du dépôt git principal (workspace).
   * @param storageDir Dossier de stockage (ex: globalStorage/worktrees).
   */
  constructor(repoRoot: string, storageDir: string) {
    this.repoRoot = repoRoot;
    // storageDir utilisé via worktreesDir
    this.worktreesDir = path.join(storageDir, 'worktrees');
    if (!fs.existsSync(this.worktreesDir)) {
      fs.mkdirSync(this.worktreesDir, { recursive: true });
    }
  }

  /**
   * Vérifie si un répertoire est un dépôt git.
   */
  static async isGitRepo(dir: string): Promise<boolean> {
    try {
      await git(dir, ['rev-parse', '--git-dir'], { allowFail: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Chemin du worktree pour un thread.
   */
  path(threadId: string): string {
    return path.join(this.worktreesDir, threadId);
  }

  /**
   * Vérifie si un worktree existe pour ce thread.
   */
  exists(threadId: string): boolean {
    return fs.existsSync(this.path(threadId));
  }

  /**
   * Chemin du fichier de métadonnées.
   */
  private metaFile(threadId: string): string {
    return path.join(this.worktreesDir, `${threadId}.json`);
  }

  /**
   * Chemin du fichier de liens.
   */
  private linksFile(threadId: string): string {
    return path.join(this.worktreesDir, `${threadId}.links.json`);
  }

  /**
   * Crée un worktree détaché pour un thread.
   * @param threadId Identifiant du thread.
   * @param options Options de création.
   * @returns Chemin du worktree et tree de base.
   */
  async create(
    threadId: string,
    options: { includeUncommitted: boolean; linkPaths: string[] },
  ): Promise<CreateWorktreeResult> {
    const worktreePath = this.path(threadId);

    if (fs.existsSync(worktreePath)) {
      throw new Error(`Worktree existe déjà pour thread ${threadId}`);
    }

    // 1. git worktree add --detach <path> HEAD
    await git(this.repoRoot, ['worktree', 'add', '--detach', worktreePath, 'HEAD']);

    let warning: string | undefined;
    let baseTree: string;

    try {
      if (options.includeUncommitted) {
        // 2a. Reproduire modifications non commitées : diff HEAD --binary -> apply dans worktree
        const diffResult = await gitBuffer(this.repoRoot, ['diff', 'HEAD', '--binary'], { allowFail: true });
        if (diffResult.code === 0 && diffResult.stdout.length > 0) {
          await gitBuffer(worktreePath, ['apply', '--binary'], { input: diffResult.stdout });
        }
        // Fichiers non suivis
        const untrackedResult = await git(this.repoRoot, ['ls-files', '--others', '--exclude-standard', '-z'], { allowFail: true });
        if (untrackedResult.code === 0 && untrackedResult.stdout) {
          const files = untrackedResult.stdout.split('\0').filter(Boolean);
          for (const file of files) {
            const src = path.join(this.repoRoot, file);
            const dst = path.join(worktreePath, file);
            if (fs.existsSync(src)) {
              const dstDir = path.dirname(dst);
              if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });
              fs.copyFileSync(src, dst);
            }
          }
        }
      } else {
        // 2b. Vérifier s'il y a des modifications non commitées dans le workspace
        const status = await git(this.repoRoot, ['status', '--porcelain'], { allowFail: true });
        if (status.code === 0 && status.stdout.trim()) {
          warning = 'Le worktree part de HEAD : les modifications non commitées du workspace n\'y sont pas.';
        }
      }

      // 3. linkPaths : créer junctions/symlinks
      const createdLinks: string[] = [];
      for (const linkPath of options.linkPaths) {
        const src = path.join(this.repoRoot, linkPath);
        const dst = path.join(worktreePath, linkPath);
        if (fs.existsSync(src)) {
          const dstDir = path.dirname(dst);
          if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });
          try {
            if (process.platform === 'win32') {
              fs.symlinkSync(src, dst, 'junction');
            } else {
              fs.symlinkSync(src, dst, 'dir');
            }
            createdLinks.push(linkPath);
          } catch (err) {
            log.warn(`Échec lien pour ${linkPath}, copie récursive : ${err}`);
            this.copyRecursive(src, dst);
            createdLinks.push(linkPath);
          }
        }
      }

      // Sauvegarder la liste des liens
      fs.writeFileSync(this.linksFile(threadId), JSON.stringify(createdLinks, null, 2), 'utf8');

      // 4. État de départ : git add -A (excluant linkPaths) + git write-tree
      baseTree = await this.computeTree(worktreePath, options.linkPaths);

      // Sauvegarder métadonnées
      const meta: WorktreeMeta = {
        threadId,
        path: worktreePath,
        baseTree,
        linkPaths: createdLinks,
        createdAt: Date.now(),
      };
      fs.writeFileSync(this.metaFile(threadId), JSON.stringify(meta, null, 2), 'utf8');

      return { path: worktreePath, baseTree, warning };
    } catch (err) {
      // Nettoyage en cas d'échec
      try {
        await this.remove(threadId);
      } catch {}
      throw err;
    }
  }

  /**
   * Calcule le tree actuel du worktree (git add -A + write-tree).
   */
  async currentTree(threadId: string): Promise<string> {
    const worktreePath = this.path(threadId);
    if (!fs.existsSync(worktreePath)) {
      throw new Error(`Worktree introuvable pour thread ${threadId}`);
    }

    const meta = this.loadMeta(threadId);
    return this.computeTree(worktreePath, meta.linkPaths);
  }

  /**
   * Résout le répertoire git réel d'un worktree (peut être un fichier .git pointant vers le gitdir principal).
   */
  private resolveGitDir(worktreePath: string): string {
    const gitFile = path.join(worktreePath, '.git');
    if (fs.existsSync(gitFile)) {
      const stat = fs.statSync(gitFile);
      if (stat.isFile()) {
        const content = fs.readFileSync(gitFile, 'utf8').trim();
        const match = content.match(/^gitdir:\s*(.+)$/);
        if (match) {
          const gitDir = match[1].trim();
          return path.isAbsolute(gitDir) ? gitDir : path.join(worktreePath, gitDir);
        }
      }
    }
    return path.join(worktreePath, '.git');
  }

  /**
   * Calcule le tree git après git add -A avec exclusions.
   */
  private async computeTree(worktreePath: string, excludePaths: string[]): Promise<string> {
    // Créer un fichier d'exclusion temporaire dans le vrai répertoire git
    const gitDir = this.resolveGitDir(worktreePath);
    const excludesFile = path.join(gitDir, 'worktree-excludes');
    const excludeContent = excludePaths.map(p => p.replace(/\\/g, '/')).join('\n') + '\n';
    fs.writeFileSync(excludesFile, excludeContent, 'utf8');

    try {
      // git add -A avec core.excludesFile
      await git(worktreePath, ['-c', `core.excludesFile=${excludesFile}`, 'add', '-A']);
      // git write-tree
      const result = await git(worktreePath, ['write-tree']);
      return result.stdout.trim();
    } finally {
      try { fs.unlinkSync(excludesFile); } catch {}
    }
  }

  /**
   * Charge les métadonnées d'un worktree.
   */
  private loadMeta(threadId: string): WorktreeMeta {
    const file = this.metaFile(threadId);
    if (!fs.existsSync(file)) {
      throw new Error(`Métadonnées worktree introuvables pour ${threadId}`);
    }
    return JSON.parse(fs.readFileSync(file, 'utf8')) as WorktreeMeta;
  }

  /**
   * Retourne les fichiers modifiés depuis la création du worktree.
   */
  async changedFiles(threadId: string): Promise<string[]> {
    const meta = this.loadMeta(threadId);
    const currentTree = await this.currentTree(threadId);

    if (meta.baseTree === currentTree) return [];

    const result = await git(this.path(threadId), ['diff', '--name-only', meta.baseTree, currentTree]);
    return result.stdout.trim().split('\n').filter(Boolean);
  }

  /**
   * Retourne le contenu d'un fichier à l'état de base (baseTree).
   */
  async fileAtBase(threadId: string, relPath: string): Promise<string | undefined> {
    const meta = this.loadMeta(threadId);
    const result = await git(this.path(threadId), ['show', `${meta.baseTree}:${relPath}`], { allowFail: true });
    if (result.code !== 0) return undefined;
    return result.stdout;
  }

  /**
   * Contenu binaire d'un fichier à l'état de base (undefined s'il n'existait pas).
   */
  async fileAtBaseBuffer(threadId: string, relPath: string): Promise<Buffer | undefined> {
    const meta = this.loadMeta(threadId);
    const result = await gitBuffer(this.path(threadId), ['show', `${meta.baseTree}:${relPath}`], { allowFail: true });
    if (result.code !== 0) return undefined;
    return result.stdout;
  }

  /**
   * Statistiques +N/−N par fichier entre baseTree et l'état actuel du worktree.
   * `additions`/`deletions` valent undefined pour un fichier binaire.
   */
  async numstat(threadId: string): Promise<Map<string, { additions?: number; deletions?: number }>> {
    const meta = this.loadMeta(threadId);
    const currentTree = await this.currentTree(threadId);
    const out = new Map<string, { additions?: number; deletions?: number }>();
    if (meta.baseTree === currentTree) return out;

    const result = await git(
      this.path(threadId),
      ['diff', '--numstat', '-z', meta.baseTree, currentTree],
      { allowFail: true },
    );
    if (result.code !== 0) return out;

    const entries = result.stdout.split('\0');
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;
      const firstTab = entry.indexOf('\t');
      const secondTab = entry.indexOf('\t', firstTab + 1);
      if (firstTab < 0 || secondTab < 0) continue;
      const added = entry.slice(0, firstTab);
      const removed = entry.slice(firstTab + 1, secondTab);
      let rel = entry.slice(secondTab + 1);
      if (!rel) {
        // Renommage : l'ancien puis le nouveau chemin suivent en entrées séparées.
        const oldPath = entries[i + 1] ?? '';
        const newPath = entries[i + 2] ?? '';
        i += 2;
        rel = newPath || oldPath;
      }
      if (!rel) continue;
      const binary = added === '-' || removed === '-';
      out.set(
        rel.replace(/\\/g, '/'),
        binary
          ? { additions: undefined, deletions: undefined }
          : { additions: Number.parseInt(added, 10), deletions: Number.parseInt(removed, 10) },
      );
    }
    return out;
  }

  /**
   * Restaure un fichier du worktree à l'état de base (baseTree).
   * Fichier absent de la base → supprimé. Ne touche jamais à l'index.
   */
  async restoreFile(threadId: string, relPath: string): Promise<void> {
    const worktreePath = this.path(threadId);
    if (!fs.existsSync(worktreePath)) {
      throw new Error(`Worktree introuvable pour thread ${threadId}`);
    }
    const root = path.resolve(worktreePath);
    const abs = path.resolve(root, relPath);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error(`Chemin hors du worktree : ${relPath}`);
    }

    const base = await this.fileAtBaseBuffer(threadId, relPath);
    if (base === undefined) {
      try {
        fs.unlinkSync(abs);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      return;
    }
    this.ensureDirAndWrite(abs, base);
  }

  /**
   * Génère un patch binaire entre baseTree et currentTree.
   */
  async diffPatch(threadId: string): Promise<Buffer> {
    const meta = this.loadMeta(threadId);
    const currentTree = await this.currentTree(threadId);

    if (meta.baseTree === currentTree) return Buffer.alloc(0);

    const result = await gitBuffer(this.path(threadId), ['diff', '--binary', '--full-index', meta.baseTree, currentTree]);
    return result.stdout;
  }

  /**
   * Applique le patch du worktree dans le repo principal.
   * Nouvel algorithme sûr :
   * 1. --check --binary → applied direct
   * 2. --3way --binary si workspace propre par rapport à l'index
   * 3. Sinon merge-file fichier par fichier (sans toucher à l'index)
   * Jamais de --reject, jamais de perte de données.
   */
  async apply(threadId: string): Promise<{
    status: 'applied' | 'conflict' | 'empty';
    files: string[];
    conflicted: string[];
    detail?: string;
  }> {
    const patch = await this.diffPatch(threadId);
    if (patch.length === 0) {
      return { status: 'empty', files: [], conflicted: [] };
    }

    const files = await this.changedFiles(threadId);
    if (files.length === 0) {
      return { status: 'empty', files: [], conflicted: [] };
    }

    // Étape 1 : git apply --check --binary (sans toucher à l'index)
    const checkResult = await gitBuffer(this.repoRoot, ['apply', '--check', '--binary'], { input: patch, allowFail: true });
    if (checkResult.code === 0) {
      // Appliquer directement sans utiliser l'index
      const applyResult = await gitBuffer(this.repoRoot, ['apply', '--binary'], { input: patch, allowFail: true });
      if (applyResult.code === 0) {
        // Les fichiers sont modifiés dans le workspace, pas dans l'index
        return { status: 'applied', files, conflicted: [] };
      }
      // Si --check passe mais apply échoue (rare), on continue vers les autres stratégies
      log.warn(`git apply --check OK mais apply échoué : ${applyResult.stderr}`);
    }

    // Étape 2 : git apply --3way --binary SEULEMENT si workspace propre par rapport à l'index pour ces fichiers
    const dirtyCheck = await git(this.repoRoot, ['diff', '--name-only', '--', ...files], { allowFail: true });
    const workspaceClean = dirtyCheck.code === 0 && !dirtyCheck.stdout.trim();

    if (workspaceClean) {
      const threeWayResult = await gitBuffer(this.repoRoot, ['apply', '--3way', '--binary'], { input: patch, allowFail: true });
      if (threeWayResult.code === 0) {
        // Succès --3way : laisser les changements non indexés
        await git(this.repoRoot, ['reset', '-q', '--', ...files]);
        // Vérifier s'il y a des conflits (marqueurs)
        const unmerged = await git(this.repoRoot, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true });
        if (unmerged.code === 0 && unmerged.stdout.trim()) {
          const conflicted = unmerged.stdout.trim().split('\n').filter(Boolean);
          return {
            status: 'conflict',
            files,
            conflicted,
            detail: 'Conflits de fusion détectés (marqueurs laissés pour l\'éditeur de fusion VS Code)',
          };
        }
        return { status: 'applied', files, conflicted: [] };
      }
      // --3way a échoué (ex: blob absent), on continue vers merge-file
      log.warn(`git apply --3way échoué : ${threeWayResult.stderr}`);
    } else {
      log.info('Workspace sale pour les fichiers du patch, passage à merge-file');
    }

    // Étape 3 : merge-file fichier par fichier (sans toucher à l'index)
    return this.applyWithMergeFile(threadId, files);
  }

  /**
   * Fusion fichier par fichier avec git merge-file.
   * Ne touche jamais à l'index. Laisse les marqueurs de conflit dans le workspace.
   */
  private async applyWithMergeFile(
    threadId: string,
    files: string[],
  ): Promise<{
    status: 'applied' | 'conflict' | 'empty';
    files: string[];
    conflicted: string[];
    detail?: string;
  }> {
    const conflictedFiles: string[] = [];
    const processedFiles: string[] = [];

    for (const relPath of files) {
      try {
        const result = await this.mergeSingleFile(threadId, relPath);
        processedFiles.push(relPath);
        if (result === 'conflict') {
          conflictedFiles.push(relPath);
        }
      } catch (err) {
        log.error(`Erreur merge-file pour ${relPath} : ${err}`);
        conflictedFiles.push(relPath);
        processedFiles.push(relPath);
      }
    }

    if (conflictedFiles.length === 0) {
      return { status: 'applied', files: processedFiles, conflicted: [] };
    }

    return {
      status: 'conflict',
      files: processedFiles,
      conflicted: conflictedFiles,
      detail: `Fusion fichier par fichier (git merge-file) : résolvez les marqueurs de conflit dans ${conflictedFiles.join(', ')}`,
    };
  }

  /**
   * Fusionne un seul fichier avec git merge-file.
   * Retourne 'applied' | 'conflict' | 'skipped' (ours === theirs).
   */
  private async mergeSingleFile(threadId: string, relPath: string): Promise<'applied' | 'conflict' | 'skipped'> {
    const worktreePath = this.path(threadId);
    const repoFile = path.join(this.repoRoot, relPath);

    // Lire les trois versions en Buffer pour comparaison binaire exacte
    const [baseBuf, theirsBuf, oursBuf] = await Promise.all([
      this.fileAtBaseOrNull(threadId, relPath),                    // base (baseTree)
      this.readFileBuffer(worktreePath, relPath),                  // theirs (worktree)
      this.readFileBuffer(this.repoRoot, relPath),                 // ours (workspace)
    ]);

    const theirsMissing = theirsBuf === null;
    const oursMissing = oursBuf === null;

    // Cas 1 : ours identique à base (ou les deux absents) → écrire theirs (ou supprimer)
    if (this.buffersEqual(oursBuf, baseBuf)) {
      if (theirsMissing) {
        // Supprimé par l'agent : supprimer dans workspace s'il existe
        if (!oursMissing) {
          fs.unlinkSync(repoFile);
        }
      } else {
        // Écrire theirs
        this.ensureDirAndWrite(repoFile, theirsBuf);
      }
      return 'applied';
    }

    // Cas 2 : ours identique à theirs → rien à faire
    if (this.buffersEqual(oursBuf, theirsBuf)) {
      return 'skipped';
    }

    // Cas 3 : theirs absent (supprimé par l'agent) mais ours modifié → conflit, ne pas supprimer
    if (theirsMissing) {
      // ours existe et diffère de base (sinon cas 1) → conflit
      return 'conflict';
    }

    // Cas 4 : fichier binaire (octet nul dans les 8000 premiers octets de l'une des versions)
    if (this.isBinary(baseBuf) || this.isBinary(theirsBuf) || this.isBinary(oursBuf)) {
      // Ne pas toucher à ours, écrire theirs à côté
      const theirsPath = `${repoFile}.agenthub-theirs`;
      this.ensureDirAndWrite(theirsPath, theirsBuf!);
      return 'conflict';
    }

    // Cas 5 : merge-file à trois voies
    // Écrire base/ours/theirs dans des fichiers temporaires
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-merge-'));
    try {
      const basePath = path.join(tmpDir, 'base');
      const oursPath = path.join(tmpDir, 'ours');
      const theirsPath = path.join(tmpDir, 'theirs');

      // base peut être null (fichier créé par l'agent) → fichier vide
      fs.writeFileSync(basePath, baseBuf ?? Buffer.alloc(0));
      // ours peut être null (fichier créé par l'agent) → fichier vide
      fs.writeFileSync(oursPath, oursBuf ?? Buffer.alloc(0));
      fs.writeFileSync(theirsPath, theirsBuf!);

      // git merge-file -p -L workspace -L base -L "agent <threadId>" <ours> <base> <theirs>
      const mergeResult = await gitBuffer(this.repoRoot, [
        'merge-file',
        '-p',
        '-L', 'workspace',
        '-L', 'base',
        '-L', `agent ${threadId}`,
        oursPath,
        basePath,
        theirsPath,
      ], { allowFail: true });

      if (mergeResult.code < 0) {
        // Erreur système (pas un conflit) : ne pas écrire, laisser ours intact
        log.error(`git merge-file erreur système pour ${relPath} : ${mergeResult.stderr}`);
        return 'conflict';
      }

      // Écrire le résultat (stdout) dans le workspace
      this.ensureDirAndWrite(repoFile, mergeResult.stdout);

      // code 0 = propre, code > 0 = conflits (marqueurs présents)
      return mergeResult.code === 0 ? 'applied' : 'conflict';
    } finally {
      // Nettoyer les fichiers temporaires
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  }

  /**
   * Lit un fichier et retourne son contenu en Buffer, ou null s'il n'existe pas.
   */
  private readFileBuffer(cwd: string, relPath: string): Buffer | null {
    const fullPath = path.join(cwd, relPath);
    if (!fs.existsSync(fullPath)) return null;
    return fs.readFileSync(fullPath);
  }

  /**
   * Lit un fichier à l'état baseTree et retourne son contenu en Buffer, ou null s'il n'existe pas.
   */
  private async fileAtBaseOrNull(threadId: string, relPath: string): Promise<Buffer | null> {
    const content = await this.fileAtBaseBuffer(threadId, relPath);
    return content ?? null;
  }

  /**
   * Compare deux Buffers (null = absent). Egaux si les deux null ou même contenu.
   */
  private buffersEqual(a: Buffer | null, b: Buffer | null): boolean {
    if (a === null && b === null) return true;
    if (a === null || b === null) return false;
    return a.equals(b);
  }

  /**
   * Détecte si un Buffer contient un octet nul dans les 8000 premiers octets.
   */
  private isBinary(buf: Buffer | null): boolean {
    if (!buf) return false;
    const len = Math.min(buf.length, 8000);
    for (let i = 0; i < len; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  }

  /**
   * Crée le dossier parent si nécessaire et écrit le Buffer.
   */
  private ensureDirAndWrite(filePath: string, content: Buffer): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, content);
  }

  /**
   * Supprime un worktree et nettoie les liens.
   * IMPORTANT : supprime les liens SANS récursion pour ne pas effacer la cible (ex: node_modules du workspace).
   */
  async remove(threadId: string): Promise<void> {
    const worktreePath = this.path(threadId);
    const linksFile = this.linksFile(threadId);

    // 1. Supprimer les liens créés (SANS récursion)
    if (fs.existsSync(linksFile)) {
      try {
        const links = JSON.parse(fs.readFileSync(linksFile, 'utf8')) as string[];
        for (const linkPath of links) {
          const linkFull = path.join(worktreePath, linkPath);
          try {
            const stat = fs.lstatSync(linkFull);
            if (stat.isDirectory()) {
              // Junction ou symlink de dossier : rmdir sans récursion
              fs.rmdirSync(linkFull);
            } else {
              // Fichier : unlink
              fs.unlinkSync(linkFull);
            }
          } catch (err) {
            log.warn(`Échec suppression lien ${linkPath} : ${err}`);
          }
        }
      } catch (err) {
        log.warn(`Échec lecture liens ${threadId} : ${err}`);
      }
      try { fs.unlinkSync(linksFile); } catch {}
    }

    // 2. git worktree remove --force
    if (fs.existsSync(worktreePath)) {
      await git(this.repoRoot, ['worktree', 'remove', '--force', worktreePath], { allowFail: true });
    }

    // 3. git worktree prune
    await git(this.repoRoot, ['worktree', 'prune'], { allowFail: true });

    // 4. Supprimer fichiers métadonnées
    try { fs.unlinkSync(this.metaFile(threadId)); } catch {}
  }

  /**
   * Copie récursive (fallback si symlink/junction échoue).
   */
  private copyRecursive(src: string, dst: string): void {
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
      for (const entry of fs.readdirSync(src)) {
        this.copyRecursive(path.join(src, entry), path.join(dst, entry));
      }
    } else {
      fs.copyFileSync(src, dst);
    }
  }
}