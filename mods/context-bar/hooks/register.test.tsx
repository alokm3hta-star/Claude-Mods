import { test, expect } from 'claude-code/testing'

import { bar, cacheFrom, cacheState, colourFor, cutsBack, hitRate, isCore, limitFor, lowest, minutesLeft, pastLimit, planColour, planWorthShowing, pointsFrom, roleLabel, toPlan } from './register'

test('bar fills in proportion to the percentage', async () => {
  expect(bar(0, 10)).toBe('░░░░░░░░░░')
  expect(bar(50, 10)).toBe('█████░░░░░')
  expect(bar(120, 10)).toBe('██████████')
})

test('hit rate is cache reads over all input tokens', async () => {
  expect(hitRate({ read: 90, write: 5, input: 5, at: 0 })).toBe(90)
  expect(hitRate({ read: 0, write: 0, input: 0, at: 0 })).toBe(0)
})

test('cache countdown runs from the last request and stops at zero', async () => {
  const c = { read: 1, write: 0, input: 0, at: 0 }
  expect(minutesLeft(c, 10 * 60000)).toBe(50)
  expect(minutesLeft(c, 90 * 60000)).toBe(0)
})

test('the band draws on terminal and desktop', async ($, on) => {
  // Beneath the plugin: nothing else draws in the band.
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as never
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'context-bar', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, columns: 100 } as never })
    expect(await ui.find({ type: 'Text', text: /Context/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /cold/ })).toBeDefined()
    await ui.unmount()
  }
})

test('bar is green to 45%, amber above 45%, red from the hand-over limit', async () => {
  expect(colourFor(45, 55)).toBe('success')
  expect(colourFor(46, 55)).toBe('warning')
  expect(colourFor(54, 55)).toBe('warning')
  expect(colourFor(55, 55)).toBe('error')
  expect(colourFor(59, 60)).toBe('warning')
  expect(colourFor(60, 60)).toBe('error')
})

test('countdown starts when the last request went out, not when the turn ended', async () => {
  const usage = { cache_read_input_tokens: 90, cache_creation_input_tokens: 5, input_tokens: 5 }
  const sent = 0
  const ended = 10 * 60000
  const c = cacheFrom(usage, sent, ended)
  expect(c.at).toBe(sent)
  expect(minutesLeft(c, ended)).toBe(50)
  expect(cacheFrom(usage, null, ended).at).toBe(ended)
})

test('a model switch since the last request shows the cache as cold', async () => {
  expect(cacheState(30, 'opus', 'opus')).toBe('warm')
  expect(cacheState(30, 'opus', 'sonnet')).toBe('model-changed')
  expect(cacheState(0, 'opus', 'sonnet')).toBe('cold')
  expect(cacheState(30, null, 'opus')).toBe('warm')
})

test('plan is shown as left, five-hour first; the lowest window decides how it shows', async () => {
  const p = toPlan([
    { kind: 'seven_day', percentUsed: 20 },
    { kind: 'five_hour', percentUsed: 85.5, resetsAt: '2026-10-09T22:00:00Z' },
    { kind: 'spend_limit', percentUsed: 1 },
  ])
  expect(p.map(w => [w.kind, w.left])).toEqual([['five_hour', 15], ['seven_day', 80]])
  expect(lowest(p)).toBe(15)
  expect(planWorthShowing(p, 20)).toBe(true)
  expect(planWorthShowing(toPlan([{ kind: 'five_hour', percentUsed: 50 }]), 20)).toBe(false)
  expect(planColour(15, 20)).toBe('error')
  expect(planColour(30, 20)).toBe('warning')
  expect(planColour(60, 20)).toBe('success')
})

test('with no plan reading yet, a helper starts as normal', async ($, on) => {
  let ran = 0
  on('tool.call', () => {
    ran++
    return { result: {} } as never
  })
  await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'y' } as never)
  expect(ran).toBe(1)
})

