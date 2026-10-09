import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { brief, knownIn, parseHarvest, proposal, setFields } from './desk'
import { fromInstructions, fromSkill, groups, queued } from './commands'

const SP = (n: number, status = 'pending') =>
  `---\nid: SP-${n}\ndate: 2026-10-07\ntype: enrich\ntarget: wiki/pages/cap/x.md\npriority: medium\nstatus: ${status}\n---\n\n# SP-${n} — Add the outbox fact\n\nBody line.\n`

test('a pending proposal is read; others are not', async () => {
  expect(proposal('/f', SP(3))?.title).toBe('SP-3 — Add the outbox fact')
  expect(proposal('/f', SP(3, 'executed'))).toBeNull()
})

test('setting a status changes that field alone', async () => {
  const out = setFields(SP(3), { status: 'approved', reviewed: '2026-10-09' })
  expect(out).toContain('status: approved')
  expect(out).toContain('reviewed: 2026-10-09')
  expect(out.split('\n').slice(9)).toEqual(SP(3).split('\n').slice(8))
})

test('a harvest answer becomes findings; NONE becomes none', async () => {
  const text = '{"fact": "cds.ql INSERT returns the key", "evidence": "npm test passed"}\nnot json\n'
  expect(parseHarvest(text, '2026-10-09')).toEqual([{ fact: 'cds.ql INSERT returns the key', evidence: 'npm test passed', at: '2026-10-09' }])
  expect(parseHarvest('NONE', 'd')).toEqual([])
})

test('a finding names the wiki pages that already know its objects', async () => {
  const lookup = '## Pages\n\n## Entities\n`x`\n\nKONV | sd/pricing.md, sd/conditions.md\ncds.ql | cap-dev/cap-cds-ql.md\n\n## Edges\n'
  expect(knownIn('Table KONV is replaced in S/4HANA', lookup)).toEqual(['sd/pricing.md', 'sd/conditions.md'])
  expect(knownIn('cds.ql INSERT returns the key', lookup)).toEqual(['cap-dev/cap-cds-ql.md'])
  expect(knownIn('nothing named here', lookup)).toEqual([])
})

test('where we left off reads the handoff, blockers and action items', async () => {
  const b = brief({
    handoff: '---\nstatus: open\ncreated: 2026-10-08\nsession_focus: Build slice 3\n---\n',
    blockers: '## Active\n\n| Blocker | Since | Detail |\n|---|---|---|\n| **Guard on root** | 2026-07-25 | d |\n\n## Resolved\n',
    actions: '## Active Items\n\n| ID | Title | Created |\n|---|---|---|\n| AI-001 | Approve batch | 2026-09-16 |\n',
  })
  expect(b.handoff).toBe('2026-10-08: Build slice 3')
  expect(b.blockers).toEqual(['Guard on root (since 2026-07-25)'])
  expect(b.actions).toEqual(['AI-001 Approve batch (since 2026-09-16)'])
})

const ROOT = '/w/wiki-project'
let sent: string[] = []
let filled: string[] = []

const disk = (on: On, files: Record<string, string>, root = ROOT) => {
  mock.clock(on)
  on('session.cwd', () => ({ value: root }) as never)
  on('session.start', () => ({ cwd: root }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('fs.exists', ($, e) => ({ value: e.path in files || Object.keys(files).some(f => f.startsWith(`${e.path}/`)) }))
  on('fs.read', ($, e) => ({ value: files[e.path] ?? '' }))
  on('fs.write', ($, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('fs.list', ($, e) => ({
    value: Object.keys(files)
      .filter(f => f.startsWith(`${e.path}/`))
      .map(f => ({ name: f.slice(e.path!.length + 1), kind: 'file' as const })),
  }) as never)
  on('ui.open', () => ({ value: { isOpen: true } }) as never)
  on('prompt.submit', ($, e) => {
    sent.push(String((e as { text?: string }).text))
    return { text: String((e as { text?: string }).text) } as never
  })
  on('prompt.fill', ($, e) => {
    filled.push(String((e as { text?: string }).text))
    return { isFilled: true } as never
  })
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as never
  })
  return files
}

test('every write goes through; a new wiki page is listed for you to check', async ($, on) => {
  disk(on, { [`${ROOT}/wiki/pending/proposals/SP-1.md`]: SP(1), [`${ROOT}/wiki/pages/cap-dev/old.md`]: 'x' })
  let wrote = 0
  on('tool.call', () => {
    wrote++
    return { result: {} } as never
  })
  await $.session.start({ source: 'startup', cwd: ROOT } as never)
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/wiki/pages/cap-dev/cap-outbox.md`, content: 'x' } as never)
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/wiki/pages/cap-dev/old.md`, content: 'y' } as never)
  expect(wrote).toBe(2)
  await $.command.run({ command: 'wiki-pages' } as never)
  const pane = await $.ui.mount({ plugin: 'control-panel', surface: 'terminal', component: 'Pane', requestId: 'control-panel', props: {} as never })
  expect(await pane.find({ type: 'Markdown', text: /cap-dev\/cap-outbox\.md/ })).toBeDefined()
  expect(await pane.find({ type: 'Markdown', text: /old\.md/ })).toBeUndefined()
  await pane.unmount()
})

