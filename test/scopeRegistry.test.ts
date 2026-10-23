import { describe, it, expect, beforeEach } from 'vitest';
import { ScopeRegistry, ScopeConflictError } from '../src/core/ScopeRegistry';

describe('ScopeRegistry', () => {
  let registry: ScopeRegistry;

  beforeEach(() => {
    registry = new ScopeRegistry();
  });

  describe('acquire / release / scopeOf', () => {
    it('acquire et scopeOf', () => {
      registry.acquire('thread-1', ['src/**']);
      expect(registry.scopeOf('thread-1')).toEqual(['src/**']);
    });

    it('release libère le scope', () => {
      registry.acquire('thread-1', ['src/**']);
      registry.release('thread-1');
      expect(registry.scopeOf('thread-1')).toBeUndefined();
    });

    it('acquire met à jour le scope existant', () => {
      registry.acquire('thread-1', ['src/**']);
      registry.acquire('thread-1', ['src/**', 'tests/**']);
      expect(registry.scopeOf('thread-1')).toEqual(['src/**', 'tests/**']);
    });
  });

  describe('isInScope', () => {
    it('chemin dans scope', () => {
      expect(registry.isInScope('src/a.ts', ['src/**'])).toBe(true);
      expect(registry.isInScope('src/sub/b.ts', ['src/**'])).toBe(true);
    });

    it('chemin hors scope', () => {
      expect(registry.isInScope('other/a.ts', ['src/**'])).toBe(false);
    });

    it('scope sans glob = dossier', () => {
      expect(registry.isInScope('src/a.ts', ['src'])).toBe(true);
      expect(registry.isInScope('src/sub/b.ts', ['src'])).toBe(true);
      expect(registry.isInScope('src.ts', ['src'])).toBe(false);
    });
  });

  describe('ownerOf', () => {
    it('retourne le thread propriétaire', () => {
      registry.acquire('thread-1', ['src/**']);
      registry.acquire('thread-2', ['tests/**']);
      expect(registry.ownerOf('src/a.ts')).toBe('thread-1');
      expect(registry.ownerOf('tests/b.ts')).toBe('thread-2');
      expect(registry.ownerOf('other/c.ts')).toBeUndefined();
    });
  });

  describe('conflits de chevauchement', () => {
    it('src/a/** vs src/a/b.ts → conflit', () => {
      registry.acquire('thread-1', ['src/a/**']);
      expect(() => registry.acquire('thread-2', ['src/a/b.ts'])).toThrow(ScopeConflictError);
    });

    it('src/a/** vs src/b/** → ok (pas de conflit)', () => {
      registry.acquire('thread-1', ['src/a/**']);
      registry.acquire('thread-2', ['src/b/**']); // Ne doit pas lever
      expect(registry.scopeOf('thread-2')).toEqual(['src/b/**']);
    });

    it('src/a vs src/a/x.ts → conflit', () => {
      registry.acquire('thread-1', ['src/a']);
      expect(() => registry.acquire('thread-2', ['src/a/x.ts'])).toThrow(ScopeConflictError);
    });

    it('release libère pour permettre nouvel acquire', () => {
      registry.acquire('thread-1', ['src/**']);
      registry.release('thread-1');
      registry.acquire('thread-2', ['src/**']); // Ne doit pas lever
      expect(registry.scopeOf('thread-2')).toEqual(['src/**']);
    });

    it('ScopeConflictError contient les bonnes propriétés', () => {
      registry.acquire('thread-1', ['src/**']);
      try {
        registry.acquire('thread-2', ['src/a.ts']);
      } catch (e) {
        expect(e).toBeInstanceOf(ScopeConflictError);
        expect((e as ScopeConflictError).conflictingThreadId).toBe('thread-1');
        // L'ordre peut varier selon l'implémentation
        const overlap = (e as ScopeConflictError).overlapping;
        expect(overlap).toContain('src/**');
        expect(overlap).toContain('src/a.ts');
        expect((e as ScopeConflictError).message).toContain('thread-1');
      }
    });
  });

  describe('cas limites', () => {
    it('globs identiques → conflit', () => {
      registry.acquire('thread-1', ['src/**']);
      expect(() => registry.acquire('thread-2', ['src/**'])).toThrow(ScopeConflictError);
    });

    it('un glob contenant l\'autre → conflit', () => {
      registry.acquire('thread-1', ['**/*.ts']);
      expect(() => registry.acquire('thread-2', ['src/a.ts'])).toThrow(ScopeConflictError);
    });

    it('scope vide → pas de conflit', () => {
      registry.acquire('thread-1', []);
      registry.acquire('thread-2', ['src/**']);
      expect(registry.scopeOf('thread-2')).toEqual(['src/**']);
    });
  });
});