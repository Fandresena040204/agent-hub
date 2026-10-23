// Matching de globs relatifs (portée d'écriture). Gère **, * et ?.

/** Normalise un chemin relatif : séparateurs `/`, sans `./` ni `/` final. */
export function normalizeRel(p: string): string {
  let s = p.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (s.startsWith('./')) s = s.slice(2);
  s = s.replace(/\/+$/, '');
  return s;
}

function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convertit un glob relatif en RegExp ancrée.
 * `**` traverse les dossiers, `*` s'arrête aux `/`, `?` = un caractère hors `/`.
 * Un glob sans joker (`src/foo`) couvre aussi son contenu (`src/foo/**`).
 */
export function globToRegExp(glob: string): RegExp {
  const g = normalizeRel(glob);
  if (!/[*?]/.test(g)) {
    return new RegExp(`^${escapeRe(g)}(?:/.*)?$`);
  }
  let out = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          i++;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += escapeRe(c);
    }
  }
  return new RegExp(`^${out}$`);
}

/** Vrai si `relPath` correspond à au moins un glob. Insensible à la casse sous Windows. */
export function matchesAny(relPath: string, globs: readonly string[]): boolean {
  const rel = normalizeRel(relPath);
  const ci = process.platform === 'win32';
  const candidate = ci ? rel.toLowerCase() : rel;
  return globs.some((g) => globToRegExp(ci ? normalizeRel(g).toLowerCase() : g).test(candidate));
}
