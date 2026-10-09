# Claude Mods

A collection of mods for Claude Code. Each mod lives in its own folder under `mods/`, and the
marketplace file at `.claude-plugin/marketplace.json` lists them all, so this one repository
installs any of them.

## Mods

<!-- mods:start -->
| Mod | What it does |
| --- | --- |
| [client-mask](mods/client-mask) | Mask client names, personal data and secrets before anything leaves this machine; keep the list private and leave no trace of what was swapped |
| [context-bar](mods/context-bar) | Context fill as a bar above the prompt, with prompt-cache hit rate and whether the cache is still warm |
| [control-panel](mods/control-panel) | Click instead of remembering: a panel of each project's own commands and playbooks, what needs you now, a wiki desk for reading proposals and findings, and where you left off. It never changes how your agents work. |
| [git-guard](mods/git-guard) | Keep Claude out of your git history: no co-author trailer, no PR footer, and no push of a commit that carries one |
| [house-style](mods/house-style) | Hold documents Claude writes to your house style: no dashes, British spelling, none of your banned words. It enforces the author's own style: see the note below the table. |
| [released-objects](mods/released-objects) | Flag SAP objects in ABAP code that are not released, deprecated or have no API, with SAP's successor, using SAP's own release lists. It flags, never blocks. |
| [workspace-board](mods/workspace-board) | One board for what is waiting on you across your projects: sessions waiting for an answer or approval, proposals to review, blockers, action items and handoffs, each with a button to jump there or start it. Opened from the Board button on the context bar. |
<!-- mods:end -->

## Before you install

I built these mods for the way I work, so check that each one suits yours. Mods tied to my own projects are kept out of this repository.

**Ready to use anywhere.** context-bar and git-guard work in any project with no setup. client-mask works anywhere once you have run its setup script and added your own client names, as described below.

**Works from your own project files.** control-panel builds its buttons from each project's `CLAUDE.md` and its `.claude/skills/` playbooks. It reads commands listed in a code block under `GROUP:` headings, one per line as `@agent command [argument]` followed by a long dash and what it does, or in table rows that start with a command in backticks. A command with an `[argument]` fills the prompt for you to finish; the rest run on a click. Its wiki tabs (a proposal reader, new pages, and where you left off) appear only in projects with a `wiki/pending/proposals/` folder.

**Opinionated.** house-style holds documents to my own house style: British spelling, no dashes and a list of words I avoid. If your style differs, change the rules in `~/.claude/house-style/rules.json`, or leave this mod out.

## Install a mod

Type this at the prompt of a Claude Code terminal session, replacing `<mod>` with a name from the table:

```
/plugin install <mod> --marketplace alokm3hta-star/Claude-Mods
```

Answer `y` to add the marketplace, then press Enter to pick the user scope.

## Set up client-mask on a new machine

client-mask needs two steps beyond the install line, because some of its protection lives in your Claude Code settings rather than in the mod.

1. Install the mod with the line above, using `client-mask` as the name.
2. From a clone of this repository, run the setup script once. It switches on the safety catch, which refuses any prompt in a session the mod is not protecting, keeps saved conversations for 30 days, and stops file backups, feedback uploads and error reports. Saved conversations and typed history are kept; the mod masks any listed name left in them when a conversation closes. It backs up your settings file first.

   ```
   python3 scripts/setup_client_mask.py
   ```

3. Restart Claude Code, then type `/client-mask-edit` to add your client names. The list lives in `~/.claude/client-mask/` on your machine only and is never part of this repository.

To check what the script would change without changing anything, add `--dry-run`.

## Add a new mod

1. Put the mod in `mods/<mod-name>/`, with `.claude-plugin/plugin.json`, `hooks/hooks.json` and `hooks/register.tsx`. The folder name must match the `name` in `plugin.json`.
2. Commit it. The pre-commit hook runs `scripts/sync_mods.py`, which rebuilds the mod table above and the list in `.claude-plugin/marketplace.json` from each mod's `plugin.json`.

After a fresh clone, turn the hook on once:

```
git config core.hooksPath .githooks
```

To check a mod before committing, run `claude plugin validate mods/<mod-name>`.
