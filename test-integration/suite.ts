// Scénarios exécutés dans l'Extension Host, avec les vrais CLI claude et opencode.
import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentHubApi } from '../src/extension';
import type { ThreadInfo } from '../src/core/types';

const SUB_MODEL = 'opencode/deepseek-v4.1-flash-free';
const results: { name: string; ok: boolean; detail?: string }[] = [];

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, detail });
    console.log(`  ✗ ${name} : ${detail}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Capture de la seule fenêtre de test (Windows), même masquée, pour contrôle visuel. */
function screenshot(name: string): Promise<void> {
  const dir = process.env.AGENT_HUB_SHOTS;
  const script = process.env.AGENT_HUB_SHOT_SCRIPT;
  if (!dir || !script || process.platform !== 'win32') return Promise.resolve();
  const file = path.join(dir, `${name}.png`);
  return new Promise((resolve) =>
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Out', file], (err, _o, stderr) => {
      if (err) console.log(`  (capture ${name} impossible : ${stderr.trim() || err.message})`);
      resolve();
    }),
  );
}

function git(ws: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: ws, encoding: 'utf8' }).trim();
}

export async function run(): Promise<void> {
  const ws = process.env.AGENT_HUB_TEST_WS!;
  console.log(`Agent Hub — tests d'intégration dans VS Code ${vscode.version} (workspace ${ws})`);

  const ext = vscode.extensions.getExtension<AgentHubApi>('local.agent-hub');
  assert(ext, 'extension local.agent-hub introuvable');
  const api = await ext.activate();
  const orch = api.orchestrator;
  assert(orch, "l'Orchestrator n'a pas été créé (pas de dossier ouvert ?)");
  const head0 = git(ws, 'rev-parse', 'HEAD');

  await step('activation : commandes enregistrées et vues ouvertes', async () => {
    const cmds = await vscode.commands.getCommands(true);
    for (const c of ['agentHub.newMainThread', 'agentHub.openThread', 'agentHub.applyWorktree', 'agentHub.removeWorktree', 'agentHub.toggleCommitPermission', 'agentHub.showThreadDiff']) {
      assert(cmds.includes(c), `commande manquante : ${c}`);
    }
    await vscode.commands.executeCommand('workbench.view.extension.agentHub');
    assert(orch.isGitRepo, 'le workspace de test devrait être un dépôt git');
  });

  await step('list_agents : claude et opencode disponibles avec leurs capacités', async () => {
    const agents = await orch.listAgents();
    const claude = agents.find((a) => a.id === 'claude');
    const oc = agents.find((a) => a.id === 'opencode');
    assert(claude?.available, `claude indisponible : ${claude?.detail}`);
    assert(oc?.available, `opencode indisponible : ${oc?.detail}`);
    assert(Array.isArray(oc.capabilities?.models) && oc.capabilities.models.some((m) => m.id === SUB_MODEL), 'modèle opencode attendu absent');
    assert(claude.capabilities?.effortLevels?.some((e) => e.id === 'high'), 'efforts claude non découverts');
    const codex = agents.find((a) => a.id === 'codex');
    assert(codex && !codex.available && codex.detail, 'codex absent devrait être indisponible avec un détail');
  });

  await step('permission de commit : off par défaut, bascule en on', async () => {
    assert(orch.getCommitPermission() === 'deny', `attendu deny, obtenu ${orch.getCommitPermission()}`);
    orch.setCommitPermission('allow');
    assert(orch.getCommitPermission() === 'allow', 'bascule non appliquée');
  });

  let main: ThreadInfo | undefined;
  await step('thread principal Claude : délégation à OpenCode visible et commit via MCP', async () => {
    main = await orch.startMainThread({
      agent: 'claude',
      model: 'haiku',
      permissionMode: 'edit',
      prompt:
        "Utilise les outils MCP agent-hub. 1) Appelle list_agents. 2) Appelle delegate avec agent 'opencode', model '" +
        SUB_MODEL +
        "', mode 'edit', isolation 'shared', scope ['hello.txt'], wait true, et le prompt : \"Crée le fichier hello.txt contenant exactement la ligne: bonjour\". 3) Appelle commit avec le threadId obtenu et le message 'ajout hello'. Réponds ensuite en une phrase avec le sha.",
    });
    // La conversation s'affiche dans la vue latérale (barre secondaire), comme le Chat de VS Code.
    await vscode.commands.executeCommand('agentHub.openThread', main.id);
    await sleep(1500);

    // Pendant que le sous-agent tourne : capture de la vue Threads.
    for (let i = 0; i < 240 && !orch.listThreads().some((t) => t.parentId === main!.id); i++) await sleep(500);
    await sleep(4000);
    await screenshot('1-delegation-en-cours');

    const final = await orch.waitThread(main.id, 600);
    assert(final.status === 'idle', `statut principal : ${final.status} ${final.error ?? ''}`);
    const child = orch.listThreads().find((t) => t.parentId === main!.id);
    assert(child, 'aucun thread délégué créé');
    assert(child.agent === 'opencode' && child.model === SUB_MODEL, `thread enfant inattendu : ${child.agent} ${child.model}`);
    assert(child.changedFiles.includes('hello.txt'), `fichiers modifiés : ${child.changedFiles.join(',')}`);
    assert(child.violations.commits.length === 0 && child.violations.scope.length === 0, 'violations inattendues');
    const log = git(ws, 'log', '--oneline', '-1');
    assert(/ajout hello/.test(log), `dernier commit : ${log}`);
    assert(orch.getEvents(main.id).some((e) => e.event.type === 'commit_made'), 'commit_made absent');
    assert(git(ws, 'branch', '--list').split('\n').length === 1, 'une branche a été créée');
    await screenshot('2-principal-termine');
  });

  await step('ouverture du thread délégué : panneau dédié, ChangesView et diff', async () => {
    const child = orch.listThreads().find((t) => t.parentId === main?.id);
    assert(child, 'pas de thread enfant');
    await vscode.commands.executeCommand('agentHub.openThread', child.id);
    await sleep(1500);
    const changes = await orch.changedFiles(child.id);
    assert(changes.some((c) => c.path === 'hello.txt'), 'hello.txt absent de changedFiles');
    const base = await orch.baseContent(child.id, 'hello.txt');
    assert(base === undefined, 'la base de hello.txt devrait être vide (fichier créé)');
    await vscode.commands.executeCommand(
      'vscode.diff',
      vscode.Uri.parse(`agenthub-base:/hello.txt?thread=${child.id}&empty=1`),
      vscode.Uri.file(path.join(ws, 'hello.txt')),
      'hello.txt (diff du thread)',
    );
    await sleep(1500);
    await vscode.commands.executeCommand('agentHub.changes.focus');
    await sleep(800);
    await screenshot('3-thread-delegue-et-diff');
  });

  await step('worktree : isolation, application non commitée, suppression', async () => {
    assert(main, 'pas de thread principal');
    const headBefore = git(ws, 'rev-parse', 'HEAD');
    const t = await orch.delegate(main.id, {
      agent: 'opencode',
      model: SUB_MODEL,
      prompt: "Dans le fichier notes.txt, remplace exactement la ligne 'ligne 2' par 'ligne 2 modifiée par le worktree'. Ne touche à rien d'autre.",
      mode: 'edit',
      isolation: 'worktree',
    });
    assert(t.isolation === 'worktree' && t.worktreePath, 'thread worktree non créé');
    const done = await orch.waitThread(t.id, 600);
    assert(done.status === 'done', `statut worktree : ${done.status} ${done.error ?? ''}`);
    assert(!fs.readFileSync(path.join(ws, 'notes.txt'), 'utf8').includes('worktree'), 'le workspace a été modifié avant application');
    const files = await orch.changedFiles(t.id);
    assert(files.some((f) => f.path === 'notes.txt'), `changedFiles worktree : ${files.map((f) => f.path).join(',')}`);
    await vscode.commands.executeCommand('agentHub.openThread', t.id);
    await sleep(1000);
    await screenshot('4-worktree-avant-application');

    await vscode.commands.executeCommand('agentHub.applyWorktree', t.id);
    assert(fs.readFileSync(path.join(ws, 'notes.txt'), 'utf8').includes('modifiée par le worktree'), 'modification non appliquée');
    assert(git(ws, 'rev-parse', 'HEAD') === headBefore, 'HEAD a changé lors de l\'application');
    assert(git(ws, 'status', '--porcelain').includes('notes.txt'), 'notes.txt devrait être modifié et non commité');
    assert(git(ws, 'diff', '--cached', '--name-only') === '', "l'index ne devrait pas être modifié");
    assert(orch.getThread(t.id)?.status === 'applied', `statut après application : ${orch.getThread(t.id)?.status}`);
    assert(git(ws, 'branch', '--list').split('\n').length === 1, 'une branche a été créée');
    await sleep(1000);
    await screenshot('5-worktree-applique');
    await vscode.commands.executeCommand('agentHub.removeWorktree', t.id);
    assert(!fs.existsSync(t.worktreePath!), 'le worktree existe encore');
  });

  await step("changer d'agent, même CLI : session reprise avec un autre modèle", async () => {
    assert(main, 'pas de thread principal');
    const before = orch.getThread(main.id)!;
    const t = await orch.changeAgent(main.id, { agent: 'claude', model: 'sonnet', effort: 'low' });
    assert(t.model === 'sonnet' && t.effort === 'low', `modèle/effort : ${t.model} ${t.effort}`);
    assert(t.sessionId === before.sessionId, 'la session native devrait être conservée');
    const sw = orch.getEvents(main.id).filter((e) => e.event.type === 'agent_switched').pop()?.event;
    assert(sw?.type === 'agent_switched' && sw.mode === 'resume', 'bandeau de relais (resume) absent');
    await orch.sendMessage(main.id, 'Réponds uniquement par le mot OK, sans aucun outil.');
    const done = await orch.waitThread(main.id, 300);
    assert(done.status === 'idle', `statut : ${done.status} ${done.error ?? ''}`);
    assert(done.sessionId === before.sessionId, `session changée : ${before.sessionId} → ${done.sessionId}`);
    await vscode.commands.executeCommand('agentHub.openThread', main.id);
    await sleep(1200);
    await screenshot('6-changement-modele-meme-cli');
  });

  await step("changer d'agent principal vers OpenCode : passation, mêmes threads délégués", async () => {
    assert(main, 'pas de thread principal');
    const childrenBefore = orch.listThreads().filter((t) => t.parentId === main!.id).length;
    await orch.changeAgent(main.id, {
      agent: 'opencode',
      model: SUB_MODEL,
      message: "Sans utiliser d'outil, réponds en une phrase : quel fichier a été créé et commité dans ce thread, et par quel agent ?",
    });
    const done = await orch.waitThread(main.id, 400);
    assert(done.status === 'idle', `statut : ${done.status} ${done.error ?? ''}`);
    assert(done.agent === 'opencode', `agent courant : ${done.agent}`);
    assert((done.agentHistory?.length ?? 0) >= 3, `historique des agents : ${done.agentHistory?.length}`);
    assert(orch.listThreads().filter((t) => t.parentId === main!.id).length === childrenBefore, 'threads délégués perdus');
    const evs = orch.getEvents(main.id);
    const firstUserAfter = evs.slice(evs.findIndex((e) => e.event.type === 'agent_switched' && e.event.mode === 'handoff')).find((e) => e.event.type === 'user_text');
    const lastText = [...evs].reverse().find((e) => e.event.type === 'assistant_text')?.event;
    assert(firstUserAfter, 'message après passation absent');
    assert(lastText?.type === 'assistant_text' && /hello/i.test(lastText.text), `le nouvel agent ne connaît pas le contexte : ${lastText?.type === 'assistant_text' ? lastText.text.slice(0, 200) : '—'}`);
    await vscode.commands.executeCommand('agentHub.openThread', main.id);
    await sleep(1200);
    await screenshot('7-passation-vers-opencode');
  });

  await step('annuler les modifications d\'un thread shared (par fichier)', async () => {
    assert(main, 'pas de thread principal');
    const t = await orch.delegate(main.id, {
      agent: 'opencode',
      model: SUB_MODEL,
      prompt: "Crée le fichier tmp/annule-moi.txt contenant 'à annuler'. Ne touche à rien d'autre.",
      mode: 'edit',
      isolation: 'shared',
      scope: ['tmp/**'],
    });
    await orch.waitThread(t.id, 400);
    const files = await orch.changedFiles(t.id);
    const f = files.find((x) => x.path === 'tmp/annule-moi.txt');
    assert(f && f.additions !== undefined && f.additions >= 1, `stats absentes : ${JSON.stringify(files)}`);
    await orch.revertFiles(t.id, ['tmp/annule-moi.txt']);
    assert(!fs.existsSync(path.join(ws, 'tmp', 'annule-moi.txt')), 'le fichier créé aurait dû être supprimé');
    assert((await orch.changedFiles(t.id)).length === 0, 'il reste des fichiers modifiés');
  });

  await step('commit refusé en mode off, sans effet', async () => {
    orch.setCommitPermission('deny');
    const head = git(ws, 'rev-parse', 'HEAD');
    let msg = '';
    try {
      await orch.commit({ callerThreadId: main?.id, message: 'x', paths: ['notes.txt'] }, async () => true);
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    assert(/off/.test(msg), `refus attendu, obtenu : ${msg || 'aucune erreur'}`);
    assert(git(ws, 'rev-parse', 'HEAD') === head, 'HEAD a changé');
  });

  console.log(`HEAD initial ${head0.slice(0, 7)} → final ${git(ws, 'rev-parse', 'HEAD').slice(0, 7)}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} scénarios réussis`);
  await orch.dispose();
  if (failed.length) throw new Error(`${failed.length} scénario(s) en échec : ${failed.map((f) => f.name).join(' ; ')}`);
}
