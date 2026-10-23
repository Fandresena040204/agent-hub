import { describe, it, expect } from 'vitest';
import { AsyncQueue, parseJsonLine, runCli, resolveCommand } from '../src/adapters/process';

describe('process helpers', () => {
  it('AsyncQueue délivre puis se ferme', async () => {
    const q = new AsyncQueue<number>();
    q.push(1); q.push(2); q.close();
    const got: number[] = [];
    for await (const v of q) got.push(v);
    expect(got).toEqual([1, 2]);
  });

  it('parseJsonLine ignore une ligne invalide sans planter', () => {
    const logs: string[] = [];
    expect(parseJsonLine('{oops', (m) => logs.push(m))).toBeUndefined();
    expect(logs).toHaveLength(1);
    expect(parseJsonLine('{"a":1}')).toEqual({ a: 1 });
  });

  it('runCli passe un argument multi-lignes intact', async () => {
    const r = await runCli(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv[1]))', 'ligne 1\nligne "2" & %PATH%']);
    expect(JSON.parse(r.stdout)).toBe('ligne 1\nligne "2" & %PATH%');
  });

  it('runCli sur une commande absente renvoie une erreur sans planter', async () => {
    const r = await runCli('agent-hub-cli-inexistant', ['--help']);
    expect(r.code).not.toBe(0);
  });

  it('resolveCommand résout un nom', () => {
    expect(resolveCommand('node').file).toBeTruthy();
  });
});
