// Helpers communs aux lecteurs de sessions natives (JSONL, chemins, contenus).

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { asRecord, asString } from '../base';

/** Lit un fichier JSONL en streaming, une ligne à la fois. */
export async function streamJsonLines(filePath: string, onLine: (line: string) => void): Promise<void> {
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) onLine(line);
  } finally {
    rl.close();
    input.destroy();
  }
}

/** Première ligne d'un fichier (métadonnées Codex), sans lire le reste. */
export async function readFirstLine(filePath: string): Promise<string> {
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) return line;
    return '';
  } finally {
    rl.close();
    input.destroy();
  }
}

/** mtime en ms ; 0 si le fichier est illisible. */
export async function fileMtimeMs(filePath: string): Promise<number> {
  try {
    return (await fs.promises.stat(filePath)).mtimeMs;
  } catch {
    return 0;
  }
}

/** Chemin normalisé pour comparer deux dossiers (insensible à la casse sous Windows). */
export function normalizeCwd(p: string): string {
  const resolved = path.resolve(p);
  const trimmed = resolved.length > 1 ? resolved.replace(/[\\/]+$/, '') : resolved;
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

export function sameCwd(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return normalizeCwd(a) === normalizeCwd(b);
}

/** Concatène le texte d'une valeur (chaîne, blocs `{text}` ou `{content}`). */
export function flattenText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      parts.push(item);
      continue;
    }
    const rec = asRecord(item);
    const text = asString(rec?.text) ?? asString(rec?.content);
    if (text !== undefined) parts.push(text);
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

/** Titre de repli : une seule ligne, tronquée à `max` caractères. */
export function oneLineTitle(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) : flat;
}

/** Timestamp ISO ou numérique (ms) → ms. */
export function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

/** Extrait lisible d'une erreur CLI (première ligne, tronquée). */
export function errorExcerpt(stdout: string, stderr: string): string {
  const line = (stderr.trim() || stdout.trim()).split(/\r?\n/)[0] ?? '';
  return line ? ` : ${line.slice(0, 300)}` : '';
}
