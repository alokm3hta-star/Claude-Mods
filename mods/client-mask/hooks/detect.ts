// Built-in detectors for personal data and secrets that are not on your list.
// Each match becomes a fixed label such as ‹EMAIL›. No key is kept, so a label
// can never be turned back; the ‹ › marks make it plain that something was masked.

export type DetectorName = 'email' | 'phone' | 'niNumber' | 'iban' | 'card' | 'vatNumber' | 'secrets'

export type Detect = Partial<Record<DetectorName, boolean>>

export const LABEL = /‹[A-Z_]+›/

const label = (name: string) => `‹${name}›`

// Values that look like personal data but are not: they pass unmasked.
export const DEFAULT_KEEP = ['noreply@anthropic.com', '*@example.com', '*@example.org', '*@example.net']

const kept = (value: string, keep: readonly string[]) =>
  keep.some(k => (k.startsWith('*@') ? value.toLowerCase().endsWith(k.slice(1).toLowerCase()) : value.toLowerCase() === k.toLowerCase()))

const digits = (s: string) => s.replace(/\D/g, '')

const luhn = (n: string) => {
  let sum = 0
  for (let i = 0; i < n.length; i++) {
    let d = Number(n[n.length - 1 - i])
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2
    sum += d
  }
  return sum % 10 === 0
}

const ibanValid = (compact: string) => {
  if (compact.length < 15 || compact.length > 34) return false
  const moved = compact.slice(4) + compact.slice(0, 4)
  let rest = 0
  for (const ch of moved) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55)
    for (const d of v) rest = (rest * 10 + Number(d)) % 97
  }
  return rest === 1
}

type Rule = { name: DetectorName; re: RegExp; replace: (m: string, ...groups: string[]) => string }

const RULES: Rule[] = [
  // Secrets first, so a key that happens to contain digits is not read as a number.
  {
    name: 'secrets',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => label('PRIVATE_KEY'),
  },
  {
    name: 'secrets',
    re: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replace: () => label('TOKEN'),
  },
  {
    name: 'secrets',
    re: /(?<![A-Za-z0-9_-])(?:sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})(?![A-Za-z0-9_-])/g,
    replace: () => label('SECRET'),
  },
  {
    name: 'secrets',
    re: /(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/g,
    replace: (_m, lead) => `${lead}${label('TOKEN')}`,
  },
  {
    // "clientsecret": "…", password = '…', api_key: "…"
    name: 'secrets',
    re: /((?:"|')?[A-Za-z0-9_-]*(?:client_?secret|password|passwd|pwd|api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|private[_-]?key)(?:"|')?\s*[:=]\s*)("|')(?![$<{%])([^"'\s]{4,})\2/gi,
    replace: (_m, lead, q) => `${lead}${q}${label('SECRET')}${q}`,
  },
  {
    // SOME_SECRET=value in .env files and shell exports
    name: 'secrets',
    re: /^(\s*(?:export\s+)?[A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API_KEY|APIKEY|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*)(?![$<{%"'])([^\s#]{4,})/gm,
    replace: (_m, lead) => `${lead}${label('SECRET')}`,
  },
  {
    name: 'email',
    re: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![A-Za-z0-9-])/g,
    replace: m => label('EMAIL'),
  },
  {
    name: 'iban',
    re: /(?<![A-Za-z0-9])[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}(?![A-Za-z0-9])/g,
    replace: m => {
      // The longest stretch that checks out, so a word after it is left alone.
      const compact = m.replace(/ /g, '')
      for (let len = compact.length; len >= 15; len--) {
        if (!ibanValid(compact.slice(0, len))) continue
        let seen = 0
        let i = 0
        while (seen < len) if (m[i++] !== ' ') seen++
        return label('IBAN') + m.slice(i)
      }
      return m
    },
  },
  {
    name: 'card',
    re: /(?<![\d-])(?:4\d{3}|5[1-5]\d{2}|2[2-7]\d{2}|3[47]\d{2})(?:[ -]?\d){9,15}(?![\d-])/g,
    replace: m => {
      const n = digits(m)
      return n.length >= 13 && n.length <= 19 && luhn(n) ? label('CARD') : m
    },
  },
  {
    name: 'niNumber',
    re: /(?<![A-Za-z0-9])(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D](?![A-Za-z0-9])/g,
    replace: () => label('NI_NUMBER'),
  },
  {
    name: 'vatNumber',
    re: /(?<![A-Za-z0-9])GB ?\d{3} ?\d{4} ?\d{2}(?: ?\d{3})?(?![A-Za-z0-9])/g,
    replace: () => label('VAT_NUMBER'),
  },
  {
    name: 'phone',
    re: /(?<![\w.+-])(?:\+44 ?(?:\(0\) ?)?|0)(?:7\d{3}|[12]\d{1,4}|3\d{2}|8\d{2})[ -]?\d{3,4}[ -]?\d{3,4}(?![\w.-])/g,
    replace: m => {
      const n = digits(m.startsWith('+44') ? '0' + m.slice(3).replace(/^ ?\(0\)/, '') : m)
      return n.length === 10 || n.length === 11 ? label('PHONE') : m
    },
  },
]

export class Detector {
  private readonly rules: Rule[]

  constructor(
    detect: Detect = {},
    private readonly keep: readonly string[] = DEFAULT_KEEP,
  ) {
    this.rules = RULES.filter(r => detect[r.name] !== false)
  }

  // How many kinds of data are detected (email, phone, …).
  get count() {
    return new Set(this.rules.map(r => r.name)).size
  }

  mask(text: string): string {
    let out = text
    for (const r of this.rules) {
      r.re.lastIndex = 0
      out = out.replace(r.re, (m: string, ...rest: unknown[]) =>
        kept(m, this.keep) ? m : r.replace(m, ...(rest.filter(x => typeof x === 'string') as string[])),
      )
    }
    return out
  }

  // Labels of anything still present in clear text.
  leaks(text: string): string[] {
    const found = new Set<string>()
    for (const r of this.rules) {
      r.re.lastIndex = 0
      for (const m of text.matchAll(r.re)) {
        if (kept(m[0], this.keep)) continue
        const out = r.replace(m[0], ...(m.slice(1).filter(x => typeof x === 'string') as string[]))
        const hit = out.match(/‹([A-Z_]+)›/)
        if (out !== m[0] && hit) found.add(hit[0])
      }
    }
    return [...found]
  }
}
