# client-mask 0.18.0: on-device model layer (plan)

Written 2026-11-24. Hard rule from the owner: **no part of any PII may reach the LLM**. Masking may be one way; nothing
needs turning back. Every detection layer therefore sits in the blocking path and fails closed.

## 1. What exists today (0.17.1)

| Layer | Where | Nature |
|---|---|---|
| List (`terms`) | `mask.ts` `Masker.mask` | exact names to your placeholders, sync |
| Detectors | `detect.ts` | regex with checksums (email, UK phone, NI, IBAN, card, VAT, secrets), sync, labels `‹NAME›` |
| Leak guard | `turn.step` | rescans new messages with list + detectors, blocks the request |
| Doors masked | `prompt.submit`, `session.append` (every row, every door), `prompt.compose`, `prompt.context`, `prompt.attachment`, `skill.prompt`, `tool.describe`, `session.send`, streamed tool arguments (`maskToolArgs`), saved transcripts at close (`scrub`) | |
| Disk | `maskFileInPlace`, `/client-mask-folder`, `overwriteLoses` | list + detectors only |

Gaps the model closes: any person, company, address, ID, username, date of birth or secret **not on the list and not
matching a regex**.

## 2. Measured facts this plan rests on (spike, 2026-11-24)

- Engine: newmean-pii freestanding WebAssembly (no imports) runs under `$.wasm.compile`; logits equal Node's exactly.
- Speed in the mod runtime: about 1,450 tokens/s (medium, SIMD build). Load: about 0.25 s.
- `$.fs.read` refuses more than 4 MiB: the 11.3 MB model is read in ranges.
- Mods cannot use `import()` or npm packages: the pipeline is vendored with static imports (Apache-2.0, NOTICE kept).
- Quality (English, medium): PERSON strong; ORG weak (1 of 3 planted companies). SAP words (HANA, Joule) and code
  identifiers are tagged as PERSON without a filter.
- The mod's own guard refuses any tool call naming the list's private folder, so model files live in a folder of
  their own (3.7).

## 3. Design

### 3.1 One async mask function

`maskText(text) → { text, status }`, status `ok | withheld`:

1. `s1 = masker.mask(text)`: list, then detectors (unchanged, sync).
2. Model pass on `s1`: spans for the enabled labels. Spans inside or overlapping a placeholder or `‹LABEL›` are clipped
   to the text outside it, so nothing already masked is touched.
3. Allow filter (drops a span only when **every** word of it is in the allow vocabulary; see 3.5). Nothing else is
   dropped: no all-caps rule, no code skipping.
4. Replace each span with `‹FAMILY›` (`PERSON_L2` → `‹PERSON›`, `URL_L2` → `‹URL›`). Same label style as the
   detectors, so the existing `writesLabel` guard, counters and band work unchanged.
5. Fixpoint: repeat 2 to 4 on the output until nothing changes (at most 3 passes), so masking its own output is a
   no-op. This keeps the coverage check (3.3) from tripping on text the mod already masked.
6. Cache: keyed by a salted SHA-256 of the input (salt random per install, kept in `$.store`), value the output; and a
   set of output hashes known clean. In memory per session (LRU, 4,000 entries), so unchanged text is never re-run.

The sync `Masker.mask` stays for disk work and tests. Model tags are **never written to disk**.

### 3.2 Doors (all awaited, all fail closed)

| Door | Change |
|---|---|
| `prompt.submit` | `maskText` on text and context; withheld or model down → message refused with a toast |
| `session.append` (every door: prompt, tool-result, tool-message, delivery, attachment, hook-context, note, compaction, notice, queue) | `maskContent` becomes async; a withheld block is replaced by `‹WITHHELD›` with a short reason (the row still lands, the model never sees the text) |
| `prompt.compose`, `prompt.context`, `prompt.attachment`, `skill.prompt`, `tool.describe`, `session.send` | `maskText`; withheld → the text is replaced by the withheld note |
| `turn.step` streamed tool arguments | `maskToolArgs` flush becomes async and runs `maskText` per string value |
| Saved transcripts at close (`scrub`) | async, with the model, so reopening repairs any row a block was caught on |
| Disk (`maskFileInPlace`, folder, overwrite guard) | unchanged: list + detectors only |

