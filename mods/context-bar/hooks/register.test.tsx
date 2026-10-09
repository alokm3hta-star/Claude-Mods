import { test, expect } from 'claude-code/testing'

import { bar, cacheFrom, cacheState, colourFor, hitRate, minutesLeft } from './register'

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

test('bar is green to 45%, amber above 45%, red above 60%', async () => {
  expect(colourFor(45)).toBe('success')
  expect(colourFor(46)).toBe('warning')
  expect(colourFor(60)).toBe('warning')
  expect(colourFor(61)).toBe('error')
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
