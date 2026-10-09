import { test, expect, mock } from 'claude-code/testing'

import { check, parseIndex, parents, references } from './scan'

const TSV = [
  '# sap-released-objects v1 list=PCELatest',
  'MARA\tTABL\tN\tI_PRODUCT,I_PRODUCTSALES',
  'BKPF\tTABL\tN\tI_JOURNALENTRY',
  'I_PRODUCT\tCDS_STOB\tR\t',
  'BAPI_SALESORDER_CREATEFROMDAT2\tFUNC\tN\tI_SALESORDERTP',
  'BAPI_SALESORDER_CREATEFROMDAT2\tFUNC\tC\t',
  'CL_ABAP_REGEX\tCLAS\tR\t',
  'CL_OLD_THING\tCLAS\tD\tCL_NEW_THING',
  'CF_REBD_BUILDING\tCLAS\tX\tBAPI_RE_BU_GET_DETAIL',
  'IF_OO_ADT_CLASSRUN\tINTF\tR\t',
].join('\n')

const CODE = `CLASS zcl_demo DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_oo_adt_classrun.
    DATA mo_old TYPE REF TO cl_old_thing.
ENDCLASS.
CLASS zcl_demo IMPLEMENTATION.
  METHOD if_oo_adt_classrun~main.
    " SELECT * FROM bseg is only a comment
    SELECT matnr FROM mara INTO TABLE @DATA(lt_mara).
    SELECT * FROM i_product INTO TABLE @DATA(lt_prod).
    SELECT * FROM bkpf INNER JOIN zbkpf_ext ON bkpf~belnr = zbkpf_ext~belnr INTO TABLE @DATA(lt_doc).
    CALL FUNCTION 'BAPI_SALESORDER_CREATEFROMDAT2'.
    CALL FUNCTION 'SOME_INTERNAL_FM'.
    DATA(lo_re) = NEW cl_abap_regex( pattern = 'x' ).
    DATA(lo_b) = NEW cf_rebd_building( ).
    DATA(lo_l) = NEW lcl_helper( ).
    out->write( 'FROM mara' ).
  ENDMETHOD.
ENDCLASS.`

test('references are read from code, never from comments or text literals', async () => {
  const names = references(CODE).map(r => `${r.kind}:${r.name}`)
  expect(names).toContain('table:MARA')
  expect(names).toContain('table:BKPF')
  expect(names).toContain('function:BAPI_SALESORDER_CREATEFROMDAT2')
  expect(names).toContain('class:CL_OLD_THING')
  expect(names).toContain('interface:IF_OO_ADT_CLASSRUN')
  expect(names).not.toContain('table:BSEG')
  expect(names).not.toContain('class:ZCL_DEMO')
})

test('each object gets SAP verdict and successor; own and released names are not flagged', async () => {
  const found = check(CODE, parseIndex(TSV), ['Z', 'Y'])
  const by = new Map(found.map(f => [f.name, f]))
  expect(by.get('MARA')?.verdict).toBe('not-released')
  expect(by.get('MARA')?.successors).toBe('I_PRODUCT,I_PRODUCTSALES')
  expect(by.get('BKPF')?.verdict).toBe('not-released')
  expect(by.get('BAPI_SALESORDER_CREATEFROMDAT2')?.verdict).toBe('classic')
  expect(by.get('CL_OLD_THING')?.verdict).toBe('deprecated')
  expect(by.get('CF_REBD_BUILDING')?.verdict).toBe('no-api')
  expect(by.get('SOME_INTERNAL_FM')?.verdict).toBe('internal')
  expect(by.has('I_PRODUCT')).toBe(false)
  expect(by.has('CL_ABAP_REGEX')).toBe(false)
  expect(by.has('ZBKPF_EXT')).toBe(false)
  expect(by.has('LCL_HELPER')).toBe(false)
})

test('parents walks from a file up to the root', async () => {
  expect(parents('/a/b/src/zcl_x.clas.abap')).toEqual(['/a/b/src', '/a/b', '/a'])
})

// The files a test's filesystem holds; any other read fails as a missing file does.
const reader = (map: Record<string, string>) => (_: unknown, e: { path: string }) => {
  const text = map[e.path]
  if (text === undefined) throw new Error(`ENOENT ${e.path}`)
  return { value: text } as never
}

test('a written ABAP file is flagged with the list used; the write still goes through', { options: { dataDir: '~/data' } }, async ($, on) => {
  mock.env(on, { HOME: '/home/t' })
  on('fs.read', reader({
    '/home/t/data/released-objects-PCELatest.tsv': TSV,
    '/repo/abaplint.json': JSON.stringify({ syntax: { version: 'v816' } }),
  }))
  let wrote = 0
  on('tool.call', () => {
    wrote++
    return { result: { type: 'create' } } as never
  })
  const r = await $.tool.call({ tool: 'Write', file_path: '/repo/src/zcl_demo.clas.abap', content: CODE } as never)
  expect(wrote).toBe(1)
  const note = (r as { context?: readonly string[] }).context?.join('\n') ?? ''
  expect(note).toContain('MARA (table): not released')
  expect(note).toContain('use I_PRODUCT, I_PRODUCTSALES')
  expect(note).toContain('SAP list PCELatest')
  expect(note).toContain('declares v816, and no list is set for this customer')
})

