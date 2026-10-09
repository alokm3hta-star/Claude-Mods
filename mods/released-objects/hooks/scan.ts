// Pure checks: no engine calls, so they are testable on their own.

// What kind of object a reference in the code points at.
export type Kind = 'function' | 'table' | 'class' | 'interface' | 'type'

export type Ref = { name: string; kind: Kind }

// One entry of the compact index: TYPE, CODE, SUCCESSORS.
// CODE: R released, D deprecated, N notToBeReleased, S notToBeReleasedStable,
// C classicAPI, X noAPI.
export type Entry = { type: string; code: string; successors: string }

export type Index = Map<string, Entry[]>

export type Verdict = 'released' | 'deprecated' | 'classic' | 'no-api' | 'not-released' | 'internal'

export type Finding = Ref & { verdict: Verdict; successors: string }

// Reads released-objects.tsv: NAME<TAB>TYPE<TAB>CODE<TAB>SUCCESSORS, '#' lines skipped.
export const parseIndex = (text: string): Index => {
  const index: Index = new Map()
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue
    const [name, type = '', code = '', successors = ''] = line.split('\t')
    if (!name || !code) continue
    const list = index.get(name)
    const entry = { type, code, successors }
    if (list) list.push(entry)
    else index.set(name, [entry])
  }
  return index
}

// Which SAP object types can stand behind each kind of reference.
const TYPES: Record<Kind, string[]> = {
  function: ['FUNC'],
  table: ['TABL', 'CDS_STOB', 'VIEW', 'DDLS'],
  class: ['CLAS'],
  interface: ['INTF'],
  type: ['DTEL', 'TABL', 'TTYP', 'DOMA', 'CDS_STOB', 'CLAS', 'INTF'],
}

// One verdict per reference, in order of precedence: released, deprecated,
// classic API, no API, not released, internal (in neither SAP list).
export const judge = (ref: Ref, index: Index): Finding => {
  const all = index.get(ref.name) ?? []
  const typed = all.filter(e => TYPES[ref.kind].includes(e.type))
  const entries = typed.length > 0 ? typed : all
  const codes = new Set(entries.map(e => e.code))
  const successors = entries.find(e => e.successors)?.successors ?? ''
  const verdict: Verdict =
    entries.length === 0
      ? 'internal'
      : codes.has('R')
        ? 'released'
        : codes.has('D')
          ? 'deprecated'
          : codes.has('C')
            ? 'classic'
            : codes.has('X')
              ? 'no-api'
              : 'not-released'
  return { ...ref, verdict, successors: verdict === 'released' ? '' : successors }
}

