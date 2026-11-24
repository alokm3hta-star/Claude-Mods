import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { ORIGINALS, maskToolArgs } from './register'
import { Masker } from './mask'

const HOME = '/home/t'
const LIST_PATH = `${HOME}/.claude/client-mask/terms.json`
const LIST = {
  startOn: true,
  // These tests are about the list; the model has tests of its own (model.test.ts).
  model: { enabled: false },
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

test('with restoring off, a Write that would replace real names on disk is refused, naming placeholders only', async ($, on) => {
  const files = disk(on, JSON.stringify({ ...LIST, restoreInTools: [] }))
  files['/x/review.md'] = 'Prepared for Northwind Revenue by the team.'
  let ran = false
  on('tool.call', () => {
    ran = true
    return { result: { content: 'ok' } } as never
  })
  const r = await $.tool.call({ tool: 'Write', file_path: '/x/review.md', content: 'Prepared for CLIENT_3 by the team, revised.' } as never)
  expect(ran).toBe(false)
  expect(JSON.stringify(r)).toContain('CLIENT_3')
  expect(JSON.stringify(r)).not.toContain('Northwind')
})

test('with restoring on, the same Write goes ahead: the real name is put back', async ($, on) => {
  const files = disk(on)
  files['/x/review.md'] = 'Prepared for Northwind Revenue by the team.'
  let seen = ''
  on('tool.call', ($, e) => {
    seen = JSON.stringify(e)
    return { result: { content: 'ok' } } as never
  })
  await $.tool.call({ tool: 'Write', file_path: '/x/review.md', content: 'Prepared for CLIENT_3 by the team, revised.' } as never)
  expect(seen).toContain('Northwind Revenue')
})

test('a Write to a new file, or to a file with no listed names, is not held up', async ($, on) => {
  const files = disk(on, JSON.stringify({ ...LIST, restoreInTools: [] }))
  files['/x/plain.md'] = 'nothing listed here'
  let runs = 0
  on('tool.call', () => {
    runs++
    return { result: { content: 'ok' } } as never
  })
  await $.tool.call({ tool: 'Write', file_path: '/x/new.md', content: 'Draft for CLIENT_3' } as never)
  await $.tool.call({ tool: 'Write', file_path: '/x/plain.md', content: 'Draft for CLIENT_3' } as never)
  expect(runs).toBe(2)
})

test('the overwrite guard can be switched off in the list', async ($, on) => {
  const files = disk(on, JSON.stringify({ ...LIST, restoreInTools: [], guardOverwrites: false }))
  files['/x/review.md'] = 'Prepared for Northwind Revenue.'
  let ran = false
  on('tool.call', () => {
    ran = true
    return { result: { content: 'ok' } } as never
  })
  await $.tool.call({ tool: 'Write', file_path: '/x/review.md', content: 'Prepared for CLIENT_3.' } as never)
  expect(ran).toBe(true)
})

// "maskFilesInPlace": the file itself is masked on disk before Claude reads or
// edits it, so a later Edit matches and nothing ever needs turning back.
const inPlace = (on: On, extra: Record<string, unknown> = {}) => {
  const files = disk(on, JSON.stringify({ ...LIST, restoreInTools: [], showRealNames: false, maskFilesInPlace: true, ...extra }))
  on('process.run', ($, e) => {
    const argv = (e as unknown as { argv: string[] }).argv
    const [cmd, , from, to] = argv
    if (cmd === 'mv' && from !== undefined && to !== undefined) {
      files[to] = files[from] ?? ''
      delete files[from]
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  return files
}

test('with maskFilesInPlace, a file is masked on disk before Claude reads it; the original is kept privately', async ($, on) => {
  const files = inPlace(on)
  files['/x/review.md'] = 'Prepared for Northwind Revenue.\nSAP scope.'
  let seen = ''
  on('tool.call', ($, e) => {
    seen = files['/x/review.md'] ?? ''
    return { result: { content: 'ok' } } as never
  })
  await $.tool.call({ tool: 'Read', file_path: '/x/review.md' } as never)
  expect(seen).toBe('Prepared for CLIENT_3.\nSAP scope.')
  expect(files['/x/review.md.client-mask-tmp']).toBeUndefined()
  expect(files[`${HOME}/${ORIGINALS}/x/review.md`]).toBe('Prepared for Northwind Revenue.\nSAP scope.')
})

test('with maskFilesInPlace, an Edit in placeholders matches the file on disk', async ($, on) => {
  const files = inPlace(on)
  files['/x/review.md'] = 'Owner: Northwind Revenue'
  let seen: Record<string, unknown> = {}
  on('tool.call', ($, e) => {
    seen = { ...(e as Record<string, unknown>), onDisk: files['/x/review.md'] }
    return { result: { content: 'ok' } } as never
  })
  await $.tool.call({ tool: 'Edit', file_path: '/x/review.md', old_string: 'Owner: CLIENT_3', new_string: 'Owner: CLIENT_3 (lead)' } as never)
  expect(seen.onDisk).toBe('Owner: CLIENT_3')
  expect(seen.old_string).toBe('Owner: CLIENT_3')
})

test('with keepOriginals false, no copy of the original is kept anywhere', async ($, on) => {
  const files = inPlace(on, { keepOriginals: false })
  files['/x/review.md'] = 'Prepared for Northwind Revenue.'
  on('tool.call', () => ({ result: { content: 'ok' } }) as never)
  await $.tool.call({ tool: 'Read', file_path: '/x/review.md' } as never)
  expect(files['/x/review.md']).toBe('Prepared for CLIENT_3.')
  expect(Object.keys(files).some(f => f.includes('/originals/'))).toBe(false)
})

test('maskFilesInPlace leaves files that are not text alone', async ($, on) => {
  const files = inPlace(on)
  files['/x/data.bin'] = 'Northwind Revenue\u0000\u0001'
  on('tool.call', () => ({ result: { content: 'ok' } }) as never)
  await $.tool.call({ tool: 'Read', file_path: '/x/data.bin' } as never)
  expect(files['/x/data.bin']).toBe('Northwind Revenue\u0000\u0001')
})

test('without maskFilesInPlace, reading a file never changes it', async ($, on) => {
  const files = disk(on)
  files['/x/review.md'] = 'Prepared for Northwind Revenue.'
  on('tool.call', () => ({ result: { content: 'ok' } }) as never)
  await $.tool.call({ tool: 'Read', file_path: '/x/review.md' } as never)
  expect(files['/x/review.md']).toBe('Prepared for Northwind Revenue.')
})

test('with maskFilesInPlace, a file a Bash command names is masked on disk before it runs: TRM is already SAP', async ($, on) => {
  const files = inPlace(on, { terms: [...LIST.terms, { real: 'TRM', placeholder: 'SAP' }] })
  on('session.cwd', () => ({ value: '/x' }) as never)
  files['/x/plan.md'] = 'TRM go-live is in March.\nTRM interfaces: 12.'
  let onDisk = ''
  on('tool.call', () => {
    onDisk = files['/x/plan.md'] ?? ''
    return { result: { content: 'ok' } } as never
  })
  await $.tool.call({ tool: 'Bash', command: "grep -n 'SAP' plan.md" } as never)
  expect(onDisk).toBe('SAP go-live is in March.\nSAP interfaces: 12.')
})

test('with maskFilesInPlace, a cd in the command is followed, and keepOnDisk folders are never rewritten', async ($, on) => {
  const files = inPlace(on, { keepOnDisk: ['/wiki'] })
  on('session.cwd', () => ({ value: '/x' }) as never)
  files['/y/notes.md'] = 'for Northwind Revenue'
  files['/wiki/page.md'] = 'for Northwind Revenue'
  on('tool.call', () => ({ result: { content: 'ok' } }) as never)
  await $.tool.call({ tool: 'Bash', command: 'cd /y && sed -i "" s/a/b/ notes.md; cat /wiki/page.md' } as never)
  expect(files['/y/notes.md']).toBe('for CLIENT_3')
  expect(files['/wiki/page.md']).toBe('for Northwind Revenue')
  await $.tool.call({ tool: 'Read', file_path: '/wiki/page.md' } as never)
  expect(files['/wiki/page.md']).toBe('for Northwind Revenue')
})

test('with maskFilesInPlace, a file Grep is pointed at is masked on disk first', async ($, on) => {
  const files = inPlace(on)
  files['/x/review.md'] = 'Owner: Northwind Revenue'
  on('tool.call', () => ({ result: { content: 'ok' } }) as never)
  await $.tool.call({ tool: 'Grep', pattern: 'Owner', path: '/x/review.md' } as never)
  expect(files['/x/review.md']).toBe('Owner: CLIENT_3')
})

test('a local tool call with no placeholder is passed on as the same call', async ($, on) => {
  disk(on)
  let seen: Record<string, unknown> = {}
  const call = { tool: 'Bash', command: 'ls /x' }
  on('tool.call', ($, e) => {
    const { tool_use_id, ...rest } = e as Record<string, unknown>
    seen = rest
    return { result: { content: 'ok' } } as never
  })
  await $.tool.call(call as never)
  expect(JSON.stringify(seen)).toBe(JSON.stringify(call))
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
  disk(on, JSON.stringify({ startOn: true, model: { enabled: false }, terms: [{ real: 'NWR', placeholder: 'CLIENT_3' }, { real: 'TRM', placeholder: 'SYSTEM_1', onlyWith: ['NWR'] }] }))
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

// Regression: held pieces released only after the engine's block-end marker
// reached the engine as a call with no arguments ("required parameter missing").
// The test engine refuses made-up engine chunks, so the stream is fed directly.
const fakeStream = (chunks: unknown[]) => {
  const gen = (async function* () {
    for (const c of chunks) yield c
  })()
  return Object.assign(gen, {
    result: Promise.resolve({ turnId: 'x', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', usage: null }),
  }) as never
}

test('the final tool calls keep their own objects when nothing is masked; a name is still masked', async () => {
  const m = new Masker(LIST as never)
  const plain = { id: 't1', name: 'Agent', input: { prompt: 'review the draft comments' } }
  const named = { id: 't2', name: 'Agent', input: { prompt: 'brief for Northwind Revenue' } }
  const run = async (toolUses: unknown[]) => {
    const result = { turnId: 'x', index: 0, answer: '', toolUses, stopReason: 'tool_use', usage: null }
    const gen = (async function* () {})()
    const it = maskToolArgs(Object.assign(gen, { result: Promise.resolve(result) }) as never, s => Promise.resolve(m.mask(s)))
    let r = await it.next()
    while (!r.done) r = await it.next()
    return { result, out: r.value as unknown as typeof result }
  }
  const a = await run([plain])
  expect(a.out).toBe(a.result)
  expect(a.out.toolUses[0]).toBe(plain)
  const b = await run([plain, named])
  expect(b.out.toolUses[0]).toBe(plain)
  expect(JSON.stringify(b.out.toolUses[1])).toContain('CLIENT_3')
  expect(JSON.stringify(b.out.toolUses[1])).not.toContain('Northwind')
})

for (const [label, pieces] of [
  ['nothing to mask', ['{"command":', '"ls"}']],
  ['a name to mask', ['{"prompt":"brief for Northwind ', 'Revenue"}']],
] as const) {
  test(`a tool call's arguments pass before the engine's end-of-block marker (${label})`, async () => {
    const m = new Masker(LIST as never)
    const out: { kind: string; json?: string }[] = []
    const stream = fakeStream([
      { kind: 'tool', index: 0, id: 't1', name: 'Bash', ref: 1 },
      ...pieces.map((json, i) => ({ kind: 'input', index: 0, json, ref: 2 + i })),
      { kind: 'engine', ref: 9 },
      { kind: 'stop', stopReason: 'tool_use', usage: null, ref: 10 },
    ])
    const gen = maskToolArgs(stream, s => Promise.resolve(m.mask(s)))
    for (let r = await gen.next(); !r.done; r = await gen.next()) out.push(r.value as never)
    const kinds = out.map(c => c.kind)
    expect(kinds.lastIndexOf('input')).toBeLessThan(kinds.indexOf('engine'))
    const json = out.filter(c => c.kind === 'input').map(c => c.json).join('')
    expect(json).not.toContain('Northwind')
    expect(JSON.parse(json)).toBeTruthy()
  })
}

// Regression: arguments in the API's own JSON formatting (spaces, escapes) were
// re-serialised even with nothing to mask, so the engine marked the response
// as rewritten by a mod and auto mode refused every Bash, Edit and Write call.
test('API-formatted arguments with nothing to mask pass on as the very same chunks', async () => {
  const m = new Masker(LIST as never)
  const pieces = [
    { kind: 'input', index: 0, json: '{"command": "ls -la ', ref: 2 },
    { kind: 'input', index: 0, json: '\\u00e9t\\u00e9 \\/tmp", ', ref: 3 },
    { kind: 'input', index: 0, json: '"description": "List \\u2014 files"}', ref: 4 },
  ]
  const stream = fakeStream([{ kind: 'tool', index: 0, id: 't1', name: 'Bash', ref: 1 }, ...pieces, { kind: 'engine', ref: 9 }])
  const out: unknown[] = []
  const gen = maskToolArgs(stream, s => Promise.resolve(m.mask(s)))
  for (let r = await gen.next(); !r.done; r = await gen.next()) out.push(r.value)
  const inputs = out.filter(c => (c as { kind: string }).kind === 'input')
  expect(inputs.length).toBe(3)
  inputs.forEach((c, i) => expect(c).toBe(pieces[i]))
})

test('API-formatted arguments with a name are still masked', async () => {
  const m = new Masker(LIST as never)
  const stream = fakeStream([
    { kind: 'tool', index: 0, id: 't1', name: 'Agent', ref: 1 },
    { kind: 'input', index: 0, json: '{"prompt": "brief for Northwind ', ref: 2 },
    { kind: 'input', index: 0, json: 'Revenue \\u2014 draft"}', ref: 3 },
    { kind: 'engine', ref: 9 },
  ])
  const out: { kind: string; json?: string }[] = []
  const gen = maskToolArgs(stream, s => Promise.resolve(m.mask(s)))
  for (let r = await gen.next(); !r.done; r = await gen.next()) out.push(r.value as never)
  const json = out.filter(c => c.kind === 'input').map(c => c.json).join('')
  expect(json).not.toContain('Northwind')
  expect(JSON.parse(json).prompt).toContain('CLIENT_3')
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
  disk(on, JSON.stringify({ startOn: true, model: { enabled: false }, terms: [{ real: 'TRM', placeholder: 'SAP' }] }))
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
  disk(on, JSON.stringify({ model: { enabled: false }, terms: [{ real: 'TRM', placeholder: 'SAP' }] }))
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
  disk(on, JSON.stringify({ model: { enabled: false }, terms: [{ real: 'Northwind Revenue', placeholder: 'CLIENT_3' }] }))
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
  disk(on, JSON.stringify({ model: { enabled: false }, terms: [] }))
  on('ui.status', () => ({ value: undefined }) as never)
  const listFile = [HOME, '.claude', 'client' + '-mask', 'terms.json'].join('/')
  const r = await $.tool.call({ tool: 'Read', file_path: listFile } as never)
  expect(JSON.stringify(r)).toContain('private')
})

// /client-mask-folder: every text file under a folder is masked on disk by the
// list, inside the mod; no model is involved, and the answer names no file.
const tree = (on: On, list: Record<string, unknown>) => {
  const files: Record<string, string> = { [LIST_PATH]: JSON.stringify(list) }
  const isDir = (p: string) => Object.keys(files).some(f => f.startsWith(`${p}/`))
  mock.env(on, { HOME })
  mock.clock(on)
  on('session.cwd', () => ({ value: '/w' }) as never)
  on('fs.exists', ($, e) => ({ value: e.path in files || isDir(e.path) }))
  on('fs.stat', ($, e) => ({ value: { kind: isDir(e.path) ? ('dir' as const) : ('file' as const), size: (files[e.path] ?? '').length, mtimeMs: 1, isLink: false } }))
  on('fs.read', ($, e) => ({ value: files[e.path] ?? '' }))
  on('fs.write', ($, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('fs.list', ($, e) => {
    const names = new Set<string>()
    for (const f of Object.keys(files)) if (f.startsWith(`${e.path}/`)) names.add(f.slice(e.path.length + 1).split('/')[0] as string)
    return { value: [...names].map(name => ({ name, kind: isDir(`${e.path}/${name}`) ? ('dir' as const) : ('file' as const), size: 1, mtimeMs: 1, isLink: false })) } as never
  })
  on('process.run', ($, e) => {
    const [cmd, , from, to] = (e as unknown as { argv: string[] }).argv
    if (cmd === 'mv' && from !== undefined && to !== undefined) {
      files[to] = files[from] ?? ''
      delete files[from]
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  const store: Record<string, unknown> = {}
  on('store.get', ($, e) => ({ value: store[e.key] }) as never)
  on('store.set', ($, e) => {
    store[e.key] = e.value
    return { value: undefined } as never
  })
  on('ui.status', () => ({ value: undefined }) as never)
  return files
}

test('/client-mask-folder masks every text file under a folder on disk, TRM to SAP, and names no file', async ($, on) => {
  const files = tree(on, { terms: [{ real: 'TRM', placeholder: 'SAP' }, { real: 'Northwind Revenue', placeholder: 'CLIENT_3' }] })
  files['/w/docs/plan.md'] = 'TRM go-live is in March.'
  files['/w/docs/sub/notes.txt'] = 'TRM and SAP for Northwind Revenue'
  files['/w/docs/plain.md'] = 'nothing listed'
  files['/w/docs/.git/config'] = 'TRM'
  files['/w/docs/data.bin'] = 'TRM\u0000'
  const r = await $.command.run({ command: 'client-mask-folder', args: 'docs' } as never)
  expect(files['/w/docs/plan.md']).toBe('SAP go-live is in March.')
  expect(files['/w/docs/sub/notes.txt']).toBe('SAP and SAP for CLIENT_3')
  expect(files['/w/docs/plain.md']).toBe('nothing listed')
  expect(files['/w/docs/.git/config']).toBe('TRM')
  expect(files['/w/docs/data.bin']).toBe('TRM\u0000')
  expect(files[`${HOME}/${ORIGINALS}/w/docs/plan.md`]).toBe('TRM go-live is in March.')
  const text = JSON.stringify(r)
  expect(text).toContain('Masked 2 files')
  expect(text).not.toContain('plan.md')
  expect(text).not.toContain('Northwind')
})

test('/client-mask-folder refuses the home folder and Claude\'s own folder', async ($, on) => {
  const files = tree(on, { terms: [{ real: 'TRM', placeholder: 'SAP' }] })
  files[`${HOME}/a.md`] = 'TRM'
  for (const args of ['~', '~/.claude', '']) {
    await $.command.run({ command: 'client-mask-folder', args } as never)
  }
  expect(files[`${HOME}/a.md`]).toBe('TRM')
})

// "maskOnDiskIn": only the folders named there are ever rewritten on disk.
test('with maskOnDiskIn, only files in those folders are masked on disk; wiki pages never are', async ($, on) => {
  const files = inPlace(on, { maskOnDiskIn: ['/w/Review'], terms: [...LIST.terms, { real: 'TRM', placeholder: 'SAP' }] })
  on('session.cwd', () => ({ value: '/w' }) as never)
  files['/w/Review/plan.md'] = 'TRM go-live'
  files['/w/review/70 Tooling /sdd.md'] = 'TRM tooling'
  files['/w/wiki/pages/fica.md'] = 'TRM/PSCD in FI-CA'
  on('tool.call', () => ({ result: { content: 'ok' } }) as never)
  await $.tool.call({ tool: 'Read', file_path: '/w/Review/plan.md' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/w/review/70 Tooling /sdd.md' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/w/wiki/pages/fica.md' } as never)
  await $.tool.call({ tool: 'Bash', command: 'grep -n SAP wiki/pages/fica.md' } as never)
  expect(files['/w/Review/plan.md']).toBe('SAP go-live')
  expect(files['/w/review/70 Tooling /sdd.md']).toBe('SAP tooling')
  expect(files['/w/wiki/pages/fica.md']).toBe('TRM/PSCD in FI-CA')
})

test('with maskOnDiskIn, a full rewrite of a wiki page that holds real names is still refused', async ($, on) => {
  const files = inPlace(on, { maskOnDiskIn: ['/w/Review'] })
  files['/w/wiki/pages/client.md'] = 'Prepared for Northwind Revenue.'
  let ran = false
  on('tool.call', () => {
    ran = true
    return { result: { content: 'ok' } } as never
  })
  const r = await $.tool.call({ tool: 'Write', file_path: '/w/wiki/pages/client.md', content: 'Prepared for CLIENT_3.' } as never)
  expect(ran).toBe(false)
  expect(JSON.stringify(r)).toContain('CLIENT_3')
  expect(files['/w/wiki/pages/client.md']).toBe('Prepared for Northwind Revenue.')
})

test('/client-mask-folder refuses a folder outside maskOnDiskIn and masks one inside it', async ($, on) => {
  const files = tree(on, { maskOnDiskIn: ['/w/Review'], terms: [{ real: 'TRM', placeholder: 'SAP' }] })
  files['/w/wiki/pages/fica.md'] = 'TRM/PSCD'
  files['/w/Review/a.md'] = 'TRM review'
  const out = JSON.stringify(await $.command.run({ command: 'client-mask-folder', args: 'wiki' } as never))
  expect(out).toContain('outside the folders')
  expect(files['/w/wiki/pages/fica.md']).toBe('TRM/PSCD')
  await $.command.run({ command: 'client-mask-folder', args: '/w' } as never)
  expect(files['/w/wiki/pages/fica.md']).toBe('TRM/PSCD')
  expect(files['/w/Review/a.md']).toBe('SAP review')
})

test('/client-mask-tidy rewrites the list readably, keeps the version before, and names nothing', async ($, on) => {
  const files = tree(on, { terms: [] })
  const messy = '{"startOn":false,"terms":[{"placeholder":"CLIENT_3","real":"Northwind Revenue"}, // main client\n{"real":"TRM","placeholder":"SAP"},]}'
  files[LIST_PATH] = messy
  const r = JSON.stringify(await $.command.run({ command: 'client-mask-tidy', args: '' } as never))
  expect(r).toContain('Tidied your masking list: 2 terms')
  expect(r).not.toContain('Northwind')
  expect(files[`${LIST_PATH}.before-tidy`]).toBe(messy)
  const tidied = files[LIST_PATH] ?? ''
  expect(tidied).toContain('// main client')
  expect(tidied).toContain('{ "real": "Northwind Revenue", "placeholder": "CLIENT_3" }')
  // The tidied list is read by the mod as before: the name is still masked.
  const again = JSON.stringify(await $.command.run({ command: 'client-mask-tidy', args: '' } as never))
  expect(again).toContain('already tidy')
})

test('/client-mask-tidy leaves a tidy list and its saved copy alone, whatever its line endings', async ($, on) => {
  const files = tree(on, { terms: [] })
  files[LIST_PATH] = '{"terms":[{"real":"TRM","placeholder":"SAP"}]}'
  await $.command.run({ command: 'client-mask-tidy', args: '' } as never)
  const original = files[`${LIST_PATH}.before-tidy`]
  files[LIST_PATH] = (files[LIST_PATH] ?? '').replace(/\n/g, '\r\n').replace(/\s+$/, '')
  const r = JSON.stringify(await $.command.run({ command: 'client-mask-tidy', args: '' } as never))
  expect(r).toContain('already tidy')
  expect(files[`${LIST_PATH}.before-tidy`]).toBe(original)
})

test('with the model wanted but not installed, nothing is sent: the request is stopped', async ($, on) => {
  disk(on, JSON.stringify({ startOn: true, terms: [] }))
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('session.messages', () => ({ value: [{ role: 'user', content: 'hi' }] }) as never)
  stepBeneath(on, ['{"prompt":"ok"}'])
  const { chunks } = await runStep($)
  expect(JSON.stringify(chunks)).toContain('masking model is not installed')
  expect(chunks.some(c => c.kind === 'input')).toBe(false)
})

test('with the model switched off in the list, the list and detectors still mask', async ($, on) => {
  disk(on, JSON.stringify({ startOn: true, model: { enabled: false }, terms: [{ real: 'Northwind Revenue', placeholder: 'CLIENT_3' }] }))
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('session.messages', () => ({ value: [{ role: 'user', content: 'hi' }] }) as never)
  stepBeneath(on, ['{"prompt":"brief for Northwind Revenue"}'])
  const { chunks } = await runStep($)
  expect(chunks.filter(c => c.kind === 'input').map(c => c.json).join('')).toBe('{"prompt":"brief for CLIENT_3"}')
})
