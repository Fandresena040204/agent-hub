// Tests de la logique de présentation (src/ui/presentation.ts, sans vscode).
import { describe, expect, it } from 'vitest';
import {
  COMMIT_DIFF_MAX,
  agentHistoryLines,
  agentRefText,
  agentSegmentLine,
  agentSwitchText,
  commitStatusBarText,
  commitStatusBarTooltip,
  commitWord,
  commitPreviewDetail,
  defaultModelChoice,
  effortChoice,
  escapeHtml,
  fileIconId,
  fileParts,
  fileStatusText,
  formatToolBody,
  formatValue,
  formatUsage,
  isThreadRunning,
  permissionFromWord,
  resolveDefaultOption,
  renderEventHtml,
  renderEventPatch,
  sortThreads,
  threadContextValue,
  threadDescription,
  threadIconId,
  threadStatusText,
  threadStatusWord,
  threadTooltip,
  truncate,
} from '../src/ui/presentation';
import type { AgentSegment, ThreadInfo } from '../src/core/types';

function thread(overrides: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    id: 't1',
    agent: 'claude',
    permissionMode: 'edit',
    isolation: 'shared',
    cwd: '/w',
    title: 'Titre',
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
    changedFiles: [],
    violations: { scope: [], commits: [] },
    ...overrides,
  };
}

describe('statuts et contextValue', () => {
  it('threadStatusWord : running / idle / finished', () => {
    expect(threadStatusWord('starting')).toBe('running');
    expect(threadStatusWord('running')).toBe('running');
    expect(threadStatusWord('idle')).toBe('idle');
    expect(threadStatusWord('done')).toBe('finished');
    expect(threadStatusWord('applied')).toBe('finished');
    expect(threadStatusWord('error')).toBe('finished');
    expect(threadStatusWord('conflict')).toBe('finished');
    expect(threadStatusWord('interrupted')).toBe('finished');
  });

  it('threadContextValue suit la forme attendue', () => {
    expect(threadContextValue(thread({ status: 'running', isolation: 'shared' }))).toBe('thread running main shared');
    expect(threadContextValue(thread({ status: 'starting', parentId: 'p', isolation: 'worktree' }))).toBe('thread running sub worktree');
    expect(threadContextValue(thread({ status: 'done', isolation: 'worktree' }))).toBe('thread finished main worktree worktree-done');
    expect(threadContextValue(thread({ status: 'applied', isolation: 'worktree' }))).toBe('thread finished main worktree');
    // idle pilote les menus « Changer d'agent » sur un thread non en cours.
    expect(threadContextValue(thread({ status: 'idle', parentId: 'p' }))).toBe('thread idle sub shared');
    expect(threadContextValue(thread({ status: 'error', isolation: 'worktree' }))).toBe('thread finished main worktree');
    expect(threadContextValue(thread({ status: 'interrupted' }))).toBe('thread finished main shared');
    expect(threadContextValue(thread({ status: 'conflict' }))).toBe('thread finished main shared');
  });

  it('threadDescription omet les champs absents et ajoute les badges', () => {
    expect(threadDescription(thread())).toBe('claude · shared');
    expect(
      threadDescription(thread({ model: 'm1', effort: 'high', isolation: 'worktree', changedFiles: ['a'] })),
    ).toBe('claude · m1 · high · worktree · 1 fichier');
    expect(threadDescription(thread({ changedFiles: ['a', 'b', 'c'] }))).toBe('claude · shared · 3 fichiers');
    expect(
      threadDescription(
        thread({ violations: { scope: ['x/**'], commits: [{ oldHead: 'a', newHead: 'b' }] } }),
      ),
    ).toBe('claude · shared · ⚠ scope · ⚠ commit');
  });

  it('les statuts produisent la bonne icône et le bon libellé', () => {
    expect(threadIconId('starting')).toBe('loading~spin');
    expect(threadIconId('running')).toBe('loading~spin');
    expect(threadIconId('done')).toBe('check');
    expect(threadIconId('applied')).toBe('check');
    expect(threadIconId('error')).toBe('error');
    expect(threadIconId('conflict')).toBe('warning');
    expect(threadIconId('idle')).toBe('debug-pause');
    expect(threadIconId('interrupted')).toBe('circle-slash');
    expect(isThreadRunning('running')).toBe(true);
    expect(isThreadRunning('idle')).toBe(false);
    expect(threadStatusText('done')).toBe('terminé');
  });

  it('sortThreads trie par date de création (stables à date égale)', () => {
    const t3 = thread({ id: 'z', createdAt: 3 });
    const t1 = thread({ id: 'a', createdAt: 1 });
    const t2 = thread({ id: 'b', createdAt: 2 });
    expect(sortThreads([t3, t1, t2]).map((t) => t.id)).toEqual(['a', 'b', 'z']);
  });

  it('threadTooltip regroupe les détails', () => {
    const tip = threadTooltip(
      thread({
        status: 'error',
        model: 'm<x>',
        effort: 'med',
        worktreePath: 'D:/wt/t1',
        scope: ['src/**'],
        changedFiles: ['a'],
        violations: { scope: ['out.ts'], commits: [] },
        summary: 'fin',
        error: 'boom "x"',
      }),
    );
    expect(tip).toContain('**Statut :** erreur');
    expect(tip).toContain('m&#60;x&#62;');
    expect(tip).toContain('D:/wt/t1');
    expect(tip).toContain('src/**');
    expect(tip).toContain('out.ts');
    expect(tip).toContain('boom');
    expect(tip).toContain('fin');
  });
});

