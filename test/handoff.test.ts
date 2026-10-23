import { describe, expect, it } from 'vitest';
import { buildHandoff } from '../src/core/handoff';
import type { StoredEvent } from '../src/core/events';
import type { CommitPermission, ThreadInfo } from '../src/core/types';

function thread(overrides: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    id: 't1',
    agent: 'claude',
    model: 'm1',
    permissionMode: 'edit',
    isolation: 'shared',
    cwd: '/ws',
    title: 'Migration API',
    status: 'idle',
    createdAt: 1000,
    updatedAt: 2000,
    changedFiles: [],
    violations: { scope: [], commits: [] },
    ...overrides,
  };
}

function user(ts: number, text: string): StoredEvent {
  return { ts, event: { type: 'user_text', text } };
}

function assistant(ts: number, text: string, partial = false): StoredEvent {
  return { ts, event: { type: 'assistant_text', text, partial } };
}

function base(events: StoredEvent[], extra: Partial<Parameters<typeof buildHandoff>[0]> = {}) {
  return buildHandoff({
    thread: thread(),
    events,
    children: [],
    uncommitted: [],
    commitPermission: 'ask',
    ...extra,
  });
}

describe('buildHandoff', () => {
  it('produit un dossier structuré avec les sections attendues', () => {
    const text = base(
      [
        user(1, 'Migre l\'API vers REST'),
        assistant(2, 'Je commence par les routes.'),
        { ts: 3, event: { type: 'tool_call', name: 'read', input: { path: 'src/a.ts' } } },
        { ts: 4, event: { type: 'commit_made', sha: 'abcdef1234567', message: 'wip', paths: ['a.ts'] } },
        { ts: 5, event: { type: 'scope_violation', path: 'docs/x.md' } },
      ],
      { summary: 'Résumé de l\'agent sortant.', uncommitted: ['src/a.ts'] },
    );

    expect(text.startsWith('Dossier de passation Agent Hub')).toBe(true);
    expect(text).toContain('claude/m1');
    expect(text).toContain("## Demande d'origine");
    expect(text).toContain("Migre l'API vers REST");
    expect(text).toContain("## Résumé de l'agent sortant");
    expect(text).toContain("Résumé de l'agent sortant.");
    expect(text).toContain('## Derniers échanges');
    expect(text).toContain('Utilisateur :');
    expect(text).toContain('Agent :');
    expect(text).toContain('outil read');
    expect(text).toContain('Commit abcdef1');
    expect(text).toContain('Violation de scope : docs/x.md');
    expect(text).toContain('## Threads délégués');
    expect(text).toContain('## Fichiers modifiés non commités');
    expect(text).toContain('- src/a.ts');
    expect(text).toContain('## Permission de commit');
    expect(text).toContain('ask');
    expect(text.trimEnd().endsWith('Continue le travail à partir de cet état. Relis les fichiers si besoin.')).toBe(true);
  });

  it('tronque les échanges les plus anciens pour tenir dans maxChars', () => {
    const events: StoredEvent[] = [user(1, 'TRÈS ANCIEN message')];
    for (let i = 0; i < 40; i++) {
      events.push(assistant(2 + i, `Réponse intermédiaire ${i} `.repeat(8)));
    }
    events.push(user(100, 'MESSAGE RÉCENT À GARDER'));

    const text = base(events, { maxChars: 900 });
    expect(text.length).toBeLessThanOrEqual(900);
    expect(text).toContain('MESSAGE RÉCENT À GARDER');
    // Les réponses intermédiaires les plus anciennes sont coupées (la demande d'origine reste).
    expect(text).not.toContain('Réponse intermédiaire 0 ');
    expect(text).toContain('TRÈS ANCIEN message');
  });

  it('signale un worktree terminé non appliqué', () => {
    const child = thread({
      id: 'c1',
      parentId: 't1',
      isolation: 'worktree',
      status: 'done',
      title: 'Sous-tâche',
      changedFiles: ['src/b.ts'],
      violations: { scope: ['docs/y.md'], commits: [{ oldHead: 'a', newHead: 'b' }] },
    });
    const applied = thread({ id: 'c2', parentId: 't1', isolation: 'worktree', status: 'applied' });

    const text = base([], { children: [child, applied] });
    expect(text).toContain('c1');
    expect(text).toContain('Sous-tâche');
    expect(text).toContain('worktree');
    expect(text).toContain('src/b.ts');
    expect(text).toContain('docs/y.md');
    expect(text).toContain('merge_thread');
    expect(text.indexOf('c1')).toBeLessThan(text.indexOf('merge_thread'));
    expect(text).toContain('c2');
  });

  it('traduit la permission de commit et inclut le résumé fourni', () => {
    for (const [perm, label] of [
      ['deny', 'off'],
      ['ask', 'ask'],
      ['allow', 'on'],
    ] as [CommitPermission, string][]) {
      const text = base([], { commitPermission: perm, summary: 'SYNTHÈSE' });
      expect(text).toContain(label);
      expect(text).toContain('SYNTHÈSE');
    }
  });
});
