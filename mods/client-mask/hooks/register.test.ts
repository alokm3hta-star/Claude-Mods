import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const HOME = '/home/t'
const LIST_PATH = `${HOME}/.claude/client-mask/terms.json`
const LIST = {
  startOn: true,
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
  const store: Record<string, unknown> = {}
  on('store.get', ($, e) => ({ value: store[e.key] }) as never)
  on('store.set', ($, e) => {
    store[e.key] = e.value
    return { value: undefined } as never
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
    expect(await ui.find({ type: 'Button', text: '🔒 Masking on' })).toBeDefined()
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
  disk(on, JSON.stringify({ startOn: true, terms: [{ real: 'NWR', placeholder: 'CLIENT_3' }, { real: 'TRM', placeholder: 'SYSTEM_1', onlyWith: ['NWR'] }] }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as never
  })
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  await $.tool.call({ tool: 'WebSearch', query: 'warm-up' } as never).catch(() => undefined)
  const ui = await $.ui.mount({ plugin: 'client-mask', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, columns: 120 } as never })
  expect(await ui.find({ type: 'Button', text: '🔒 Masking on' })).toBeDefined()
  await ui.press({ key: 'mask' })
  expect(await ui.find({ type: 'Button', text: '⚠ Masking off' })).toBeDefined()
  await ui.press({ key: 'mask' })
  expect(await ui.find({ type: 'Button', text: '🔒 Masking on' })).toBeDefined()
  await ui.unmount()
})

test('while masking is off for the session, placeholders are no longer swapped', async ($, on) => {
  disk(on)
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as never
  })
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  let written = ''
  on('tool.call', ($, e) => {
    written = JSON.stringify(e)
    return { result: { content: 'ok' } } as never
  })
  await $.tool.call({ tool: 'WebSearch', query: 'warm-up' } as never).catch(() => undefined)
  const ui = await $.ui.mount({ plugin: 'client-mask', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, columns: 120 } as never })
  await ui.press({ key: 'mask' })
  expect(await ui.find({ type: 'Button', text: '⚠ Masking off' })).toBeDefined()
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
    return { value: undefined } as never
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

// A pretend model step beneath the plugin: a tool call whose arguments arrive
// in pieces, a name split across two of them.
const stepBeneath = (on: On, pieces: string[]) => {
  on('turn.step', async function* () {
    yield { kind: 'tool', index: 0, id: 't1', name: 'Agent' }
    for (const json of pieces) yield { kind: 'input', index: 0, json }
    yield { kind: 'stop', stopReason: 'tool_use', usage: null }
    return { turnId: 'x', index: 0, answer: '', toolUses: [{ name: 'Agent', input: JSON.parse(pieces.join('')) }], stopReason: 'tool_use', usage: null }
  } as never)
}

const runStep = async ($: Engine, messageCount = 1) => {
  const stream = $.turn.step({ turnId: 'x', index: 0, model: 'm', messageCount } as never)
  const chunks: { kind: string; json?: string }[] = []
  for await (const c of stream) chunks.push(c as never)
  return { chunks, result: await stream.result }
}

test("a name the model writes into a tool call is masked before it is stored", async ($, on) => {
  disk(on)
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('session.messages', () => ({ value: [{ role: 'user', content: 'hi' }] }) as never)
  stepBeneath(on, ['{"prompt":"brief for Northwind ', 'Revenue, ask Priya Okafor"}'])
  const { chunks, result } = await runStep($)
  const json = chunks.filter(c => c.kind === 'input').map(c => c.json).join('')
  expect(json).not.toContain('Northwind')
  expect(JSON.parse(json).prompt).toBe('brief for CLIENT_3, ask PERSON_1')
  expect(JSON.stringify(result)).not.toContain('Northwind')
})

test("a tool call with nothing to mask streams through unchanged", async ($, on) => {
  disk(on)
  on('ui.status', () => ({ value: undefined }) as never)
  on('session.messages', () => ({ value: [{ role: 'user', content: 'hi' }] }) as never)
  stepBeneath(on, ['{"prompt":', '"plain"}'])
  const { chunks } = await runStep($)
  expect(chunks.filter(c => c.kind === 'input').map(c => c.json)).toEqual(['{"prompt":', '"plain"}'])
})

test("a name in an earlier tool call of the model's does not stop the conversation", async ($, on) => {
  disk(on)
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('session.messages', () => ({
    value: [
      { role: 'user', content: 'start' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't0', name: 'Agent', input: { prompt: 'Northwind Revenue brief' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't0', content: 'launched' }] },
    ],
  }) as never)
  stepBeneath(on, ['{"prompt":"ok"}'])
  const { chunks } = await runStep($)
  expect(JSON.stringify(chunks)).not.toContain('stopped this request')
})

