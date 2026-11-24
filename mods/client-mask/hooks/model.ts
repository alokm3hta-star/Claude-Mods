import type { EngineInterface } from 'claude-code'

import { ALLOW_VOCAB } from './allow-vocab'
import { createDetector, family, LABELS, TAGS } from './pii/detector'
import { createEngine, DeadlineError } from './pii/engine'
import { MODEL_FILES, MODEL_VERSION } from './pii/models'
import { Tokenizer } from './pii/tokenizer'
import type { WebTokenizerFile } from './pii/tokenizer'

// The on-device model layer: a small token-classification model (newmean-pii,
// Apache-2.0, vendored under ./pii) finds names, companies, addresses, IDs and
// the like that are not on your list and match no detector. It runs here, in
// WebAssembly; nothing it reads leaves this machine. What it finds is masked one
// way, as ‹PERSON›, ‹ORG›… like the detectors' labels, and never turned back.

export type ModelSize = 'medium' | 'large' | 'small' | 'nano'

export type ModelConfig = {
  // On unless set to false.
  enabled?: boolean
  size?: ModelSize
  // Which kinds the model masks; default all of them.
  labels?: string[]
  // > 0 masks more, < 0 masks less (about -1..1). Default 0.
  sensitivity?: number
  // A text longer than this, in model tokens, is withheld rather than sent unscanned.
  maxTokens?: number
  // A scan past this many milliseconds is withheld rather than sent unscanned.
  timeoutMs?: number
  // Words the model may leave unmasked (products, your own terms); compared in lower case.
  allow?: string[]
}

export const MODEL_LABELS: readonly string[] = LABELS
// What the model masks unless the list names its own "labels": every kind but
// SECRET, which the detectors find precisely; the model's SECRET tagged random
// folder names and IDs, and a label in a command is refused.
export const DEFAULT_LABELS: readonly string[] = LABELS.filter(l => l !== 'SECRET')
// sensitivity 0.5: on planted names, companies, addresses and IDs it found one
// company more than 0 for two more masks in 75,000 characters of wiki text;
// 1 added noise and found nothing more (calibration, 2026-11-24).
export const DEFAULTS = { size: 'medium' as ModelSize, maxTokens: 100000, timeoutMs: 180000, sensitivity: 0.5 }

// Companies the model misses most: capitalised words ending in a word that
// names a company ("Halverton Utilities", "Fenwick & Lyle plc"). A rule, run
// with the model and held to the same allowed words. A company that is one
// bare name ("Deltacore") is found only by your list.
const COMPANY_WORDS =
  'Ltd|Limited|plc|PLC|LLP|LLC|Inc|Corp|Corporation|GmbH|AG|SE|SA|S\\.A\\.|BV|NV|Pty|Oy|AB|ASA|Group|Holdings|Utilities|Insurance|Assurance|Bank|Banking|Foods|Water|Energy|Power|Gas|Logistics|Transport|Council|Trust|Partners|Partnership|Associates|Consulting|Consultants|Industries|Manufacturing|Retail|Healthcare|Pharma|Pharmaceuticals|Airways|Airlines|Motors|Telecom|Telecommunications|University|College|Hospital|Authority|Agency|Ministry|Department|Foundation|Capital|Investments|Properties|Estates|Developments|Construction|Engineering|Chemicals|Metals|Mining|Shipping|Freight|Brewery|Breweries|Stores|Supermarkets'
const LEADING =
  /^(?:The|A|An|Our|Your|Their|This|That|These|Those|With|For|From|At|To|By|And|Or|In|On|As|If|When|Then|So|But|Also|Dear|Hi|Hello|Thanks|Please|Ask|Call|Email|Contact|Tell|Meet|Met|Send|See|Check|Use|Visit|Join|Spoke|Speak|Ring|Phone|Write|Invite|Cc|Bcc|Attn|Re|Fwd)\s+/
const COMPANY = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:\\p{Lu}[\\p{L}\\p{N}'’.-]*\\s+(?:&\\s+|and\\s+|of\\s+)?){1,4}(?:${COMPANY_WORDS})(?![\\p{L}\\p{N}])\\.?`,
  'gu',
)
export const companySpans = (text: string): { start: number; end: number; label: string }[] => {
  const out: { start: number; end: number; label: string }[] = []
  for (const m of text.matchAll(COMPANY)) {
    let start = m.index ?? 0
    let value = m[0]
    // A capital that only starts a sentence ("The", "With") is not part of the name.
    for (let lead = value.match(LEADING); lead; lead = value.match(LEADING)) {
      start += lead[0].length
      value = value.slice(lead[0].length)
    }
    if (/\s/.test(value)) out.push({ start, end: start + value.length, label: 'ORG' })
  }
  return out
}

