# Adaptateurs Agent Hub — flags réels, modèles, efforts, interdictions git

Ce document consigne ce qui a été **vérifié** sur la machine de développement (Windows 11, 23/10/2026), les écarts avec la spécification initiale et les choix faits quand un point était ambigu.

| CLI | Version | État |
|---|---|---|
| Claude Code (`claude`) | 2.1.308 | vérifié (flags, flux stream-json, hook, MCP, scénario de délégation réel) |
| OpenCode (`opencode`) | 2.0.32 | vérifié (flags, flux JSON, permissions v2, blocage de `git commit`, scénario réel) |
| Codex (`codex`) | — | **non installé** : adaptateur écrit d'après la documentation, testé avec faux CLI, **non vérifié** |
| Antigravity (`agy`) | — | **non installé** : idem, **non vérifié** |

Les aides brutes capturées sont dans `docs/_claude-help.txt` et `docs/_opencode-run-help.txt`.

## Synthèse

| | Claude Code | OpenCode | Codex (non vérifié) | agy (non vérifié) |
|---|---|---|---|---|
| Invocation | `claude -p … --output-format stream-json --verbose --permission-prompts none` | `opencode run --format json --standalone` | `codex exec --json --skip-git-repo-check` | `agy -p … --output-format stream-json --non-interactive` |
| Reprise | `--resume <session_id>` | `--session <ses_…>` | `codex exec resume <id>` | `--resume <id>` |
| Modèles | alias parsés de `--help` (`fable`, `opus`, `sonnet`) + tout alias d'un mot + ids `claude-…` | `opencode models` (≈430 sur cette machine) | `free-text` (liste si le CLI en expose une) | parsés de `--help`, sinon `free-text` |
| Efforts | `--effort` : `low, medium, high, xhigh, max` (parsés de `--help`) | variantes `#variant` via `opencode api GET /api/model` : `low, medium, high, xhigh, max, none, thinking, minimal` | `-c model_reasoning_effort=…` si l'aide les liste, sinon `null` | `--effort`/`--thinking` si présents, sinon `null` |
| Interdiction git (couche 1) | `--disallowedTools Bash(git <cmd>:*) PowerShell(git <cmd>:*)` + hook PreToolUse `dist/hooks/claudeGuard.js` | règles `permissions` v2 `shell *git*<cmd>* deny` via `OPENCODE_CONFIG_CONTENT` — **vérifié : `git commit` → `Permission denied`** | sandbox `workspace-write` (`.git` en lecture seule) | options d'outils interdits si l'aide en montre, sinon couches 2/3 |
| Portée d'écriture | hook PreToolUse (Edit/Write/NotebookEdit hors globs → refus) | règles `edit` (`deny *` puis `allow <glob>`) — vérifié | aucune (prompt + détection) | aucune (prompt + détection) |
| MCP (agent principal) | `--mcp-config <json>` + `--allowedTools mcp__agenthub` | `mcp.servers.agenthub {type:"remote"}` dans la config injectée (chargement vérifié, connexion de bout en bout non testée) | `-c mcp_servers.agenthub.url=…`, token via variable d'env | `--mcp-config` si présent dans l'aide |

Les couches 2 (consigne dans le prompt système du sous-agent) et 3 (`GitGuard` : `HEAD` contrôlé au démarrage, à chaque `tool_result` et à la fin → `commit_violation`) s'appliquent à **tous** les adaptateurs.

## Constats faits pendant les tests de bout en bout

