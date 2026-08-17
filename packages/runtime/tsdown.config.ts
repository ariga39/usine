import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/runtime.ts", "src/contract.ts", "src/schema.ts"],
  format: "esm",
  unbundle: true,
  dts: true,
  clean: true,
});
