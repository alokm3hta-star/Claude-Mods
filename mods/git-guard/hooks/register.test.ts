import { test, expect, mock } from 'claude-code/testing'

import { claudeLines, pushDirectory, writesMessage } from './guard'

const TRAILER = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'

test('every usual spelling of a Claude credit is found; ordinary lines are not', async () => {
  const text = [
    'Fix the parser',
    '',
    TRAILER,
    'Co-authored-by: Claude <noreply@anthropic.com>',
    '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
    'Claude-Session: https://claude.ai/code/abc',
    'Co-Authored-By: Priya <priya@example.com>',
    'Add the claude-mods README',
  ].join('\n')
  expect(claudeLines(text).length).toBe(4)
})

test('commit and pull request commands are recognised; others are not', async () => {
  expect(writesMessage('git commit -m "x"')).toBe(true)
  expect(writesMessage('cd repo && git -C . commit --amend')).toBe(true)
  expect(writesMessage('gh pr create --title t --body b')).toBe(true)
  expect(writesMessage('git status && echo commit')).toBe(false)
  expect(writesMessage('grep -r "Co-Authored-By" .')).toBe(false)
})

test('a push runs where its last cd or -C points', async () => {
  expect(pushDirectory('cd ~/repo && git push')).toBe('~/repo')
  expect(pushDirectory('cd "/a b" && cd sub && git push origin main')).toBe('sub')
  expect(pushDirectory('git -C "/x y" push')).toBe('/x y')
  expect(pushDirectory('git push')).toBeUndefined()
})

test('Claude is never asked to add the trailer or the footer', async ($, on) => {
  on('attribution.text', ($, e) => ({ text: `${e.kind} credit` }))
  expect((await $.attribution.text({ kind: 'commit', text: TRAILER })).text).toBe('')
  expect((await $.attribution.text({ kind: 'pr', text: '🤖 Generated' })).text).toBe('')
  expect((await $.attribution.text({ kind: 'remedy', text: 'r' })).text).toBe('remedy credit')
})

test('a commit that credits Claude is refused; a clean one runs', async ($, on) => {
  let ran = 0
  on('tool.call', () => {
    ran++
    return { result: { stdout: '' } } as never
  })
  const bad = await $.tool.call({ tool: 'Bash', command: `git commit -m "$(cat <<'EOF'\nFix\n\n${TRAILER}\nEOF\n)"` } as never)
  expect(JSON.stringify(bad)).toContain('git-guard')
  expect(ran).toBe(0)
  await $.tool.call({ tool: 'Bash', command: 'git commit -m "Fix"' } as never)
  expect(ran).toBe(1)
})

test('a push with an unpushed Claude-credited commit is stopped; a clean one goes', async ($, on) => {
  mock.env(on, { HOME: '/home/t' })
  on('session.cwd', () => ({ value: '/home/t/repo' }) as never)
  let log = `abc123\nFix\n\n${TRAILER}\n`
  on('process.run', () => ({ value: { exitCode: 0, stdout: log, stderr: '' } }) as never)
  let pushed = 0
  on('tool.call', () => {
    pushed++
    return { result: { stdout: '' } } as never
  })
  const r = await $.tool.call({ tool: 'Bash', command: 'git push' } as never)
  expect(JSON.stringify(r)).toContain('not yet pushed')
  expect(pushed).toBe(0)
  log = 'abc123\nFix\n'
  await $.tool.call({ tool: 'Bash', command: 'git push' } as never)
  expect(pushed).toBe(1)
})
