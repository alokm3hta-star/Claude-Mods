# Vendored: newmean-pii

Source: https://github.com/newmean-ai/pii at commit `4b63a4c` (npm `@newmean-ai/pii` 1.6.2), Apache-2.0. `LICENSE` and
`NOTICE` in this folder are the project's own. Model files (v1.1.0) are not vendored: they are installed by you under
`~/.claude/client-mask-models/<size>-1.1.0/` and checked against the SHA-256 values in `models.ts` on every load.

| File | From | Change |
|---|---|---|
| `tokenizer.ts`, `decode.ts`, `table.ts`, `word_tables.ts`, `emoji.ts`, `pictographic.ts`, `models.ts`, `types.ts` | `js/src/` | import paths without `.js` (the mod loader's form); nothing else |
| `onnx-weights.ts` | `js/src/engines/` | as above |
| `pii-simd.wasm` | `js/src/engines/wasm-simd.ts` | the embedded base64 written out as the binary it holds (SHA-256 `eaeaac20…59fd`, no imports) |
| `engine.ts` | `js/src/engines/builtin.ts` | new: compiled by the caller (`$.wasm.compile`), a deadline checked before each 256-token window, an optional `pause` between windows (in the mod runtime a `$` call, so the band answers mid-scan), no relaxed-SIMD build, no dynamic import |
| `detector.ts` | `js/src/redactor.ts` | new: detect only (model, emoji handling, whole words, grapheme snapping); no regex layer, table mode, user lists, onnxruntime or download |
| `helper.mjs` | new | runs the same files in a local Node process for texts too long for a hook's 10 s budget; stdin in, stdout out, no network, no writes |

Parity: on 14 texts (wiki pages, emoji, hyphenated names, an address) the vendored detector gave exactly the spans of the
npm package's `detect()` (2026-11-24). In the mod runtime the engine's logits checksum equalled Node's.
