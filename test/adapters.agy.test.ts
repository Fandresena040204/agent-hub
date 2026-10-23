import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentEvent } from '../src/core/events';
import type { StartOptions } from '../src/adapters/AgentAdapter';
import { AgyAdapter, agyHasModelsCommand, parseAgyEffort, parseAgyModels } from '../src/adapters/agy';

const ROOT = process.cwd();
const MOCK = path.join(ROOT, 'src', 'adapters', '__mocks__', 'mockCli.js');
const FIXTURES = path.join(ROOT, 'src', 'adapters', '__mocks__', 'fixtures');
const HELP = path.join(FIXTURES, 'agy-help.txt');

const ENV_KEYS = [
  'MOCK_ARGS_FILE', 'MOCK_ENV_FILE', 'MOCK_HELP_FILE', 'MOCK_MODELS_FILE',
  'MOCK_EXIT_CODE', 'MOCK_DELAY_MS',
] as const;
let savedEnv: Record<string, string | undefined>;
let tmp: string;
let argsFile: string;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-agy-'));
  argsFile = path.join(tmp, 'args.jsonl');
  process.env.MOCK_ARGS_FILE = argsFile;
  process.env.MOCK_HELP_FILE = HELP;
  process.env.MOCK_MODELS_FILE = path.join(tmp, 'models.txt');
  fs.writeFileSync(process.env.MOCK_MODELS_FILE, 'gemini-3-pro\ngemini-3-flash\n');
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function adapter(fixture = path.join(FIXTURES, 'agy-basic.jsonl')): AgyAdapter {
  return new AgyAdapter({ command: process.execPath, prefixArgs: [MOCK, fixture] });
}

function readCalls(): string[][] {
  if (!fs.existsSync(argsFile)) return [];
  return fs.readFileSync(argsFile, 'utf8').split(/\r?\n/).filter(Boolean)
    .map((l) => (JSON.parse(l) as string[]).slice(1));
}

function runCalls(): string[][] {
  return readCalls().filter((args) => args.includes('-p'));
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

describe('AgyAdapter — capabilities', () => {
  it('parse l’aide simulée', () => {
    const help = fs.readFileSync(HELP, 'utf8');
    expect(parseAgyModels(help)).toEqual(['gemini-3-pro', 'gemini-3-flash', 'claude-sonnet-4-5']);
    expect(parseAgyEffort(help)).toEqual({ flag: '--effort', levels: ['low', 'medium', 'high'] });
    expect(agyHasModelsCommand(help)).toBe(true);
  });

  it('découvre et met en cache les capabilities', async () => {
    const a = adapter();
    const caps = await a.getCapabilities();
    expect(caps.models).toEqual([
      { id: 'gemini-3-pro' },
      { id: 'gemini-3-flash' },
      { id: 'claude-sonnet-4-5' },
    ]);
    expect(caps.effortLevels?.map((e) => e.id)).toEqual(['low', 'medium', 'high']);
    await a.getCapabilities();
    expect(readCalls().filter((args) => args.includes('--help'))).toHaveLength(1);
  });

  it('isAvailable renvoie la version', async () => {
    await expect(adapter().isAvailable()).resolves.toEqual({ ok: true, detail: 'mock 1.0.0' });
  });
});

describe('AgyAdapter — arguments', () => {
  it('génère les flags attendus (modèle, effort, mode, MCP, git)', async () => {
    const run = adapter().start(options('fais un truc', {
      model: 'gemini-3-pro',
      effort: 'high',
      mcpServerUrl: 'http://localhost:1234/mcp',
      mcpToken: 'jeton',
      systemPromptAppend: 'REGLE ABSOLUE',
      allowedPaths: ['src/**'],
    }));
    await collectUntil(run.events[Symbol.asyncIterator](), isFinal);

    const call = runCalls()[0];
    expect(call).toBeDefined();
    expect(call.slice(0, 2)).toEqual(['-p', 'REGLE ABSOLUE\n\nfais un truc']);
    expect(call).toEqual(expect.arrayContaining([
      '--output-format', 'stream-json', '--non-interactive',
      '--model', 'gemini-3-pro',
      '--effort', 'high',
      '--mode', 'accept-edits',
    ]));
    expect(call).not.toContain('--resume');

    const mcp = JSON.parse(call[call.indexOf('--mcp-config') + 1]) as {
      mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>;
    };
    expect(mcp.mcpServers.agenthub).toEqual({
      type: 'http',
      url: 'http://localhost:1234/mcp',
      headers: { Authorization: 'Bearer jeton' },
    });

    const idx = call.indexOf('--disallowed-tools');
    expect(idx).toBeGreaterThan(-1);
    expect(call).toContain('Bash(git commit:*)');
    expect(call).toContain('PowerShell(git push:*)');
  });

  it('readonly → --mode plan', async () => {
    const run = adapter().start(options('lis', { permissionMode: 'readonly' }));
    await collectUntil(run.events[Symbol.asyncIterator](), isFinal);
    expect(runCalls()[0]).toEqual(expect.arrayContaining(['--mode', 'plan']));
  });

  it('full → --mode accept-edits', async () => {
    const run = adapter().start(options('fonce', { permissionMode: 'full' }));
    await collectUntil(run.events[Symbol.asyncIterator](), isFinal);
    expect(runCalls()[0]).toEqual(expect.arrayContaining(['--mode', 'accept-edits']));
  });

  it('ignore mcpServerUrl si l’aide ne montre pas --mcp-config', async () => {
    const help = path.join(tmp, 'agy-help-sans-mcp.txt');
    fs.writeFileSync(help, 'Usage: agy [OPTIONS]\n\nOptions:\n  -p, --prompt <prompt>\n          Prompt.\n');
    process.env.MOCK_HELP_FILE = help;
    const run = adapter().start(options('test', { mcpServerUrl: 'http://localhost:1234/mcp', mcpToken: 'secret' }));
    await collectUntil(run.events[Symbol.asyncIterator](), isFinal);
    const call = runCalls()[0];
    expect(call).not.toContain('--mcp-config');
    expect(call.some((a) => a.includes('secret'))).toBe(false);
  });
});

describe('AgyAdapter — mapping des événements', () => {
  it('traduit la fixture stream-json', async () => {
    const run = adapter().start(options('lis a.txt'));
    const raw: string[] = [];
    run.onRawLine?.((stream, line) => raw.push(`${stream}:${line.slice(0, 20)}`));
    const events = await collectUntil(run.events[Symbol.asyncIterator](), isFinal);

    expect(events[0]).toEqual({ type: 'session_started', sessionId: 'agy-sess-001' });

    expect(events.filter((e) => e.type === 'assistant_text')).toEqual([
      { type: 'assistant_text', text: 'Je regarde a.txt.', partial: false },
      { type: 'assistant_text', text: 'Créé b.txt.', partial: false },
    ]);

    const calls = events.filter((e) => e.type === 'tool_call');
    expect(calls.map((e) => (e as { name: string }).name)).toEqual(['Read', 'Write']);

    const results = events.filter((e) => e.type === 'tool_result');
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ id: 'tu_1', name: 'Read', output: 'hello', isError: false });
    expect(results[1]).toMatchObject({ id: 'tu_2', name: 'Write', isError: false });

    expect(events).toContainEqual({ type: 'file_changed', path: 'b.txt' });
    expect(events).toContainEqual({ type: 'usage', tokens: 120, cost: 0.001 });
    expect(events.at(-1)).toEqual({ type: 'done', summary: 'Créé b.txt.' });
    expect(raw.length).toBeGreaterThan(0);
  });

  it('résultat en erreur → error', async () => {
    const fixture = path.join(tmp, 'agy-error.jsonl');
    fs.writeFileSync(fixture, '{"type":"result","subtype":"error","is_error":true,"result":"modèle surchargé"}\n');
    const run = adapter(fixture).start(options('test'));
    const events = await collectUntil(run.events[Symbol.asyncIterator](), isFinal);
    expect(events.at(-1)).toEqual({ type: 'error', message: 'modèle surchargé' });
  });

  it('ignore une ligne JSON invalide et les types inconnus', async () => {
    const fixture = path.join(tmp, 'agy-invalid.jsonl');
    fs.writeFileSync(fixture, [
      '{oops',
      '{"type":"system","subtype":"init","session_id":"agy-x"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"bonjour"}]}}',
      '{"type":"inconnu","blabla":true}',
      '{"type":"result","result":"fini","usage":{"input_tokens":5,"output_tokens":10}}',
      '',
    ].join('\n'));
    const run = adapter(fixture).start(options('test'));
    const events = await collectUntil(run.events[Symbol.asyncIterator](), isFinal);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events).toContainEqual({ type: 'assistant_text', text: 'bonjour', partial: false });
    expect(events).toContainEqual({ type: 'usage', tokens: 15 });
    expect(events.at(-1)).toEqual({ type: 'done', summary: 'fini' });
  });
});