### 3.3 Coverage check (turn.step, before every request)

For every scannable piece added since the last request: if its hash is a known clean output, pass; otherwise run
`maskText` on it now. Unchanged → record clean, pass. Changed → the piece holds unmasked PII: block the request,
naming only label families and counts. This replaces "we masked at the door" with "every piece was provably scanned".

### 3.4 Fail closed

- `model.enabled` and the model cannot load (missing file, SHA-256 mismatch, compile error) → state `broken` with the
  reason; every prompt refused, every request blocked, band shows it. The model loads at `session.start` in the
  background; a door that needs it awaits the same promise.
- A text over `model.maxTokens` (default 40,000), or a scan past `model.timeoutMs` (default 60,000; checked between
  256-token windows) → withheld (3.2).
- Engine exception → withheld, never passed through.
- Masking paused by you (band) or `enabled: false` → nothing masked: your explicit choice, as today.

### 3.5 Allow vocabulary

A word list the filter may skip, case-insensitive: a curated starter list of SAP product and technology names shipped
in the mod (no person names), plus your list's `keep`, `keepAsIs` and a new `model.allow`. A span is dropped only if
all its words are in it, so "Priya HANA" is still masked.

### 3.6 Settings (list file)

```json
"model": {
  "enabled": true,
  "size": "medium",
  "labels": ["PERSON", "PERSON_L2", "ORG", "ADDRESS", "ID_NUMBER", "FINANCIAL", "USERNAME", "DATE_OF_BIRTH", "SECRET", "EMAIL", "PHONE", "URL", "URL_L2"],
  "sensitivity": 0,
  "maxTokens": 40000,
  "timeoutMs": 60000,
  "allow": []
}
```

`validate` checks each field and reports by name only. `listfile.ts` `SETTINGS` gains `model`, or `/client-mask-tidy`
would drop it. `sensitivity` default is set by calibration (5.5).

### 3.7 Model files

`~/.claude/client-mask-models/<size>-1.1.0/` (`model_q4e.onnx`, `tokenizer.web.json`), outside the list's private
folder so they can be installed and checked. Hashes pinned in `pii/models.ts` and checked on every load, so a changed
file is refused. `/client-mask-model` shows status and the two download commands; the mod never touches the network.

## 4. Files

| File | Change |
|---|---|
| `hooks/pii/` (new) | vendored from newmean-ai/pii 4b63a4c (Apache-2.0): `tokenizer.ts`, `decode.ts`, `word_tables.ts`, `words.ts` (word widening and grapheme snap cut from `table.ts`), `emoji.ts`, `pictographic.ts`, `onnx-weights.ts`, `models.ts`; new `engine.ts` (`$.wasm.compile`, deadline between windows) and `detector.ts` (detect only: no regex, no table mode, no onnxruntime, no fetch); `pii-simd.wasm`; `LICENSE`, `NOTICE`, `VENDORED.md` (source commit and what was cut) |
| `hooks/model.ts` (new) | loader (ranged read, SHA-256, compile, warm), `ModelLayer` with queue, cache, fixpoint, allow filter; an interface so tests inject a fake |
| `hooks/allow-vocab.ts` (new) | starter SAP vocabulary |
| `hooks/mask.ts` | `maskContentAsync`, `maskArgsJsonAsync`, `mapStringsAsync`; `validate` for `model`; types |
| `hooks/detect.ts` | secrets `key = "value"` rule: lookbehind so a match starts at a word start (1,729 ms → 0.6 ms on 32k characters) |
| `hooks/register.tsx` | doors async, coverage check, model state in band and status, `/client-mask-model` |
| `hooks/scrub.ts` | async variant |
| `hooks/listfile.ts` | `model` in `SETTINGS` |
| `types/index.d.ts` | `MaskStatus` gains `model: 'off' \| 'loading' \| 'on' \| 'broken'` |
| `.claude-plugin/plugin.json` | 0.18.0 |

## 5. Tests and checks