// Model spans and rule spans as one sorted list without overlaps: where they
// overlap, the union is masked, under the model's label.
const mergeSpans = (a: { start: number; end: number; label: string }[], b: { start: number; end: number; label: string }[]) => {
  const all = [...a, ...b].sort((x, y) => x.start - y.start || y.end - x.end)
  const out: { start: number; end: number; label: string }[] = []
  for (const s of all) {
    const last = out[out.length - 1]
    if (last && s.start < last.end) last.end = Math.max(last.end, s.end)
    else out.push({ ...s })
  }
  return out
}

// Outside the list's private folder, so the files can be installed and checked;
// their SHA-256 is pinned, so a changed file is refused.
export const MODELS_DIR = '.claude/client-mask-models'
export const modelFolder = (home: string, size: ModelSize) => `${home}/${MODELS_DIR}/${size}-${MODEL_VERSION}`
export const modelUrl = (size: ModelSize) => `https://huggingface.co/newmean-ai/pii-${size}/resolve/v${MODEL_VERSION}/`
const variantFor = (size: ModelSize) => (size === 'large' || size === 'medium' ? 'q4e' : 'q4')
export const modelFiles = (size: ModelSize) => ({ model: `model_${variantFor(size)}.onnx`, tokenizer: 'tokenizer.web.json' })

// Problems with the "model" setting, by field name only.
export const validateModel = (m: unknown): string[] => {
  if (m === undefined) return []
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['the list\'s "model" must be an object of settings']
  const c = m as Record<string, unknown>
  const p: string[] = []
  const known = new Set(['enabled', 'size', 'labels', 'sensitivity', 'maxTokens', 'timeoutMs', 'allow'])
  for (const k of Object.keys(c)) if (!known.has(k)) p.push(`the list's "model" has an unknown setting "${k}"`)
  if (c.enabled !== undefined && typeof c.enabled !== 'boolean') p.push('the list\'s "model.enabled" must be true or false')
  if (c.size !== undefined && !(typeof c.size === 'string' && c.size in MODEL_FILES)) p.push('the list\'s "model.size" must be "medium", "large", "small" or "nano"')
  if (c.labels !== undefined && !(Array.isArray(c.labels) && c.labels.every(l => typeof l === 'string' && MODEL_LABELS.includes(l))))
    p.push(`the list's "model.labels" must name kinds from: ${MODEL_LABELS.join(', ')}`)
  if (c.sensitivity !== undefined && !(typeof c.sensitivity === 'number' && Number.isFinite(c.sensitivity) && Math.abs(c.sensitivity) <= 3))
    p.push('the list\'s "model.sensitivity" must be a number between -3 and 3')
  for (const k of ['maxTokens', 'timeoutMs'] as const)
    if (c[k] !== undefined && !(typeof c[k] === 'number' && Number.isInteger(c[k]) && (c[k] as number) > 0)) p.push(`the list's "model.${k}" must be a whole number above 0`)
  if (c.allow !== undefined && !(Array.isArray(c.allow) && c.allow.every(w => typeof w === 'string' && w.trim() !== '')))
    p.push('the list\'s "model.allow" must be a list of words')
  return p
}

// What the layer needs from the model: tokens to size a text, spans to mask.
export interface SpanFinder {
  tokens(text: string): number
  detect(text: string, deadline: number): Promise<{ start: number; end: number; label: string }[]>
}

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join('')

// $.fs.read gives at most 4 MiB at a time, as base64.
const READ_CHUNK = 4 * 1024 * 1024
async function readBytes($: EngineInterface, path: string): Promise<Uint8Array> {
  const { size } = await $.fs.stat(path)
  const out = new Uint8Array(size)
  for (let offset = 0; offset < size; offset += READ_CHUNK) {
    const { base64 } = (await $.fs.read(path, { as: 'bytes', offset, length: Math.min(READ_CHUNK, size - offset) })) as { base64: string }
    const bin = atob(base64)
    for (let i = 0; i < bin.length; i++) out[offset + i] = bin.charCodeAt(i)
  }
  return out
}

