// Pure clean-up of saved files: no engine calls, so it is testable on its own.
// Claude Code keeps each conversation as a file of one JSON row per line, and
// your typed prompts in a history file. Both stay; any name from your list
// still in clear text in them is masked in place. Nothing records what changed.

// Fields Claude Code needs to find and resume a conversation, left as they are.
const KEEP_FIELDS = new Set([
  'cwd',
  'project',
  'sessionId',
  'uuid',
  'parentUuid',
  'leafUuid',
  'logicalParentUuid',
  'messageId',
  'promptId',
  'requestId',
  'agentId',
  'id',
  'tool_use_id',
  'toolUseID',
  'signature',
  'type',
  'role',
  'model',
  'timestamp',
  'version',
  'gitBranch',
  'userType',
  'entrypoint',
  'slug',
])

// Masks every string value in a row, except the fields above and signed
// thinking, which the API refuses once changed (and which only ever held what
// the model saw, already masked).
const scrubValue = (value: unknown, mask: (s: string) => string): unknown => {
  if (typeof value === 'string') return mask(value)
  if (Array.isArray(value)) return value.map(v => scrubValue(v, mask))
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>
    if (row.type === 'thinking' || row.type === 'redacted_thinking') return value
    return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, KEEP_FIELDS.has(k) ? v : scrubValue(v, mask)]))
  }
  return value
}

export const scrubLine = (line: string, mask: (s: string) => string): string => {
  if (line.trim() === '') return line
  let row: unknown
  try {
    row = JSON.parse(line)
  } catch {
    // A row cut short (a crash mid-write) is masked as plain text.
    return mask(line)
  }
  const out = scrubValue(row, mask)
  const text = JSON.stringify(out)
  return text === JSON.stringify(row) ? line : text
}

// The whole file; `changed` false when nothing in it needed masking.
export const scrubFile = (text: string, mask: (s: string) => string): { text: string; changed: boolean } => {
  let changed = false
  const out = text
    .split('\n')
    .map(line => {
      const next = scrubLine(line, mask)
      if (next !== line) changed = true
      return next
    })
    .join('\n')
  return { text: out, changed }
}