test("a name in clear text in what the model is sent still stops the request", async ($, on) => {
  disk(on)
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('session.messages', () => ({ value: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't0', content: 'row for Northwind Revenue' }] }] }) as never)
  stepBeneath(on, ['{"prompt":"ok"}'])
  const { chunks } = await runStep($)
  expect(JSON.stringify(chunks)).toContain('stopped this request')
})

test('SAP in a tool call the model writes stays SAP, in the stream and for local tools', async ($, on) => {
  disk(on, JSON.stringify({ startOn: true, terms: [{ real: 'TRM', placeholder: 'SAP' }] }))
  on('ui.status', () => ({ value: undefined }) as never)
  on('session.messages', () => ({ value: [{ role: 'user', content: 'hi' }] }) as never)
  let seen = ''
  on('tool.call', ($, e) => {
    seen = JSON.stringify(e)
    return { result: { content: 'ok' } } as never
  })
  stepBeneath(on, ['{"prompt":"SAP ', 'migration"}'])
  const { chunks } = await runStep($)
  expect(chunks.filter(c => c.kind === 'input').map(c => c.json).join('')).toBe('{"prompt":"SAP migration"}')
  await $.tool.call({ tool: 'Write', file_path: '/x/a.md', content: 'SAP plan' } as never)
  expect(seen).toContain('SAP plan')
  expect(seen).not.toContain('TRM')
})

test('masking switched on mid-conversation: what was already sent never stops it; what is new is still checked', async ($, on) => {
  disk(on, JSON.stringify({ terms: [{ real: 'TRM', placeholder: 'SAP' }] }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as never
  })
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  let messages: unknown[] = []
  on('session.messages', () => ({ value: messages }) as never)
  stepBeneath(on, ['{"prompt":"ok"}'])
  await $.tool.call({ tool: 'WebSearch', query: 'warm-up' } as never).catch(() => undefined)
  const ui = await $.ui.mount({ plugin: 'client-mask', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, columns: 120 } as never })
  // A new session starts with masking off: the wiki loads and "what is TRM?" goes out as written.
  expect(await ui.find({ type: 'Button', text: '⚠ Masking off' })).toBeDefined()
  messages = [{ role: 'user', content: 'what is TRM?' }]
  expect(JSON.stringify((await runStep($, 1)).chunks)).not.toContain('stopped this request')
  // Masking switched on for this session: the conversation carries on.
  await ui.press({ key: 'mask' })
  messages = [...messages, { role: 'assistant', content: 'an answer' }, { role: 'user', content: 'and SAP pricing?' }]
  expect(JSON.stringify((await runStep($, 3)).chunks)).not.toContain('stopped this request')
  // Something new in clear text is still stopped.
  messages = [...messages, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't9', content: 'TRM config dump' }] }]
  expect(JSON.stringify((await runStep($, 4)).chunks)).toContain('stopped this request')
  await ui.unmount()
})

test('a new session starts with masking off: nothing is masked until it is switched on', async ($, on) => {
  disk(on, JSON.stringify({ terms: [{ real: 'Northwind Revenue', placeholder: 'CLIENT_3' }] }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as never
  })
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  let seen = ''
  on('tool.call', ($, e) => {
    seen = JSON.stringify(e)
    return { result: { content: 'ok' } } as never
  })
  await $.tool.call({ tool: 'Write', file_path: '/x/CLIENT_3.md', content: 'hi' } as never)
  expect(seen).toContain('/x/CLIENT_3.md')
  const ui = await $.ui.mount({ plugin: 'client-mask', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, columns: 120 } as never })
  expect(await ui.find({ type: 'Button', text: '⚠ Masking off' })).toBeDefined()
  await ui.press({ key: 'mask' })
  expect(await ui.find({ type: 'Button', text: '🔒 Masking on' })).toBeDefined()
  await $.tool.call({ tool: 'Write', file_path: '/x/CLIENT_3.md', content: 'hi' } as never)
  expect(seen).toContain('/x/Northwind Revenue.md')
  await ui.unmount()
})

test('the list folder stays private even while masking is off', async ($, on) => {
  disk(on, JSON.stringify({ terms: [] }))
  on('ui.status', () => ({ value: undefined }) as never)
  const listFile = [HOME, '.claude', 'client' + '-mask', 'terms.json'].join('/')
  const r = await $.tool.call({ tool: 'Read', file_path: listFile } as never)
  expect(JSON.stringify(r)).toContain('private')
})
