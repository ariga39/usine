import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts", "src/contract.ts"],
    format: "esm",
    dts: true,
    clean: true,
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
