import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getHead, HeadWatcher, mergeInProgress, filesWithConflictMarkers, diffSummary, commitPaths, snapshotFiles, statusPaths } from '../src/core/GitGuard';
import { git } from '../src/core/git';

async function createTempGitRepo(): Promise<{ repoDir: string; cleanup: () => void }> {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitguard-test-'));
  
  const runGit = (args: string[]) => git(repoDir, args);
  
  await runGit(['init']);
  await runGit(['config', 'user.email', 'test@test.com']);
  await runGit(['config', 'user.name', 'Test User']);
  
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

describe('GitGuard', () => {
  let repoDir: string;
  let cleanupRepo: () => void;

  beforeEach(async () => {
    const repo = await createTempGitRepo();
    repoDir = repo.repoDir;
    cleanupRepo = repo.cleanup;
  });

  afterEach(() => {
    cleanupRepo();
  });

  describe('getHead', () => {
    it('retourne le SHA du HEAD', async () => {
      const head = await getHead(repoDir);
      expect(head).toMatch(/^[0-9a-f]{40}$/);
    });

    it('retourne undefined si pas de commit', async () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-git-'));
      await git(emptyDir, ['init']);
      await git(emptyDir, ['config', 'user.email', 'test@test.com']);
      await git(emptyDir, ['config', 'user.name', 'Test User']);
      const head = await getHead(emptyDir);
      expect(head).toBeUndefined();
      fs.rmSync(emptyDir, { recursive: true, force: true });
    });
  });

  describe('HeadWatcher', () => {
    it('démarre et détecte un nouveau commit', async () => {
      const watcher = new HeadWatcher(repoDir);
      await watcher.start();
      
      // Premier check -> pas de changement
      let change = await watcher.check();
      expect(change).toBeUndefined();
      
      // Faire un commit
      const newFile = path.join(repoDir, 'new.txt');
      fs.writeFileSync(newFile, 'new content');
      await git(repoDir, ['add', 'new.txt']);
      await git(repoDir, ['commit', '-m', 'Add new file']);
      
      // Check détecte le changement
      change = await watcher.check();
      expect(change).toBeDefined();
      expect(change!.oldHead).toMatch(/^[0-9a-f]{40}$/);
      expect(change!.newHead).toMatch(/^[0-9a-f]{40}$/);
      expect(change!.oldHead).not.toBe(change!.newHead);
      
      // Deuxième check -> pas de nouveau changement
      change = await watcher.check();
      expect(change).toBeUndefined();
    });

    it('ne signale chaque changement qu\'une fois', async () => {
      const watcher = new HeadWatcher(repoDir);
      await watcher.start();
      
      // Faire 2 commits
      for (let i = 1; i <= 2; i++) {
        const f = path.join(repoDir, `file${i}.txt`);
        fs.writeFileSync(f, `content ${i}`);
        await git(repoDir, ['add', `file${i}.txt`]);
        await git(repoDir, ['commit', '-m', `Commit ${i}`]);
      }
      
      // Premier check signale le dernier commit
      const change1 = await watcher.check();
      expect(change1).toBeDefined();
      
      // Deuxième check ne signale rien
      const change2 = await watcher.check();
      expect(change2).toBeUndefined();
    });
  });

  describe('mergeInProgress', () => {
    it('retourne false sur repo propre', async () => {
      expect(await mergeInProgress(repoDir)).toBe(false);
    });

    it('retourne true si MERGE_HEAD existe', async () => {
      // Créer une situation de merge
      const otherBranch = 'feature';
      await git(repoDir, ['checkout', '-b', otherBranch]);
      const f = path.join(repoDir, 'feature.txt');
      fs.writeFileSync(f, 'feature');
      await git(repoDir, ['add', 'feature.txt']);
      await git(repoDir, ['commit', '-m', 'Feature']);
      await git(repoDir, ['checkout', 'master']);
      
      // Commencer un merge (sans le finir)
      await git(repoDir, ['merge', '--no-commit', '--no-ff', otherBranch], { allowFail: true });
      
      expect(await mergeInProgress(repoDir)).toBe(true);
    });

    it('retourne true si fichiers non fusionnés', async () => {
      // Créer une vraie situation de merge conflict
      // 1. Créer une branche avec une modification
      await git(repoDir, ['checkout', '-b', 'conflict-branch']);
      fs.writeFileSync(path.join(repoDir, 'conflict.txt'), 'branch version\n');
      await git(repoDir, ['add', 'conflict.txt']);
      await git(repoDir, ['commit', '-m', 'Branch version']);
      
      // 2. Revenir sur master et faire une modification conflicte
      await git(repoDir, ['checkout', 'master']);
      fs.writeFileSync(path.join(repoDir, 'conflict.txt'), 'master version\n');
      await git(repoDir, ['add', 'conflict.txt']);
      await git(repoDir, ['commit', '-m', 'Master version']);
      
      // 3. Essayer de merger - cela va créer un conflit
      await git(repoDir, ['merge', 'conflict-branch'], { allowFail: true });
      
      // Maintenant mergeInProgress devrait détecter le conflit
      expect(await mergeInProgress(repoDir)).toBe(true);
    });
  });

  describe('filesWithConflictMarkers', () => {
    it('détecte les marqueurs de conflit', async () => {
      const f1 = path.join(repoDir, 'conflict1.txt');
      fs.writeFileSync(f1, '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n');
      
      const f2 = path.join(repoDir, 'conflict2.txt');
      fs.writeFileSync(f2, 'normal content\n=======\nmore\n>>>>>>> branch\n');
      
      const f3 = path.join(repoDir, 'normal.txt');
      fs.writeFileSync(f3, 'normal file\n');
      
      const result = await filesWithConflictMarkers(repoDir, ['conflict1.txt', 'conflict2.txt', 'normal.txt']);
      expect(result).toContain('conflict1.txt');
      expect(result).toContain('conflict2.txt');
      expect(result).not.toContain('normal.txt');
    });
  });

  describe('diffSummary', () => {
    it('génère un résumé de diff', async () => {
      const f = path.join(repoDir, 'README.md');
      fs.writeFileSync(f, '# Modified\n\nNew content');
      
      const summary = await diffSummary(repoDir, ['README.md']);
      expect(summary).toContain('README.md');
    });

    it('inclut les fichiers non suivis', async () => {
      const f = path.join(repoDir, 'untracked.txt');
      fs.writeFileSync(f, 'untracked');
      
      const summary = await diffSummary(repoDir, ['untracked.txt']);
      expect(summary).toContain('untracked.txt');
      expect(summary).toContain('non suivi');
    });
  });

  describe('commitPaths', () => {
    it('commit seulement les fichiers demandés', async () => {
      // Modifier deux fichiers
      fs.writeFileSync(path.join(repoDir, 'README.md'), '# Modified\n');
      const newFile = path.join(repoDir, 'new.txt');
      fs.writeFileSync(newFile, 'new');
      
      // Commit seulement README.md
      const result = await commitPaths(repoDir, ['README.md'], 'Update README');
      
      // Git commit outputs abbreviated SHA (7+ chars)
      expect(result.sha).toMatch(/^[0-9a-f]{7,40}$/);
      
      // Vérifier que new.txt n'est pas commité
      const status = await git(repoDir, ['status', '--porcelain']);
      expect(status.stdout).toContain('?? new.txt'); // Non suivi
    });

    it('refuse si paths vide', async () => {
      await expect(commitPaths(repoDir, [], 'Empty commit')).rejects.toThrow('liste de chemins vide');
    });
  });

  describe('snapshotFiles', () => {
    it('capture l\'état des fichiers', () => {
      fs.writeFileSync(path.join(repoDir, 'a.txt'), 'content a');
      fs.writeFileSync(path.join(repoDir, 'b.txt'), 'content b');
      
      const snapshot = snapshotFiles(repoDir, ['a.txt', 'b.txt', 'missing.txt']);
      
      expect(snapshot.get('a.txt')).toBe('content a');
      expect(snapshot.get('b.txt')).toBe('content b');
      expect(snapshot.get('missing.txt')).toBeUndefined();
    });
  });

  describe('statusPaths', () => {
    it('retourne les chemins modifiés/ajoutés/supprimés/non suivis', async () => {
      // Modifier un fichier suivi
      fs.writeFileSync(path.join(repoDir, 'README.md'), '# Modified\n');
      
      // Ajouter un fichier non suivi
      fs.writeFileSync(path.join(repoDir, 'untracked.txt'), 'new');
      
      // Supprimer un fichier (créer puis supprimer)
      const toDelete = path.join(repoDir, 'todelete.txt');
      fs.writeFileSync(toDelete, 'delete me');
      await git(repoDir, ['add', 'todelete.txt']);
      await git(repoDir, ['commit', '-m', 'Add todelete']);
      fs.unlinkSync(toDelete);
      
      const paths = await statusPaths(repoDir);
      expect(paths).toContain('README.md');
      expect(paths).toContain('untracked.txt');
      expect(paths).toContain('todelete.txt');
    });
  });
});