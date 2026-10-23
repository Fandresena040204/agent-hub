import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ThreadStore } from '../src/core/ThreadStore';
import type { ThreadInfo } from '../src/core/types';
import type { StoredEvent, RawLine } from '../src/core/events';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'threadstore-test-'));
}

function removeDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('ThreadStore', () => {
  let baseDir: string;
  let store: ThreadStore;

  beforeEach(() => {
    baseDir = createTempDir();
    store = new ThreadStore(baseDir);
  });

  afterEach(() => {
    removeDir(baseDir);
  });

  const sampleThread: ThreadInfo = {
    id: 'thread-1',
    agent: 'claude',
    permissionMode: 'edit',
    isolation: 'shared',
    cwd: '/workspace',
    title: 'Test Thread',
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    changedFiles: ['src/a.ts'],
    violations: { scope: [], commits: [] },
  };

  const sampleEvent: StoredEvent = {
    ts: Date.now(),
    event: { type: 'assistant_text', text: 'Hello', partial: false },
  };

  const sampleRaw: RawLine = {
    ts: Date.now(),
    stream: 'stdout',
    line: 'raw output line',
  };

  it('saveThread et loadThreads', () => {
    store.saveThread(sampleThread);
    const threads = store.loadThreads();
    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe('thread-1');
    expect(threads[0].title).toBe('Test Thread');
  });

  it('loadThreads ignore fichiers corrompus', () => {
    store.saveThread(sampleThread);
    // Corrompre un fichier
    const corruptFile = path.join(baseDir, 'threads', 'corrupt.json');
    fs.writeFileSync(corruptFile, '{ invalid json');
    const threads = store.loadThreads();
    expect(threads).toHaveLength(1);
  });

  it('appendEvent et loadEvents', () => {
    store.appendEvent('thread-1', sampleEvent);
    store.appendEvent('thread-1', { ...sampleEvent, ts: Date.now() + 1, event: { type: 'user_text', text: 'Hi' } });
    const events = store.loadEvents('thread-1');
    expect(events).toHaveLength(2);
    expect(events[0].event.type).toBe('assistant_text');
    expect(events[1].event.type).toBe('user_text');
  });

  it('loadEvents avec lastN', () => {
    store.appendEvent('thread-1', sampleEvent);
    store.appendEvent('thread-1', { ...sampleEvent, ts: Date.now() + 1 });
    store.appendEvent('thread-1', { ...sampleEvent, ts: Date.now() + 2 });
    const events = store.loadEvents('thread-1', 2);
    expect(events).toHaveLength(2);
  });

  it('loadEvents ignore lignes corrompues', () => {
    store.appendEvent('thread-1', sampleEvent);
    // Corrompre le fichier directement
    const eventsFile = path.join(baseDir, 'events', 'thread-1.jsonl');
    fs.appendFileSync(eventsFile, 'not json\n');
    store.appendEvent('thread-1', { ...sampleEvent, ts: Date.now() + 1 });
    const events = store.loadEvents('thread-1');
    expect(events).toHaveLength(2);
  });

  it('appendRaw et lecture', () => {
    store.appendRaw('thread-1', sampleRaw);
    store.appendRaw('thread-1', { ...sampleRaw, ts: Date.now() + 1, line: 'another line' });
    // Pas de méthode de lecture pour raw, mais on vérifie que le fichier existe
    const rawFile = path.join(baseDir, 'raw', 'thread-1.jsonl');
    expect(fs.existsSync(rawFile)).toBe(true);
    const content = fs.readFileSync(rawFile, 'utf8');
    expect(content).toContain('raw output line');
    expect(content).toContain('another line');
  });

  it('deleteThread supprime tous les fichiers', () => {
    store.saveThread(sampleThread);
    store.appendEvent('thread-1', sampleEvent);
    store.appendRaw('thread-1', sampleRaw);
    store.deleteThread('thread-1');
    expect(fs.existsSync(path.join(baseDir, 'threads', 'thread-1.json'))).toBe(false);
    expect(fs.existsSync(path.join(baseDir, 'events', 'thread-1.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(baseDir, 'raw', 'thread-1.jsonl'))).toBe(false);
  });

  it('loadThreads sur dossier vide', () => {
    const threads = store.loadThreads();
    expect(threads).toEqual([]);
  });

  it('loadEvents sur thread inexistant', () => {
    const events = store.loadEvents('nonexistent');
    expect(events).toEqual([]);
  });
});