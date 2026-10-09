import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { added, checks, issues } from './style'

test('dashes, American spelling and banned words are each found, by line', async () => {
  const text = 'One line — with a dash.\nWe organize the colors.\nA seamless rollout.\nA list:\n- item - with a spaced hyphen'
  const found = issues(text)
  expect(found.map(i => `${i.line}:${i.key}`)).toEqual(['1:em dash', '5:spaced hyphen', '2:organize', '2:colors', '3:seamless'])
  expect(found.find(i => i.key === 'organize')?.fix).toBe('organise')
})

test('code, links, comments and capitalised names are left alone', async () => {
  const text = [
    'Run `npm run organize` here —', // the dash is outside the code
    '```',
    'const color = "gray" — x',
    '```',
    'See [the guide](https://example.com/organize-colors).',
    'The Sales Organization and Authorization objects stay as SAP spells them.',
    'A resize, a prize, downsizing, a constructor and a citizen are fine.',
  ].join('\n')
  expect(issues(text).map(i => i.key)).toEqual(['em dash'])
})

test('a file can switch a check off, and your keep list is respected', async () => {
  expect(issues('<!-- allow: dashes -->\nA — B')).toEqual([])
  expect(issues('<!-- house-style: off -->\nA — B, organize')).toEqual([])
  expect(issues('the modeling tool', { keep: ['modeling tool'] })).toEqual([])
})

test('an edit is judged only on what it adds', async () => {
  const old = 'Old line — kept.'
  expect(added(old, `${old} New text.`)).toEqual([])
  expect(added(old, `${old} New — dash.`).length).toBe(2)
})

test('only documents are checked, and skipped folders are left alone', async () => {
  expect(checks('/p/README.md')).toBe(true)
  expect(checks('/p/src/app.ts')).toBe(false)
  expect(checks('/Users/a/.claude/projects/x/memory/MEMORY.md')).toBe(false)
  expect(checks('/p/wiki/raw/source.md')).toBe(false)
  expect(checks('/p/drafts/post.md', { skipPaths: ['/drafts/'] })).toBe(false)
})

const disk = (on: On, files: Record<string, string>) => {
  mock.env(on, { HOME: '/home/t' })
  on('fs.exists', ($, e) => ({ value: e.path in files }))
  on('fs.read', ($, e) => ({ value: files[e.path] ?? '' }))
}

test('a document with a new dash is refused with the line to fix; a clean one is written', async ($, on) => {
  disk(on, { '/p/notes.md': 'Old — line.' })
  let wrote = 0
  on('tool.call', () => {
    wrote++
    return { result: {} } as never
  })
  const bad = await $.tool.call({ tool: 'Write', file_path: '/p/new.md', content: 'Intro.\nWe prioritize this.' } as never)
  expect(JSON.stringify(bad)).toContain('line 2')
  expect(JSON.stringify(bad)).toContain('prioritise')
  await $.tool.call({ tool: 'Write', file_path: '/p/notes.md', content: 'Old — line.\nAnd a clean one.' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/p/notes.md', old_string: 'Old', new_string: 'Older' } as never)
  expect(wrote).toBe(2)
})

test('your own banned words from rules.json are refused too', async ($, on) => {
  disk(on, { '/home/t/.claude/house-style/rules.json': JSON.stringify({ bannedWords: ['synergy'] }) })
  on('tool.call', () => ({ result: {} }) as never)
  const r = await $.tool.call({ tool: 'Edit', file_path: '/p/a.md', old_string: 'x', new_string: 'Real synergy.' } as never)
  expect(JSON.stringify(r)).toContain('synergy')
})
