// client-mask's out-of-hook scanner: runs the same vendored newmean-pii detector as the mod, in a local Node process,
// for texts too long to scan within a hook's time budget. Reads one JSON request on stdin, writes one JSON answer on
// stdout, touches no network, writes no file. It checks both model files against their pinned SHA-256 itself.
//
// Request: { model, tokenizer, pinned: { model: {bytes, sha256}, tokenizer: {bytes, sha256} }, labels, sensitivity,
//            timeoutMs, texts: string[] }
// Answer:  { spans: [{ start, end, label }][], ms } or { error: "<reason without any text>" }
import { register } from 'node:module'

// The vendored files import each other without a file extension, as the mod's loader wants; Node needs one.
register(
  'data:text/javascript,' +
    encodeURIComponent(
      'export async function resolve(s, c, n) { if (s.startsWith("./") && !/\\.[a-z]+$/.test(s)) { try { return await n(s + ".ts", c) } catch {} } return n(s, c) }',
    ),
)

const fail = reason => {
  process.stdout.write(JSON.stringify({ error: reason }))
  process.exit(0)
}

try {
  const { readFileSync } = await import('node:fs')
  const { createHash } = await import('node:crypto')
  const { fileURLToPath } = await import('node:url')
  const here = fileURLToPath(new URL('.', import.meta.url))
  const req = JSON.parse(readFileSync(0, 'utf8'))
  const t0 = performance.now()
  const read = (path, pin) => {
    const b = readFileSync(path)
    if (b.length !== pin.bytes || createHash('sha256').update(b).digest('hex') !== pin.sha256) fail('a model file does not match its published checksum')
    return new Uint8Array(b)
  }
  const model = read(req.model, req.pinned.model)
  const tok = read(req.tokenizer, req.pinned.tokenizer)
  const { Tokenizer } = await import('./tokenizer.ts')
  const { createEngine } = await import('./engine.ts')
  const { createDetector, TAGS } = await import('./detector.ts')
  const tokenizer = new Tokenizer(JSON.parse(new TextDecoder().decode(tok)))
  const engine = createEngine(new WebAssembly.Module(readFileSync(`${here}pii-simd.wasm`)), model, TAGS.length)
  const detector = createDetector(tokenizer, engine, { labels: req.labels, sensitivity: req.sensitivity })
  const deadline = t0 + req.timeoutMs
  const spans = []
  for (const text of req.texts) {
    spans.push((await detector.detect(text, deadline)).map(s => ({ start: s.start, end: s.end, label: s.label })))
  }
  process.stdout.write(JSON.stringify({ spans, ms: Math.round(performance.now() - t0) }))
} catch (err) {
  fail(err && err.name === 'DeadlineError' ? 'too slow' : 'the scan failed')
}