1. **`PWD` hérité (OpenCode/Bun)** — OpenCode choisit son répertoire de projet d'après la variable `PWD`, pas d'après le `cwd` du processus. Un sous-agent lancé depuis l'extension écrivait donc dans le dossier du parent. Correctif général dans `src/adapters/process.ts` : `PWD` est forcé au `cwd` de chaque CLI lancé.
2. **Outils MCP refusés par Claude en mode non interactif** — avec `--permission-prompts none`, tout outil qui demanderait une permission est refusé, y compris les outils MCP. L'adaptateur ajoute `--allowedTools mcp__agenthub` quand un serveur MCP est fourni.
3. **Alias de modèles Claude** — l'aide ne cite que des exemples (« e.g. 'fable', 'opus', or 'sonnet' ») ; `haiku` est valide mais absent. La validation accepte donc les alias listés, tout alias d'un seul mot (ex. `haiku`, `opus[1m]`) et les ids `claude-…` ; c'est le CLI qui tranche pour un alias inconnu (erreur remontée en événement `error`). Un nom manifestement invalide (espaces, etc.) est refusé avec la liste des alias.
4. **OpenCode v2 : nouveau format de permissions** — `{"permission":{"bash":…}}` (v1) est ignoré silencieusement ; le format v2 est un tableau `permissions` où la dernière règle qui matche gagne (voir la section OpenCode).
5. **Lancement sans shell sous Windows** — les shims npm (`claude.cmd`, `opencode.cmd`) sont résolus vers l'exécutable réel pour éviter `cmd.exe`, qui casse les prompts multi-lignes et les caractères spéciaux.

Scénario réel validé (dépôt temporaire, `mainAgentCommit = allow`) : Claude `haiku` appelle `list_agents` → `delegate` vers `opencode` / `opencode/deepseek-v4.1-flash-free` (shared, scope `hello.txt`, `wait: true`) → le thread enfant crée `hello.txt` (`changedFiles = ['hello.txt']`) → `commit({threadIds})` crée le commit et émet `commit_made` ; aucune violation, aucune branche créée.

## Application d'un worktree (`merge_thread` / bouton « Appliquer »)

Stratégie, du plus simple au plus robuste, sans jamais commiter ni perdre de données :

1. `git apply --check --binary` puis `git apply --binary` si le patch s'applique proprement (l'index n'est pas touché).
2. Sinon, `git apply --3way --binary` **seulement si** les fichiers concernés sont propres par rapport à l'index ; en cas de conflit, les marqueurs et les entrées non fusionnées sont laissés en place pour l'éditeur de fusion de VS Code ; en cas de succès, `git reset -q -- <fichiers>` laisse les changements non indexés.
3. Repli quand `--3way` ne peut pas s'appliquer — **cas observé** : le fichier est déjà modifié et non indexé dans le workspace (typiquement le 2e worktree qui touche un fichier déjà appliqué par le 1er : `git apply --3way` refuse un fichier qui « ne correspond pas à l'index ») ; également base absente de l'historique. On fusionne alors fichier par fichier avec `git merge-file` (base = état de départ du worktree, ours = workspace, theirs = worktree), sans toucher à l'index :
   - workspace inchangé depuis la base → la version de l'agent est écrite ;
   - conflit texte → marqueurs `<<<<<<< workspace` / `>>>>>>> agent <id>` écrits dans le fichier, statut `conflict` ;
   - fichier binaire divergent → le fichier du workspace est conservé et la version de l'agent est écrite à côté (`<fichier>.agenthub-theirs`) ;
   - fichier supprimé par l'agent mais modifié dans le workspace → rien n'est supprimé, conflit signalé.

