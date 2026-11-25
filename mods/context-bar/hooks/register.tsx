import { atom, read, update } from 'claude-code'
import type { CoreEngineInterface, Register } from 'claude-code'

import type { Cache, CoreRoom, Fill, Plan, Points } from '../types'

// How long the prompt cache lives after the last request. This session runs on
// the 1-hour cache; set to 5 for the standard API cache.
const CACHE_TTL_MIN = 60
const BAR_CELLS = 20

const fill = atom({ plugin: 'context-bar', key: 'fill' } as const, null)
const cache = atom({ plugin: 'context-bar', key: 'cache' } as const, null)
const now = atom({ plugin: 'context-bar', key: 'now' } as const, 0)
const requestAt = atom({ plugin: 'context-bar', key: 'requestAt' } as const, null)
// The model the last request went to, and the session's model now. The cache
// belongs to one model, so a switch leaves the next message without it.
const requestModel = atom({ plugin: 'context-bar', key: 'requestModel' } as const, null)
const model = atom({ plugin: 'context-bar', key: 'model' } as const, null)
// The workspace board, when installed: its Board button sits at the end of this line.
const board = atom({ plugin: 'workspace-board', key: 'band' } as const, { present: false, summary: '', waiting: false })
const boardAsk = atom({ plugin: 'context-bar', key: 'boardAsk' } as const, 0)
// When the control panel's band is drawn, the Board button sits there beside Commands instead.
const panelShown = atom({ plugin: 'control-panel', key: 'shown' } as const, false)
// How much of the plan is left: shown when it runs low, and never a reason to hold a helper.
const plan = atom({ plugin: 'context-bar', key: 'plan' } as const, [] as Plan[])
// This session's title in the app, which says whether it is a Core or a helper.
const title = atom({ plugin: 'context-bar', key: 'title' } as const, null as string | null)
const titleAt = atom({ plugin: 'context-bar', key: 'titleAt' } as const, 0)
// The hand-over points read from SolveFoundry's settings, and when they were read.
const points = atom({ plugin: 'context-bar', key: 'points' } as const, null as Points | null)
const pointsAt = atom({ plugin: 'context-bar', key: 'pointsAt' } as const, 0)

// Context checkpoint (ways-of-working.md): a coordinator (a title with "Core") hands over at 60%, a helper at 55%.
// In SolveFoundry the settings give the points: a Core's is context.coreHandoffAt, and a builder has two, taking no
// new job from context.helperStopAt but finishing the one it holds (its reviewer included), and pausing at
// context.helperPauseAt. Past its hand-over point a session may not start more helpers, only hand over.
const HELPER_LIMIT = 55
const CORE_LIMIT = 60
const HAND_OVER_HOLDS = new Set(['Agent', 'Task', 'Workflow', 'mcp__ccd_session__start_session'])
// SolveFoundry's settings beneath the session's project root (which a shell `cd` does not move), and the framework
// name that marks them.
const SETTINGS_FILE = 'setup/config.json'
const FRAMEWORK = 'SolveFoundry'
// The range setup/config.schema.json gives the context points; the framework uses the default for a value outside it.
const POINT_MIN = 15
const POINT_MAX = 90

// How a SolveFoundry Core meets its point (context.coreRoom): under `rotation` it hands over to a spare Core, as
// before; under `cutback` (the framework's default) or `cutback-summary` it cuts its own conversation back, and
// SolveFoundry's hooks/cores.py gives that reminder, so this mod neither reminds nor holds it.
const CORE_ROOMS: readonly CoreRoom[] = ['cutback', 'rotation', 'cutback-summary']
const DEFAULT_CORE_ROOM: CoreRoom = 'cutback'

// Outside SolveFoundry, or with its settings unreadable, the old points and the hand-over hold, so the notice never
// goes quiet.
const DEFAULT_POINTS: Points = { stopAt: null, pauseAt: HELPER_LIMIT, coreAt: CORE_LIMIT, coreRoom: 'rotation' }

