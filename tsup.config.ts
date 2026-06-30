import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  // viem and zod are runtime dependencies, not bundled into the output.
  external: ["viem", "zod"],
});
