import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts"],
    format: "esm",
    dts: true,
    clean: true,
  },
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/private/**"],
  },
});