const isPoint = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= POINT_MIN && v <= POINT_MAX

// The points from the text of SolveFoundry's settings file: DEFAULT_POINTS for another project's file or one that
// cannot be read. A builder's two points that are missing, out of range or out of order keep the helper default, and
// a Core's point that is missing or out of range keeps the Core default. A coreRoom that is missing or unknown is
// the framework's default, cutback.
export const pointsFrom = (text: string | null): Points => {
  if (!text) return DEFAULT_POINTS
  try {
    const settings = JSON.parse(text) as {
      framework?: { name?: unknown }
      context?: { helperStopAt?: unknown; helperPauseAt?: unknown; coreHandoffAt?: unknown; coreRoom?: unknown }
    }
    if (settings.framework?.name !== FRAMEWORK) return DEFAULT_POINTS
    const { helperStopAt: stopAt, helperPauseAt: pauseAt, coreHandoffAt: coreAt, coreRoom: room } = settings.context ?? {}
    const helper = isPoint(stopAt) && isPoint(pauseAt) && stopAt <= pauseAt ? { stopAt, pauseAt } : DEFAULT_POINTS
    const coreRoom = CORE_ROOMS.find(r => r === room) ?? DEFAULT_CORE_ROOM
    return { stopAt: helper.stopAt, pauseAt: helper.pauseAt, coreAt: isPoint(coreAt) ? coreAt : CORE_LIMIT, coreRoom }
  } catch {
    return DEFAULT_POINTS
  }
}

export const isCore = (t: string | null) => t !== null && /\bcore\b/i.test(t)
// With no title to read (no app, or it has not answered), the stricter of the two hand-over points holds.
export const limitFor = (sessionTitle: string | null, p: Points = DEFAULT_POINTS) =>
  sessionTitle === null ? Math.min(p.coreAt, p.pauseAt) : isCore(sessionTitle) ? p.coreAt : p.pauseAt
// No context reading fails open: nothing is held.
export const pastLimit = (f: Fill | null, sessionTitle: string | null, p: Points = DEFAULT_POINTS) =>
  f !== null && f.percent >= limitFor(sessionTitle, p)
// A Core that cuts its own conversation back at its point instead of handing over: no hand-over reminder or hold.
// Points an earlier version stored carry no coreRoom, and keep the hand-over.
export const cutsBack = (sessionTitle: string | null, p: Points = DEFAULT_POINTS) =>
  isCore(sessionTitle) && (p.coreRoom === 'cutback' || p.coreRoom === 'cutback-summary')
// Past the point and due to hand over: every session past it but a Core that cuts back.
const handsOver = (f: Fill | null, sessionTitle: string | null, p: Points = DEFAULT_POINTS) =>
  pastLimit(f, sessionTitle, p) && !cutsBack(sessionTitle, p)
// A titled helper between its two SolveFoundry points: it finishes its job, starting helpers as it needs, and takes
// no new one.
const noNewJob = (f: Fill | null, sessionTitle: string | null, p: Points = DEFAULT_POINTS) =>
  f !== null && sessionTitle !== null && !isCore(sessionTitle) && p.stopAt !== null && f.percent >= p.stopAt && !pastLimit(f, sessionTitle, p)
// The lowest point that could apply to this session, below which no title or settings need reading.
const firstPoint = (p: Points) => Math.min(p.coreAt, p.stopAt ?? p.pauseAt, p.pauseAt)
// Shown on the bar so anyone can see which limit applies and that the title was read.
export const roleLabel = (sessionTitle: string | null, p: Points = DEFAULT_POINTS) => {
  if (sessionTitle === null) return `limit ${limitFor(null, p)}, title not read`
  if (isCore(sessionTitle)) return `Core, limit ${p.coreAt}`
  return p.stopAt === null ? `helper, limit ${p.pauseAt}` : `helper, no new job ${p.stopAt}, limit ${p.pauseAt}`
}
export const reminder = (percent: number) => `Context at ${percent} per cent: hand over now (ways-of-working, Context checkpoint)`
const stopReminder = (percent: number) =>
  `Context at ${percent} per cent: take no new job; finish the one you hold, its reviews included (context.helperStopAt)`

