import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/cli.ts"],
    format: "esm",
    unbundle: true,
    dts: true,
    clean: true,
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
