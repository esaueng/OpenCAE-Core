import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@opencae/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
      "@opencae/solver-cpu": fileURLToPath(new URL("../../packages/solver-cpu/src/index.ts", import.meta.url))
    }
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"]
  }
});