// Comments and string literals removed, so a name in either is never read as code.
// A function module's name is a literal, so `CALL FUNCTION '<name>'` is kept as a marker.
export const stripAbap = (code: string): string =>
  code
    .split('\n')
    .map(line => (line.startsWith('*') ? '' : line))
    .join('\n')
    .replace(/CALL\s+FUNCTION\s+'([^']+)'/gi, (_, n: string) => `CALL FUNCTION §${n}§`)
    .replace(/'(?:[^'\n]|'')*'|`(?:[^`\n]|``)*`|\|[^|\n]*\|/g, "''")
    .replace(/"[^\n]*/g, '')

const NAME = String.raw`([A-Za-z_/][\w/]*)`

// Names the code defines itself: local classes, interfaces, types and variables.
const definedLocally = (code: string): Set<string> => {
  const own = new Set<string>()
  const patterns = [
    new RegExp(String.raw`\bCLASS\s+${NAME}\s+DEFINITION`, 'gi'),
    new RegExp(String.raw`\bINTERFACE\s+${NAME}(?=[\s.])`, 'gi'),
    new RegExp(String.raw`\b(?:TYPES|DATA|CLASS-DATA|CONSTANTS|STATICS|FIELD-SYMBOLS)\s*:?\s+<?${NAME}`, 'gi'),
    new RegExp(String.raw`,\s*${NAME}\s+TYPE\b`, 'gi'),
  ]
  for (const p of patterns) for (const m of code.matchAll(p)) if (m[1]) own.add(m[1].toUpperCase())
  return own
}

// Statements (split at a full stop that ends a statement) that are ABAP SQL reads or writes.
const sqlStatements = (code: string) =>
  code.split(/\.(?=\s|$)/).filter(s => /\b(?:SELECT|WITH|UPDATE|INSERT|DELETE|MODIFY)\b/i.test(s))

// Every SAP object reference the ABAP or CDS source makes, de-duplicated.
export const references = (source: string): Ref[] => {
  const code = stripAbap(source)
  const found = new Map<string, Ref>()
  const add = (name: string | undefined, kind: Kind) => {
    if (!name) return
    const n = name.toUpperCase()
    const key = `${kind}:${n}`
    if (!found.has(key)) found.set(key, { name: n, kind })
  }
  const each = (re: RegExp, kind: Kind, text = code) => {
    for (const m of text.matchAll(re)) add(m[1], kind)
  }

  each(/CALL FUNCTION §([^§]+)§/g, 'function')
  for (const s of sqlStatements(code)) {
    each(new RegExp(String.raw`\b(?:FROM|JOIN)\s+${NAME}`, 'gi'), 'table', s)
    each(new RegExp(String.raw`\bUPDATE\s+${NAME}\s+SET\b`, 'gi'), 'table', s)
    each(new RegExp(String.raw`\bINSERT\s+INTO\s+${NAME}`, 'gi'), 'table', s)
  }
  // CDS source: data sources and association targets.
  if (/\bdefine\s+(?:root\s+)?(?:view|table\s+function|custom\s+entity)\b/i.test(code)) {
    each(new RegExp(String.raw`\b(?:from|join)\s+${NAME}`, 'gi'), 'table')
    each(new RegExp(String.raw`\b(?:association|composition)\s*(?:\[[^\]]*\])?\s*(?:to|of)\s+(?:parent\s+)?${NAME}`, 'gi'), 'table')
  }
  each(new RegExp(String.raw`\b${NAME}=>`, 'g'), 'class')
  each(new RegExp(String.raw`\bNEW\s+${NAME}\s*\(`, 'gi'), 'class')
  each(new RegExp(String.raw`\bCAST\s+${NAME}\s*\(`, 'gi'), 'class')
  each(new RegExp(String.raw`\bINHERITING\s+FROM\s+${NAME}`, 'gi'), 'class')
  each(new RegExp(String.raw`\bCREATE\s+OBJECT\s+\S+\s+TYPE\s+${NAME}`, 'gi'), 'class')
  each(new RegExp(String.raw`\bTYPE\s+REF\s+TO\s+${NAME}`, 'gi'), 'class')
  each(new RegExp(String.raw`\bINTERFACES\s+${NAME}`, 'gi'), 'interface')
  each(new RegExp(String.raw`\b${NAME}~`, 'g'), 'interface')
  each(new RegExp(String.raw`\b(?:TYPE|LIKE)\s+(?:(?:STANDARD|SORTED|HASHED)\s+)?(?:TABLE\s+OF\s+|RANGE\s+OF\s+|LINE\s+OF\s+)?${NAME}`, 'gi'), 'type')

  const own = definedLocally(code)
  return [...found.values()].filter(r => !own.has(r.name))
}

// Generic and built-in names that are never SAP repository objects.
const BUILT_IN = new Set([
  'DATA', 'OBJECT', 'ANY', 'TABLE', 'STANDARD', 'SORTED', 'HASHED', 'REF', 'LINE', 'RANGE', 'TO', 'OF',
  'I', 'INT8', 'F', 'P', 'C', 'N', 'D', 'T', 'X', 'STRING', 'XSTRING', 'DECFLOAT16', 'DECFLOAT34',
  'UTCLONG', 'B', 'S', 'SIMPLE', 'CLIKE', 'CSEQUENCE', 'XSEQUENCE', 'NUMERIC', 'DECFLOAT',
  'INDEX', 'ME', 'SUPER', 'SY', 'SYST', 'ABAP_BOOL', 'ABAP_TRUE', 'ABAP_FALSE', 'BOOLEAN',
])

// A name that only the customer or the code itself can own: Z/Y namespace,
// a local class or interface, or a built-in type.
export const isOwn = (name: string, prefixes: readonly string[]) =>
  BUILT_IN.has(name) ||
  prefixes.some(p => name.startsWith(p.toUpperCase())) ||
  /^(?:LCL|LIF|LTC|LTH|LCX|LTY|TY|TT|GT|LT|LS|LV|LO|LR|MT|MS|MV|MO)_/.test(name)

// The findings worth showing: everything not released, skipping the customer's
// own names, and skipping an unlisted bare type (too many local and built-in types).
export const check = (source: string, index: Index, prefixes: readonly string[]): Finding[] =>
  references(source)
    .filter(r => !isOwn(r.name, prefixes))
    .map(r => judge(r, index))
    .filter(f => f.verdict !== 'released')
    .filter(f => !(f.verdict === 'internal' && (f.kind === 'type' || f.name.startsWith('/'))))

const SAY: Record<Verdict, string> = {
  released: 'released',
  deprecated: 'deprecated',
  classic: 'classic API: not released, but acceptable on private cloud and on-premise',
  'no-api': 'no API: not for customer code',
  'not-released': 'not released for customer code',
  internal: 'internal: in neither SAP list, so no released or classic API',
}

const line = (f: Finding) => {
  const use = f.successors.startsWith('concept:')
    ? `; SAP successor concept ${f.successors.slice(8)}`
    : f.successors
      ? `; use ${f.successors.split(',').join(', ')}`
      : ''
  return `- ${f.name} (${f.kind}): ${SAY[f.verdict]}${use}`
}

// The note the model reads after the write, or undefined when nothing needs saying.
export const report = (where: string, findings: Finding[], basis: string): string | undefined => {
  const attention = findings.filter(f => f.verdict !== 'classic')
  const classic = findings.filter(f => f.verdict === 'classic')
  if (findings.length === 0) return undefined
  const parts = [`released-objects: the ABAP just written to ${where} uses SAP objects that are not released (${basis}).`]
  if (attention.length > 0) parts.push('Needs attention:', ...attention.map(line))
  if (classic.length > 0) parts.push('Classic APIs (acceptable, but released alternatives exist where named):', ...classic.map(line))
  parts.push(
    'This is a flag, not a block: the write went through. Tell the user which objects were flagged and which SAP list was used, and prefer the released successor where SAP names one.',
  )
  return parts.join('\n')
}

// A short line for the person.
export const summary = (where: string, findings: Finding[], list: string) => {
  const attention = findings.filter(f => f.verdict !== 'classic').length
  const classic = findings.length - attention
  const bits = [attention > 0 ? `${attention} not released` : '', classic > 0 ? `${classic} classic API` : ''].filter(Boolean)
  return `released-objects: ${where}: ${bits.join(', ')} (list ${list})`
}

// Which SAP list was used and why, said in every flag.
export const basisText = (list: string, why: string, missing?: string) =>
  [`checked against SAP list ${list}`, why, missing ? `the chosen list ${missing} is not downloaded, so ${list} was used` : '']
    .filter(Boolean)
    .join('; ')

// Text that looks like ABAP or CDS source, so an MCP tool's input can be checked.
export const looksLikeAbap = (text: string) =>
  /\b(?:CLASS\s+\S+\s+(?:DEFINITION|IMPLEMENTATION)|METHOD\s+[\w~]+\s*\.|ENDMETHOD|REPORT\s+\S+\s*\.|FUNCTION\s+\S+\s*\.|define\s+(?:root\s+)?view)/i.test(
    text,
  )

export const isAbapFile = (path: string) => /\.(?:abap|asddls|acds)$/i.test(path)

export const expandHome = (path: string, home: string) =>
  path === '~' ? home : path.startsWith('~/') ? `${home}/${path.slice(2)}` : path

// The ABAP language version a repository declares in abaplint.json (syntax.version), if any.
export const abaplintVersion = (json: string): string | undefined => {
  try {
    const v = (JSON.parse(json) as { syntax?: { version?: unknown } }).syntax?.version
    return typeof v === 'string' && v ? v : undefined
  } catch {
    return undefined
  }
}

// "v816=PCE2023_3, v757=PCE2022" -> Map. Empty until the mapping is grounded.
export const parseVersionMap = (text: string): Map<string, string> => {
  const map = new Map<string, string>()
  for (const pair of text.split(/[,;\s]+/)) {
    const [k, v] = pair.split('=')
    if (k && v) map.set(k.trim().toLowerCase(), v.trim())
  }
  return map
}

// The directories from a file's folder up to the root, nearest first.
export const parents = (path: string): string[] => {
  const dirs: string[] = []
  let dir = path.replace(/\/[^/]*$/, '')
  while (dir) {
    dirs.push(dir)
    const up = dir.replace(/\/[^/]*$/, '')
    if (up === dir) break
    dir = up
  }
  return dirs
}

// "~/code/client-a=PCE2023_3; /work/client-b=PCE2022_2" -> [folder, list] pairs,
// one per customer, longest folder first. Separated by ; or new lines.
export const parseFolderLists = (text: string, home: string): Array<[string, string]> =>
  text
    .split(/[;\n]+/)
    .map(pair => pair.split('='))
    .filter((p): p is [string, string] => p.length === 2 && Boolean(p[0]?.trim()) && Boolean(p[1]?.trim()))
    .map(([folder, list]): [string, string] => [expandHome(folder.trim(), home).replace(/\/+$/, ''), list.trim()])
    .sort((a, b) => b[0].length - a[0].length)

// The customer list for code under one of the configured folders, if any.
export const folderList = (path: string, pairs: Array<[string, string]>) =>
  pairs.find(([folder]) => path === folder || path.startsWith(`${folder}/`))
