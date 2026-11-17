import { test, expect } from 'claude-code/testing'

import { GENERATED, parseList, sameMeaning, tidyList } from './listfile'
import { KEEP_AS_IS, Masker, validate } from './mask'

const MESSY = `// my clients
{"startOn":true, "restoreInTools": [], "showRealNames":false,
 "_how": "old help text",
 "terms": [
  // the main client
  {"placeholder":"CLIENT_3","real":"Northwind Revenue"},
  {"real":"TRM","placeholder":"SAP"}, // one-way rule
  {"real": "Priya Okafor", "placeholder": "PERSON_1", "toFiles": false},
  {"real":"NWR","placeholder":"CLIENT_3",},
  {"pattern":"GB\\\\d{2}","placeholder":"IBAN"},
  {"real":"Acme Bank","placeholder":"CLIENT_1"},
  {"real":"Old Name","placeholder":""},
  /* to review */
 ],
 "maskOnDiskIn": ["~/Review"],
}
`

test('the list reads with notes and trailing commas, and means the same as plain JSON', () => {
  const p = parseList(MESSY)
  const v = p.value as { terms: unknown[]; startOn: boolean }
  expect(v.startOn).toBe(true)
  expect(v.terms.length).toBe(7)
  expect(validate(v)).toEqual([])
})

test('a broken list names a line, never its content', () => {
  let message = ''
  try {
    parseList('{\n  "terms": [\n    {"real": "Northwind Revenue" "placeholder": "X"}\n  ]\n}')
  } catch (err) {
    message = (err as Error).message
  }
  expect(message).toBe('the list is not valid JSON (line 3)')
})

test('tidy: settings first, terms grouped and aligned, notes kept, meaning unchanged', () => {
  const p = parseList(MESSY)
  const { text, terms, groups } = tidyList(p, 'Help for you.', KEEP_AS_IS)
  expect(terms).toBe(7)
  expect(groups).toBe(5)
  const back = parseList(text)
  expect(sameMeaning(p.value, back.value)).toBe(true)
  expect(text).not.toContain('old help text')
  expect(text).toContain('// the main client')
  expect(text).toContain('// one-way rule')
  expect(text).toContain('// to review')
  expect(text).toContain('// my clients')
  // Settings come before the terms; the two CLIENT_3 rows stay together, the first first.
  expect(text.indexOf('"maskOnDiskIn"')).toBeLessThan(text.indexOf('"terms"'))
  expect(text.indexOf('"Northwind Revenue"')).toBeLessThan(text.indexOf('"NWR"'))
  expect(text.indexOf('"Acme Bank"')).toBeLessThan(text.indexOf('"Northwind Revenue"'))
  // Tidying a tidy list changes nothing, and generated lines are not doubled.
  const again = tidyList(back, 'Help for you.', KEEP_AS_IS).text
  expect(again).toBe(text)
  expect(text.split(`// ${GENERATED}One-way`).length).toBe(2)
})

test('tidy keeps what the masker does: same masking, same names turned back', () => {
  const p = parseList(MESSY)
  const back = parseList(tidyList(p, 'h', KEEP_AS_IS).text)
  const a = new Masker(p.value as never)
  const b = new Masker(back.value as never)
  const sample = 'Northwind Revenue and NWR use TRM; Priya Okafor; Acme Bank; Old Name; GB12'
  expect(b.mask(sample)).toBe(a.mask(sample))
  expect(b.restore('CLIENT_3 CLIENT_1 SAP')).toBe(a.restore('CLIENT_3 CLIENT_1 SAP'))
  const byPlaceholder = (l: [string, string][]) => [...l].sort((x, y) => (x[0] + x[1] < y[0] + y[1] ? -1 : 1))
  expect(byPlaceholder(b.legend())).toEqual(byPlaceholder(a.legend()))
})

test('sameMeaning catches a changed row order within a placeholder', () => {
  const a = { terms: [{ real: 'A', placeholder: 'P' }, { real: 'B', placeholder: 'P' }] }
  const b = { terms: [{ real: 'B', placeholder: 'P' }, { real: 'A', placeholder: 'P' }] }
  expect(sameMeaning(a, b)).toBe(false)
})
