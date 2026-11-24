// The newmean-pii built-in engine (engine/pii.c built to pii-simd.wasm: freestanding, no imports), adapted from
// js/src/engines/builtin.ts for a hooks module: the caller compiles the module (a hooks module compiles WebAssembly only
// through $.wasm.compile), and each 256-token window checks a deadline first, so a long text cannot hold the thread
// past it. Apache-2.0, see LICENSE and NOTICE in this folder.
import { onnxToPiiw } from './onnx-weights'

interface Exports {
  memory: WebAssembly.Memory
  pii_alloc(n: number): number
  pii_load(ptr: number, len: number): number
  pii_tags(): number
  pii_max_len(): number
  pii_ids(n: number): number
  pii_run(ids: number, n: number): number
}

export class DeadlineError extends Error {
  constructor() {
    super('scan ran past its time limit')
    this.name = 'DeadlineError'
  }
}

export interface Engine {
  run(windows: { ids: number[] }[], deadline: number): Promise<Float32Array[]>
}

export function createEngine(module: WebAssembly.Module, model: Uint8Array, nTags: number): Engine {
  const instance = new WebAssembly.Instance(module, {})
  const ex = instance.exports as unknown as Exports
  const weights = onnxToPiiw(model)
  const ptr = ex.pii_alloc(weights.length)
  if (!ptr) throw new Error('engine: out of memory')
  new Uint8Array(ex.memory.buffer, ptr, weights.length).set(weights)
  const rc = ex.pii_load(ptr, weights.length)
  if (rc !== 0) throw new Error(`engine: unsupported model file (code ${rc})`)
  if (ex.pii_tags() !== nTags) throw new Error(`engine: model has ${ex.pii_tags()} tags, expected ${nTags}`)
  const maxLen = ex.pii_max_len()
  return {
    async run(windows, deadline) {
      const out: Float32Array[] = []
      for (const { ids } of windows) {
        if (performance.now() > deadline) throw new DeadlineError()
        const L = ids.length
        const ip = L <= maxLen ? ex.pii_ids(L) : 0
        if (!ip) throw new Error(`engine: window of ${L} tokens (max ${maxLen})`)
        new Int32Array(ex.memory.buffer, ip, L).set(ids)
        const o = ex.pii_run(ip, L)
        if (!o) throw new Error('engine: out of memory')
        out.push(new Float32Array(ex.memory.buffer, o, L * nTags).slice())
        // Give the rest of the mod a turn between windows.
        await Promise.resolve()
      }
      return out
    },
  }
}
