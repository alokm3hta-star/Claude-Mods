// Reading and tidying your masking list. The list may carry notes for you:
// lines starting with // (and /* ... */), and trailing commas are allowed.
// Everything here runs inside the mod on this computer: no model reads the
// list, and no message from here quotes what is in it.

export type Notes = { before: string[]; after?: string }
type Annotated = {
  // Notes above and beside each member of an object, by key, and each item of
  // an array, by position; notes left before a closing bracket under "end".
  members: WeakMap<object, Map<string | number, Notes>>
  ends: WeakMap<object, string[]>
}
export type Parsed = { value: unknown; notes: Annotated }

// Notes the tidy command writes itself; it drops and rewrites them each time.
export const GENERATED = '── '

type Token =
  | { t: 'punct'; v: string; line: number }
  | { t: 'value'; v: unknown; line: number }
  | { t: 'comment'; v: string; line: number; sameLine: boolean }

const fail = (line: number): never => {
  // Never quotes the list: a message about it can reach the conversation.
  throw new Error(`the list is not valid JSON (line ${line})`)
}

const tokenize = (text: string): Token[] => {
  const out: Token[] = []
  let line = 1
  let lastLine = 0
  let i = 0
  while (i < text.length) {
    const c = text[i] as string
    if (c === '\n') {
      line++
      i++
      continue
    }
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i)
      const body = text.slice(i + 2, end === -1 ? text.length : end)
      out.push({ t: 'comment', v: body.trim(), line, sameLine: lastLine === line })
      i = end === -1 ? text.length : end
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end === -1) fail(line)
      const body = text.slice(i + 2, end)
      const start = line
      for (const part of body.split('\n')) {
        const v = part.replace(/^\s*\*?\s?/, '').trimEnd()
        if (v !== '') out.push({ t: 'comment', v, line, sameLine: lastLine === start && line === start })
        line++
      }
      line--
      i = end + 2
      continue
    }
    if ('{}[]:,'.includes(c)) {
      out.push({ t: 'punct', v: c, line })
      lastLine = line
      i++
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\n') fail(line)
        j += text[j] === '\\' ? 2 : 1
      }
      if (j >= text.length) fail(line)
      let v: unknown
      try {
        v = JSON.parse(text.slice(i, j + 1))
      } catch {
        fail(line)
      }
      out.push({ t: 'value', v, line })
      lastLine = line
      i = j + 1
      continue
    }
    const m = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i))
    if (!m) fail(line)
    const word = (m as RegExpExecArray)[0]
    out.push({ t: 'value', v: JSON.parse(word), line })
    lastLine = line
    i += word.length
  }
  return out
}

export const parseList = (text: string): Parsed => {
  const tokens = tokenize(text.replace(/^﻿/, ''))
  const notes: Annotated = { members: new WeakMap(), ends: new WeakMap() }
  let k = 0
  let pending: string[] = []
  // The member or item the last value closed, for a note on the same line.
  let last: { owner: object; key: string | number } | null = null
  const noteFor = (owner: object, key: string | number): Notes => {
    let m = notes.members.get(owner)
    if (!m) notes.members.set(owner, (m = new Map()))
    let n = m.get(key)
    if (!n) m.set(key, (n = { before: [] }))
    return n
  }
  const skipComments = () => {
    while (tokens[k]?.t === 'comment') {
      const c = tokens[k] as Extract<Token, { t: 'comment' }>
      if (c.sameLine && last && pending.length === 0) {
        const n = noteFor(last.owner, last.key)
        n.after = n.after === undefined ? c.v : `${n.after} ${c.v}`
      } else pending.push(c.v)
      k++
    }
  }
  const peek = () => {
    skipComments()
    return tokens[k]
  }
  const take = () => {
    skipComments()
    const t = tokens[k++]
    if (!t) fail(tokens.at(-1)?.line ?? 1)
    return t as Token
  }
  const expect = (v: string) => {
    const t = take()
    if (t.t !== 'punct' || t.v !== v) fail(t.line)
  }
  const value = (): unknown => {
    const t = take()
    if (t.t === 'value') return t.v
    if (t.t !== 'punct') return fail(t.line)
    if (t.v === '{') {
      const obj: Record<string, unknown> = {}
      for (;;) {
        const n = peek()
        if (n?.t === 'punct' && n.v === '}') break
        const before = pending
        pending = []
        const key = take()
        if (key.t !== 'value' || typeof key.v !== 'string') return fail(key.line)
        expect(':')
        last = null
        obj[key.v] = value()
        if (before.length > 0) noteFor(obj, key.v).before.push(...before)
        last = { owner: obj, key: key.v }
        const sep = peek()
        if (sep?.t === 'punct' && sep.v === ',') {
          take()
          continue
        }
        break
      }
      if (pending.length > 0) notes.ends.set(obj, pending)
      pending = []
      expect('}')
      last = null
      return obj
    }
    if (t.v === '[') {
      const arr: unknown[] = []
      for (;;) {
        const n = peek()
        if (n?.t === 'punct' && n.v === ']') break
        const before = pending
        pending = []
        last = null
        arr.push(value())
        const at = arr.length - 1
        if (before.length > 0) noteFor(arr, at).before.push(...before)
        last = { owner: arr, key: at }
        const sep = peek()
        if (sep?.t === 'punct' && sep.v === ',') {
          take()
          continue
        }
        break
      }
      if (pending.length > 0) notes.ends.set(arr, pending)
      pending = []
      expect(']')
      last = null
      return arr
    }
    return fail(t.line)
  }
  const v = value()
  skipComments()
  if (k < tokens.length) fail((tokens[k] as Token).line)
  return { value: v, notes }
}

