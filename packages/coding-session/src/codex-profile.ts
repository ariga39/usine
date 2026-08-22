import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CodexOptions, ModelReasoningEffort } from "@openai/codex-sdk";
import { Toml } from "effect/unstable/encoding";
import { z } from "zod";

type CodexConfig = NonNullable<CodexOptions["config"]>;

const modelReasoningEffortSchema = z.enum(["minimal", "low", "medium", "high", "xhigh"]);
const profileConfigFieldsSchema = z
  .object({
    features: z.record(z.string(), z.unknown()).optional(),
    model_catalog_json: z.string().optional(),
    model_provider: z.string().trim().min(1).optional(),
    model_providers: z.record(z.string(), z.unknown()).optional(),
    model_reasoning_effort: modelReasoningEffortSchema.optional(),
    model_reasoning_summary: z.string().optional(),
    model_verbosity: z.string().optional(),
    personality: z.string().optional(),
    service_tier: z.string().optional(),
  })
  .passthrough();
const profileFileSchema = z
  .object({
    model: z.string().trim().min(1),
    model_reasoning_effort: modelReasoningEffortSchema.optional(),
  })
  .passthrough();
const profileSelectionSchema = z.object({
  model: z.string().trim().min(1),
  modelReasoningEffort: modelReasoningEffortSchema.optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const PROFILE_CONFIG_KEYS = new Set([
  "features",
  "model",
  "model_catalog_json",
  "model_provider",
  "model_providers",
  "model_reasoning_effort",
  "model_reasoning_summary",
  "model_verbosity",
  "personality",
  "service_tier",
]);

export class CodexProfileSelectionError extends Error {
  readonly code = "codex_profile_unusable" as const;

  constructor(
    readonly profile: string,
    reason = "must be a non-blank safe profile name",
  ) {
    super(`Codex profile is unusable: ${reason}`);
    this.name = "CodexProfileSelectionError";
  }
}

export function validateCodexProfile(profile: string): string {
  const normalized = profile.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized))
    throw new CodexProfileSelectionError(profile);
  return normalized;
}

export interface CodexProfileSelection {
  model: string;
  modelReasoningEffort?: ModelReasoningEffort;
}

interface ResolvedCodexProfile extends CodexProfileSelection {
  config: CodexConfig;
}

export type CodexProfileResolver = (
  profile: string,
  environment: NodeJS.ProcessEnv,
) => Promise<CodexProfileSelection>;

export const resolveCodexProfile: CodexProfileResolver = async (
  profile: string,
  environment: NodeJS.ProcessEnv,
) => {
  const normalized = validateCodexProfile(profile);
  const codexHome = environment.CODEX_HOME?.trim() || join(homedir(), ".codex");
  let parsed: unknown;
  try {
    parsed = Toml.parse(await readFile(join(codexHome, `${normalized}.config.toml`), "utf8"));
  } catch {
    throw new CodexProfileSelectionError(
      normalized,
      `named profile "${normalized}" has an unreadable Codex configuration`,
    );
  }

  const profileConfig = profileFileSchema.safeParse(parsed);
  if (!profileConfig.success)
    throw new CodexProfileSelectionError(
      normalized,
      `named profile "${normalized}" has malformed or unsupported model configuration`,
    );
  const supportedConfig = profileConfigFieldsSchema.safeParse(profileConfig.data);
  if (!supportedConfig.success)
    throw new CodexProfileSelectionError(
      normalized,
      `named profile "${normalized}" has malformed or unsupported model configuration`,
    );

  const config = Object.fromEntries(
    Object.entries(supportedConfig.data).filter(([key]) => PROFILE_CONFIG_KEYS.has(key)),
  ) as CodexConfig;
  return {
    model: profileConfig.data.model,
    modelReasoningEffort: profileConfig.data.model_reasoning_effort,
    config,
  };
};

export function normalizeCodexProfileSelection(
  profile: string,
  selection: unknown,
): ResolvedCodexProfile {
  const parsed = profileSelectionSchema.safeParse(selection);
  if (!parsed.success)
    throw new CodexProfileSelectionError(
      profile,
      `named profile "${profile}" has malformed or unsupported model configuration`,
    );

  const profileConfig = profileConfigFieldsSchema.safeParse(parsed.data.config ?? {});
  if (!profileConfig.success)
    throw new CodexProfileSelectionError(
      profile,
      `named profile "${profile}" has malformed or unsupported model configuration`,
    );
  const config = Object.fromEntries(
    Object.entries(profileConfig.data).filter(([key]) => PROFILE_CONFIG_KEYS.has(key)),
  ) as CodexConfig;
  return {
    model: parsed.data.model,
    modelReasoningEffort: parsed.data.modelReasoningEffort,
    config: {
      ...config,
      model: parsed.data.model,
      ...(parsed.data.modelReasoningEffort
        ? { model_reasoning_effort: parsed.data.modelReasoningEffort }
        : {}),
    },
  };
}

export function codexAdapterConfig(
  selection: ResolvedCodexProfile,
  mcpConfig: CodexConfig = {},
): CodexConfig {
  return {
    ...selection.config,
    model: selection.model,
    ...(selection.modelReasoningEffort
      ? { model_reasoning_effort: selection.modelReasoningEffort }
      : {}),
    approval_policy: "never",
    mcp_servers: {},
    ...mcpConfig,
  };
}
