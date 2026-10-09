#!/usr/bin/env python3
"""Safety catch for client-mask, run by Claude Code itself before each prompt.

The client-mask mod marks every session it protects. If this session has no
mark, the mod is not running (it failed to load, was switched off, or Claude
Code changed under it), so the prompt is refused before anything is sent.

To turn masking off on purpose, create the file ~/.claude/client-mask/off.
Set up in ~/.claude/settings.json as a UserPromptSubmit command hook.
"""
import json
import os
import re
import sys

home = os.path.expanduser("~")
folder = os.path.join(home, ".claude", "client-mask")

try:
    session = json.load(sys.stdin).get("session_id", "")
except Exception:
    session = ""

if os.path.exists(os.path.join(folder, "off")):
    sys.exit(0)
if re.fullmatch(r"[A-Za-z0-9-]+", session or "") and os.path.exists(os.path.join(folder, "alive", session)):
    sys.exit(0)

print(json.dumps({
    "decision": "block",
    "reason": (
        "Masking is not running in this session, so this message was not sent. "
        "Restart Claude Code and look for the masking line above the prompt. "
        "To turn masking off on purpose, create the file ~/.claude/client-mask/off."
    ),
    "hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "suppressOriginalPrompt": True},
}))
sys.exit(0)
