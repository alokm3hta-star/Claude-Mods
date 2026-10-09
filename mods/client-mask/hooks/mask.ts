import { DEFAULT_KEEP, Detector, LABEL } from './detect'
import type { Detect } from './detect'

// Pure masking logic: no engine calls, so it is testable on its own.
// You choose every placeholder yourself, so the same name always becomes the
// same placeholder. Nothing remembers what was swapped or where.

export type Entry = {
  // An exact name, matched ignoring case. Several rows may share a
  // placeholder; the first of them is the spelling it turns back into.
  real?: string
  // Or a regular expression (an IBAN, a tax ID). Masked, never turned back.
  pattern?: string
  // What the model sees instead, e.g. CLIENT_3. Any text you like; leave it
  // blank ("") to remove the name altogether, never turned back.
  placeholder: string
  wholeWord?: boolean
  // false keeps the placeholder even in files Claude writes, so the name never
  // lands in code, comments, file names or test data. Default true.
  toFiles?: boolean
}

export type Config = {
  enabled?: boolean
  wholeWord?: boolean
  restoreInTools?: string[]
  onLeak?: 'block' | 'warn' | 'off'
  blockBinaryFiles?: boolean
  // Refuse a message with a pasted picture, which cannot be masked. Default true.
  blockPictures?: boolean
  // Built-in detectors, each on unless set to false.
  detect?: Detect
  // Values the detectors leave alone (exact, or "*@domain").
  keep?: string[]
  // Folders of real client data Claude may never open.
  blockedFolders?: string[]
  // Show the real names again in replies on your screen, marked 🔒. Default true.
  showRealNames?: boolean
  terms: Entry[]
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const literal = (s: string, wholeWord: boolean) =>
  new RegExp(wholeWord ? `(?<![\\p{L}\\p{N}])${escape(s)}(?![\\p{L}\\p{N}])` : escape(s), 'giu')

// Problems with the list, by row number only: a message never quotes a name.
export const validate = (config: unknown): string[] => {
  const c = config as Partial<Config> | null
  if (!c || typeof c !== 'object' || !Array.isArray(c.terms)) return ['the list has no "terms" rows']
  const problems: string[] = []
  const strings = (v: unknown) => Array.isArray(v) && v.every(s => typeof s === 'string')
  if (c.blockedFolders !== undefined && !strings(c.blockedFolders)) problems.push('the list\'s "blockedFolders" must be a list of folder paths')
  if (c.keep !== undefined && !strings(c.keep)) problems.push('the list\'s "keep" must be a list of values')
  if (c.detect !== undefined && (typeof c.detect !== 'object' || c.detect === null)) problems.push('the list\'s "detect" must be an object of true/false switches')
  const realTo = new Map<string, string>()
  c.terms.forEach((t, i) => {
    const row = `row ${i + 1}`
    if (!t || typeof t !== 'object') return void problems.push(`${row} is not an entry`)
    if (typeof t.placeholder !== 'string') problems.push(`${row}: give a placeholder, or "" to remove the name`)
    const hasReal = typeof t.real === 'string' && t.real.trim() !== ''
    const hasPattern = typeof t.pattern === 'string' && t.pattern !== ''
    if (hasReal === hasPattern) problems.push(`${row}: give either "real" or "pattern"`)
    if (hasPattern) {
      try {
        new RegExp(t.pattern as string, 'gu')
      } catch {
        problems.push(`${row}: the pattern is not a valid regular expression`)
      }
    }
    if (hasReal) {
      const key = (t.real as string).toLowerCase()
      const before = realTo.get(key)
      if (before !== undefined && before !== t.placeholder) problems.push(`${row}: this name already has a different placeholder`)
      realTo.set(key, t.placeholder as string)
    }
  })
  if (problems.length > 0) return problems
  // A placeholder that contains a name would be masked again and never return.
  const wholeDefault = c.wholeWord ?? true
  c.terms.forEach((t, i) => {
    for (const other of c.terms ?? []) {
      if (!other.real) continue
      if (literal(other.real, other.wholeWord ?? wholeDefault).test(t.placeholder)) {
        problems.push(`row ${i + 1}: the placeholder contains a name from the list`)
        break
      }
    }
  })
  return problems
}

type Rule = { re: RegExp; placeholder: string }

// How a name removed altogether (a blank placeholder) is shown on your screen.
export const REMOVED = '(removed)'

export class Masker {
  private readonly rules: Rule[] = []
  private readonly back = new Map<string, string>()
  private readonly shown = new Map<string, string>()
  private readonly known: RegExp | null
  private readonly detector: Detector
  private readonly removedNames: string[] = []
  // How many names the last mask() call removed altogether.
  removed = 0

  constructor(config: Config) {
    this.detector = new Detector(config.detect, [...DEFAULT_KEEP, ...(config.keep ?? [])])
    const wholeDefault = config.wholeWord ?? true
    const literals: (Rule & { length: number })[] = []
    const patterns: Rule[] = []
    for (const t of config.terms) {
      if (t.pattern) {
        patterns.push({ re: new RegExp(t.pattern, 'gu'), placeholder: t.placeholder })
        continue
      }
      if (!t.real) continue
      if (t.placeholder === '') {
        literals.push({ re: literal(t.real, t.wholeWord ?? wholeDefault), placeholder: '', length: t.real.length })
        this.removedNames.push(t.real)
        continue
      }
      literals.push({ re: literal(t.real, t.wholeWord ?? wholeDefault), placeholder: t.placeholder, length: t.real.length })
      if (!this.shown.has(t.placeholder)) this.shown.set(t.placeholder, t.real)
      if (t.toFiles !== false && !this.back.has(t.placeholder)) this.back.set(t.placeholder, t.real)
    }
    // Longest first, so "Acme Bank" wins over "Acme".
    literals.sort((a, b) => b.length - a.length)
    this.rules.push(...literals.map(({ re, placeholder }) => ({ re, placeholder })), ...patterns)

    const all = [...new Set(config.terms.map(t => t.placeholder).filter(p => p !== ''))].sort((a, b) => b.length - a.length)
    this.known = all.length ? new RegExp(`(?<![A-Za-z0-9_])(?:${all.map(escape).join('|')})(?![A-Za-z0-9_])`, 'g') : null
  }

  get termCount() {
    return this.rules.length
  }

  get detectorCount() {
    return this.detector.count
  }

  // Apply `fn` only to the stretches of `text` that are not already
  // placeholders, so a name like "Client" never eats into CLIENT_3.
  private outside(text: string, fn: (part: string) => string) {
    if (!this.known) return fn(text)
    let out = ''
    let last = 0
    for (const m of text.matchAll(this.known)) {
      out += fn(text.slice(last, m.index)) + m[0]
      last = (m.index ?? 0) + m[0].length
    }
    return out + fn(text.slice(last))
  }

  mask(text: string): string {
    if (!text) return text
    let out = text
    this.removed = 0
    for (const rule of this.rules) {
      out = this.outside(out, part =>
        part.replace(rule.re, () => {
          if (rule.placeholder === '') this.removed++
          return rule.placeholder
        }),
      )
    }
    return this.outside(out, part => this.detector.mask(part))
  }

  restore(text: string): string {
    if (!text || !this.known) return text
    return text.replace(this.known, ph => this.back.get(ph) ?? ph)
  }

  // How many placeholders and labels a text carries, to count what was masked.
  marks(text: string): number {
    return (this.known ? (text.match(this.known)?.length ?? 0) : 0) + (text.match(/‹[A-Z_]+›/g)?.length ?? 0)
  }

  // Each placeholder and label a text carries, with how often.
  markCounts(text: string): Map<string, number> {
    const counts = new Map<string, number>()
    const all = [...(this.known ? text.match(this.known) ?? [] : []), ...(text.match(/‹[A-Z_]+›/g) ?? [])]
    for (const m of all) counts.set(m, (counts.get(m) ?? 0) + 1)
    return counts
  }

  // For your screen only: the real names put back, marked so you can see where
  // masking happened. In markdown a name outside code is drawn bold; inside code
  // it is left plain, so code stays as written. Labels stay as they are.
  display(text: string, markdown: boolean): string {
    if (!text || !this.known) return text
    const swap = (s: string, plain: boolean) =>
      s.replace(this.known as RegExp, ph => {
        const real = this.shown.get(ph)
        if (real === undefined) return ph
        return plain ? real : markdown ? `**${real}**🔒` : `${real}🔒`
      })
    if (!markdown) return swap(text, false)
    return text
      .split(/(```[\s\S]*?```|`[^`\n]*`)/)
      .map((part, i) => swap(part, i % 2 === 1))
      .join('')
  }

  // Placeholders of any name still present in clear text.
  leaks(text: string): string[] {
    const found = new Set<string>()
    for (const rule of this.rules) {
      this.outside(text, part => {
        rule.re.lastIndex = 0
        if (rule.re.test(part)) found.add(rule.placeholder || REMOVED)
        rule.re.lastIndex = 0
        return part
      })
    }
    this.outside(text, part => {
      for (const l of this.detector.leaks(part)) found.add(l)
      return part
    })
    return [...found]
  }

  // Placeholder and the name it turns back into, for the on-screen legend.
  legend(): [string, string][] {
    return [...this.shown.entries(), ...this.removedNames.map((real): [string, string] => [REMOVED, real])]
  }
}

// Whether a tool call names the folder that holds your list. The list stays
// out of Claude's reach; anything that slips past this still comes back masked.
export const LIST_FOLDER = /\.claude\/client-mask(?![\w.-])|client-mask\/(?:terms|vault)\b/i

export const namesList = (args: unknown, home: string): boolean => {
  let hit = false
  mapStrings(args, s => {
    if (LIST_FOLDER.test(s) || (home !== '' && s.includes(`${home}/.claude/client-mask`))) hit = true
    return s
  })
  return hit
}

// Whether a tool call names one of your blocked folders, written in full or
// from your home folder (~/ or $HOME/).
export const namesBlockedFolder = (args: unknown, home: string, folders: readonly string[]): boolean => {
  const forms = folders.flatMap(f => {
    const full = (f.startsWith('~/') ? `${home}/${f.slice(2)}` : f).replace(/\/+$/, '')
    if (!full) return []
    const short = home !== '' && full.startsWith(`${home}/`) ? full.slice(home.length + 1) : null
    return short ? [full, `~/${short}`, `$HOME/${short}`, `\${HOME}/${short}`] : [full]
  })
  let hit = false
  mapStrings(args, s => {
    if (forms.some(f => s.includes(f))) hit = true
    return s
  })
  return hit
}

// Whether a tool call would write a masked label (‹EMAIL›, ‹SECRET›…) somewhere:
// labels never turn back, so writing one would overwrite the real value.
export const writesLabel = (args: unknown): boolean => {
  let hit = false
  mapStrings(args, s => {
    if (LABEL.test(s)) hit = true
    return s
  })
  return hit
}

export const mapStrings = (value: unknown, fn: (s: string) => string): unknown => {
  if (typeof value === 'string') return fn(value)
  if (Array.isArray(value)) return value.map(v => mapStrings(v, fn))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]))
  }
  return value
}

type Block = { type: string; [field: string]: unknown }

// Rewrites the text a content block carries. Thinking blocks are signed by the
// API and images carry no searchable text, so both pass unchanged.
export const maskBlock = (b: Block, mask: (s: string) => string): Block => {
  switch (b.type) {
    case 'text':
      return typeof b.text === 'string' ? { ...b, text: mask(b.text) } : b
    case 'tool_use':
      return { ...b, input: mapStrings(b.input, mask) }
    case 'tool_result':
      if (typeof b.content === 'string') return { ...b, content: mask(b.content) }
      if (Array.isArray(b.content)) return { ...b, content: (b.content as Block[]).map(c => maskBlock(c, mask)) }
      return b
    case 'document': {
      const src = b.source as { type?: string; data?: unknown } | undefined
      return src?.type === 'text' && typeof src.data === 'string' ? { ...b, source: { ...src, data: mask(src.data) } } : b
    }
    default:
      return b
  }
}

export const maskContent = (content: unknown, mask: (s: string) => string): unknown => {
  if (typeof content === 'string') return mask(content)
  if (Array.isArray(content)) return (content as Block[]).map(b => maskBlock(b, mask))
  return content
}

// The text of a conversation the guard scans: everything but signed thinking
// and binary media.
export const scannable = (messages: { content: unknown }[]): string => {
  const parts: string[] = []
  const walk = (b: unknown) => {
    if (typeof b === 'string') return void parts.push(b)
    if (!b || typeof b !== 'object') return
    const block = b as Block
    if (block.type === 'thinking' || block.type === 'redacted_thinking' || block.type === 'image') return
    if (block.type === 'document') {
      const src = block.source as { type?: string; data?: unknown } | undefined
      if (src?.type === 'text' && typeof src.data === 'string') parts.push(src.data)
      return
    }
    if (typeof block.text === 'string') parts.push(block.text)
    if (block.type === 'tool_use') parts.push(JSON.stringify(block.input ?? ''))
    if (block.type === 'tool_result') {
      if (typeof block.content === 'string') parts.push(block.content)
      else if (Array.isArray(block.content)) block.content.forEach(walk)
    }
  }
  for (const m of messages) Array.isArray(m.content) ? m.content.forEach(walk) : walk(m.content)
  return parts.join('\n')
}

export const toolMatches = (tool: string, patterns: string[]) =>
  patterns.some(p => (p.endsWith('*') ? tool.startsWith(p.slice(0, -1)) : tool === p))

export const BINARY_FILE = /\.(pdf|png|jpe?g|gif|webp|heic|bmp|tiff?)$/i
