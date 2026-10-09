// Pure checks: no engine calls, so they are testable on their own.

export type Rules = {
  // File endings checked. Default: .md, .mdx, .txt.
  extensions?: string[]
  // Any path containing one of these is left alone.
  skipPaths?: string[]
  // Words or phrases never flagged, matched ignoring case (an SAP term, a quotation).
  keep?: string[]
  // Words or phrases refused, matched ignoring case, added to the built-in list.
  bannedWords?: string[]
  // American spelling and its British form, added to the built-in list.
  spellings?: Record<string, string>
}

export type Issue = { check: 'dashes' | 'spelling' | 'words'; key: string; line: number; fix: string }

export const DEFAULT_EXTENSIONS = ['.md', '.mdx', '.txt']

// Notes, plans and memory under ~/.claude keep their own formats; sources are never rewritten.
// Wiki entity pages hold SAP's own wording, extracted from source, so they are left as written.
export const DEFAULT_SKIP = ['/.claude/', '/node_modules/', '/raw/', '/raw_processed/', '/other_sources/', '/wiki/pages/', 'CHANGELOG']

// SAP's own terms, spelt as SAP spells them, even in lower case.
export const DEFAULT_KEEP = [
  'authorization', 'authorizations', 'authorize', 'authorized', 'authorizing', 'business catalog', 'business catalogs',
  'technical catalog', 'technical catalogs', 'catalog object', 'cost center', 'cost centers', 'profit center',
  'profit centers', 'work center', 'work centers', 'sales organization', 'purchasing organization', 'customizing',
  'data modeling', 'center of excellence',
]

// From the LLM Studio voice check: hype words and throat-clearing openers.
export const DEFAULT_BANNED = [
  'revolutionary', 'revolutionise', 'revolutionize', 'game-changing', 'game changer', 'game-changer', 'seamless',
  'seamlessly', 'world-class', 'cutting-edge', 'next-gen', 'next-generation', 'paradigm shift', 'turnkey',
  'best-in-class', 'state-of-the-art', 'effortless', 'effortlessly', 'in conclusion', 'in summary', 'to summarise',
  "it's worth noting", 'it is worth noting', 'at the end of the day', 'needless to say', 'when it comes to',
]

// Whole words with no clean rule of their own. The -ize and -yze endings are a rule, below.
export const DEFAULT_SPELLINGS: Record<string, string> = {
  color: 'colour', colors: 'colours', colored: 'coloured', colorful: 'colourful',
  behavior: 'behaviour', behaviors: 'behaviours', behavioral: 'behavioural',
  favor: 'favour', favors: 'favours', favorite: 'favourite', favorites: 'favourites', favorable: 'favourable',
  honor: 'honour', labor: 'labour', neighbor: 'neighbour', neighbors: 'neighbours', flavor: 'flavour',
  humor: 'humour', rumor: 'rumour', harbor: 'harbour', endeavor: 'endeavour', armor: 'armour', vigor: 'vigour',
  center: 'centre', centers: 'centres', centered: 'centred', liter: 'litre', theater: 'theatre', fiber: 'fibre',
  somber: 'sombre', meager: 'meagre', catalog: 'catalogue', catalogs: 'catalogues', defense: 'defence',
  offense: 'offence', pretense: 'pretence',
  traveled: 'travelled', traveling: 'travelling', traveler: 'traveller', travelers: 'travellers',
  canceled: 'cancelled', canceling: 'cancelling', labeled: 'labelled', labeling: 'labelling',
  modeled: 'modelled', modeling: 'modelling', fueled: 'fuelled', signaled: 'signalled', signaling: 'signalling',
  leveled: 'levelled', leveling: 'levelling', enroll: 'enrol', enrollment: 'enrolment', fulfill: 'fulfil',
  fulfillment: 'fulfilment', skillful: 'skilful', willful: 'wilful', installment: 'instalment',
  gray: 'grey', aluminum: 'aluminium', aging: 'ageing', acknowledgment: 'acknowledgement',
}

// -ize words whose z is right in British English too.
const IZE_KEEP = /(?:siz(?:e|ed|es|ing)|priz(?:e|es|ed)|seiz(?:e|ed|es|ing)|capsiz(?:e|ed|es|ing)|maize|baize)$/

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The text with code, links and HTML comments blanked out, line breaks kept,
// so a line number still points at the right line.
export const prose = (text: string): string =>
  text
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, m => ' '.repeat(m.length))
    .replace(/\]\([^)\n]*\)/g, m => ' '.repeat(m.length))
    .replace(/https?:\/\/\S+/g, m => ' '.repeat(m.length))

const lineAt = (text: string, index: number) => text.slice(0, index).split('\n').length

