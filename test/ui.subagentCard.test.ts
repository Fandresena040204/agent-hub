// Tests des cartes de sous-agents : logique pure de src/ui/chatViewModel.ts + src/ui/presentation.ts.
import { describe, expect, it } from 'vitest';
import {
  cardsBlockHtml,
  readOnlyForThread,
  subagentCardHtml,
  subagentGroupHtml,
  subagentProgressText,
  type SubagentCardDatum,
} from '../src/ui/chatViewModel';
import {
  SUBAGENT_END_STATUSES,
  breaksSubagentGroup,
  buildChatHtml,
  cardDurationMs,
  cardPhase,
  formatDuration,
  groupHeaderText,
  lineageHtml,
  subagentNotificationText,
} from '../src/ui/presentation';
import type { AgentEvent } from '../src/core/events';
import type { ThreadInfo } from '../src/core/types';

function thread(overrides: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    id: 'c1',
    parentId: 'p1',
    agent: 'claude',
    model: 'opus',
    permissionMode: 'edit',
    isolation: 'shared',
    cwd: '/w',
    title: 'Corriger les tests',
    status: 'running',
    createdAt: 1_000,
    updatedAt: 1_000,
    changedFiles: [],
    violations: { scope: [], commits: [] },
    ...overrides,
  };
}

const NOW = 61_000; // 60 s après la création : durée 01:00

describe('durée des cartes', () => {
  it('formatDuration : mm:ss, minutes non bornées, jamais négative', () => {
    expect(formatDuration(0)).toBe('00:00');
    expect(formatDuration(1_000)).toBe('00:01');
    expect(formatDuration(90_000)).toBe('01:30');
    expect(formatDuration(3_723_000)).toBe('62:03');
    expect(formatDuration(-5_000)).toBe('00:00');
  });

  it('cardDurationMs : maintenant si actif, finishedAt si fini, updatedAt en repli', () => {
    expect(cardDurationMs(thread({ status: 'running' }), NOW)).toBe(60_000);
    expect(cardDurationMs(thread({ status: 'done', finishedAt: 31_000 }), NOW)).toBe(30_000);
    // Tour fini sans finishedAt : la dernière mise à jour sert de fin.
    expect(cardDurationMs(thread({ status: 'done' }), NOW)).toBe(0);
    // Horloge locale dans le futur : bornée à 0.
    expect(cardDurationMs(thread({ status: 'running', createdAt: 100_000 }), NOW)).toBe(0);
  });
});

describe('phase et progression', () => {
  it('cardPhase : run / fail / done', () => {
    expect(cardPhase('starting')).toBe('run');
    expect(cardPhase('running')).toBe('run');
    expect(cardPhase('done')).toBe('done');
    expect(cardPhase('applied')).toBe('done');
    expect(cardPhase('idle')).toBe('done');
    expect(cardPhase('interrupted')).toBe('done');
    expect(cardPhase('error')).toBe('fail');
    expect(cardPhase('conflict')).toBe('fail');
  });

  it('subagentProgressText : activité en direct, puis résumé, sinon erreur', () => {
    expect(subagentProgressText(thread({ lastActivity: '«cherche src»' }))).toBe('«cherche src»');
    expect(subagentProgressText(thread({ lastActivity: undefined }))).toBe('');
    expect(subagentProgressText(thread({ status: 'done', summary: 'Fini proprement' }))).toBe('Fini proprement');
    expect(subagentProgressText(thread({ status: 'error', error: 'boom' }))).toBe('boom');
    // Le résumé prime sur l'erreur enregistrée.
    expect(subagentProgressText(thread({ status: 'error', summary: 'partiel', error: 'boom' }))).toBe('partiel');
  });
});

