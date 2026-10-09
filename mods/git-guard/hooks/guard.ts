// Pure checks: no engine calls, so they are testable on their own.

// A line that credits Claude: the co-author trailer, the session trailer, or
// the "Generated with Claude Code" footer, in any of their usual spellings.
export const CLAUDE_LINE =
  /^.*(?:co-authored-by:[^\n]*(?:claude|anthropic)|noreply@anthropic\.com|claude-session:|generated with \[?claude code).*$/gim

export const claudeLines = (text: string): string[] => [...text.matchAll(CLAUDE_LINE)].map(m => m[0].trim())

// A shell command that writes a commit message or a pull request text.
const WRITES_MESSAGE =
  /\bgit\b[^|;&\n]*\b(?:commit|merge|tag|notes|revert|cherry-pick)\b|\bgh\s+pr\s+(?:create|edit|merge|comment|review)\b|\bgh\s+release\s+(?:create|edit)\b/

export const writesMessage = (command: string) => WRITES_MESSAGE.test(command)

// A shell command that pushes.
export const pushes = (command: string) => /\bgit\b[^|;&\n]*\bpush\b/.test(command)

// Where a push runs: the last `cd` before it, or `git -C <dir>`; else undefined.
export const pushDirectory = (command: string): string | undefined => {
  const at = command.search(/\bgit\b[^|;&\n]*\bpush\b/)
  const before = command.slice(0, at)
  const unquote = (s: string) => s.replace(/^["']|["']$/g, '')
  const c = /-C\s+("[^"]+"|'[^']+'|\S+)/.exec(command.slice(at))
  if (c) return unquote(c[1])
  const cds = [...before.matchAll(/\bcd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g)]
  return cds.length ? unquote(cds[cds.length - 1][1]) : undefined
}

export const expandHome = (dir: string, home: string) =>
  dir === '~' ? home : dir.startsWith('~/') ? `${home}/${dir.slice(2)}` : dir.replace(/^\$HOME\b|^\$\{HOME\}/, home)
