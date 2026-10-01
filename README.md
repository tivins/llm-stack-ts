# llm-stack-ts

CLI + librairie Bun/TS pour démarrer, arrêter et surveiller des services locaux (llama.cpp, ComfyUI, ...) qui se partagent un GPU, depuis un seul fichier de configuration.

Port de [llm-stack](../llm-stack) (PHP) et [llm-stack-sdk](../llm-stack-sdk) (PHP), fusionnés en un seul package : en Bun/TS, plus besoin d'un SDK séparé qui `exec()` le binaire CLI et parse sa sortie — le CLI (`src/cli.ts`) et l'API importable (`src/index.ts`) partagent directement le même code (`Orchestrator`, `ProcessManager`...).

## Prérequis

- Bun
- Linux (utilise `/proc` pour la détection de processus, comme l'original PHP)

## Installation

```sh
cd /data/projects/llm-stack-ts
bun install
bun link
```

`bun link` expose la commande `stack` globalement.

## Configuration

Copiez l'exemple et adaptez-le :

```sh
cp stack-example.json stack.json
```

Définissez `LLM_STACK_CONFIG` ou passez `-f /chemin/vers/stack.json` pour utiliser un fichier différent. `stack.json` est gitignoré pour que vos commandes/chemins locaux restent privés. Ajoutez `"$schema": "/chemin/vers/llm-stack-ts/stack.schema.json"` pour avoir l'autocomplétion dans votre éditeur.

```json
{
  "vram_capacity_gb": 16,
  "launchers": [
    {
      "name": "comfyui",
      "command": "/data/softwares/comfyui/venv/bin/python main.py",
      "cwd": "/data/softwares/comfyui/ComfyUI",
      "vram_gb": 14,
      "health": { "url": "http://127.0.0.1:8188/system_stats" }
    }
  ]
}
```

| Clé | Défaut | Rôle |
|---|---|---|
| `vram_capacity_gb` | aucun contrôle | VRAM totale disponible pour les services `gpu` |
| `name` | requis | Identifiant (lettres, chiffres, `.`, `_`, `-`) |
| `command` | requis | Commande lancée via `bash -c "exec <command>"` |
| `description`, `type` | `""` | Libellés libres |
| `cwd` | dossier courant | Dossier de travail (`~` accepté) |
| `env` | — | Variables d'environnement ajoutées |
| `vram_gb` | `0` | VRAM réservée, comptée seulement si `gpu` |
| `gpu` | `true` | Compte `vram_gb` dans le budget VRAM |
| `exclusive` | valeur de `gpu` | Démarrer ce service arrête les autres services `exclusive` |
| `process_match` | égalité stricte avec `command` | Sous-chaîne de la ligne de commande pour retrouver un processus lancé hors de `stack` |
| `stop_timeout_seconds` | `10` | Délai entre SIGTERM et SIGKILL |
| `health.url` | — | URL interrogée jusqu'à obtenir une réponse |
| `health.expected_status` | tout 2xx | Code HTTP exact attendu |
| `health.timeout_seconds` | `300` | Délai maximum de démarrage |
| `health.interval_ms` | `1000` | Intervalle entre deux essais |

Une clé inconnue (faute de frappe) déclenche un avertissement. Les anciennes clés restent acceptées : `vram_capacity_in_gigabytes`, `minimal_video_ram_usage_in_gigabytes` et `allow_full_cpu` (`true` équivaut à `gpu: false, exclusive: false`, `false` à `gpu: true, exclusive: true`). `stack validate` les signale.

### GPU et exclusivité

- Un service **`exclusive`** arrête les autres services `exclusive` en cours avant de démarrer (typiquement : les gros modèles, ComfyUI).
- Un service **`gpu`** non exclusif (un petit reranker, par exemple) cohabite avec les autres tant que la somme des `vram_gb` actifs tient dans `vram_capacity_gb`.
- Le budget est vérifié **avant** d'arrêter quoi que ce soit : un démarrage refusé laisse la stack intacte.

### Suivi des processus et logs

`stack` mémorise le PID de chaque service qu'il lance (dans `<tmpdir>/stack-llm`) et le suit quoi qu'il exécute ensuite (un script `start.sh` qui fait `exec python ...` reste suivi). `stop` envoie le signal à tout le groupe de processus, donc les enfants d'un script ne restent pas orphelins.

La sortie standard et d'erreur de chaque service est écrite dans `~/.local/state/llm-stack/logs/<name>.log` (ou `$XDG_STATE_HOME`), le run précédent est conservé en `<name>.log.1`. Si un service meurt pendant le démarrage, `stack start` affiche son code de sortie et les dernières lignes du log.

## Usage CLI

```sh
stack list                  # liste les services (* = actif)
stack list-json             # idem, en JSON
stack status                # tableau : état, PID, VRAM, health de chaque service
stack status <name>         # inactive | starting | ready
stack start <name...>       # démarre un ou plusieurs services, dans l'ordre (attend le health check si configuré)
stack run <name...>         # alias de start
stack start <name...> --no-wait
stack restart <name...>     # stop puis start
stack stop                  # arrête tous les services actifs
stack stop <name...>        # arrête un ou plusieurs services
stack logs <name>           # dernières lignes du log (-n 100, --follow / -F)
stack validate              # vérifie la configuration (y compris les clés obsolètes)
```

## Usage en librairie

```ts
import { Stack } from 'llm-stack-ts';
// ou, depuis un autre projet du dossier : import { Stack } from '../llm-stack-ts/src';

const stack = new Stack(); // résout stack.json comme le CLI (option file, $LLM_STACK_CONFIG, ./stack.json)

// Liste
console.log(stack.listSummary());

// Démarrer et attendre le health check (comportement par défaut)
await stack.start('llm_main');
console.log(await stack.status('llm_main')); // "ready"
console.log(stack.pid('llm_main'), stack.logFile('llm_main'));
stack.stop('llm_main');
stack.stopAll(); // arrête tous les services actifs

// Démarrer sans attendre
await stack.start('llm_main', { noWait: true });
while ((await stack.status('llm_main')) !== 'ready') {
  await Bun.sleep(2000);
}

// Changer de modèle (démarrer un service exclusive arrête les autres)
await stack.start('llm_main');
await stack.start('llm_flash'); // arrête llm_main, démarre llm_flash
```

Pour l'utiliser depuis un autre projet du dossier `/data/projects/` sans publier sur npm :

```json
{
  "dependencies": {
    "llm-stack-ts": "file:../llm-stack-ts"
  }
}
```

## License

MIT
