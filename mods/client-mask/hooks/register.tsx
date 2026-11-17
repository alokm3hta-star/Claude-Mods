import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, Register, TurnStepChunk, TurnStepResult } from 'claude-code'

import { BINARY_FILE, KEEP_AS_IS, Masker, REMOVED, commandPaths, mapStrings, onDiskAllowed, maskArgsJson, maskContent, namesBlockedFolder, namesList, scannable, toolMatches, validate, writesLabel } from './mask'
import type { Config } from './mask'
import { parseList, sameMeaning, tidyList } from './listfile'
import { scrubFile } from './scrub'
import type { MaskStatus } from '../types'

// Your list lives outside every repository, in your home folder, and never in
// chat. Claude is refused any tool call that names its folder.
const DIR = '.claude/client-mask'
const VIEW = 'client-mask-view'
const EDIT = 'client-mask-edit'
const FOLDER = 'client-mask-folder'
const TIDY = 'client-mask-tidy'
const DEFAULT_RESTORE = ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'Grep', 'Glob']
// Tools that change files: a masked label in what they write would overwrite
// the real value, so such a call is refused.
const WRITERS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash']
const TEMPLATE = {
  _how:
    'One row per spelling: {"real": "Acme Bank", "placeholder": "CLIENT_1"}. ' +
    'Rows may share a placeholder; the first row is the spelling it turns back into. ' +
    'For numbers such as an IBAN use {"pattern": "<regular expression>", "placeholder": "IBAN"}; those are never turned back. ' +
    'Any text works as a placeholder; leave it blank ("") to remove the name altogether. ' +
    'Add "onlyWith": ["NBR"] to a row to mask it only when NBR (or any of its spellings) is in the same message or file. ' +
    'Add "toFiles": false to a row to keep its placeholder even in files Claude writes (for people\'s names and IDs). ' +
    'Emails, phone numbers, NI numbers, IBANs, card numbers, VAT numbers and secrets are masked without being listed; ' +
    'switch one off with "detect": {"phone": false}, and list values to leave alone in "keep". ' +
    'List folders of real client data Claude may never open in "blockedFolders". ' +
    'To never turn placeholders back, set "restoreInTools": [] (files and commands) and "showRealNames": false (your screen); ' +
    'a full rewrite of a file that holds real names is then refused, unless "guardOverwrites": false. ' +
    'Or set "maskFilesInPlace": true to mask each text file on disk before Claude reads, edits, greps or runs a command on it ' +
    '(a copy of the original is kept where Claude cannot open it; "keepOriginals": false keeps none; ' +
    'only folders in "maskOnDiskIn", when set, are rewritten, and never those in "keepOnDisk"). /client-mask-folder <folder> masks a whole folder on disk at once, with no model involved.',
  detect: {},
  keep: [],
  blockedFolders: [],
  terms: [],
}

// What the band above the prompt shows: whether masking is on, and how many
// items the last message carried masked. Counts only, never what was masked.
const statusAtom = atom({ plugin: 'client-mask', key: 'status' } as const, null)
const maskedAtom = atom({ plugin: 'client-mask', key: 'masked' } as const, 0)
// This session only: masking switched on or off from the band. Unset (null), a
// session starts off, so masking applies only where you switch it on; the
// list's "startOn": true starts every session on instead.
const pausedAtom = atom({ plugin: 'client-mask', key: 'paused' } as const, null as boolean | null)
// Sessions that had masking on, by id, with when: only their saved copies are
// cleaned. Kept across sessions; entries older than the clean-up window go.
const MASKED_KEY = 'maskedSessions'
// How many messages of each loop (main, or a subagent's id) already went to the
// model in an earlier request. Those are not checked again: resending them tells
// the model nothing new, so switching masking on mid-conversation never stops it.
const sentAtom = atom({ plugin: 'client-mask', key: 'sent' } as const, {} as Record<string, number>)

let masker: Masker | null = null
let markedSession = ''
let config: Config | null = null
// Why the list cannot be used, by row number only. While set, nothing is sent.
let broken: string | null = null
let home = ''
let listPath = ''
let loadedMtime = -1
let checkedAt = 0
let paused = false

const isOn = () => broken === null && masker !== null && config?.enabled !== false && !paused
const mask = (s: string) => (isOn() && masker ? masker.mask(s) : s)