describe('AgyAdapter — erreurs et sessions', () => {
  it('effort invalide → uniquement une erreur listant les valeurs', async () => {
    const run = adapter().start(options('test', { effort: 'turbo' }));
    const events = await collectAll(run.events[Symbol.asyncIterator]());
    expect(events).toHaveLength(1);
    if (events[0].type === 'error') {
      expect(events[0].message).toContain("Niveau d'effort invalide");
      expect(events[0].message).toContain('low, medium, high');
    }
    expect(runCalls()).toHaveLength(0);
  });

  it('modèle invalide → erreur listant les modèles', async () => {
    const run = adapter().start(options('test', { model: 'gpt-4' }));
    const events = await collectAll(run.events[Symbol.asyncIterator]());
    expect(events).toHaveLength(1);
    if (events[0].type === 'error') {
      expect(events[0].message).toContain('Modèle invalide');
      expect(events[0].message).toContain('gemini-3-pro');
    }
    expect(runCalls()).toHaveLength(0);
  });

  it('CLI absent → isAvailable ok:false et start → error clair', async () => {
    const a = new AgyAdapter({ command: 'agent-hub-cli-inexistant-agy' });
    const available = await a.isAvailable();
    expect(available.ok).toBe(false);
    expect(available.detail).toContain('CLI agy introuvable');
    expect(available.detail).toContain('agentHub.agy.path');

    const events = await collectUntil(a.start(options('test')).events[Symbol.asyncIterator](), isFinal);
    const err = events.at(-1);
    expect(err?.type).toBe('error');
    if (err?.type === 'error') {
      expect(err.message).toContain('introuvable');
      expect(err.message).toContain('agentHub.agy.path');
    }
  });

  it('sendMessage reprend la session (--resume)', async () => {
    const run = adapter().start(options('premier'));
    const it = run.events[Symbol.asyncIterator]();
    const first = await collectUntil(it, isFinal);
    expect(first.at(-1)?.type).toBe('done');
    expect(runCalls()[0]).not.toContain('--resume');

    void run.sendMessage('second');
    const second = await collectUntil(it, isFinal);
    expect(second.some((e) => e.type === 'user_text')).toBe(true);
    expect(second.at(-1)?.type).toBe('done');
    expect(runCalls()[1]).toEqual(expect.arrayContaining(['--resume', 'agy-sess-001']));
  });
});
