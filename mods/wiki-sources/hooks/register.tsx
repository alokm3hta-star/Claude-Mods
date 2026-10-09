import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { healthUrl, kindOf, verdict } from './sources'
import type { Seen } from './sources'
import type { Server, Tally } from '../types'

const isWikiProject = atom({ plugin: 'wiki-sources', key: 'isWikiProject' } as const, false)
const server = atom({ plugin: 'wiki-sources', key: 'server' } as const, 'none' as Server)
const tally = atom({ plugin: 'wiki-sources', key: 'tally' } as const, { wiki: 0, web: 0, own: 0 } as Tally)

// Whether the session's project draws on a wiki: a grounding server, a wiki
// folder, or project instructions that speak of one.
async function inspectProject($: EngineInterface): Promise<{ isWiki: boolean; health: string | null }> {
  const cwd = await $.session.cwd()
  const text = async (f: string) => ((await $.fs.exists(`${cwd}/${f}`)) ? await $.fs.read(`${cwd}/${f}`) : '')
  const health = healthUrl(await text('.mcp.json'))
  const isWiki = health !== null || (await $.fs.exists(`${cwd}/wiki/index.md`)) || /\bwiki\b/i.test(await text('CLAUDE.md'))
  return { isWiki, health }
}

async function probe($: EngineInterface, url: string): Promise<Server> {
  try {
    const r = await $.http.fetch(url)
    return r.ok && /ok/i.test(r.text.slice(0, 200)) ? 'up' : 'down'
  } catch {
    return 'down'
  }
}

export const register: Register = on => {
  let seen: Seen = { wiki: 0, web: 0 }

  on('session.start', async ($, e, next) => {
    const project = await inspectProject($).catch(() => ({ isWiki: false, health: null }))
    await update($, isWikiProject, () => project.isWiki)
    if (project.health) {
      const url = project.health
      await update($, server, () => 'down')
      void probe($, url).then(s => update($, server, () => s))
      $.clock.every(60000, () => void probe($, url).then(s => update($, server, () => s)))
    }
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    seen = { wiki: 0, web: 0 }
    return next(e)
  })

  // Counts what the turn looked things up in, its subagents' lookups included.
  on('tool.call', ($, e, next) => {
    const kind = kindOf(String(e.tool), e)
    if (kind) seen[kind]++
    return next(e)
  })

  // A line under each answer saying where it came from. It is shown on your
  // screen only; the model never reads it.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId || e.reason !== 'answer' || !(await read($, isWikiProject))) return r
    const v = verdict(e.answer, seen)
    if (!v) return r
    await update($, tally, t => ({ ...(t ?? { wiki: 0, web: 0, own: 0 }), [v.source]: (t?.[v.source] ?? 0) + 1 }))
    return { ...r, text: v.text }
  })

  // The band: the wiki server's light and this session's tally.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey || !(await read($, isWikiProject))) return below
    const s = await read($, server)
    const t = await read($, tally)
    const { Box, Text } = $.ui.resolve(e)
    const line = (
      <Box flexDirection="row">
        {s === 'none' ? null : (
          <Text>
            <Text dimColor>Wiki server </Text>
            <Text color={s === 'up' ? 'success' : 'error'}>{s === 'up' ? '● up' : '○ down'}</Text>
            <Text dimColor>{'  ·  '}</Text>
          </Text>
        )}
        <Text dimColor>Answers this session: </Text>
        <Text>{`📚 wiki ${t.wiki}  🌐 web ${t.web}  🧠 own ${t.own}`}</Text>
      </Box>
    )
    return below ? (
      <Box flexDirection="column">
        {line}
        {below}
      </Box>
    ) : (
      line
    )
  })
}
