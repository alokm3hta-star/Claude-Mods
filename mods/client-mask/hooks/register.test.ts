import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

const HOME = '/home/t'
const LIST_PATH = `${HOME}/.claude/client-mask/terms.json`
const LIST = {
  blockedFolders: ['~/client-exports'],
  terms: [
    { real: 'Northwind Revenue', placeholder: 'CLIENT_3' },
    { real: 'Priya Okafor', placeholder: 'PERSON_1', toFiles: false },
  ],
}

// A list on a pretend disk, answered beneath the plugin.
const disk = (on: On, text = JSON.stringify(LIST)) => {
  const files: Record<string, string> = { [LIST_PATH]: text }
  mock.env(on, { HOME })
  mock.clock(on)
  on('fs.exists', ($, e) => ({ value: e.path in files || Object.keys(files).some(f => f.startsWith(`${e.path}/`)) }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false } }))
  on('fs.read', ($, e) => ({ value: files[e.path] ?? '' }))
  on('fs.write', ($, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  return files
}

test('a local tool gets the real values back; a web tool keeps placeholders; nothing is recorded', async ($, on) => {
  const files = disk(on)
  const seen: Record<string, unknown> = {}
  on('tool.call', ($, e) => {
    seen[e.tool] = e
    return { result: { content: 'ok' } } as never
  })
  await $.tool.call({ tool: 'Write', file_path: '/x/CLIENT_3.md', content: 'Dear PERSON_1' } as never)
  await $.tool.call({ tool: 'WebSearch', query: 'CLIENT_3 tax rules' } as never)
  expect(JSON.stringify(seen.Write)).toContain('/x/Northwind Revenue.md')
  // A row marked toFiles: false keeps its placeholder, even in files.
  expect(JSON.stringify(seen.Write)).toContain('Dear PERSON_1')
  expect(JSON.stringify(seen.WebSearch)).toContain('CLIENT_3 tax rules')
  expect(Object.keys(files)).toEqual([LIST_PATH])
})

test('a tool call that opens the list folder is refused', async ($, on) => {
  disk(on)
  let ran = false
  on('tool.call', () => {
    ran = true
    return { result: { content: 'list contents' } } as never
  })
  const r = await $.tool.call({ tool: 'Bash', command: 'cat ~/.claude/client-mask/terms.json' } as never)
  expect(ran).toBe(false)
  expect(JSON.stringify(r)).toContain('private')
})

test('reading a PDF is refused while masking is on', async ($, on) => {
  disk(on)
  let ran = false
  on('tool.call', () => {
    ran = true
    return { result: { content: 'pdf bytes' } } as never
  })
  const r = await $.tool.call({ tool: 'Read', file_path: '/x/scan.pdf' } as never)
  expect(ran).toBe(false)
  expect(JSON.stringify(r)).toContain('cannot be masked')
})

test("Claude's own notes keep the placeholders", async ($, on) => {
  disk(on)
  let seen = ''
  on('tool.call', ($, e) => {
    seen = JSON.stringify(e)
    return { result: { content: 'ok' } } as never
  })
  await $.tool.call({ tool: 'Write', file_path: `${HOME}/.claude/projects/x/memory/note.md`, content: 'CLIENT_3 prefers email' } as never)
  expect(seen).toContain('CLIENT_3 prefers email')
})

test('writing a masked label into a file is refused', async ($, on) => {
  disk(on)
  let ran = false
  on('tool.call', () => {
    ran = true
    return { result: { content: 'ok' } } as never
  })
  const r = await $.tool.call({ tool: 'Edit', file_path: '/x/a.ts', old_string: 'x', new_string: 'const to = "‹EMAIL›"' } as never)
  expect(ran).toBe(false)
  expect(JSON.stringify(r)).toContain('overwrite the real value')
})

test('a blocked client-data folder cannot be opened', async ($, on) => {
  disk(on)
  let ran = false
  on('tool.call', () => {
    ran = true
    return { result: { content: 'rows' } } as never
  })
  const r = await $.tool.call({ tool: 'Bash', command: 'head ~/client-exports/payers.csv' } as never)
  expect(ran).toBe(false)
  expect(JSON.stringify(r)).toContain('real client data')
  const r2 = await $.tool.call({ tool: 'Read', file_path: `${HOME}/client-exports/payers.csv` } as never)
  expect(JSON.stringify(r2)).toContain('real client data')
})

test('a broken list stops tools from getting real values', async ($, on) => {
  disk(on, '{ not json')
  let seen = ''
  on('tool.call', ($, e) => {
    seen = JSON.stringify(e)
    return { result: { content: 'ok' } } as never
  })
  await $.tool.call({ tool: 'Write', file_path: '/x/a.md', content: 'CLIENT_3' } as never)
  expect(seen).toContain('CLIENT_3')
})

test('the band shows that masking is on, on terminal and desktop', async ($, on) => {
  disk(on)
  // Beneath the plugin: nothing else draws in the band.
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as never
  })
  on('ui.status', () => ({ value: undefined }) as never)
  await $.tool.call({ tool: 'WebSearch', query: 'warm-up' } as never).catch(() => undefined)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'client-mask', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, columns: 120 } as never })
    expect(await ui.find({ type: 'Button', label: '🔒 Masking on' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2 names/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the band says so when the list has a problem', async ($, on) => {
  disk(on, '{ not json')
  // Beneath the plugin: nothing else draws in the band.
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as never
  })
  on('ui.status', () => ({ value: undefined }) as never)
  await $.tool.call({ tool: 'WebSearch', query: 'warm-up' } as never).catch(() => undefined)
  const ui = await $.ui.mount({ plugin: 'client-mask', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, columns: 120 } as never })
  expect(await ui.find({ type: 'Text', text: /nothing will be sent/ })).toBeDefined()
  await ui.unmount()
})