L'état de départ d'un worktree est un **objet tree** (`git add -A` + `git write-tree` dans l'index propre au worktree), jamais un commit ; le worktree est créé avec `git worktree add --detach` (aucune branche).

## Autres choix faits sur des points ambigus

- **« Remise à la valeur du réglage à chaque nouvelle session » (permission de commit)** : interprété comme chaque session VS Code (activation de l'extension). Changer la permission via la barre d'état ne modifie pas le réglage.
- **Attribution des `scope_violation` détectées par `git status`** : un fichier modifié hors scope n'est attribué à un sous-agent que s'il est le seul thread délégué `shared`/`edit` actif et que le thread principal est au repos ; sinon l'auteur est indéterminable et rien n'est signalé. Les `file_changed` émis par l'adaptateur sont, eux, toujours attribués avec certitude.
- **Isolation par défaut (`agent-decides`)** : si l'agent principal ne précise rien, `readonly` → `shared`, `edit` avec `scope` → `shared`, `edit` sans `scope` → `worktree`.
- **Profondeur de délégation = 1** : seuls les threads principaux reçoivent un jeton MCP ; un sous-agent n'a donc accès à aucun outil de délégation ni à `commit`.
- **Fil d'événements d'un run** : chaque tour (un processus CLI) se termine par `done` ou `error` ; le flux reste ouvert pour les messages de suivi jusqu'à l'interruption.

---

## Adaptateur Claude Code

CLI vérifié : `claude` **2.1.308** (aide complète : `docs/_claude-help.txt`), auto-mis à jour en
2.1.309 pendant les essais ; les flags utilisés sont identiques et acceptés par les deux versions.

### Invocation

```
claude -p <prompt> --output-format stream-json --verbose --permission-prompts none
       [--model <alias|claude-…>] [--effort <niveau>]
       [--resume <sessionId>] [--append-system-prompt <txt>]
       [--mcp-config <json>]
       --permission-mode <default|acceptEdits|bypassPermissions>
       [--disallowedTools <outils…>] [--settings <json>]
```

- Chaque tour = un processus. `sendMessage` relance un processus avec `--resume <sessionId>`
  (id capturé sur la ligne `system/init`).
- `systemPromptAppend` est passé via `--append-system-prompt` au **premier** tour seulement
  (la session reprise le conserve).
- MCP : `--mcp-config '{"mcpServers":{"agenthub":{"type":"http","url":…,"headers":{"Authorization":"Bearer …"}}}}'`.
  Format conforme à la doc Claude Code ; non testé de bout en bout avec un serveur MCP réel.

### Modes de permission (vérifiés)

| mode | flags |
|---|---|
| `readonly` | `--permission-mode default` + `--disallowedTools Edit Write NotebookEdit` |
| `edit` | `--permission-mode acceptEdits` |
| `full` | `--permission-mode bypassPermissions` |

`default` n'apparaît pas dans les `choices` de `--help` en 2.1.308, mais est accepté par le CLI
(vérifié : le processus démarre et le modèle est bien sollicité).

### Git (couche 1)

Pour chaque sous-commande de `gitPolicy.forbidden`, on ajoute à `--disallowedTools` :

```
Bash(git <cmd>:*)   PowerShell(git <cmd>:*)
```

Vérifié en réel : avec `--disallowedTools "Bash(git status:*)"`, l'outil Bash est appelé puis refusé
par Claude Code (`REFUSE`). C'est une couche de défense : un script lancé par un autre outil peut
contourner ce filtre, d'où le hook ci-dessous.

### Hook de garde (`src/hooks/claudeGuard.ts`)

Si `guardScript` est fourni, l'adaptateur ajoute :

```json
{"hooks":{"PreToolUse":[{"matcher":"Edit|Write|NotebookEdit|Bash|PowerShell",
  "hooks":[{"type":"command","command":"node \"<guardScript>\""}]}]}}
```

et les variables d'environnement :

- `AGENT_HUB_ALLOWED_PATHS` : JSON array de globs relatifs au `cwd` (absente = aucune restriction) ;
- `AGENT_HUB_FORBIDDEN_GIT` : JSON array de sous-commandes git interdites.

Le script lit `{tool_name, tool_input, cwd}` sur stdin :

- `Edit`/`Write`/`NotebookEdit`/`MultiEdit` : résout `file_path`/`notebook_path` par rapport au `cwd`,
  refuse (exit 2 + raison sur stderr) si le chemin sort du workspace ou ne matche aucun glob ;
- `Bash`/`PowerShell` : tokenise `tool_input.command` (guillemets, `&&`, `||`, `;`, `|`, `$(…)`) et
  refuse si `git <sous-commande interdite>` est trouvé, y compris `git -C x commit`, `git -c a=b commit`,
  `git.exe push` ;
- tout le reste : exit 0.

Une liste JSON invalide est traitée comme une liste vide (écritures refusées / git non filtré selon la variable).
Le hook ne couvre pas les outils MCP qui écriraient des fichiers.

Build : `esbuild.mjs` produit aussi `dist/hooks/claudeGuard.js` (script autonome).

### Capabilities (dynamiques, mises en cache)

- `effortLevels` : parsés depuis `claude --help`, option `--effort <level>` suivie de
  `(low, medium, high, xhigh, max)` (le texte peut être sur plusieurs lignes).
  Résultat réel : `low, medium, high, xhigh, max`.
- `models` : alias extraits des quotes de l'aide de `--model` (« e.g. 'fable', 'opus', or 'sonnet' »).
  La validation accepte un alias listé, tout alias d'un seul mot non listé (ex. `haiku`, absent de
  l'aide) **ou** tout id commençant par `claude-` (voir « Constats ») ; à défaut de parsing,
  `models: 'free-text'`.
- `defaultModel`/`defaultEffort` : non exposés par le CLI, laissés indéfinis.

### Mapping des événements

| ligne CLI | événement |
|---|---|
| `system/init` | `session_started` |
| `assistant` content `text` | `assistant_text {partial:false}` |
| `assistant` content `tool_use` | `tool_call {id,name,input}` (mémorisé par id) |
| `user` content `tool_result` | `tool_result {id,name,output,isError}` |
| `tool_result` OK d’un `Write`/`Edit`/`NotebookEdit` | `file_changed {path: input.file_path}` |
| `result` | `usage {tokens: input+output, cost: total_cost_usd}` puis `done {summary: result}` |
| `result` avec `is_error` | `usage` puis `error {message: result}` |

Tout le reste (`rate_limit_event`, hooks `system/hook_*`, …) est ignoré.
Ligne non JSON : loguée en debug et ignorée. `tool_result.content` est transmis tel quel (string ou blocs).

### Limites connues

- Sans `guardScript`, `allowedPaths` n'est pas appliqué (seul le mode de permission agit).
- Le guard est une analyse de chaîne : `git` obfusqué (alias, variable, script, base64) peut passer.
- `usage` ne compte que `input_tokens + output_tokens` (pas les tokens de cache), conformément au contrat.
- Le flux reste ouvert après une erreur d'exécution (CLI absent, code ≠ 0) : seul `interrupt()` le ferme.
  Une erreur de validation (modèle/effort), elle, émet un unique `error` puis ferme.


## Adaptateur OpenCode

CLI vérifié : `opencode` **v2.0.32** (aide `run` : `docs/_opencode-run-help.txt`).

### Invocation

```
opencode run --format json --standalone [-m provider/model[#variant]]
             [--session <id>] [--auto] <message>
```

- `--standalone` est obligatoire pour l'adaptateur : sans lui le service d'arrière-plan peut ignorer
  le `cwd` et l'environnement du thread (vérifié : la config passée par `OPENCODE_CONFIG_CONTENT`
  n'est réellement chargée qu'en mode standalone pour `run`).
- Chaque tour = un processus. `sendMessage` relance avec `--session <id>` (id `ses_…` lu sur les lignes).
- **Pas de flag de prompt système** : `systemPromptAppend` est préfixé au premier message
  (`<append>\n\n<prompt>`), la session reprenant ensuite l'historique.
- Échec (code ≠ 0) sans événement `error` : `error` avec les dernières lignes stderr.
  Code 0 : `done {summary: dernier texte}`.

### Modèles et efforts

- Modèles : `opencode models` → une ligne `provider/model` par modèle (dynamique, mis en cache).
- Variantes/efforts : `opencode api --standalone GET /api/model` renvoie pour chaque modèle
  `variants: [{id, settings}]`. L'adaptateur fait l'**union** des `id` de tous les modèles.
  Sur la machine de test : `low, medium, high, xhigh, max, none, thinking, minimal`.
  L'effort est passé en `-m provider/model#variant`.
- Limite : `effortLevels` est global (contrat `AgentCapabilities`), alors que les variantes varient
  par modèle. Une variante valide globalement mais absente du modèle choisi sera refusée par le CLI.
- Si l'appel `api` échoue, `effortLevels: null` (pas d'effort transmissible) ; si `models` échoue,
  `models: 'free-text'`.

