import type { Beat, BeatState, Row, RowStatus } from '../types'

// A beat file older than this is left over from a closed session and is removed.
export const STALE_MS = 24 * 60 * 60_000

// Reads one beat file; anything malformed is ignored.
export function parseBeat(text: string): Beat | null {
  try {
    const b = JSON.parse(text) as Partial<Beat>
    if (typeof b.id !== 'string' || typeof b.updated !== 'number' || typeof b.state !== 'string') return null
    return {
      id: b.id,
      project: String(b.project ?? ''),
      cwd: String(b.cwd ?? ''),
      state: b.state as BeatState,
      detail: String(b.detail ?? ''),
      since: Number(b.since ?? b.updated),
      updated: b.updated,
    }
  } catch {
    return null
  }
}

// One entry of `claude agents --json`, the fields the board reads.
export type Agent = {
  sessionId?: string
  id?: string
  cwd: string
  kind: 'interactive' | 'background'
  startedAt: number
  pid?: number
  status?: 'busy' | 'waiting' | 'idle'
  waitingFor?: string
  state?: string
  name?: string
}

export function parseAgents(text: string): Agent[] {
  try {
    const list = JSON.parse(text) as unknown
    return Array.isArray(list) ? (list as Agent[]).filter(a => a && typeof a.cwd === 'string') : []
  } catch {
    return []
  }
}

const WHY: Record<string, string> = {
  'permission prompt': 'wants your approval',
  'input needed': 'needs your answer',
  'sandbox request': 'wants your approval to leave the sandbox',
  'worker request': 'a helper wants your approval',
  'dialog open': 'has a question open',
}

// Open sessions: those with a live process, and background jobs still running or
// blocked. Claude Code's own list says who is busy or waiting; a session's own
// file adds what it is doing and whether its last answer asked you something.
export function merge(agents: Agent[], beats: Beat[], self: string, now: number): Row[] {
  const byId = new Map(beats.map(b => [b.id, b]))
  const rows: Row[] = []
  for (const a of agents) {
    const background = a.kind === 'background'
    if (background ? a.state !== 'working' && a.state !== 'blocked' : !a.pid) continue
    const beat = a.sessionId ? byId.get(a.sessionId) : undefined
    let status: RowStatus
    let why = ''
    if (a.status === 'waiting' || a.state === 'blocked') {
      why = WHY[a.waitingFor ?? ''] ?? 'is waiting on you'
      status = a.waitingFor === 'input needed' || a.waitingFor === 'dialog open' ? 'asked' : 'approval'
    } else if (a.status === 'busy' || (background && a.state === 'working')) {
      status = 'working'
    } else {
      status = beat?.state === 'asked' ? 'asked' : 'done'
      if (status === 'asked') why = 'asked you something'
    }
    const project = a.cwd.split('/').pop() ?? a.cwd
    rows.push({
      key: a.sessionId ?? a.id ?? `${a.cwd}-${a.startedAt}`,
      project,
      cwd: a.cwd,
      name: a.name ?? '',
      status,
      why,
      detail: beat ? beat.detail : '',
      since: beat ? beat.since : a.startedAt,
      self: !!a.sessionId && a.sessionId === self,
      background,
    })
  }
  return ordered(rows, now)
}

export const needsYou = (r: { status: RowStatus }) => r.status === 'approval' || r.status === 'asked'
// Doing something: running, or held up on you.
export const isBusy = (r: Row) => r.status === 'working' || needsYou(r)

// The button shows only when more than one session is doing something.
export const showBand = (rows: Row[]) => rows.filter(isBusy).length >= 2

// Sessions that need you first, then the working ones, then the rest; newest first within each.
export function ordered(rows: Row[], _now: number): Row[] {
  const rank = (r: Row) => (needsYou(r) ? 0 : r.status === 'working' ? 1 : 2)
  return [...rows].sort((a, b) => rank(a) - rank(b) || b.since - a.since)
}

