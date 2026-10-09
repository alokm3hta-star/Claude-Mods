import type { Register } from 'claude-code'

import {
  abaplintVersion,
  basisText,
  check,
  expandHome,
  type Index,
  isAbapFile,
  looksLikeAbap,
  parents,
  parseIndex,
  parseFolderLists,
  parseVersionMap,
  folderList,
  report,
  summary,
} from './scan'

// Input keys the engine adds beside a tool's own arguments.
const RESERVED = new Set(['tool', 'tool_use_id', 'consent'])

// The ABAP a tool call writes, and where: a Write or Edit to an ABAP or CDS file,
// or ABAP source passed to an MCP tool (an ADT server writing to a system).
const written = (e: Record<string, unknown>): { where: string; path?: string; code: string } | undefined => {
  const tool = String(e.tool ?? '')
  const path = typeof e.file_path === 'string' ? e.file_path : undefined
  if (path && isAbapFile(path)) {
    if (tool === 'Write' && typeof e.content === 'string') return { where: path, path, code: e.content }
    if (tool === 'Edit' && typeof e.new_string === 'string') return { where: path, path, code: e.new_string }
    if (Array.isArray(e.edits)) {
      const code = e.edits.map(x => String((x as { new_string?: unknown }).new_string ?? '')).join('\n')
      return { where: path, path, code }
    }
  }
  if (tool.startsWith('mcp__')) {
    const code = Object.entries(e)
      .filter(([k, v]) => !RESERVED.has(k) && typeof v === 'string' && looksLikeAbap(v))
      .map(([, v]) => v as string)
      .join('\n')
    if (code) return { where: tool, code }
  }
  return undefined
}

export const register: Register = (on, options) => {
  const dataDirOption = String(options.dataDir ?? '')
  const defaultList = String(options.defaultList ?? 'PCELatest') || 'PCELatest'
  const versionMap = parseVersionMap(String(options.versionMap ?? ''))
  const customerLists = String(options.customerLists ?? '')
  const prefixes = String(options.customerPrefixes ?? 'Z,Y')
    .split(',')
    .map(p => p.trim())
    .filter(Boolean)

  // Read once per list and kept: null marks a list whose file is not there.
  const indexes = new Map<string, Index | null>()
  const versions = new Map<string, string | null>()
  let warnedMissing = false

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const write = written(e as unknown as Record<string, unknown>)
    if (!write) return ran

    const home = dataDirOption.startsWith('~') ? ((await $.env.get('HOME')) ?? '') : ''
    const dataDir = expandHome(dataDirOption, home)

    const load = async (list: string): Promise<Index | null> => {
      if (!indexes.has(list)) {
        const text = await $.fs.read(`${dataDir}/released-objects-${list}.tsv`).catch(() => undefined)
        indexes.set(list, text === undefined ? null : parseIndex(text))
      }
      return indexes.get(list) ?? null
    }

    // The repository's declared ABAP version: the nearest abaplint.json above the code.
    const start = write.path ?? `${await $.session.cwd()}/.`
    let version: string | undefined
    for (const dir of parents(start)) {
      if (!versions.has(dir)) {
        const json = await $.fs.read(`${dir}/abaplint.json`).catch(() => undefined)
        versions.set(dir, json === undefined ? null : (abaplintVersion(json) ?? null))
      }
      const v = versions.get(dir)
      if (v) {
        version = v
        break
      }
    }

    // Precedence: the customer's own folder setting, then the repository's declared
    // ABAP version, then the default list.
    const byFolder = customerLists
      ? folderList(
          start,
          parseFolderLists(customerLists, home || (customerLists.includes('~') ? ((await $.env.get('HOME')) ?? '') : '')),
        )
      : undefined
    const byVersion = version ? versionMap.get(version.toLowerCase()) : undefined
    const chosen = byFolder?.[1] ?? byVersion
    const why = byFolder
      ? `the customer list set for ${byFolder[0]}`
      : byVersion
        ? `chosen from abaplint.json syntax version ${version}`
        : version
          ? `this repository's abaplint.json declares ${version}, and no list is set for this customer`
          : 'no customer list set and no abaplint.json found for this code'
    let list = chosen ?? defaultList
    let index = await load(list)
    let missing: string | undefined
    if (!index && chosen) {
      missing = chosen
      list = defaultList
      index = await load(list)
    }
    if (!index) {
      if (!warnedMissing) {
        warnedMissing = true
        $.ui.toast(`released-objects: no list at ${dataDir}/released-objects-${list}.tsv; set dataDir in its settings`)
      }
      return ran
    }

    const findings = check(write.code, index, prefixes)
    const note = report(write.where, findings, basisText(list, why, missing))
    if (!note) return ran
    $.ui.toast(summary(write.where.replace(/^.*\//, ''), findings, list))
    return { ...ran, context: [...(ran.context ?? []), note] }
  })
    // A check that fails never stands in the way of the write.
    .catch(($, e, next) => next(e))
}
