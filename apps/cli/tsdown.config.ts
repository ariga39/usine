import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: "esm",
  unbundle: true,
  dts: true,
  clean: true,
});
