import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { BINARY_FILE, GROUP_MODES, Masker, REMOVED, mapStrings, maskContent, namesBlockedFolder, namesList, scannable, toolMatches, validate, writesLabel } from './mask'
import type { Config } from './mask'
import type { GroupMode, MaskStatus } from '../types'

// Your list lives outside every repository, in your home folder, and never in
// chat. Claude is refused any tool call that names its folder.
const DIR = '.claude/client-mask'
const VIEW = 'client-mask-view'
const EDIT = 'client-mask-edit'
const GROUPS = 'client-mask-groups'
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
    'List folders of real client data Claude may never open in "blockedFolders".',
  detect: {},
  keep: [],
  blockedFolders: [],
  terms: [],
}

// What the band above the prompt shows: whether masking is on, and how many
// items the last message carried masked. Counts only, never what was masked.
const statusAtom = atom({ plugin: 'client-mask', key: 'status' } as const, null)
const maskedAtom = atom({ plugin: 'client-mask', key: 'masked' } as const, 0)
// This session's choice for "onlyWith" rows; a new session starts at 'group'.
const groupsAtom = atom({ plugin: 'client-mask', key: 'groups' } as const, 'group' as GroupMode)
const GROUP_HELP: Record<GroupMode, string> = {
  group: 'masked only as a group, when their companion is in the same message or file',
  individual: 'masked individually, wherever each appears',
  off: 'not masked, even next to their companion',
}

let masker: Masker | null = null
let markedSession = ''
let config: Config | null = null
// Why the list cannot be used, by row number only. While set, nothing is sent.
let broken: string | null = null
let home = ''
let listPath = ''
let loadedMtime = -1
let checkedAt = 0

const isOn = () => broken === null && masker !== null && config?.enabled !== false
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
    level: broken ? 'broken' : isOn() ? 'on' : 'off',
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
  if (masker) masker.groupMode = await read($, groupsAtom)
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
      parsed = JSON.parse(await $.fs.read(listPath))
    } catch {
      // The parser's message can quote the file, so it is not passed on.
      throw new Error('the list is not valid JSON')
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

const stopped = () =>
  `client-mask stopped this: ${broken}. Fix it with /client-mask-edit; nothing is sent until it reads cleanly.`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await ensure($)
    // Keeps the band current and the session marked after /clear.
    $.clock.every(5000, () => void ensure($))
    await $.command.register({ name: VIEW, description: 'Show which placeholder stands for which client term (on screen only)' })
    await $.command.register({ name: EDIT, description: 'Open your masking list in your text editor (Claude never sees it)' })
    await $.command.register({ name: GROUPS, description: 'For this session, mask "onlyWith" names: group (normal), individual, or off' })
    return next(e)
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
    if (!toolMatches(tool, config.restoreInTools ?? DEFAULT_RESTORE)) return next(e)
    // Claude's own notes and settings keep the placeholders.
    if (home !== '' && path.startsWith(`${home}/.claude/`)) return next(e)
    const m = masker
    const restored = mapStrings(args, s => m.restore(s)) as typeof args
    return next({ ...e, ...restored, tool, tool_use_id } as typeof e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'client-mask: its guard failed, so the tool call was stopped.' }))

  // 5. Last check before each request: if the list cannot be read, or any name
  // is still in clear text, the request is not sent.
  on('turn.step', async function* ($, e, next) {
    await ensure($)
    let note: string | null = null
    if (broken) note = stopped()
    else if (isOn() && masker && config?.onLeak !== 'off') {
      const messages = e.agentId ? await $.session.messages({ as: 'api', agentId: e.agentId }) : await $.session.messages({ as: 'api' })
      const hits = Array.isArray(messages) ? masker.leaks(scannable(messages)) : []
      if (hits.length > 0) {
        note =
          `client-mask stopped this request: the name behind ${hits.join(', ')} is still in clear text ` +
          '(usually because the list changed mid-conversation). Start a new session to continue.'
        if (config?.onLeak === 'warn') {
          $.ui.toast(note, { timeoutMs: 10000 })
          note = null
        }
      }
    }
    if (note === null) return yield* next(e)
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

  // Opens the list in your own text editor; its contents never pass through here.
  on('command.run', { command: EDIT }, async $ => {
    await ensure($)
    if (!(await $.fs.exists(listPath))) {
      await $.fs.write(listPath, JSON.stringify(TEMPLATE, null, 2) + '\n')
      await $.process.run(['chmod', '600', listPath])
    }
    const { exitCode } = await $.process.run(['open', '-t', listPath])
    return { text: exitCode === 0 ? 'Your masking list is open in your text editor. Save it and masking picks it up within 5 seconds.' : 'Could not open your text editor.' }
  })

  // Sets, for this session only, how "onlyWith" rows behave.
  on('command.run', { command: GROUPS }, async ($, e) => {
    const choice = e.args.trim().toLowerCase()
    if (choice === '') {
      const now = await read($, groupsAtom)
      return { text: `Grouped names are ${GROUP_HELP[now]} (${now}). Change it with /${GROUPS} group, individual or off.` }
    }
    if (!(GROUP_MODES as readonly string[]).includes(choice)) {
      return { text: `Use /${GROUPS} group, individual or off.` }
    }
    const mode = choice as GroupMode
    await update($, groupsAtom, () => mode)
    if (masker) masker.groupMode = mode
    return { text: `For this session, grouped names are ${GROUP_HELP[mode]}.` }
  })

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
    const { Box, Text } = $.ui.resolve(e)
    const plural = (k: number, one: string) => `${k} ${one}${k === 1 ? '' : 's'}`
    const line =
      s.level === 'broken' ? (
        <Text color="error">⛔ Masking list has a problem: nothing will be sent (/client-mask-edit)</Text>
      ) : s.level === 'off' ? (
        <Text color="warning">⚠ Masking is switched off</Text>
      ) : (
        <Text>
          <Text color="success">🔒 Masking on</Text>
          <Text dimColor>
            {`  ·  ${plural(s.names, 'name')}  ·  ${plural(s.detectors, 'kind')} of personal data  ·  list locked` +
              (s.folders > 0 ? `  ·  ${plural(s.folders, 'folder')} blocked` : '') +
              `  ·  last message: ${n} masked`}
          </Text>
        </Text>
      )
    return below ? (
      <Box flexDirection="column">
        {below}
        {line}
      </Box>
    ) : (
      line
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