describe('barre d’état commits', () => {
  it('mapping deny/ask/allow <-> off/ask/on', () => {
    expect(commitWord('deny')).toBe('off');
    expect(commitWord('ask')).toBe('ask');
    expect(commitWord('allow')).toBe('on');
    expect(permissionFromWord('off')).toBe('deny');
    expect(permissionFromWord('on')).toBe('allow');
  });

  it('textes de la barre d’état', () => {
    expect(commitStatusBarText('deny', true)).toContain('Commits : off');
    expect(commitStatusBarText('ask', true)).toContain('Commits : ask');
    expect(commitStatusBarText('allow', true)).toContain('Commits : on');
    expect(commitStatusBarText('deny', false)).toContain('Commits : n/a');
    expect(commitStatusBarTooltip('deny', false)).toContain('pas un dépôt git');
    expect(commitStatusBarTooltip('ask', true)).toContain('confirmation');
  });
});

describe('échappement et troncature', () => {
  it('escapeHtml neutralise le HTML', () => {
    expect(escapeHtml(`<script>alert("x&y'z")</script>`)).toBe(
      '&#60;script&#62;alert(&#34;x&#38;y&#39;z&#34;)&#60;/script&#62;',
    );
  });

  it('truncate borne la longueur totale', () => {
    expect(truncate('abcdef', 6)).toBe('abcdef');
    expect(truncate('abcdefg', 6)).toBe('abcde…');
    expect(truncate('abcdefgh', 6)).toHaveLength(6);
    expect(truncate('', 0)).toBe('');
  });
});

describe('fichiers modifiés', () => {
  it('fileParts sépare dossier et nom, / ou \\', () => {
    expect(fileParts('src/a/b.ts')).toEqual({ dir: 'src/a', name: 'b.ts' });
    expect(fileParts('a.ts')).toEqual({ dir: '', name: 'a.ts' });
    expect(fileParts('src\\win.ts')).toEqual({ dir: 'src', name: 'win.ts' });
  });

  it('icônes et libellés par statut', () => {
    expect(fileIconId('added')).toBe('diff-added');
    expect(fileIconId('modified')).toBe('diff-modified');
    expect(fileIconId('deleted')).toBe('diff-removed');
    expect(fileStatusText('deleted')).toBe('supprimé');
  });
});

describe('assistant de création', () => {
  it('resolveDefaultOption : réglage > capabilities > premier de la liste', () => {
    const list = [{ id: 'a' }, { id: 'b' }];
    expect(resolveDefaultOption(list, undefined, undefined)).toBe('a');
    expect(resolveDefaultOption(list, 'b', undefined)).toBe('b');
    expect(resolveDefaultOption(list, 'b', 'a')).toBe('a');
    expect(resolveDefaultOption(list, undefined, 'inconnu')).toBe('a');
    expect(resolveDefaultOption('free-text', undefined, 'm1')).toBe('m1');
    expect(resolveDefaultOption('free-text', 'm2', undefined)).toBe('m2');
    expect(resolveDefaultOption([], undefined, undefined)).toBeUndefined();
  });
});

