import { test, expect } from 'claude-code/testing'

import { Masker } from './mask'
import { scrubFile, scrubLine } from './scrub'

const m = new Masker({ terms: [{ real: 'Northwind Revenue', placeholder: 'CLIENT_3' }] })
const mask = (s: string) => m.mask(s)

test('a saved row keeps its place and its ids; only the name is masked', async () => {
  const row = {
    type: 'user',
    uuid: 'u-1',
    sessionId: 's-1',
    cwd: '/work/Northwind Revenue',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't-1', content: 'Dear Northwind Revenue' }] },
    toolUseResult: { filePath: '/x/Northwind Revenue.md', content: 'Northwind Revenue invoice' },
  }
  const out = JSON.parse(scrubLine(JSON.stringify(row), mask))
  expect(out.uuid).toBe('u-1')
  expect(out.sessionId).toBe('s-1')
  // Where the conversation ran stays as it is, so it can still be reopened.
  expect(out.cwd).toBe('/work/Northwind Revenue')
  expect(out.message.content[0].content).toBe('Dear CLIENT_3')
  expect(out.toolUseResult.filePath).toBe('/x/CLIENT_3.md')
  expect(out.toolUseResult.content).toBe('CLIENT_3 invoice')
})

test('signed thinking is left alone', async () => {
  const row = { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Northwind Revenue', signature: 'sig' }] } }
  const line = JSON.stringify(row)
  expect(scrubLine(line, mask)).toBe(line)
})

test('a file with nothing to mask is reported unchanged, byte for byte', async () => {
  const text = '{"type":"user","message":{"content":"hello"}}\n{"display":"CLIENT_3 is fine"}\n'
  const r = scrubFile(text, mask)
  expect(r.changed).toBe(false)
  expect(r.text).toBe(text)
})

test('a typed-prompt history line is masked; a broken line is masked as text', async () => {
  const text = '{"display":"email Northwind Revenue","project":"/work"}\n{"display":"Northwind Revenue cut'
  const r = scrubFile(text, mask)
  expect(r.changed).toBe(true)
  expect(r.text).not.toContain('Northwind Revenue')
  expect(JSON.parse(r.text.split('\n')[0]).project).toBe('/work')
})