### Permissions et git (format v2 réel)

Le format v1 `{"permission":{"bash":{"git commit*":"deny"}}}` est **silencieusement ignoré** en v2
(vérifié : le `git commit` passe). Le format v2 est un tableau :

```json
{"permissions":[{"action":"edit","resource":"*","effect":"deny"},
                {"action":"edit","resource":"src/**","effect":"allow"}]}
```

- `action` = nom d'outil/glob : `edit` (write/edit/patch), `shell`, `execute`, `read`, `subagent`, …
- `resource` = commande shell, ou chemin pour `edit`.
- **La dernière règle qui matche gagne** (vérifié). Pour restreindre, il faut donc `deny "*"` d'abord,
  puis les `allow` ; l'ordre inverse (`allow` puis `deny "*"`) retire complètement l'outil.

Mapping appliqué par l'adaptateur :

| mode | règles |
|---|---|
| `readonly` | `edit:* deny`, `shell:* deny`, `execute:* deny` (pas de `--auto`) |
| `edit`/`full` | `--auto`, puis un `deny` shell par sous-commande git interdite : `*git*<cmd>*` |

- Git : le motif `*git*<cmd>*` couvre `git commit`, `git -C . commit`, `git -c a=b commit`, `git.exe push`.
  Vérifié : avec `--auto`, un `deny` n'est pas contourné (le shell répond `Permission denied`).
  Limite : analyse par glob sur la chaîne de commande (faux positifs possibles, obfuscation possible).