test('the band counts what is unread; Keep marks a proposal read and leaves it pending; Reject rejects it', async ($, on) => {
  const files = disk(on, { [`${ROOT}/wiki/pending/proposals/SP-1.md`]: SP(1), [`${ROOT}/wiki/pending/proposals/SP-2.md`]: SP(2, 'executed'), [`${ROOT}/wiki/pending/proposals/SP-3.md`]: SP(3) })
  await $.session.start({ source: 'startup', cwd: ROOT } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'control-panel', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 } as never })
    expect(await band.find({ type: 'Text', text: /things? needs? you/ })).toBeDefined()
    await band.unmount()
  }
  await $.command.run({ command: 'wiki-review' } as never)
  const pane = await $.ui.mount({ plugin: 'control-panel', surface: 'terminal', component: 'Pane', requestId: 'control-panel', props: {} as never })
  expect(await pane.find({ type: 'Markdown', text: /Add the outbox fact/ })).toBeDefined()
  await pane.press({ key: 'keep' })
  expect(files[`${ROOT}/wiki/pending/proposals/SP-1.md`]).toContain('status: pending')
  expect(files[`${ROOT}/wiki/pending/proposals/SP-1.md`]).toContain('reviewed: ')
  await pane.press({ key: 'reject' })
  expect(files[`${ROOT}/wiki/pending/proposals/SP-3.md`]).toContain('status: rejected')
  await pane.unmount()
})

const INSTRUCTIONS = [
  '# Rules',
  '```',
  'INGESTION:',
  '  @kylie convert [file]       — convert PDF to splits',
  '  @anja status                — current wiki state',
  'CAP DEV (Dan — CAP and React):',
  '  @dan test [repo]            — run the CAP gate',
  '  @paul mcp status            — is it up',
  '```',
  '## Status commands',
  '| `@jarvis status` | Read the state |',
  '| `@jarvis` | (main thread) | roster row, not a command |',
].join('\n')

test('a project\'s cheat sheet and command tables become grouped buttons', async () => {
  const cmds = fromInstructions(INSTRUCTIONS)
  expect(groups(cmds).map(([g]) => g)).toEqual(['Ingestion', 'CAP dev', 'Status commands'])
  expect(cmds.map(c => `${c.label}|${c.mode}|${c.text}`)).toEqual([
    'Kylie: convert…|fill|@kylie convert ',
    'Anja: status|run|@anja status',
    'Dan: test…|fill|@dan test ',
    'Paul: MCP status|run|@paul mcp status',
    'Status|run|@jarvis status',
  ])
})

test('a playbook becomes a button that fills its slash command', async () => {
  expect(fromSkill('---\nname: clean-abap\ndescription: Tidy ABAP.\n---\n')).toEqual({ group: 'Playbooks', command: '/clean-abap', label: 'Clean abap…', description: 'Tidy ABAP.', text: '/clean-abap ', mode: 'fill' })
  expect(queued('---\ncount: 2\n---')).toBe(2)
})

test('the panel lists what needs you; a run button sends, a fill button fills the prompt', async ($, on) => {
  sent = []
  filled = []
  disk(on, {
    [`${ROOT}/CLAUDE.md`]: INSTRUCTIONS,
    [`${ROOT}/wiki/pending/proposals/SP-1.md`]: SP(1),
    [`${ROOT}/wiki/pending/handoff.md`]: '---\nstatus: open\ncreated: 2026-10-08\nsession_focus: Admin screen\n---\n',
    [`${ROOT}/wiki/pending/action-items.md`]: '## Active Items\n\n| ID | Title | Created |\n|---|---|---|\n| AI-003 | Ingest notes | 2026-09-24 |\n',
  })
  await $.session.start({ source: 'startup', cwd: ROOT } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'control-panel', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 } as never })
    expect(await band.find({ type: 'Text', text: /3 things need you/ })).toBeDefined()
    await band.unmount()
  }
  await $.command.run({ command: 'panel' } as never)
  const pane = await $.ui.mount({ plugin: 'control-panel', surface: 'terminal', component: 'Pane', requestId: 'control-panel', props: {} as never })
  expect(await pane.find({ type: 'Text', text: /Open handoff from 2026-10-08: Admin screen/ })).toBeDefined()
  await pane.press({ key: 'need-handoff-Resume' })
  await pane.press({ key: 'need-AI-003-Run' })
  await pane.press({ key: 'c-@kylie convert ' })
  await pane.press({ key: 'c-@anja status' })
  expect(sent).toEqual(['@alex resume-handoff', 'Run action item AI-003', '@anja status'])
  expect(filled).toEqual(['@kylie convert '])
  await pane.unmount()
})

test('a project without a wiki still gets its commands', async ($, on) => {
  disk(on, { [`/w/plain/CLAUDE.md`]: INSTRUCTIONS }, '/w/plain')
  await $.session.start({ source: 'startup', cwd: '/w/plain' } as never)
  const band = await $.ui.mount({ plugin: 'control-panel', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 } as never })
  expect(await band.find({ type: 'Text', text: /nothing needs you/ })).toBeDefined()
  await band.unmount()
})
