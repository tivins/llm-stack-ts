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
cp stack-example.toml stack.toml
```

Définissez `LLM_STACK_CONFIG` ou passez `-f /chemin/vers/stack.toml` pour utiliser un fichier différent. Sinon `stack` cherche `./stack.toml` puis `./stack.json`. Ces deux fichiers sont gitignorés pour que vos commandes et chemins locaux restent privés. Mettez `#:schema /chemin/vers/llm-stack-ts/stack.schema.json` en première ligne pour avoir l'autocomplétion (Taplo / Even Better TOML).

```toml
vram_capacity_gb = 16

[vars]
models = "/data/models"

# Réglages communs aux gros modèles. Un launcher `abstract` ne se démarre pas, il sert de parent.
[launchers._llama]
abstract = true
kind = "llama-server"
command = "/home/linuxbrew/.linuxbrew/bin/llama-server"
vram_gb = 14
args = { flash-attn = "on", parallel = 1 }

[launchers.gemma]
extends = "_llama"
args = { model = "${models}/gemma-4-26B.gguf", ctx-size = 16384, reasoning-budget = 6144 }

# Une variante ne déclare que ce qui change ; `clé = false` retire un flag hérité.
[launchers.gemma_32k]
extends = "gemma"
args = { ctx-size = 32768, reasoning-budget = false }

[launchers.comfyui]
command = "/data/softwares/comfyui/venv/bin/python main.py --port ${port}"
cwd = "/data/softwares/comfyui/ComfyUI"
port = 8188
vram_gb = 14
health = { url = "http://127.0.0.1:${port}/system_stats" }
```

`stack show gemma_32k` affiche la commande finale, une fois l'héritage et les variables résolus.

### Clés

| Clé | Défaut | Rôle |
|---|---|---|
| `vram_capacity_gb` | aucun contrôle | VRAM totale disponible pour les services `gpu` |
| `vars` | — | Variables utilisables en `${nom}`. Une variable peut utiliser celles définies avant elle |
| `[launchers.<nom>]` | — | Un service. Le nom accepte lettres, chiffres, `.`, `_` et `-` |
| `extends` | — | Hérite de tout ce que déclare un autre launcher (voir plus bas) |
| `abstract` | `false` | Sert uniquement de parent : n'apparaît pas dans `list` et ne se démarre pas. Non hérité |
| `kind` | `command` | `llama-server` : voir plus bas |
| `command` | requis (sauf `llama-server`) | Commande lancée via `bash -c "exec <command> <args>"` |
| `args` | — | Options ajoutées à `command` (voir plus bas) |
| `port`, `host` | — | Disponibles en `${port}` et `${host}`. Pour `llama-server`, ils deviennent `--port` et `--host` |
| `description`, `type` | `""` | Libellés libres |
| `cwd` | dossier courant | Dossier de travail (`~` accepté) |
| `env` | — | Variables d'environnement ajoutées |
| `vram_gb` | `0` | VRAM réservée, comptée seulement si `gpu` |
| `gpu` | `true` | Compte `vram_gb` dans le budget VRAM |
| `exclusive` | valeur de `gpu` | Démarrer ce service arrête les autres services `exclusive` |
| `process_match` | égalité stricte avec la commande | Sous-chaîne de la ligne de commande pour retrouver un processus lancé hors de `stack` |
| `stop_timeout_seconds` | `10` | Délai entre SIGTERM et SIGKILL |
| `health.url` | — | URL interrogée jusqu'à obtenir une réponse |
| `health.expected_status` | tout 2xx | Code HTTP exact attendu |
| `health.timeout_seconds` | `300` | Délai maximum de démarrage |
| `health.interval_ms` | `1000` | Intervalle entre deux essais |

Une clé inconnue (faute de frappe) ou une variable `${...}` inconnue déclenche un avertissement. Dans `command`, une variable inconnue est laissée telle quelle pour que bash la développe (`${HOME}`).

### `args`

Chaque entrée devient une option de la ligne de commande :

| TOML | Ligne de commande |
|---|---|
| `ctx-size = 16384` | `--ctx-size 16384` |
| `m = "x.gguf"` (une lettre) | `-m x.gguf` |
| `"-fa" = "on"` (clé qui commence par `-`) | `-fa on` |
| `embedding = true` | `--embedding` |
| `reasoning-budget = false` | rien (retire un flag hérité) |
| `lora = ["a.gguf", "b.gguf"]` | `--lora a.gguf --lora b.gguf` |

Les valeurs sont échappées pour le shell, et un `~/` en tête de valeur est développé. Les arguments positionnels restent dans `command`.

### `extends`