describe('rendu des événements', () => {
  it('textes utilisateur/assistant échappés', () => {
    const html = renderEventHtml({ type: 'user_text', text: '<b>&</b>' }, 'b1');
    expect(html).toContain('class="row user"');
    expect(html).not.toContain('<b>');
    const html2 = renderEventHtml({ type: 'assistant_text', text: 'L1\nL2', partial: false }, 'b2');
    expect(html2).toContain('bubble assistant');
  });

  it('outils : JSON indenté, string brut, tronqué à 4000', () => {
    const call = renderEventHtml({ type: 'tool_call', name: 'grep', input: { a: 1 } }, 'b3');
    expect(call).toContain('details');
    expect(call).toContain('&#34;a&#34;: 1');
    expect(call).not.toContain('&amp;amp;');
    const big = { s: 'x'.repeat(9000) };
    const body = formatToolBody(big);
    expect(body.length).toBeLessThanOrEqual(4000);
    expect(formatToolBody('déjà\nstring')).toContain('déjà');
    expect(formatValue({ a: [1] })).toContain('1');
  });

  it('bannières, séparation, usage', () => {
    expect(renderEventHtml({ type: 'scope_violation', path: 'etc/passwd' }, 'b4')).toContain('banner err');
    expect(renderEventHtml({ type: 'commit_violation', oldHead: 'aaaaaaaaaa', newHead: 'bbbbbbbbbb' }, 'b5')).toContain('banner err');
    expect(renderEventHtml({ type: 'commit_made', sha: 'cccccccccc', message: 'ajoute x', paths: [] }, 'b6')).toContain('banner ok');
    expect(renderEventHtml({ type: 'error', message: 'fail <>' }, 'b7')).toContain('banner err');
    const sep = renderEventHtml({ type: 'done', summary: 'fini <i>' }, 'b8');
    expect(sep).toContain('sep');
    expect(sep).not.toContain('<i>');
    expect(renderEventHtml({ type: 'usage', tokens: 12345, cost: 0.5 }, 'b9')).toContain('12');
    expect(formatUsage(1500)).toBe('1\u202f500 tokens');
    expect(formatUsage(1500, 0.0042)).toContain('0.0042');
  });

  it('pliation des partiels : remplace le dernier bloc partiel', () => {
    const p1 = renderEventPatch(null, { type: 'assistant_text', text: 'a', partial: true }, 'b1');
    expect(p1).toEqual({ target: null, html: expect.any(String), openPartialId: 'b1' });
    const p2 = renderEventPatch(p1.openPartialId, { type: 'assistant_text', text: 'ab', partial: true }, 'b2');
    expect(p2.target).toBe('b1');
    expect(p2.openPartialId).toBe('b2');
    const fin = renderEventPatch(p2.openPartialId, { type: 'assistant_text', text: 'abcd', partial: false }, 'b3');
    expect(fin.target).toBe('b2');
    expect(fin.openPartialId).toBeNull();
    // Un autre événement ferme le bloc partiel sans le remplacer, et est ajouté.
    const tool = renderEventPatch(fin.openPartialId, { type: 'tool_call', name: 'ls', input: {} }, 'b4');
    expect(tool.target).toBeNull();
    expect(tool.openPartialId).toBeNull();
  });
});

describe('aperçu de commit', () => {
  it('détail = message + fichiers + diff tronqué à ~3000', () => {
    const detail = commitPreviewDetail({ message: 'msg', paths: ['a.ts', 'b.ts'], diffSummary: 'd'.repeat(5000) });
    expect(detail).toContain('msg');
    expect(detail).toContain('a.ts');
    expect(detail).toContain('b.ts');
    expect(detail.length).toBeGreaterThan(2000);
    expect(detail.length).toBeLessThanOrEqual('msg\nFichiers :\n• a.ts\n• b.ts\n'.length + COMMIT_DIFF_MAX);
  });
});

describe('relais d’agent (agent_switched)', () => {
  it('agentRefText compose « agent/modèle · effort »', () => {
    expect(agentRefText({ agent: 'claude', model: 'opus', effort: 'high' })).toBe('claude/opus · high');
    expect(agentRefText({ agent: 'opencode', model: 'glm-5.3' })).toBe('opencode/glm-5.3');
    expect(agentRefText({ agent: 'codex' })).toBe('codex');
  });

  it('agentSwitchText mentionne le mode (session reprise / passation)', () => {
    expect(
      agentSwitchText({
        from: { agent: 'claude', model: 'opus' },
        to: { agent: 'opencode', model: 'glm-5.3' },
        mode: 'resume',
      }),
    ).toBe('relais : claude/opus → opencode/glm-5.3 (session reprise)');
    expect(
      agentSwitchText({ from: { agent: 'claude' }, to: { agent: 'agy', model: 'm', effort: 'low' }, mode: 'handoff' }),
    ).toBe('relais : claude → agy/m · low (passation)');
  });

  it('bandeau neutre centré, en-tête et actions présents, contenu échappé', () => {
    const tip = renderEventHtml(
      { type: 'agent_switched', from: { agent: 'claude', model: 'opus' }, to: { agent: 'opencode', model: 'glm-5.3' }, mode: 'handoff' },
      'b1',
    );
    expect(tip).toContain('class="banner switch"');
    expect(tip).toContain('— relais : claude/opus → opencode/glm-5.3 (passation) —');
    const bad = renderEventHtml(
      { type: 'agent_switched', from: { agent: 'claude', model: '<x>' }, to: { agent: 'agy' }, mode: 'resume' },
      'b2',
    );
    expect(bad).toContain('&#60;x&#62;');
    expect(bad).not.toContain('<x>');
  });
});

