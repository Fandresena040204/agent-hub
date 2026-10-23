import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Worktrees } from '../src/core/Worktrees';
import { git } from '../src/core/git';

async function createTempGitRepo(): Promise<{ repoDir: string; cleanup: () => void }> {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-test-'));
  
  // Init git repo
  const runGit = (args: string[]) => git(repoDir, args);
  
  await runGit(['init']);
  await runGit(['config', 'user.email', 'test@test.com']);
  await runGit(['config', 'user.name', 'Test User']);
  
  // Commit initial
  const testFile = path.join(repoDir, 'README.md');
  fs.writeFileSync(testFile, '# Test Repo\n');
  await runGit(['add', 'README.md']);
  await runGit(['commit', '-m', 'Initial commit']);

  const cleanup = () => {
    if (fs.existsSync(repoDir)) {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  };

  return { repoDir, cleanup };
}

describe('Worktrees', () => {
  let repoDir: string;
  let cleanupRepo: () => void;
  let storageDir: string;
  let worktrees: Worktrees;

  beforeEach(async () => {
    const repo = await createTempGitRepo();
    repoDir = repo.repoDir;
    cleanupRepo = repo.cleanup;
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-storage-'));
    worktrees = new Worktrees(repoDir, storageDir);
  });

  afterEach(async () => {
    cleanupRepo();
    if (fs.existsSync(storageDir)) {
      fs.rmSync(storageDir, { recursive: true, force: true });
    }
  });

  it('isGitRepo détecte un dépôt git', async () => {
    expect(await Worktrees.isGitRepo(repoDir)).toBe(true);
    expect(await Worktrees.isGitRepo(path.join(os.tmpdir(), 'not-a-repo'))).toBe(false);
  });

  it('create worktree détaché', async () => {
    const result = await worktrees.create('thread-1', { includeUncommitted: false, linkPaths: [] });
    
    expect(fs.existsSync(result.path)).toBe(true);
    expect(result.baseTree).toMatch(/^[0-9a-f]{40}$/);
    
    // Vérifier que c'est détaché (HEAD detached)
    const headWt = await git(result.path, ['rev-parse', 'HEAD']);
    const headMain = await git(repoDir, ['rev-parse', 'HEAD']);
    expect(headWt.stdout.trim()).toBe(headMain.stdout.trim());
    
    // Vérifier qu'on est en detached HEAD (pas de branche courante)
    const branch = await git(result.path, ['branch', '--show-current']);
    expect(branch.stdout.trim()).toBe(''); // Pas de branche courante = detached
  });

  it('includeUncommitted reproduit modifications et fichiers non suivis', async () => {
    // Modifier un fichier suivi
    const trackedFile = path.join(repoDir, 'README.md');
    fs.writeFileSync(trackedFile, '# Modified\n');
    
    // Ajouter un fichier non suivi
    const untrackedFile = path.join(repoDir, 'new-file.txt');
    fs.writeFileSync(untrackedFile, 'untracked content');
    
    const result = await worktrees.create('thread-1', { includeUncommitted: true, linkPaths: [] });
    void result;
    
    // Vérifier que la modif est dans le worktree
    const wtReadme = path.join(result.path, 'README.md');
    expect(fs.readFileSync(wtReadme, 'utf8').replace(/\r\n/g, '\n')).toBe('# Modified\n');
    
    // Vérifier que le fichier non suivi est copié
    const wtNewFile = path.join(result.path, 'new-file.txt');
    expect(fs.existsSync(wtNewFile)).toBe(true);
    expect(fs.readFileSync(wtNewFile, 'utf8')).toBe('untracked content');
  });

  it('includeUncommitted=false avec mods non commitées → warning', async () => {
    const trackedFile = path.join(repoDir, 'README.md');
    fs.writeFileSync(trackedFile, '# Modified\n');
    
    const result = await worktrees.create('thread-1', { includeUncommitted: false, linkPaths: [] });
    
    expect(result.warning).toContain('modifications non commitées');
    // Le worktree doit avoir le contenu original
    const wtReadme = path.join(result.path, 'README.md');
    expect(fs.readFileSync(wtReadme, 'utf8').replace(/\r\n/g, '\n')).toBe('# Test Repo\n');
  });

  it('linkPaths crée junction/symlink', async () => {
    // Créer un dossier à lier
    const linkDir = path.join(repoDir, 'external-deps');
    fs.mkdirSync(linkDir, { recursive: true });
    fs.writeFileSync(path.join(linkDir, 'dep.txt'), 'dependency');
    
    const result = await worktrees.create('thread-1', { includeUncommitted: false, linkPaths: ['external-deps'] });
    
    const linkedPath = path.join(result.path, 'external-deps');
    expect(fs.existsSync(linkedPath)).toBe(true);
    expect(fs.readFileSync(path.join(linkedPath, 'dep.txt'), 'utf8')).toBe('dependency');
    
    // Vérifier que c'est bien un lien (sur Windows junction, ailleurs symlink)
    const stat = fs.lstatSync(linkedPath);
    expect(stat.isSymbolicLink() || (process.platform === 'win32' && (stat as any).mode === 16896)).toBe(true);
  });

  it('changedFiles ne contient que les modifs de l\'agent', async () => {
    const result = await worktrees.create('thread-1', { includeUncommitted: false, linkPaths: [] });
    
    // Modifier un fichier dans le worktree (simuler agent)
    const wtFile = path.join(result.path, 'README.md');
    fs.writeFileSync(wtFile, '# Agent modified\n');
    
    const changed = await worktrees.changedFiles('thread-1');
    expect(changed).toContain('README.md');
    expect(changed).toHaveLength(1);
  });

  it('fileAtBase retourne le contenu à la base', async () => {
    const result = await worktrees.create('thread-1', { includeUncommitted: false, linkPaths: [] });
    void result;
    
    const content = await worktrees.fileAtBase('thread-1', 'README.md');
    expect(content).toBe('# Test Repo\n');
    
    const missing = await worktrees.fileAtBase('thread-1', 'nonexistent.txt');
    expect(missing).toBeUndefined();
  });

  it('diffPatch génère un patch binaire', async () => {
    const result = await worktrees.create('thread-1', { includeUncommitted: false, linkPaths: [] });
    
    // Modifier
    fs.writeFileSync(path.join(result.path, 'README.md'), '# Modified\n');
    
    const patch = await worktrees.diffPatch('thread-1');
    expect(patch.length).toBeGreaterThan(0);
    const patchStr = patch.toString('utf8');
    expect(patchStr).toContain('README.md');
    expect(patchStr).toContain('Modified');
  });

  it('apply → applied, fichiers modifiés non commités, HEAD inchangé', async () => {
    const result = await worktrees.create('thread-1', { includeUncommitted: false, linkPaths: [] });
    
    // Modifier dans worktree
    fs.writeFileSync(path.join(result.path, 'README.md'), '# Agent modified\n');
    
    const applyResult = await worktrees.apply('thread-1');
    
    expect(applyResult.status).toBe('applied');
    expect(applyResult.files).toContain('README.md');
    expect(applyResult.conflicted).toHaveLength(0);
    
    // Dans le repo principal : fichier modifié mais non commité
    const mainReadme = path.join(repoDir, 'README.md');
    expect(fs.readFileSync(mainReadme, 'utf8').replace(/\r\n/g, '\n')).toBe('# Agent modified\n');
    
    // HEAD inchangé
    const headBefore = await git(repoDir, ['rev-parse', 'HEAD']);
    const headAfter = await git(repoDir, ['rev-parse', 'HEAD']);
    expect(headAfter.stdout.trim()).toBe(headBefore.stdout.trim());
    
    // Pas dans l'index (reset -q --)
    const status = await git(repoDir, ['status', '--porcelain']);
    expect(status.stdout).toContain(' M README.md'); // Modified but not staged
  });

  it('DEUX worktrees modifiant la même ligne : 1er applied, 2e conflict', async () => {
    // Créer deux worktrees
    const result1 = await worktrees.create('thread-1', { includeUncommitted: false, linkPaths: [] });
    const result2 = await worktrees.create('thread-2', { includeUncommitted: false, linkPaths: [] });
    
    // Les deux modifient la même ligne du même fichier
    fs.writeFileSync(path.join(result1.path, 'README.md'), '# Thread 1\n');
    fs.writeFileSync(path.join(result2.path, 'README.md'), '# Thread 2\n');
    
    // Premier apply
    const apply1 = await worktrees.apply('thread-1');
    expect(apply1.status).toBe('applied');
    expect(apply1.files).toContain('README.md');
    expect(apply1.conflicted).toHaveLength(0);
    
    // Deuxième apply -> conflit avec marqueurs
    const apply2 = await worktrees.apply('thread-2');
    expect(apply2.status).toBe('conflict');
    expect(apply2.conflicted).toContain('README.md');
    expect(apply2.files).toContain('README.md');
    expect(apply2.detail).toContain('Fusion fichier par fichier');
    
    // Le fichier contient les marqueurs de conflit avec les deux versions
    const mainReadme = path.join(repoDir, 'README.md');
    const content = fs.readFileSync(mainReadme, 'utf8').replace(/\r\n/g, '\n');
    expect(content).toContain('<<<<<<< workspace');
    expect(content).toContain('# Thread 1');
    expect(content).toContain('=======');
    expect(content).toContain('# Thread 2');
    expect(content).toContain('>>>>>>> agent thread-2');
    
    // Aucun fichier .rej créé
    const rejFiles = fs.readdirSync(repoDir).filter(f => f.endsWith('.rej'));
    expect(rejFiles).toHaveLength(0);
  });

  it('remove nettoie et ne supprime pas la cible d\'un lien', async () => {
    // Créer un dossier externe
    const externalDir = path.join(repoDir, 'external-data');
    fs.mkdirSync(externalDir, { recursive: true });
    fs.writeFileSync(path.join(externalDir, 'data.txt'), 'important data');
    
    const result = await worktrees.create('thread-1', { includeUncommitted: false, linkPaths: ['external-data'] });
    
    // Vérifier que le lien existe
    const linkedPath = path.join(result.path, 'external-data');
    expect(fs.existsSync(linkedPath)).toBe(true);
    
    // Supprimer le worktree
    await worktrees.remove('thread-1');
    
    // Le worktree est supprimé
    expect(fs.existsSync(result.path)).toBe(false);
    
    // MAIS la cible originale existe toujours
    expect(fs.existsSync(externalDir)).toBe(true);
    expect(fs.readFileSync(path.join(externalDir, 'data.txt'), 'utf8')).toBe('important data');
  });

  it('exists et path', async () => {
    expect(worktrees.exists('thread-1')).toBe(false);
    const result = await worktrees.create('thread-1', { includeUncommitted: false, linkPaths: [] });
    expect(worktrees.exists('thread-1')).toBe(true);
    expect(worktrees.path('thread-1')).toBe(result.path);
    await worktrees.remove('thread-1');
    expect(worktrees.exists('thread-1')).toBe(false);
  });

  it('DEUX worktrees modifiant des lignes DIFFÉRENTES : les deux applied', async () => {
    // Créer un fichier avec plusieurs lignes
    const multiLineFile = path.join(repoDir, 'multi.txt');
    fs.writeFileSync(multiLineFile, 'ligne 1\nligne 2\nligne 3\nligne 4\nligne 5\n');
    await git(repoDir, ['add', 'multi.txt']);
    await git(repoDir, ['commit', '-m', 'Add multi.txt']);
    
    // Créer deux worktrees
    const result1 = await worktrees.create('thread-1', { includeUncommitted: false, linkPaths: [] });
    const result2 = await worktrees.create('thread-2', { includeUncommitted: false, linkPaths: [] });
    
    // Thread 1 modifie le début, thread 2 modifie la fin (lignes éloignées)
    fs.writeFileSync(path.join(result1.path, 'multi.txt'), 'ligne 1 MODIFIÉE\nligne 2\nligne 3\nligne 4\nligne 5\n');
    fs.writeFileSync(path.join(result2.path, 'multi.txt'), 'ligne 1\nligne 2\nligne 3\nligne 4\nligne 5 MODIFIÉE\n');
    
    // Premier apply
    const apply1 = await worktrees.apply('thread-1');
    expect(apply1.status).toBe('applied');
    expect(apply1.conflicted).toHaveLength(0);
    
    // Deuxième apply -> doit aussi réussir (merge clean)
    const apply2 = await worktrees.apply('thread-2');
    expect(apply2.status).toBe('applied');
    expect(apply2.conflicted).toHaveLength(0);
    
    // Le fichier contient les deux modifications, pas de marqueurs
    const mainFile = path.join(repoDir, 'multi.txt');
    const content = fs.readFileSync(mainFile, 'utf8').replace(/\r\n/g, '\n');
    expect(content).toContain('ligne 1 MODIFIÉE');
    expect(content).toContain('ligne 5 MODIFIÉE');
    expect(content).not.toContain('<<<<<<<');
    expect(content).not.toContain('>>>>>>>');
  });

  it('apply sur workspace propre → applied, index intact, HEAD inchangé', async () => {
    const result = await worktrees.create('thread-1', { includeUncommitted: false, linkPaths: [] });
    
    // Modifier dans worktree
    fs.writeFileSync(path.join(result.path, 'README.md'), '# Agent modified\n');
    
    const headBefore = await git(repoDir, ['rev-parse', 'HEAD']);
    
    const applyResult = await worktrees.apply('thread-1');
    
    expect(applyResult.status).toBe('applied');
    expect(applyResult.files).toContain('README.md');
    expect(applyResult.conflicted).toHaveLength(0);
    
    // Dans le repo principal : fichier modifié mais non commité
    const mainReadme = path.join(repoDir, 'README.md');
    expect(fs.readFileSync(mainReadme, 'utf8').replace(/\r\n/g, '\n')).toBe('# Agent modified\n');
    
    // HEAD inchangé
    const headAfter = await git(repoDir, ['rev-parse', 'HEAD']);
    expect(headAfter.stdout.trim()).toBe(headBefore.stdout.trim());
    
    // Index intact (git diff --cached --name-only vide)
    const cachedDiff = await git(repoDir, ['diff', '--cached', '--name-only']);
    expect(cachedDiff.stdout.trim()).toBe('');
    
    // Workspace a des modifications non indexées
    const status = await git(repoDir, ['status', '--porcelain']);
    expect(status.stdout).toContain(' M README.md');
  });

  it('fichier supprimé dans worktree et modifié dans workspace → conflict, fichier présent', async () => {
    const result = await worktrees.create('thread-1', { includeUncommitted: false, linkPaths: [] });
    
    // Dans le worktree : supprimer le fichier
    fs.unlinkSync(path.join(result.path, 'README.md'));
    
    // Dans le workspace : modifier le fichier
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Workspace modified\n');
    
    const applyResult = await worktrees.apply('thread-1');
    
    expect(applyResult.status).toBe('conflict');
    expect(applyResult.conflicted).toContain('README.md');
    
    // Le fichier est toujours présent dans le workspace (non supprimé)
    const mainReadme = path.join(repoDir, 'README.md');
    expect(fs.existsSync(mainReadme)).toBe(true);
    const content = fs.readFileSync(mainReadme, 'utf8').replace(/\r\n/g, '\n');
    expect(content).toBe('# Workspace modified\n');
    
    // Le detail mentionne le conflit
    expect(applyResult.detail).toContain('Fusion fichier par fichier');
  });

  it('numstat : +N/−N par fichier, undefined pour un binaire', async () => {
    const result = await worktrees.create('thread-1', { includeUncommitted: false, linkPaths: [] });

    fs.writeFileSync(path.join(result.path, 'README.md'), '# Agent modifié\n');
    fs.mkdirSync(path.join(result.path, 'src'), { recursive: true });
    fs.writeFileSync(path.join(result.path, 'src', 'new.ts'), 'ligne1\nligne2\n');
    fs.writeFileSync(path.join(result.path, 'bin.dat'), Buffer.from([0, 1, 2, 3]));

    const stats = await worktrees.numstat('thread-1');
    expect(stats.get('README.md')).toEqual({ additions: 1, deletions: 1 });
    expect(stats.get('src/new.ts')).toEqual({ additions: 2, deletions: 0 });
    const binary = stats.get('bin.dat');
    expect(binary).toBeDefined();
    expect(binary!.additions).toBeUndefined();
    expect(binary!.deletions).toBeUndefined();
  });

  it('numstat : vide si rien n\'a changé', async () => {
    await worktrees.create('thread-1', { includeUncommitted: false, linkPaths: [] });
    expect((await worktrees.numstat('thread-1')).size).toBe(0);
  });

  it('restoreFile : contenu de base restauré, fichier créé supprimé', async () => {
    const result = await worktrees.create('thread-1', { includeUncommitted: false, linkPaths: [] });

    fs.writeFileSync(path.join(result.path, 'README.md'), '# Agent\n');
    fs.writeFileSync(path.join(result.path, 'src.ts'), 'nouveau\n');
    expect((await worktrees.changedFiles('thread-1')).sort()).toEqual(['README.md', 'src.ts']);

    await worktrees.restoreFile('thread-1', 'README.md');
    expect(fs.readFileSync(path.join(result.path, 'README.md'), 'utf8').replace(/\r\n/g, '\n'))
      .toBe('# Test Repo\n');

    await worktrees.restoreFile('thread-1', 'src.ts');
    expect(fs.existsSync(path.join(result.path, 'src.ts'))).toBe(false);

    // Le worktree est revenu à l'état de base.
    expect(await worktrees.changedFiles('thread-1')).toEqual([]);
    // Le workspace n'a jamais été touché.
    expect(fs.readFileSync(path.join(repoDir, 'README.md'), 'utf8').replace(/\r\n/g, '\n'))
      .toBe('# Test Repo\n');
  });

  it('restoreFile refuse un chemin hors du worktree', async () => {
    await worktrees.create('thread-1', { includeUncommitted: false, linkPaths: [] });
    await expect(worktrees.restoreFile('thread-1', '../evasion.txt')).rejects.toThrow(/hors du worktree/);
  });
});