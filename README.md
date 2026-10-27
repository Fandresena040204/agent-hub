# Agent Hub

Extension VS Code qui pilote plusieurs agents de codage — **Claude Code, Codex, OpenCode, Antigravity (`agy`)** — dans une même session. Un **agent principal** reste actif dans son thread et **délègue** des sous-tâches à d'autres agents via un serveur MCP local. Chaque thread délégué s'ouvre dans son propre panneau (conversation en direct, fichiers modifiés, diff).

Détails techniques par CLI (flags réellement vérifiés, modèles, niveaux d'effort, interdictions git, limites) : [`docs/ADAPTERS.md`](docs/ADAPTERS.md).

## Installation

Prérequis : Node 20+, git, VS Code ≥ 1.90, et au moins un des CLI installé et authentifié (`claude`, `codex`, `opencode`, `agy`).

```bash
npm install
npm run build      # dist/extension.js + dist/hooks/claudeGuard.js
npm test           # vitest (adaptateurs testés contre des faux CLI)
```

Tests d'intégration dans un vrai VS Code (Windows, utilise le `Code.exe` installé ou `VSCODE_PATH`, avec les vrais CLI `claude` et `opencode`) :

```bash
npm run test:vscode   # 7 scénarios : délégation réelle Claude → OpenCode, diff, worktree, commit ; captures de la fenêtre si AGENT_HUB_SHOTS est défini
```

Lancement : ouvrir ce dossier dans VS Code, puis **F5** (configuration « Agent Hub (Extension Development Host) »). Pour un paquet : `npx @vscode/vsce package`.

Un CLI absent n'empêche rien : il apparaît comme indisponible, avec un message clair.

## Utilisation

1. Barre d'activité → **Agent Hub** → bouton **+** (ou commande **« Agent Hub: Nouveau thread principal »**).
2. Choisir l'agent, le modèle, le niveau d'effort (proposé seulement si le CLI en a) et le mode de permission (`readonly` / `edit` / `full`), puis saisir la consigne. Les listes sont lues dynamiquement depuis chaque CLI.
3. La conversation s'affiche dans la **barre latérale secondaire**, au même endroit que le Chat de VS Code (onglet « Agent Hub ») : sélecteur de thread, appels d'outils repliables, bandeaux de relais d'agent. Au-dessus de la saisie, le bloc **« N fichiers modifiés +A −D »** liste les fichiers du thread : clic = diff, **Conserver** / **Annuler** par fichier ou pour tous, **Appliquer** pour un thread worktree. Entrée envoie un message de suivi (la session du CLI est reprise).
4. **Sous-agents façon T3 Code** : chaque délégation apparaît **dans la conversation du parent sous forme de carte vivante** (agent, modèle, effort, statut, dernière activité, durée, résumé, `N fichiers +A −D`, boutons Ouvrir / Stop / Appliquer) ; plusieurs délégations consécutives se regroupent dans une carte repliable. Une notification signale la fin d'un sous-agent. Les **threads délégués sont en lecture seule** (réglage `agentHub.delegation.readOnlyChildren`, vrai par défaut) : on écrit au thread principal, qui pilote ses sous-agents ; un fil d'Ariane « ← parent › enfant » permet de remonter.
5. Les threads enfants apparaissent aussi sous leur parent dans la vue **Threads**, avec agent, modèle, effort, isolation, statut et nombre de fichiers modifiés. Un clic ouvre leur conversation dans la vue de chat.
6. La vue **Fichiers modifiés** liste les fichiers du thread sélectionné ; un clic ouvre le diff par rapport à l'état de base propre à ce thread.
7. Threads `worktree` terminés (menu contextuel) : **Voir le diff**, **Appliquer** (applique au workspace, sans commit), **Supprimer le worktree**.

### Outils MCP exposés à l'agent principal

`list_agents`, `delegate`, `read_thread`, `message_thread`, `wait_thread`, `list_threads`, `interrupt_thread`, `merge_thread`, `commit`.

Le serveur écoute sur `127.0.0.1`, sur un port aléatoire, avec un jeton propre à chaque thread principal. Les sous-agents ne reçoivent aucun jeton : ils ne peuvent ni déléguer (profondeur maximale = 1) ni commiter.

### Isolation des sous-agents

- **`shared`** : le sous-agent travaille directement dans le workspace, sur les fichiers de son `scope` (globs, obligatoire en mode `edit`). Deux scopes qui se chevauchent sont refusés. Une écriture hors scope déclenche un `scope_violation` visible dans l'UI et remonté à l'agent principal.
- **`worktree`** : copie isolée créée par `git worktree add --detach` (ni branche, ni commit). Plusieurs sous-agents peuvent toucher les mêmes fichiers. Le travail est appliqué au workspace via « Appliquer » ou `merge_thread`, **non commité** ; un conflit est signalé, jamais forcé.
- **`readonly`** : exécution dans le workspace avec les permissions les plus restrictives du CLI.

Hors dépôt git, l'isolation `shared` est forcée et l'outil `commit` est désactivé.

## Règles git

- **Un sous-agent ne commite jamais** et ne modifie pas l'état git (`commit`, `push`, `add`, `reset`, `checkout`, `switch`, `restore`, `stash`, `rebase`, `merge`, `cherry-pick`, `branch`, `tag`, `clean`). Les commandes en lecture (`status`, `diff`, `log`, `show`) restent permises. Trois couches s'appliquent :
  1. les permissions du CLI quand elles existent (règles d'outils interdits et hook pour Claude Code, règles `permissions` pour OpenCode, sandbox pour Codex) ;
  2. une consigne explicite dans le prompt système du sous-agent ;
  3. une détection a posteriori : si `HEAD` change, un `commit_violation` est affiché et remonté à l'agent principal (rien n'est annulé automatiquement).
- **L'agent principal** ne commite que par l'outil MCP `commit`, selon la permission :
  - `deny` (par défaut) : refus explicite ;
  - `ask` : boîte de dialogue montrant les fichiers, le résumé du diff et le message ; un refus n'a aucun effet ;
  - `allow` : commit direct, événement `commit_made`.
- La barre d'état **« Commits : off / ask / on »** change la permission pour la session, sans toucher au réglage. Elle revient à la valeur du réglage à chaque nouvelle session VS Code.
- `commit` ne commite que les fichiers désignés (`threadIds` ou `paths`). Il refuse un fichier appartenant au scope d'un thread encore actif, un thread `worktree` non appliqué, une fusion en cours et des fichiers contenant des marqueurs de conflit.
- `push`, `amend`, `reset`, `rebase`, `force`, les changements de branche et les suppressions restent interdits à tous les agents, quelle que soit la politique.

## Configuration

| Réglage | Défaut | Rôle |
|---|---|---|
| `agentHub.<agent>.path` | nom du CLI | chemin du CLI (`claude`, `codex`, `opencode`, `agy`) |
| `agentHub.<agent>.defaultModel` / `.defaultEffort` | — | valeurs présélectionnées |
| `agentHub.delegation.allowedModels` | `[]` | modèles que l'agent principal peut choisir (vide = tous) |
| `agentHub.delegation.allowedAgents` | `[]` | agents que l'agent principal peut choisir (vide = tous) |
| `agentHub.delegation.readOnlyChildren` | `true` | threads délégués en lecture seule pour l'utilisateur |
| `agentHub.delegation.maxActiveThreads` | `3` | threads délégués actifs en parallèle |
| `agentHub.delegation.threadTimeoutSec` | `1800` | délai maximal par thread délégué |
| `agentHub.isolation.policy` | `agent-decides` | ou `always-worktree` / `always-shared` |
| `agentHub.worktree.includeUncommitted` | `true` | reproduire les modifications non commitées dans les worktrees |
| `agentHub.worktree.linkPaths` | `["node_modules"]` | chemins ignorés par git à lier dans les worktrees |
| `agentHub.git.mainAgentCommit` | `deny` | `deny` / `ask` / `allow` |

## Journal et données

- Journal de debug : canal de sortie **« Agent Hub »** (commande « Agent Hub: Afficher le journal »). Les clés d'API et jetons sont masqués.
- Threads, événements et sortie brute de chaque CLI (pour le débogage) : fichiers JSONL dans le stockage de l'extension pour ce workspace. Les worktrees y sont aussi créés.
- Aucun appel réseau autre que `localhost`, hormis ceux des CLI eux-mêmes. Les processus enfants sont tués (arborescence comprise, `taskkill /T` sous Windows) à l'interruption d'un thread et à la fermeture de l'extension.

## Architecture

```
src/
├─ core/       events, types, Orchestrator, ThreadStore, ScopeRegistry, Worktrees, GitGuard, git, glob
├─ adapters/   AgentAdapter, base (CliAgentRun), claude, codex, opencode, agy, process, __mocks__/
├─ hooks/      claudeGuard (hook PreToolUse : scope + git)
├─ mcp/        DelegateServer (MCP Streamable HTTP, JSON)
├─ ui/         ThreadsTreeProvider, ChatView, chatViewModel, ChangesView, CommitStatusBar, commitDialog, newThreadWizard
└─ extension.ts
```

## Limites connues

- Codex et `agy` n'étaient pas installés pendant le développement : leurs adaptateurs suivent la documentation et sont testés avec des faux CLI, mais leurs flags et formats ne sont pas vérifiés (voir `docs/ADAPTERS.md`).
- Les garde-fous par analyse de commande (hook Claude, règles OpenCode) peuvent être contournés par une commande git obfusquée ; la détection `commit_violation` reste en filet de sécurité.
- En mode `shared`, une écriture hors scope détectée par `git status` n'est attribuée que si un seul sous-agent `shared`/`edit` est actif.