- Portée (`allowedPaths`) : `edit:* deny` puis `allow` pour chaque glob (+ `<glob>/**` pour un dossier
  simple). Vérifié : écriture autorisée dans `allowed/**`, refusée ailleurs.
- L'outil **`execute`** (Code Mode) exécute du JS et peut importer `node:fs` : il a écrit un fichier
  hors périmètre pendant les essais. Il est donc refusé dès qu'une portée est définie ou en readonly.
  (`node:child_process` est bloqué par le bac à sable — `git` ne peut pas être lancé par ce biais.)

Tout est transmis via `OPENCODE_CONFIG_CONTENT` (JSON), qui s'ajoute à la config utilisateur.

### MCP

Format v2 (observé dans la config réelle de la machine) :

```json
{"mcp":{"servers":{"agenthub":{"type":"remote","url":"<URL>",
  "headers":{"Authorization":"Bearer <TOKEN>"}}}}}
```

Le document virtuel `OPENCODE_CONFIG_CONTENT` est bien chargé par `--standalone`
(vérifié via `opencode api --standalone GET /api/config`). Connexion MCP réelle non testée de bout en bout.

### Mapping des événements

| ligne CLI | événement |
|---|---|
| `sessionID` (1re ligne) | `session_started` (une seule fois) |
| `text` | `assistant_text {partial:false}` |
| `tool_use` | `tool_call {id,name,input}` puis, si `state.status` = `completed`/`error`, `tool_result` |
| `tool_use` `write`/`edit`/`patch` réussi | `file_changed {path: state.input.path/filePath}` |
| `step_finish` | `usage {tokens: input+output+reasoning, cost}` |
| `error` | `error {message}` (émis en fin de tour) |
| fin de processus code 0 | `done {summary: dernier texte}` |

Les autres types (`step_start`, …) sont ignorés ; une ligne non JSON est loguée et ignorée.

### Limites connues

- Effort global vs variantes par modèle (cf. ci-dessus) ; effort ignoré si aucun modèle n'est fourni
  (le CLI n'accepte `#variant` qu'avec `-m`).
- Le format de config v2 peut évoluer ; les clés inconnues sont ignorées sans erreur par le CLI,
  donc une régression de format est silencieuse (les tests figent le format observé).
- L'outil `execute` doit être désactivé pour garantir la portée ; cela retire aussi le Code Mode.
- `deny` git est une analyse de chaîne, pas un vrai sandbox : un binaire renommé ou un script
  contourne le filtre.


## Adaptateur Codex

> **NON VÉRIFIÉ** : `codex` n'est pas installé sur la machine de développement (`codex --help` →
> command not found). Tous les flags et le format JSONL ci-dessous viennent de la documentation Codex
> et sont figés par les fixtures de test (`src/adapters/__mocks__/fixtures/codex-*.jsonl`), pas observés
> sur un CLI réel. À revalider dès qu'un `codex` est disponible.

