/// <reference types="vite/client" />

/**
 * Import shaders as strings.
 *
 * `?raw` is Vite's convention and is already covered by `vite/client`, but the
 * declaration is restated here so the intent is visible at the import site:
 * these modules exist to be handed to `createShaderModule`, not imported as
 * code. That distinction is also why nothing type-checks their contents --
 * only a WebGPU implementation can, which is what the parity run does.
 */
declare module '*?raw' {
  const source: string;
  export default source;
}