describe('HTML d\'une carte', () => {
  it('carte en cours : pastille, activité en italique, minuteur, Stop, pas d\'Appliquer', () => {
    const html = subagentCardHtml(
      thread({ lastActivity: '«edits a.ts»' }),
      'b1',
      'sg-b1',
      { count: 2, additions: 5, deletions: 3 },
      NOW,
    );
    expect(html).toContain('<div id="b1" class="sacard sa-run" data-thread="c1" data-group="sg-b1" data-start="1000" data-running="1"');
    expect(html).toContain('title="claude · opus · shared · 01:00"');
    expect(html).toContain('<div class="sa-l3 act">«edits a.ts»</div>');
    expect(html).toContain('<span class="sa-dur">01:00</span>');
    expect(html).toContain('<span class="sa-files">2 fichiers <span class="fnum add">+5</span> <span class="fnum del">−3</span></span>');
    expect(html).toContain('data-cact="openThread"');
    expect(html).toContain('data-cact="stopThread"');
    expect(html).not.toContain('data-cact="applyThread"');
  });

  it('carte terminée : résumé borné à 3 lignes, durée figée, plus de Stop', () => {
    const html = subagentCardHtml(
      thread({ status: 'done', summary: 'Tests corrigés', finishedAt: 31_000 }),
      'b2',
      'sg-b2',
      undefined,
      NOW,
    );
    expect(html).toContain('class="sacard sa-done"');
    expect(html).not.toContain('data-running');
    expect(html).toContain('<div class="sa-l3 sum">Tests corrigés</div>');
    expect(html).toContain('<span class="sa-dur">00:30</span>');
    expect(html).not.toContain('data-cact="stopThread"');
    expect(html).not.toContain('data-cact="applyThread"');
  });

  it('carte en erreur : pastille rouge, message d\'erreur en rouge', () => {
    const html = subagentCardHtml(thread({ status: 'error', error: 'CLI <absent>' }), 'b3', 'sg-b3', undefined, NOW);
    expect(html).toContain('class="sacard sa-fail"');
    expect(html).toContain('<div class="sa-l3 bad">CLI &#60;absent&#62;</div>');
    expect(html).not.toContain('<absent>');
  });

  it('worktree terminé non appliqué : bouton Appliquer ; appliqué ou partagé : jamais', () => {
    const wt = thread({ isolation: 'worktree', status: 'done', worktreePath: '/wt' });
    expect(subagentCardHtml(wt, 'b4', 'sg-b4', undefined, NOW)).toContain('data-cact="applyThread"');
    const wtApplied = thread({ isolation: 'worktree', status: 'applied', worktreePath: '/wt' });
    expect(subagentCardHtml(wtApplied, 'b5', 'sg-b5', undefined, NOW)).not.toContain('data-cact="applyThread"');
    const shared = thread({ status: 'done' });
    expect(subagentCardHtml(shared, 'b6', 'sg-b6', undefined, NOW)).not.toContain('data-cact="applyThread"');
  });

  it('échappement : titre, résumé, scope et id de thread', () => {
    const html = subagentCardHtml(
      thread({
        id: 'c<x>',
        title: 'Corriger <b>les tests</b> & "quotes"',
        status: 'done',
        summary: '<img src=x onerror=alert(1)>',
        scope: ['src/**', 'a"b'],
        violations: { scope: ['out.ts'], commits: [{ oldHead: 'a', newHead: 'b' }] },
        finishedAt: 2_000,
      }),
      'b1',
      'sg-b1',
      undefined,
      NOW,
    );
    expect(html).toContain('data-thread="c&#60;x&#62;"');
    expect(html).toContain('Corriger &#60;b&#62;les tests&#60;/b&#62; &#38; &#34;quotes&#34;');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&#60;img src=x onerror=alert(1)&#62;');
    expect(html).toContain('title="claude · opus · shared · périmètre : src/**, a&#34;b · 00:01"');
    expect(html).toContain('⚠ scope');
    expect(html).toContain('⚠ commit');
  });

  it('titre long tronqué ; totaux absents : pas de compteur de fichiers', () => {
    const long = 'x'.repeat(80);
    const html = subagentCardHtml(thread({ title: long }), 'b1', 'sg-b1', undefined, NOW);
    expect(html).toContain(`${'x'.repeat(63)}…`);
    expect(html).not.toContain('x'.repeat(64));
    const bare = subagentCardHtml(thread(), 'b2', 'sg-b2', undefined, NOW);
    expect(bare).not.toContain('sa-files');
  });
});

describe('en-tête de groupe', () => {
  it('« N sous-agents · X terminés · Y en cours · Z en erreur »', () => {
    const members = [
      thread({ id: 'a', status: 'done' }),
      thread({ id: 'b', status: 'running' }),
      thread({ id: 'c', status: 'done' }),
      thread({ id: 'd', status: 'error' }),
      thread({ id: 'e', status: 'starting' }),
    ];
    expect(groupHeaderText(members)).toBe('5 sous-agents · 2 terminés · 2 en cours · 1 en erreur');
    expect(groupHeaderText([thread({ status: 'done' }), thread({ status: 'interrupted' })]))
      .toBe('2 sous-agents · 2 terminés');
    expect(groupHeaderText([thread()])).toBe('1 sous-agent · 1 en cours');
  });
});

describe('décision de regroupement', () => {
  it('les messages (utilisateur ou assistant) cassent le groupe, pas les événements techniques', () => {
    const breaks: AgentEvent[] = [
      { type: 'user_text', text: 'suite' },
      { type: 'assistant_text', text: 'réponse', partial: false },
    ];
    for (const ev of breaks) expect(breaksSubagentGroup(ev)).toBe(true);
    const kept: AgentEvent[] = [
      { type: 'tool_call', name: 'grep', input: {} },
      { type: 'tool_result', name: 'grep', output: '' },
      { type: 'usage', tokens: 10 },
      { type: 'file_changed', path: 'a.ts' },
      { type: 'done', summary: '' },
      { type: 'session_started', sessionId: 's' },
      { type: 'subagent_started', threadId: 'x' },
    ];
    for (const ev of kept) expect(breaksSubagentGroup(ev)).toBe(false);
  });
});