### Invocation

```
codex exec --json --skip-git-repo-check
      [-m <model>] [-c model_reasoning_effort=<effort>]
      [--sandbox <read-only|workspace-write>]
      [-c mcp_servers.agenthub.url=<url>
       -c mcp_servers.agenthub.bearer_token_env_var=AGENT_HUB_MCP_TOKEN]
      <prompt>
```

Reprise (id `thread_id` capturé sur `thread.started`) :

```
codex exec resume <sessionId> --json --skip-git-repo-check … <prompt>
```

- Chaque tour = un processus. `sendMessage` relance `codex exec resume`.
- `systemPromptAppend` est préfixé au prompt du **premier** tour (`<append>\n\n<prompt>`) ; la session
  reprise conserve l'historique.
- `--skip-git-repo-check` autorise l'exécution hors dépôt git (worktrees temporaires, tests).
- Échec (code ≠ 0) sans événement final : `error` avec les dernières lignes stderr. Code 0 sans
  `turn.completed` : `done {summary: dernier agent_message}`.
- `resume`, `--skip-git-repo-check`, `-c` sur `resume` : **non vérifiés**.

### Modes de permission

| mode | args |
|---|---|
| `readonly` | `--sandbox read-only` |
| `edit` | `--sandbox workspace-write` |
| `full` | `--sandbox workspace-write` + `-c sandbox_workspace_write.network_access=true` |

`-c approval_policy=never` est ajouté dans tous les cas : les tours sont pilotés par l'extension, aucune
approbation interactive ne doit bloquer le processus. (La doc Codex écrit `approval_policy="never"` ;
comme le CLI est lancé **sans shell**, les guillemets sont retirés : la valeur passée est `never`.)

### Git et portée

- **Couche 1 (CLI)** : Codex n'a pas de refus d'outil par commande. Le sandbox `workspace-write` garde
  `.git` en lecture seule (doc Codex) : un `git commit` échoue. En `readonly`, le sandbox `read-only`
  interdit toute écriture.
- **Couches 2 et 3** (consigne de prompt, puis `GitGuard`) sont appliquées ailleurs par l'Orchestrator.
  L'adaptateur ne transmet **rien** de `gitPolicy.forbidden` dans les args.
- **`allowedPaths`** : aucun mécanisme natif côté Codex. Rien n'est ajouté aux args ; la portée est
  portée par le prompt construit par l'Orchestrator (un `info` est logué, sans les chemins).
  Une écriture hors périmètre n'est donc **pas** bloquée par l'adaptateur.

### MCP

```
-c mcp_servers.agenthub.url=<url>
-c mcp_servers.agenthub.bearer_token_env_var=AGENT_HUB_MCP_TOKEN
```

Le token n'est **jamais** un argument : il est transmis dans l'environnement du processus sous
`AGENT_HUB_MCP_TOKEN`, que Codex lit via `bearer_token_env_var`. Sans token, seule l'URL est passée.
Format documenté, non testé de bout en bout avec un serveur MCP réel.

### Mapping des événements (JSONL stdout)

| ligne CLI | événement |
|---|---|
| `thread.started` (`thread_id`) | `session_started` |
| `item.started` `command_execution` | `tool_call {id, name:'command_execution', input:{command}}` |
| `item.completed` `command_execution` | `tool_result {id, name, output:aggregated_output, isError: status='failed' ou exit_code≠0}` |
| `item.completed` `file_change` (`changes[].path`) | un `file_changed` par chemin |
| `item.started` `mcp_tool_call` | `tool_call {id, name:'<server>.<tool>', input:arguments}` |
| `item.completed` `mcp_tool_call` | `tool_result {id, name, output:result ou error, isError}` |
| `item.completed` `agent_message` (`text`) | `assistant_text {partial:false}` (mémorisé comme dernier texte) |
| `turn.completed` (`usage`) | `usage {tokens: input_tokens + output_tokens}` puis `done {summary}` |
| `turn.failed` (`error.message`) / `error` (`message`) | `error {message}` |