// Masks and counts how many items the text gained, by placeholder or label.
// Kept in memory for this message only, and never names what was masked.
let counted = 0
const swaps = new Map<string, number>()
const countingMask = (s: string) => {
  const out = mask(s)
  if (masker && isOn() && masker.removed > 0) {
    counted += masker.removed
    swaps.set(REMOVED, (swaps.get(REMOVED) ?? 0) + masker.removed)
  }
  if (masker && out !== s) {
    const before = masker.markCounts(s)
    for (const [mark, n] of masker.markCounts(out)) {
      const gained = n - (before.get(mark) ?? 0)
      if (gained <= 0) continue
      counted += gained
      swaps.set(mark, (swaps.get(mark) ?? 0) + gained)
    }
  }
  return out
}

// "CLIENT_3 ×2, ‹EMAIL› ×1"
export const swapSummary = (m: ReadonlyMap<string, number>) =>
  [...m.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([mark, n]) => `${mark} ×${n}`)
    .join(', ')

let shown = ''
const publish = async ($: EngineInterface) => {
  const s: MaskStatus = {
    level: broken ? 'broken' : isOn() ? 'on' : paused && masker !== null && config?.enabled !== false ? 'paused' : 'off',
    names: masker?.termCount ?? 0,
    detectors: masker?.detectorCount ?? 0,
    folders: config?.blockedFolders?.length ?? 0,
  }
  const key = JSON.stringify(s)
  if (key === shown) return
  shown = key
  await update($, statusAtom, () => s)
}

// Tells the separate safety catch that masking runs in this session; without
// this mark it refuses every prompt. Marks older than two days are cleared.
const markSession = async ($: EngineInterface) => {
  const id = await $.session.id()
  if (id === markedSession || !home) return
  const alive = `${home}/${DIR}/alive`
  await $.fs.write(`${alive}/${id}`, String(await $.clock.now()))
  markedSession = id
  await $.process.run(['find', alive, '-type', 'f', '-mtime', '+2', '-delete'])
}

// Loads the list, and reloads it when it changes (checked at most every 5s).
// Never throws: a list it cannot read stops sending rather than sending unmasked.
const ensure = async ($: EngineInterface) => {
  await load($)
  paused = (await read($, pausedAtom)) ?? config?.startOn !== true
  if (isOn()) await rememberMasked($)
  try {
    await markSession($)
  } catch {
    // The safety catch refuses prompts until the mark is written.
  }
  await publish($)
}

const load = async ($: EngineInterface) => {
  try {
    const now = await $.clock.now()
    if ((masker || broken) && now - checkedAt < 5000) return
    checkedAt = now
    if (!listPath) {
      home = (await $.env.get('HOME')) ?? ''
      listPath = `${home}/${DIR}/terms.json`
    }
    if (!(await $.fs.exists(listPath))) {
      // No names listed yet: personal data and secrets are still masked.
      config = { terms: [] }
      masker = new Masker(config)
      broken = null
      loadedMtime = -1
      $.ui.status('🔒 masking personal data; no client names listed yet (/client-mask-edit)')
      return
    }
    const { mtimeMs } = await $.fs.stat(listPath)
    if ((masker || broken) && mtimeMs === loadedMtime) return
    loadedMtime = mtimeMs
    let parsed: unknown
    try {
      // Notes (// and /* */) and trailing commas are allowed in the list.
      parsed = parseList(await $.fs.read(listPath)).value
    } catch (err) {
      // Only our own message, which gives a line number and never quotes the file.
      const own = err instanceof Error && err.message.startsWith('the list') ? err.message : null
      throw new Error(own ?? 'the list is not valid JSON')
    }
    const problems = validate(parsed)
    if (problems.length > 0) throw new Error(problems.join('; '))
    config = parsed as Config
    masker = new Masker(config)
    broken = null
    $.ui.status(isOn() ? `🔒 masking ${masker.termCount} client names and ${masker.detectorCount} kinds of personal data` : 'masking off')
  } catch (err) {
    masker = null
    const message = err instanceof Error ? err.message : ''
    broken = message.startsWith('the list') || message.startsWith('row') ? message : 'the list could not be read'
    $.ui.status('⛔ masking list has a problem: nothing will be sent')
  }
}

// Opens the list in your own text editor; its contents never pass through here.
// Answers with what happened, for the command's reply or a toast.
const openList = async ($: EngineInterface) => {
  await ensure($)
  if (!(await $.fs.exists(listPath))) {
    await $.fs.write(listPath, tidyList(parseList(JSON.stringify(TEMPLATE)), TEMPLATE._how, KEEP_AS_IS).text)
    await $.process.run(['chmod', '600', listPath])
  }
  const { exitCode } = await $.process.run(['open', '-t', listPath])
  return exitCode === 0 ? 'Your masking list is open in your text editor. Save it and masking picks it up within 5 seconds.' : 'Could not open your text editor.'
}