describe('agents successifs (infobulle)', () => {
  function at(h: number, m: number): number {
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d.getTime();
  }

  it('agentHistoryLines : null sans historique ou segment unique', () => {
    expect(agentHistoryLines(thread())).toBeNull();
    expect(agentHistoryLines(thread({ agentHistory: [{ agent: 'claude', since: 1, mode: 'start' }] }))).toBeNull();
  });

  it('lignes horodatées avec mode, et section dans threadTooltip quand > 1 segment', () => {
    const hist: AgentSegment[] = [
      { agent: 'claude', model: 'opus', effort: 'high', since: at(14, 5), mode: 'start' },
      { agent: 'opencode', model: 'glm-5.3', since: at(15, 42), mode: 'handoff' },
      { agent: 'agy', model: 'm', since: at(16, 0), mode: 'resume' },
    ];
    const t = thread({ agentHistory: hist });
    expect(agentHistoryLines(t)).toEqual([
      '• 14:05 · claude/opus · high — démarrage',
      '• 15:42 · opencode/glm-5.3 — passation',
      '• 16:00 · agy/m — session reprise',
    ]);
    expect(agentSegmentLine(hist[1])).toBe('15:42 · opencode/glm-5.3 — passation');
    const tip = threadTooltip(t);
    expect(tip).toContain('**Agents successifs :**');
    expect(tip).toContain('claude/opus · high');
    expect(tip).toContain('session reprise');
    expect(threadTooltip(thread())).not.toContain('Agents successifs');
    expect(threadTooltip(thread({ agentHistory: [hist[0]] }))).not.toContain('Agents successifs');
  });
});

describe('choix modèle / effort des assistants', () => {
  it('defaultModelChoice : courant (même agent) > réglage > défaut caps > premier de la liste', () => {
    const caps = { models: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], effortLevels: null, defaultModel: 'b' };
    expect(defaultModelChoice({ caps, agentId: 'claude', setting: 'c' })).toBe('c');
    expect(defaultModelChoice({ caps, agentId: 'claude', current: { agent: 'claude', model: 'c' }, setting: 'a' })).toBe('c');
    // Autre agent choisi : le courant ne s'applique pas.
    expect(defaultModelChoice({ caps, agentId: 'opencode', current: { agent: 'claude', model: 'c' }, setting: 'a' })).toBe('a');
    // Valeur courante hors liste : retombe sur le premier de la liste.
    expect(defaultModelChoice({ caps, agentId: 'claude', current: { agent: 'claude', model: 'zzz' } })).toBe('a');
    expect(defaultModelChoice({ caps, agentId: 'claude' })).toBe('b');
  });

  it('defaultModelChoice en saisie libre : courant > réglage', () => {
    const caps = { models: 'free-text' as const, effortLevels: null };
    expect(defaultModelChoice({ caps, agentId: 'claude', current: { agent: 'claude', model: 'm2' }, setting: 'm1' })).toBe('m2');
    expect(defaultModelChoice({ caps, agentId: 'codex', current: { agent: 'claude', model: 'm2' }, setting: 'm1' })).toBe('m1');
    expect(defaultModelChoice({ caps, agentId: 'claude', setting: 'm1' })).toBe('m1');
    expect(defaultModelChoice({ caps, agentId: 'claude' })).toBeUndefined();
  });

  it('effortChoice filtre les niveaux par modèle via effortLevelsFor', () => {
    const caps = {
      models: 'free-text' as const,
      effortLevels: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }],
      defaultEffort: 'medium',
      effortLevelsByModel: { 'glm-5.3-flash-free': [{ id: 'free' }] },
    };
    // Niveaux propres au modèle prioritaires ; le défaut global « medium » n'y est pas → premier niveau.
    expect(effortChoice(caps, 'glm-5.3-flash-free')).toEqual({ levels: [{ id: 'free' }], def: 'free' });
    expect(effortChoice(caps, 'autre')).toEqual({ levels: caps.effortLevels, def: 'medium' });
    expect(effortChoice(caps, undefined)).toEqual({ levels: caps.effortLevels, def: 'medium' });
    // Liste propre au modèle vide → étape sautée.
    expect(effortChoice({ models: 'free-text', effortLevels: null, effortLevelsByModel: { m: [] } }, 'm')).toEqual({ levels: null, def: undefined });
    // Aucun niveau du tout.
    expect(effortChoice({ models: 'free-text', effortLevels: null }, 'x')).toEqual({ levels: null, def: undefined });
    // Le réglage utilisateur prime sur le défaut caps, sinon premier de la liste.
    expect(effortChoice(caps, 'autre', 'high').def).toBe('high');
    expect(effortChoice({ models: 'free-text', effortLevels: [{ id: 'b' }, { id: 'a' }] }, undefined).def).toBe('b');
  });
});

