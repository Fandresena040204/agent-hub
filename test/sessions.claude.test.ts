import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { ClaudeAdapter } from '../src/adapters/claude';
import {
  encodeClaudeProjectDir,
  isTechnicalUserText,
  listClaudeSessions,
  parseClaudeSessionLines,
  readClaudeSession,
} from '../src/adapters/sessions/claudeSessions';

const ROOT = process.cwd();
const FIXTURES = path.join(ROOT, 'src', 'adapters', '__mocks__', 'fixtures');
const SESSIONS = path.join(FIXTURES, 'sessions');
const CONFIG_DIR = path.join(SESSIONS, 'claude');
const CWD = 'C:\\Users\\test\\session-demo';
const ID_RECENT = '650fc40f-0000-4000-8000-000000000001';
const ID_OLD = '650fc40f-0000-4000-8000-000000000002';
const LONG_PROMPT = 'Merci de vérifier le comportement du lecteur de sessions natives dans tous les cas limites';

let savedConfigDir: string | undefined;

beforeEach(() => {
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = CONFIG_DIR;
});

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
});

function readFixture(id: string): string {
  return fs.readFileSync(
    path.join(CONFIG_DIR, 'projects', encodeClaudeProjectDir(CWD), `${id}.jsonl`),
    'utf8',
  );
}

describe('sessions Claude — encodage et chemins', () => {
  it('encode chaque caractère non alphanumérique du cwd en tiret', () => {
    expect(encodeClaudeProjectDir('D:\\perso\\VSCode')).toBe('D--perso-VSCode');
    expect(encodeClaudeProjectDir('C:\\Users\\x\\Temp\\a-b')).toBe('C--Users-x-Temp-a-b');
    expect(encodeClaudeProjectDir('/home/dev/proj')).toBe('-home-dev-proj');
  });

  it('dossier de projet absent → aucune session', async () => {
    await expect(listClaudeSessions('C:\\Users\\test\\absent', { configDir: CONFIG_DIR, env: {} })).resolves.toEqual([]);
  });
});

describe('sessions Claude — liste', () => {
  it('liste les fichiers JSONL du dossier, du plus récent au plus ancien', async () => {
    const sessions = await listClaudeSessions(CWD, { configDir: CONFIG_DIR, env: {} });
    expect(sessions.map((s) => s.id)).toEqual([ID_RECENT, ID_OLD]);
    expect(sessions[0]).toMatchObject({
      title: 'Refactor du module de test',
      createdAt: Date.parse('2026-10-27T09:00:00.000Z'),
      updatedAt: Date.parse('2026-10-27T09:00:06.000Z'),
      cwd: CWD,
      model: 'claude-test-1',
      messageCount: 2,
    });
    expect(sessions[1].title).toBe(LONG_PROMPT.slice(0, 80));
    expect(sessions[1].model).toBe('claude-test-2');
    expect(sessions[1].messageCount).toBe(2);
  });

  it('ignore les sous-dossiers (memory) et les lignes invalides', async () => {
    const sessions = await listClaudeSessions(CWD, { configDir: CONFIG_DIR, env: {} });
    expect(sessions).toHaveLength(2);
    expect(sessions.some((s) => s.id === 'notes')).toBe(false);
  });

  it("l'adaptateur expose listSessions et respecte CLAUDE_CONFIG_DIR", async () => {
    const adapter = new ClaudeAdapter({ command: 'claude' });
    const sessions = await adapter.listSessions!(CWD);
    expect(sessions.map((s) => s.id)).toEqual([ID_RECENT, ID_OLD]);
  });
});