// /client-mask-tidy: rewrites your list in a fixed, readable layout, here on
// this computer; no model reads it. It writes only when the tidied list reads
// back with exactly the same meaning, and keeps the version before beside it.
// The answer gives counts only.
export const tidyListFile = async ($: EngineInterface): Promise<string> => {
  await ensure($)
  if (!listPath || !(await $.fs.exists(listPath))) return 'You have no masking list yet: /client-mask-edit starts one.'
  if (broken) return stopped()
  const before = await $.fs.read(listPath)
  let parsed: ReturnType<typeof parseList>
  try {
    parsed = parseList(before)
  } catch {
    return stopped()
  }
  const extra = ((parsed.value as Config).keepAsIs ?? []).map(s => s.trim().toUpperCase())
  const { text, terms, groups } = tidyList(parsed, TEMPLATE._how, new Set([...KEEP_AS_IS, ...extra]))
  let check: unknown
  try {
    check = parseList(text).value
  } catch {
    check = null
  }
  if (check === null || validate(check).length > 0 || !sameMeaning(parsed.value, check)) {
    return 'client-mask: the tidied list did not read back with the same meaning, so your list was left exactly as it was.'
  }
  if (text === before) return 'Your masking list is already tidy.'
  const backup = `${listPath}.before-tidy`
  await $.fs.write(backup, before)
  await $.process.run(['chmod', '600', backup])
  const tmp = `${listPath}.tidy-tmp`
  await $.fs.write(tmp, text)
  await $.process.run(['chmod', '600', tmp])
  const { exitCode } = await $.process.run(['mv', '-f', tmp, listPath])
  if (exitCode !== 0) return 'client-mask: the tidied list could not be saved, so your list was left as it was.'
  return `Tidied your masking list: ${terms} terms in ${groups} groups, your notes kept. The version before is saved beside it as terms.json.before-tidy.`
}

const stopped = () =>
  `client-mask stopped this: ${broken}. Fix it with /client-mask-edit; nothing is sent until it reads cleanly.`

// Saved conversations and typed-prompt history are kept, cleaned of any name
// from your list. Only a list that reads cleanly is used for the clean-up.
const IDLE_MS = 5 * 60 * 1000
const RECENT_MS = 2 * 24 * 60 * 60 * 1000

// Cleans one saved file in place. Skipped when the file changed while it was
// read (a session still writing to it); the next clean-up catches it.
const scrubPath = async ($: EngineInterface, path: string) => {
  if (!masker || broken || config?.enabled === false) return
  const m = masker
  try {
    const before = await $.fs.stat(path)
    const { text, changed } = scrubFile(await $.fs.read(path), s => m.mask(s))
    if (!changed) return
    const after = await $.fs.stat(path)
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return
    const tmp = `${path}.client-mask-tmp`
    await $.fs.write(tmp, text)
    await $.process.run(['chmod', '600', tmp])
    await $.process.run(['mv', '-f', tmp, path])
  } catch {
    // A file that cannot be cleaned now is tried again at the next start.
  }
}

// Every saved conversation file (subagents' included) whose session `pick` takes.
const savedConversations = async ($: EngineInterface, pick: (session: string, mtimeMs: number) => boolean) => {
  const root = `${home}/.claude/projects`
  const found: string[] = []
  if (!home || !(await $.fs.exists(root))) return found
  for (const project of await $.fs.list(root)) {
    if (project.kind !== 'dir') continue
    const dir = `${root}/${project.name}`
    for (const f of await $.fs.list(dir)) {
      if (f.kind === 'file' && f.name.endsWith('.jsonl') && pick(f.name.slice(0, -6), f.mtimeMs)) found.push(`${dir}/${f.name}`)
      if (f.kind !== 'dir') continue
      const sub = `${dir}/${f.name}/subagents`
      if (!(await $.fs.exists(sub))) continue
      for (const s of await $.fs.list(sub)) {
        if (s.kind === 'file' && s.name.endsWith('.jsonl') && pick(f.name, s.mtimeMs)) found.push(`${sub}/${s.name}`)
      }
    }
  }
  return found
}

