// Tests de l'import de sessions natives et de la suppression : logique pure de
// src/ui/nativeSessions.ts, src/ui/threadLifecycle.ts et src/ui/chatViewModel.ts.
import { describe, expect, it } from 'vitest';
import { isUnsupportedError, nativeSessionItem, relativeDate } from '../src/ui/nativeSessions';
import {
  deleteConfirmDetail,
  fallbackThreadAfterRemoval,
  subagentRemovedCardHtml,
  subtreeDeleteInfo,
} from '../src/ui/threadLifecycle';
import { cardsBlockHtml, subagentGroupHeaderText } from '../src/ui/chatViewModel';
import type { ThreadInfo } from '../src/core/types';

function thread(overrides: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    id: 'm1',
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

const NOW = 1_000_000;

describe('date relative', () => {
  it('minutes, heures, jours, bornée à « il y a 1 min »', () => {
    expect(relativeDate(NOW - 300_000, NOW)).toBe('il y a 5 min');
    expect(relativeDate(NOW - 10_800_000, NOW)).toBe('il y a 3 h');
    expect(relativeDate(NOW - 172_800_000, NOW)).toBe('il y a 2 j');
    expect(relativeDate(NOW - 59_000, NOW)).toBe('il y a 1 min');
    expect(relativeDate(NOW - 36 * 3600_000, NOW)).toBe('il y a 1 j');
  });

  it('jamais négative, ts absent ou non fini → chaîne vide', () => {
    expect(relativeDate(NOW + 60_000, NOW)).toBe('il y a 1 min');
    expect(relativeDate(0, NOW)).toBe('il y a 16 min'); // 1970 : très ancien mais valide
    expect(relativeDate(NaN, NOW)).toBe('');
    expect(relativeDate(undefined, NOW)).toBe('');
  });
});

describe('libellés de session native', () => {
  it('description = date relative · modèle ; detail = N messages · id court', () => {
    const item = nativeSessionItem(
      { id: 'a1b2c3d4e5f6g7h8i9', title: 'Refactor', updatedAt: NOW - 300_000, model: 'opus', messageCount: 12 },
      undefined,
      NOW,
    );
    expect(item.label).toBe('Refactor');
    expect(item.description).toBe('il y a 5 min · opus');
    expect(item.detail).toBe('12 messages · a1b2c3d4e5f…');
  });

  it('singulier « 1 message » ; sans modèle ni compteur : seulement la date et l\u2019id', () => {
    const item = nativeSessionItem({ id: 'xyz', title: 't', updatedAt: NOW - 200_000, messageCount: 1 }, undefined, NOW);
    expect(item.detail).toBe('1 message · xyz');
    const bare = nativeSessionItem({ id: 'abc', title: 't', updatedAt: NOW - 300_000 }, undefined, NOW);
    expect(bare.description).toBe('il y a 5 min');
    expect(bare.detail).toBe('abc');
  });

  it('session déjà importée : « déjà dans Agent Hub » dans le detail', () => {
    const item = nativeSessionItem(
      { id: 'abc', title: 't', updatedAt: NOW - 300_000 },
      'thread9',
      NOW,
    );
    expect(item.detail).toBe('abc · déjà dans Agent Hub');
    expect(nativeSessionItem({ id: 'abc', title: 't', updatedAt: NOW - 300_000 }, undefined, NOW).detail)
      .not.toContain('déjà dans Agent Hub');
  });

  it('titre vide : « (sans titre) » ; compteur nul : omis', () => {
    const item = nativeSessionItem({ id: 'abc', title: '   ', updatedAt: NOW - 300_000, messageCount: 0 }, undefined, NOW);
    expect(item.label).toBe('(sans titre)');
    expect(item.detail).toBe('abc');
  });
});

describe('erreur « non pris en charge »', () => {
  it('reconnue, les autres erreurs restent des erreurs', () => {
    expect(isUnsupportedError("L'import de sessions n'est pas encore pris en charge pour Claude.")).toBe(true);
    expect(isUnsupportedError('Agent claude indisponible : CLI introuvable.')).toBe(false);
  });
});

describe('comptes du sous-arbre supprimé', () => {
  const main = thread({ id: 'm1', status: 'done' });
  const running = thread({ id: 's1', parentId: 'm1', status: 'running' });
  const worktree = thread({ id: 's2', parentId: 'm1', isolation: 'worktree', status: 'done', worktreePath: '/wt' });
  const applied = thread({ id: 'g1', parentId: 's2', isolation: 'worktree', status: 'applied', worktreePath: '/wt' });

  it('tous les descendants comptent, worktree appliqué exclu', () => {
    expect(subtreeDeleteInfo([main, running, worktree, applied], main)).toEqual({
      childCount: 3,
      runningCount: 1,
      unappliedWorktrees: 1,
    });
  });

  it('délégué supprimé seul : lui-même inclus', () => {
    expect(subtreeDeleteInfo([main, running, worktree, applied], running)).toEqual({
      childCount: 0,
      runningCount: 1,
      unappliedWorktrees: 0,
    });
  });
});

describe('texte de confirmation de suppression', () => {
  it('thread seul : juste la session native conservée', () => {
    const detail = deleteConfirmDetail({ isMain: false, agent: 'claude', childCount: 0, runningCount: 0, unappliedWorktrees: 0 });
    expect(detail).toBe("La session native du CLI (claude) n'est pas supprimée.");
  });

  it('principal avec délégués, en cours, worktree non appliqué', () => {
    const detail = deleteConfirmDetail({
      isMain: true,
      agent: 'opencode',
      childCount: 3,
      runningCount: 1,
      unappliedWorktrees: 1,
    });
    expect(detail).toBe(
      'Ses 3 threads délégués seront aussi supprimés.\n'
      + '1 est en cours et sera interrompu.\n'
      + 'Les modifications non appliquées d\u2019un worktree seront perdues.\n'
      + "La session native du CLI (opencode) n'est pas supprimée.",
    );
  });

  it('pluriels ; principal sans délégué : pas de ligne délégués', () => {
    const plural = deleteConfirmDetail({
      isMain: true,
      agent: 'agy',
      childCount: 2,
      runningCount: 2,
      unappliedWorktrees: 5,
    });
    expect(plural).toContain('Ses 2 threads délégués seront aussi supprimés.');
    expect(plural).toContain('2 sont en cours et seront interrompus.');
    expect(plural).toContain('Les modifications non appliquées de 5 worktrees seront perdues.');
    expect(deleteConfirmDetail({ isMain: true, agent: 'claude', childCount: 1, runningCount: 0, unappliedWorktrees: 0 }))
      .toContain('Son thread délégué sera aussi supprimé.');
    const noChildren = deleteConfirmDetail({ isMain: true, agent: 'claude', childCount: 0, runningCount: 0, unappliedWorktrees: 0 });
    expect(noChildren).not.toContain('délégué');
  });
});

describe('repli après suppression', () => {
  const m1 = thread({ id: 'm1', updatedAt: 10 });
  const m2 = thread({ id: 'm2', updatedAt: 20 });

  it('parent encore présent : le parent', () => {
    expect(fallbackThreadAfterRemoval([m1, m2], 'm1', 's1')).toBe('m1');
  });

  it('parent parti (sous-arbre entier) : principal le plus récent', () => {
    expect(fallbackThreadAfterRemoval([m1, m2], 'gone', 's1')).toBe('m2');
    expect(fallbackThreadAfterRemoval([m2, m1], 'gone', 's1')).toBe('m2');
  });

  it('aucun thread restant : accueil', () => {
    expect(fallbackThreadAfterRemoval([], undefined, 's1')).toBeUndefined();
    expect(fallbackThreadAfterRemoval([], 'm1', 's1')).toBeUndefined();
  });

  it('principal restant unique : lui', () => {
    expect(fallbackThreadAfterRemoval([m1], undefined, 'x')).toBe('m1');
  });
});

describe('carte « Sous-agent supprimé »', () => {
  it('grisée, ids échappés', () => {
    const html = subagentRemovedCardHtml('c<x>', 'b<1>');
    expect(html).toContain('class="sacard sa-gone"');
    expect(html).toContain('data-thread="c&#60;x&#62;"');
    expect(html).toContain('id="b&#60;1&#62;"');
    expect(html).toContain('Sous-agent supprimé');
    expect(html).not.toContain('c<x>');
    expect(html).not.toContain('b<1>');
  });

  it('carte seule grise, sans enveloppe de groupe', () => {
    const block = cardsBlockHtml([{ blockId: 'b0', removedId: 'gone1' }], 'sg-b0');
    expect(block.single).toBe(true);
    expect(block.html).toContain('class="sacard sa-gone"');
    expect(block.html).not.toContain('sagroup');
  });

  it('dans un groupe : en-tête compte les supprimés, cartes vivantes intactes', () => {
    const live = thread({ id: 'c1', status: 'running' });
    const done = thread({ id: 'c2', status: 'done', finishedAt: 2_000 });
    const block = cardsBlockHtml(
      [
        { blockId: 'b0', removedId: 'gone1' },
        { thread: live, blockId: 'b1' },
        { thread: done, blockId: 'b2' },
      ],
      'sg-b0',
    );
    expect(block.single).toBe(false);
    expect(block.html).toContain('data-thread="gone1"');
    expect(block.html).toContain('3 sous-agents · 1 terminé · 1 en cours · 1 supprimé');
    expect(block.html).toContain('data-thread="c1"');
    expect(block.html).toContain('data-thread="c2"');
  });
});

describe('en-tête de groupe avec sous-agents supprimés', () => {
  it('préfixe élargi, suffixe « N supprimé(s) »', () => {
    expect(subagentGroupHeaderText([thread({ status: 'running' })], 2))
      .toBe('3 sous-agents · 1 en cours · 2 supprimés');
    expect(subagentGroupHeaderText([thread({ status: 'done' })], 1))
      .toBe('2 sous-agents · 1 terminé · 1 supprimé');
    expect(subagentGroupHeaderText([thread({ status: 'done' })], 0))
      .toBe('1 sous-agent · 1 terminé');
    expect(subagentGroupHeaderText([], 1))
      .toBe('1 sous-agent · 1 supprimé');
  });
});