describe('sessions Claude — conversion des événements', () => {
  it('convertit user/assistant, ignore thinking, sidechain et lignes techniques', async () => {
    const content = await readClaudeSession(ID_RECENT, CWD, { configDir: CONFIG_DIR, env: {} });
    expect(content.title).toBe('Refactor du module de test');
    expect(content.model).toBe('claude-test-1');
    expect(content.cwd).toBe(CWD);

    expect(content.events.map((e) => e.event)).toEqual([
      { type: 'user_text', text: 'Ajoute un fichier notes.txt' },
      {
        type: 'tool_call',
        id: 'toolu_write_1',
        name: 'Write',
        input: { file_path: 'notes.txt', content: 'bonjour' },
      },
      {
        type: 'tool_result',
        id: 'toolu_write_1',
        name: 'Write',
        output: 'File created successfully: notes.txt',
        isError: false,
      },
      { type: 'file_changed', path: 'notes.txt' },
      { type: 'assistant_text', text: 'Le fichier notes.txt est créé.', partial: false },
    ]);

    const events = content.events.map((e) => e.event);
    expect(events.some((e) => e.type === 'assistant_text' && e.text.includes('sous-agent'))).toBe(false);
    expect(events.some((e) => e.type === 'user_text' && e.text.includes('Rappel interne'))).toBe(false);
    // Horodatage de la ligne porteuse (tool_call = 09:00:03, tool_result = 09:00:04).
    expect(content.events.map((e) => e.ts)).toEqual([
      Date.parse('2026-10-27T09:00:01.000Z'),
      Date.parse('2026-10-27T09:00:03.000Z'),
      Date.parse('2026-10-27T09:00:04.000Z'),
      Date.parse('2026-10-27T09:00:04.000Z'),
      Date.parse('2026-10-27T09:00:05.000Z'),
    ]);
  });

  it("l'adaptateur expose readSession", async () => {
    const adapter = new ClaudeAdapter({ command: 'claude' });
    const content = await adapter.readSession!(ID_OLD, CWD);
    expect(content.title).toBe(LONG_PROMPT.slice(0, 80));
    expect(content.events.map((e) => e.event.type)).toEqual(['user_text', 'assistant_text']);
  });

  it('titre : dernier titre explicite, sinon premier message utilisateur', () => {
    const parsed = parseClaudeSessionLines(
      [
        JSON.stringify({ type: 'ai-title', aiTitle: 'Titre IA', timestamp: '2026-01-01T00:00:00.000Z' }),
        '{oops',
        JSON.stringify({ type: 'custom-title', customTitle: 'Titre personnalisé', timestamp: '2026-01-01T00:00:01.000Z' }),
      ],
      { fallbackTs: 42 },
    );
    expect(parsed.title).toBe('Titre personnalisé');
    expect(parsed.updatedAt).toBe(Date.parse('2026-01-01T00:00:01.000Z'));
    expect(parsed.messageCount).toBe(0);

    const fallback = parseClaudeSessionLines(
      [JSON.stringify({ type: 'user', message: { role: 'user', content: '  Premier   message utile  ' } })],
      { fallbackTs: 7 },
    );
    expect(fallback.title).toBe('Premier message utile');
    expect(fallback.updatedAt).toBe(7);
  });

  it('détecte les messages utilisateur purement techniques', () => {
    expect(isTechnicalUserText('<system-reminder>rappel</system-reminder>')).toBe(true);
    expect(isTechnicalUserText('<command-name>/help</command-name>')).toBe(true);
    expect(isTechnicalUserText('<local-command-stdout>ok</local-command-stdout>')).toBe(true);
    expect(isTechnicalUserText('Explique ce fichier')).toBe(false);
  });

  it('refuse un identifiant douteux et signale une session absente', async () => {
    await expect(readClaudeSession('../evil', CWD, { configDir: CONFIG_DIR, env: {} })).rejects.toThrow(/invalide/);
    await expect(
      readClaudeSession('00000000-0000-4000-8000-000000000000', CWD, { configDir: CONFIG_DIR, env: {} }),
    ).rejects.toThrow(/introuvable/);
  });

  it('lit la fixture sans aucun chemin personnel', () => {
    // Garde-fou : les fixtures du dépôt ne contiennent aucune donnée réelle.
    const raw = readFixture(ID_RECENT) + readFixture(ID_OLD);
    expect(raw).not.toContain('fandr');
  });
});
