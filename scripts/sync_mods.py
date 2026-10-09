#!/usr/bin/env python3
"""Rebuild the mod list in .claude-plugin/marketplace.json and README.md from mods/*/.

Each mod's own .claude-plugin/plugin.json is the source of truth: its name and
description. Run it by hand, or let the pre-commit hook run it on every commit.
"""
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
MARKETPLACE = ROOT / ".claude-plugin" / "marketplace.json"
README = ROOT / "README.md"
START, END = "<!-- mods:start -->", "<!-- mods:end -->"


def read_mods():
    mods = []
    for manifest in sorted(ROOT.glob("mods/*/.claude-plugin/plugin.json")):
        folder = manifest.parent.parent
        data = json.loads(manifest.read_text())
        if data.get("name") != folder.name:
            raise SystemExit(f"{folder.name}: plugin.json name is {data.get('name')!r}; it must match the folder name")
        mods.append({"name": data["name"], "description": data.get("description", ""), "folder": folder.name})
    return mods


def write_marketplace(mods):
    market = json.loads(MARKETPLACE.read_text())
    market["plugins"] = [
        {"name": m["name"], "source": f"./mods/{m['folder']}", "description": m["description"]} for m in mods
    ]
    MARKETPLACE.write_text(json.dumps(market, indent=2) + "\n")


def write_readme(mods):
    rows = ["| Mod | What it does |", "| --- | --- |"]
    rows += [f"| [{m['name']}](mods/{m['folder']}) | {m['description']} |" for m in mods]
    block = f"{START}\n" + "\n".join(rows) + f"\n{END}"
    text = README.read_text()
    if START not in text or END not in text:
        raise SystemExit(f"README.md is missing the {START} / {END} markers")
    README.write_text(re.sub(re.escape(START) + ".*?" + re.escape(END), lambda _: block, text, flags=re.S))


if __name__ == "__main__":
    mods = read_mods()
    write_marketplace(mods)
    write_readme(mods)
    print(f"synced {len(mods)} mod(s): {', '.join(m['name'] for m in mods)}")
