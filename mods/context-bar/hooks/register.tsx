import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Cache, Fill } from '../types'

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

const toFill = (c: { tokens?: number; window: number; percent?: number }): Fill | null =>
  c.tokens === undefined ? null : { tokens: c.tokens, window: c.window, percent: c.percent ?? Math.round((c.tokens / c.window) * 100) }

const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`)

export const bar = (percent: number, cells = BAR_CELLS) => {
  const filled = Math.min(cells, Math.round((percent / 100) * cells))
  return '█'.repeat(filled) + '░'.repeat(cells - filled)
}

// Green until 45%, amber above 45%, red above 60%.
export const colourFor = (percent: number) => (percent > 60 ? 'error' : percent > 45 ? 'warning' : 'success')

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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const usage = await $.session.usage()
    await update($, fill, () => toFill(usage.context))
    const start = await $.clock.now()
    await update($, now, () => start)
    const m = await $.session.model()
    await update($, model, () => m)
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
    return next(e)
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

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const f = await read($, fill)
    const c = await read($, cache)
    const t = await read($, now)
    const sentWith = await read($, requestModel)
    const current = await read($, model)
    const { Box, Text } = $.ui.resolve(e)

    const pct = f?.percent ?? 0
    const barColour = colourFor(pct)
    const left = c ? minutesLeft(c, t) : 0
    const state = c ? cacheState(left, sentWith, current) : 'cold'
    const cacheLabel = state === 'warm' ? `● warm, ${left}m left` : state === 'model-changed' ? '○ cold, model changed' : '○ cold'
    const rate = c ? hitRate(c) : null

    return (
      <Box flexDirection="row">
        <Text dimColor>Context </Text>
        <Text color={barColour}>{bar(pct)}</Text>
        <Text> {f ? `${pct}% (${k(f.tokens)}/${k(f.window)})` : 'no reading yet'}</Text>
        <Text dimColor>  ·  Cache hit </Text>
        <Text>{rate === null ? '–' : `${rate}%`}</Text>
        <Text dimColor>  ·  </Text>
        <Text color={state === 'warm' ? 'success' : 'inactive'}>{cacheLabel}</Text>
      </Box>
    )
  })
}
