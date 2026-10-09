import type { EngineInterface, Register } from 'claude-code'

import { added, checks, report } from './style'
import type { Rules } from './style'

// Your own additions live in ~/.claude/house-style/rules.json; without it the
// built-in rules apply.
async function loadRules($: EngineInterface): Promise<Rules> {
  const home = (await $.env.get('HOME')) ?? ''
  const file = `${home}/.claude/house-style/rules.json`
  try {
    if (!(await $.fs.exists(file))) return {}
    return JSON.parse(await $.fs.read(file)) as Rules
  } catch {
    $.ui.toast('house-style: rules.json is not valid JSON; the built-in rules apply', { timeoutMs: 6000 })
    return {}
  }
}

export const register: Register = on => {
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const r = await loadRules($)
    if (!checks(e.file_path, r)) return next(e)
    const before = (await $.fs.exists(e.file_path)) ? await $.fs.read(e.file_path) : ''
    const found = added(before, e.content, r)
    return found.length ? { deny: report(e.file_path, found) } : next(e)
  })
    // A check that fails lets the write through rather than block your work.
    .catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const r = await loadRules($)
    if (!checks(e.file_path, r)) return next(e)
    const found = added(e.old_string, e.new_string, r)
    return found.length ? { deny: report(e.file_path, found, 'of your new text') } : next(e)
  }).catch(($, e, next) => next(e))
}
