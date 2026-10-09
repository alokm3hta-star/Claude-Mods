import type { Register } from 'claude-code'

import { claudeLines, expandHome, pushDirectory, pushes, writesMessage } from './guard'

export const register: Register = on => {
  // Claude is never asked to add the trailer or the footer in the first place.
  on('attribution.text', { kind: 'commit' }, () => ({ text: '' }))
  on('attribution.text', { kind: 'pr' }, () => ({ text: '' }))

  // A commit or pull request text that still credits Claude is refused.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = String(e.command ?? '')
    if (writesMessage(command)) {
      const found = claudeLines(command)
      if (found.length > 0) {
        return {
          deny:
            `git-guard: this would credit Claude in your git history (${found[0]}). ` +
            'Remove that line and run it again; your commits and pull requests carry no Claude attribution.',
        }
      }
    }

    // Before a push, every commit not yet on a remote is read; one that credits
    // Claude stops the push.
    if (pushes(command)) {
      const home = (await $.env.get('HOME')) ?? ''
      const dir = pushDirectory(command)
      const cwd = dir ? expandHome(dir, home) : await $.session.cwd()
      const log = await $.process.run(['git', 'log', '--branches', '--not', '--remotes', '--format=%h%n%B%n'], {
        cwd,
        timeoutMs: 10000,
      })
      if (log.exitCode === 0) {
        const found = claudeLines(log.stdout)
        if (found.length > 0) {
          return {
            deny:
              `git-guard: ${found.length} line${found.length === 1 ? '' : 's'} crediting Claude in commits not yet pushed (${found[0]}). ` +
              'Rewrite those commit messages to drop the line, then push again.',
          }
        }
      }
    }
    return next(e)
  })
    // A check that fails lets the command through rather than block your work.
    .catch(($, e, next) => next(e))
}