// The plugin's own store across sessions, stood in for by a map beneath it,
const storeIn = (on: any) => {
  const mem = new Map<string, unknown>()
  on('store.get', (_$: any, e: any) => ({ value: mem.get(e.key) }) as never)
  on('store.set', (_$: any, e: any) => {
    mem.set(e.key, e.value)
    return { value: undefined } as never
  })
  on('store.delete', (_$: any, e: any) => {
    mem.delete(e.key)
    return { value: undefined } as never
  })
  // and the clock, at a fixed moment
  on('clock.now', () => ({ value: Date.parse('2026-10-17T10:00:00Z') }) as never)
  return mem
}

// APP-3651 P1: with any share of the plan left, even none, a helper starts and no Let helpers run button is drawn.
test('at any plan left, even none, a helper starts and the band has no Let helpers run button', async ($, on) => {
  storeIn(on)
  let ran = 0
  on('tool.call', () => {
    ran++
    return { result: {} } as never
  })
  on('session.measure', () => ({ changed: ['rateLimits'] }) as never)
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as never
  })
  await $.session.measure({ context: { window: 200000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100 }, { kind: 'seven_day', percentUsed: 100 }], changed: ['rateLimits'] } as never)
  for (const tool of ['Agent', 'Task', 'Workflow']) {
    const result = await $.tool.call({ tool, description: 'x', prompt: 'y' } as never)
    expect(JSON.stringify(result)).not.toContain('deny')
  }
  expect(ran).toBe(3)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'context-bar', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, columns: 100 } as never })
    // APP-3651 P3: the plan left still shows when it runs low.
    expect(await ui.find({ type: 'Text', text: /0% \(5h\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', label: 'Let helpers run' })).toBeUndefined()
    await ui.unmount()
  }
})

// APP-3651 N1: a press stored before the change, in this session or across sessions, is left alone and holds nothing.
test('values stored by an earlier version hold nothing and raise no error', async ($, on) => {
  const mem = storeIn(on)
  mem.set('letHelpersRunUntil', 1)
  let ran = 0
  on('tool.call', () => {
    ran++
    return { result: {} } as never
  })
  on('session.measure', () => ({ changed: ['rateLimits'] }) as never)
  await $.session.measure({ context: { window: 200000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 95 }], changed: ['rateLimits'] } as never)
  await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'y' } as never)
  expect(ran).toBe(1)
})

test('with plenty of plan left the figure stays out of the way', async ($, on) => {
  on('session.measure', () => ({ changed: ['rateLimits'] }) as never)
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as never
  })
  await $.session.measure({ context: { window: 200000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 30 }], changed: ['rateLimits'] } as never)
  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, columns: 100 } as never })
  expect(await ui.find({ type: 'Text', text: /Plan left/ })).toBeUndefined()
  await ui.unmount()
})

// Context checkpoint (ways-of-working): helpers hand over at 55%, a Core at 60%.
// What the engine answers beneath the plugin in a session: the measure.
const engine = (on: any) => {
  on('session.measure', () => ({ changed: ['context'] }) as never)
}
const fillAt = async ($: any, percent: number) =>
  $.session.measure({ context: { tokens: percent * 2000, window: 200000, percent }, changed: ['context'] } as never)

// The app's get_session answers this session's title; a test stands in for it.
const titled = (on: any, title: string) =>
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: JSON.stringify({ sessionId: 'local_x', title }) }], isError: false } }) as never)

const callsThrough = (on: any) => {
  const ran: string[] = []
  on('tool.call', ($: any, e: any) => {
    ran.push(String(e.tool))
    return { result: {} } as never
  })
  return ran
}

const band = async ($: any) => $.ui.mount({ plugin: 'context-bar', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, columns: 100 } as never })
const emptyBand = (on: any) =>
  on('ui.render', ($: any, e: any) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as never
  })

// Every prompt.submit beneath the plugin echoes what reached it, context included.
const echoPrompt = (on: any) => {
  const seen: (readonly string[] | undefined)[] = []
  on('prompt.submit', ($: any, e: any) => {
    seen.push(e.context)
    return { text: e.text, context: e.context } as never
  })
  return seen
}

