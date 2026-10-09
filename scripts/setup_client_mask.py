#!/usr/bin/env python3
"""Set up the client-mask mod's safety settings on this machine.

Install the mod first (/plugin install client-mask --marketplace alokm3hta-star/Claude-Mods),
then run this once from a clone of the repo:

    python3 scripts/setup_client_mask.py            # apply
    python3 scripts/setup_client_mask.py --dry-run  # show what would change

It merges into ~/.claude/settings.json (a backup is written beside it first):
  - a safety catch that refuses any prompt in a session the mod is not protecting
  - no saved conversations or typed history, no file backups before edits
  - no feedback uploads or error reports
  - saved data deleted after 7 days
It never creates or touches your masking list; make that with /client-mask-edit.
"""
import json
import os
import shutil
import sys
import time

HOME = os.path.expanduser("~")
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SETTINGS = os.path.join(HOME, ".claude", "settings.json")
GUARD_SRC = os.path.join(REPO, "mods", "client-mask", "guard", "prompt_guard.py")
GUARD_DEST = os.path.join(HOME, ".claude", "hooks", "client_mask_prompt_guard.py")
MASK_FOLDER = os.path.join(HOME, ".claude", "client-mask")

ENV = {
    "CLAUDE_CODE_SKIP_PROMPT_HISTORY": "1",
    "DISABLE_FEEDBACK_COMMAND": "1",
    "CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY": "1",
    "DISABLE_ERROR_REPORTING": "1",
}

dry = "--dry-run" in sys.argv
settings = json.load(open(SETTINGS)) if os.path.exists(SETTINGS) else {}
changes = []

env = settings.setdefault("env", {})
for key, value in ENV.items():
    if env.get(key) != value:
        env[key] = value
        changes.append(f"set {key}={value}")
if settings.get("fileCheckpointingEnabled") is not False:
    settings["fileCheckpointingEnabled"] = False
    changes.append("turn off file backups before edits")
if settings.get("cleanupPeriodDays") != 7:
    settings["cleanupPeriodDays"] = 7
    changes.append("delete saved data after 7 days")

groups = settings.setdefault("hooks", {}).setdefault("UserPromptSubmit", [])
has_guard = any("prompt_guard" in h.get("command", "") for g in groups for h in g.get("hooks", []))
if not has_guard:
    groups.append({"hooks": [{"type": "command", "command": f"python3 -I {GUARD_DEST}", "timeout": 10}]})
    changes.append("add the safety catch before each prompt")

if not changes:
    print("Already set up; nothing to change.")
    sys.exit(0)
print("Changes:" + "".join(f"\n  - {c}" for c in changes))
if dry:
    print("Dry run: nothing written.")
    sys.exit(0)

if not has_guard:
    os.makedirs(os.path.dirname(GUARD_DEST), exist_ok=True)
    shutil.copy2(GUARD_SRC, GUARD_DEST)
os.makedirs(MASK_FOLDER, mode=0o700, exist_ok=True)
if os.path.exists(SETTINGS):
    shutil.copy2(SETTINGS, f"{SETTINGS}.bak-{time.strftime('%Y%m%d-%H%M%S')}")
os.makedirs(os.path.dirname(SETTINGS), exist_ok=True)
with open(SETTINGS, "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")
print("Done. Restart Claude Code, then add your client names with /client-mask-edit.")