// Settings first, in this order; any other key after them, as found.
const SETTINGS = [
  'enabled', 'startOn', 'onLeak', 'showRealNames', 'restoreInTools', 'maskFilesInPlace', 'keepOriginals',
  'maskOnDiskIn', 'keepOnDisk', 'guardOverwrites', 'blockBinaryFiles', 'blockPictures', 'wholeWord',
  'keepAsIs', 'keep', 'blockedFolders', 'detect',
]
const ROW_FIRST = ['real', 'pattern', 'placeholder']

type Row = Record<string, unknown>

// One line of JSON, spaced to read: ["a", "b"], { "k": 1 }.
const inline = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(inline).join(', ')}]`
  if (v && typeof v === 'object') {
    const e = Object.entries(v)
    return e.length === 0 ? '{}' : `{ ${e.map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ')} }`
  }
  return JSON.stringify(v)
}

const wrap = (text: string, width: number): string[] => {
  const out: string[] = []
  let cur = ''
  for (const w of text.split(/\s+/)) {
    if (cur !== '' && cur.length + 1 + w.length > width) {
      out.push(cur)
      cur = w
    } else cur = cur === '' ? w : `${cur} ${w}`
  }
  if (cur !== '') out.push(cur)
  return out
}

const keep = (lines: string[] | undefined) => (lines ?? []).filter(l => !l.startsWith(GENERATED))

// The rows' groups, in the order they are written.
const GROUPS = [
  { key: 'names', title: 'Names: turned back into the real name on screen and in files, unless switched off' },
  { key: 'files', title: 'Names kept as placeholders even in files ("toFiles": false)' },
  { key: 'oneway', title: 'One-way: the placeholder is a real word and is never turned back (SAP always is)' },
  { key: 'removed', title: 'Removed altogether (blank placeholder)' },
  { key: 'patterns', title: 'Patterns (regular expressions), applied in this order' },
] as const

export type TidyResult = { text: string; terms: number; groups: number }

