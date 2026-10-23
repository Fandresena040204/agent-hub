import { createLogger } from './log';

createLogger('scopeGlob');

/** Résultat de la normalisation d'un glob. */
export interface NormalizedGlob {
  /** Glob original. */
  original: string;
  /** Glob normalisé (séparateurs /, sans ./ initial). */
  normalized: string;
  /** Préfixe statique : segments avant le premier caractère glob (* ? [ {). */
  staticPrefix: string[];
  /** True si le glob contient des caractères glob. */
  hasGlob: boolean;
  /** True si le glob contient **. */
  hasDoubleStar: boolean;
}

/**
 * Normalise un glob : séparateurs /, retire ./ initial.
 */
function normalizeGlob(glob: string): string {
  let g = glob.replace(/\\/g, '/');
  if (g.startsWith('./')) g = g.slice(2);
  return g;
}

/**
 * Extrait le préfixe statique d'un glob (segments avant le premier * ? [ {).
 */
function extractStaticPrefix(glob: string): string[] {
  const normalized = normalizeGlob(glob);
  // Trouver le premier caractère glob
  const globChars = '*?[{';
  let firstGlobIdx = normalized.length;
  for (const ch of globChars) {
    const idx = normalized.indexOf(ch);
    if (idx >= 0 && idx < firstGlobIdx) firstGlobIdx = idx;
  }
  const staticPart = normalized.slice(0, firstGlobIdx);
  // Segments complets seulement (jusqu'au dernier /)
  const lastSlash = staticPart.lastIndexOf('/');
  const prefixStr = lastSlash >= 0 ? staticPart.slice(0, lastSlash + 1) : '';
  return prefixStr ? prefixStr.split('/').filter(Boolean) : [];
}

/**
 * Vérifie si un glob contient des caractères glob.
 */