// The helper process (./pii/helper.mjs under Node): the same detector, outside
// the hook's budget. Node must be on the PATH; without it, long texts are
// withheld rather than sent unscanned.
export async function externalFinder($: EngineInterface, home: string, cfg: ModelConfig, tokens: (t: string) => number): Promise<SpanFinder | null> {
  const size = cfg.size ?? DEFAULTS.size
  const folder = modelFolder(home, size)
  const names = modelFiles(size)
  const pinned = MODEL_FILES[size]
  const helper = `${$.plugin.root}/hooks/pii/helper.mjs`
  const node = await $.process.run(['node', '--version'], { timeoutMs: 5000 }).catch(() => null)
  if (!node || node.exitCode !== 0) return null
  const base = {
    model: `${folder}/${names.model}`,
    tokenizer: `${folder}/${names.tokenizer}`,
    pinned: { model: pinned[variantFor(size)], tokenizer: pinned.tokenizer },
    labels: cfg.labels ?? DEFAULT_LABELS,
    sensitivity: cfg.sensitivity ?? DEFAULTS.sensitivity,
  }
  return {
    tokens,
    async detect(text, deadline) {
      const timeoutMs = Math.max(1000, Math.round(deadline - performance.now()))
      const r = await $.process.run(['node', '--no-warnings', helper], {
        stdin: JSON.stringify({ ...base, timeoutMs, texts: [text] }),
        timeoutMs: timeoutMs + 5000,
      })
      let answer: { spans?: { start: number; end: number; label: string }[][]; error?: string }
      try {
        answer = JSON.parse(r.stdout)
      } catch {
        throw new Error('the helper gave no answer')
      }
      if (answer.error === 'too slow') throw new DeadlineError()
      if (answer.error || !answer.spans || !answer.spans[0]) throw new Error('the helper could not scan')
      return answer.spans[0]
    },
  }
}

export class ModelUnavailable extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'ModelUnavailable'
  }
}

// Reads, checks and compiles the model. Throws ModelUnavailable with a reason
// that names no text, only what is wrong with the files.
export async function loadFinder($: EngineInterface, home: string, cfg: ModelConfig): Promise<SpanFinder> {
  const size = cfg.size ?? DEFAULTS.size
  const folder = modelFolder(home, size)
  const names = modelFiles(size)
  const pinned = MODEL_FILES[size]
  const variant = variantFor(size)
  const files = [
    { path: `${folder}/${names.model}`, info: pinned[variant] },
    { path: `${folder}/${names.tokenizer}`, info: pinned.tokenizer },
  ]
  const bytes: Uint8Array[] = []
  for (const f of files) {
    if (!(await $.fs.exists(f.path))) throw new ModelUnavailable(`the ${size} masking model is not installed (/client-mask-model shows how)`)
    const b = await readBytes($, f.path)
    if (b.length !== f.info.bytes || hex(await crypto.subtle.digest('SHA-256', b)) !== f.info.sha256) {
      throw new ModelUnavailable(`a ${size} masking model file does not match its published checksum, so it was not used`)
    }
    bytes.push(b)
  }
  try {
    const tokenizer = new Tokenizer(JSON.parse(new TextDecoder().decode(bytes[1])) as WebTokenizerFile)
    const module = await $.wasm.compile('./pii/pii-simd.wasm')
    const engine = createEngine(module, bytes[0] as Uint8Array, TAGS.length)
    return createDetector(tokenizer, engine, { labels: cfg.labels ?? DEFAULT_LABELS, sensitivity: cfg.sensitivity ?? DEFAULTS.sensitivity })
  } catch {
    throw new ModelUnavailable('the masking model could not be started')
  }
}

export type Scan = {
  text: string
  // Set when the text could not be scanned: it must not be sent.
  withheld?: 'too long' | 'too slow' | 'failed'
  // True when one more pass would change nothing.
  stable: boolean
  // How many spans each pass masked.
  found: number
}

const words = (s: string) => s.split(/[^\p{L}\p{N}]+/u).filter(Boolean)

export type LayerOptions = {
  labels?: readonly string[]
  maxTokens?: number
  timeoutMs?: number
  allow?: readonly string[]
  // Ranges of a text already masked (placeholders and labels): never touched again.
  marked: (text: string) => [number, number][]
  // At most this many passes; a pass runs only when the one before masked something.
  passes?: number
}

export type LayerStats = { scans: number; tokens: number; ms: number; masked: number; withheld: number }

// How long a hook call may still spend scanning: a hook has 10 s of its own
// time per call (waiting on the engine and on `$` calls is free), and one that
// runs past it is skipped, which would let its text through unmasked. Each call
// takes a deadline well inside that; a scan that would not fit before it goes
// to the helper process, whose time is a `$` call and does not count.
export type Budget = { deadline: number }
export const HOOK_SCAN_MS = 6500
export const newBudget = (ms: number = HOOK_SCAN_MS): Budget => ({ deadline: performance.now() + ms })

