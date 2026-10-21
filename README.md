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
vram_capacity_gb = 15   # carte de 16 Go, voir « Bail GPU »

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
| `vram_capacity_gb` | aucun contrôle | VRAM que les services `gpu` peuvent utiliser : la capacité de la carte moins une marge (voir « Bail GPU ») |
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
- Un `llama-server` en `gpu = false` met quand même ses couches sur le GPU si `n-gpu-layers` n'est pas à `0` (réglage par défaut de llama.cpp), et cette VRAM n'est comptée nulle part. `stack validate` et `stack list` le signalent : mettez `n-gpu-layers = 0` pour rester sur le CPU, ou `gpu = true`, `exclusive = false` et son `vram_gb` pour le compter.

### Bail GPU

Plusieurs clients peuvent piloter la stack en même temps : le CLI, et des projets qui importent `Stack` (un éditeur de workflows, des scripts de génération...). Le **bail GPU** évite que l'un arrête le service qu'un autre est en train d'utiliser :

- Un seul client tient le GPU à la fois. Les autres attendent leur tour dans une file (voir « File de jobs »), et le CLI affiche qui tient le GPU : `GPU held by flow_editor: run 42 (pid 1234) for 3m12s, waiting...`.
- Démarrer ou arrêter un service `gpu` ou `exclusive` prend le bail le temps de l'opération, puis le rend. Pour garder un service le temps de s'en servir (démarrer ComfyUI, générer, passer au LLM), le client tient le bail plus longtemps avec `withLease` (voir « Usage en librairie »).
- Un service déjà actif ne demande pas de bail pour `start`. Les services CPU (`gpu = false`, non `exclusive`) non plus.
- `--force` (CLI) ou `{ force: true }` (librairie) passe outre, comme avant le bail.
- Pas de démon : le bail repose sur des fichiers à côté des PID (`<tmpdir>/stack-llm/gpu/`). Un client qui meurt perd sa place, son bail ne bloque personne. Un client bloqué mais vivant, si : `stack gpu release --force` casse son bail (il n'est pas prévenu et continue comme s'il le tenait).

### File de jobs