1. Existing 76 tests pass unchanged.
2. New unit tests (fake model, no files): ordering (list before model), placeholders and labels never re-masked,
   allow filter needs every word, fixpoint, cache hit, withheld on size and on timeout, broken model refuses prompts
   and blocks requests, coverage check blocks an unscanned piece with PII and passes a clean one, tool argument
   masking, `validate` messages, tidy keeps `model`.
3. Speed regression test: 32,000 adversarial characters through the detectors under 100 ms.
4. Runtime parity: in the mod runtime, vendored spans equal the npm package's spans on a fixed corpus (Node writes the
   reference; a check mod compares).
5. Calibration: planted set plus the wiki sample at sensitivity 0, 0.5, 1; pick the highest that keeps over-masking
   tolerable; record numbers.
6. `claude plugin validate` clean of errors; type-check.
7. Live check after `/reload-plugins`: the band reports the model on; a prompt carrying a made-up name arrives masked.

## 6. Rollout

Back up 0.17.1 to `~/.claude/backups/client-mask-0.17.1-2026-11-24/` first (the folder is not under git). The model is
off unless the list file turns it on. The list file is yours to edit (`/client-mask-edit`): Claude cannot open it, so
turning the model on is your one step. Rollback: copy the backup back and `/reload-plugins`.

## 7. Known limits (stated, not hidden)

- No detector finds everything: the medium model misses 2 to 8% of PII characters on English benchmarks. The list
  remains the only exact guarantee for client names; use `/client-mask-suggest` (next release) to grow it.
- Cost: about 3.5 s per 5k-token tool result, once (cached). A 20k-token file read takes about 14 s.
- Over-masking in code and SAP identifiers is accepted in favour of no leaks; the allow vocabulary is the release valve.
- Pictures and PDFs stay refused, as today.
- `large` (15.5 MB, fewer misses) needs one more download, with your approval; `size` makes it a one-line switch.

## 8. Next release (not in 0.18.0)

`/client-mask-suggest [folder]`: model plus a company-suffix rule, results in a screen-only pane with Add and Ignore.

## 9. As built (2026-11-24), where it differs from the plan above

- **Hook time budget.** A hook has 10 s of its own time per call and is skipped (its text passing unmasked) when it runs
  past it. So each call scans inside the mod only while an estimate fits a 6.5 s deadline (4 s for the check before each
  request, 0.4 s per tool call's arguments); anything longer goes to `hooks/pii/helper.mjs`, the same detector in a local
  Node process via `$.process.run`, whose waiting does not count. Without Node, such texts are withheld.
- **Limits.** `maxTokens` 100,000 and `timeoutMs` 180,000 (helper); above them a text is withheld, never sent unscanned.
- **Fail closed everywhere.** Every hook that carries text has a `.catch`: prompt refused; row, send or tool argument
  replaced by the `‹WITHHELD›` note; system prompt, context, attachment, skill and tool description keep only text
  already known clean; the request check stops the request.
- **On by default.** `"model": {"enabled": false}` switches it off; your list needs no change to have it on.
- **Sensitivity 0.5** after calibration (19 planted items: 15 found at 0, 16 at 0.5 and 1; 50, 52 and 57 masks on 75,000
  characters of wiki text).
- **Company rule.** Capitalised words ending in a company word (Ltd, plc, Utilities, Insurance…) are masked as `‹ORG›`
  with the model: 18 of 19 planted items found; the miss is a bare company name, which only your list can catch.
- **Cache.** Clean texts known by salted SHA-256, kept across sessions (5,000 newest), reset whenever the list changes.
- **Allow vocabulary.** Products and technical words only, nothing under three letters (initials).
- **Saved transcripts.** The clean-up at close stays list and detectors only: rows are stored masked by the model
  already, and the check before each request scans anything it has not seen.
- **Tests.** 95 pass (76 from 0.17.1, 19 new): model layer with a fake model, budget and helper routing, withheld
  paths, cache, settings, company rule, detector speed, and the engine refusing to send while the model is missing.

## 10. After the first live run (2026-11-24)

The model over-masked random folder names, the project folder name and agent names, and the label guard then refused
Claude's own commands and edits. Changes: tool-call arguments are masked by the list and detectors only (what comes
back still goes through the model); the model's SECRET kind is off by default (the detectors find secrets precisely);
model IDs and user names inside a file path, and hex machine IDs, are left alone (all-digit IDs are still masked);
words of the home and project folder paths are allowed. 97 tests pass.

