import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// veilo-sdk-core's prover.js calls
//   Function('return import("snarkjs")')()
// to hide the dynamic import from bundlers. The result is that neither Vite
// nor the browser can resolve the bare specifier at runtime, so proof
// generation always throws "snarkjs is required...". Rewrite it to a plain
// dynamic import so Vite's dep-optimizer handles it like any other module.
const unhideSnarkjsImport = {
  name: "veilo-unhide-snarkjs",
  enforce: "pre" as const,
  transform(code: string, id: string) {
    if (!id.includes("veilo-sdk-core") || !id.endsWith("prover.js")) return;
    if (!code.includes(`Function('return import("snarkjs")')`)) return;
    return code.replace(
      /Function\('return import\("snarkjs"\)'\)\(\)/g,
      'import("snarkjs")',
    );
  },
};

export default defineConfig({
  plugins: [unhideSnarkjsImport, react()],
  define: {
    // Several Solana / Anchor deps still reference `global` and `process`.
    global: "globalThis",
    "process.env": {},
  },
  resolve: {
    alias: {
      // Polyfill Node's Buffer in the browser (web3.js still imports it).
      buffer: "buffer",
      // veilo-sdk-core imports `crypto.randomBytes` from Node's crypto.
      // Vite's default browser resolution is an empty stub, so point it at
      // a Web-Crypto-backed shim.
      crypto: path.resolve(__dirname, "src/shims/crypto.ts"),
    },
  },
  optimizeDeps: {
    // Force pre-bundling so esbuild resolves veilo-sdk-core's CJS/ESM
    // interop once at dep-optimize time instead of at runtime.
    include: ["veilo-sdk-core", "@coral-xyz/anchor", "snarkjs"],
    esbuildOptions: {
      target: "es2022",
      plugins: [
        {
          name: "veilo-unhide-snarkjs-esbuild",
          setup(build) {
            build.onLoad({ filter: /veilo-sdk-core.*prover\.js$/ }, async (args) => {
              const fs = await import("node:fs/promises");
              const src = await fs.readFile(args.path, "utf8");
              return {
                contents: src.replace(
                  /Function\('return import\("snarkjs"\)'\)\(\)/g,
                  'import("snarkjs")',
                ),
                loader: "js",
              };
            });
          },
        },
      ],
    },
  },
  build: {
    target: "es2022",
  },
});
