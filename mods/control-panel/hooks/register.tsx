import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { HARVEST_PROMPT, brief, byNumber, findings, knownIn, parseHarvest, proposal, setFields, toJsonl } from './desk'
import type { Finding, Proposal } from './desk'
import { fromInstructions, fromSkill, groups, queued } from './commands'
import type { Cmd } from './commands'
import type { Counts, Mode } from '../types'

const PANE = 'control-panel'
const rootAtom = atom({ plugin: 'control-panel', key: 'root' } as const, null as string | null)
const modeAtom = atom({ plugin: 'control-panel', key: 'mode' } as const, 'commands' as Mode)
const countsAtom = atom({ plugin: 'control-panel', key: 'counts' } as const, { proposals: 0, unreviewed: 0, findings: 0 } as Counts)
const newPagesAtom = atom({ plugin: 'control-panel', key: 'newPages' } as const, [] as string[])
const cwdAtom = atom({ plugin: 'control-panel', key: 'cwd' } as const, '')
const sentAtom = atom({ plugin: 'control-panel', key: 'sent' } as const, '')
const cursorAtom = atom({ plugin: 'control-panel', key: 'cursor' } as const, 0)
const versionAtom = atom({ plugin: 'control-panel', key: 'version' } as const, 0)

const PROPOSALS = 'wiki/pending/proposals'
const FINDINGS = 'wiki/pending/session-findings.jsonl'
const BINNED = 'wiki/pending/session-findings-binned.jsonl'

type Item = { kind: 'proposal'; p: Proposal } | { kind: 'finding'; f: Finding; index: number; known: string[] }

// What the pane shows, read from disk when the queue changes.
let queue: Item[] = []
let commands: Cmd[] = []

const today = () => new Date().toISOString().slice(0, 10)

async function readIf($: EngineInterface, path: string): Promise<string | null> {
  return (await $.fs.exists(path)) ? await $.fs.read(path) : null
}

// A project counts as a wiki when it keeps a proposal queue.
async function findRoot($: EngineInterface): Promise<string | null> {
  const cwd = await $.session.cwd()
  return (await $.fs.exists(`${cwd}/${PROPOSALS}`)) ? cwd : null
}

