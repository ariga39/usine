import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/runtime.ts",
    "src/contract.ts",
    "src/schema.ts",
    "src/task-authority.ts",
    "src/candidate-workspace.ts",
    "src/coding-session.ts",
    "src/delivery-run.ts",
    "src/quality-gate.ts",
    "src/forge-delivery.ts",
  ],
  format: "esm",
  unbundle: true,
  dts: true,
  clean: true,
});