// The model's tool calls, masked as they stream in. The engine stores a tool
// call as the model wrote it and no later hook can rewrite it, so this is the
// one place a name the model writes into a tool call (an agent's brief, a
// search) is caught. Each call's argument pieces are held until the call ends,
// so a name split across pieces is still found; unchanged calls pass as sent.
type StepChunk = TurnStepChunk
export const maskToolArgs = async function* (stream: HookStream<StepChunk, TurnStepResult>, m: Masker): AsyncGenerator<StepChunk, TurnStepResult> {
  let held: { index: number; chunks: StepChunk[]; json: string } | null = null
  const flush = function* (): Generator<StepChunk> {
    if (!held) return
    const { index, chunks, json } = held
    held = null
    const masked = maskArgsJson(json, s => m.mask(s))
    if (masked === json) yield* chunks
    else yield { kind: 'input', index, json: masked }
  }
  for await (const c of stream) {
    if (c.kind === 'input') {
      if (held && held.index !== c.index) yield* flush()
      held ??= { index: c.index, chunks: [], json: '' }
      held.chunks.push(c)
      held.json += c.json
      continue
    }
    // Any other item ends the held pieces, the engine's own items included: a
    // block's end arrives as one, and the engine closes the call on it. Holding
    // the pieces past it sent every tool call with no arguments.
    yield* flush()
    yield c
  }
  yield* flush()
  const r = await stream.result
  // A call with nothing to mask keeps its own object: a call a hook rewrote is
  // not the one auto mode reviewed, so it would be refused.
  const toolUses = r.toolUses.map(t => {
    const input = mapStrings(t.input, s => m.mask(s))
    return JSON.stringify(input) === JSON.stringify(t.input) ? t : { ...t, input }
  })
  return toolUses.every((t, i) => t === r.toolUses[i]) ? r : { ...r, toolUses }
}

const maskedSessions = async ($: EngineInterface): Promise<Record<string, number>> => {
  const v = await $.store.get(MASKED_KEY)
  return v && typeof v === 'object' ? (v as Record<string, number>) : {}
}

let remembered = ''
// Never throws: failing to remember only means this conversation's saved copy
// is not cleaned when it closes; masking itself carries on.
const rememberMasked = async ($: EngineInterface) => {
  try {
    const id = await $.session.id()
    if (id === remembered) return
    const now = await $.clock.now()
    const kept = Object.fromEntries(Object.entries(await maskedSessions($)).filter(([, t]) => now - t < RECENT_MS))
    await $.store.set(MASKED_KEY, { ...kept, [id]: now })
    remembered = id
  } catch {
    // Tried again on the next check.
  }
}

// What a Write would lose: the placeholders (or labels) of listed names and
// personal data in the file on disk that the text written no longer carries.
// null when nothing is lost or there is no file yet; an empty list when the
// file exists but cannot be read, which refuses the write rather than risk it.
// Names only the placeholder, never the real value, as the refusal reaches Claude.
export const overwriteLoses = async ($: EngineInterface, m: Masker, path: string, content: string, restores: boolean): Promise<string[] | null> => {
  let before: string
  try {
    if (!(await $.fs.exists(path))) return null
    before = await $.fs.read(path)
  } catch {
    return []
  }
  const onDisk = m.leaks(before)
  if (onDisk.length === 0) return null
  const kept = new Set(m.leaks(restores ? m.restore(content) : content))
  const lost = onDisk.filter(p => !kept.has(p))
  return lost.length > 0 ? lost : null
}

// Tools whose file is masked on disk first, with "maskFilesInPlace".
const IN_PLACE = ['Read', 'Edit', 'MultiEdit']
const IN_PLACE_MAX_BYTES = 5 * 1024 * 1024
// Copies of files as they were before masking: inside the list's own folder,
// which no tool call may name, so Claude can never open them.
export const ORIGINALS = `${DIR}/originals`

// Masks a text file on disk, in place. 'masked' or 'unchanged' (nothing to
// mask, or no file yet); 'skipped' for what is not a text file or is too large,
// left alone (a read of it is still masked on the way in); 'failed' only when a
// file that needed masking could not be written.
export type InPlace = 'masked' | 'unchanged' | 'skipped' | 'failed'
const NUL = String.fromCharCode(0)
const UNDECODABLE = String.fromCharCode(0xfffd)
export const maskFileInPlace = async ($: EngineInterface, m: Masker, path: string, keepOriginal: boolean): Promise<InPlace> => {
  let text: string
  try {
    if (!(await $.fs.exists(path))) return 'unchanged'
    if (BINARY_FILE.test(path)) return 'skipped'
    const { kind, size } = await $.fs.stat(path)
    if (kind !== 'file' || size > IN_PLACE_MAX_BYTES) return 'skipped'
    text = await $.fs.read(path)
  } catch {
    return 'skipped'
  }
  if (text.includes(NUL) || text.includes(UNDECODABLE)) return 'skipped'
  const masked = m.mask(text)
  if (masked === text) return 'unchanged'
  try {
    const home = (await $.env.get('HOME')) ?? ''
    if (keepOriginal && home !== '') {
      const copy = `${home}/${ORIGINALS}${path.startsWith('/') ? '' : '/'}${path}`
      if (!(await $.fs.exists(copy))) {
        await $.fs.write(copy, text)
        await $.process.run(['chmod', '600', copy])
      }
    }
    const tmp = `${path}.client-mask-tmp`
    await $.fs.write(tmp, masked)
    const { exitCode } = await $.process.run(['mv', '-f', tmp, path])
    return exitCode === 0 ? 'masked' : 'failed'
  } catch {
    return 'failed'
  }
}