export function ago(ms: number): string {
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d`
}

export function stateText(r: Row, now: number): string {
  const t = ago(now - r.since)
  const past = t === 'just now' ? t : `${t} ago`
  switch (r.status) {
    case 'working':
      return `working, ${t}`
    case 'approval':
    case 'asked':
      return r.why
    default:
      return `finished, ${past}`
  }
}

export const icon = (s: RowStatus) => (s === 'approval' ? '✋' : s === 'asked' ? '❓' : s === 'working' ? '⏳' : '✓')

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

// What a tool call says the session is doing. Only text the model wrote, or a
// file name, is kept: never the prompt you typed, so nothing masked leaks to disk.
export function activity(tool: string, input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const base = (p: string) => p.split('/').pop() ?? p
  switch (tool) {
    case 'Bash':
      return clip(s('description') || 'running a command', 80)
    case 'Agent':
    case 'Task':
      return clip(`helper: ${s('description') || 'working'}`, 80)
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `editing ${base(s('file_path') || s('notebook_path'))}`
    case 'Read':
      return `reading ${base(s('file_path'))}`
    case 'Grep':
    case 'Glob':
      return 'searching files'
    case 'WebSearch':
    case 'WebFetch':
      return 'searching the web'
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos) ? (input.todos as { status?: string; activeForm?: string; content?: string }[]) : []
      const now = todos.find(t => t.status === 'in_progress')
      return now ? clip(now.activeForm || now.content || 'working', 80) : 'planning'
    }
    default:
      if (tool.startsWith('mcp__')) return `using ${tool.split('__')[1] ?? 'a connector'}`
      return clip(tool, 40)
  }
}

// The last question in an answer, if it ends on one.
export function question(answer: string): string | null {
  const lines = answer.trim().split('\n').map(l => l.replace(/[*_`#>]/g, '').trim()).filter(Boolean)
  const last = lines.at(-1) ?? ''
  return last.endsWith('?') ? clip(last, 100) : null
}

// Folders that are kept but no longer worked on.
export const isArchive = (name: string) => /retired|backup|archive|\bold\b/i.test(name)

// Claude Code keeps each project's sessions in a folder named after its path.
export const sessionFolder = (home: string, dir: string) => `${home}/.claude/projects/${dir.replace(/[^A-Za-z0-9]/g, '-')}`

// Pending proposals: one file each with `status: pending`, or rows of a single table.
export function pendingInTable(text: string): number {
  return text.split('\n').filter(l => /^\|/.test(l) && /\|\s*pending\s*\|/i.test(l)).length
}

export function handoffOpen(text: string): string | null {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? ''
  if (!/^status:\s*open\s*$/m.test(fm)) return null
  const date = /^created:\s*(.+)$/m.exec(fm)?.[1]?.trim()
  return date ? `open handoff from ${date}` : 'open handoff'
}

export function openCount(text: string): number {
  return Number(/Open Count[^\d]*(\d+)/i.exec(text)?.[1] ?? 0)
}

// The rows of the first Markdown table under a heading, as cells with formatting removed.
export function tableUnder(text: string, heading: RegExp): string[][] {
  const lines = text.split('\n')
  const start = lines.findIndex(l => /^#{1,6}\s/.test(l) && heading.test(l))
  if (start < 0) return []
  const rows: string[][] = []
  for (const l of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(l)) break
    if (!l.startsWith('|')) continue
    const cells = l.split('|').slice(1, -1).map(c => c.replace(/\*\*|`/g, '').trim())
    if (cells.every(c => /^:?-+:?$/.test(c))) continue
    rows.push(cells)
  }
  return rows.slice(1)
}

// Open action items: [id, title] for each row of Active Items.
export const actionItems = (text: string) => tableUnder(text, /Active Items/i).filter(r => /^[A-Z]+-\d+/.test(r[0] ?? '')).map(r => ({ id: r[0], title: r[1] ?? '' }))

// Open blockers: the first sentence of each Active row, and since when.
export const blockers = (text: string) =>
  tableUnder(text, /^#+\s*Active\b/i)
    .filter(r => r[0])
    .map(r => ({ title: clip(r[0].split(/(?<=[.)])\s/)[0] ?? r[0], 160), since: r[1] ?? '' }))

// What an open handoff was about.
export function handoffFocus(text: string): string {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? ''
  return clip(/^session_focus:\s*(.+)$/m.exec(fm)?.[1]?.replace(/^["']|["']$/g, '') ?? '', 140)
}

// How many files wait in the ingest queue.
export const ingestCount = (text: string) => Number(/^count:\s*(\d+)/m.exec(text)?.[1] ?? 0)

// Pending proposal ids, listed briefly.
export function idList(ids: string[], max = 6): string {
  const sorted = [...ids].sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')))
  return sorted.length > max ? `${sorted.slice(0, max).join(', ')} and ${sorted.length - max} more` : sorted.join(', ')
}

// The Claude desktop app's link that opens one of its sessions.
export const jumpLink = (desktopId: string) => `claude://code/continue?session=${encodeURIComponent(desktopId)}`
// The desktop app's link that opens a new session in a folder with the prompt filled in.
export const newSessionLink = (dir: string, prompt: string) => `claude://code/new?folder=${encodeURIComponent(dir)}&q=${encodeURIComponent(prompt)}`
