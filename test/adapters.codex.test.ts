import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentEvent } from '../src/core/events';
import type { StartOptions } from '../src/adapters/AgentAdapter';
import {
  CodexAdapter,
  codexHasModelsCommand,
  parseCodexConfig,
  parseCodexEfforts,
  parseCodexModels,
} from '../src/adapters/codex';

const ROOT = process.cwd();
const MOCK = path.join(ROOT, 'src', 'adapters', '__mocks__', 'mockCli.js');
const FIXTURES = path.join(ROOT, 'src', 'adapters', '__mocks__', 'fixtures');
const HELP = path.join(FIXTURES, 'codex-help.txt');

const ENV_KEYS = [
  'MOCK_ARGS_FILE', 'MOCK_ENV_FILE', 'MOCK_HELP_FILE', 'MOCK_MODELS_FILE',
  'MOCK_EXIT_CODE', 'MOCK_DELAY_MS', 'CODEX_HOME',
] as const;
let savedEnv: Record<string, string | undefined>;
let tmp: string;
let argsFile: string;
let envFile: string;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-codex-'));
  argsFile = path.join(tmp, 'args.jsonl');
  envFile = path.join(tmp, 'env.jsonl');
  process.env.MOCK_ARGS_FILE = argsFile;
  process.env.MOCK_ENV_FILE = envFile;
  process.env.MOCK_HELP_FILE = HELP;
  process.env.MOCK_MODELS_FILE = path.join(FIXTURES, 'codex-models.txt');
  const codexHome = path.join(tmp, 'codex-home');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-5.1-codex"\nmodel_reasoning_effort = "high"\n');
  process.env.CODEX_HOME = codexHome;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function adapter(fixture = path.join(FIXTURES, 'codex-basic.jsonl')): CodexAdapter {
  return new CodexAdapter({ command: process.execPath, prefixArgs: [MOCK, fixture] });
}

function readCalls(): string[][] {
  if (!fs.existsSync(argsFile)) return [];
  return fs.readFileSync(argsFile, 'utf8').split(/\r?\n/).filter(Boolean)
    .map((l) => (JSON.parse(l) as string[]).slice(1));
}

