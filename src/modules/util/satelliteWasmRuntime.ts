/**
 * satellite.js exports its WASM runtimes from the package root, so importing the
 * package transforms two Emscripten bundles this app never calls. vite.config.ts
 * aliases them here; throwing keeps a mistaken use loud rather than half-alive.
 */
export default function createWasmModule(): never {
  throw new Error("satellite.js's WebAssembly runtime is deliberately not bundled; SGP4 runs in JavaScript. Remove the #wasm-* aliases in vite.config.ts to bring it back.");
}
