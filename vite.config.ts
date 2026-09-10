import { defineConfig } from "vite-plus";

const repositoryState = [
  "**/.worktrees/**",
  "**/.pnpm-store/**",
  "**/.tasks/**",
  "**/node_modules/**",
  "**/dist/**",
];

export default defineConfig({
  fmt: {
    ignorePatterns: ["AGENTS.md", "README.md", "docs/**", ...repositoryState],
    printWidth: 100,
  },
  lint: {
    categories: {
      correctness: "error",
      suspicious: "warn",
    },
    // External target templates are type-aware checked in their generated projects.
    ignorePatterns: [
      ...repositoryState,
      "evaluations/475/controls/**",
      "evaluations/475/fixture/**",
    ],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: repositoryState,
  },
});
