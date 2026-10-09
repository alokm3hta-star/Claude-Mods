# Claude Mods

A collection of mods for Claude Code. Each mod lives in its own folder under `mods/`, and the
marketplace file at `.claude-plugin/marketplace.json` lists them all, so this one repository
installs any of them.

## Mods

<!-- mods:start -->
| Mod | What it does |
| --- | --- |
| [context-bar](mods/context-bar) | Context fill as a bar above the prompt, with prompt-cache hit rate and whether the cache is still warm |
<!-- mods:end -->

## Install a mod

Type this at the prompt of a Claude Code terminal session, replacing `<mod>` with a name from the table:

```
/plugin install <mod> --marketplace alokm3hta-star/Claude-Mods
```

Answer `y` to add the marketplace, then press Enter to pick the user scope.

## Add a new mod

1. Put the mod in `mods/<mod-name>/`, with `.claude-plugin/plugin.json`, `hooks/hooks.json` and `hooks/register.tsx`. The folder name must match the `name` in `plugin.json`.
2. Commit it. The pre-commit hook runs `scripts/sync_mods.py`, which rebuilds the mod table above and the list in `.claude-plugin/marketplace.json` from each mod's `plugin.json`.

After a fresh clone, turn the hook on once:

```
git config core.hooksPath .githooks
```

To check a mod before committing, run `claude plugin validate mods/<mod-name>`.