Chaque demande de bail est un job de la file, avec une **priorité** : `0` pour l'interactif (le chat), `1` pour ce que l'utilisateur vient de demander (une image ; c'est la valeur par défaut, y compris pour le CLI), `2` pour les tâches de fond. Le GPU revient :

1. à la priorité la plus haute, sans interrompre le job en cours : un message de chat attend la fin d'une image déjà lancée ;
2. à priorité égale, aux jobs qui veulent le **launcher déjà chargé** (`launcher`), même arrivés après, pour ne recharger un modèle qu'une fois. Ce regroupement s'arrête après `max_batch` jobs d'affilée (8), ou dès qu'un job pour un autre launcher attend depuis `switch_after_seconds` (2 min) ;
3. puis dans l'ordre d'arrivée.

Un job de priorité 2 attend en plus que le GPU soit **calme** : `idle_seconds` (60 s) sans job de priorité 0 ou 1, ni appel à `touch()` (l'application signale par exemple que l'utilisateur tape). Il ne passe jamais devant un job de priorité 0 ou 1, même un qui attend.

```toml
gpu_queue = { idle_seconds = 60, switch_after_seconds = 120, max_batch = 8 }
```

`stack gpu` affiche la file dans l'ordre où les jobs passeront, avec leur priorité, leur launcher, ce qu'ils attendent et leur id ; `stack gpu cancel <id>` retire un job qui attend (son attente échoue avec `GpuLeaseLostError`).

Comme le bail, la file n'a pas de démon : chaque client relit les tickets du dossier et calcule le même ordre. Elle ne vit que tant que les clients attendent : un job dont le processus meurt est retiré, et ce qu'il avait démarré reste actif. C'est à l'application de garder ses jobs (une table en base, par exemple) et de les redéposer après un redémarrage.

Le bail ne coordonne que les clients de la stack. Le bureau (Xorg), le navigateur et les autres programmes prennent de la VRAM sans demander : environ 0,6 Go sur une carte de 16 Go avec un bureau et Firefox ouverts, davantage avec une vidéo ou du WebGL. Réglez donc `vram_capacity_gb` sous la capacité réelle de la carte (`15` pour 16 Go).

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
stack start <name> --force  # n'attend pas le bail GPU (aussi sur restart et stop)
stack start <name> --priority 0 --max-wait 30   # priorité dans la file, abandon après 30 s (aussi sur restart et stop)
stack gpu                   # qui tient le bail GPU, la file dans l'ordre de passage
stack gpu cancel <id>       # retire un job de la file
stack gpu release --force   # casse le bail d'un client bloqué
stack logs <name>           # dernières lignes du log (-n 100, --follow / -F)
stack validate              # vérifie la configuration : clés obsolètes, fichiers de modèles et chemins absents, llama-server en gpu = false qui utilise le GPU
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
import { ConsoleLogger, Stack } from 'llm-stack-ts';
// ou, depuis un autre projet du dossier : import { Stack } from '../llm-stack-ts/src';

const stack = new Stack(); // résout la config comme le CLI (option file, $LLM_STACK_CONFIG, ./stack.toml, ./stack.json)
// Silencieuse par défaut ; pour afficher la progression comme le CLI :
// const stack = new Stack({ logger: new ConsoleLogger() });

// Liste
console.log(stack.listSummary());

// Démarrer et attendre le health check (comportement par défaut)
await stack.start('llm_main');
console.log(await stack.status('llm_main')); // "ready"
console.log(stack.pid('llm_main'), stack.logFile('llm_main'));
await stack.stop('llm_main'); // rend la main une fois le processus terminé
await stack.stopAll(); // arrête tous les services actifs

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

Garder le GPU le temps d'un travail (voir « Bail GPU ») : aucun autre client ne peut démarrer ou arrêter un service GPU avant la fin de la fonction. Le libellé `holder` est libre, il est affiché aux autres clients qui attendent.

```ts
await stack.withLease({ holder: 'persona_helper: lot mei', signal }, async () => {
  await stack.start('comfyui'); // utilise le bail en cours, n'attend pas
  // ... génération ...
  await stack.start('qwen-vision'); // arrête comfyui (exclusive), toujours sous le même bail
}); // bail rendu ici, même en cas d'erreur ; les services restent actifs

// Bail sur plusieurs appels séparés : on le passe explicitement
const lease = await stack.acquire({ holder: 'flow_editor: exécution 42' });
try {
  await stack.start('comfyui', { lease });
} finally {
  lease.release();
}

console.log(stack.gpu()); // { holder, waiting }
```

Passer par la file (voir « File de jobs ») : `launcher` est démarré sous le bail avant la fonction, `maxWait` abandonne avec `GpuBusyError` (qui porte `status.holder`), et `onWait` dit qui tient le GPU et où en est le job.

```ts
import { GpuBusyError } from 'llm-stack-ts';

// Une réponse du chat : priorité 0, le modèle reste chargé pour les suivantes
await stack.withLease({ holder: 'chat: reply 12', priority: 0, launcher: 'qwen-32k-chat' }, async () => {
  // ... requêtes à llama-server ...
});

// Une tâche de fond : passe après le chat et attend que le GPU soit calme
try {
  await stack.withLease(
    {
      holder: 'chat: summary 7',
      priority: 2,
      launcher: 'qwen-32k-chat',
      maxWait: 10 * 60_000,
      onWait: (holder, me) => console.log(holder?.holder ?? 'GPU busy', me.position, me.reason), // 'turn' | 'priority' | 'batch' | 'idle'
    },
    async () => {
      /* ... */
    },
  );
} catch (err) {
  if (err instanceof GpuBusyError) console.log(`occupé par ${err.status.holder?.holder}, on réessaiera`);
  else throw err;
}

stack.touch(); // l'utilisateur est actif : les jobs de priorité 2 attendent encore idle_seconds
stack.cancel(id); // retire un job qui attend (id donné par stack.gpu().waiting)
```

`start`, `restart` et `stop` acceptent aussi `priority`, `maxWait` et `onWait` pour le bail qu'ils prennent seuls.

`signal` (un `AbortSignal`) interrompt l'attente du bail, et `start` l'accepte aussi : annulé pendant le health check, il arrête le processus qu'il vient de lancer, mais ne touche pas à un service qui tournait déjà. `new Stack({ holder: 'mon_projet' })` préfixe le libellé des baux que `start`/`stop` prennent seuls (`mon_projet: start comfyui` ; par défaut, le nom du script). Si un autre client a cassé le bail (`stack gpu release --force`), les opérations qui l'utilisent échouent avec `GpuLeaseLostError`.

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
