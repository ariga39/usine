import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: { entry: ["src/index.ts"], format: "esm", dts: true, deps: { neverBundle: ["react"] } },
  fmt: { ignorePatterns: ["dist/**", "node_modules/**", "pnpm-lock.yaml"] },
  lint: {
    categories: { correctness: "error", suspicious: "warn" },
    ignorePatterns: ["dist/**", "node_modules/**"],
    options: { typeAware: true, typeCheck: true },
  },
  test: { include: ["tests/**/*.test.mjs"], fileParallelism: false },
});
