// Pure logic: no engine calls, so it is testable on its own.

export type Seen = { wiki: number; web: number }

// Retrieval from a grounding server, or a read of the wiki's pages, index or lookup.
const WIKI_PATH = /wiki\/(?:pages|clusters)\b|\blookup\.md\b|\btier2-sections\.md\b/
const GROUNDING_HOUSEKEEPING = /__(?:about|refresh_index|submit_observation)$/
const WEB_TOOL =
  /^(?:WebSearch|WebFetch)$|^mcp__(?:Claude_Browser|claude-in-chrome)__(?:navigate|get_page_text|read_page|find)$|^mcp__Control_Chrome__get_page_content$/

export const kindOf = (tool: string, input: unknown): 'wiki' | 'web' | null => {
  if (/^mcp__[\w-]*grounding[\w-]*__/.test(tool)) return GROUNDING_HOUSEKEEPING.test(tool) ? null : 'wiki'
  if (WEB_TOOL.test(tool)) return 'web'
  if (/^(?:Read|Grep|Glob|Bash)$/.test(tool) && WIKI_PATH.test(JSON.stringify(input ?? ''))) return 'wiki'
  return null
}

// Wiki pages an answer cites: [T1 parent: a.md; b.md], [T2 devlabs: c.md], or a [WIKI] tag.
export const citedPages = (answer: string): string[] => {
  const pages = new Set<string>()
  for (const m of answer.matchAll(/\[T[12]\b[^\]]*?:\s*([^\]]+)\]/g)) {
    for (const p of m[1].split(/[;,]/)) {
      const name = p.trim().split(/[\s#]/)[0]
      if (name.endsWith('.md')) pages.add(name)
    }
  }
  const tags = answer.match(/\[WIKI\]/g)?.length ?? 0
  for (let i = 0; i < tags; i++) pages.add(`[WIKI] ${i + 1}`)
  return [...pages]
}

export type Verdict = { source: 'wiki' | 'web' | 'own'; text: string } | null

// The line shown under an answer. A short reply with no lookup (a "done") gets none.
export const verdict = (answer: string, seen: Seen): Verdict => {
  if (!answer.trim()) return null
  const cited = citedPages(answer).length
  const gap = /KNOWLEDGE GAP/.test(answer) ? ' · ⚠️ a knowledge gap is declared' : ''
  const web = seen.web > 0
  if (cited > 0 || seen.wiki > 0) {
    const what = cited > 0 ? `${cited} page${cited === 1 ? '' : 's'} cited` : `checked ${seen.wiki} time${seen.wiki === 1 ? '' : 's'}, nothing cited`
    return { source: 'wiki', text: `📚 From the wiki: ${what}${web ? ', plus the web' : ''}${gap}` }
  }
  if (web) return { source: 'web', text: `🌐 From the web, not the wiki${gap}` }
  if (answer.length < 300 && !gap) return null
  return { source: 'own', text: `🧠 From Claude's own knowledge: no wiki or web lookup this turn${gap}` }
}

// The health address beside a grounding server's /mcp address.
export const healthUrl = (mcpJson: string): string | null => {
  try {
    const servers = (JSON.parse(mcpJson) as { mcpServers?: Record<string, { url?: string }> }).mcpServers ?? {}
    const entry = Object.entries(servers).find(([name, s]) => /grounding/.test(name) && typeof s.url === 'string' && /^https?:/.test(s.url))
    if (!entry) return null
    const url = entry[1].url as string
    return url.endsWith('/mcp') ? `${url.slice(0, -4)}/health` : `${url.replace(/\/+$/, '')}/health`
  } catch {
    return null
  }
}
