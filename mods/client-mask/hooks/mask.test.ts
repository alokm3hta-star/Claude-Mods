import { test, expect } from 'claude-code/testing'

import { Masker, REMOVED, namesList, validate } from './mask'
import type { Config } from './mask'

const LIST: Config = {
  terms: [
    { real: 'Northwind Revenue', placeholder: 'CLIENT_3' },
    { real: 'NWR', placeholder: 'CLIENT_3' },
    { real: 'Priya Okafor', placeholder: 'PERSON_1' },
    { pattern: 'GB\\d{2} ?[A-Z]{4}(?: ?\\d{4}){3} ?\\d{2}', placeholder: 'IBAN' },
  ],
}

test('a name becomes the placeholder you chose, the same every time', async () => {
  const text = 'Northwind Revenue (NWR) wrote to Priya Okafor; nwr agreed.'
  const once = new Masker(LIST).mask(text)
  expect(once).toBe('CLIENT_3 (CLIENT_3) wrote to PERSON_1; CLIENT_3 agreed.')
  expect(new Masker(LIST).mask(text)).toBe(once)
})

test('a placeholder turns back into the first spelling listed for it', async () => {
  const m = new Masker(LIST)
  expect(m.restore('Dear PERSON_1, about CLIENT_3')).toBe('Dear Priya Okafor, about Northwind Revenue')
  expect(m.restore('CLIENT_30 and XCLIENT_3 stay as they are')).toBe('CLIENT_30 and XCLIENT_3 stay as they are')
})

test('a pattern is masked and never turned back', async () => {
  const m = new Masker(LIST)
  const out = m.mask('Pay GB82 WEST 1234 5698 7654 32 today')
  expect(out).toBe('Pay IBAN today')
  expect(m.restore(out)).toBe('Pay IBAN today')
})

test('masking text that is already masked changes nothing', async () => {
  const m = new Masker(LIST)
  const out = m.mask('Northwind Revenue')
  expect(m.mask(out)).toBe(out)
})

test('the leak check names the placeholder, never the name', async () => {
  const m = new Masker(LIST)
  expect(m.leaks('CLIENT_3 met Priya Okafor')).toEqual(['PERSON_1'])
  expect(m.leaks('CLIENT_3 met PERSON_1')).toEqual([])
})

test('a list with mistakes is refused, by row number and without quoting a name', async () => {
  expect(validate(LIST)).toEqual([])
  expect(validate({})).toEqual(['the list has no "terms" rows'])
  const problems = validate({
    terms: [
      { real: 'Northwind Revenue', placeholder: 'client 3' },
      { real: 'Northwind Revenue', placeholder: 'CLIENT_4' },
      { placeholder: 'X' },
      { real: 'NWR', pattern: 'x', placeholder: 'Y' },
      { real: 'Acme' },
    ],
  })
  expect(problems.length).toBe(4)
  expect(problems.join(' ')).not.toContain('Northwind')
  expect(validate({ terms: [{ real: 'Client', placeholder: 'CLIENT_9' }] })).toEqual([
    'row 1: the placeholder contains a name from the list',
  ])
})

test('a tool call that names the list folder is caught; the mod folder is not', async () => {
  const home = '/Users/t'
  expect(namesList({ command: 'cat ~/.claude/client-mask/terms.json' }, home)).toBe(true)
  expect(namesList({ command: 'ls $HOME/.claude/client-mask' }, home)).toBe(true)
  expect(namesList({ file_path: '/Users/t/.claude/client-mask/terms.json' }, home)).toBe(true)
  expect(namesList({ command: 'cd ~/.claude && cat client-mask/terms.json' }, home)).toBe(true)
  expect(namesList({ file_path: '/Users/t/.claude/mods/client-mask/hooks/mask.ts' }, home)).toBe(false)
})

test('on screen, placeholders show the real name, marked; code stays plain', async () => {
  const m = new Masker(LIST)
  expect(m.display('CLIENT_3 wrote to PERSON_1 about `CLIENT_3`', true)).toBe('**Northwind Revenue**🔒 wrote to **Priya Okafor**🔒 about `Northwind Revenue`')
  expect(m.display('```\nconst c = "CLIENT_3"\n```', true)).toBe('```\nconst c = "Northwind Revenue"\n```')
  expect(m.display('Ask CLIENT_3 at ‹EMAIL›', false)).toBe('Ask Northwind Revenue🔒 at ‹EMAIL›')
})

test('what a message gained is counted per placeholder and label', async () => {
  const m = new Masker(LIST)
  const before = 'NWR and Northwind Revenue, mail a@b.co'
  const after = new Masker({ ...LIST }).mask(before)
  const counts = m.markCounts(after)
  expect(counts.get('CLIENT_3')).toBe(2)
  expect(counts.get('‹EMAIL›')).toBe(1)
})

test('any text is a placeholder, and a blank one removes the name for good', async () => {
  const list: Config = {
    terms: [
      { real: 'Northwind Revenue', placeholder: 'the client (bank)' },
      { real: 'Priya Okafor', placeholder: '' },
    ],
  }
  expect(validate(list)).toEqual([])
  const m = new Masker(list)
  expect(m.mask('Northwind Revenue told Priya Okafor no.')).toBe('the client (bank) told  no.')
  expect(m.removed).toBe(1)
  expect(m.restore('Dear the client (bank)')).toBe('Dear Northwind Revenue')
  expect(m.restore('nothing comes back for a removed name')).toBe('nothing comes back for a removed name')
  expect(m.leaks('Priya Okafor is here')).toEqual([REMOVED])
  expect(m.legend()).toEqual([
    ['the client (bank)', 'Northwind Revenue'],
    [REMOVED, 'Priya Okafor'],
  ])
})
