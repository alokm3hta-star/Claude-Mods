import { test, expect } from 'claude-code/testing'

import { actionItems, activity, blockers, handoffFocus, handoffOpen, idList, ingestCount, isArchive, jumpLink, merge, newSessionLink, openCount, parseAgents, parseBeat, pendingInTable, question, sessionFolder, showBand } from './board'
import type { Agent } from './board'
import type { Beat } from '../types'

const NOW = 1_800_000_000_000
const A = (over: Partial<Agent>): Agent => ({ cwd: '/w/Dev Labs', kind: 'interactive', startedAt: NOW - 60_000, pid: 1, status: 'idle', sessionId: 's1', ...over })
const B = (over: Partial<Beat>): Beat => ({ id: 's1', project: 'Dev Labs', cwd: '/w/Dev Labs', state: 'working', detail: 'editing board.ts', since: NOW - 120_000, updated: NOW, ...over })

test('the session list is read; closed sessions and finished jobs are left out', async () => {
  const agents = parseAgents(
    JSON.stringify([
      A({ sessionId: 'a', status: 'busy' }),
      A({ sessionId: 'b', pid: undefined, status: undefined }),
      A({ sessionId: 'c', kind: 'background', state: 'done', pid: undefined }),
      A({ sessionId: 'd', kind: 'background', state: 'working', pid: undefined }),
    ]),
  )
  expect(merge(agents, [], 'a', NOW).map(r => r.key)).toEqual(['a', 'd'])
  expect(parseAgents('not json')).toEqual([])
})

test('waiting sessions say why and come first', async () => {
  const rows = merge(
    [
      A({ sessionId: 'w', status: 'busy', cwd: '/w/LLM Wiki' }),
      A({ sessionId: 'p', status: 'waiting', waitingFor: 'permission prompt', cwd: '/w/swift-invoicing' }),
      A({ sessionId: 'q', status: 'waiting', waitingFor: 'input needed', cwd: '/w/Travel Plan' }),
    ],
    [],
    '',
    NOW,
  )
  expect(rows.map(r => [r.project, r.status, r.why])).toEqual([
    ['swift-invoicing', 'approval', 'wants your approval'],
    ['Travel Plan', 'asked', 'needs your answer'],
    ['LLM Wiki', 'working', ''],
  ])
})

test("a session's own file adds what it is doing, and an idle one that asked a question waits on you", async () => {
  const [busy] = merge([A({ status: 'busy' })], [B({})], 's1', NOW)
  expect(busy.detail).toBe('editing board.ts')
  expect(busy.self).toBe(true)
  const [asked] = merge([A({ status: 'idle' })], [B({ state: 'asked', detail: 'Which one first?' })], '', NOW)
  expect(asked.status).toBe('asked')
})

test('the button shows only when more than one session is doing something', async () => {
  const one = merge([A({ sessionId: 'a', status: 'busy' }), A({ sessionId: 'b', status: 'idle' })], [], '', NOW)
  const two = merge([A({ sessionId: 'a', status: 'busy' }), A({ sessionId: 'b', status: 'waiting', waitingFor: 'permission prompt' })], [], '', NOW)
  expect(showBand(one)).toBe(false)
  expect(showBand(two)).toBe(true)
})

test('only text the model wrote, or a file name, describes the activity', async () => {
  expect(activity('Bash', { command: 'npm test', description: 'Run the CAP tests' })).toBe('Run the CAP tests')
  expect(activity('Edit', { file_path: '/w/x/hooks/board.ts' })).toBe('editing board.ts')
  expect(activity('Agent', { description: 'Survey studios', prompt: 'secret stuff' })).toBe('helper: Survey studios')
  expect(activity('mcp__wiki-grounding__search', {})).toBe('using wiki-grounding')
})

test('an answer that ends on a question is noticed', async () => {
  expect(question('Done.\n\n**Which one should I build first?**')).toBe('Which one should I build first?')
  expect(question('All done.')).toBeNull()
})

test('retired and backup folders are skipped', async () => {
  expect(isArchive('LLM Dev (retired 2026-09-16)')).toBe(true)
  expect(isArchive('LLM Wiki Backup')).toBe(true)
  expect(isArchive('Dev Labs')).toBe(false)
  expect(sessionFolder('/Users/Alok', '/Users/Alok/Desktop/Claude Workspace/Dev Labs')).toBe('/Users/Alok/.claude/projects/-Users-Alok-Desktop-Claude-Workspace-Dev-Labs')
})

test('action items, blockers, handoffs and the ingest queue are read from the wiki files', async () => {
  const items = '# Open\n\n## Active Items\n\n| ID | Title | Created |\n|---|---|---|\n| AI-002 | Stage the restore batch | 2026-09-18 |\n| AI-004 | Ingest the sizing | 2026-10-07 |\n\n## Closed Items\n\n| ID | Title |\n|---|---|\n| AI-001 | Done one |\n'
  expect(actionItems(items)).toEqual([{ id: 'AI-002', title: 'Stage the restore batch' }, { id: 'AI-004', title: 'Ingest the sizing' }])
  const bl = '## Active\n\n| Blocker | Since | Detail |\n|---|---|---|\n| **0TPR detail is scoped by a guard** (interim). More words here. | 2026-07-25 | x |\n\n## Resolved\n\n| Blocker | Resolved |\n|---|---|\n| old | 2026-01-01 |\n'
  expect(blockers(bl)).toEqual([{ title: '0TPR detail is scoped by a guard (interim).', since: '2026-07-25' }])
  expect(handoffFocus('---\nstatus: open\nsession_focus: "board mock"\n---\n')).toBe('board mock')
  expect(ingestCount('---\ncount: 3\n---\n')).toBe(3)
  expect(idList(['SP-110', 'SP-9', 'SP-50'])).toBe('SP-9, SP-50, SP-110')
  expect(idList(['A-1', 'A-2', 'A-3'], 2)).toBe('A-1, A-2 and 1 more')
})

test('links open a desktop session, or a new one in a folder with the step filled in', async () => {
  expect(jumpLink('local_abc-1')).toBe('claude://code/continue?session=local_abc-1')
  expect(newSessionLink('/Users/A/Dev Labs', 'Run action item AI-002')).toBe('claude://code/new?folder=%2FUsers%2FA%2FDev%20Labs&q=Run%20action%20item%20AI-002')
})

test('review queues, handoffs and blockers are counted', async () => {
  expect(pendingInTable('| ID | Status |\n|---|---|\n| P-1 | pending |\n| P-2 | approved |\n| P-3 | Pending |\n')).toBe(2)
  expect(handoffOpen('---\nstatus: open\ncreated: 2026-10-08\n---\n')).toBe('open handoff from 2026-10-08')
  expect(handoffOpen('---\nstatus: consumed\n---\n')).toBeNull()
  expect(openCount('**Open Count:** 1\n')).toBe(1)
})

test('a malformed session file is ignored', async () => {
  expect(parseBeat('{')).toBeNull()
  expect(parseBeat(JSON.stringify(B({})))?.detail).toBe('editing board.ts')
})



test('the board draws in a narrow side panel on desktop and terminal', async ($, on) => {
  on('process.run', async () => ({ exitCode: 0, stdout: '[]', stderr: '' }) as never)
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as never
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'workspace-board', surface, component: 'Pane', requestId: 'workspace-board', props: { requestId: 'workspace-board', columns: 40, bodyColumns: 36, maxRows: 40 } as never })
    expect(await ui.find({ type: 'Text', text: /Sessions waiting on you/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Waiting for your review/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /Refresh/ } as never)).toBeDefined()
    await ui.unmount()
  }
})
