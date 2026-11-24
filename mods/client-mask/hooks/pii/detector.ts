// Detection only, cut down from newmean-pii js/src/redactor.ts (createRedactor): the model's spans with emoji taken out
// of what the model reads, word widening and grapheme snapping, as `detect` gives them. No regex layer, no table mode,
// no user lists, no onnxruntime, no download: the caller hands in the tokenizer and engine. Apache-2.0, see LICENSE and
// NOTICE in this folder.
import { bestTags, decodeSpans, makeWindows } from './decode'
import { restoreSpans, stripEmoji } from './emoji'
import { finishDetect } from './table'
import type { Tokenizer } from './tokenizer'
import type { Engine } from './engine'
import type { Span } from './types'

/** Tag list of the v1 models (index = model output). */
export const LABELS = ['PERSON', 'PERSON_L2', 'EMAIL', 'PHONE', 'ADDRESS', 'ID_NUMBER', 'FINANCIAL', 'ORG', 'USERNAME', 'URL', 'URL_L2', 'DATE_OF_BIRTH', 'SECRET'] as const
export type Label = (typeof LABELS)[number]
export const TAGS = ['O', ...LABELS.flatMap(l => [`B-${l}`, `I-${l}`])]

export const family = (l: string) => l.replace(/_L2$/, '')

export interface DetectorOptions {
  labels?: readonly string[]
  /** > 0 masks more, < 0 less; about -1..1. */
  sensitivity?: number
}

export interface Detector {
  /** Tokens the model reads for `text`. */
  tokens(text: string): number
  /** Spans to mask, sorted and non-overlapping. Throws DeadlineError past `deadline` (performance.now() time). */
  detect(text: string, deadline: number): Promise<Span[]>
}

/** Overlapping model spans become one; the longest span's label wins. Same as redactor.ts combine without regex. */
function combine(model: Span[], enabled: Set<string>): Span[] {
  const all = [...model].sort((a, b) => a.start - b.start || b.end - a.end)
  const groups: Span[][] = []
  let end = -1
  for (const s of all) {
    if (groups.length && s.start < end) {
      groups[groups.length - 1]!.push(s)
      end = Math.max(end, s.end)
    } else {
      groups.push([s])
      end = s.end
    }
  }
  const out: Span[] = []
  for (const g of groups) {
    const use = g.filter(s => enabled.has(s.label)).sort((a, b) => b.end - b.start - (a.end - a.start))
    if (!use.length) continue
    let lo = use[0]!.start
    let hi = use[0]!.end
    for (const s of use) {
      if (s.start < lo) lo = s.start
      if (s.end > hi) hi = s.end
    }
    out.push({ start: lo, end: hi, label: use[0]!.label, source: 'model' })
  }
  return out
}

export function createDetector(tokenizer: Tokenizer, engine: Engine, options: DetectorOptions = {}): Detector {
  const enabled = new Set<string>(options.labels ?? LABELS)
  const oBias = -(options.sensitivity ?? 0)
  if (!Number.isFinite(oBias)) throw new Error('sensitivity must be a finite number')

  const modelSpans = async (text: string, deadline: number): Promise<Span[]> => {
    const enc = tokenizer.encode(text)
    if (!enc.ids.length) return []
    const windows = makeWindows(enc.ids, tokenizer.bosId, tokenizer.eosId)
    const logits = await engine.run(windows, deadline)
    const tags = bestTags(enc.ids.length, windows, logits, TAGS.length, oBias, 0)
    return decodeSpans(text, enc, tags, TAGS)
  }

  return {
    tokens: text => tokenizer.encode(text).ids.length,
    async detect(text, deadline) {
      const stripped = stripEmoji(text)
      const raw = stripped ? restoreSpans(text, await modelSpans(stripped.text, deadline), stripped.keep) : await modelSpans(text, deadline)
      return finishDetect(text, combine(raw, enabled), null, true).map(s => ({ start: s.start, end: s.end, label: s.label, source: s.source }))
    },
  }
}