function runCalls(): string[][] {
  return readCalls().filter((args) => args.includes('exec') && !args.includes('--help'));
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

describe('CodexAdapter — capabilities', () => {
  it('parse l’aide simulée et le fichier de modèles', async () => {
    const help = fs.readFileSync(HELP, 'utf8');
    expect(parseCodexEfforts(help)).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh']);
    expect(parseCodexModels(help)).toEqual(['gpt-5.1-codex', 'gpt-5.1-codex-mini', 'gpt-5.1']);
    expect(codexHasModelsCommand(help)).toBe(true);
    expect(parseCodexConfig('model = "gpt-5.1"\nmodel_reasoning_effort = "low"\n')).toEqual({
      model: 'gpt-5.1',
      effort: 'low',
    });
  });

  it('découvre les capabilities via `models`, l’aide et ~/.codex/config.toml', async () => {
    const a = adapter();
    const caps = await a.getCapabilities();
    expect(caps.models).toEqual([{ id: 'gpt-5.1-codex' }, { id: 'gpt-5.1-codex-mini' }, { id: 'gpt-5.1' }]);
    expect(caps.effortLevels?.map((e) => e.id)).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh']);
    expect(caps.defaultModel).toBe('gpt-5.1-codex');
    expect(caps.defaultEffort).toBe('high');

    await a.getCapabilities();
    expect(readCalls().filter((args) => args.includes('models'))).toHaveLength(1);
  });

  it('isAvailable renvoie la version', async () => {
    await expect(adapter().isAvailable()).resolves.toEqual({ ok: true, detail: 'mock 1.0.0' });
  });
});

describe('CodexAdapter — arguments', () => {
  it('génère les flags attendus et ne met jamais le token dans les args', async () => {
    const run = adapter().start(options('fais un truc', {
      model: 'gpt-5.1-codex',
      effort: 'high',
      mcpServerUrl: 'http://localhost:1234/mcp',
      mcpToken: 'jeton-secret',
      systemPromptAppend: 'REGLE ABSOLUE',
      allowedPaths: ['src/**'],
    }));
    await collectUntil(run.events[Symbol.asyncIterator](), isFinal);

    const call = runCalls()[0];
    expect(call).toBeDefined();
    expect(call[0]).toBe('exec');
    expect(call).toEqual(expect.arrayContaining([
      '--json', '--skip-git-repo-check',
      '-m', 'gpt-5.1-codex',
      '-c', 'model_reasoning_effort=high',
      '--sandbox', 'workspace-write',
      '-c', 'approval_policy=never',
      '-c', 'mcp_servers.agenthub.url=http://localhost:1234/mcp',
      '-c', 'mcp_servers.agenthub.bearer_token_env_var=AGENT_HUB_MCP_TOKEN',
    ]));
    expect(call.at(-1)).toBe('REGLE ABSOLUE\n\nfais un truc');
    expect(call.some((a) => a.includes('jeton-secret'))).toBe(false);
    expect(call).not.toContain('resume');

    const env = readEnvCalls().at(-1);
    expect(env?.AGENT_HUB_MCP_TOKEN).toBe('jeton-secret');
  });

  it('readonly → sandbox read-only', async () => {
    const run = adapter().start(options('lis', { permissionMode: 'readonly' }));
    await collectUntil(run.events[Symbol.asyncIterator](), isFinal);
    expect(runCalls()[0]).toEqual(expect.arrayContaining(['--sandbox', 'read-only']));
  });

  it('edit → workspace-write sans accès réseau', async () => {
    const run = adapter().start(options('édite', { permissionMode: 'edit' }));
    await collectUntil(run.events[Symbol.asyncIterator](), isFinal);
    const call = runCalls()[0];
    expect(call).toEqual(expect.arrayContaining(['--sandbox', 'workspace-write']));
    expect(call).not.toContain('sandbox_workspace_write.network_access=true');
  });

  it('full → workspace-write + accès réseau', async () => {
    const run = adapter().start(options('fonce', { permissionMode: 'full' }));
    await collectUntil(run.events[Symbol.asyncIterator](), isFinal);
    expect(runCalls()[0]).toEqual(expect.arrayContaining([
      '--sandbox', 'workspace-write',
      '-c', 'sandbox_workspace_write.network_access=true',
    ]));
  });
});

describe('CodexAdapter — mapping des événements', () => {
  it('traduit la fixture JSONL', async () => {
    const run = adapter().start(options('lis a.txt'));
    const raw: string[] = [];
    run.onRawLine?.((stream, line) => raw.push(`${stream}:${line.slice(0, 20)}`));
    const events = await collectUntil(run.events[Symbol.asyncIterator](), isFinal);

    expect(events[0]).toEqual({ type: 'session_started', sessionId: 'thr_mock_001' });

    const calls = events.filter((e) => e.type === 'tool_call');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      type: 'tool_call',
      id: 'item_1',
      name: 'command_execution',
      input: { command: 'cat a.txt' },
    });
    expect(calls[1]).toMatchObject({ type: 'tool_call', id: 'item_3', name: 'agenthub.commit' });

    const results = events.filter((e) => e.type === 'tool_result');
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ id: 'item_1', name: 'command_execution', output: 'hello\n', isError: false });
    expect(results[1]).toMatchObject({ id: 'item_3', name: 'agenthub.commit', isError: false });

    expect(events.filter((e) => e.type === 'file_changed')).toEqual([
      { type: 'file_changed', path: 'b.txt' },
      { type: 'file_changed', path: 'src/c.txt' },
    ]);
    expect(events).toContainEqual({ type: 'assistant_text', text: 'Lu a.txt (hello) et créé b.txt.', partial: false });
    expect(events).toContainEqual({ type: 'usage', tokens: 150 });
    expect(events.at(-1)).toEqual({ type: 'done', summary: 'Lu a.txt (hello) et créé b.txt.' });
    expect(raw.length).toBeGreaterThan(0);
  });

  it('turn.failed → error', async () => {
    const fixture = path.join(tmp, 'codex-failed.jsonl');
    fs.writeFileSync(fixture, '{"type":"turn.failed","error":{"message":"quota dépassé"}}\n');
    const run = adapter(fixture).start(options('test'));
    const events = await collectUntil(run.events[Symbol.asyncIterator](), isFinal);
    expect(events.at(-1)).toEqual({ type: 'error', message: 'quota dépassé' });
  });

  it('ignore une ligne JSON invalide', async () => {
    const fixture = path.join(tmp, 'codex-invalid.jsonl');
    fs.writeFileSync(fixture, [
      'pas du json',
      '{"type":"thread.started","thread_id":"thr_x"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"bonjour"}}',
      '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":10}}',
      '',
    ].join('\n'));
    const run = adapter(fixture).start(options('test'));
    const events = await collectUntil(run.events[Symbol.asyncIterator](), isFinal);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events).toContainEqual({ type: 'assistant_text', text: 'bonjour', partial: false });
    expect(events).toContainEqual({ type: 'usage', tokens: 15 });
    expect(events.at(-1)).toEqual({ type: 'done', summary: 'bonjour' });
  });
});

