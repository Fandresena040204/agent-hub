import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OpenCodeAdapter } from '../src/adapters/opencode';
import {
  parseOpenCodeExport,
  parseOpenCodeSessionList,
  readOpenCodeSession,
} from '../src/adapters/sessions/opencodeSessions';

const ROOT = process.cwd();
const FIXTURES = path.join(ROOT, 'src', 'adapters', '__mocks__', 'fixtures');
const SESSIONS = path.join(FIXTURES, 'sessions');
const MOCK = path.join(ROOT, 'src', 'adapters', '__mocks__', 'mockCli.js');
const CWD = 'C:\\Users\\test\\ws';
const LIST_FILE = path.join(SESSIONS, 'opencode-session-list.json');
const EXPORT_FILE = path.join(SESSIONS, 'opencode-session-export.json');

const ENV_KEYS = ['MOCK_ARGS_FILE', 'MOCK_SESSION_LIST_FILE', 'MOCK_SESSION_EXPORT_FILE'] as const;
let savedEnv: Record<string, string | undefined>;
let tmp: string;
let argsFile: string;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-oc-sessions-'));
  argsFile = path.join(tmp, 'args.jsonl');
  process.env.MOCK_ARGS_FILE = argsFile;
  process.env.MOCK_SESSION_LIST_FILE = LIST_FILE;
  process.env.MOCK_SESSION_EXPORT_FILE = EXPORT_FILE;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function adapter(): OpenCodeAdapter {
  return new OpenCodeAdapter({
    command: process.execPath,
    prefixArgs: [MOCK, path.join(FIXTURES, 'opencode-basic.jsonl')],
  });
}

function readCalls(): string[][] {
  if (!fs.existsSync(argsFile)) return [];
  return fs.readFileSync(argsFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as string[]);
}

function sessionCalls(): string[][] {
  return readCalls().filter((args) => args.includes('session'));
}

describe('sessions OpenCode — liste', () => {
  it('filtre sur directory et trie du plus récent au plus ancien', () => {
    const sessions = parseOpenCodeSessionList(fs.readFileSync(LIST_FILE, 'utf8'), CWD);
    expect(sessions.map((s) => s.id)).toEqual(['ses_new', 'ses_old']);
    expect(sessions[0]).toMatchObject({
      title: 'Nouvelle session',
      createdAt: 1792775400000,
      updatedAt: 1792775500000,
      cwd: CWD,
    });
    expect(sessions[1].title).toBe('Ancienne session');
  });

  it('tolère une réponse invalide ou vide', () => {
    expect(parseOpenCodeSessionList('{oops', CWD)).toEqual([]);
    expect(parseOpenCodeSessionList('{}', CWD)).toEqual([]);
    expect(parseOpenCodeSessionList('[]', CWD)).toEqual([]);
  });

  it('comparaison insensible à la casse sous Windows seulement', () => {
    const json = JSON.stringify([
      { id: 'ses_case', title: 'Casse', updated: 1, created: 1, directory: 'c:\\users\\test\\ws' },
    ]);
    const sessions = parseOpenCodeSessionList(json, CWD);
    expect(sessions).toHaveLength(process.platform === 'win32' ? 1 : 0);
  });

  it('utilise `session list --format json -n 200 --standalone` dans le workspace', async () => {
    const listFile = path.join(tmp, 'list.json');
    const entries = (JSON.parse(fs.readFileSync(LIST_FILE, 'utf8')) as { directory: string }[]).map((s) => ({
      ...s,
      directory: s.directory === CWD ? tmp : s.directory,
    }));
    fs.writeFileSync(listFile, JSON.stringify(entries));
    process.env.MOCK_SESSION_LIST_FILE = listFile;

    const sessions = await adapter().listSessions!(tmp);
    expect(sessions.map((s) => s.id)).toEqual(['ses_new', 'ses_old']);
    expect(sessionCalls()[0]).toEqual(expect.arrayContaining([
      'session', 'list', '--format', 'json', '-n', '200', '--standalone',
    ]));
  });

  it('échec du CLI → erreur explicite', async () => {
    delete process.env.MOCK_SESSION_LIST_FILE;
    await expect(adapter().listSessions!(tmp)).rejects.toThrow(/Liste des sessions OpenCode impossible/);
  });
});

describe('sessions OpenCode — export', () => {
  it('convertit user, text, tool, tool_result et file_changed', () => {
    const content = parseOpenCodeExport(fs.readFileSync(EXPORT_FILE, 'utf8'));
    expect(content).toBeDefined();
    expect(content!.title).toBe('Nouvelle session');
    expect(content!.model).toBe('acme/mock-model');
    expect(content!.effort).toBe('high');
    expect(content!.cwd).toBe(CWD);
    expect(content!.events.map((e) => e.event)).toEqual([
      { type: 'user_text', text: 'Crée a.txt' },
      { type: 'tool_call', id: 'call_write', name: 'write', input: { path: 'a.txt', content: 'ok' } },
      {
        type: 'tool_result',
        id: 'call_write',
        name: 'write',
        output: 'Created file a.txt',
        isError: false,
      },
      { type: 'file_changed', path: 'a.txt' },
      { type: 'tool_call', id: 'call_read', name: 'read', input: { path: 'missing.txt' } },
      { type: 'tool_result', id: 'call_read', name: 'read', output: 'Fichier absent', isError: true },
      { type: 'assistant_text', text: 'a.txt créé.', partial: false },
    ]);
    expect(content!.events.map((e) => e.ts)).toEqual([
      1792775401000,
      1792775402000,
      1792775402000,
      1792775402000,
      1792775402000,
      1792775402000,
      1792775403000,
    ]);
  });

  it('réponse invalide → undefined', () => {
    expect(parseOpenCodeExport('{oops')).toBeUndefined();
    expect(parseOpenCodeExport('{}')).toBeUndefined();
    expect(parseOpenCodeExport('{"messages":[]}')).toBeUndefined();
  });

  it('utilise `session export <id> --standalone` et convertit le contenu', async () => {
    const content = await adapter().readSession!('ses_new', tmp);
    expect(content.title).toBe('Nouvelle session');
    expect(content.events.filter((e) => e.event.type === 'assistant_text')).toHaveLength(1);
    expect(sessionCalls()[0]).toEqual(expect.arrayContaining(['session', 'export', 'ses_new', '--standalone']));
  });

  it('échec du CLI → erreur explicite', async () => {
    delete process.env.MOCK_SESSION_EXPORT_FILE;
    await expect(
      readOpenCodeSession('ses_new', tmp, {
        command: process.execPath,
        prefixArgs: [MOCK, path.join(FIXTURES, 'opencode-basic.jsonl')],
      }),
    ).rejects.toThrow(/Export de la session OpenCode "ses_new" impossible/);
  });

  it('identifiant vide refusé', async () => {
    await expect(
      readOpenCodeSession('  ', tmp, { command: process.execPath, prefixArgs: [MOCK] }),
    ).rejects.toThrow(/vide/);
  });
});