test('a mapped version picks its own list', { options: { dataDir: '/data', versionMap: 'v816=PCE2023_3' } }, async ($, on) => {
  on('fs.read', reader({
    '/data/released-objects-PCE2023_3.tsv': 'MARA\tTABL\tN\tI_PRODUCT',
    '/repo/abaplint.json': JSON.stringify({ syntax: { version: 'v816' } }),
  }))
  on('tool.call', () => ({ result: {} }) as never)
  const r = await $.tool.call({ tool: 'Write', file_path: '/repo/src/zr.prog.abap', content: 'SELECT * FROM mara INTO TABLE @DATA(t).' } as never)
  const note = (r as { context?: readonly string[] }).context?.join('\n') ?? ''
  expect(note).toContain('SAP list PCE2023_3')
  expect(note).toContain('chosen from abaplint.json syntax version v816')
})

test('non-ABAP files and clean code add nothing', { options: { dataDir: '/data' } }, async ($, on) => {
  on('fs.read', reader({ '/data/released-objects-PCELatest.tsv': TSV }))
  on('tool.call', () => ({ result: {} }) as never)
  const a = await $.tool.call({ tool: 'Write', file_path: '/repo/notes.md', content: 'SELECT * FROM mara.' } as never)
  expect((a as { context?: readonly string[] }).context).toBeUndefined()
  const b = await $.tool.call({ tool: 'Write', file_path: '/repo/z.prog.abap', content: 'SELECT * FROM i_product INTO TABLE @DATA(t).' } as never)
  expect((b as { context?: readonly string[] }).context).toBeUndefined()
  // The same setup does flag unreleased code, so the empty answers above are real.
  const c = await $.tool.call({ tool: 'Write', file_path: '/repo/z.prog.abap', content: 'SELECT * FROM mara INTO TABLE @DATA(t).' } as never)
  expect((c as { context?: readonly string[] }).context?.join('')).toContain('MARA')
})

test('ABAP sent to an MCP tool is checked too', { options: { dataDir: '/data' } }, async ($, on) => {
  on('fs.read', reader({ '/data/released-objects-PCELatest.tsv': TSV }))
  on('session.cwd', () => ({ value: '/work' }) as never)
  on('tool.call', () => ({ result: {} }) as never)
  const source = 'CLASS zcl_x IMPLEMENTATION.\n  METHOD run.\n    SELECT * FROM bkpf INTO TABLE @DATA(t).\n  ENDMETHOD.\nENDCLASS.'
  const r = await $.tool.call({ tool: 'mcp__adt__set_source', uri: '/sap/bc/adt/oo/classes/zcl_x', source } as never)
  const note = (r as { context?: readonly string[] }).context?.join('\n') ?? ''
  expect(note).toContain('BKPF (table): not released')
  expect(note).toContain('use I_JOURNALENTRY')
})

test('a customer folder setting wins over the version', { options: { dataDir: '/data', versionMap: 'v816=PCE2023_3', customerLists: '/clients/acme=PCE2022_2; /clients=PCE2025_0' } }, async ($, on) => {
  on('fs.read', reader({
    '/data/released-objects-PCE2022_2.tsv': 'MARA\tTABL\tN\tI_PRODUCT',
    '/data/released-objects-PCE2023_3.tsv': 'MARA\tTABL\tN\tI_PRODUCT',
    '/data/released-objects-PCELatest.tsv': 'MARA\tTABL\tN\tI_PRODUCT',
    '/clients/acme/abaplint.json': JSON.stringify({ syntax: { version: 'v816' } }),
  }))
  on('tool.call', () => ({ result: {} }) as never)
  const r = await $.tool.call({ tool: 'Write', file_path: '/clients/acme/src/zr.prog.abap', content: 'SELECT * FROM mara INTO TABLE @DATA(t).' } as never)
  const note = (r as { context?: readonly string[] }).context?.join('\n') ?? ''
  expect(note).toContain('SAP list PCE2022_2')
  expect(note).toContain('the customer list set for /clients/acme')
  const other = await $.tool.call({ tool: 'Write', file_path: '/clients/beta/zr.prog.abap', content: 'SELECT * FROM mara INTO TABLE @DATA(t).' } as never)
  const otherNote = (other as { context?: readonly string[] }).context?.join('\n') ?? ''
  expect(otherNote).toContain('the chosen list PCE2025_0 is not downloaded, so PCELatest was used')
})
