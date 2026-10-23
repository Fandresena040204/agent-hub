import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentEvent } from '../src/core/events';
import type { StartOptions } from '../src/adapters/AgentAdapter';
import { ClaudeAdapter, parseClaudeEfforts, parseClaudeModelAliases } from '../src/adapters/claude';

const ROOT = process.cwd();
const MOCK = path.join(ROOT, 'src', 'adapters', '__mocks__', 'mockCli.js');
const FIXTURES = path.join(ROOT, 'src', 'adapters', '__mocks__', 'fixtures');
const REAL_HELP = path.join(ROOT, 'docs', '_claude-help.txt');

const ENV_KEYS = ['MOCK_ARGS_FILE', 'MOCK_ENV_FILE', 'MOCK_HELP_FILE', 'MOCK_EXIT_CODE', 'MOCK_DELAY_MS'] as const;
let savedEnv: Record<string, string | undefined>;
let tmp: string;
let argsFile: string;
let envFile: string;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-claude-'));
  argsFile = path.join(tmp, 'args.jsonl');
  envFile = path.join(tmp, 'env.jsonl');
  process.env.MOCK_ARGS_FILE = argsFile;
  process.env.MOCK_ENV_FILE = envFile;
  process.env.MOCK_HELP_FILE = REAL_HELP;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function adapter(fixture = path.join(FIXTURES, 'claude-basic.jsonl'), guardScript?: string): ClaudeAdapter {
  return new ClaudeAdapter({ command: process.execPath, prefixArgs: [MOCK, fixture], guardScript });
}

function readCalls(): string[][] {
  if (!fs.existsSync(argsFile)) return [];
  return fs.readFileSync(argsFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as string[]);
}

function runCalls(): string[][] {
  return readCalls().filter((args) => args.includes('-p'));
}