`reasoning`, `todo_list`, `item.updated`, `turn.started` et les lignes inconnues sont ignorés.
`item.started` d'un `file_change` est ignoré (la liste `changes` n'est complète qu'à `item.completed`),
ce qui évite les doublons. `cached_input_tokens` n'est pas compté séparément (sous-ensemble de
`input_tokens` dans la doc).
Ligne non JSON : loguée en debug et ignorée. Les lignes brutes restent disponibles via `onRawLine`.

### Capabilities (dynamiques, mises en cache)

- **Modèles** : si `codex --help` mentionne une sous-commande de liste de modèles (`codex models`), elle
  est appelée et chaque ligne non vide est un id. Sinon, les valeurs énumérées de `--model` dans l'aide
  sont utilisées. Sinon `models: 'free-text'` (aucune liste en dur).
- **Efforts** : aucune liste codée en dur. Les valeurs sont cherchées dans `codex --help` /
  `codex exec --help` autour de `model_reasoning_effort` (`valeurs : …`, `{…}`, ou section d'une option
  `--effort`). La doc Codex connue mentionne `minimal`, `low`, `medium`, `high`, `xhigh` : **à titre
  indicatif seulement**. Si rien n'est trouvé (CLI absent), `effortLevels: null` ; fournir un effort
  produit alors une erreur `(aucune)`.
- **defaultModel / defaultEffort** : lus dans `$CODEX_HOME/config.toml` (défaut `~/.codex/config.toml`),
  clés `model = "…"` et `model_reasoning_effort = "…"`. Absents du fichier → non exposés.
- Un modèle découvert est validé strictement ; `free-text` accepte n'importe quel id.

### Limites connues

- Flags, format JSONL, sémantique de `resume` et découverte de `models` : **non vérifiés**.
- `gitPolicy.forbidden` et `allowedPaths` ne sont pas appliqués par l'adaptateur (cf. ci-dessus).
- Le sandbox ne protège que si Codex honore `workspace-write` ; un binaire/script hors sandbox peut
  contourner la règle `.git` en lecture seule.
- `usage` ne compte que `input_tokens + output_tokens` (pas de coût fourni par ce flux).
- Le flux reste ouvert après une erreur d'exécution (CLI absent, code ≠ 0) : seul `interrupt()` le
  ferme. Une erreur de validation (modèle/effort) émet un unique `error` puis ferme.


## Adaptateur Antigravity (`agy`)

> **NON VÉRIFIÉ** : `agy` n'est pas installé sur la machine de développement (`agy --help` →
> command not found). Les flags et le format `stream-json` ci-dessous sont **supposés** (le format est
> annoncé proche de Claude Code) et figés par les fixtures
> `src/adapters/__mocks__/fixtures/agy-*.jsonl`. À revalider avec un CLI réel.

### Invocation

```
agy -p <prompt> --output-format stream-json --non-interactive
    [--model <id>] [--effort|--thinking <niveau>]
    --mode <plan|accept-edits>
    [--resume <sessionId>] [--mcp-config <json>]
    [--disallowed-tools <outils…>]
```

- Chaque tour = un processus. `sendMessage` relance avec `--resume <sessionId>` (id lu sur
  `system/init`, `session_id`/`sessionId` ou `session.id`).
  Si l'aide ne montre pas `--resume`, l'adaptateur l'utilise quand même par défaut (fallback
  documenté, non vérifié).
- `systemPromptAppend` est préfixé au prompt du **premier** tour (`<append>\n\n<prompt>`).
- Échec (code ≠ 0) sans événement final : `error` avec les dernières lignes stderr. Code 0 :
  `done {summary: résultat ou dernier texte}`.

### Modes de permission

| mode | args |
|---|---|
| `readonly` | `--mode plan` |
| `edit` / `full` | `--mode accept-edits` |

### Capabilities (dynamiques, mises en cache)

Tout est découvert dans `agy --help` (une seule invocation, mise en cache) :

