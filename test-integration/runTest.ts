// Lance le VS Code installé avec l'extension en développement et exécute suite.ts dans l'Extension Host.
// Usage : npm run test:vscode  (variable VSCODE_PATH pour un autre Code.exe)
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '..');
  const vscodeExecutablePath =
    process.env.VSCODE_PATH ?? path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe');

  // Workspace jetable : dépôt git avec un commit initial.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-vscode-'));
  const ws = path.join(work, 'ws');
  fs.mkdirSync(ws);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: ws, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@agenthub.local');
  git('config', 'user.name', 'agent-hub-test');
  fs.writeFileSync(path.join(ws, 'README.md'), '# workspace de test\n');
  fs.writeFileSync(path.join(ws, 'notes.txt'), 'ligne 1\nligne 2\nligne 3\n');
  git('add', '.');
  git('commit', '-qm', 'init');

  const shots = process.env.AGENT_HUB_SHOTS ?? path.join(work, 'shots');
  fs.mkdirSync(shots, { recursive: true });

  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'out-integration', 'suite.js'),
    launchArgs: [ws, '--disable-extensions', '--user-data-dir', path.join(work, 'user-data'), '--skip-welcome', '--skip-release-notes'],
    extensionTestsEnv: {
      AGENT_HUB_SHOTS: shots,
      AGENT_HUB_SHOT_SCRIPT: path.join(root, 'test-integration', 'screenshot.ps1'),
      AGENT_HUB_TEST_WS: ws,
    },
  });
  console.log(`captures : ${shots}`);
}

main().catch((err) => {
  console.error('Échec des tests VS Code :', err);
  process.exit(1);
});