// What the file switches off: <!-- house-style: off --> for all of it,
// <!-- allow: dashes --> (or spelling, words) for one check.
export const allowed = (text: string): Set<string> => {
  const off = new Set<string>()
  if (/<!--\s*house-style:\s*off\s*-->/i.test(text)) ['dashes', 'spelling', 'words'].forEach(c => off.add(c))
  for (const m of text.matchAll(/<!--\s*allow:\s*([a-z, ]+?)\s*-->/gi)) for (const c of (m[1] ?? '').split(/[ ,]+/)) off.add(c.toLowerCase())
  return off
}

export const issues = (text: string, rules: Rules = {}): Issue[] => {
  const off = allowed(text)
  let body = prose(text)
  for (const k of [...DEFAULT_KEEP, ...(rules.keep ?? [])]) body = body.replace(new RegExp(escape(k), 'gi'), m => ' '.repeat(m.length))
  const found: Issue[] = []

  if (!off.has('dashes')) {
    for (const m of body.matchAll(/[—–]/g)) {
      found.push({ check: 'dashes', key: m[0] === '—' ? 'em dash' : 'en dash', line: lineAt(body, m.index ?? 0), fix: 'start a new sentence, or use a colon' })
    }
    // A spaced hyphen between words, used as a dash (not a list bullet or a table rule).
    for (const m of body.matchAll(/(?<=[\p{L}\p{N},.)])[ \t]+-[ \t]+(?=[\p{L}\p{N}(])/gu)) {
      found.push({ check: 'dashes', key: 'spaced hyphen', line: lineAt(body, m.index ?? 0), fix: 'start a new sentence, or use a colon' })
    }
  }

  if (!off.has('spelling')) {
    const spellings = { ...DEFAULT_SPELLINGS, ...(rules.spellings ?? {}) }
    // Lower-case words only: a capitalised term mid-sentence is usually a name
    // (an SAP "Sales Organization"), which keeps its own spelling.
    // A word followed by ":" or "=" is a style property or a setting (color:#fff), not prose.
    for (const m of body.matchAll(/(?<![\p{L}\p{N}_-])[a-z][a-z]+(?![\p{L}\p{N}_:=-])/gu)) {
      const w = m[0]
      let fix = Object.hasOwn(spellings, w) ? spellings[w] : undefined
      if (!fix && !IZE_KEEP.test(w)) {
        const r = /^([a-z]{2,})(iz|yz)(e|es|ed|ing|ation|ations|er|ers)$/.exec(w)
        if (r) fix = `${r[1]}${r[2] === 'iz' ? 'is' : 'ys'}${r[3]}`
      }
      if (fix) found.push({ check: 'spelling', key: w, line: lineAt(body, m.index ?? 0), fix })
    }
  }

  if (!off.has('words')) {
    for (const word of [...DEFAULT_BANNED, ...(rules.bannedWords ?? [])]) {
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${escape(word).replace(/[- ]/g, '[- ]?')}(?![\\p{L}\\p{N}])`, 'giu')
      for (const m of body.matchAll(re)) found.push({ check: 'words', key: word.toLowerCase(), line: lineAt(body, m.index ?? 0), fix: 'cut it, or say the plain thing' })
    }
  }
  return found
}

// The problems `after` adds to `before`: an edit is judged only on what it
// brings in, so a file that already breaks a rule can still be edited.
export const added = (before: string, after: string, rules: Rules = {}): Issue[] => {
  const was = new Map<string, number>()
  for (const i of issues(before, rules)) was.set(i.key, (was.get(i.key) ?? 0) + 1)
  const now = issues(after, rules)
  const count = new Map<string, number>()
  for (const i of now) count.set(i.key, (count.get(i.key) ?? 0) + 1)
  return now.filter(i => (count.get(i.key) ?? 0) > (was.get(i.key) ?? 0))
}

export const checks = (path: string, rules: Rules = {}) => {
  const p = path.toLowerCase()
  const ext = rules.extensions ?? DEFAULT_EXTENSIONS
  if (!ext.some(x => p.endsWith(x.toLowerCase()))) return false
  return ![...DEFAULT_SKIP, ...(rules.skipPaths ?? [])].some(s => path.includes(s))
}

export const report = (path: string, found: Issue[], of = ""): string => {
  const name = path.split('/').pop() ?? path
  const lines = found.slice(0, 12).map(i => `line ${i.line}${of ? ` ${of}` : ""}: ${i.check === 'spelling' ? `"${i.key}" is American; write "${i.fix}"` : `${i.key}; ${i.fix}`}`)
  const more = found.length > 12 ? `; and ${found.length - 12} more` : ''
  return (
    `house-style: ${name} breaks the house style. Fix these and write it again: ${lines.join('; ')}${more}. ` +
    'If a line is right as it stands (a quotation, an SAP term), put <!-- allow: dashes --> (or spelling, words) in the file.'
  )
}
