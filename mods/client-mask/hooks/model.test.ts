import { test, expect } from 'claude-code/testing'
import { DEFAULT_LABELS, ModelLayer, ScanCache, companySpans, machineId, validateModel, WITHHELD_NOTE, newBudget } from './model'
import type { SpanFinder } from './model'
import { DeadlineError } from './pii/engine'
import { Detector } from './detect'
import { Masker } from './mask'

// A pretend model: tags every given word as the given label, wherever it occurs.
const fake = (tags: Record<string, string>, opts: { slow?: boolean; calls?: { n: number } } = {}): SpanFinder => ({
  tokens: t => Math.ceil(t.length / 4),
  async detect(text, deadline) {
    if (opts.calls) opts.calls.n++
    if (opts.slow || performance.now() > deadline) throw new DeadlineError()
    const out: { start: number; end: number; label: string }[] = []
    for (const [word, label] of Object.entries(tags)) {
      let i = text.indexOf(word)
      while (i >= 0) {
        out.push({ start: i, end: i + word.length, label })
        i = text.indexOf(word, i + word.length)
      }
    }
    return out.sort((a, b) => a.start - b.start)
  },
})

const masker = new Masker({ terms: [{ real: 'Northwind Revenue', placeholder: 'CLIENT_3' }] })
const layer = (finder: SpanFinder, external: SpanFinder | null = null, extra = {}) =>
  new ModelLayer(finder, external, { marked: t => masker.marked(t), ...extra })

test('what the model finds is masked one way, by kind', async () => {
  const r = await layer(fake({ 'Priya Raman': 'PERSON', 'Halverton Utilities': 'ORG' })).scan('Priya Raman at Halverton Utilities agreed.')
  expect(r.text).toBe('‹PERSON› at ‹ORG› agreed.')
  expect(r.withheld).toBeUndefined()
})

test('a second kind of name (PERSON_L2) is masked as a person', async () => {
  const r = await layer(fake({ 'Dr Raman': 'PERSON_L2' })).scan('Ask Dr Raman.')
  expect(r.text).toBe('Ask ‹PERSON›.')
})

test('a placeholder or label already in the text is never masked again', async () => {
  const text = masker.mask('Northwind Revenue Holdings, mail ‹EMAIL›')
  const r = await layer(fake({ 'CLIENT_3 Holdings': 'ORG', '‹EMAIL›': 'EMAIL' })).scan(text)
  expect(r.text).toBe('CLIENT_3 ‹ORG›, mail ‹EMAIL›')
})

test('a span is left only when every word of it is an allowed word', async () => {
  const l = layer(fake({ HANA: 'PERSON', 'Priya HANA': 'PERSON', Joule: 'PERSON' }))
  expect((await l.scan('HANA and Joule')).text).toBe('HANA and Joule')
  expect((await l.scan('Priya HANA wrote')).text).toBe('‹PERSON› wrote')
})

test('your own allowed words are left alone; short words never count as allowed', async () => {
  const l = layer(fake({ Contoso: 'ORG', PM: 'PERSON_L2' }), null, { allow: ['contoso'] })
  expect((await l.scan('Contoso PM')).text).toBe('Contoso ‹PERSON›')
})

test('kinds switched off are not masked', async () => {
  const l = layer(fake({ 'https://x.example/a': 'URL', Priya: 'PERSON' }), null, { labels: ['PERSON'] })
  expect((await l.scan('Priya at https://x.example/a')).text).toBe('‹PERSON› at https://x.example/a')
})

test('a second pass runs only when the first masked something, and masking its output changes nothing', async () => {
  const calls = { n: 0 }
  const l = layer(fake({ Priya: 'PERSON' }, { calls }))
  await l.scan('nothing here')
  expect(calls.n).toBe(1)
  calls.n = 0
  const r = await l.scan('Priya called')
  expect(calls.n).toBe(2)
  expect(r.stable).toBe(true)
  expect((await l.scan(r.text)).text).toBe(r.text)
})

test('a text over the token limit is withheld, never passed on unscanned', async () => {
  const r = await layer(fake({}), null, { maxTokens: 10 }).scan('x'.repeat(200))
  expect(r.withheld).toBe('too long')
})

test('a scan that runs out of hook time goes to the helper when there is one', async () => {
  const helperCalls = { n: 0 }
  const l = layer(fake({ Priya: 'PERSON' }, { slow: true }), fake({ Priya: 'PERSON' }, { calls: helperCalls }))
  const r = await l.scan('Priya called')
  expect(r.text).toBe('‹PERSON› called')
  expect(helperCalls.n).toBeGreaterThan(0)
})

test('a text too long for the hook budget goes straight to the helper', async () => {
  const inlineCalls = { n: 0 }
  const helperCalls = { n: 0 }
  const l = layer(fake({ Priya: 'PERSON' }, { calls: inlineCalls }), fake({ Priya: 'PERSON' }, { calls: helperCalls }))
  const r = await l.scan(`Priya ${'word '.repeat(4000)}`, newBudget(50))
  expect(inlineCalls.n).toBe(0)
  expect(helperCalls.n).toBeGreaterThan(0)
  expect(r.text.startsWith('‹PERSON› ')).toBe(true)
})

test('without a helper, a scan out of time is withheld', async () => {
  const r = await layer(fake({ Priya: 'PERSON' }, { slow: true })).scan('Priya called')
  expect(r.withheld).toBe('too slow')
})