export class ModelLayer {
  private readonly inline: SpanFinder
  private readonly external: SpanFinder | null
  private readonly labels: Set<string>
  private readonly allow: Set<string>
  private readonly opts: LayerOptions
  private queue: Promise<unknown> = Promise.resolve()
  // Tokens a second in this process, measured; starts low so early guesses err towards the helper.
  private rate = 1000
  readonly stats: LayerStats & { external: number } = { scans: 0, tokens: 0, ms: 0, masked: 0, withheld: 0, external: 0 }

  constructor(inline: SpanFinder, external: SpanFinder | null, opts: LayerOptions) {
    this.inline = inline
    this.external = external
    this.opts = opts
    this.labels = new Set(opts.labels ?? DEFAULT_LABELS)
    this.allow = new Set([...ALLOW_VOCAB, ...(opts.allow ?? [])].map(w => w.trim().toLowerCase()))
  }

  // A span is left alone only when every word in it is an allowed word, or the
  // whole of it is; a span with no letter or digit carries nothing to mask.
  allowed(value: string): boolean {
    const v = value.trim().toLowerCase()
    if (this.allow.has(v)) return true
    const w = words(v)
    return w.length === 0 || w.every(x => this.allow.has(x))
  }

  // One in-process model call at a time, in arrival order.
  private inlineDetect(text: string, deadline: number): Promise<{ start: number; end: number; label: string }[]> {
    const run = this.queue.then(() => {
      if (performance.now() > deadline) throw new DeadlineError()
      return this.inline.detect(text, deadline)
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  // One pass: in this process when it fits the hook's budget, else in the helper.
  private async detect(text: string, tokens: number, budget: Budget, deadline: number) {
    const guess = (tokens / this.rate) * 1000 + 250
    if (performance.now() + guess < budget.deadline) {
      const t = performance.now()
      try {
        const spans = await this.inlineDetect(text, budget.deadline)
        const ms = performance.now() - t
        if (ms > 200) this.rate = Math.max(200, Math.round(0.7 * this.rate + 0.3 * (tokens / (ms / 1000))))
        return spans
      } catch (err) {
        // Out of hook time (or queued behind others): the helper takes it.
        if (!(err instanceof DeadlineError) || !this.external) throw err
      }
    }
    if (!this.external) throw new DeadlineError()
    this.stats.external++
    return this.external.detect(text, deadline)
  }

  scan(text: string, budget: Budget = newBudget()): Promise<Scan> {
    return this.scanNow(text, budget)
  }

  private async scanNow(text: string, budget: Budget): Promise<Scan> {
    if (text.trim() === '') return { text, stable: true, found: 0 }
    const t0 = performance.now()
    let tokens: number
    try {
      tokens = this.inline.tokens(text)
    } catch {
      this.stats.withheld++
      return { text, withheld: 'failed', stable: false, found: 0 }
    }
    if (tokens > (this.opts.maxTokens ?? DEFAULTS.maxTokens)) {
      this.stats.withheld++
      return { text, withheld: 'too long', stable: false, found: 0 }
    }
    const deadline = t0 + (this.opts.timeoutMs ?? DEFAULTS.timeoutMs)
    let cur = text
    let found = 0
    let stable = false
    try {
      for (let pass = 0; pass < (this.opts.passes ?? 2); pass++) {
        const spans = await this.detect(cur, tokens, budget, deadline)
        const edits = this.edits(cur, this.labels.has('ORG') ? mergeSpans(spans, companySpans(cur)) : spans)
        if (edits.length === 0) {
          stable = true
          break
        }
        found += edits.length
        let out = ''
        let last = 0
        for (const e of edits) {
          out += cur.slice(last, e.start) + `‹${e.label}›`
          last = e.end
        }
        cur = out + cur.slice(last)
      }
    } catch (err) {
      this.stats.withheld++
      return { text, withheld: err instanceof DeadlineError ? 'too slow' : 'failed', stable: false, found: 0 }
    } finally {
      this.stats.scans++
      this.stats.tokens += tokens
      this.stats.ms += performance.now() - t0
    }
    this.stats.masked += found
    return { text: cur, stable, found }
  }

  // The model's spans as edits: enabled kinds only, clipped to what is not
  // already masked, trimmed of white space, and not wholly allowed words.
  edits(text: string, spans: { start: number; end: number; label: string }[]): { start: number; end: number; label: string }[] {
    const marked = this.opts.marked(text).sort((a, b) => a[0] - b[0])
    const out: { start: number; end: number; label: string }[] = []
    for (const s of spans) {
      if (!this.labels.has(s.label)) continue
      // The parts of the span outside every marked range.
      let pieces: [number, number][] = [[s.start, s.end]]
      for (const [ms, me] of marked) {
        if (me <= s.start || ms >= s.end) continue
        pieces = pieces.flatMap(([a, b]): [number, number][] => {
          if (me <= a || ms >= b) return [[a, b]]
          const keep: [number, number][] = []
          if (ms > a) keep.push([a, ms])
          if (me < b) keep.push([me, b])
          return keep
        })
      }
      for (let [a, b] of pieces) {
        while (a < b && /\s/.test(text[a] as string)) a++
        while (b > a && /\s/.test(text[b - 1] as string)) b--
        if (a >= b || this.allowed(text.slice(a, b))) continue
        if (machineId(text, a, b, s.label)) continue
        out.push({ start: a, end: b, label: family(s.label) })
      }
    }
    return out.sort((x, y) => x.start - y.start)
  }
}

// What is known about texts, by a salted SHA-256 so no text is kept: the hashes
// of texts that masking leaves exactly as they are ("clean"), and, for this
// session only, what each text that did change became. Clean hashes are kept
// across sessions (they are hashes of masked text), so a resumed conversation
// is not scanned again.
export class ScanCache {
  private salt = ''
  private readonly clean = new Set<string>()
  private readonly memo = new Map<string, Scan>()
  private dirty = false
  hits = 0
  misses = 0
  static readonly MAX_CLEAN = 5000
  static readonly MAX_MEMO = 4000

  // `fingerprint` changes whenever the list or the model settings change, so
  // what was clean under an older list is never trusted.
  async init(salt: string, fingerprint: string, saved: readonly string[]) {
    this.salt = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}\n${fingerprint}`)))
    this.clean.clear()
    this.memo.clear()
    for (const h of saved) this.clean.add(h)
  }

  get ready() {
    return this.salt !== ''
  }

  // Which list and settings the clean hashes belong to: itself a salted hash.
  get id() {
    return this.salt
  }

  load(saved: readonly string[]) {
    for (const h of saved.slice(-ScanCache.MAX_CLEAN)) this.clean.add(h)
  }

  key(text: string): Promise<string> {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${this.salt}\n${text}`)).then(hex)
  }