## 11. 0.18.1: masking you switch on stays on (2026-11-24)

Sessions still start with masking off; you switch it on from the band. Your press is now kept per session in the
store as well as in the session's state, so when the session's state comes back empty (a plugin having the context
re-read) masking stays as you set it, instead of falling back to off. If masking ever goes off without a press on the
band, a toast says so at once. Also in 0.18.1: git short hashes count as machine IDs; the wiki's agent names are
allowed words (owner's decision). 103 tests pass.

## 12. 0.18.2: the band never goes silent (2026-11-24)

The band could lag a press by seconds: the in-process model held the mod's one worker for a whole scan (its
"turn between windows" was a resolved promise, which runs before any queued press or redraw), and the press waited
on store writes before redrawing. Now the engine hands the worker back between 256-token windows through a `$` call
(`$.clock.sleep(1)`), so a press and its redraw run mid-scan; a press shows "⏳ Switching masking on/off…" at once,
then settles; while the model loads, the band shows "⏳ Masking starting" with the step (reading the model files,
checking them, starting the model) and "nothing is sent until the lock shows"; the 🔒 shows only once the model is
ready; while a scan runs, the lock row reads "scanning…". 105 tests pass. Not yet checked live: how long a press
takes mid-scan, and whether the pauses slow a long scan (each is one host round trip per 256 tokens).

## 13. 0.18.3: fewer false positives in document work (2026-11-24)

A session editing a tooling document and checking vendor claims on the web lost its section numbers, product names
and every source address to the model, the label guard then refused its edit scripts, and three subagents stopped
with no report. Probed with the real model (medium v1.1.0) on made-up texts; causes and changes:
- **Subagents stopped at once.** The Agent call's brief is masked by the list and detectors only (section 10), but it
  comes back as a user message in the subagent's loop, where the check before each request ran the model on it and
  counted whatever the model re-masked as a leak. Now every tool-call argument of 200 characters or more is marked
  clean by its salted hash once masked, so the brief passes; it is the model's own text.
- **Local writers keep their digits.** Write, Edit, MultiEdit, NotebookEdit and Bash arguments are masked by the list
  only: the phone rule read `0123456789` in a Python command as a phone number and the guard refused the mod's own
  label. Tools that send their arguments elsewhere (WebSearch, WebFetch, Agent, MCP) keep the detectors. The phone rule
  also no longer matches a run that counts up or down or repeats one digit.
- **Structural numbers.** An ID or phone span the model finds loses any line-number prefix (`2041→`, `2041\t`,
  `2041:`, `path:2041:`), and a dotted section or version number (3.1.2.2.4, 2026.11.3) or a counting run is left. A
  number after such a prefix (a staff number) is still masked.
- **Products.** Test and operations tools (Xray, Tosca, Tricentis, NeoLoad, LoadRunner, Puppet, Ansible, Selenium…)
  are allowed words; joining words (and, of, the…) no longer keep an otherwise allowed span masked ("Priya and Tosca"
  is still masked). Sensitivity was not the cause: Tosca, NeoLoad and Tricentis were masked at 0.5, 0 and -0.5.
- **Web addresses, whole.** The model tags an address in pieces, and masking some pieces let the rest through. Now an
  address is one unit: left whole when its host is, or is under, a public documentation domain (`ALLOW_DOMAINS` in
  allow-vocab.ts, plus the list's new `"model": {"allowDomains": [...]}`) and it carries no @, no personal query field
  (user=, email=, id=…) and no profile path (/user/, /profile/, /in/…), and no name the model found inside it;
  otherwise masked whole as ‹URL›. Tenant domains (a company's atlassian.net, sharepoint.com) are not on the list.
Real-data controls in the probe (a person, a company, a phone number, an email, a staff number, a profile address, a
tenant address) all stay masked. 111 tests pass (6 new). Not checked live yet: a subagent run with the model on.