test("a reply on screen shows the real name; what reached the model does not change", async ($, on) => {
  disk(on)
  let drawn = ''
  on('ui.render', ($, e) => {
    drawn = String((e.props as { text?: string }).text ?? '')
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as never
  })
  on('ui.status', () => ({ value: undefined }) as never)
  await $.tool.call({ tool: 'WebSearch', query: 'warm-up' } as never).catch(() => undefined)
  const ui = await $.ui.mount({ plugin: 'client-mask', surface: 'terminal', component: 'AssistantMessage', props: { text: 'Hello CLIENT_3', isFirstOfReply: true } as never })
  expect(drawn).toBe('Hello **Northwind Revenue**🔒')
  await ui.unmount()
})

test('the masking button switches masking off and back on', async ($, on) => {
  disk(on, JSON.stringify({ terms: [{ real: 'NWR', placeholder: 'CLIENT_3' }, { real: 'TRM', placeholder: 'SYSTEM_1', onlyWith: ['NWR'] }] }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as never
  })
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', () => undefined as never)
  await $.tool.call({ tool: 'WebSearch', query: 'warm-up' } as never).catch(() => undefined)
  const ui = await $.ui.mount({ plugin: 'client-mask', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, columns: 120 } as never })
  expect(await ui.find({ type: 'Button', label: '🔒 Masking on' })).toBeDefined()
  await ui.press({ key: 'mask' })
  expect(await ui.find({ type: 'Button', label: '⚠ Masking off' })).toBeDefined()
  await ui.press({ key: 'mask' })
  expect(await ui.find({ type: 'Button', label: '🔒 Masking on' })).toBeDefined()
  await ui.unmount()
})

test('while masking is off for the session, placeholders are no longer swapped', async ($, on) => {
  disk(on)
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as never
  })
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', () => undefined as never)
  let written = ''
  on('tool.call', ($, e) => {
    written = JSON.stringify(e)
    return { result: { content: 'ok' } } as never
  })
  await $.tool.call({ tool: 'WebSearch', query: 'warm-up' } as never).catch(() => undefined)
  const ui = await $.ui.mount({ plugin: 'client-mask', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, columns: 120 } as never })
  await ui.press({ key: 'mask' })
  expect(await ui.find({ type: 'Button', label: '⚠ Masking off' })).toBeDefined()
  await $.tool.call({ tool: 'Write', file_path: '/x/CLIENT_3.md', content: 'hi' } as never)
  expect(written).toContain('/x/CLIENT_3.md')
  await ui.unmount()
})

test('the edit button opens the list in the text editor', async ($, on) => {
  disk(on)
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as never
  })
  on('ui.status', () => ({ value: undefined }) as never)
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return undefined as never
  })
  const ran: string[][] = []
  on('process.run', ($, e) => {
    ran.push([...(e as unknown as { argv: string[] }).argv])
    return { value: { exitCode: 0, stdout: "", stderr: "" } } as never
  })
  await $.tool.call({ tool: 'WebSearch', query: 'warm-up' } as never).catch(() => undefined)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'client-mask', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, columns: 120 } as never })
    await ui.press({ key: 'edit' })
    expect(ran.some(a => a[0] === 'open' && a.includes(LIST_PATH))).toBe(true)
    expect(toasts.at(-1)).toContain('open in your text editor')
    await ui.unmount()
  }
})