// Rewrites the list in a fixed, readable layout: help on top, settings one
// per line, then the terms grouped and aligned. Rows that share a placeholder
// stay together in their order (the first is the name it turns back into);
// patterns keep their order. Your own notes are kept with what they sit by.
export const tidyList = (parsed: Parsed, help: string, keepAsIs: ReadonlySet<string>): TidyResult => {
  const cfg = parsed.value as Row
  const { members, ends } = parsed.notes
  const top = members.get(cfg)
  const terms = Array.isArray(cfg.terms) ? (cfg.terms as Row[]) : []
  const termNotes = members.get(terms)
  const lines: string[] = []
  const say = (indent: string, text: string) => lines.push(`${indent}// ${text}`)
  say('', `${GENERATED}client-mask list. Open it with /client-mask-edit; tidy it with /client-mask-tidy.`)
  say('', `${GENERATED}Lines starting with // are notes for you; the mod ignores them. Lines starting with // ${GENERATED.trim()} are rewritten by /client-mask-tidy.`)
  for (const l of wrap(help, 96)) say('', `${GENERATED}${l}`)
  lines.push('{')

  const keys = [...SETTINGS.filter(k => k in cfg), ...Object.keys(cfg).filter(k => !SETTINGS.includes(k) && k !== 'terms' && k !== '_how')]
  const body: string[][] = []
  for (const key of keys) {
    const n = top?.get(key)
    const block: string[] = keep(n?.before).map(t => `  // ${t}`)
    block.push(`  ${JSON.stringify(key)}: ${inline(cfg[key])}${n?.after !== undefined ? `\u0000${n.after}` : ''}`)
    body.push(block)
  }

  // Rows by placeholder, each placeholder's rows together, in list order.
  const kindOf = (r: Row): (typeof GROUPS)[number]['key'] => {
    if (typeof r.pattern === 'string') return 'patterns'
    const ph = typeof r.placeholder === 'string' ? r.placeholder : ''
    if (ph === '') return 'removed'
    if (keepAsIs.has(ph.trim().toUpperCase())) return 'oneway'
    return r.toFiles === false ? 'files' : 'names'
  }
  const order = terms.map((r, i) => ({ r, i }))
  const firstOf = new Map<string, number>()
  for (const { r, i } of order) {
    const ph = typeof r.pattern === 'string' ? `\u0000${i}` : String(r.placeholder ?? '')
    if (!firstOf.has(ph)) firstOf.set(ph, i)
  }
  const blockKey = (r: Row, i: number) => (typeof r.pattern === 'string' ? `\u0000${i}` : String(r.placeholder ?? ''))
  const groupOfBlock = new Map<string, string>()
  for (const { r, i } of order) {
    const b = blockKey(r, i)
    if (!groupOfBlock.has(b)) groupOfBlock.set(b, kindOf(r))
  }
  const rowText = (r: Row) => {
    const first = ROW_FIRST.filter(k => k in r).map(k => `${JSON.stringify(k)}: ${inline(r[k])}`)
    const rest = Object.keys(r).filter(k => !ROW_FIRST.includes(k)).map(k => `${JSON.stringify(k)}: ${inline(r[k])}`)
    return { lead: first[0] ?? '', tail: [...first.slice(1), ...rest] }
  }
  const termLines: string[] = []
  let groups = 0
  for (const g of GROUPS) {
    const rows = order.filter(({ r, i }) => groupOfBlock.get(blockKey(r, i)) === g.key)
    if (rows.length === 0) continue
    groups++
    if (g.key !== 'patterns' && g.key !== 'removed') {
      rows.sort((a, b) => {
        const pa = String(a.r.placeholder ?? '').toLowerCase()
        const pb = String(b.r.placeholder ?? '').toLowerCase()
        return pa === pb ? (firstOf.get(String(a.r.placeholder)) ?? 0) - (firstOf.get(String(b.r.placeholder)) ?? 0) || a.i - b.i : pa < pb ? -1 : 1
      })
    }
    if (termLines.length > 0) termLines.push('')
    termLines.push(`    // ${GENERATED}${g.title}`)
    const width = Math.max(...rows.map(({ r }) => rowText(r).lead.length))
    for (const { r, i } of rows) {
      const n = termNotes?.get(i)
      for (const t of keep(n?.before)) termLines.push(`    // ${t}`)
      const { lead, tail } = rowText(r)
      const text = tail.length === 0 ? `{ ${lead} }` : `{ ${(lead + ',').padEnd(width + 1)} ${tail.join(', ')} }`
      termLines.push(`    ${text}${n?.after !== undefined ? `\u0000${n.after}` : ''}`)
    }
  }
  const termEnd = keep(ends.get(terms)).map(t => `    // ${t}`)

  // Commas: after every value but the last of its list, before any note.
  const comma = (block: string[], last: boolean) =>
    block.map((l, j) => {
      const isValue = !l.trimStart().startsWith('//') && l.trim() !== ''
      const lastValue = j === block.map(x => !x.trimStart().startsWith('//') && x.trim() !== '').lastIndexOf(true)
      if (!isValue || (last && lastValue)) return l.replace('\u0000', '  // ')
      const [v, note] = l.split('\u0000')
      return `${v},${note !== undefined ? `  // ${note}` : ''}`
    })
  const hasTerms = 'terms' in cfg
  body.forEach((block, j) => lines.push(...comma(block, j === body.length - 1 && !hasTerms)))
  if (hasTerms) {
    if (body.length > 0) lines.push('')
    const n = top?.get('terms')
    for (const t of keep(n?.before)) lines.push(`  // ${t}`)
    lines.push('  "terms": [')
    lines.push(...comma(termLines, true), ...termEnd)
    lines.push(`  ]${n?.after !== undefined ? `  // ${n.after}` : ''}`)
  }
  for (const t of keep(ends.get(cfg))) lines.push(`  // ${t}`)
  lines.push('}')
  return { text: lines.join('\n') + '\n', terms: terms.length, groups }
}

// Whether two lists mean the same to the masker: the same settings, each
// placeholder's rows in the same order, and the patterns in the same order.
export const sameMeaning = (a: unknown, b: unknown): boolean => {
  const strip = (v: unknown) => {
    const { terms, _how, ...rest } = v as Row
    void _how
    const rows = Array.isArray(terms) ? (terms as Row[]) : []
    const byPh = new Map<string, string[]>()
    const patterns: string[] = []
    for (const r of rows) {
      const s = canon(r)
      if (typeof r.pattern === 'string') patterns.push(s)
      else {
        const ph = String(r.placeholder ?? '')
        byPh.set(ph, [...(byPh.get(ph) ?? []), s])
      }
    }
    return canon({ rest, byPh: [...byPh.entries()].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)), patterns })
  }
  return strip(a) === strip(b)
}

const canon = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map(k => `${JSON.stringify(k)}:${canon((v as Row)[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v)
}
