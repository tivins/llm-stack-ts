# Changelog

## 0.14.0 - 2026-11-20

### Added

- `stack gpu sample` : relève le GPU (puissance, utilisation, VRAM, température, par `nvidia-smi`) toutes les 10 s (`--interval`) dans `$XDG_STATE_HOME/llm-stack/gpu-samples/AAAA-MM-JJ.csv` ; service utilisateur fourni (`systemd/stack-gpu-sampler.service`). Reprend le script `gpu-sampler` de forge (même format de CSV).
- `stack gpu usage [jours|AAAA-MM-JJ]` : Wh, puissance moyenne et maximale, temps occupé, VRAM maximale par jour ou par heure, puis Wh par projet en croisant avec le journal des baux ; `--json` donne les données. Reprend le script `gpu-usage` de forge.
- Lib : `runGpuSampler`, `readGpuSample`, `appendGpuSample`, `readGpuSamples`, `gpuSampleDays`, `summarizeGpuUsage`, `formatGpuUsage`, `defaultGpuSamplesDir`.

## 0.13.0 - 2026-11-20

### Added

- Journal des baux GPU : chaque bail rendu ajoute une ligne JSON (holder, pid, priorité, launcher, demande, obtention, libération, `broken` si un autre client l'avait cassé) à `$XDG_STATE_HOME/llm-stack/gpu-journal/AAAA-MM.jsonl`. Il survit au redémarrage, contrairement au bail dans `/tmp`. Les baux pris à distance (`stack lease`) sont écrits sur la machine qui a le GPU. Un client qui meurt en tenant le bail n'écrit rien.
- `stack gpu history [jours|AAAA-MM-JJ]` : temps de GPU tenu et temps d'attente par projet (texte du holder avant le premier `:`), 7 derniers jours par défaut ; une date liste aussi chaque bail ; `--json` donne les baux.
- Lib : `GpuLockOptions.journalDir` (pas de journal si absent ; `Stack` et `createOrchestrator` le règlent), `StackOptions.gpuJournalDir`, `readGpuJournal`, `summarizeGpuJournal`, `formatGpuHistory`, `holderProject`, `defaultGpuJournalDir`.

## 0.12.0 - 2026-11-19

### Added

- Option `start` des baux (`withLease`, `acquire`) : `start: false` ne démarre pas `launcher` sous le bail ; il ne sert qu'à choisir la machine dont on prend le GPU (le bail de forge pour un launcher `remote`) et à grouper les jobs. Le job démarre ses services lui-même, sous ce bail. Pour un client qui veut montrer le temps de chargement (llm-multi-ts, `leaseGate(stack, { startLauncher: false })`) : sans cette option, il ne nommait pas le launcher, et un service de forge tournait sous un bail local seulement, sans le bail de forge.

## 0.11.1 - 2026-11-19

### Fixed

- `LauncherSummary.port` (et donc `url`, `stack list-json`) prend le port de l'URL du health check quand le launcher n'a pas de clé `port` : ComfyUI, lancé sur son port par défaut, avait un résumé sans port, et une machine distante n'ouvrait pas de tunnel vers lui.

## 0.11.0 - 2026-11-19

### Added

- Machines distantes : `[remotes.<nom>]` (`ssh`, `wake`, `wake_broadcast`, `wake_timeout_seconds`, `port_offset`, `tunnel`, `stack`, `command`) et launchers `remote = "<nom>"` (option `remote_name`), sans autre réglage : le modèle, la VRAM et l'exclusivité restent dans le `stack.toml` de la machine distante. `start`, `restart`, `stop`, `status`, `show` et `logs` y passent par `ssh <machine> stack … --json`.
- Bail distant : `withLease({ launcher })` et `acquire({ launcher })` sur un launcher distant prennent le bail de cette machine avec `stack lease` (nouvelle `RemoteLease`, sous-classe de `GpuLease`) ; `start`/`stop` d'un service de la même machine passent sous ce bail. Libellé là-bas : `<machine d'ici>/<holder>`. Sans bail, un `start` distant prend un bail là-bas le temps du démarrage.
- Tunnels ssh (`ssh -N -L`, suivis comme des services) ouverts par `start` vers `127.0.0.1:<port + port_offset>`, relancés s'ils ne répondent plus, fermés par `stack stop` sans nom.
- Wake-on-LAN automatique d'une machine distante qui ne répond pas (start, restart, bail), puis `RemoteUnreachableError` si elle ne répond toujours pas. `status`, `list`, `stop` et `gpu` ne réveillent jamais.
- `LauncherSummary.url` (URL de base du service : origine du health check ou `127.0.0.1:<port>`, ou bout du tunnel) et `LauncherSummary.host`. `describeLauncher()` donne ce résumé, valeurs distantes comprises.
- `Stack.remoteGpu()` ; `stack gpu` affiche aussi la file de chaque machine distante. `stack gpu touch` ; `Stack.touch()` prévient aussi les machines distantes (au plus toutes les 10 s).
- `stack list` (`@forge`), `stack status` (colonne HOST), `stack validate` (le launcher existe-t-il là-bas ?) connaissent les launchers distants. `--hold` fonctionne sur des services d'une même machine distante.
- Schéma : `remotes`, `remote`, `remote_name`.

### Changed

- `stack stop` sans nom ferme aussi les tunnels ; il n'arrête jamais les services d'une machine distante.
- `--json` écrit ses lignes de manière synchrone : la dernière (erreur, `released`) n'est plus perdue par la sortie du processus.

## 0.10.0 - 2026-11-19

### Added

- CLI : `stack lease [name]` prend le bail GPU et le garde tant que stdin reste ouvert ; fermer stdin pendant l'attente retire le job de la file. Démarre `name` sous le bail avant de le donner, puis exécute sous ce bail les commandes lues sur stdin, une par ligne : `start <name>`, `restart <name>`, `stop <name>`, `touch`, `release`. `--holder` (nouveau) fixe le libellé, `--priority` et `--max-wait` comme ailleurs. Lancé par `ssh`, le bail d'un client distant devient un processus de la machine du GPU : si le client ou le réseau tombe, sshd ferme stdin et le bail est rendu. Première étape du pilotage de forge depuis le PC principal (`llm-central/decisions/2026-11-19_forge_distant.md`).
- CLI : `--json` sur `status`, `gpu`, `start`, `run`, `restart`, `stop` et `lease` : un objet JSON, ou une ligne JSON par événement (`waiting`, `granted`, `done`, `error`, `cancelled`, `released`) ; les messages de progression passent sur stderr et une erreur est aussi écrite sur stdout (`{"event":"error","message":…}`).
- Librairie : `runLeaseSession()` (la boucle de `stack lease`, sur n'importe quelle source de lignes) et les types `LeaseEvent`, `LeaseEndReason`, `LeaseSessionOptions`.

## 0.9.1 - 2026-11-09

### Fixed

- `ProcessExit.signal` reste un nom de signal (`SIGTERM`…) même quand Bun le donne sous forme de numéro : corrige le typecheck avec `@types/bun` 1.4 (`ProcessManager.ts`), vu depuis local_semantic_index.

## 0.9.0 - 2026-11-06

### Added

- CLI : `stack start <name...> --hold` (et `run`) garde le bail GPU après le démarrage, jusqu'à Ctrl+C, en priorité 0 par défaut (`--priority` pour changer). Les autres clients (un worker en tâche de fond, par exemple) attendent dans la file au lieu d'arrêter un service qu'on utilise à la main. Le bail est rendu aussi quand plus aucun des services ne tourne, ou quand un autre client le casse ; les services restent actifs. Refusé avec `--force` et hors de `start`/`run`.

## 0.8.0 - 2026-10-21

### Added

- File de jobs avec priorités sur le bail GPU, sans démon : `priority` 0 (chat), 1 (demandé par l'utilisateur, par défaut) et 2 (fond). À priorité égale, les jobs qui veulent le launcher déjà chargé passent d'abord (option `launcher`), jusqu'à `max_batch` jobs d'affilée ou jusqu'à ce qu'un autre job attende depuis `switch_after_seconds`. Les jobs de priorité 2 attendent `idle_seconds` sans activité de priorité 0 ou 1. Réglages dans la nouvelle table `gpu_queue` de la config.
- Options du bail (`Stack.withLease`, `Stack.acquire`, `GpuLock.acquire`) : `priority`, `launcher` (démarré sous le bail avant la fonction par `Stack`), `idleMs`, `maxWait` (abandon avec la nouvelle `GpuBusyError`, qui porte le détenteur et la file) et `onWait` pour l'appelant. `start`, `restart` et `stop` acceptent `priority`, `maxWait` et `onWait`.
- `Stack.touch()` repousse les jobs de fond ; `Stack.cancel(id)` et `stack gpu cancel <id>` retirent un job qui attend.
- CLI : `--priority` et `--max-wait` sur `start`, `run`, `restart` et `stop` ; `stack gpu` affiche la file dans l'ordre de passage, avec priorité, launcher, raison de l'attente et id.
- `stack validate` et `stack list` signalent un `llama-server` en `gpu = false` qui met quand même des couches sur le GPU (pas de `n-gpu-layers = 0`) : cette VRAM n'est comptée nulle part. Aussi exporté : `cpuOffloadWarnings()`.

### Changed

- Les clients en attente passent dans l'ordre de la file et non plus seulement dans l'ordre d'arrivée. Sans `priority` ni `launcher`, rien ne change : tout le monde est en priorité 1, dans l'ordre d'arrivée.
- `AcquireOptions.onWait` reçoit `(holder, position)` : `holder` peut être `null` (aucun détenteur, mais le job attend son tour ou le calme). `LeaseInfo` porte `priority`, `launcher` et, dans `GpuStatus.waiting`, `reason`.
- L'exclusion mutuelle ne repose plus sur l'ordre de la boulangerie : le client élu marque son ticket puis vérifie que personne d'autre ne l'a fait, et recule sinon.

## 0.7.0 - 2026-10-14

### Changed

- `Stack` et `createOrchestrator()` n'écrivent plus dans la console par défaut : sans `StackOptions.logger`, la librairie est silencieuse. Passer `logger: new ConsoleLogger()` pour retrouver les messages. Le CLI les affiche toujours.

## 0.6.0 - 2026-10-14

### Added

- Bail GPU partagé entre tous les clients de la stack (CLI et projets qui importent `Stack`) : un seul détenteur à la fois, les autres attendent dans l'ordre d'arrivée et le journal indique qui tient le GPU. Sans démon : des fichiers dans `<tmpdir>/stack-llm/gpu/`, et un client qui meurt perd sa place.
- Démarrer ou arrêter un service `gpu` ou `exclusive` prend le bail le temps de l'opération : un client n'arrête plus le service qu'un autre est en train d'utiliser, s'il tient le bail.
- Librairie : `Stack.withLease()`, `Stack.acquire()`, `Stack.gpu()`, option `lease` de `start`/`stop`/`restart`, `StackOptions.holder`, `GpuLeaseLostError`. Classe `GpuLock` exportée.
- `stack gpu` affiche le détenteur et la file ; `stack gpu release --force` casse le bail d'un client bloqué.
- `--force` sur `start`, `run`, `restart` et `stop` : passe outre le bail.
- `Stack.start()` et `Stack.restart()` acceptent un `signal` (`AbortSignal`) : il interrompt l'attente du bail ou du health check, et arrête le processus que l'appel venait de lancer.

### Changed

- `Stack.stop()`, `Stack.stopAll()` et `ProcessController.stop()` renvoient une `Promise` et n'attendent plus la fin du processus en bloquant (`Bun.sleepSync`) : les appelants doivent faire `await`.
- `Orchestrator.ensureActive(name, options)` prend un objet (`wait`, `signal`, `lease`, `force`) au lieu du booléen `waitForHealth`. `Orchestrator.restart()` fait l'arrêt et le démarrage sous un seul bail.
- `stack restart` ne laisse plus un autre client prendre le GPU entre l'arrêt et le démarrage.
- `vram_capacity_gb` désigne la VRAM que la stack peut utiliser, pas la capacité de la carte : l'exemple passe à `15` pour une carte de 16 Go, pour laisser de la place au bureau et au navigateur.

## 0.5.0 - 2026-10-10

### Added

- Configuration en TOML (`stack.toml`), cherché avant `stack.json`. Le JSON reste accepté.
- Launchers indexés par nom (`[launchers.<nom>]`) ; l'ancien tableau avec `name` reste accepté.
- `extends` : un launcher hérite d'un autre, `args`, `env` et `health` sont fusionnés clé par clé. `abstract = true` pour un parent qui ne se démarre pas.
- `args` : options sous forme de table (`ctx-size = 16384` → `--ctx-size 16384`, `true` pour un flag nu, `false` pour retirer un flag hérité, tableau pour répéter un flag).
- `kind = "llama-server"` : binaire par défaut, `--host`/`--port` ajoutés à partir des clés `host`/`port`, `health.url` déduite, options courtes (`c`, `m`, `fa`, `np`, `ngl`...) converties en options longues.
- `vars` et variables `${nom}`, plus `${name}`, `${port}` et `${host}` propres à chaque launcher.
- `stack migrate` convertit un `stack.json` en `stack.toml` (variantes, parent commun, `vars`) et vérifie que chaque launcher reste identique avant d'écrire.
- `stack show [name...]` affiche la commande finale après héritage et variables.
- `stack list -q` affiche seulement les noms.
- `list-json` et `Stack.listSummary()` exposent `extends`, `model`, `ctxSize`, `reasoningBudget` et `port`.
- `--arg key[=value]` sur `start`, `run`, `restart` et `show` pour surcharger une option le temps d'un lancement. Librairie : `StackOptions.argOverrides`.
- `stack validate` signale les fichiers et dossiers absents de la ligne de commande (modèles `.gguf`, `--mmproj`...) et sort en erreur.
- Librairie : `parseStackConfig`, `readStackFile`, `findMissingPaths`, `migrateStackConfig`.

### Changed

- `stack list` affiche un tableau regroupé par type : modèle, contexte, budget de raisonnement, port, VRAM, et les variantes sous leur parent avec seulement ce qu'elles changent. Ces informations sont aussi relues dans les commandes `llama-server` d'un `stack.json` à l'ancien format.
- `stack-example.json` est remplacé par `stack-example.toml`.
- Un nom de launcher peut commencer par `_`.

## 0.4.0 - 2026-10-01

### Fixed

- `stack start` ne signale plus « Process exited before becoming healthy » pour un service lancé via un script qui fait `exec` (ex. ComfyUI) : le processus est suivi par son PID et son heure de démarrage, plus par sa ligne de commande.
- `stack stop` arrête tout le groupe de processus : les enfants d'un script ne restent plus orphelins en gardant de la VRAM.
- Un démarrage refusé faute de VRAM n'arrête plus les autres services au passage.
- Deux services avec le même `process_match` (ex. deux variantes du même modèle) ne sont plus vus actifs en même temps.
- Sans `process_match`, un processus n'est retrouvé que si sa ligne de commande est identique à `command` (avant : une simple sous-chaîne, qui pouvait viser un processus sans rapport).

### Added

- Logs par service dans `~/.local/state/llm-stack/logs/<name>.log` (run précédent en `.log.1`) et commande `stack logs <name> [-n N] [--follow]`.
- En cas d'échec au démarrage, le code de sortie et les dernières lignes du log sont affichés.
- Nouvelles clés de config : `cwd`, `env`, `gpu`, `exclusive`, `stop_timeout_seconds`, `vram_gb`, `vram_capacity_gb`.
- Les services `gpu` non `exclusive` partagent réellement la VRAM : leur `vram_gb` est compté dans le budget.
- `stack status` sans nom (ou avec plusieurs) affiche un tableau ; `stack restart` ; `stack validate`.
- Avertissement sur les clés inconnues, `stack.schema.json` pour l'autocomplétion.
- Librairie : `Stack.restart()`, `Stack.pid()`, `Stack.logFile()`, `Stack.warnings`.

### Changed

- `type` et `description` sont optionnels ; `type` est un libellé libre (plus limité aux types LLM).
- `vram_gb` (0 par défaut) et `vram_capacity_gb` sont optionnels ; sans capacité, pas de contrôle de VRAM.
- Health check : tout code 2xx est accepté si `expected_status` n'est pas précisé.
- Délai avant SIGKILL porté de 5 s à 10 s par défaut (configurable).
- Librairie : `LlmLauncher` devient `Launcher` (`vramGb`, `gpu`, `exclusive` remplacent `minimalVideoRamUsageInGigabytes` et `allowFullCPU`) ; `ProcessController.start()` renvoie `{ pid, exited }` et l'interface gagne `getPid()`.

### Deprecated

- `vram_capacity_in_gigabytes`, `minimal_video_ram_usage_in_gigabytes` et `allow_full_cpu` restent acceptés ; `stack validate` les signale.

### Removed

- Librairie : `LLM_TYPES`, `isLlmType` et le type `LlmType`.

## 0.3.0 - 2026-09-29

- `stack run` est un alias de `stack start` (mêmes arguments, y compris `--no-wait`).

## 0.2.0 - 2026-09-29

- `stack stop` sans nom arrête tous les modèles actifs. `stack stop <name...>` conserve le comportement précédent.
- `Stack.stopAll()` expose le même comportement côté librairie.
