import { createLogger } from './log';
import { isInScope, globsOverlap } from './scopeGlob';

const log = createLogger('ScopeRegistry');

/** Portée active d'un thread. */
interface ActiveScope {
  threadId: string;
  scope: string[];
}

/**
 * Registre des scopes actifs pour le mode shared.
 * Détecte les conflits de chevauchement entre threads.
 */
export class ScopeRegistry {
  private activeScopes = new Map<string, ActiveScope>();

  /**
   * Acquiert un scope pour un thread.
   * @param threadId Identifiant du thread.
   * @param scope Liste de globs relatifs au workspace.
   * @throws ScopeConflictError si chevauchement avec un autre thread actif.
   */
  acquire(threadId: string, scope: string[]): void {
    if (this.activeScopes.has(threadId)) {
      // Déjà acquis, mettre à jour
      this.activeScopes.set(threadId, { threadId, scope: [...scope] });
      return;
    }

    // Vérifier les conflits avec les autres threads actifs
    for (const [otherId, otherScope] of this.activeScopes) {
      const conflict = this.findConflict(scope, otherScope.scope);
      if (conflict) {
        const msg = `Le scope chevauche celui du thread ${otherId} (${conflict[0]} ↔ ${conflict[1]}). Utilisez isolation: 'worktree' ou attendez la fin de ce thread (wait_thread).`;
        throw new ScopeConflictError(otherId, conflict, msg);
      }
    }

    this.activeScopes.set(threadId, { threadId, scope: [...scope] });
    log.info(`Scope acquis pour thread ${threadId} : ${scope.join(', ')}`);
  }

  /**
   * Libère le scope d'un thread.
   */
  release(threadId: string): void {
    this.activeScopes.delete(threadId);
    log.info(`Scope libéré pour thread ${threadId}`);
  }

  /**
   * Retourne le scope d'un thread actif.
   */
  scopeOf(threadId: string): string[] | undefined {
    return this.activeScopes.get(threadId)?.scope;
  }

  /**
   * Retourne l'ID du thread actif dont le scope contient ce chemin.
   */
  ownerOf(relPath: string): string | undefined {
    const normalizedPath = relPath.replace(/\\/g, '/');
    for (const [threadId, { scope }] of this.activeScopes) {
      if (isInScope(normalizedPath, scope)) {
        return threadId;
      }
    }
    return undefined;
  }

  /**
   * Vérifie si un chemin est dans un scope donné.
   */
  isInScope(relPath: string, scope: string[]): boolean {
    return isInScope(relPath, scope);
  }

  /**
   * Trouve le premier chevauchement entre deux listes de globs.
   * @returns Tuple [globA, globB] qui se chevauchent, ou undefined.
   */
  private findConflict(scopeA: string[], scopeB: string[]): [string, string] | undefined {
    for (const globA of scopeA) {
      for (const globB of scopeB) {
        if (globsOverlap(globA, globB)) {
          return [globA, globB];
        }
      }
    }
    return undefined;
  }
}

/**
 * Erreur levée quand un scope chevauche celui d'un autre thread actif.
 */
export class ScopeConflictError extends Error {
  constructor(
    public readonly conflictingThreadId: string,
    public readonly overlapping: [string, string],
    message: string,
  ) {
    super(message);
    this.name = 'ScopeConflictError';
  }
}