import { describe, expect, it } from 'vitest';
import { globToRegExp, matchesAny, normalizeRel } from '../src/core/glob';

describe('normalizeRel', () => {
  it('uniformise les séparateurs et retire ./ et le / final', () => {
    expect(normalizeRel('.\\src\\a\\b.ts')).toBe('src/a/b.ts');
    expect(normalizeRel('./src//b/')).toBe('src/b');
  });
});

describe('globToRegExp', () => {
  it('* ne traverse pas les dossiers', () => {
    expect(globToRegExp('src/*.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/sub/a.ts')).toBe(false);
  });

  it('** traverse les dossiers', () => {
    expect(globToRegExp('src/**').test('src/a/b.ts')).toBe(true);
    expect(globToRegExp('**/*.md').test('docs/adapters/x.md')).toBe(true);
    expect(globToRegExp('**/*.md').test('README.md')).toBe(true);
  });

  it('? matche un seul caractère hors /', () => {
    expect(globToRegExp('a?.ts').test('ab.ts')).toBe(true);
    expect(globToRegExp('a?.ts').test('a/.ts')).toBe(false);
  });

  it('un dossier simple couvre son contenu', () => {
    expect(globToRegExp('src/foo').test('src/foo')).toBe(true);
    expect(globToRegExp('src/foo').test('src/foo/a.ts')).toBe(true);
    expect(globToRegExp('src/foo').test('src/foobar/a.ts')).toBe(false);
  });
});

describe('matchesAny', () => {
  it('accepte si au moins un glob correspond', () => {
    expect(matchesAny('src/a.ts', ['docs/**', 'src/**'])).toBe(true);
    expect(matchesAny('test/a.ts', ['src/**'])).toBe(false);
  });

  it('normalise le chemin testé', () => {
    expect(matchesAny('.\\src\\a.ts', ['src/**'])).toBe(true);
  });
});
