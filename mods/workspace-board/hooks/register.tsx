import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { actionItems, activity, ago, blockers, handoffFocus, handoffOpen, icon, idList, ingestCount, isArchive, jumpLink, merge, needsYou, newSessionLink, parseAgents, parseBeat, pendingInTable, question, sessionFolder, showBand, STALE_MS } from './board'
import type { Band, Beat, BeatState, Review, Row, RowStatus } from '../types'

const PANE = 'workspace-board'
const rowsAtom = atom({ plugin: 'workspace-board', key: 'rows' } as const, [] as Row[])
const reviewsAtom = atom({ plugin: 'workspace-board', key: 'reviews' } as const, [] as Review[])
const checkingAtom = atom({ plugin: 'workspace-board', key: 'checking' } as const, false)
const hiddenAtom = atom({ plugin: 'workspace-board', key: 'hidden' } as const, 0)
// Read by the context bar, which draws the Board button and the short summary on its own line.
const bandAtom = atom({ plugin: 'workspace-board', key: 'band' } as const, { present: false, summary: '', waiting: false } as Band)

const POLL_MS = 15_000
// A project counts as in progress when a session ran there within this window.
const ACTIVE_DAYS = 30

let home = ''
let dir = ''
let me: Beat | null = null
let claude: string | null = null
let listFailed = false
let started = false
// What each other session last showed, so a toast fires once per change.
const seen = new Map<string, RowStatus>()

