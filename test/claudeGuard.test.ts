import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { decide, type GuardEnv, type GuardInput } from '../src/hooks/claudeGuard';

const cwd = path.resolve('/tmp/agenthub-guard');

function input(tool: string, toolInput: Record<string, unknown>): GuardInput {
  return { tool_name: tool, tool_input: toolInput, cwd };
}

const scopeEnv: GuardEnv = { AGENT_HUB_ALLOWED_PATHS: JSON.stringify(['src/**', 'docs']) };
const gitEnv: GuardEnv = { AGENT_HUB_FORBIDDEN_GIT: JSON.stringify(['commit', 'push']) };

describe('claudeGuard — écritures', () => {
  it('sans variable de portée, aucune restriction', () => {
    expect(decide(input('Write', { file_path: path.join(cwd, 'ailleurs.ts') }), {}).allow).toBe(true);
  });

  it('accepte un chemin relatif dans le périmètre', () => {
    expect(decide(input('Write', { file_path: 'src/a.ts' }), scopeEnv).allow).toBe(true);
    expect(decide(input('Edit', { file_path: 'docs/adapters/x.md' }), scopeEnv).allow).toBe(true);
  });

  it('accepte un chemin absolu dans le périmètre', () => {
    expect(decide(input('Write', { file_path: path.join(cwd, 'src', 'a.ts') }), scopeEnv).allow).toBe(true);
  });

  it('refuse une écriture hors périmètre avec une raison', () => {
    const d = decide(input('Write', { file_path: 'package.json' }), scopeEnv);
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('hors périmètre');
  });

  it('refuse un chemin qui sort du workspace', () => {
    const d = decide(input('Write', { file_path: '../secret.ts' }), scopeEnv);
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('workspace');
  });

  it('refuse NotebookEdit via notebook_path', () => {
    expect(decide(input('NotebookEdit', { notebook_path: 'src/n.ipynb' }), scopeEnv).allow).toBe(true);
    expect(decide(input('NotebookEdit', { notebook_path: 'hors/n.ipynb' }), scopeEnv).allow).toBe(false);
  });

  it('une liste JSON invalide refuse les écritures', () => {
    expect(decide(input('Write', { file_path: 'src/a.ts' }), { AGENT_HUB_ALLOWED_PATHS: '{oops' }).allow).toBe(false);
  });

  it('ne touche pas aux outils de lecture', () => {
    expect(decide(input('Read', { file_path: 'etc/passwd' }), scopeEnv).allow).toBe(true);
  });
});

describe('claudeGuard — git', () => {
  it('refuse git commit simple', () => {
    const d = decide(input('Bash', { command: 'git commit -m "x"' }), gitEnv);
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('git commit');
  });

  it('refuse avec -C et -c', () => {
    expect(decide(input('Bash', { command: 'git -C sub commit -m x' }), gitEnv).allow).toBe(false);
    expect(decide(input('Bash', { command: 'git -c user.name=x commit -m x' }), gitEnv).allow).toBe(false);
  });

  it('refuse après && ; | et dans PowerShell', () => {
    expect(decide(input('Bash', { command: 'npm test && git push origin main' }), gitEnv).allow).toBe(false);
    expect(decide(input('Bash', { command: 'cd x; git commit' }), gitEnv).allow).toBe(false);
    expect(decide(input('Bash', { command: 'git log | git commit -m x' }), gitEnv).allow).toBe(false);
    expect(decide(input('PowerShell', { command: 'git.exe push' }), gitEnv).allow).toBe(false);
  });

  it('refuse une commande substituée', () => {
    expect(decide(input('Bash', { command: 'echo $(git commit -m x)' }), gitEnv).allow).toBe(false);
  });

  it('laisse passer les commandes git en lecture', () => {
    expect(decide(input('Bash', { command: 'git status --short' }), gitEnv).allow).toBe(true);
    expect(decide(input('Bash', { command: 'git log --grep=add' }), gitEnv).allow).toBe(true);
    expect(decide(input('Bash', { command: 'npm test' }), gitEnv).allow).toBe(true);
  });

  it('sans liste de git interdits, tout passe', () => {
    expect(decide(input('Bash', { command: 'git commit -m x' }), {}).allow).toBe(true);
  });
});
