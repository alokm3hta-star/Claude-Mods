// Reads a project's own command list and playbooks into buttons. Pure: no engine calls.

export type Cmd = { group: string; command: string; label: string; description: string; text: string; mode: 'run' | 'fill' }

const ACRONYMS = new Set(['ABAP', 'AI', 'API', 'ATC', 'BTP', 'CAP', 'MCP', 'RAP', 'SAP', 'UI'])

const acronyms = (s: string) => s.split(' ').map(w => (ACRONYMS.has(w.toUpperCase()) ? w.toUpperCase() : w)).join(' ')

// "CAP DEV (Dan, CAP and React)" reads as "CAP dev"; "INGESTION" as "Ingestion".
const tidyGroup = (g: string) =>
  g
    .replace(/\(.*$/, '')
    .replace(/[:#*`]/g, '')
    .trim()
    .split(/\s+/)
    .map((w, i) => (ACRONYMS.has(w.toUpperCase()) ? w.toUpperCase() : i === 0 ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()))
    .join(' ')

// One command as a button: what it says, what it sends, and whether it needs more from you.
export const toCmd = (group: string, command: string, description: string): Cmd | null => {
  const c = command.trim()
  const m = /^([@/][\w-]+)(.*)$/.exec(c)
  if (!m) return null
  const head = m[1] ?? ''
  const rest = (m[2] ?? '').trim()
  const needs = /[[<]/.test(c)
  const fixed = needs ? c.slice(0, c.search(/[[<]/)).trimEnd() : c
  const words = (head.startsWith('/') ? head.slice(1) : rest).replace(/[[<][^\]>]*[\]>]/g, '').replace(/-/g, ' ').trim()
  if (!words) return null
  const tidy = acronyms(words)
  const label = tidy[0]!.toUpperCase() + tidy.slice(1) + (needs ? '…' : '')
  return { group: tidyGroup(group), command: c, label, description: description.trim(), text: needs ? `${fixed} ` : fixed, mode: needs ? 'fill' : 'run' }
}

// From CLAUDE.md: the cheat-sheet blocks ("GROUP:" then "  @agent verb [arg]  — what it does")
// and command tables ("| `@agent verb` | what it does |"), in the order they appear.
export const fromInstructions = (text: string): Cmd[] => {
  const out: Cmd[] = []
  let inBlock = false
  let group = 'Commands'
  let heading = 'Commands'
  for (const line of text.split('\n')) {
    if (/^```/.test(line)) {
      inBlock = !inBlock
      continue
    }
    const h = /^#{2,4}\s+(.+)$/.exec(line)
    if (!inBlock && h) heading = h[1] ?? heading
    if (inBlock) {
      const g = /^([A-Z][A-Z0-9 ]+)(?:\s*\(.*\))?:\s*$/.exec(line)
      if (g) group = g[1] ?? group
      const c = /^\s+([@/][\w-]+(?:[^—]*?))\s+—\s+(.+)$/.exec(line)
      if (c) {
        const cmd = toCmd(group, c[1] ?? '', c[2] ?? '')
        if (cmd) out.push(cmd)
      }
      continue
    }
    const t = /^\|\s*`([@/][\w-]+ [^`]+)`\s*\|\s*([^|]*)\|/.exec(line)
    if (t) {
      const cmd = toCmd(heading, t[1] ?? '', (t[2] ?? '').replace(/`/g, '').slice(0, 120))
      if (cmd) out.push(cmd)
    }
  }
  // First mention wins; a group of several agents names each one.
  const seen = new Set<string>()
  const unique = out.filter(c => !seen.has(c.text) && seen.add(c.text))
  const agents = new Map<string, Set<string>>()
  for (const c of unique) {
    const a = /^@\w+/.exec(c.command)?.[0]
    if (a) agents.set(c.group, (agents.get(c.group) ?? new Set()).add(a))
  }
  return unique.map(c => {
    const a = /^@(\w+)/.exec(c.command)?.[1]
    return a && (agents.get(c.group)?.size ?? 0) > 1 ? { ...c, label: `${a[0]!.toUpperCase()}${a.slice(1)}: ${ACRONYMS.has(c.label.split(' ')[0]!.replace('…', '')) ? c.label : c.label[0]!.toLowerCase() + c.label.slice(1)}` } : c
  })
}

// A playbook (a project skill) as a button that fills /name for you to finish.
export const fromSkill = (skillMd: string): Cmd | null => {
  const name = /^name:\s*(.+)$/m.exec(skillMd)?.[1]?.trim()
  if (!name) return null
  const description = /^description:\s*(.+)$/m.exec(skillMd)?.[1]?.trim() ?? ''
  const label = name.replace(/-/g, ' ')
  return { group: 'Playbooks', command: `/${name}`, label: `${label[0]!.toUpperCase()}${label.slice(1)}…`, description, text: `/${name} `, mode: 'fill' }
}

export const groups = (cmds: Cmd[]): [string, Cmd[]][] => {
  const map = new Map<string, Cmd[]>()
  for (const c of cmds) map.set(c.group, [...(map.get(c.group) ?? []), c])
  return [...map.entries()]
}

// Ingest queue size, from the count line the scan script writes.
export const queued = (ingestQueue: string): number => Number(/^count:\s*(\d+)/m.exec(ingestQueue)?.[1] ?? 0)