// The claude command, found once: the session list comes from `claude agents --json`.
async function findClaude($: EngineInterface): Promise<string | null> {
  for (const c of ['claude', `${home}/.npm-global/bin/claude`, `${home}/.local/bin/claude`, `${home}/.claude/local/claude`, '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) {
    const r = await $.process.run([c, '--version'], { timeoutMs: 5000 }).catch(() => null)
    if (r && r.exitCode === 0) return c
  }
  return null
}

async function save($: EngineInterface, state: BeatState, detail: string) {
  if (!me || !dir) return
  const now = await $.clock.now()
  me = { ...me, state, detail: detail || me.detail, since: state === me.state ? me.since : now, updated: now }
  await $.fs.write(`${dir}/${me.id}.json`, JSON.stringify(me)).catch(() => {})
}

// The short line for the context bar: who is working and who is waiting on you.
function band(rows: Row[]): Band {
  if (!showBand(rows)) return { present: true, summary: '', waiting: false }
  const working = rows.filter(r => r.status === 'working').length
  const waiting = rows.filter(r => !r.self && needsYou(r))
  const parts = [`${working} working`, ...waiting.map(r => `${icon(r.status)} ${r.project}`)]
  return { present: true, summary: parts.join('  '), waiting: waiting.length > 0 }
}

// Reads the open sessions and every session's own file, and tells you when
// another session starts waiting on you.
async function scan($: EngineInterface) {
  if (!dir) return
  const now = await $.clock.now()
  const beats: Beat[] = []
  for (const f of await $.fs.list(dir).catch(() => [])) {
    if (!f.name.endsWith('.json')) continue
    const path = `${dir}/${f.name}`
    const b = parseBeat(await $.fs.read(path).catch(() => ''))
    if (!b) continue
    if (now - b.updated > STALE_MS) await $.process.run(['rm', '-f', path]).catch(() => {})
    else beats.push(b.id === me?.id ? me : b)
  }
  if (claude === null) claude = await findClaude($)
  const r = claude ? await $.process.run([claude, 'agents', '--json'], { timeoutMs: 10000 }).catch(() => null) : null
  listFailed = !r || r.exitCode !== 0
  if (!r || listFailed) return
  const rows = merge(parseAgents(r.stdout), beats, me?.id ?? '', now)
  for (const row of rows) {
    if (row.self) continue
    if (needsYou(row) && seen.get(row.key) !== row.status) $.ui.toast(`${icon(row.status)} ${row.project} ${row.why}`, { timeoutMs: 6000 })
    seen.set(row.key, row.status)
  }
  await update($, rowsAtom, () => rows)
  await update($, bandAtom, () => band(rows))
}

// When a session last ran in this project, from Claude Code's own session folder.
async function lastActive($: EngineInterface, cwd: string): Promise<number> {
  const entries = await $.fs.list(sessionFolder(home, cwd)).catch(() => [])
  return entries.reduce((m, e) => Math.max(m, e.mtimeMs), 0)
}

// Everything waiting for your review or action in one project: proposals to read,
// blockers, action items, an open handoff, files waiting to be ingested.
async function projectReviews($: EngineInterface, dir: string): Promise<Review[]> {
  const project = dir.split('/').pop() ?? dir
  const out: Review[] = []
  const add = (r: Omit<Review, 'project' | 'dir' | 'fillOnly'> & { fillOnly?: boolean }) => out.push({ project, dir, fillOnly: false, ...r, key: `${dir}#${r.key}` })
  const read = (f: string) => $.fs.read(`${dir}/${f}`).catch(() => '')

  const props = `${dir}/wiki/pending/proposals`
  if (await $.fs.exists(props)) {
    const ids: string[] = []
    for (const f of await $.fs.list(props).catch(() => [])) {
      if (f.kind === 'file' && f.name.endsWith('.md') && /^status:\s*pending\s*$/m.test(await $.fs.read(`${props}/${f.name}`).catch(() => ''))) ids.push(f.name.replace(/\.md$/, ''))
    }
    if (ids.length) add({ key: 'proposals', kind: 'proposals', label: `${ids.length} proposal${ids.length === 1 ? '' : 's'} to review`, text: idList(ids), button: 'Review', command: '@sarah queue' })
  } else {
    const n = pendingInTable(await read('wiki/pending/update-proposals.md'))
    if (n) add({ key: 'proposals', kind: 'proposals', label: `${n} proposal${n === 1 ? '' : 's'} to review`, text: 'In the proposal table', button: 'Review', command: '@sarah queue' })
  }

  const handoffText = await read('wiki/pending/handoff.md')
  const handoff = handoffOpen(handoffText)
  if (handoff) add({ key: 'handoff', kind: 'handoff', label: `Handoff, ${handoff.replace(/^open handoff from /, 'left ').replace(/^open handoff$/, 'open')}`, text: handoffFocus(handoffText) || 'Pick up where the last session left off', button: 'Resume', command: '@alex resume-handoff' })

  for (const [n, b] of blockers(await read('wiki/pending/blockers.md')).entries())
    add({ key: `blocker-${n}`, kind: 'blocker', label: `Blocker${b.since ? `, since ${b.since}` : ''}`, text: b.title, button: 'Open', command: `Let's look at the open blocker: ${b.title}`, fillOnly: true })

  for (const a of actionItems(await read('wiki/pending/action-items.md')))
    add({ key: a.id, kind: 'action', label: `Action item ${a.id}`, text: a.title, button: 'Run', command: `Run action item ${a.id}` })

  const ingest = ingestCount(await read('wiki/pending/ingest-queue.md'))
  if (ingest) add({ key: 'ingest', kind: 'ingest', label: `${ingest} file${ingest === 1 ? '' : 's'} to ingest`, text: 'Waiting in other_sources', button: 'Show', command: '@kylie list' })
  return out
}

// Every project in progress: one with a session open now, or worked on in the
// last few weeks. Retired and backup folders are left out.
async function check($: EngineInterface) {
  await update($, checkingAtom, () => true)
  const parent = (me?.cwd ?? (await $.session.root())).replace(/\/[^/]+$/, '')
  const open = new Set((await read($, rowsAtom)).map(r => r.cwd))
  const since = (await $.clock.now()) - ACTIVE_DAYS * 86_400_000
  const reviews: Review[] = []
  let hidden = 0
  for (const e of await $.fs.list(parent).catch(() => [])) {
    if (e.kind !== 'dir' || e.name.startsWith('.')) continue
    const d = `${parent}/${e.name}`
    if (!open.has(d) && (isArchive(e.name) || (await lastActive($, d)) < since)) {
      hidden++
      continue
    }
    reviews.push(...(await projectReviews($, d)))
  }
  const here = me?.cwd ?? ''
  const rank: Record<Review['kind'], number> = { blocker: 0, handoff: 1, proposals: 2, action: 3, ingest: 4 }
  reviews.sort((a, b) => Number(b.dir === here) - Number(a.dir === here) || a.project.localeCompare(b.project) || rank[a.kind] - rank[b.kind])
  await update($, reviewsAtom, () => reviews)
  await update($, hiddenAtom, () => hidden)
  await update($, checkingAtom, () => false)
}

// The desktop app's own id for a session, found from the session id in its records.
async function desktopId($: EngineInterface, sessionId: string): Promise<string | null> {
  const root = `${home}/Library/Application Support/Claude/claude-code-sessions`
  const r = await $.process.run(['grep', '-rlF', '--include=local_*.json', sessionId, root], { timeoutMs: 8000 }).catch(() => null)
  const file = r?.stdout.split('\n').find(Boolean)
  return file ? (file.split('/').pop() ?? '').replace(/\.json$/, '') : null
}

async function jump($: EngineInterface, row: Row) {
  const id = await desktopId($, row.key)
  if (!id) {
    $.ui.toast(`${row.project} is not a desktop app session; switch to it in its terminal.`, { timeoutMs: 6000 })
    return
  }
  await $.process.run(['open', jumpLink(id)], { timeoutMs: 5000 }).catch(() => {})
}

// Here: sends the command (or fills it in). Another project: opens a new session there with it filled in.
async function act($: EngineInterface, r: Review) {
  if (r.dir === me?.cwd) {
    if (r.fillOnly) await $.prompt.fill({ text: r.command, mode: 'replace' })
    else await $.prompt.submit({ text: r.command })
    return
  }
  await $.process.run(['open', newSessionLink(r.dir, r.command)], { timeoutMs: 5000 }).catch(() => {})
}

async function openBoard($: EngineInterface) {
  await scan($)
  await $.ui.open({ id: PANE, title: 'Workspace board', focus: true })
  void check($)
}

// Once per load: note this session, show the Board button, and keep the list fresh.
async function start($: EngineInterface, cwd: string) {
  if (started) return
  started = true
  home = (await $.env.get('HOME')) ?? ''
  if (!home) return
  dir = `${home}/.claude/workspace-board/sessions`
  const root = await $.session.root().catch(() => cwd)
  const now = await $.clock.now()
  me = { id: await $.session.id(), project: root.split('/').pop() ?? root, cwd: root, state: 'done', detail: '', since: now, updated: now }
  await save($, 'done', '')
  await update($, bandAtom, () => ({ present: true, summary: '', waiting: false }))
  await $.command.register({ name: 'board', description: 'Open the workspace board: sessions in progress and what is open for you in each project' })
  await scan($).catch(() => {})
  $.clock.every(POLL_MS, () => void scan($).catch(() => {}))
}

export const register: Register = on => {
  // Every session starts the board when it opens. The desktop app reports no person at
  // start, so this cannot wait for one; and starting from a drawing fails, because the app
  // refuses the writes start makes (the button and /board) while a drawing is under way.
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await start($, e.cwd).catch(() => {})
    return r
  })

  on('session.end', async ($, e, next) => {
    if (me && dir) await $.process.run(['rm', '-f', `${dir}/${me.id}.json`], { timeoutMs: 1000 }).catch(() => {})
    return next(e)
  })

  on('command.run', { command: 'board' }, async $ => {
    await openBoard($)
    return { text: listFailed ? 'Workspace board opened, but the list of open sessions could not be read.' : 'Workspace board opened.' }
  })

  on('turn.start', async ($, e, next) => {
    await save($, 'working', 'thinking')
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    const q = e.reason === 'answer' ? question(r.text) : null
    await save($, q ? 'asked' : 'done', q ?? (e.reason === 'answer' ? 'finished' : e.reason === 'aborted' ? 'stopped' : 'stopped on an error'))
    return r
  })

  // Notes what the session is doing. It never changes or blocks a call.
  on('tool.call', async ($, e, next) => {
    if (!e.agentId) await save($, 'working', activity(String(e.tool), e as unknown as Record<string, unknown>)).catch(() => {})
    return next(e)
  })

  // The context bar's Board button asks for the board by writing its own value.
  on('state.set', async ($, e, next) => {
    const r = await next(e)
    const w = e as unknown as { plugin?: string; key?: string }
    if (w.plugin === 'context-bar' && w.key === 'boardAsk') await openBoard($)
    return r
  })

  // Laid out as stacked cards so it reads in the narrow side panel as well as a wide one.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const rows = await read($, rowsAtom)
    const reviews = await read($, reviewsAtom)
    const checking = await read($, checkingAtom)
    const hidden = await read($, hiddenAtom)
    const now = Date.now()

    const waiting = rows.filter(r => needsYou(r) && !r.self)
    const working = rows.filter(r => r.status === 'working')
    const count = (k: Review['kind']) => reviews.filter(r => r.kind === k).length
    const proposals = reviews.filter(r => r.kind === 'proposals').reduce((t, r) => t + (Number(/^(\d+)/.exec(r.label)?.[1]) || 0), 0)

    const tile = (key: string, value: number, label: string, colour?: 'warning' | 'error') => (
      <Box key={key} flexDirection="column" borderStyle="round" paddingX={1} minWidth={12} alignItems="center">
        <Text bold color={value ? colour : 'inactive'}>{String(value)}</Text>
        <Text dimColor>{label}</Text>
      </Box>
    )

    const card = (key: string, label: string, colour: 'warning' | 'error' | 'success' | undefined, text: string, buttons: { key: string; label: string; onPress: () => unknown }[]) => (
      <Box key={key} flexDirection="column" borderStyle="round" paddingX={1}>
        <Text color={colour} bold>{label}</Text>
        <Text wrap="wrap">{text}</Text>
        {buttons.length ? (
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            {buttons.map(b => <Button key={b.key} label={b.label} onPress={b.onPress} />)}
          </Box>
        ) : null}
      </Box>
    )

    const tone = (k: Review['kind']) => (k === 'blocker' ? 'error' : k === 'proposals' || k === 'handoff' ? 'warning' : undefined)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {tile('k-wait', waiting.length, 'waiting', 'warning')}
          {tile('k-rev', proposals, 'to review', 'warning')}
          {tile('k-hand', count('handoff'), 'handoffs')}
          {tile('k-block', count('blocker'), 'blockers', 'error')}
          {tile('k-act', count('action'), 'action items')}
        </Box>

        <Box flexDirection="column" gap={1}>
          <Text bold>Sessions waiting on you</Text>
          {listFailed ? <Text color="warning">The list of open sessions could not be read just now.</Text> : null}
          {waiting.length === 0 ? <Text dimColor>No session is waiting on you.</Text> : null}
          {waiting.map(r =>
            card(`s-${r.key}`, `${icon(r.status)} ${r.project}`, 'warning', `${r.why}${r.detail ? `: ${r.detail}` : ''} (${ago(now - r.since)})`, [{ key: `j-${r.key}`, label: 'Jump to session', onPress: () => jump($, r) }]),
          )}
        </Box>

        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row">
            <Text bold>Waiting for your review  </Text>
            {checking ? <Text dimColor>checking…</Text> : null}
          </Box>
          {!checking && reviews.length === 0 ? <Text dimColor>Nothing waiting for your review.</Text> : null}
          {reviews.map(r =>
            card(`r-${r.key}`, `${r.label} · ${r.project}${r.dir === me?.cwd ? ' (here)' : ''}`, tone(r.kind), r.text, [{ key: `a-${r.key}`, label: r.button, onPress: () => act($, r) }]),
          )}
        </Box>

        {working.length ? (
          <Box flexDirection="column" gap={1}>
            <Text bold>Working now</Text>
            {working.map(r =>
              card(`w-${r.key}`, `⏳ ${r.project}${r.self ? ' (here)' : ''}`, 'success', `${r.detail || 'working'} (${ago(now - r.since)})`, r.self ? [] : [{ key: `wj-${r.key}`, label: 'Jump to session', onPress: () => jump($, r) }]),
            )}
          </Box>
        ) : null}

        <Text dimColor>{`Projects worked on in the last ${ACTIVE_DAYS} days.${hidden ? ` ${hidden} quiet, retired or backup folders hidden.` : ''} In another project, a button opens a new session there with the step filled in.`}</Text>
        <Box flexDirection="row">
          <Button key="refresh" label="Refresh" onPress={() => openBoard($)} />
        </Box>
      </Box>
    )
  })
}