describe('carte seule ou groupe repliable', () => {
  const t1 = thread({ id: 'c1', status: 'running', title: 'Un' });
  const t2 = thread({ id: 'c2', status: 'done', title: 'Deux', finishedAt: 2_000 });
  const members: SubagentCardDatum[] = [
    { thread: t1, blockId: 'b1' },
    { thread: t2, blockId: 'b2' },
  ];

  it('un seul enfant : carte seule, sans enveloppe de groupe', () => {
    const block = cardsBlockHtml([{ thread: t1, blockId: 'b1' }], 'sg-b1');
    expect(block.single).toBe(true);
    expect(block.html.startsWith('<div id="b1" class="sacard')).toBe(true);
    expect(block.html).not.toContain('sagroup');
  });

  it('plusieurs enfants consécutifs : details repliable ouvert, en-tête, cartes dedans', () => {
    const block = cardsBlockHtml(members, 'sg-b1');
    expect(block.single).toBe(false);
    expect(block.html.startsWith('<details class="sagroup" id="sg-b1" open>')).toBe(true);
    expect(block.html).toContain('<summary class="sagroup-h"><span class="sarrow">▸</span><span class="sgtext">2 sous-agents · 1 terminé · 1 en cours</span></summary>');
    expect(block.html).toContain('data-thread="c1"');
    expect(block.html).toContain('data-thread="c2"');
    expect(block.html.indexOf('data-thread="c1"')).toBeLessThan(block.html.indexOf('data-thread="c2"'));
  });

  it('subagentGroupHtml porte l\'en-tête et l\'id du groupe', () => {
    const html = subagentGroupHtml(members, 'sg-b1');
    expect(html).toContain('id="sg-b1"');
    expect(html).toContain('1 en cours');
    expect(html).toContain('1 terminé');
  });
});

describe('lignée et lecture seule', () => {
  it('fil d\'Ariane : ← parent › enfant, parent cliquable ; principal : rien', () => {
    const child = thread({ id: 's1', parentId: 'm1', title: 'Enfant <x>' });
    const parent = thread({ id: 'm1', title: 'Principal &' });
    const html = lineageHtml(child, parent);
    expect(html).toContain('<button type="button" class="lcrumb" data-id="m1"');
    expect(html).toContain('← Principal &#38;');
    expect(html).toContain('<span class="lgcur">Enfant &#60;x&#62;</span>');
    // Parent inconnu : libellé de repli, le clic reste possible.
    expect(lineageHtml(child, undefined)).toContain('← thread parent');
    expect(lineageHtml(thread({ parentId: undefined }), parent)).toBe('');
  });

  it('readOnlyForThread : enfants seulement, selon le réglage', () => {
    expect(readOnlyForThread(thread(), true)).toBe(true);
    expect(readOnlyForThread(thread(), false)).toBe(false);
    expect(readOnlyForThread(thread({ parentId: undefined }), true)).toBe(false);
    expect(readOnlyForThread(undefined, true)).toBe(false);
  });
});

describe('notification de fin de sous-agent', () => {
  it('texte : titre + agent/modèle + durée', () => {
    const t = thread({ status: 'done', finishedAt: 31_000, model: 'opus' });
    expect(subagentNotificationText(t, NOW)).toBe('Sous-agent terminé : Corriger les tests (claude/opus, 00:30)');
  });

  it('statuts de fin : done, error, interrupted', () => {
    expect(SUBAGENT_END_STATUSES).toEqual(['done', 'error', 'interrupted']);
  });
});

describe('coquille HTML : cartes, lignée, bandeau lecture seule', () => {
  it('la vue pilote cartes en direct, fil d\'Ariane et bandeau de lecture seule', () => {
    const html = buildChatHtml('nOnCe03');
    // Boutons des cartes : dispatch générique sur data-cact (Ouvrir / Stop / Appliquer côté extension).
    expect(html).toContain('data-cact');
    expect(html).toContain('b.dataset.cact');
    expect(html).toContain("t: 'selectThread'");
    expect(html).toContain("m.type === 'card'");
    expect(html).toContain("querySelector('.sgtext')");
    expect(html).toContain("classList.contains('sagroup')");
    expect(html).toContain('data-running');
    expect(html).toContain('id="lignee"');
    expect(html).toContain('id="robar"');
    expect(html).toContain('Aller au thread principal');
    expect(html).toContain('Thread délégué en lecture seule');
    expect(html).toContain("Changer d'agent, de modèle ou d'effort");
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
  });
});

describe('agentRefText sans doublon de fournisseur', () => {
  it('ne répète pas « opencode/ » quand le modèle le contient déjà', async () => {
    const { agentRefText } = await import('../src/ui/presentation');
    expect(agentRefText({ agent: 'opencode', model: 'opencode/glm-5.3-flash-free' })).toBe('opencode/glm-5.3-flash-free');
    expect(agentRefText({ agent: 'opencode', model: 'openrouter/x' })).toBe('opencode/openrouter/x');
  });
});