describe('CodexAdapter — erreurs et sessions', () => {
  it('effort invalide → uniquement une erreur listant les valeurs, sans lancer le CLI', async () => {
    const run = adapter().start(options('test', { effort: 'turbo' }));
    const events = await collectAll(run.events[Symbol.asyncIterator]());
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    if (events[0].type === 'error') {
      expect(events[0].message).toContain("Niveau d'effort invalide");
      expect(events[0].message).toContain('minimal, low, medium, high, xhigh');
    }
    expect(runCalls()).toHaveLength(0);
  });

  it('modèle invalide → erreur listant les modèles découverts', async () => {
    const run = adapter().start(options('test', { model: 'gpt-4' }));
    const events = await collectAll(run.events[Symbol.asyncIterator]());
    expect(events).toHaveLength(1);
    if (events[0].type === 'error') {
      expect(events[0].message).toContain('Modèle invalide');
      expect(events[0].message).toContain('gpt-5.1-codex');
    }
    expect(runCalls()).toHaveLength(0);
  });

  it('CLI absent → isAvailable ok:false et start → error clair', async () => {
    const a = new CodexAdapter({ command: 'agent-hub-cli-inexistant-codex' });
    const available = await a.isAvailable();
    expect(available.ok).toBe(false);
    expect(available.detail).toContain('CLI codex introuvable');
    expect(available.detail).toContain('agentHub.codex.path');

    const events = await collectUntil(a.start(options('test')).events[Symbol.asyncIterator](), isFinal);
    const err = events.at(-1);
    expect(err?.type).toBe('error');
    if (err?.type === 'error') {
      expect(err.message).toContain('introuvable');
      expect(err.message).toContain('agentHub.codex.path');
    }
  });

  it('sendMessage reprend la session via `exec resume`', async () => {
    const run = adapter().start(options('premier'));
    const it = run.events[Symbol.asyncIterator]();
    const first = await collectUntil(it, isFinal);
    expect(first.at(-1)?.type).toBe('done');
    expect(runCalls()[0]).not.toContain('resume');

    void run.sendMessage('second');
    const second = await collectUntil(it, isFinal);
    expect(second.some((e) => e.type === 'user_text')).toBe(true);
    expect(second.at(-1)?.type).toBe('done');

    const call = runCalls()[1];
    expect(call.slice(0, 3)).toEqual(['exec', 'resume', 'thr_mock_001']);
    expect(call).toEqual(expect.arrayContaining(['--json', '--skip-git-repo-check']));
  });
});
