import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodexAdapter } from '../src/adapters/codex';
import {
  listCodexSessions,
  parseCodexSessionLines,
  readCodexSession,
} from '../src/adapters/sessions/codexSessions';

const ROOT = process.cwd();
const FIXTURES = path.join(ROOT, 'src', 'adapters', '__mocks__', 'fixtures');
const CODEX_FIXTURES = path.join(FIXTURES, 'sessions', 'codex');
const CWD = 'C:\\Users\\test\\ws';
const NEWEST = path.join(CODEX_FIXTURES, '2026', '10', '27', 'rollout-2026-10-27T10-00-00-aaaaaaaa.jsonl');

let savedCodexHome: string | undefined;
let tmp: string;
let codexHome: string;

beforeEach(() => {
  savedCodexHome = process.env.CODEX_HOME;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-codex-'));
  codexHome = path.join(tmp, '.codex');
  fs.cpSync(CODEX_FIXTURES, path.join(codexHome, 'sessions'), { recursive: true });
  process.env.CODEX_HOME = codexHome;
});

afterEach(() => {
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('sessions Codex — conversion', () => {
  it('convertit les response_item et ignore les messages techniques', () => {
    const lines = fs.readFileSync(NEWEST, 'utf8').split(/\r?\n/);
    const data = parseCodexSessionLines(lines);

    expect(data.sessionId).toBe('codex-session-1');
    expect(data.title).toBe('Crée un fichier b.txt Merci');
    expect(data.cwd).toBe(CWD);
    expect(data.model).toBe('gpt-5-codex');
    expect(data.effort).toBe('medium');
    expect(data.createdAt).toBe(Date.parse('2026-10-27T10:00:00.000Z'));
    expect(data.updatedAt).toBe(Date.parse('2026-10-27T10:00:09.000Z'));
    expect(data.messageCount).toBe(3);

    expect(data.events.map((e) => e.event)).toEqual([
      { type: 'user_text', text: 'Crée un fichier b.txt\nMerci' },
      { type: 'assistant_text', text: 'Je crée le fichier.', partial: false },
      {
        type: 'tool_call',
        id: 'call_1',
        name: 'shell',
        input: { command: ['bash', '-lc', 'echo ok > b.txt'] },
      },
      { type: 'tool_result', id: 'call_1', name: 'shell', output: 'exit 0', isError: false },
      { type: 'assistant_text', text: "C'est fait.", partial: false },
    ]);
  });

  it('lit le titre des métadonnées et tolère les lignes inconnues', () => {
    const data = parseCodexSessionLines(
      [
        JSON.stringify({ type: 'session_meta', payload: { id: 'x', cwd: '/w', title: 'Titre explicite' } }),
        JSON.stringify({ type: 'unknown', payload: { foo: 1 } }),
        '{oops',
      ],
      { fallbackTs: 99 },
    );
    expect(data.sessionId).toBe('x');
    expect(data.title).toBe('Titre explicite');
    expect(data.events).toEqual([]);
    expect(data.updatedAt).toBe(99);
  });

  it('replie le titre sur le premier message utilisateur', () => {
    const data = parseCodexSessionLines([
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Bonjour' }] },
      }),
    ]);
    expect(data.title).toBe('Bonjour');
  });
});

describe('sessions Codex — liste et lecture', () => {
  it('filtre sur cwd et trie du plus récent au plus ancien', async () => {
    const sessions = await listCodexSessions(CWD, { env: { CODEX_HOME: codexHome } });
    expect(sessions.map((s) => s.id)).toEqual(['codex-session-1', 'codex-session-2']);
    expect(sessions[0]).toMatchObject({
      title: 'Crée un fichier b.txt Merci',
      updatedAt: Date.parse('2026-10-27T10:00:09.000Z'),
      cwd: CWD,
      model: 'gpt-5-codex',
      messageCount: 3,
    });
  });

  it('un autre dossier ne voit que ses propres sessions', async () => {
    const sessions = await listCodexSessions('C:\\Users\\test\\other', { env: { CODEX_HOME: codexHome } });
    expect(sessions.map((s) => s.id)).toEqual(['codex-session-3']);
  });

  it("dossier CODEX_HOME absent → aucune session", async () => {
    await expect(
      listCodexSessions(CWD, { env: { CODEX_HOME: path.join(tmp, 'absent') } }),
    ).resolves.toEqual([]);
  });

  it("l'adaptateur expose listSessions/readSession", async () => {
    const adapter = new CodexAdapter({ command: 'codex' });
    const sessions = await adapter.listSessions!(CWD);
    expect(sessions.map((s) => s.id)).toEqual(['codex-session-1', 'codex-session-2']);

    const content = await adapter.readSession!('codex-session-2', CWD);
    expect(content.title).toBe('Ancienne session');
    expect(content.cwd).toBe(CWD);
    expect(content.events.map((e) => e.event)).toEqual([
      { type: 'user_text', text: 'Ancienne session' },
      { type: 'assistant_text', text: 'Réponse ancienne', partial: false },
    ]);
  });

  it('session inconnue → erreur explicite', async () => {
    await expect(
      readCodexSession('inconnue', CWD, { env: { CODEX_HOME: codexHome } }),
    ).rejects.toThrow(/Session Codex introuvable/);
    await expect(
      readCodexSession('  ', CWD, { env: { CODEX_HOME: codexHome } }),
    ).rejects.toThrow(/vide/);
  });
});