function hasGlobChars(glob: string): boolean {
  return /[*?[{]/.test(glob);
}

/**
 * Vérifie si un glob contient **.
 */
function hasDoubleStar(glob: string): boolean {
  return glob.includes('**');
}

/**
 * Normalise un glob et extrait ses métadonnées.
 */
export function parseGlob(glob: string): NormalizedGlob {
  const normalized = normalizeGlob(glob);
  return {
    original: glob,
    normalized,
    staticPrefix: extractStaticPrefix(normalized),
    hasGlob: hasGlobChars(normalized),
    hasDoubleStar: hasDoubleStar(normalized),
  };
}

/**
 * Vérifie si un chemin correspond à un glob (style gitignore/.gitignore).
 * Utilise une implémentation simple basée sur minimatch mais sans dépendance.
 * Sensible à la casse sur Linux/macOS, insensible sur Windows.
 */
export function matchGlob(glob: string, relPath: string): boolean {
  const normalizedGlob = normalizeGlob(glob);
  const normalizedPath = normalizeGlob(relPath);
  const isWin = process.platform === 'win32';

  // Si le glob ne contient pas de caractères glob, c'est un chemin littéral
  // ou un dossier (équivalent à dossier/**).
  if (!hasGlobChars(normalizedGlob)) {
    if (normalizedGlob === normalizedPath) return true;
    // Dossier : vérifier si le chemin est dans ce dossier
    return normalizedPath.startsWith(normalizedGlob + '/');
  }

  // Convertir le glob en regex
  const regexStr = globToRegex(normalizedGlob);
  const flags = isWin ? 'i' : '';
  const regex = new RegExp(`^${regexStr}$`, flags);
  return regex.test(normalizedPath);
}

/**
 * Convertit un glob en pattern regex (compatible gitignore).
 */
function globToRegex(glob: string): string {
  let regex = '';
  let i = 0;
  let inCharClass = false;
  let charClassStart = 0;

  while (i < glob.length) {
    const ch = glob[i];

    if (ch === '\\' && i + 1 < glob.length) {
      // Échappement
      const next = glob[i + 1];
      if (inCharClass) {
        regex += '\\' + escapeRegex(next);
      } else {
        regex += escapeRegex(next);
      }
      i += 2;
      continue;
    }

    if (ch === '[' && !inCharClass) {
      inCharClass = true;
      charClassStart = i;
      regex += '[';
      i++;
      continue;
    }

    if (ch === ']' && inCharClass) {
      inCharClass = false;
      regex += ']';
      i++;
      continue;
    }

    if (inCharClass) {
      regex += ch === '!' ? '^' : (ch === '^' && i === charClassStart + 1 ? '\\^' : escapeRegex(ch));
      i++;
      continue;
    }

    switch (ch) {
      case '*':
        if (i + 1 < glob.length && glob[i + 1] === '*') {
          // ** : match tout y compris /
          regex += '.*';
          i += 2;
          // Si suivi de /, le consommer
          if (i < glob.length && glob[i] === '/') {
            i++;
          }
        } else {
          // * : match tout sauf /
          regex += '[^/]*';
          i++;
        }
        break;
      case '?':
        // ? : un caractère sauf /
        regex += '[^/]';
        i++;
        break;
      case '.':
      case '+':
      case '(':
      case ')':
      case '|':
      case '^':
      case '$':
      case '{':
      case '}':
        regex += '\\' + ch;
        i++;
        break;
      default:
        regex += escapeRegex(ch);
        i++;
    }
  }

  return regex;
}

/**
 * Échappe les caractères spéciaux regex.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Vérifie si deux globs se chevauchent (peuvent matcher le même fichier).
 * Règle conservatrice : dans le doute, considère qu'ils se chevauchent.
 *
 * @param globA Premier glob.
 * @param globB Deuxième glob.
 * @returns True si les globs peuvent matcher au moins un chemin commun.
 */
export function globsOverlap(globA: string, globB: string): boolean {
  const a = parseGlob(globA);
  const b = parseGlob(globB);

  // Normaliser les chemins pour la comparaison
  const pathA = a.normalized;
  const pathB = b.normalized;

  // Si l'un est un chemin littéral, vérifier s'il matche l'autre
  if (!a.hasGlob && matchGlob(b.normalized, pathA)) return true;
  if (!b.hasGlob && matchGlob(a.normalized, pathB)) return true;

  // Comparer les préfixes statiques
  const prefixA = a.staticPrefix;
  const prefixB = b.staticPrefix;

  // Trouver le préfixe commun
  let commonLen = 0;
  const minLen = Math.min(prefixA.length, prefixB.length);
  while (commonLen < minLen && segmentsEqual(prefixA[commonLen], prefixB[commonLen])) {
    commonLen++;
  }

  // Si les préfixes statiques divergent, pas de chevauchement
  if (commonLen < minLen) return false;

  // L'un des préfixes est préfixe de l'autre
  // Si aucun des deux n'a de globs après le préfixe commun, pas de chevauchement
  const prefixStr = prefixA.slice(0, commonLen).join('/');
  const aRest = a.normalized.slice(prefixStr.length + (commonLen > 0 ? 1 : 0));
  const bRest = b.normalized.slice(prefixStr.length + (commonLen > 0 ? 1 : 0));

  // Si les deux n'ont plus que des segments littéraux après le préfixe commun, pas de chevauchement
  if (!a.hasGlob && !b.hasGlob) return false;

  // Variables utilisées pour éviter l'erreur noUnusedLocals
  void aRest;
  void bRest;

  // Règle conservatrice : si l'un a ** ou les deux ont des globs, chevauchement possible
  if (a.hasDoubleStar || b.hasDoubleStar) return true;
  if (a.hasGlob && b.hasGlob) return true;

  // Un a des globs, l'autre non après le préfixe commun
  // Vérifier si le littéral peut matcher le glob
  const longer = a.hasGlob ? a : b;
  const literal = a.hasGlob ? b : a;
  const literalPath = literal.normalized;

  // Construire un chemin test à partir du littéral
  return matchGlob(longer.normalized, literalPath);
}

/**
 * Compare deux segments de chemin (insensible à la casse sur Windows).
 */
function segmentsEqual(a: string, b: string): boolean {
  if (process.platform === 'win32') {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

/**
 * Vérifie si un chemin relatif est dans un scope (liste de globs).
 */
export function isInScope(relPath: string, scope: string[]): boolean {
  const normalizedPath = normalizeGlob(relPath);
  for (const glob of scope) {
    if (matchGlob(glob, normalizedPath)) return true;
  }
  return false;
}

/**
 * Retourne les globs du scope qui matchent le chemin.
 */
export function matchingGlobs(relPath: string, scope: string[]): string[] {
  const normalizedPath = normalizeGlob(relPath);
  return scope.filter((glob) => matchGlob(glob, normalizedPath));
}