function readEnvCalls(): Record<string, string>[] {
  if (!fs.existsSync(envFile)) return [];
  return fs.readFileSync(envFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

function options(prompt: string, extra: Partial<StartOptions> = {}): StartOptions {
  return {
    prompt,
    cwd: tmp,
    permissionMode: 'edit',
    gitPolicy: { forbidden: ['commit', 'push'], role: 'main' },
    ...extra,
  };
}

async function nextWithTimeout(it: AsyncIterator<AgentEvent>, ms = 15000): Promise<IteratorResult<AgentEvent>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout en attendant un événement')), ms);
    it.next().then(
      (r) => { clearTimeout(timer); resolve(r); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function collectUntil(it: AsyncIterator<AgentEvent>, stop: (e: AgentEvent) => boolean): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for (;;) {
    const r = await nextWithTimeout(it);
    if (r.done) return out;
    out.push(r.value);
    if (stop(r.value)) return out;
  }
}

async function collectAll(it: AsyncIterator<AgentEvent>): Promise<AgentEvent[]> {
  return collectUntil(it, () => false);
}

const isFinal = (e: AgentEvent) => e.type === 'done' || e.type === 'error';

describe('ClaudeAdapter — capabilities', () => {
  it('parse l’aide réelle de claude', () => {
    const help = fs.readFileSync(REAL_HELP, 'utf8');
    expect(parseClaudeEfforts(help)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    const aliases = parseClaudeModelAliases(help);
    expect(aliases).toContain('fable');
    expect(aliases).toContain('opus');
    expect(aliases).toContain('sonnet');
  });

  it('découvre les capabilities via le CLI et les met en cache', async () => {
    const a = adapter();
    const caps = await a.getCapabilities();
    expect(caps.models).toEqual(expect.arrayContaining([{ id: 'opus' }, { id: 'sonnet' }]));
    expect(caps.effortLevels?.map((e) => e.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    await a.getCapabilities();
    expect(readCalls().filter((args) => args.includes('--help'))).toHaveLength(1);
  });

  it('isAvailable renvoie la version', async () => {
    const a = adapter();
    await expect(a.isAvailable()).resolves.toEqual({ ok: true, detail: 'mock 1.0.0' });
  });
});

describe('ClaudeAdapter — arguments', () => {
  it('génère tous les flags attendus', async () => {
    const guard = path.join(tmp, 'guard.js');
    const run = adapter(path.join(FIXTURES, 'claude-basic.jsonl'), guard).start(options('fais un truc', {
      model: 'opus',
      effort: 'high',
      mcpServerUrl: 'http://localhost:1234/mcp',
      mcpToken: 'jeton',
      systemPromptAppend: 'REGLE ABSOLUE',
      allowedPaths: ['src/**'],
    }));
    const it = run.events[Symbol.asyncIterator]();
    await collectUntil(it, isFinal);

    const call = runCalls()[0];
    expect(call).toBeDefined();
    expect(call).toEqual(expect.arrayContaining([
      '-p', 'fais un truc', '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none',
      '--model', 'opus', '--effort', 'high', '--append-system-prompt', 'REGLE ABSOLUE',
      '--permission-mode', 'acceptEdits',
    ]));
    expect(call).toContain('Bash(git commit:*)');
    expect(call).toContain('PowerShell(git commit:*)');
    expect(call).toContain('Bash(git push:*)');

    const mcp = JSON.parse(call[call.indexOf('--mcp-config') + 1]) as {
      mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>;
    };
    expect(mcp.mcpServers.agenthub).toEqual({
      type: 'http',
      url: 'http://localhost:1234/mcp',
      headers: { Authorization: 'Bearer jeton' },
    });

    const settings = JSON.parse(call[call.indexOf('--settings') + 1]) as {
      hooks: { PreToolUse: { matcher: string; hooks: { type: string; command: string }[] }[] };
    };
    const hook = settings.hooks.PreToolUse[0];
    expect(hook.matcher).toBe('Edit|Write|NotebookEdit|Bash|PowerShell');
    expect(hook.hooks[0].command).toBe(`node "${guard}"`);

    const env = readEnvCalls().find((e) => e.AGENT_HUB_ALLOWED_PATHS !== undefined);
    expect(env).toBeDefined();
    expect(JSON.parse(env!.AGENT_HUB_ALLOWED_PATHS)).toEqual(['src/**']);
    expect(JSON.parse(env!.AGENT_HUB_FORBIDDEN_GIT)).toEqual(['commit', 'push']);
  });

  it('readonly passe --permission-mode default et interdit les outils d’écriture', async () => {
    const run = adapter().start(options('lis', { permissionMode: 'readonly' }));
    const it = run.events[Symbol.asyncIterator]();
    await collectUntil(it, isFinal);
    const call = runCalls()[0];
    expect(call).toEqual(expect.arrayContaining(['--permission-mode', 'default']));
    for (const tool of ['Edit', 'Write', 'NotebookEdit']) expect(call).toContain(tool);
  });

  it('full passe bypassPermissions', async () => {
    const run = adapter().start(options('fonce', { permissionMode: 'full' }));
    const it = run.events[Symbol.asyncIterator]();
    await collectUntil(it, isFinal);
    expect(runCalls()[0]).toEqual(expect.arrayContaining(['--permission-mode', 'bypassPermissions']));
  });
});

describe('ClaudeAdapter — mapping des événements', () => {
  it('traduit la fixture réelle', async () => {
    const run = adapter().start(options('lis a.txt'));
    const raw: string[] = [];
    run.onRawLine?.((stream, line) => raw.push(`${stream}:${line.slice(0, 20)}`));
    const events = await collectUntil(run.events[Symbol.asyncIterator](), isFinal);

    expect(events[0]).toEqual({ type: 'session_started', sessionId: '85950b43-853e-4b24-9830-f8458873fa58' });

    const toolCalls = events.filter((e) => e.type === 'tool_call');
    expect(toolCalls).toHaveLength(3);
    expect(toolCalls[0]).toMatchObject({ type: 'tool_call', name: 'Read' });

    const results = events.filter((e) => e.type === 'tool_result');
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ name: 'Read', isError: false });
    expect(results[1]).toMatchObject({ name: 'Read', isError: true });

    expect(events).toContainEqual({ type: 'file_changed', path: events
      .filter((e) => e.type === 'tool_call' && e.name === 'Write')
      .map((e) => (e as { input: { file_path: string } }).input.file_path)[0] });

    expect(events).toContainEqual({ type: 'usage', tokens: 427, cost: 0.00375799 });
    expect(events.at(-1)).toMatchObject({ type: 'done', summary: 'Read `a.txt` (it contains "hello") and wrote `b.txt` with "bye".' });
    expect(raw.length).toBeGreaterThan(0);
  });

  it('ignore une ligne JSON invalide', async () => {
    const run = adapter(path.join(FIXTURES, 'claude-invalid.jsonl')).start(options('test'));
    const events = await collectUntil(run.events[Symbol.asyncIterator](), isFinal);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events).toContainEqual({ type: 'assistant_text', text: 'bonjour', partial: false });
    expect(events).toContainEqual({ type: 'usage', tokens: 15, cost: 0.01 });
    expect(events.at(-1)).toEqual({ type: 'done', summary: 'fini' });
  });

  it('résultat is_error → error', async () => {
    const run = adapter(path.join(FIXTURES, 'claude-error.jsonl')).start(options('test'));
    const events = await collectUntil(run.events[Symbol.asyncIterator](), isFinal);
    expect(events.at(-1)).toEqual({ type: 'error', message: 'modèle surchargé' });
  });
});

describe('ClaudeAdapter — erreurs et sessions', () => {
  it('modèle invalide → une seule erreur listant les valeurs valides, sans lancer le CLI', async () => {
    const run = adapter().start(options('test', { model: 'GPT 4.1' }));
    const events = await collectAll(run.events[Symbol.asyncIterator]());
    expect(events).toHaveLength(1);
    const err = events[0];
    expect(err.type).toBe('error');
    if (err.type === 'error') {
      expect(err.message).toContain('Modèle invalide');
      expect(err.message).toContain('opus');
      expect(err.message).toContain('claude-');
    }
    expect(runCalls()).toHaveLength(0);
  });

  it('effort invalide → erreur listant les niveaux', async () => {
    const run = adapter().start(options('test', { effort: 'turbo' }));
    const events = await collectAll(run.events[Symbol.asyncIterator]());
    expect(events).toHaveLength(1);
    if (events[0].type === 'error') {
      expect(events[0].message).toContain('low, medium, high, xhigh, max');
    }
  });

  it('accepte un id complet claude-…', async () => {
    const run = adapter().start(options('test', { model: 'claude-futur-9' }));
    const events = await collectUntil(run.events[Symbol.asyncIterator](), isFinal);
    expect(events.at(-1)?.type).toBe('done');
    expect(runCalls()[0]).toEqual(expect.arrayContaining(['--model', 'claude-futur-9']));
  });

  it('CLI absent → message clair', async () => {
    const a = new ClaudeAdapter({ command: 'agent-hub-cli-inexistant-claude' });
    await expect(a.isAvailable()).resolves.toMatchObject({ ok: false });
    const run = a.start(options('test'));
    const events = await collectUntil(run.events[Symbol.asyncIterator](), isFinal);
    const err = events.at(-1);
    expect(err?.type).toBe('error');
    if (err?.type === 'error') {
      expect(err.message).toContain('introuvable');
      expect(err.message).toContain('agentHub.claude.path');
    }
  });

  it('sendMessage reprend la session (--resume) et met en file pendant un tour', async () => {
    process.env.MOCK_DELAY_MS = '60';
    const run = adapter().start(options('premier'));
    const it = run.events[Symbol.asyncIterator]();
    const first = await collectUntil(it, isFinal);
    expect(first.at(-1)?.type).toBe('done');
    expect(runCalls()[0]).not.toContain('--resume');

    void run.sendMessage('second');
    const second = await collectUntil(it, isFinal);
    expect(second.some((e) => e.type === 'user_text')).toBe(true);
    expect(second.at(-1)?.type).toBe('done');
    const call = runCalls()[1];
    expect(call).toEqual(expect.arrayContaining(['--resume', '85950b43-853e-4b24-9830-f8458873fa58']));
  });

  it('un message envoyé pendant le tour est mis en file', async () => {
    process.env.MOCK_DELAY_MS = '80';
    const run = adapter().start(options('premier'));
    const it = run.events[Symbol.asyncIterator]();
    // Premier événement (session_started) : le tour est en cours.
    const firstEvent = await nextWithTimeout(it);
    expect(firstEvent.done).toBe(false);
    void run.sendMessage('deuxième');
    const rest = await collectUntil(it, isFinal);
    const rest2 = await collectUntil(it, isFinal);
    expect(rest.concat(rest2).filter((e) => e.type === 'done')).toHaveLength(2);
    expect(runCalls()[1]).toEqual(expect.arrayContaining(['--resume']));
  });

  it('interrupt ferme le flux et tue le processus', async () => {
    process.env.MOCK_DELAY_MS = '250';
    const run = adapter().start(options('long'));
    const it = run.events[Symbol.asyncIterator]();
    const first = await nextWithTimeout(it);
    expect(first.done).toBe(false);
    const started = Date.now();
    await run.interrupt();
    const rest = await collectAll(it);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(rest.some((e) => e.type === 'done')).toBe(false);
    await run.sendMessage('ignoré');
  });
});
