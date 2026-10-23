import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from './log';
import type { ThreadInfo } from './types';
import type { StoredEvent, RawLine } from './events';

const log = createLogger('ThreadStore');

/** Chemin relatif du fichier threads dans le dossier de base. */
const THREADS_DIR = 'threads';
/** Chemin relatif du fichier events dans le dossier de base. */
const EVENTS_DIR = 'events';
/** Chemin relatif du fichier raw dans le dossier de base. */
const RAW_DIR = 'raw';

/**
 * Persistance des threads et événements dans un dossier de base.
 * Écritures append synchrones pour simplicité et robustesse.
 */
export class ThreadStore {
  private readonly threadsDir: string;
  private readonly eventsDir: string;
  private readonly rawDir: string;

  /**
   * @param baseDir Dossier de base (ex: globalStorage de l'extension).
   */
  constructor(baseDir: string) {
    this.threadsDir = path.join(baseDir, THREADS_DIR);
    this.eventsDir = path.join(baseDir, EVENTS_DIR);
    this.rawDir = path.join(baseDir, RAW_DIR);
    this.ensureDirs();
  }

  private ensureDirs(): void {
    for (const dir of [this.threadsDir, this.eventsDir, this.rawDir]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  /** Chemin du fichier thread. */
  private threadFile(id: string): string {
    return path.join(this.threadsDir, `${id}.json`);
  }

  /** Chemin du fichier events. */
  private eventsFile(id: string): string {
    return path.join(this.eventsDir, `${id}.jsonl`);
  }

  /** Chemin du fichier raw. */
  private rawFile(id: string): string {
    return path.join(this.rawDir, `${id}.jsonl`);
  }

  /**
   * Sauvegarde un thread (écrase le fichier existant).
   */
  saveThread(info: ThreadInfo): void {
    const file = this.threadFile(info.id);
    const tmp = file + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(info, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch {}
      log.error(`Échec sauvegarde thread ${info.id} : ${err}`);
      throw err;
    }
  }

  /**
   * Charge tous les threads.
   * Ignore les fichiers corrompus.
   */
  loadThreads(): ThreadInfo[] {
    const threads: ThreadInfo[] = [];
    if (!fs.existsSync(this.threadsDir)) return threads;

    for (const file of fs.readdirSync(this.threadsDir)) {
      if (!file.endsWith('.json')) continue;
      const full = path.join(this.threadsDir, file);
      try {
        const content = fs.readFileSync(full, 'utf8');
        const info = JSON.parse(content) as ThreadInfo;
        threads.push(info);
      } catch (err) {
        log.warn(`Fichier thread corrompu ignoré : ${file} (${err})`);
      }
    }
    return threads;
  }

  /**
   * Ajoute un événement au fichier JSONL du thread.
   * Écriture append synchrone.
   */
  appendEvent(threadId: string, event: StoredEvent): void {
    const file = this.eventsFile(threadId);
    const line = JSON.stringify(event) + '\n';
    try {
      fs.appendFileSync(file, line, 'utf8');
    } catch (err) {
      log.error(`Échec append event thread ${threadId} : ${err}`);
      throw err;
    }
  }

  /**
   * Charge les événements d'un thread.
   * @param lastN Si défini, ne renvoie que les N derniers événements.
   */
  loadEvents(threadId: string, lastN?: number): StoredEvent[] {
    const file = this.eventsFile(threadId);
    if (!fs.existsSync(file)) return [];

    const events: StoredEvent[] = [];
    try {
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.trim().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as StoredEvent;
          events.push(event);
        } catch {
          // Ligne corrompue ignorée
        }
      }
    } catch (err) {
      log.warn(`Échec lecture events thread ${threadId} : ${err}`);
      return [];
    }

    if (lastN && lastN > 0 && events.length > lastN) {
      return events.slice(-lastN);
    }
    return events;
  }

  /**
   * Ajoute une ligne brute au fichier JSONL du thread.
   * Écriture append synchrone.
   */
  appendRaw(threadId: string, raw: RawLine): void {
    const file = this.rawFile(threadId);
    const line = JSON.stringify(raw) + '\n';
    try {
      fs.appendFileSync(file, line, 'utf8');
    } catch (err) {
      log.error(`Échec append raw thread ${threadId} : ${err}`);
      throw err;
    }
  }

  /**
   * Supprime tous les fichiers d'un thread.
   */
  deleteThread(threadId: string): void {
    for (const file of [this.threadFile(threadId), this.eventsFile(threadId), this.rawFile(threadId)]) {
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch (err) {
        log.warn(`Échec suppression ${file} : ${err}`);
      }
    }
  }
}