// Tests de la vue de chat latérale : logique pure de src/ui/chatViewModel.ts + shell HTML en mode 'view'.
import { describe, expect, it } from 'vitest';
import {
  chatThreadOptions,
  fileSignature,
  filesActions,
  filesTotals,
  pendingFiles,
  renderFilesBlockHtml,
  threadSubtitle,
} from '../src/ui/chatViewModel';
import { buildChatHtml } from '../src/ui/presentation';
import type { ChangedFile } from '../src/core/orchestratorApi';
import type { ThreadInfo } from '../src/core/types';

function thread(overrides: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    id: 't1',
    agent: 'claude',
    permissionMode: 'edit',
    isolation: 'shared',
    cwd: '/w',
    title: 'Principal',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    changedFiles: [],
    violations: { scope: [], commits: [] },
    ...overrides,
  };
}

function file(overrides: Partial<ChangedFile> = {}): ChangedFile {
  return { path: 'a.ts', absPath: '/abs/a.ts', status: 'modified', ...overrides };
}

describe('sélecteur de threads', () => {
  it('principaux d\'abord, délégués indentés juste après leur parent', () => {
    const opts = chatThreadOptions([
      thread({ id: 's2', parentId: 'm1', title: 'Délégué tests', createdAt: 3 }),
      thread({ id: 'm2', title: 'Second', createdAt: 2 }),
      thread({ id: 'm1', title: 'Premier', createdAt: 1 }),
      thread({ id: 's1', parentId: 'm1', title: 'Délégué docs', createdAt: 2 }),
    ]);
    expect(opts.map((o) => o.label)).toEqual([
      '● Premier',
      '● ↳ Délégué docs',
      '● ↳ Délégué tests',
      '● Second',
    ]);
    expect(opts.map((o) => o.id)).toEqual(['m1', 's1', 's2', 'm2']);
  });

  it('pastille ◐ pour les threads en cours, ● pour les autres', () => {
    const opts = chatThreadOptions([
      thread({ id: 'busy', title: 'En cours', status: 'running' }),
      thread({ id: 'calm', title: 'Au repos', status: 'done' }),
    ]);
    expect(opts[0].label).toBe('◐ En cours');
    expect(opts[1].label).toBe('● Au repos');
  });

  it('délégués orphelins (parent absent) en fin de liste', () => {
    const opts = chatThreadOptions([
      thread({ id: 'orphan', parentId: 'nonexistent', title: 'Orphelin', createdAt: 5 }),
      thread({ id: 'only', title: 'Seul', createdAt: 1 }),
    ]);
    expect(opts.map((o) => o.id)).toEqual(['only', 'orphan']);
    expect(opts[1].label).toContain('↳ Orphelin');
  });
});

describe('sous-titre d\'en-tête', () => {
  it('agent · modèle · effort · isolation (champs absents omis)', () => {
    expect(threadSubtitle(thread())).toBe('claude · shared');
    expect(threadSubtitle(thread({ model: 'm1', effort: 'high', isolation: 'worktree' }))).toBe('claude · m1 · high · worktree');
  });
});

describe('totaux du bloc fichiers', () => {
  it('somme des + et −, omis quand inconnus (binaire)', () => {
    expect(filesTotals([])).toEqual({ count: 0, additions: undefined, deletions: undefined });
    expect(filesTotals([file({ additions: 2, deletions: 1 }), file({ path: 'b.ts', additions: 3, deletions: 4 })])).toEqual({ count: 2, additions: 5, deletions: 5 });
    expect(filesTotals([file({ additions: undefined, deletions: undefined })])).toEqual({ count: 1, additions: undefined, deletions: undefined });
    // Binaire : le total des autres fichiers reste affiché.
    expect(filesTotals([file({ additions: 1 }), file({ additions: undefined, deletions: undefined })])).toEqual({ count: 2, additions: 1, deletions: undefined });
  });
});

describe('fichiers conservés (signature)', () => {
  it('signature `chemin:additions:deletions`', () => {
    expect(fileSignature({ path: 'a.ts', additions: 1, deletions: 2 })).toBe('a.ts:1:2');
    expect(fileSignature({ path: 'b.png', additions: undefined, deletions: undefined })).toBe('b.png::');
  });

  it('le fichier conservé sort de la liste, réapparaît si la signature change', () => {
    const files = [file({ additions: 1, deletions: 0 }), file({ path: 'b.ts', additions: 2, deletions: 3 })];
    const pending = pendingFiles(files, ['a.ts:1:0']);
    expect(pending.map((f) => f.path)).toEqual(['b.ts']);
    // Fichier modifié à nouveau : nouvelle signature → il réapparaît.
    expect(pendingFiles([file({ additions: 5, deletions: 0 })], ['a.ts:1:0'])).toHaveLength(1);
    expect(pendingFiles([file({ additions: 1, deletions: 0 })], ['a.ts:1:0'])).toHaveLength(0);
  });
});