test('a model that fails is withheld, never passed on unscanned', async () => {
  const broken: SpanFinder = { tokens: () => 1, detect: async () => { throw new Error('boom') } }
  const r = await layer(broken).scan('Priya called')
  expect(r.withheld).toBe('failed')
  expect(WITHHELD_NOTE.failed.startsWith('‹WITHHELD›')).toBe(true)
})

test('the cache knows clean texts by salted hash and forgets them when the list changes', async () => {
  const c = new ScanCache()
  await c.init('salt', 'list v1', [])
  const k = await c.key('hello')
  expect(c.isClean(k)).toBe(false)
  c.markClean(k)
  expect(c.isClean(k)).toBe(true)
  expect(k).not.toContain('hello')
  const saved = c.takeSaved() ?? []
  await c.init('salt', 'list v2', [])
  c.load(saved)
  expect(c.isClean(await c.key('hello'))).toBe(false)
})

test('the model setting is checked field by field, naming fields only', () => {
  expect(validateModel(undefined)).toEqual([])
  expect(validateModel({ enabled: false, size: 'medium', labels: ['PERSON'], sensitivity: 0.5, maxTokens: 5000, timeoutMs: 1000, allow: ['contoso'] })).toEqual([])
  expect(validateModel({ size: 'huge' }).join()).toContain('model.size')
  expect(validateModel({ labels: ['NAME'] }).join()).toContain('model.labels')
  expect(validateModel({ sensitivity: Number.NaN }).join()).toContain('model.sensitivity')
  expect(validateModel({ colour: 'red' }).join()).toContain('unknown setting')
  expect(validateModel('on').join()).toContain('must be an object')
})

test('the detectors stay fast on long runs of letters (no quadratic patterns)', () => {
  const d = new Detector()
  for (const s of ['a'.repeat(32000), 'ab_-'.repeat(8000), '1'.repeat(32000), 'A1'.repeat(16000)]) {
    const t = performance.now()
    d.mask(s)
    d.leaks(s)
    expect(performance.now() - t).toBeLessThan(150)
  }
})

test('the secrets rule still finds a secret after the speed fix', () => {
  const d = new Detector()
  expect(d.mask('"client_secret": "abcd1234"')).toBe('"client_secret": "‹SECRET›"')
  expect(d.mask("password = 'hunter22'")).toBe("password = '‹SECRET›'")
  expect(d.mask('x"apiKey":"q1w2e3r4"')).toBe('x"apiKey":"‹SECRET›"')
})

test('companies the model tends to miss are caught by their company word', async () => {
  const t = 'The Halverton Utilities team met Fenwick & Lyle plc and Brackenridge Logistics Ltd.'
  const found = companySpans(t).map(s => t.slice(s.start, s.end))
  expect(found).toEqual(['Halverton Utilities', 'Fenwick & Lyle plc', 'Brackenridge Logistics Ltd.'])
  const r = await layer(fake({})).scan('Ask Gravenmoor Insurance about it.')
  expect(r.text).toBe('Ask ‹ORG› about it.')
  // A lone company word or a sentence start is not a company.
  expect(companySpans('Group results. The Bank opened.').length).toBe(0)
})

test('the model does not mask secrets by default: the detectors do that, precisely', async () => {
  expect(DEFAULT_LABELS.includes('SECRET')).toBe(false)
  const r = await layer(fake({ rHjMqo: 'SECRET' })).scan('folder spare-rHjMqo here')
  expect(r.text).toBe('folder spare-rHjMqo here')
})

test('IDs and user names inside a file path, and machine IDs, are left; an all-digit number is still masked', async () => {
  const t = 'cd /Users/kim/work/9f3a1c2e-77b1 then id 00482913'
  expect(machineId(t, t.indexOf('kim'), t.indexOf('kim') + 3, 'USERNAME')).toBe(true)
  expect(machineId('run 9f3a1c2e-77b1-40aa now', 4, 22, 'ID_NUMBER')).toBe(true)
  const n = t.indexOf('00482913')
  expect(machineId(t, n, n + 8, 'ID_NUMBER')).toBe(false)
  // A person's name in a path is still masked: only IDs and user names are left there.
  expect(machineId(t, t.indexOf('kim'), t.indexOf('kim') + 3, 'PERSON')).toBe(false)
  const r = await layer(fake({ kim: 'USERNAME', '00482913': 'ID_NUMBER' })).scan(t)
  expect(r.text).toBe('cd /Users/kim/work/9f3a1c2e-77b1 then id ‹ID_NUMBER›')
})

test('a path the model calls a URL is left; a real web address is still masked', () => {
  const t = 'updated /private/tmp/claude-501/x/edit-check.txt and see https://acme.example/kim'
  const p = t.indexOf('-501')
  expect(machineId(t, p, p + 4, 'URL')).toBe(true)
  const w = t.indexOf('https')
  expect(machineId(t, w, t.length, 'URL')).toBe(false)
})

test('a git short hash is a machine ID', () => {
  expect(machineId('commit 67a0b77 done', 7, 14, 'ID_NUMBER')).toBe(true)
})

test("the wiki's agent names and their @-commands are left, other names are not", async () => {
  const r = await layer(fake({ Alex: 'PERSON', '@sarah': 'USERNAME', 'Priya Raman': 'PERSON' })).scan('Alex asks @sarah and Priya Raman')
  expect(r.text).toBe('Alex asks @sarah and ‹PERSON›')
})