// The title from the app's get_session answer, or null when there is none.
export const titleFrom = (r: { content: readonly { type: string; text?: string }[]; isError: boolean }): string | null => {
  if (r.isError) return null
  for (const b of r.content) {
    if (b.type !== 'text' || !b.text) continue
    try {
      const v = JSON.parse(b.text) as { title?: unknown }
      if (typeof v.title === 'string') return v.title
    } catch {
      // not JSON; try the next block
    }
  }
  return null
}

// Reads the title from the app at most once a minute once known; while
// unknown it asks each time it matters (only from 50% up). Never throws.
// (Declared after the atoms it reads.)
async function refreshTitle($: Pick<CoreEngineInterface, 'state' | 'mcp'>) {
  try {
    // The bar's own clock, which ticks every 30s, is fine for a once-a-minute check.
    const t = await read($, now)
    if ((await read($, title)) !== null && t - (await read($, titleAt)) < 60000) return
    const found = titleFrom(await $.mcp.call('ccd_session_mgmt', 'get_session', { session_id: 'self' }))
    if (found !== null) {
      await update($, titleAt, () => t)
      await update($, title, () => found)
    }
  } catch {
    // No app session tools here (a terminal session): the helper limit holds.
  }
}

// Reads the hand-over points from SolveFoundry's settings beneath the project root at most once a minute;
// DEFAULT_POINTS when there are none. Never throws. (Declared after the atoms it reads.)
async function refreshPoints($: Pick<CoreEngineInterface, 'state' | 'fs' | 'session'>): Promise<Points> {
  try {
    const readAt = await read($, now)
    const known = await read($, points)
    if (known !== null && readAt - (await read($, pointsAt)) < 60000) return known
    const root = await $.session.root()
    const text = await $.fs.read(`${root}/${SETTINGS_FILE}`).then(v => (typeof v === 'string' ? v : null), () => null)
    const found = pointsFrom(text)
    await update($, pointsAt, () => readAt)
    await update($, points, () => found)
    return found
  } catch {
    // No file system, session or state here: the old points hold.
    return DEFAULT_POINTS
  }
}

const toFill = (c: { tokens?: number; window: number; percent?: number }): Fill | null =>
  c.tokens === undefined ? null : { tokens: c.tokens, window: c.window, percent: c.percent ?? Math.round((c.tokens / c.window) * 100) }

