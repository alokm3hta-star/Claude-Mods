// Pure logic over the wiki's own files: no engine calls, so it is testable on its own.

// ---------- frontmatter ----------

export const frontmatter = (text: string): Record<string, string> => {
  const m = /^---\n([\s\S]*?)\n---/.exec(text)
  const out: Record<string, string> = {}
  if (!m) return out
  for (const line of (m[1] ?? '').split('\n')) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line)
    if (kv?.[1]) out[kv[1]] = (kv[2] ?? '').trim()
  }
  return out
}

// Sets (or adds) frontmatter fields, leaving the rest of the file exactly as it was.
export const setFields = (text: string, fields: Record<string, string>): string => {
  const m = /^---\n([\s\S]*?)\n---/.exec(text)
  if (!m) return text
  let block = m[1] ?? ''
  for (const [k, v] of Object.entries(fields)) {
    const re = new RegExp(`^${k}:.*$`, 'm')
    block = re.test(block) ? block.replace(re, `${k}: ${v}`) : `${block}\n${k}: ${v}`
  }
  return `---\n${block}\n---${text.slice(m[0].length)}`
}

// ---------- proposals ----------

export type Proposal = { file: string; id: string; title: string; type: string; target: string; priority: string; date: string; body: string; reviewed: string }

export const proposal = (file: string, text: string): Proposal | null => {
  const f = frontmatter(text)
  if (f.status !== 'pending') return null
  const rest = text.replace(/^---\n[\s\S]*?\n---\n?/, '')
  const title = /^#\s+(.+)$/m.exec(rest)?.[1] ?? f.id ?? file
  const body = rest.replace(/^#\s+.+$/m, '').trim()
  return { file, id: f.id ?? '', title, type: f.type ?? '', target: f.target ?? '', priority: f.priority ?? '', date: f.date ?? '', body, reviewed: f.reviewed ?? '' }
}

// Oldest first, by number.
export const byNumber = (a: Proposal, b: Proposal) => (Number(a.id.replace(/\D/g, '')) || 0) - (Number(b.id.replace(/\D/g, '')) || 0)

// ---------- session findings ----------

export type Finding = { fact: string; evidence: string; page?: string; at: string }

export const findings = (jsonl: string): Finding[] =>
  jsonl
    .split('\n')
    .filter(l => l.trim())
    .flatMap(l => {
      try {
        const f = JSON.parse(l) as Finding
        return typeof f.fact === 'string' && typeof f.evidence === 'string' ? [f] : []
      } catch {
        return []
      }
    })

export const toJsonl = (list: Finding[]) => list.map(f => JSON.stringify(f)).join('\n') + (list.length ? '\n' : '')

// What the catcher asks of the session. Facts only, each with its proof.
export const HARVEST_PROMPT = [
  'Look back over this session for durable facts worth adding to the wiki.',
  'Keep a fact only if this session proved it with evidence you can name: a test that passed or failed, a response from a real system, a document or API description that was read.',
  'Leave out anything that was read from the wiki itself, opinions, plans, to-dos, guesses, and any client name, person, email address or secret.',
  'Answer with one JSON object per line and nothing else: {"fact": "...", "evidence": "...", "page": "the wiki page it belongs on, if you know"}.',
  'At most 6 lines. If there is nothing, answer exactly NONE.',
].join(' ')

export const parseHarvest = (text: string, at: string): Finding[] => {
  if (/^\s*NONE\s*$/.test(text)) return []
  return findings(text.replace(/^```\w*\n?|```$/gm, '')).map(f => ({ ...f, at })).slice(0, 6)
}

// Lines of `fact` already known to a wiki's lookup index: the identifiers it
// names (KONV, /UI2/FLP, cds.ql) found among the index's entities.
export const knownIn = (fact: string, lookup: string): string[] => {
  const ids = [...new Set(fact.match(/(?<![\w/])[A-Z][A-Z0-9_/]{2,}(?![\w/])|\b[a-z]+(?:\.[a-z_]+)+\b/g) ?? [])]
  const start = lookup.indexOf('\n## Entities')
  if (start < 0 || ids.length === 0) return []
  const end = lookup.indexOf('\n## ', start + 5)
  const section = lookup.slice(start, end < 0 ? undefined : end)
  const pages = new Set<string>()
  for (const id of ids) {
    const row = new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\| (.+)$`, 'm').exec(section)
    if (row) for (const p of (row[1] ?? '').split(/,\s*/)) pages.add(p.trim())
  }
  return [...pages].slice(0, 5)
}

// ---------- where we left off ----------

export type Brief = { handoff: string | null; blockers: string[]; actions: string[]; notes: string | null }

const tableRows = (text: string, heading: RegExp): string[][] => {
  const at = text.search(heading)
  if (at < 0) return []
  const rest = text.slice(at).split('\n').slice(1)
  const rows: string[][] = []
  for (const l of rest) {
    if (/^## /.test(l)) break
    if (!/^\|/.test(l) || /^\|[-\s|]+\|$/.test(l)) continue
    rows.push(l.split('|').slice(1, -1).map(c => c.trim()))
  }
  return rows.slice(1).filter(r => !/^_?none_?$/i.test(r[0] ?? ''))
}

const plain = (s: string, n = 140) => {
  const t = s.replace(/\*\*|`/g, '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

export const brief = (files: { handoff?: string; blockers?: string; actions?: string; notes?: string }): Brief => {
  const h = files.handoff ? frontmatter(files.handoff) : {}
  const handoff = h.status === 'open' ? `${h.created ?? ''}: ${plain(h.session_focus ?? '', 400)}` : null
  const blockers = files.blockers ? tableRows(files.blockers, /^## Active/m).map(r => `${plain(r[0] ?? '')} (since ${r[1] ?? '?'})`) : []
  const actions = files.actions ? tableRows(files.actions, /^## Active Items/m).map(r => `${r[0]} ${plain(r[1] ?? '')} (since ${r[2] ?? '?'})`) : []
  const notes = files.notes ? plain(files.notes.replace(/^#.*$/m, ''), 600) : null
  return { handoff, blockers, actions, notes }
}
