import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { citedPages, healthUrl, kindOf, verdict } from './sources'

test('grounding lookups and wiki reads count as wiki; web tools as web; housekeeping as neither', async () => {
  expect(kindOf('mcp__wiki-grounding__search', { query: 'x' })).toBe('wiki')
  expect(kindOf('mcp__wiki-grounding__about', {})).toBeNull()
  expect(kindOf('Grep', { pattern: 'KONV', path: 'wiki/lookup.md' })).toBe('wiki')
  expect(kindOf('Read', { file_path: '/p/wiki/pages/a.md' })).toBe('wiki')
  expect(kindOf('Read', { file_path: '/p/src/a.ts' })).toBeNull()
  expect(kindOf('WebSearch', { query: 'x' })).toBe('web')
  expect(kindOf('mcp__Claude_Browser__get_page_text', {})).toBe('web')
})

test('cited pages are read from every citation form', async () => {
  const a = 'One [T1 parent: a.md; b.md]. Two [T2 devlabs: c.md#x]. Again [T1 parent: a.md]. A post fact [WIKI].'
  expect(citedPages(a).length).toBe(4)
})

test('each answer gets the line that fits where it came from', async () => {
  const long = 'x'.repeat(400)
  expect(verdict(`${long} [T1 parent: a.md]`, { wiki: 2, web: 0 })?.text).toBe('📚 From the wiki: 1 page cited')
  expect(verdict(long, { wiki: 3, web: 1 })?.text).toBe('📚 From the wiki: checked 3 times, nothing cited, plus the web')
  expect(verdict(long, { wiki: 0, web: 2 })?.source).toBe('web')
  expect(verdict(long, { wiki: 0, web: 0 })?.text).toContain("Claude's own knowledge")
  expect(verdict(`${long} KNOWLEDGE GAP`, { wiki: 1, web: 0 })?.text).toContain('knowledge gap')
  expect(verdict('Done.', { wiki: 0, web: 0 })).toBeNull()
})

test('the health address sits beside the grounding server address', async () => {
  expect(healthUrl(JSON.stringify({ mcpServers: { 'wiki-grounding': { url: 'http://127.0.0.1:8768/mcp' } } }))).toBe('http://127.0.0.1:8768/health')
  expect(healthUrl(JSON.stringify({ mcpServers: { other: { url: 'http://x/mcp' } } }))).toBeNull()
  expect(healthUrl('not json')).toBeNull()
})

const project = (on: On, files: Record<string, string>, health = 'ok') => {
  on('session.cwd', () => ({ value: '/p' }) as never)
  on('fs.exists', ($, e) => ({ value: e.path in files }))
  on('fs.read', ($, e) => ({ value: files[e.path] ?? '' }))
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: health } }) as never)
  mock.clock(on)
  on('session.start', () => ({ cwd: '/p' }) as never)
  on('turn.start', ($, e) => e as never)
}

const MCP = JSON.stringify({ mcpServers: { 'wiki-grounding': { url: 'http://127.0.0.1:8768/mcp' } } })

test('in a wiki project an answer gets its source line and the tally counts it', async ($, on) => {
  project(on, { '/p/.mcp.json': MCP })
  on('tool.call', () => ({ result: {} }) as never)
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as never
  })
  await $.session.start({ source: 'startup', cwd: '/p' } as never)
  await $.turn.start({ text: 'q', turnId: 't' } as never)
  await $.tool.call({ tool: 'mcp__wiki-grounding__search', query: 'KONV' } as never)
  const r = await $.turn.complete({ answer: `${'x'.repeat(400)} [T1 parent: konv.md]`, reason: 'answer', durationMs: 1, isAborted: false, turnId: 't' } as never)
  expect(r.text).toBe('📚 From the wiki: 1 page cited')
  const ui = await $.ui.mount({ plugin: 'wiki-sources', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } as never })
  expect(await ui.find({ type: 'Text', text: /wiki 1/ })).toBeDefined()
  await ui.unmount()
})

test('outside a wiki project nothing is added', async ($, on) => {
  project(on, { '/p/CLAUDE.md': 'A travel planner.' })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  await $.session.start({ source: 'startup', cwd: '/p' } as never)
  await $.turn.start({ text: 'q', turnId: 't' } as never)
  const answer = 'y'.repeat(400)
  const r = await $.turn.complete({ answer, reason: 'answer', durationMs: 1, isAborted: false, turnId: 't' } as never)
  expect(r.text).toBe(answer)
})

test('the band shows the server light and the tally, on terminal and desktop', async ($, on) => {
  project(on, { '/p/.mcp.json': MCP })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as never
  })
  await $.session.start({ source: 'startup', cwd: '/p' } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'wiki-sources', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } as never })
    expect(await ui.find({ type: 'Text', text: /Wiki server/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /wiki 0/ })).toBeDefined()
    await ui.unmount()
  }
})