test('a Core is any session whose title says Core; everyone else is a helper', async () => {
  expect(isCore('Mail Core 4')).toBe(true)
  expect(isCore('Workbench Core 2')).toBe(true)
  expect(isCore('Mail Helper 13')).toBe(false)
  expect(isCore(null)).toBe(false)
  expect(limitFor('Mail Core 4')).toBe(60)
  expect(limitFor('Mail Helper 13')).toBe(55)
  expect(limitFor(null)).toBe(55)
  expect(pastLimit(null, 'Mail Helper 13')).toBe(false)
  expect(pastLimit({ tokens: 1, window: 2, percent: 55 }, 'Mail Helper 13')).toBe(true)
  expect(pastLimit({ tokens: 1, window: 2, percent: 57 }, 'Mail Core 4')).toBe(false)
})

test('below the limit nothing changes: no hold, no reminder, no hand-over words', async ($, on) => {
  engine(on)
  const ran = callsThrough(on)
  titled(on, 'Mail Helper 13')
  emptyBand(on)
  const seen = echoPrompt(on)
  await fillAt($, 54)
  await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'y' } as never)
  await $.tool.call({ tool: 'mcp__ccd_session__start_session', title: 'x' } as never)
  expect(ran).toEqual(['Agent', 'mcp__ccd_session__start_session'])
  await $.prompt.submit({ text: 'hi' } as never)
  expect(seen.at(-1) ?? []).toEqual([])
  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: /hand over now/ })).toBeUndefined()
  await ui.unmount()
})

test('a helper at 55% turns red, is reminded each turn, and cannot start helpers', async ($, on) => {
  engine(on)
  const ran = callsThrough(on)
  titled(on, 'Mail Helper 13')
  emptyBand(on)
  const seen = echoPrompt(on)
  await fillAt($, 55)
  const agent = await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'y' } as never)
  const start = await $.tool.call({ tool: 'mcp__ccd_session__start_session', title: 'x' } as never)
  expect(JSON.stringify(agent)).toContain('hand over')
  expect(JSON.stringify(start)).toContain('hand over')
  expect(ran).toEqual([])
  await $.prompt.submit({ text: 'next' } as never)
  expect(seen.at(-1)).toEqual(['Context at 55 per cent: hand over now (ways-of-working, Context checkpoint)'])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'context-bar', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, columns: 100 } as never })
    expect(await ui.find({ type: 'Text', text: /hand over now/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a Core at 57% is not held; at 60% it is', async ($, on) => {
  engine(on)
  const ran = callsThrough(on)
  titled(on, 'Mail Core 4')
  emptyBand(on)
  const seen = echoPrompt(on)
  await fillAt($, 57)
  await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'y' } as never)
  expect(ran).toEqual(['Agent'])
  await $.prompt.submit({ text: 'a' } as never)
  expect(seen.at(-1) ?? []).toEqual([])
  const calm = await band($)
  expect(await calm.find({ type: 'Text', text: /hand over now/ })).toBeUndefined()
  await calm.unmount()

  await fillAt($, 60)
  const held = await $.tool.call({ tool: 'mcp__ccd_session__start_session', title: 'x' } as never)
  expect(JSON.stringify(held)).toContain('hand over')
  await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'y' } as never)
  expect(ran).toEqual(['Agent'])
  await $.prompt.submit({ text: 'b' } as never)
  expect(seen.at(-1)).toEqual(['Context at 60 per cent: hand over now (ways-of-working, Context checkpoint)'])
  const red = await band($)
  expect(await red.find({ type: 'Text', text: /hand over now/ })).toBeDefined()
  await red.unmount()
})