  isClean(key: string) {
    const hit = this.clean.has(key)
    if (hit) this.hits++
    return hit
  }

  markClean(key: string) {
    if (this.clean.has(key)) return
    this.clean.add(key)
    this.dirty = true
    if (this.clean.size > ScanCache.MAX_CLEAN) this.clean.delete(this.clean.values().next().value as string)
  }

  remembered(key: string): Scan | undefined {
    const s = this.memo.get(key)
    if (s) {
      this.hits++
      this.memo.delete(key)
      this.memo.set(key, s)
    } else this.misses++
    return s
  }

  remember(key: string, scan: Scan) {
    this.memo.set(key, scan)
    if (this.memo.size > ScanCache.MAX_MEMO) this.memo.delete(this.memo.keys().next().value as string)
  }

  // The clean hashes to keep, newest last; null when nothing changed since the last call.
  takeSaved(): string[] | null {
    if (!this.dirty) return null
    this.dirty = false
    return [...this.clean]
  }
}

export const WITHHELD_NOTE: Record<NonNullable<Scan['withheld']>, string> = {
  'too long': '‹WITHHELD› client-mask held this text back: it is too long to scan for personal data. Ask for a smaller part (a line range, a filter, a head or tail).',
  'too slow': '‹WITHHELD› client-mask held this text back: scanning it for personal data took too long. Ask for a smaller part.',
  failed: '‹WITHHELD› client-mask held this text back: it could not be scanned for personal data.',
}

// An ID or user name the model found that is part of a file path, or a machine
// ID (hex with letters and digits, a UUID): not about a person, and masking it
// breaks every command that names the path. An all-digit number is still masked.
const MACHINE_KINDS = new Set(['ID_NUMBER', 'USERNAME', 'URL', 'URL_L2'])
export function machineId(text: string, a: number, b: number, label: string): boolean {
  if (!MACHINE_KINDS.has(label)) return false
  const value = text.slice(a, b)
  // A web address with a scheme or www. is masked wherever it is; anything else
  // the model calls a URL inside a file path is part of the path.
  if ((label === 'URL' || label === 'URL_L2') && (value.includes('://') || /^www\./i.test(value))) return false
  // 7 characters and up: a git short hash is 7.
  if (/^[0-9a-f-]{7,}$/i.test(value) && /[a-f]/i.test(value) && /\d/.test(value)) return true
  let s = a
  let e = b
  while (s > 0 && !/\s/.test(text[s - 1] as string)) s--
  while (e < text.length && !/\s/.test(text[e] as string)) e++
  return /[/\\]/.test(text.slice(s, e))
}