// The lookup indexes a finding is checked against: this wiki's and its parent's.
async function lookups($: EngineInterface, root: string): Promise<string[]> {
  const parent = `${root.replace(/\/[^/]+$/, '')}/LLM Wiki/wiki/lookup.md`
  const out: string[] = []
  for (const p of [`${root}/wiki/lookup.md`, parent]) {
    const t = await readIf($, p)
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

// The project's own commands and playbooks, read from its instructions and skills.
async function loadCommands($: EngineInterface, cwd: string): Promise<Cmd[]> {
  const out: Cmd[] = fromInstructions((await readIf($, `${cwd}/CLAUDE.md`)) ?? '')
  const skills = `${cwd}/.claude/skills`
  if (await $.fs.exists(skills)) {
    for (const d of await $.fs.list(skills)) {
      if (d.kind !== 'dir') continue
      const c = fromSkill((await readIf($, `${skills}/${d.name}/SKILL.md`)) ?? '')
      if (c && !out.some(o => o.text.trim() === c.text.trim())) out.push(c)
    }
  }
  return out
}

type Need = { key: string; text: string; actions: { label: string; run?: string; fill?: string; open?: Mode }[] }

// What needs you now: an open handoff, unread proposals and findings, open
// action items, files waiting to be ingested. Each with the command that deals with it.
async function needs($: EngineInterface): Promise<Need[]> {
  const root = await read($, rootAtom)
  if (!root) return []
  const out: Need[] = []
  const b = brief({
    handoff: (await readIf($, `${root}/wiki/pending/handoff.md`)) ?? undefined,
    actions: (await readIf($, `${root}/wiki/pending/action-items.md`)) ?? undefined,
  })
  if (b.handoff) out.push({ key: 'handoff', text: `Open handoff from ${b.handoff.slice(0, 90)}`, actions: [{ label: 'Resume', run: '@alex resume-handoff' }] })
  const c = await read($, countsAtom)
  if (c.unreviewed + c.findings > 0) {
    out.push({
      key: 'queue',
      text: `${c.unreviewed} proposal${c.unreviewed === 1 ? '' : 's'} and ${c.findings} finding${c.findings === 1 ? '' : 's'} to read`,
      actions: [{ label: 'Review', open: 'review' }, ...(c.proposals > 0 ? [{ label: 'Approve all', run: '@sarah approve-all' }] : [])],
    })
  }
  for (const a of b.actions) {
    const id = /^[A-Z]+-\d+/.exec(a)?.[0]
    if (id) out.push({ key: id, text: a.replace(/ \(since [^)]*\)$/, ''), actions: [{ label: 'Run', run: `Run action item ${id}` }] })
  }
  const waiting = queued((await readIf($, `${root}/wiki/pending/ingest-queue.md`)) ?? '')
  if (waiting > 0) out.push({ key: 'ingest', text: `${waiting} file${waiting === 1 ? '' : 's'} waiting to be converted`, actions: [{ label: 'Convert', fill: '@kylie convert ' }] })
  return out
}

// Sends a command as if you typed it, or puts it in the prompt for you to finish.
async function send($: EngineInterface, cmd: { run?: string; fill?: string }): Promise<void> {
  if (cmd.fill !== undefined) {
    await $.prompt.fill({ text: cmd.fill, mode: 'replace' })
    await update($, sentAtom, () => '')
    return
  }
  if (!cmd.run) return
  await update($, sentAtom, () => cmd.run ?? '')
  await $.prompt.submit({ text: cmd.run })
}

async function refresh($: EngineInterface): Promise<void> {
  const cwd = await read($, cwdAtom)
  if (cwd) commands = await loadCommands($, cwd)
  const root = await read($, rootAtom)
  if (!root) {
    await update($, versionAtom, v => (v ?? 0) + 1)
    return
  }
  const names = (await $.fs.list(`${root}/${PROPOSALS}`)).map(n => n.name).filter(n => /^SP-\d+\.md$/.test(n))
  const ps: Proposal[] = []
  for (const n of names) {
    const file = `${root}/${PROPOSALS}/${n}`
    const p = proposal(file, await $.fs.read(file))
    if (p) ps.push(p)
  }
  ps.sort(byNumber)
  const fs = findings((await readIf($, `${root}/${FINDINGS}`)) ?? '')
  const indexes = await lookups($, root)
  queue = [
    ...fs.map((f, index): Item => ({ kind: 'finding', f, index, known: [...new Set(indexes.flatMap(l => knownIn(f.fact, l)))] })),
    ...ps.map((p): Item => ({ kind: 'proposal', p })),
  ]
  await update($, countsAtom, () => ({ proposals: ps.length, unreviewed: ps.filter(p => !p.reviewed).length, findings: fs.length }))
  await update($, cursorAtom, c => Math.min(c ?? 0, Math.max(0, queue.length - 1)))
  await update($, versionAtom, v => (v ?? 0) + 1)
}

async function openDesk($: EngineInterface, mode: Mode): Promise<void> {
  await update($, modeAtom, () => mode)
  await refresh($)
  // Start at the first finding, or else the first proposal you have not read.
  await update($, cursorAtom, () => Math.max(0, queue.findIndex(i => i.kind === 'finding' || !i.p.reviewed)))
  await $.ui.open({ id: PANE, title: 'Control panel', focus: true })
}

// Keep leaves the proposal pending for Sarah, as it always was, and only notes
// that you read it. Reject and Hold use the statuses Sarah already uses.
async function decideProposal($: EngineInterface, p: Proposal, decision: 'keep' | 'rejected' | 'held'): Promise<void> {
  const text = await $.fs.read(p.file)
  const reviewed = `${today()} by owner (wiki desk)`
  await $.fs.write(p.file, setFields(text, decision === 'keep' ? { reviewed } : { status: decision, reviewed }))
  $.ui.toast(decision === 'keep' ? `${p.id} read and kept in the queue` : `${p.id} ${decision}`, { timeoutMs: 4000 })
  await refresh($)
  await update($, cursorAtom, () => Math.max(0, queue.findIndex(i => i.kind === 'finding' || !i.p.reviewed)))
}

async function removeFinding($: EngineInterface, root: string, index: number, binned: boolean): Promise<void> {
  const list = findings((await readIf($, `${root}/${FINDINGS}`)) ?? '')
  const [gone] = list.splice(index, 1)
  await $.fs.write(`${root}/${FINDINGS}`, toJsonl(list))
  if (binned && gone) await $.fs.write(`${root}/${BINNED}`, `${(await readIf($, `${root}/${BINNED}`)) ?? ''}${JSON.stringify({ ...gone, binned: today() })}\n`)
}

// A kept finding becomes an ordinary proposal through the wiki's own script, read by you.
async function keepFinding($: EngineInterface, item: Extract<Item, { kind: 'finding' }>): Promise<void> {
  const root = await read($, rootAtom)
  if (!root) return
  const { f, known } = item
  const body = [
    `Provenance: session finding caught ${f.at}, kept by the owner in the wiki desk ${today()}.`,
    '',
    `Fact: ${f.fact}`,
    '',
    `Evidence: ${f.evidence}`,
    known.length ? `\nPossible overlap, check before writing: ${known.join(', ')}` : '',
  ].join('\n')
  const made = await $.process.run(
    [
      'python3', 'scripts/new_proposal.py',
      '--title', `Session finding: ${f.fact.slice(0, 90)}`,
      '--type', 'enrich',
      '--target', f.page || 'to be placed by Sarah',
      '--trigger', `session finding ${f.at}`,
      '--priority', 'medium',
      '--raised-by', 'wiki-desk',
      '--body', body,
    ],
    { cwd: root, timeoutMs: 20000 },
  )
  const id = /SP-\d+/.exec(made.stdout)?.[0]
  if (made.exitCode !== 0 || !id) {
    $.ui.toast(`Could not raise the proposal: ${(made.stderr || made.stdout).slice(0, 160)}`, { timeoutMs: 8000 })
    return
  }
  const file = `${root}/${PROPOSALS}/${id}.md`
  await $.fs.write(file, setFields(await $.fs.read(file), { reviewed: `${today()} by owner (wiki desk)` }))
  await removeFinding($, root, item.index, false)
  $.ui.toast(`Kept as ${id}, in the proposal queue`, { timeoutMs: 4000 })
  await refresh($)
}

async function binFinding($: EngineInterface, index: number): Promise<void> {
  const root = await read($, rootAtom)
  if (!root) return
  await removeFinding($, root, index, true)
  await refresh($)
}

// Asks the session itself what it proved, and adds the answer to the findings list.
async function harvest($: EngineInterface): Promise<number> {
  const root = await read($, rootAtom)
  if (!root) return 0
  const r = await $.model.fork({ prompt: HARVEST_PROMPT })
  if (!r.isAnswered) return 0
  const found = parseHarvest(r.text, today())
  if (found.length === 0) return 0
  const before = (await readIf($, `${root}/${FINDINGS}`)) ?? ''
  await $.fs.write(`${root}/${FINDINGS}`, before + toJsonl(found))
  await refresh($)
  return found.length
}

// A turn that ran tests, called a real system or read documentation can prove a fact.
const EVIDENCE_TOOL = /^mcp__(?:sap-adt-mcp|adt-bridge|sap-[\w-]+)__|^WebFetch$/
const EVIDENCE_COMMAND = /\b(?:npm (?:run )?test|npm run gate|jest|pytest|vitest|cds (?:watch|deploy|compile|build)|abaplint|abap_transpile|cf (?:push|deploy|env|services)|curl\s+-?\S*\s*https?:)/

export const register: Register = on => {
  let sawEvidence = false
  let harvestDue = false
  let lastHarvest = 0
  let harvesting = false

  on('session.start', async ($, e, next) => {
    const root = await findRoot($).catch(() => null)
    await update($, rootAtom, () => root)
    await update($, cwdAtom, () => e.cwd)
    await $.command.register({ name: 'panel', description: 'Open the control panel: this project\'s commands, what needs you, the wiki desk' })
    await refresh($).catch(() => {})
    if (root) {
      await $.command.register({ name: 'wiki-review', description: 'Review wiki proposals and session findings one at a time' })
      await $.command.register({ name: 'wiki-pages', description: 'Wiki pages created in this session, to check' })
      await $.command.register({ name: 'where', description: 'Where we left off: handoff, blockers and open action items' })
      await $.command.register({ name: 'wiki-harvest', description: 'Catch the facts this session proved, for review' })
      await refresh($).catch(() => {})
      $.clock.every(30000, () => {
        void (async () => {
          if (!harvestDue || harvesting || (await $.clock.now()) - lastHarvest < 20 * 60000) return
          harvesting = true
          harvestDue = false
          lastHarvest = await $.clock.now()
          const n = await harvest($).catch(() => 0)
          harvesting = false
          if (n > 0) $.ui.toast(`📥 ${n} new finding${n === 1 ? '' : 's'} to review in the wiki desk`, { timeoutMs: 6000 })
        })()
      })
    }
    return next(e)
  })

  on('command.run', { command: 'panel' }, async $ => {
    await openDesk($, 'commands')
    return { text: 'Control panel opened.' }
  })
  on('command.run', { command: 'wiki-review' }, async $ => {
    await openDesk($, 'review')
    return { text: 'Wiki desk opened.' }
  })
  on('command.run', { command: 'wiki-pages' }, async $ => {
    await openDesk($, 'pages')
    return { text: 'New wiki pages opened.' }
  })
  on('command.run', { command: 'where' }, async $ => {
    await openDesk($, 'where')
    return { text: 'Where we left off, opened.' }
  })
  on('command.run', { command: 'wiki-harvest' }, async $ => {
    const n = await harvest($)
    return { text: n > 0 ? `${n} finding${n === 1 ? '' : 's'} caught for review: /wiki-review` : 'Nothing proven this session that the wiki lacks.' }
  })

  on('turn.start', ($, e, next) => {
    sawEvidence = false
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId && e.reason === 'answer' && sawEvidence) harvestDue = true
    return next(e)
  })

  // Notes evidence, and the wiki pages this session creates, for you to check
  // afterwards. It never stops a write.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (EVIDENCE_TOOL.test(tool) || (tool === 'Bash' && EVIDENCE_COMMAND.test(String((e as { command?: string }).command ?? '')))) sawEvidence = true
    if (tool !== 'Write') return next(e)
    const root = await read($, rootAtom)
    const path = String((e as { file_path?: string }).file_path ?? '')
    const isNew = !!root && path.startsWith(`${root}/wiki/pages/`) && !(await $.fs.exists(path))
    const r = await next(e)
    if (isNew && r.deny === undefined && !(r as { isError?: boolean }).isError) await update($, newPagesAtom, l => [...(l ?? []), path])
    return r
  })

  // The band: the project, how many things need you, and the door to the panel.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const cwd = await read($, cwdAtom)
    await read($, versionAtom)
    if (e.props.hasSurvey || !cwd || (commands.length === 0 && !(await read($, rootAtom)))) return below
    const n = (await needs($)).length
    const pages = await read($, newPagesAtom)
    const { Box, Text, Button } = $.ui.resolve(e)
    const line = (
      <Box flexDirection="row">
        <Text dimColor>{`${cwd.split('/').pop()}  `}</Text>
        {n > 0 ? <Text color="warning">{`${n} thing${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} you  `}</Text> : <Text dimColor>nothing needs you  </Text>}
        {pages.length ? <Text dimColor>{`${pages.length} new wiki page${pages.length === 1 ? '' : 's'}  `}</Text> : null}
        <Button key="panel" label="Commands" onPress={() => openDesk($, 'commands')} />
      </Box>
    )
    return below ? (
      <Box flexDirection="column">
        {line}
        {below}
      </Box>
    ) : (
      line
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    await read($, versionAtom)
    const mode = await read($, modeAtom)
    const root = await read($, rootAtom)
    const tabs = (
      <Box flexDirection="row">
        <Button key="t-commands" label="Commands" variant={mode === 'commands' ? 'primary' : undefined} onPress={() => update($, modeAtom, () => 'commands')} />
        {root ? <Button key="t-review" label="Wiki desk" variant={mode === 'review' ? 'primary' : undefined} onPress={() => update($, modeAtom, () => 'review')} /> : null}
        {root ? <Button key="t-pages" label="New pages" variant={mode === 'pages' ? 'primary' : undefined} onPress={() => update($, modeAtom, () => 'pages')} /> : null}
        {root ? <Button key="t-where" label="Where we left off" variant={mode === 'where' ? 'primary' : undefined} onPress={() => update($, modeAtom, () => 'where')} /> : null}
      </Box>
    )

    if (mode === 'commands' || !root) {
      const list = await needs($)
      const sent = await read($, sentAtom)
      return (
        <Box flexDirection="column">
          {tabs}
          {list.length ? <Text bold>Needs you now</Text> : null}
          {list.map(n => (
            <Box key={`need-${n.key}`} flexDirection="row">
              <Text>{`${n.text}  `}</Text>
              {n.actions.map(a => (
                <Button key={`need-${n.key}-${a.label}`} label={a.label} onPress={() => (a.open ? update($, modeAtom, () => a.open as Mode) : send($, a))} />
              ))}
            </Box>
          ))}
          {groups(commands).map(([g, cs]) => (
            <Box key={`g-${g}`} flexDirection="column">
              <Text dimColor>{g}</Text>
              <Box flexDirection="row" flexWrap="wrap">
                {cs.map(c => (
                  <Button key={`c-${c.text}`} label={c.label} onPress={() => send($, c.mode === 'fill' ? { fill: c.text } : { run: c.text })} />
                ))}
              </Box>
            </Box>
          ))}
          {commands.length === 0 ? <Text dimColor>This project lists no commands or playbooks.</Text> : <Text dimColor>Buttons ending in … put the command in the prompt for you to finish. The rest run straight away.</Text>}
          {sent ? <Text color="success">{`Sent: ${sent}`}</Text> : null}
        </Box>
      )
    }

    if (mode === 'where') {
      const b = brief({
        handoff: (await readIf($, `${root}/wiki/pending/handoff.md`)) ?? undefined,
        blockers: (await readIf($, `${root}/wiki/pending/blockers.md`)) ?? undefined,
        actions: (await readIf($, `${root}/wiki/pending/action-items.md`)) ?? undefined,
        notes: (await readIf($, `${root}/WORKING-NOTES.md`)) ?? undefined,
      })
      const c = await read($, countsAtom)
      const md = [
        '### Where we left off',
        b.handoff ? `**Open handoff** ${b.handoff}\n\nSay \`@alex resume-handoff\` to pick it up.` : 'No open handoff.',
        b.blockers.length ? `**Blockers**\n\n${b.blockers.map(x => `- ${x}`).join('\n')}` : 'No open blockers.',
        b.actions.length ? `**Open action items**\n\n${b.actions.map(x => `- ${x}`).join('\n')}` : 'No open action items.',
        `**Waiting for you** ${c.unreviewed} of ${c.proposals} proposals not yet read, ${c.findings} findings.`,
        b.notes ? `**Working notes** ${b.notes}` : '',
      ]
        .filter(Boolean)
        .join('\n\n')
      return (
        <Box flexDirection="column">
          {tabs}
          <Markdown text={md} />
        </Box>
      )
    }

    if (mode === 'pages') {
      const pages = await read($, newPagesAtom)
      const md = pages.length
        ? ['### Wiki pages created this session', ...pages.map(p => `- [${p.slice(root.length + 1)}](file://${encodeURI(p)})`)].join('\n')
        : 'No wiki pages created this session.'
      return (
        <Box flexDirection="column">
          {tabs}
          <Markdown text={md} />
        </Box>
      )
    }

    const cursor = await read($, cursorAtom)
    const item = queue[cursor]
    if (!item) {
      return (
        <Box flexDirection="column">
          {tabs}
          <Text dimColor>Nothing to review.</Text>
        </Box>
      )
    }
    const nav = (
      <Box flexDirection="row">
        <Text dimColor>{`${cursor + 1} of ${queue.length}  `}</Text>
        <Button key="prev" label="Back" onPress={() => update($, cursorAtom, c => Math.max(0, (c ?? 0) - 1))} />
        <Button key="skip" label="Skip" onPress={() => update($, cursorAtom, c => Math.min(queue.length - 1, (c ?? 0) + 1))} />
      </Box>
    )
    if (item.kind === 'finding') {
      const md = [
        `### Session finding (${item.f.at})`,
        item.f.fact,
        `**Evidence** ${item.f.evidence}`,
        item.f.page ? `**Belongs on** ${item.f.page}` : '',
        item.known.length ? `**Already in the wiki?** These pages name the same objects: ${item.known.join(', ')}` : '**Already in the wiki?** No page names these objects.',
      ]
        .filter(Boolean)
        .join('\n\n')
      return (
        <Box flexDirection="column">
          {tabs}
          {nav}
          <Markdown text={md} />
          <Box flexDirection="row">
            <Button key="keep" variant="primary" hotkey="k" label="Keep" onPress={() => keepFinding($, item)} />
            <Button key="bin" hotkey="r" label="Bin it" onPress={() => binFinding($, item.index)} />
          </Box>
        </Box>
      )
    }
    const p = item.p
    const body = p.body.split('\n').slice(0, 40).join('\n')
    const md = [`### ${p.title}`, `${p.id} · ${p.type || 'proposal'} · ${p.priority || 'no priority'} · ${p.date}${p.reviewed ? ` · ✓ read ${p.reviewed.slice(0, 10)}` : ''}`, p.target ? `**Target** ${p.target}` : '', body].filter(Boolean).join('\n\n')
    return (
      <Box flexDirection="column">
        {tabs}
        {nav}
        <Markdown text={md} />
        <Box flexDirection="row">
          <Button key="keep" variant="primary" hotkey="k" label="Keep" onPress={() => decideProposal($, p, 'keep')} />
          <Button key="hold" hotkey="h" label="Hold" onPress={() => decideProposal($, p, 'held')} />
          <Button key="reject" hotkey="r" label="Reject" onPress={() => decideProposal($, p, 'rejected')} />
        </Box>
      </Box>
    )
  })
}