Un launcher hérite de tout ce que déclare son parent (qui peut lui-même hériter d'un autre). `args`, `env` et `health` sont fusionnés clé par clé ; les autres clés remplacent la valeur héritée. `name` et `abstract` ne sont pas hérités.

### `kind = "llama-server"`

- `command` vaut `llama-server` par défaut (cherché dans le `PATH`) ;
- `--host` (défaut `127.0.0.1`) et `--port` (défaut `8080`) sont ajoutés à partir de `host` et `port` ;
- `health.url` vaut `http://<host>:<port>/health` par défaut. Les autres clés de `health` restent configurables ;
- les formes courtes des options sont converties en formes longues (`m` → `model`, `c` → `ctx-size`, `fa` → `flash-attn`, `np` → `parallel`, `ngl` → `n-gpu-layers`, `ctk`/`ctv` → `cache-type-k`/`cache-type-v`, `mm` → `mmproj`...). Une variante peut donc écrire `ctx-size` pour remplacer un `c` hérité.

### Migration depuis `stack.json`

```sh
stack -f /chemin/vers/stack.json migrate   # écrit /chemin/vers/stack.toml
```

`migrate` découpe les commandes `llama-server` en `args`, extrait le binaire et le dossier des modèles dans `vars`, regroupe dans un parent `abstract` ce que partagent tous les modèles qui écoutent sur le même port, et transforme les launchers qui utilisent le même modèle en variantes du premier. Le résultat est rechargé et comparé à l'original, launcher par launcher. Si un seul diffère, rien n'est écrit. `-o fichier` choisit la sortie (`-o -` pour stdout) et `--force` écrase un fichier existant. Pensez ensuite à faire pointer `LLM_STACK_CONFIG` vers le nouveau fichier.

Le format JSON reste accepté, que les launchers soient écrits en tableau (avec `name`) ou en objet indexé par nom, avec `extends`, `kind` et `args`. Les anciennes clés restent acceptées aussi : `vram_capacity_in_gigabytes`, `minimal_video_ram_usage_in_gigabytes` et `allow_full_cpu` (`true` équivaut à `gpu: false, exclusive: false`, `false` à `gpu: true, exclusive: true`). `stack validate` les signale.

### GPU et exclusivité

- Un service **`exclusive`** arrête les autres services `exclusive` en cours avant de démarrer (typiquement : les gros modèles, ComfyUI).
- Un service **`gpu`** non exclusif (un petit reranker, par exemple) cohabite avec les autres tant que la somme des `vram_gb` actifs tient dans `vram_capacity_gb`.
- Le budget est vérifié **avant** d'arrêter quoi que ce soit : un démarrage refusé laisse la stack intacte.

### Suivi des processus et logs

`stack` mémorise le PID de chaque service qu'il lance (dans `<tmpdir>/stack-llm`) et le suit quoi qu'il exécute ensuite (un script `start.sh` qui fait `exec python ...` reste suivi). `stop` envoie le signal à tout le groupe de processus, donc les enfants d'un script ne restent pas orphelins.

La sortie standard et d'erreur de chaque service est écrite dans `~/.local/state/llm-stack/logs/<name>.log` (ou `$XDG_STATE_HOME`), le run précédent est conservé en `<name>.log.1`. Si un service meurt pendant le démarrage, `stack start` affiche son code de sortie et les dernières lignes du log.

## Usage CLI

```sh
stack list                  # liste les services par type (* = actif), voir ci-dessous
stack list -q               # noms seuls, un par ligne (scripts, complétion)
stack list-json             # idem, en JSON (avec extends, model, ctxSize, reasoningBudget, port)
stack status                # tableau : état, PID, VRAM, health de chaque service
stack status <name>         # inactive | starting | ready
stack start <name...>       # démarre un ou plusieurs services, dans l'ordre (attend le health check si configuré)
stack run <name...>         # alias de start
stack start <name...> --no-wait
stack start <name> --arg ctx-size=65536 --arg reasoning-budget=false   # essai ponctuel, sans modifier la config
stack restart <name...>     # stop puis start (accepte aussi --arg)
stack show [name...]        # commande finale et réglages, après héritage et variables (accepte --arg)
stack stop                  # arrête tous les services actifs
stack stop <name...>        # arrête un ou plusieurs services
stack logs <name>           # dernières lignes du log (-n 100, --follow / -F)
stack validate              # vérifie la configuration : clés obsolètes, fichiers de modèles et chemins absents
stack migrate               # convertit stack.json en stack.toml (-o fichier, --force)
```

`stack list` regroupe les services par `type` et place chaque variante sous son parent. La colonne MODEL reste vide quand la variante utilise le modèle de son parent. CTX (`ctx-size`) et REASON (`reasoning-budget`) sont côte à côte pour comparer d'un coup d'œil la place laissée au raisonnement : `-` signifie non défini (illimité pour llama-server), `∞` correspond à `-1`. DETAILS n'affiche que les autres `args` déclarés par le launcher lui-même (`-clé` pour un flag retiré). Le nom n'a donc pas besoin de redire le modèle ou le contexte :

```
  NAME             MODEL                              CTX  REASON  PORT   VRAM  DETAILS
text-generation
  gemma            google_gemma-4-26B-A4B-it-IQ4_NL   16k      6k  8080   14GB  models-max=1
* └ gemma-32k                                         32k      4k  8080   14GB  long context
image
  comfyui          -                                    -       -  8188   14GB  python main.py
```

Pour un `stack.json` à l'ancien format (toute la commande dans `command`), ces colonnes sont relues dans la commande `llama-server`.

Dans un terminal, la dernière colonne est coupée à la largeur de la fenêtre et l'actif est en couleur (désactivable avec `NO_COLOR=1`).

## Usage en librairie

```ts
import { Stack } from 'llm-stack-ts';
// ou, depuis un autre projet du dossier : import { Stack } from '../llm-stack-ts/src';

const stack = new Stack(); // résout la config comme le CLI (option file, $LLM_STACK_CONFIG, ./stack.toml, ./stack.json)

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

// Surcharger des args (équivalent de --arg)
const big = new Stack({ argOverrides: { llm_main: { 'ctx-size': 65536 } } });

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