const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`)

export const bar = (percent: number, cells = BAR_CELLS) => {
  const filled = Math.min(cells, Math.round((percent / 100) * cells))
  return '█'.repeat(filled) + '░'.repeat(cells - filled)
}

// Green until 45%, amber above 45%, red from the session's hand-over limit.
export const colourFor = (percent: number, limit: number) => (percent >= limit ? 'error' : percent > 45 ? 'warning' : 'success')

export const hitRate = (c: Cache) => {
  const total = c.read + c.write + c.input
  return total === 0 ? 0 : Math.round((c.read / total) * 100)
}

// The cache lifetime runs from the start of the request that read or wrote it,
// so the countdown starts when the turn's last request went out, not when the
// turn ended. Without a request time, the turn's end is the fallback.
export const cacheFrom = (
  u: { cache_read_input_tokens: number; cache_creation_input_tokens: number; input_tokens: number },
  sentAt: number | null,
  endedAt: number,
): Cache => ({ read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, input: u.input_tokens, at: sentAt ?? endedAt })

export const minutesLeft = (c: Cache, at: number) => Math.max(0, Math.ceil(CACHE_TTL_MIN - (at - c.at) / 60000))

export type CacheState = 'warm' | 'cold' | 'model-changed'

export const cacheState = (minutes: number, sentWith: string | null, current: string | null): CacheState =>
  minutes <= 0 ? 'cold' : sentWith !== null && current !== null && sentWith !== current ? 'model-changed' : 'warm'

// The plan's windows as left, not used: the five-hour one first, then the week.
export const toPlan = (limits: readonly { kind: string; percentUsed: number; resetsAt?: string }[]): Plan[] =>
  limits
    .filter(l => l.kind === 'five_hour' || l.kind === 'seven_day')
    .map(l => ({ kind: l.kind, left: Math.max(0, Math.round(100 - l.percentUsed)), resetsAt: l.resetsAt ?? null }))
    .sort((a, b) => (a.kind === 'five_hour' ? -1 : b.kind === 'five_hour' ? 1 : 0))

// The lowest window left decides how the plan is shown.
export const lowest = (p: readonly Plan[]): number | null => (p.length ? Math.min(...p.map(w => w.left)) : null)
// Shown only when it matters: once any window is below twice the floor.
export const planWorthShowing = (p: readonly Plan[], floor: number) => (lowest(p) ?? 100) < floor * 2
export const planColour = (left: number, floor: number) => (left < floor ? 'error' : left < floor * 2 ? 'warning' : 'success')
const windowName = (kind: string) => (kind === 'five_hour' ? '5h' : 'week')

export const register: Register = (on, options) => {
  // The plan floor only colours and shows the plan left; helpers are never held for plan usage.
  const floor = Number(options?.helperFloor ?? 20) || 20

  on('session.start', async ($, e, next) => {
    const usage = await $.session.usage()
    await update($, fill, () => toFill(usage.context))
    const start = await $.clock.now()
    await update($, now, () => start)
    const m = await $.session.model()
    await update($, model, () => m)
    const p = toPlan(usage.rateLimits ?? [])
    if (p.length) await update($, plan, () => p)
    void refreshTitle($)
    void refreshPoints($)
    // Redraw every 30s so the cache countdown stays honest while idle, and
    // pick up a model switch made since the last request.
    $.clock.every(30000, () => {
      void $.clock.now().then(t => update($, now, () => t))
      void $.session.model().then(m => update($, model, () => m))
    })
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const f = toFill(e.context)
    if (f) await update($, fill, () => f)
    if (f && f.percent >= 50) {
      void refreshTitle($)
      void refreshPoints($)
    }
    const p = toPlan(e.rateLimits ?? [])
    if (p.length) await update($, plan, () => p)
    return next(e)
  })

  // Past the context limit, a session hands over instead of starting helpers or
  // sessions; everything else (reads, edits, git, SendMessage, archive) still runs.
  // The plan left never holds a helper.
  on('tool.call', async ($, e, next) => {
    if (e.agentId) return next(e)
    const tool = String(e.tool)
    if (HAND_OVER_HOLDS.has(tool)) {
      const f = await read($, fill)
      const sessionPoints = f ? await refreshPoints($) : DEFAULT_POINTS
      if (f && f.percent >= firstPoint(sessionPoints)) {
        await refreshTitle($)
        if (handsOver(f, await read($, title), sessionPoints)) {
          return {
            deny: `context-bar: ${reminder(f.percent)}. Do not start a helper or session from here: write your handoff or PAUSED.md and pass the work on (SendMessage to your coordinator, or the handoff playbook if you are a Core).`,
          }
        }
      }
    }
    return next(e)
  })

  // Each turn past the limit carries a one-line reminder for the model.
  on('prompt.submit', async ($, e, next) => {
    const f = await read($, fill)
    if (!f) return next(e)
    const sessionPoints = await refreshPoints($)
    if (f.percent < firstPoint(sessionPoints)) return next(e)
    await refreshTitle($)
    const sessionTitle = await read($, title)
    const words = handsOver(f, sessionTitle, sessionPoints) ? reminder(f.percent) : noNewJob(f, sessionTitle, sessionPoints) ? stopReminder(f.percent) : null
    return words === null ? next(e) : next({ ...e, context: [...(e.context ?? []), words] })
  })

  // Each step is one request to the model; stamp it as it goes out.
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      const t = await $.clock.now()
      await update($, requestAt, () => t)
      const m = await $.session.model()
      await update($, requestModel, () => m)
      await update($, model, () => m)
    }
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId && e.usage) {
      const t = await $.clock.now()
      const u = e.usage
      const sentAt = await read($, requestAt)
      await update($, cache, () => cacheFrom(u, sentAt, t))
      await update($, now, () => t)
    }
    return next(e)
  })

  // Draws its line first, then whatever other plugins draw in the band beneath it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below

    const f = await read($, fill)
    const c = await read($, cache)
    const t = await read($, now)
    const sentWith = await read($, requestModel)
    const current = await read($, model)
    const b = await read($, board)
    const panel = await read($, panelShown)
    const p = await read($, plan)
    const { Box, Text, Button } = $.ui.resolve(e)

    const pct = f?.percent ?? 0
    const sessionTitle = await read($, title)
    const sessionPoints = (await read($, points)) ?? DEFAULT_POINTS
    const handOver = handsOver(f, sessionTitle, sessionPoints)
    const cutBack = pastLimit(f, sessionTitle, sessionPoints) && cutsBack(sessionTitle, sessionPoints)
    const stopping = noNewJob(f, sessionTitle, sessionPoints)
    const barColour = colourFor(pct, limitFor(sessionTitle, sessionPoints))
    const left = c ? minutesLeft(c, t) : 0
    const state = c ? cacheState(left, sentWith, current) : 'cold'
    const cacheLabel = state === 'warm' ? `● warm, ${left}m left` : state === 'model-changed' ? '○ cold, model changed' : '○ cold'
    const rate = c ? hitRate(c) : null

    const line = (
      <Box flexDirection="row" flexWrap="wrap">
        <Text dimColor>Context </Text>
        <Text color={barColour}>{bar(pct)}</Text>
        <Text> {f ? `${pct}% (${k(f.tokens)}/${k(f.window)})` : 'no reading yet'}</Text>
        <Text dimColor>  ({roleLabel(sessionTitle, sessionPoints)})</Text>
        {handOver ? <Text color="error">  hand over now</Text> : null}
        {cutBack ? <Text color="warning">  cut back</Text> : null}
        {stopping ? <Text color="warning">  no new job</Text> : null}
        <Text dimColor>  ·  Cache hit </Text>
        <Text>{rate === null ? '–' : `${rate}%`}</Text>
        <Text dimColor>  ·  </Text>
        <Text color={state === 'warm' ? 'success' : 'inactive'}>{cacheLabel}</Text>
        {/* Plan left appears only when it is getting low; one piece, so it wraps whole on a narrow panel. */}
        {planWorthShowing(p, floor) ? (
          <Box key="plan-part" flexDirection="row">
            <Text dimColor>  ·  Plan left </Text>
            {p.map((w, i) => (
              <Text key={w.kind} color={planColour(w.left, floor)}>{`${i ? ', ' : ''}${w.left}% (${windowName(w.kind)})`}</Text>
            ))}
          </Box>
        ) : null}
        {/* The board's part is one piece, so on a narrow panel it moves to the next row whole instead of being cut off. */}
        {b.present && (b.summary || !panel) ? (
          <Box key="board-part" flexDirection="row">
            {b.summary ? <Text dimColor>  ·  </Text> : null}
            {b.summary ? <Text color={b.waiting ? 'warning' : undefined}>{b.summary}</Text> : null}
            {panel ? null : <Text>  </Text>}
            {panel ? null : <Button key="board" label="Board" onPress={() => update($, boardAsk, v => (v ?? 0) + 1)} />}
          </Box>
        ) : null}
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
}
