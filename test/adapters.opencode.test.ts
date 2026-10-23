import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentEvent } from '../src/core/events';
import type { StartOptions } from '../src/adapters/AgentAdapter';
import { OpenCodeAdapter, parseVariants, parseVariantsByModel } from '../src/adapters/opencode';

const ROOT = process.cwd();
const MOCK = path.join(ROOT, 'src', 'adapters', '__mocks__', 'mockCli.js');
const FIXTURES = path.join(ROOT, 'src', 'adapters', '__mocks__', 'fixtures');

const ENV_KEYS = [
  'MOCK_ARGS_FILE', 'MOCK_ENV_FILE', 'MOCK_MODELS_FILE', 'MOCK_API_FILE', 'MOCK_EXIT_CODE', 'MOCK_DELAY_MS',
] as const;
let savedEnv: Record<string, string | undefined>;
let tmp: string;
let argsFile: string;
let envFile: string;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-opencode-'));
  argsFile = path.join(tmp, 'args.jsonl');
  envFile = path.join(tmp, 'env.jsonl');
  process.env.MOCK_ARGS_FILE = argsFile;
  process.env.MOCK_ENV_FILE = envFile;
  process.env.MOCK_MODELS_FILE = path.join(FIXTURES, 'opencode-models.txt');
  process.env.MOCK_API_FILE = path.join(FIXTURES, 'opencode-api-model.json');
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function adapter(fixture = path.join(FIXTURES, 'opencode-basic.jsonl')): OpenCodeAdapter {
  return new OpenCodeAdapter({ command: process.execPath, prefixArgs: [MOCK, fixture] });
}

function readCalls(): string[][] {
  if (!fs.existsSync(argsFile)) return [];
  return fs.readFileSync(argsFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as string[]);
}

function runCalls(): string[][] {
  return readCalls().filter((args) => args.includes('run'));
}