- **Modèles** : valeurs énumérées de la section `--model` (ex. `Valeurs : a, b, c` ou `{a,b}`).
  Si aucune valeur n'est listée mais que l'aide mentionne une sous-commande `agy models`, elle est
  appelée (une ligne = un id). Sinon `models: 'free-text'` (saisie libre).
- **Effort** : si l'aide expose `--effort` ou `--thinking`, l'option retenue est utilisée pour passer
  `effort`, et ses valeurs énumérées deviennent `effortLevels`. Si l'option existe sans valeurs
  listées, ou si aucune option n'existe : `effortLevels: null` (fournir un effort produit une erreur).
- Pas de `defaultModel`/`defaultEffort` (aucune source locale connue).

### MCP

Supporté **uniquement si** l'aide expose `--mcp-config`. Le format transmis est celui de Claude Code :

```json
{"mcpServers":{"agenthub":{"type":"http","url":"<URL>",
  "headers":{"Authorization":"Bearer <TOKEN>"}}}}
```

Si l'option est absente de l'aide, `start` **ignore** `mcpServerUrl`/`mcpToken` et logue un
avertissement (une fois). Contrairement à Codex, le token est ici dans les args JSON (comme pour
Claude Code) : il est donc visible dans la ligne de commande du processus.

### Git (couche 1)

Aucun mécanisme natif n'est supposé par défaut. Si l'aide expose `--disallowed-tools` (ou
`--disallowedTools`), l'adaptateur ajoute, pour chaque sous-commande de `gitPolicy.forbidden` :

```
--disallowed-tools "Bash(git <cmd>:*)" "PowerShell(git <cmd>:*)"
```

Format supposé identique à Claude Code (**non vérifié**). Sans cette option, seules les couches 2
(prompt) et 3 (`GitGuard`) s'appliquent : documenté, rien n'est transmis.

`allowedPaths` n'a pas de mécanisme natif : la portée reste dans le prompt (Orchestrator).

### Mapping des événements (`stream-json`)

| ligne CLI | événement |
|---|---|
| `system/init` (`session_id`) | `session_started` |
| `assistant` `message.content[]` bloc `text` | `assistant_text {partial:false}` |
| `assistant` `message.content[]` bloc `tool_use` | `tool_call {id,name,input}` (mémorisé par id) |
| `assistant` avec `content` string ou `text` racine | `assistant_text` (forme tolérante) |
| `user` `message.content[]` bloc `tool_result` | `tool_result {id,name,output,isError}` |
| `tool_result` OK d'un `Write`/`Edit`/`NotebookEdit`/`MultiEdit` | `file_changed {path: input.file_path/path}` |
| `result` (`usage`, `total_cost_usd`) | `usage {tokens, cost}` puis `done {summary}` |
| `result` avec `is_error` ou `subtype:'error'` | `usage` puis `error {message}` |
| `error` | `error {message}` |

- `tokens` = `usage.total_tokens` s'il est fourni, sinon `input_tokens + output_tokens`.
- Tout objet inconnu portant un `text` (ou `delta.text`) est traité comme `assistant_text` ; les autres
  lignes inconnues sont ignorées. Les lignes brutes restent disponibles via `onRawLine` ; une ligne non
  JSON est loguée en debug et ignorée.
- Un texte identique au précédent n'est pas réémis (évite les doublons des flux delta + message final).

### Limites connues

- Format `stream-json`, flags `--mode`, `--resume`, `--mcp-config`, `--disallowed-tools` : **supposés**,
  non vérifiés.
- Le mapping `tool_use`/`tool_result` reprend le format Claude Code ; si `agy` utilise d'autres noms de
  blocs, seuls les textes seront remontés.
- `file_changed` est déduit d'un `tool_result` réussi (pas d'événement dédié).
- Le token MCP est passé en argument (visible dans la ligne de commande).
- Pas de blocage git natif quand `--disallowed-tools` est absent ; `allowedPaths` non appliqué par
  l'adaptateur.
- Le flux reste ouvert après une erreur d'exécution (CLI absent, code ≠ 0) : seul `interrupt()` le
  ferme. Une erreur de validation (modèle/effort) émet un unique `error` puis ferme.

