# Changelog

## 0.3.0 - 2026-09-29

- `stack run` est un alias de `stack start` (mêmes arguments, y compris `--no-wait`).

## 0.2.0 - 2026-09-29

- `stack stop` sans nom arrête tous les modèles actifs. `stack stop <name...>` conserve le comportement précédent.
- `Stack.stopAll()` expose le même comportement côté librairie.
