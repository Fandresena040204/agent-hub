import * as path from 'path';
import * as vscode from 'vscode';
import { createLogger, setLogSink } from './core/log';
import { killAllChildren } from './adapters/process';
import type { AgentAdapter } from './adapters/AgentAdapter';
import { ClaudeAdapter } from './adapters/claude';
import { OpenCodeAdapter } from './adapters/opencode';
import { CodexAdapter } from './adapters/codex';
import { AgyAdapter } from './adapters/agy';
import { Orchestrator, type OrchestratorConfig } from './core/Orchestrator';
import { ThreadStore } from './core/ThreadStore';
import { AGENT_IDS, type AgentId, type CommitPermission, type ThreadInfo } from './core/types';
import { DelegateServer } from './mcp/DelegateServer';
import { ThreadsTreeProvider } from './ui/ThreadsTreeProvider';
import { ChatView } from './ui/ChatView';
import { registerSubagentNotifications } from './ui/subagentNotifier';
import { ChangesView, registerBaseContentProvider } from './ui/ChangesView';
import { CommitStatusBar } from './ui/CommitStatusBar';
import { confirmCommit } from './ui/commitDialog';
import { runChangeAgentWizard, runDelegateWizard, runNewThreadWizard } from './ui/newThreadWizard';
import { runImportSessionWizard } from './ui/sessionImport';
import { confirmAndDeleteThread } from './ui/threadDelete';

let output: vscode.OutputChannel | undefined;
let orchestrator: Orchestrator | undefined;
let server: DelegateServer | undefined;

const log = createLogger('extension');

function settings(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('agentHub');
}

function readConfig(): OrchestratorConfig {
  const c = settings();
  const defaults: OrchestratorConfig['defaults'] = {};
  for (const id of AGENT_IDS) {
    defaults[id] = {
      model: c.get<string>(`${id}.defaultModel`) || undefined,
      effort: c.get<string>(`${id}.defaultEffort`) || undefined,
    };
  }
  return {
    maxActiveThreads: c.get<number>('delegation.maxActiveThreads', 3),
    threadTimeoutSec: c.get<number>('delegation.threadTimeoutSec', 1800),
    isolationPolicy: c.get<OrchestratorConfig['isolationPolicy']>('isolation.policy', 'agent-decides'),
    includeUncommitted: c.get<boolean>('worktree.includeUncommitted', true),
    linkPaths: c.get<string[]>('worktree.linkPaths', ['node_modules']),
    mainAgentCommit: c.get<CommitPermission>('git.mainAgentCommit', 'deny'),
    readOnlyChildren: c.get<boolean>('delegation.readOnlyChildren', true),
    defaults,
  };
}

function createAdapters(extensionPath: string): Record<AgentId, AgentAdapter> {
  const c = settings();
  const cmd = (id: AgentId) => c.get<string>(`${id}.path`) || id;
  return {
    claude: new ClaudeAdapter({ command: cmd('claude'), guardScript: path.join(extensionPath, 'dist', 'hooks', 'claudeGuard.js') }),
    codex: new CodexAdapter({ command: cmd('codex') }),
    opencode: new OpenCodeAdapter({ command: cmd('opencode') }),
    agy: new AgyAdapter({ command: cmd('agy') }),
  };
}

/** Les commandes de menu reçoivent un ThreadInfo, les autres un threadId. */
function threadIdOf(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg;
  if (arg && typeof arg === 'object' && typeof (arg as ThreadInfo).id === 'string') return (arg as ThreadInfo).id;
  return undefined;
}

/** API renvoyée par activate() (utilisée par les tests d'intégration). */
export interface AgentHubApi {
  orchestrator?: Orchestrator;
}

