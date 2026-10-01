# Changelog

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
