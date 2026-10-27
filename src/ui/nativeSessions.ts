// Logique pure des sessions natives à importer (aucun import vscode) : dates, libellés, erreurs.
import { truncate } from './presentation';

// ---------------------------------------------------------------- date relative

/**
 * Date relative française : « il y a 5 min / 3 h / 2 j » ; « il y a 1 min » sous la minute.
 * `ts` absent ou non fini → '' ; horloge en avance → borné à 0.
 */
export function relativeDate(ts: number | undefined, now: number): string {
  if (ts === undefined || !Number.isFinite(ts)) return '';
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return 'il y a 1 min';
  const m = Math.floor(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.floor(h / 24)} j`;
}

// ---------------------------------------------------------------- libellés de session

/** Textes d'un item QuickPick de session native (title + description + detail). */
export interface NativeSessionItemText {
  label: string;
  description?: string;
  detail?: string;
}

/** Session native : titre court (pour la desc « id court »). */
function shortId(id: string): string {
  return truncate(id, 12);
}

/**
 * Libellés d'une session native :
 * - label = titre (ou « (sans titre) ») ;
 * - description = date relative · modèle (champs absents omis) ;
 * - detail = `N messages · <id court>` (+ « déjà dans Agent Hub » si le thread existe déjà).
 */
export function nativeSessionItem(
  sess: { id: string; title: string; updatedAt: number; model?: string; messageCount?: number },
  importedThreadId?: string,
  now = Date.now(),
): NativeSessionItemText {
  const label = sess.title?.trim() || '(sans titre)';
  const description = [relativeDate(sess.updatedAt, now), sess.model]
    .filter((v) => typeof v === 'string' && v !== '')
    .join(' · ');
  const detailParts: string[] = [];
  if (sess.messageCount && sess.messageCount > 0) {
    detailParts.push(`${sess.messageCount} message${sess.messageCount > 1 ? 's' : ''}`);
  }
  detailParts.push(shortId(sess.id));
  if (importedThreadId) detailParts.push('déjà dans Agent Hub');
  return { label, description: description || undefined, detail: detailParts.join(' · ') || undefined };
}

// ---------------------------------------------------------------- erreurs de support

/** Vrai si l'erreur dit que l'agent ne sait pas lister/lire ses sessions natives. */
export function isUnsupportedError(message: string): boolean {
  return /pas (encore )?pris en charge/.test(message);
}