test('past the limit, SendMessage, Bash, edits and archive still run, so the hand-over can happen', async ($, on) => {
  engine(on)
  const ran = callsThrough(on)
  titled(on, 'Mail Helper 13')
  await fillAt($, 80)
  await $.tool.call({ tool: 'SendMessage', to: 'Mail Core 4', message: 'Helper 13 free' } as never)
  await $.tool.call({ tool: 'Bash', command: 'git status' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/tmp/x', old_string: 'a', new_string: 'b' } as never)
  await $.tool.call({ tool: 'mcp__ccd_session_mgmt__archive_session', session_ids: ['x'] } as never)
  await $.tool.call({ tool: 'mcp__ccd_session__hand_off_to_session', title: 'x', remaining_plan: 'y' } as never)
  expect(ran).toEqual(['SendMessage', 'Bash', 'Edit', 'mcp__ccd_session_mgmt__archive_session', 'mcp__ccd_session__hand_off_to_session'])
})

test('with no context reading, nothing is held and no reminder is added', async ($, on) => {
  engine(on)
  const ran = callsThrough(on)
  titled(on, 'Mail Helper 13')
  const seen = echoPrompt(on)
  await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'y' } as never)
  await $.tool.call({ tool: 'mcp__ccd_session__start_session', title: 'x' } as never)
  expect(ran).toEqual(['Agent', 'mcp__ccd_session__start_session'])
  await $.prompt.submit({ text: 'hi' } as never)
  expect(seen.at(-1) ?? []).toEqual([])
})

test('with no title to read, a session is held at the helper limit', async ($, on) => {
  engine(on)
  const ran = callsThrough(on)
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: 'no such server' }], isError: true } }) as never)
  await fillAt($, 56)
  await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'y' } as never)
  expect(ran).toEqual([])
})

test('the bar names the role and limit it read from the title, or says the title was not read', async () => {
  expect(roleLabel('Laptop Core')).toBe('Core, limit 60')
  expect(roleLabel('Laptop Helper 3')).toBe('helper, limit 55')
  expect(roleLabel(null)).toBe('limit 55, title not read')
})

test('once the title is read, a Core sees "Core, limit 60" on the bar', async ($, on) => {
  engine(on)
  callsThrough(on)
  titled(on, 'Laptop Core')
  emptyBand(on)
  await fillAt($, 55)
  await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'y' } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'context-bar', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, columns: 100 } as never })
    expect(await ui.find({ type: 'Text', text: /Core, limit 60/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /hand over now/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('with no title read, the bar says so beside the helper limit', async ($, on) => {
  engine(on)
  emptyBand(on)
  await fillAt($, 20)
  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: /limit 55, title not read/ })).toBeDefined()
  await ui.unmount()
})

// APP-3651 P3: her settings keep working: "-1" (outside the list, so read as unset) and each listed value load, and
// none holds a helper.
for (const helperFloor of ['-1', '10', '30']) {
  test(`with helperFloor ${helperFloor} the mod loads and a helper starts at no plan left`, { options: { helperFloor } }, async ($, on) => {
    let ran = 0
    on('tool.call', () => {
      ran++
      return { result: {} } as never
    })
    on('session.measure', () => ({ changed: ['rateLimits'] }) as never)
    await $.session.measure({ context: { window: 200000 }, rateLimits: [{ kind: 'seven_day', percentUsed: 100 }], changed: ['rateLimits'] } as never)
    await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'y' } as never)
    expect(ran).toBe(1)
  })
}

// SolveFoundry's settings beneath the project root, as the engine would read them; a test stands in for the file.
const settings = (on: any, context: Record<string, unknown>) => {
  on('session.root', () => ({ value: '/sf' }) as never)
  on('fs.read', ($: any, e: any) =>
    (e.path === '/sf/setup/config.json'
      ? { value: JSON.stringify({ framework: { name: 'SolveFoundry' }, context: { coreHandoffAt: 20, ...context } }) }
      : { error: 'no such file' }) as never)
}

test('context.coreRoom is read from SolveFoundry settings; missing or unknown is cutback', async () => {
  const sf = (context: Record<string, unknown>) => JSON.stringify({ framework: { name: 'SolveFoundry' }, context })
  expect(pointsFrom(sf({ coreRoom: 'rotation' })).coreRoom).toBe('rotation')
  expect(pointsFrom(sf({ coreRoom: 'cutback' })).coreRoom).toBe('cutback')
  expect(pointsFrom(sf({ coreRoom: 'cutback-summary' })).coreRoom).toBe('cutback-summary')
  expect(pointsFrom(sf({})).coreRoom).toBe('cutback')
  expect(pointsFrom(sf({ coreRoom: 'spare' })).coreRoom).toBe('cutback')
  // Outside SolveFoundry the old hand-over holds.
  expect(pointsFrom(JSON.stringify({ context: { coreRoom: 'cutback' } })).coreRoom).toBe('rotation')
  expect(pointsFrom(null).coreRoom).toBe('rotation')
  expect(cutsBack('Core 1', pointsFrom(sf({})))).toBe(true)
  expect(cutsBack('Builder 3', pointsFrom(sf({})))).toBe(false)
  expect(cutsBack('Core 1', pointsFrom(sf({ coreRoom: 'rotation' })))).toBe(false)
})