describe('actions selon isolation / statut', () => {
  it('thread shared : tout conserver + tout annuler, pas d\'application', () => {
    expect(filesActions(thread({ status: 'idle' }))).toEqual({
      applied: false, apply: false, keepAll: true, revertAll: true, keep: true, revert: true, busy: false,
    });
  });

  it('thread worktree non appliqué : Appliquer + Tout annuler, sans « Tout conserver »', () => {
    expect(filesActions(thread({ isolation: 'worktree', status: 'done' }))).toEqual({
      applied: false, apply: true, keepAll: false, revertAll: true, keep: true, revert: true, busy: false,
    });
  });

  it('worktree appliqué : badge seulement, aucune action', () => {
    expect(filesActions(thread({ isolation: 'worktree', status: 'applied' }))).toEqual({
      applied: true, apply: false, keepAll: false, revertAll: false, keep: false, revert: false, busy: false,
    });
  });

  it('thread actif : actions momentanément désactivées', () => {
    expect(filesActions(thread({ status: 'running' })).busy).toBe(true);
    expect(filesActions(thread({ status: 'starting', parentId: 'p' })).busy).toBe(true);
  });
});

describe('HTML du bloc fichiers', () => {
  it('en-tête « N fichiers modifiés » avec totaux', () => {
    const html = renderFilesBlockHtml(thread(), [
      file({ path: 'a.ts', additions: 2, deletions: 1 }),
      file({ path: 'b.ts', additions: 3, deletions: 2 }),
    ]);
    expect(html).toContain('2 fichiers modifiés');
    expect(html).toContain('+5');
    expect(html).toContain('−3');
    expect(html).toContain('Tout conserver');
    expect(html).toContain('Tout annuler');
    expect(html).not.toContain('Appliquer');
  });

  it('elements : dossier en gris, nom, +/−, boutons Conserver/Annuler, statut échappé', () => {
    const html = renderFilesBlockHtml(thread(), [
      file({ path: 'src/ui/ç<y>.ts', status: 'added', additions: 1, deletions: undefined }),
    ]);
    // Échappement : &#60;y&#62;.
    expect(html).toContain('&#60;y&#62;');
    expect(html).not.toContain('<y>.ts');
    expect(html).toContain('src/ui/');
    expect(html).toContain('class="fstat fstat-added"');
    expect(html).toContain('>A<');
    expect(html).toContain('+1');
    expect(html).not.toContain('−');
    expect(html).toContain('data-act="keep"');
    expect(html).toContain('data-act="revert"');
    expect(html).toContain('title="Conserver"');
    expect(html).toContain('title="Annuler"');
  });

  it('thread worktree : « Appliquer » à la place de « Tout conserver », badge « appliqué » si appliqué', () => {
    const wt = thread({ isolation: 'worktree', status: 'done' });
    const html = renderFilesBlockHtml(wt, [file({ additions: 1, deletions: 1 })]);
    expect(html).toContain('Appliquer');
    expect(html).toContain('Tout annuler');
    expect(html).not.toContain('Tout conserver');
    expect(renderFilesBlockHtml(thread({ isolation: 'worktree', status: 'applied' }), [file()]))
      .toContain('<span class="fbadge">appliqué</span>');
    expect(renderFilesBlockHtml(thread({ isolation: 'worktree', status: 'applied' }), [file()]))
      .not.toContain('data-act');
  });

  it('thread actif : boutons désactivés, diff toujours possible', () => {
    const html = renderFilesBlockHtml(thread({ status: 'running' }), [file()]);
    for (const act of ['keepAll', 'revertAll']) {
      expect(html).toContain(`data-act="${act}"`);
    }
    expect(html.match(/data-act=.*? disabled/g)).toBeTruthy();
    expect(html).toContain('data-path="a.ts"');
  });
});

describe('coquille HTML de la vue latérale', () => {
  it('mode "view" : sélecteur, bloc fichiers, saisie Entrée/Maj+Entrée, CSP stricte, aucun réseau', () => {
    const html = buildChatHtml('nOnCe02');
    expect(html).toContain("script-src 'nonce-nOnCe02'");
    expect(html).toContain('<script nonce="nOnCe02">');
    expect(html).toContain('id="tsel"');
    expect(html).toContain('id="filesblk"');
    expect(html).toContain('Maj+Entrée');
    expect(html).toContain("t: 'send'");
    expect(html).toContain("t: 'openDiff'");
    // Les actions du bloc fichiers transitent par le dispatch générique du clic.
    expect(html).toContain('btn.dataset.act');
    expect(html).toContain('acquireVsCodeApi');
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
  });
});
