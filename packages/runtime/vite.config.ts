import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
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
    dts: true,
    clean: true,
  },
});