// Every file under a folder, skipping hidden folders (.git and the like),
// node_modules and links; capped so a wrong folder cannot run away.
const FOLDER_MAX_FILES = 20000
const filesUnder = async ($: EngineInterface, root: string): Promise<string[]> => {
  const found: string[] = []
  const walk = async (dir: string) => {
    for (const f of await $.fs.list(dir)) {
      if (found.length >= FOLDER_MAX_FILES || f.isLink) continue
      const p = `${dir}/${f.name}`
      if (f.kind === 'dir') {
        if (!f.name.startsWith('.') && f.name !== 'node_modules') await walk(p)
      } else if (f.kind === 'file') found.push(p)
    }
  }
  await walk(root)
  return found
}

// /client-mask-folder <folder>: masks every text file under a folder on disk,
// by your list, here on this computer; no model reads or writes any of it. The
// answer gives counts only: it reaches the conversation, so it names no file.
export const maskFolder = async ($: EngineInterface, args: string): Promise<string> => {
  await ensure($)
  if (broken) return stopped()
  if (!masker || config?.enabled === false) return 'client-mask: masking is switched off in your list, so nothing was changed.'
  const m = masker
  const arg = args.trim().replace(/^["']|["']$/g, '')
  if (arg === '') return 'Give the folder to mask: /client-mask-folder <folder>. Every text file under it is masked on disk by your list.'
  const expanded = arg === '~' ? home : arg.startsWith('~/') ? `${home}${arg.slice(1)}` : arg
  const root = (expanded.startsWith('/') ? expanded : `${await $.session.cwd()}/${expanded}`).replace(/\/+$/, '')
  if (root === '' || root === home || root === `${home}/.claude` || root.startsWith(`${home}/.claude/`)) {
    return "client-mask: that folder is too broad or holds Claude's own files, so nothing was changed. Pick a project or document folder."
  }
  if (!(await $.fs.exists(root))) return 'client-mask: that folder does not exist, so nothing was changed.'
  const { kind } = await $.fs.stat(root)
  const files = kind === 'dir' ? await filesUnder($, root) : [root]
  const scope = { maskOnDiskIn: config?.maskOnDiskIn, keepOnDisk: config?.keepOnDisk }
  if (config?.maskOnDiskIn !== undefined && !files.some(f => onDiskAllowed(f, scope, home))) {
    return 'client-mask: that folder is outside the folders your list allows to be masked on disk ("maskOnDiskIn"), so nothing was changed.'
  }
  const n = { masked: 0, unchanged: 0, skipped: 0, failed: 0 }
  for (const f of files) {
    if (!onDiskAllowed(f, scope, home)) {
      n.skipped++
      continue
    }
    n[await maskFileInPlace($, m, f, config?.keepOriginals !== false)]++
  }
  const plural = (k: number, one: string) => `${k} ${one}${k === 1 ? '' : 's'}`
  return (
    `Masked ${plural(n.masked, 'file')} on disk; ${n.unchanged} had nothing to mask; ` +
    `${n.skipped} left as they were (not text, over 5 MB, or outside the folders your list allows)` +
    (n.failed > 0 ? `; ${n.failed} could not be written` : '') +
    (files.length >= FOLDER_MAX_FILES ? `; stopped at ${FOLDER_MAX_FILES} files` : '') +
    (n.masked > 0 && config?.keepOriginals !== false ? ". A copy of each original is in your list's private folder." : '.')
  )
}

const scrubHistory = ($: EngineInterface) => (home ? scrubPath($, `${home}/.claude/history.jsonl`) : Promise.resolve())

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await ensure($)
    // Keeps the band current and the session marked after /clear.
    $.clock.every(5000, () => void ensure($))
    await $.command.register({ name: VIEW, description: 'Show which placeholder stands for which client term (on screen only)' })
    await $.command.register({ name: EDIT, description: 'Open your masking list in your text editor (Claude never sees it)' })
    await $.command.register({ name: TIDY, description: 'Rewrite your masking list in a tidy, readable layout, locally (Claude never sees it)' })
    await $.command.register({ name: FOLDER, description: 'Mask every text file under a folder on disk by your list, locally; no model is involved' })
    // Catches conversations that closed without cleaning up (a crash, a forced
    // quit): recent ones, idle long enough that no session still writes them.
    void (async () => {
      const id = await $.session.id()
      const now = await $.clock.now()
      // Only conversations that had masking on: the others are left as written.
      const masked = await maskedSessions($)
      const files = await savedConversations($, (s, t) => s !== id && s in masked && now - t > IDLE_MS && now - t < RECENT_MS)
      for (const f of files) await scrubPath($, f)
      if (files.length > 0) await scrubHistory($)
    })().catch(() => {})
    return next(e)
  })

  // When a conversation closes, its saved copy is cleaned and kept, so it can
  // be reopened with no client name in it.
  on('session.end', async ($, e, next) => {
    const r = await next(e)
    await ensure($)
    // A conversation that never had masking on is left as written.
    if (!(e.sessionId in (await maskedSessions($)))) return r
    for (const f of await savedConversations($, s => s === e.sessionId)) await scrubPath($, f)
    await scrubHistory($)
    return r
  })

  // 1. What you type.
  on('prompt.submit', async ($, e, next) => {
    await ensure($)
    if (broken) {
      $.ui.toast(stopped(), { timeoutMs: 10000 })
      return { text: '' }
    }
    if (isOn() && (e.attachments?.length ?? 0) > 0 && config?.blockPictures !== false) {
      $.ui.toast('client-mask stopped this message: pasted pictures cannot be masked. Remove the picture and send it again.', { timeoutMs: 10000 })
      return { text: '' }
    }
    counted = 0
    swaps.clear()
    const r = await next({ ...e, text: countingMask(e.text), context: e.context?.map(countingMask) })
    const n = counted
    await update($, maskedAtom, () => n)
    return r
  })

  // 2. Every row the conversation keeps: tool results, files you mention,
  // hook context, the model's own replies. Stored and sent in masked form.
  on('session.append', async ($, e, next) => {
    await ensure($)
    if (!isOn()) return next(e)
    counted = 0
    const r = await next({ ...e, message: { ...e.message, content: maskContent(e.message.content, countingMask) as never } })
    const n = counted
    if (n > 0) await update($, maskedAtom, m => (m ?? 0) + n)
    return r
  })

  // 3. The system prompt (instructions files, memory, folder names, git status).
  on('prompt.compose', async ($, e, next) => {
    await ensure($)
    const r = await next(e)
    if (!isOn()) return r
    return { ...r, sections: r.sections.map(s => ({ ...s, text: mask(s.text) })) }
  })

  on('prompt.context', async ($, e, next) => {
    await ensure($)
    const r = await next(e)
    if (!isOn()) return r
    return { ...r, blocks: r.blocks.map(b => ({ ...b, text: mask(b.text) })) }
  })

  on('prompt.attachment', async ($, e, next) => {
    await ensure($)
    const r = await next(e)
    return isOn() && r.text !== null ? { ...r, text: mask(r.text) } : r
  })

  on('skill.prompt', async ($, e, next) => {
    await ensure($)
    const r = await next(e)
    return isOn() ? { ...r, text: mask(r.text) } : r
  })

  // Tool descriptions, which can come from outside servers.
  on('tool.describe', async ($, e, next) => {
    await ensure($)
    const r = await next(e)
    return isOn() ? { ...r, description: mask(r.description) } : r
  })

  on('session.send', async ($, e, next) => {
    await ensure($)
    return next({ ...e, text: mask(e.text) })
  })

  // 4. Tools. The list's folder is off limits. Local tools get the real values
  // back so files and commands work; anything that leaves the machine (web,
  // subagents, remote servers) keeps the placeholders. PDFs and images cannot
  // be masked, so they are refused.
  on('tool.call', async ($, e, next) => {
    await ensure($)
    const { tool, tool_use_id, ...args } = e
    if (namesList(args, home)) {
      return { deny: 'client-mask: the masking list is private and Claude cannot open its folder. You can edit it with /client-mask-edit.' }
    }
    if (namesBlockedFolder(args, home, config?.blockedFolders ?? [])) {
      return { deny: 'client-mask: that folder holds real client data, and Claude may not open it. Use made-up test data instead.' }
    }
    if (!isOn() || !masker || !config) return next(e)
    if (toolMatches(tool, WRITERS) && writesLabel(args)) {
      return {
        deny:
          'client-mask: this would write a masked label (such as ‹EMAIL› or ‹SECRET›) into a file or command. ' +
          'Labels never turn back, so it would overwrite the real value. Leave that part unchanged and edit around it.',
      }
    }
    const path = 'file_path' in e && typeof e.file_path === 'string' ? e.file_path : ''
    if (tool === 'Read' && config.blockBinaryFiles !== false && BINARY_FILE.test(path)) {
      return {
        deny:
          'client-mask: PDFs and images reach the model as pictures, which cannot be masked. ' +
          'Convert the file to text first (for a PDF: pdftotext "<file>" -), then read the text.',
      }
    }
    const restores = toolMatches(tool, config.restoreInTools ?? DEFAULT_RESTORE) && !(home !== '' && path.startsWith(`${home}/.claude/`))
    if (config.maskFilesInPlace === true) {
      // The files this call touches: Read and Edit name one; Grep's path may be
      // a file; a Bash command is read for every file it names.
      const targets =
        IN_PLACE.includes(tool) ? [path]
        : tool === 'Grep' && typeof (e as { path?: unknown }).path === 'string' ? [(e as { path: string }).path]
        : tool === 'Bash' ? commandPaths(String((e as { command?: unknown }).command ?? ''), await $.session.cwd(), home)
        : []
      for (const target of targets) {
        if (target === '' || !onDiskAllowed(target, config, home)) continue
        if ((await maskFileInPlace($, masker, target, config.keepOriginals !== false)) === 'failed') {
          return { deny: 'client-mask: a file this call touches could not be masked on disk first, so the call was stopped. Check it is a text file you can write to.' }
        }
      }
    }
    // Where files are masked on disk the guard has nothing to protect; elsewhere
    // (the folders your list keeps as they are) it still stops a full rewrite.
    const maskedOnDisk = config.maskFilesInPlace === true && onDiskAllowed(path, config, home)
    if (tool === 'Write' && path !== '' && config.guardOverwrites !== false && !maskedOnDisk) {
      const lost = await overwriteLoses($, masker, path, String((e as { content?: unknown }).content ?? ''), restores)
      if (lost !== null) {
        return {
          deny:
            lost.length === 0
              ? 'client-mask: this file could not be checked for real client names, so it was not overwritten. Use Edit to change only the parts that need changing.'
              : `client-mask: this would overwrite a file that holds the real values behind ${lost.join(', ')}. ` +
                'You only see them as placeholders, so a full rewrite would replace them for good. Use Edit to change only the parts that need changing, and leave those parts as they are.',
        }
      }
    }
    if (!restores) return next(e)
    const m = masker
    const restored = mapStrings(args, s => m.restore(s)) as typeof args
    // Pass the call on untouched when nothing was turned back: a call a hook
    // rewrote is not the one auto mode reviewed, so it would be refused.
    if (JSON.stringify(restored) === JSON.stringify(args)) return next(e)
    return next({ ...e, ...restored, tool, tool_use_id } as typeof e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'client-mask: its guard failed, so the tool call was stopped.' }))

  // 5. Last check before each request: if the list cannot be read, or any name
  // is still in clear text, the request is not sent.
  on('turn.step', async function* ($, e, next) {
    await ensure($)
    let note: string | null = null
    const loop = e.agentId ?? 'main'
    let from = (await read($, sentAtom))[loop] ?? 0
    // Fewer messages than were sent: the conversation was compacted, its summary
    // written by the model from what it was already sent. Only the newest is new.
    if (e.messageCount < from) from = Math.max(0, e.messageCount - 1)
    if (broken) note = stopped()
    else if (isOn() && masker && config?.onLeak !== 'off') {
      const messages = e.agentId ? await $.session.messages({ as: 'api', agentId: e.agentId }) : await $.session.messages({ as: 'api' })
      // Only what was added since the last request: earlier messages, sent while
      // masking was off or before a name joined the list, already reached the model.
      const hits = Array.isArray(messages) ? masker.leaks(scannable(messages.slice(from))) : []
      if (hits.length > 0) {
        note =
          `client-mask stopped this request: the name behind ${hits.join(', ')} is in clear text in what was about to be sent. ` +
          'Send your message again; if this repeats, close Claude Code and reopen this conversation: its saved copy is cleaned as it closes.'
        if (config?.onLeak === 'warn') {
          $.ui.toast(note, { timeoutMs: 10000 })
          note = null
        }
      }
    }
    if (note === null) {
      const count = e.messageCount
      await update($, sentAtom, m => ({ ...(m ?? {}), [loop]: count }))
      if (!isOn() || !masker) return yield* next(e)
      return yield* maskToolArgs(next(e), masker)
    }
    $.ui.toast(note, { timeoutMs: 10000 })
    yield { kind: 'text', index: 0, text: note }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: e.turnId, index: e.index, answer: note, toolUses: [], stopReason: 'end_turn', usage: null }
  })

  // The view draws the real values in a side panel on your screen only; a panel
  // is never part of the conversation, and the command's own reply names nothing.
  on('command.run', { command: VIEW }, async $ => {
    await $.ui.open({ id: VIEW, title: 'Client mask list' })
    return { text: 'Your list is open in a side panel, on screen only.' }
  })

  on('command.run', { command: EDIT }, async $ => ({ text: await openList($) }))

  on('command.run', { command: TIDY }, async $ => ({ text: await tidyListFile($) }))

  on('command.run', { command: FOLDER }, async ($, e) => ({ text: await maskFolder($, e.args) }))

  // After each answer, a pop-up naming what was masked, by placeholder only.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId && isOn() && swaps.size > 0) {
      $.ui.toast(`🔒 Masked: ${swapSummary(swaps)}`, { timeoutMs: 8000 })
    }
    return r
  })

  // On your screen only, Claude's replies and your own messages show the real
  // names again, marked 🔒. What the model read and what is saved stay masked.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    await ensure($)
    if (!isOn() || !masker || config?.showRealNames === false) return next(e)
    const text = masker.display(e.props.text, true)
    return text === e.props.text ? next(e) : next({ ...e, props: { ...e.props, text } })
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    await ensure($)
    if (!isOn() || !masker || config?.showRealNames === false) return next(e)
    const text = masker.display(e.props.text, false)
    return text === e.props.text ? next(e) : next({ ...e, props: { ...e.props, text } })
  })

  // One line in the band above the prompt, under any other plugin's band.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const s = await read($, statusAtom)
    if (s === null) return below
    const n = await read($, maskedAtom)
    const { Box, Text, Button } = $.ui.resolve(e)
    const plural = (k: number, one: string) => `${k} ${one}${k === 1 ? '' : 's'}`
    // The masking button: each press switches masking on or off for this session.
    const step = async () => {
      if (paused) {
        paused = false
        await update($, pausedAtom, () => false)
        if (isOn()) await rememberMasked($)
        $.ui.toast(
          'Masking is on for this session only: what you send from now on is masked. Other sessions are not affected.',
          { timeoutMs: 8000 },
        )
      } else {
        paused = true
        await update($, pausedAtom, () => true)
        $.ui.toast(
          'Masking is off for this session: what you send now reaches Claude as written. ' +
            'Switch it back on at any time: what you send from then on is masked, while what Claude already read stays in this conversation.',
          { timeoutMs: 10000 },
        )
      }
      await publish($)
    }
    const editList = async () => {
      $.ui.toast(await openList($), { timeoutMs: 6000 })
    }
    const sep = <Text dimColor>{'  ·  '}</Text>
    const mine =
      s.level === 'broken' ? (
        <Box flexDirection="row">
          <Text color="error">⛔ Masking list has a problem: nothing will be sent</Text>
          {sep}
          <Button key="edit" label="✎ edit list" plain dimColor onPress={editList} />
        </Box>
      ) : s.level === 'off' ? (
        <Box flexDirection="row">
          <Text color="warning">⚠ Masking is switched off in your list</Text>
          {sep}
          <Button key="edit" label="✎ edit list" plain dimColor onPress={editList} />
        </Box>
      ) : s.level === 'paused' ? (
        <Box flexDirection="row">
          <Button key="mask" label="⚠ Masking off" plain onPress={step} />
          <Text dimColor>{'  ·  click to mask this session only'}</Text>
          {sep}
          <Button key="edit" label="✎ edit list" plain dimColor onPress={editList} />
        </Box>
      ) : (
        <Box flexDirection="row">
          <Button key="mask" label="🔒 Masking on" plain onPress={step} />
          <Text dimColor>
            {`  ·  ${plural(s.names, 'name')}  ·  ${plural(s.detectors, 'kind')} of personal data  ·  list locked` +
              (s.folders > 0 ? `  ·  ${plural(s.folders, 'folder')} blocked` : '') +
              `  ·  last message: ${n} masked`}
          </Text>
          {sep}
          <Button key="edit" label="✎ edit list" plain dimColor onPress={editList} />
        </Box>
      )
    return below ? (
      <Box flexDirection="column">
        {below}
        {mine}
      </Box>
    ) : (
      mine
    )
  })

  on('ui.render', { component: 'Pane', requestId: VIEW }, async ($, e) => {
    await ensure($)
    const { Box, Text } = $.ui.resolve(e)
    const rows = masker?.legend() ?? []
    return (
      <Box flexDirection="column">
        {broken && <Text color="error">{broken}</Text>}
        {!broken && rows.length === 0 && <Text dimColor>No names in your list yet.</Text>}
        {rows.map(([ph, real]) => (
          <Text>
            <Text bold>{ph}</Text> = {real}
          </Text>
        ))}
      </Box>
    )
  })
}
