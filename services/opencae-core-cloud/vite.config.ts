import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: false,
    minify: false,
    outDir: "dist",
    sourcemap: true,
    ssr: "src/server.ts",
    target: "node22",
    rollupOptions: {
      output: {
        entryFileNames: "server.bundle.js"
      }
    }
  },
  ssr: {
    noExternal: ["@opencae/core", "@opencae/solver-cpu"]
  }
});