for (const room of ['cutback', 'cutback-summary', undefined] as const) {
  test(`a Core past its point under coreRoom ${room ?? '(unset)'} gets no hand-over reminder`, async ($, on) => {
    engine(on)
    callsThrough(on)
    titled(on, 'Core 1 - Active')
    settings(on, room ? { coreRoom: room } : {})
    const seen = echoPrompt(on)
    await fillAt($, 25)
    await $.prompt.submit({ text: 'next' } as never)
    expect(seen.at(-1) ?? []).toEqual([])
  })
}

for (const room of ['cutback', 'cutback-summary', undefined] as const) {
  test(`a Core past its point under coreRoom ${room ?? '(unset)'} may still start helpers and sessions`, async ($, on) => {
    engine(on)
    const ran = callsThrough(on)
    titled(on, 'Core 1 - Active')
    settings(on, room ? { coreRoom: room } : {})
    await fillAt($, 25)
    await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'y' } as never)
    await $.tool.call({ tool: 'Task', description: 'x', prompt: 'y' } as never)
    await $.tool.call({ tool: 'Workflow', script: 'x' } as never)
    await $.tool.call({ tool: 'mcp__ccd_session__start_session', title: 'x' } as never)
    expect(ran).toEqual(['Agent', 'Task', 'Workflow', 'mcp__ccd_session__start_session'])
  })

  test(`a Core past its point under coreRoom ${room ?? '(unset)'} shows "cut back", not "hand over now"`, async ($, on) => {
    engine(on)
    callsThrough(on)
    titled(on, 'Core 1 - Active')
    settings(on, room ? { coreRoom: room } : {})
    emptyBand(on)
    await fillAt($, 25)
    await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'y' } as never)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'context-bar', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, columns: 100 } as never })
      expect(await ui.find({ type: 'Text', text: /Core, limit 20/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /cut back/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /hand over now/ })).toBeUndefined()
      await ui.unmount()
    }
  })
}

test('under rotation a Core past its point is reminded, held and shown "hand over now", as before', async ($, on) => {
  engine(on)
  const ran = callsThrough(on)
  titled(on, 'Core 1 - Active')
  settings(on, { coreRoom: 'rotation' })
  emptyBand(on)
  const seen = echoPrompt(on)
  await fillAt($, 25)
  const held = await $.tool.call({ tool: 'mcp__ccd_session__start_session', title: 'x' } as never)
  expect(JSON.stringify(held)).toContain('hand over')
  expect(ran).toEqual([])
  await $.prompt.submit({ text: 'next' } as never)
  expect(seen.at(-1)).toEqual(['Context at 25 per cent: hand over now (ways-of-working, Context checkpoint)'])
  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: /hand over now/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /cut back/ })).toBeUndefined()
  await ui.unmount()
})

test('under cutback a helper past its point is still reminded and held', async ($, on) => {
  engine(on)
  const ran = callsThrough(on)
  titled(on, 'Mail Builder 3')
  settings(on, { coreRoom: 'cutback', helperStopAt: 40, helperPauseAt: 50 })
  const seen = echoPrompt(on)
  await fillAt($, 50)
  const held = await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'y' } as never)
  expect(JSON.stringify(held)).toContain('hand over')
  expect(ran).toEqual([])
  await $.prompt.submit({ text: 'next' } as never)
  expect(seen.at(-1)).toEqual(['Context at 50 per cent: hand over now (ways-of-working, Context checkpoint)'])
})