function readEnvCalls(): Record<string, string>[] {
  if (!fs.existsSync(envFile)) return [];
  return fs.readFileSync(envFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

function runConfig(): Record<string, unknown> {
  const env = readEnvCalls().filter((e) => e.OPENCODE_CONFIG_CONTENT).at(-1);
  expect(env).toBeDefined();
  return JSON.parse(env!.OPENCODE_CONFIG_CONTENT) as Record<string, unknown>;
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

const isFinal = (e: AgentEvent) => e.type === 'done' || e.type === 'error';

async function collectAll(it: AsyncIterator<AgentEvent>): Promise<AgentEvent[]> {
  return collectUntil(it, () => false);
}

describe('OpenCodeAdapter — capabilities', () => {
  it('liste les modèles et les variantes (#effort)', async () => {
    const caps = await adapter().getCapabilities();
    expect(caps.models).toEqual([{ id: 'opencode/mock-model' }, { id: 'other/m' }, { id: 'plain/model' }]);
    expect(caps.effortLevels?.map((e) => e.id)).toEqual(['low', 'high', 'max']);
    expect(caps.effortLevelsByModel).toEqual({
      'opencode/mock-model': [{ id: 'low' }, { id: 'high' }, { id: 'max' }],
      'other/m': [{ id: 'low' }],
      'plain/model': [],
    });
  });

  it('parseVariants tolère une réponse vide ou invalide', () => {
    expect(parseVariants('{oops')).toBeNull();
    expect(parseVariants('{"data":[]}')).toBeNull();
    expect(parseVariants('{"data":[{"variants":[{"id":"low"},{"id":"high"}]}]}')).toEqual(['low', 'high']);
  });

  it('parseVariantsByModel construit la clé provider/model', () => {
    expect(parseVariantsByModel('{oops')).toBeNull();
    expect(
      parseVariantsByModel(
        '{"data":[{"id":"vendor/x","modelID":"x","providerID":"p","variants":[{"id":"low"}]},{"id":"vendor/y","modelID":"y","providerID":"p","variants":[]}]}',
      ),
    ).toEqual({ 'p/x': [{ id: 'low' }], 'p/y': [] });
  });

  it('isAvailable renvoie la version', async () => {
    await expect(adapter().isAvailable()).resolves.toEqual({ ok: true, detail: 'mock 1.0.0' });
  });
});

describe('OpenCodeAdapter — arguments', () => {
  it('génère les flags et la config de permissions', async () => {
    const run = adapter().start(options('fais un truc', {
      model: 'opencode/mock-model',
      effort: 'high',
      mcpServerUrl: 'http://localhost:1234/mcp',
      mcpToken: 'jeton',
      systemPromptAppend: 'REGLE ABSOLUE',
      allowedPaths: ['src/**'],
    }));
    await collectUntil(run.events[Symbol.asyncIterator](), isFinal);

    const call = runCalls()[0];
    expect(call).toEqual(expect.arrayContaining([
      'run', '--format', 'json', '--standalone', '-m', 'opencode/mock-model#high', '--auto',
    ]));
    expect(call.at(-1)).toBe('REGLE ABSOLUE\n\nfais un truc');
    expect(call).not.toContain('--session');

    const config = runConfig();
    const permissions = config.permissions as { action: string; resource: string; effect: string }[];
    expect(permissions[0]).toEqual({ action: 'edit', resource: '*', effect: 'deny' });
    expect(permissions).toContainEqual({ action: 'edit', resource: 'src/**', effect: 'allow' });
    expect(permissions).toContainEqual({ action: 'execute', resource: '*', effect: 'deny' });
    expect(permissions).toContainEqual({ action: 'shell', resource: '*git*commit*', effect: 'deny' });
    expect(permissions).toContainEqual({ action: 'shell', resource: '*git*push*', effect: 'deny' });

    expect(config.mcp).toEqual({
      servers: {
        agenthub: {
          type: 'remote',
          url: 'http://localhost:1234/mcp',
          headers: { Authorization: 'Bearer jeton' },
        },
      },
    });
  });

  it('readonly refuse édition, shell et execute, sans --auto', async () => {
    const run = adapter().start(options('lis', { permissionMode: 'readonly' }));
    await collectUntil(run.events[Symbol.asyncIterator](), isFinal);
    const call = runCalls()[0];
    expect(call).not.toContain('--auto');
    const permissions = runConfig().permissions as { action: string; resource: string; effect: string }[];
    expect(permissions).toEqual([
      { action: 'edit', resource: '*', effect: 'deny' },
      { action: 'shell', resource: '*', effect: 'deny' },
      { action: 'execute', resource: '*', effect: 'deny' },
    ]);
  });

  it('full accepte tout sauf les commandes git interdites', async () => {
    const run = adapter().start(options('fonce', { permissionMode: 'full' }));
    await collectUntil(run.events[Symbol.asyncIterator](), isFinal);
    const call = runCalls()[0];
    expect(call).toContain('--auto');
    const permissions = runConfig().permissions as { action: string; resource: string; effect: string }[];
    expect(permissions).toHaveLength(2);
    expect(permissions.every((p) => p.effect === 'deny')).toBe(true);
  });
});

describe('OpenCodeAdapter — mapping des événements', () => {
  it('traduit la fixture réelle', async () => {
    const run = adapter().start(options('lis a.txt'));
    const events = await collectUntil(run.events[Symbol.asyncIterator](), isFinal);

    expect(events.filter((e) => e.type === 'session_started')).toEqual([
      { type: 'session_started', sessionId: 'ses_e967aef81ffexKmXLnM13ZVnmV' },
    ]);
    expect(events).toContainEqual({ type: 'assistant_text', text: '`a.txt` contains "hello". Created `c.txt` with "bye".', partial: false });

    const calls = events.filter((e) => e.type === 'tool_call');
    expect(calls.map((e) => (e as { name: string }).name)).toEqual(['read', 'write']);
    const results = events.filter((e) => e.type === 'tool_result');
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ name: 'read', isError: false });
    expect(results[1]).toMatchObject({ name: 'write', isError: false });
    expect(events).toContainEqual({ type: 'file_changed', path: 'c.txt' });

    const usage = events.filter((e) => e.type === 'usage') as { tokens: number; cost?: number }[];
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({ tokens: 4545, cost: 0 });
    expect(usage[1].tokens).toBe(147);

    expect(events.at(-1)).toEqual({ type: 'done', summary: '`a.txt` contains "hello". Created `c.txt` with "bye".' });
  });

  it('ignore une ligne JSON invalide', async () => {
    const run = adapter(path.join(FIXTURES, 'opencode-invalid.jsonl')).start(options('test'));
    const events = await collectUntil(run.events[Symbol.asyncIterator](), isFinal);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events).toContainEqual({ type: 'assistant_text', text: 'bonjour', partial: false });
    expect(events).toContainEqual({ type: 'usage', tokens: 15, cost: 0.002 });
    expect(events.at(-1)).toEqual({ type: 'done', summary: 'fini' });
  });

  it('type error → error', async () => {
    const run = adapter(path.join(FIXTURES, 'opencode-error.jsonl')).start(options('test'));
    const events = await collectUntil(run.events[Symbol.asyncIterator](), isFinal);
    expect(events.at(-1)).toEqual({ type: 'error', message: 'boom' });
  });
});