export async function activate(context: vscode.ExtensionContext): Promise<AgentHubApi> {
  output = vscode.window.createOutputChannel('Agent Hub');
  setLogSink((line) => output?.appendLine(line));
  context.subscriptions.push(output, vscode.commands.registerCommand('agentHub.showLog', () => output?.show()));
  log.info('Agent Hub activé');

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    context.subscriptions.push(
      vscode.commands.registerCommand('agentHub.newMainThread', () =>
        vscode.window.showErrorMessage('Agent Hub : ouvrez un dossier de travail pour lancer un agent.'),
      ),
    );
    return {};
  }

  // Stockage par workspace : threads, événements, worktrees.
  const storageDir = context.storageUri?.fsPath ?? path.join(context.globalStorageUri.fsPath, 'default');
  const orch = new Orchestrator({
    workspaceRoot: folder.uri.fsPath,
    storageDir,
    adapters: createAdapters(context.extensionPath),
    store: new ThreadStore(path.join(storageDir, 'threads')),
    config: readConfig,
  });
  orchestrator = orch;
  await orch.init();
  if (!orch.isGitRepo) {
    log.warn("Le workspace n'est pas un dépôt git : isolation shared forcée, outil commit désactivé.");
  }

  server = new DelegateServer(orch, {
    confirmCommit,
    allowedModels: () => settings().get<string[]>('delegation.allowedModels', []),
    allowedAgents: () => settings().get<AgentId[]>('delegation.allowedAgents', []),
    log: createLogger('mcp'),
  });
  try {
    await server.start();
    const s = server;
    orch.setMcp({ url: () => s.url, registerMainThread: (id) => s.registerMainThread(id), unregister: (id) => s.unregister(id) });
    log.info(`serveur MCP de délégation : ${server.url}`);
  } catch (err) {
    log.error(`serveur MCP indisponible : ${err instanceof Error ? err.message : String(err)}`);
    void vscode.window.showWarningMessage("Agent Hub : le serveur MCP de délégation n'a pas démarré (voir le journal).");
  }

  // UI
  const tree = new ThreadsTreeProvider(orch);
  const changes = new ChangesView(orch);
  // Conversation dans la barre latérale secondaire, au même endroit que le Chat de VS Code.
  const chatView = new ChatView(context, orch);
  new CommitStatusBar(orch).register(context);
  context.subscriptions.push(
    chatView,
    vscode.window.registerWebviewViewProvider(ChatView.viewId, chatView, { webviewOptions: { retainContextWhenHidden: true } }),
    registerSubagentNotifications(context, orch, chatView),
    vscode.window.registerTreeDataProvider('agentHub.threads', tree),
    vscode.window.registerTreeDataProvider('agentHub.changes', changes),
    registerBaseContentProvider(context, orch),
    changes,
  );

  // Détection a posteriori des écritures (scope_violation en mode shared).
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'));
  const onFs = (uri: vscode.Uri) => {
    if (!uri.fsPath.split(/[\\/]/).includes('.git')) orch.notifyFsChange(uri.fsPath);
  };
  watcher.onDidChange(onFs);
  watcher.onDidCreate(onFs);
  watcher.onDidDelete(onFs);
  context.subscriptions.push(watcher);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      void vscode.window.showErrorMessage(`Agent Hub : ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('agentHub.delegateManual', (arg: unknown) =>
      run(async () => {
        const parent = orch.getThread(threadIdOf(arg) ?? '');
        if (!parent || parent.parentId) throw new Error('Choisissez un thread principal pour déléguer.');
        const req = await runDelegateWizard(orch, parent, readConfig().isolationPolicy);
        if (!req) return;
        const child = await orch.delegate(parent.id, req);
        vscode.commands.executeCommand('agentHub.openThread', child.id);
      }),
    ),
    vscode.commands.registerCommand('agentHub.changeAgent', (arg: unknown) =>
      run(async () => {
        const thread = orch.getThread(threadIdOf(arg) ?? '');
        if (!thread) return;
        const req = await runChangeAgentWizard(orch, thread);
        if (!req) return;
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Agent Hub : changement d'agent (${req.agent})…` },
          () => orch.changeAgent(thread.id, req),
        );
      }),
    ),
    vscode.commands.registerCommand('agentHub.importSession', () =>
      run(async () => {
        const thread = await runImportSessionWizard(orch);
        if (!thread) return;
        chatView.showThread(thread.id);
        changes.setThread(thread.id);
      }),
    ),
    vscode.commands.registerCommand('agentHub.deleteThread', (arg: unknown) =>
      run(async () => {
        const id = threadIdOf(arg);
        if (id) await confirmAndDeleteThread(orch, id);
      }),
    ),
    vscode.commands.registerCommand('agentHub.newMainThread', () =>
      run(async () => {
        const req = await runNewThreadWizard(orch);
        if (!req) return;
        const thread = await orch.startMainThread(req);
        chatView.showThread(thread.id);
        changes.setThread(thread.id);
      }),
    ),
    vscode.commands.registerCommand('agentHub.openThread', (arg: unknown) => {
      const id = threadIdOf(arg);
      if (!id) return;
      chatView.showThread(id);
      changes.setThread(id);
    }),
    vscode.commands.registerCommand('agentHub.focusChat', () => vscode.commands.executeCommand('agentHub.chat.focus')),
    vscode.commands.registerCommand('agentHub.interruptThread', (arg: unknown) =>
      run(async () => {
        const id = threadIdOf(arg);
        if (id) await orch.interrupt(id);
      }),
    ),
    vscode.commands.registerCommand('agentHub.showThreadDiff', (arg: unknown) => {
      const id = threadIdOf(arg);
      if (!id) return;
      changes.setThread(id);
      void vscode.commands.executeCommand('agentHub.changes.focus');
    }),
    vscode.commands.registerCommand('agentHub.applyWorktree', (arg: unknown) =>
      run(async () => {
        const id = threadIdOf(arg);
        if (!id) return;
        const result = await orch.mergeThread(id);
        if (result.status === 'conflict') {
          void vscode.window.showWarningMessage(
            `Agent Hub : conflits lors de l'application (${result.conflicted.join(', ') || result.detail}). Résolvez-les dans l'éditeur de fusion ; rien n'a été commité.`,
          );
          for (const rel of result.conflicted) {
            await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(orch.workspaceRoot, rel)));
          }
        } else if (result.status === 'empty') {
          void vscode.window.showInformationMessage('Agent Hub : aucune modification à appliquer.');
        } else {
          void vscode.window.showInformationMessage(`Agent Hub : ${result.files.length} fichier(s) appliqué(s) au workspace, non commités.`);
        }
        changes.refresh();
      }),
    ),
    vscode.commands.registerCommand('agentHub.removeWorktree', (arg: unknown) =>
      run(async () => {
        const id = threadIdOf(arg);
        if (!id) return;
        const thread = orch.getThread(id);
        if (thread && thread.status !== 'applied') {
          const ok = await vscode.window.showWarningMessage(
            "Ce worktree n'a pas été appliqué : ses modifications seront perdues.",
            { modal: true },
            'Supprimer',
          );
          if (ok !== 'Supprimer') return;
        }
        await orch.removeWorktree(id);
      }),
    ),
  );
  return { orchestrator: orch };
}

export async function deactivate(): Promise<void> {
  await orchestrator?.dispose();
  await server?.stop().catch(() => undefined);
  await killAllChildren();
}
