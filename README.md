# llm-stack-ts

CLI + librairie Bun/TS pour démarrer, arrêter et surveiller des services LLM locaux depuis un seul fichier de configuration.

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

Définissez `LLM_STACK_CONFIG` ou passez `-f /chemin/vers/stack.json` pour utiliser un fichier différent. `stack.json` est gitignoré pour que vos commandes/chemins locaux restent privés.

## Usage CLI

```sh
stack list                  # liste les modèles (* = actif)
stack list-json             # idem, en JSON
stack start <name...>       # démarre un ou plusieurs modèles, dans l'ordre (attend le health check si configuré)
stack run <name...>         # alias de start
stack start <name...> --no-wait
stack stop                  # arrête tous les modèles actifs
stack stop <name...>        # arrête un ou plusieurs modèles
stack status <name>         # inactive | starting | ready
```

Chaque launcher déclare son budget VRAM ; l'orchestrateur refuse de démarrer un modèle si la mémoire GPU serait dépassée (et arrête les autres launchers GPU avant de démarrer, sauf `allow_full_cpu`).

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
await stack.stop('llm_main');
stack.stopAll(); // arrête tous les modèles actifs

// Démarrer sans attendre
await stack.start('llm_main', { noWait: true });
while ((await stack.status('llm_main')) !== 'ready') {
  await Bun.sleep(2000);
}

// Changer de modèle (démarrer l'un arrête les autres launchers GPU)
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