describe('OpenCodeAdapter — erreurs et sessions', () => {
  it('modèle invalide → erreur listant les modèles', async () => {
    const run = adapter().start(options('test', { model: 'gpt' }));
    const events = await collectAll(run.events[Symbol.asyncIterator]());
    expect(events).toHaveLength(1);
    if (events[0].type === 'error') {
      expect(events[0].message).toContain('Modèle invalide');
      expect(events[0].message).toContain('opencode/mock-model');
    }
    expect(runCalls()).toHaveLength(0);
  });

  it('effort invalide → erreur listant les variantes', async () => {
    const run = adapter().start(options('test', { effort: 'turbo' }));
    const events = await collectAll(run.events[Symbol.asyncIterator]());
    expect(events).toHaveLength(1);
    if (events[0].type === 'error') expect(events[0].message).toContain('low, high, max');
  });

  it('effort propre au modèle : accepté pour other/m, refusé pour un autre modèle', async () => {
    const ok = adapter().start(options('test', { model: 'other/m', effort: 'low' }));
    const events = await collectUntil(ok.events[Symbol.asyncIterator](), isFinal);
    expect(events.at(-1)?.type).toBe('done');
    expect(runCalls()[0]).toEqual(expect.arrayContaining(['-m', 'other/m#low']));

    const bad = adapter().start(options('test', { model: 'other/m', effort: 'high' }));
    const errors = await collectAll(bad.events[Symbol.asyncIterator]());
    expect(errors).toHaveLength(1);
    if (errors[0].type === 'error') {
      expect(errors[0].message).toContain("Niveau d'effort invalide");
      expect(errors[0].message).toContain('Valeurs valides : low');
      expect(errors[0].message).not.toContain('low, high');
      expect(errors[0].message).not.toContain('max');
    }
  });

  it('modèle sans variante : aucun effort accepté', async () => {
    const run = adapter().start(options('test', { model: 'plain/model', effort: 'low' }));
    const events = await collectAll(run.events[Symbol.asyncIterator]());
    expect(events).toHaveLength(1);
    if (events[0].type === 'error') {
      expect(events[0].message).toContain("Niveau d'effort invalide");
      expect(events[0].message).toContain('(aucune)');
    }
  });

  it('CLI absent → message clair', async () => {
    const a = new OpenCodeAdapter({ command: 'agent-hub-cli-inexistant-opencode' });
    await expect(a.isAvailable()).resolves.toMatchObject({ ok: false });
    const events = await collectUntil(a.start(options('test')).events[Symbol.asyncIterator](), isFinal);
    const err = events.at(-1);
    expect(err?.type).toBe('error');
    if (err?.type === 'error') {
      expect(err.message).toContain('introuvable');
      expect(err.message).toContain('agentHub.opencode.path');
    }
  });

  it('sendMessage reprend la session (--session)', async () => {
    const run = adapter().start(options('premier'));
    const it = run.events[Symbol.asyncIterator]();
    await collectUntil(it, isFinal);
    expect(runCalls()[0]).not.toContain('--session');

    void run.sendMessage('second');
    const second = await collectUntil(it, isFinal);
    expect(second.some((e) => e.type === 'user_text')).toBe(true);
    expect(second.at(-1)?.type).toBe('done');
    expect(runCalls()[1]).toEqual(expect.arrayContaining(['--session', 'ses_e967aef81ffexKmXLnM13ZVnmV']));
  });

  it('interrupt ferme le flux', async () => {
    process.env.MOCK_DELAY_MS = '250';
    const run = adapter().start(options('long'));
    const it = run.events[Symbol.asyncIterator]();
    const first = await nextWithTimeout(it);
    expect(first.done).toBe(false);
    await run.interrupt();
    const rest = await collectAll(it);
    expect(rest.some((e) => e.type === 'done')).toBe(false);
  });
});
