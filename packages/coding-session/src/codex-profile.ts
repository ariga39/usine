import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CodexOptions } from "@openai/codex-sdk";
import { Toml } from "effect/unstable/encoding";
import { z } from "zod";
import {
  providerNeutralJsonValue,
  type CodingSessionAdapterProfile,
} from "./coding-session-adapter.js";

type CodexConfig = NonNullable<CodexOptions["config"]>;
type CodexConfigValue = CodexConfig[string];

const modelReasoningEffortSchema = z.enum(["minimal", "low", "medium", "high", "xhigh"]);
const profileConfigFieldsSchema = z
  .object({
    developer_instructions: z.string().trim().min(1).optional(),
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
    developer_instructions: z.string().trim().min(1).optional(),
  })
  .passthrough();
const profileSelectionSchema = z
  .object({
    model: z.string().trim().min(1),
    modelReasoningEffort: modelReasoningEffortSchema.optional(),
    developerInstructions: z.string().trim().min(1).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const PROFILE_CONFIG_KEYS = new Set([
  "developer_instructions",
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

function hasDisallowedFeatures(value: unknown): boolean {
  return typeof value === "object" && value !== null && Object.hasOwn(value, "features");
}

function toCodexConfigValue(value: unknown): CodexConfigValue | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    const converted: CodexConfigValue[] = [];
    for (const child of value) {
      const convertedChild = toCodexConfigValue(child);
      if (convertedChild === undefined) return undefined;
      converted.push(convertedChild);
    }
    return converted;
  }
  if (value !== null && typeof value === "object") {
    const converted: CodexConfig = {};
    for (const [key, child] of Object.entries(value)) {
      const convertedChild = toCodexConfigValue(child);
      if (convertedChild === undefined) return undefined;
      converted[key] = convertedChild;
    }
    return converted;
  }
  return undefined;
}

function codexConfigFromProfileFields(
  profile: string,
  fields: Record<string, unknown>,
  includeDeveloperInstructions: boolean,
): CodexConfig {
  const config: CodexConfig = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!PROFILE_CONFIG_KEYS.has(key)) continue;
    if (!includeDeveloperInstructions && key === "developer_instructions") continue;
    const converted = toCodexConfigValue(value);
    if (converted === undefined)
      throw new CodexProfileSelectionError(
        profile,
        `named profile "${profile}" has malformed or unsupported model configuration`,
      );
    config[key] = converted;
  }
  return config;
}

export interface CodexProfileSelection {
  model: string;
  modelReasoningEffort?: NonNullable<CodingSessionAdapterProfile["reasoningEffort"]>;
  developerInstructions?: string;
  config?: Readonly<Record<string, unknown>>;
  configSha256?: string;
}

interface ResolvedCodexProfile extends Omit<CodexProfileSelection, "config" | "configSha256"> {
  config: CodexConfig;
  configSha256: string;
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
  if (hasDisallowedFeatures(profileConfig.data))
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

  const config = codexConfigFromProfileFields(normalized, supportedConfig.data, true);
  const selection = {
    model: profileConfig.data.model,
    modelReasoningEffort: profileConfig.data.model_reasoning_effort,
    developerInstructions: profileConfig.data.developer_instructions,
    config,
  };
  return withProfileChecksum(selection);
};

export function normalizeCodexProfileSelection(
  profile: string,
  selectionInput: unknown,
): ResolvedCodexProfile {
  const parsed = profileSelectionSchema.safeParse(selectionInput);
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
  if (hasDisallowedFeatures(parsed.data.config))
    throw new CodexProfileSelectionError(
      profile,
      `named profile "${profile}" has malformed or unsupported model configuration`,
    );
  const config = codexConfigFromProfileFields(profile, profileConfig.data, false);
  const selection = {
    model: parsed.data.model,
    modelReasoningEffort: parsed.data.modelReasoningEffort,
    developerInstructions: parsed.data.developerInstructions,
    config: {
      ...config,
      model: parsed.data.model,
      ...(parsed.data.modelReasoningEffort
        ? { model_reasoning_effort: parsed.data.modelReasoningEffort }
        : {}),
      ...(parsed.data.developerInstructions
        ? { developer_instructions: parsed.data.developerInstructions }
        : {}),
    },
  };
  return withProfileChecksum(selection);
}

function withProfileChecksum(
  selection: Omit<ResolvedCodexProfile, "configSha256">,
): ResolvedCodexProfile {
  return {
    ...selection,
    configSha256: resolvedProfileConfigSha256(selection),
  };
}

export function withCodexProfileDeveloperInstructions(
  selection: ResolvedCodexProfile,
  developerInstructions: string,
): ResolvedCodexProfile {
  return withProfileChecksum({
    ...selection,
    developerInstructions,
    config: { ...selection.config, developer_instructions: developerInstructions },
  });
}

function resolvedProfileConfigSha256(
  selection: Omit<ResolvedCodexProfile, "configSha256">,
): string {
  const config = selection.config;
  const supported = {
    model: selection.model,
    model_reasoning_effort: selection.modelReasoningEffort ?? null,
    developer_instructions: selection.developerInstructions ?? null,
    model_catalog_json: config.model_catalog_json ?? null,
    model_provider: config.model_provider ?? null,
    model_providers: config.model_providers ?? null,
    model_reasoning_summary: config.model_reasoning_summary ?? null,
    model_verbosity: config.model_verbosity ?? null,
    personality: config.personality ?? null,
    service_tier: config.service_tier ?? null,
  };
  return createHash("sha256").update(stableJson(supported), "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}

export function codingSessionAdapterProfile(
  selection: ResolvedCodexProfile,
): CodingSessionAdapterProfile {
  const config = selection.config;
  const modelProviders = providerNeutralJsonValue(config.model_providers);
  const profile: CodingSessionAdapterProfile = {
    model: selection.model,
    ...(selection.modelReasoningEffort ? { reasoningEffort: selection.modelReasoningEffort } : {}),
    ...(selection.developerInstructions
      ? { developerInstructions: selection.developerInstructions }
      : {}),
    ...(typeof config.model_catalog_json === "string"
      ? { modelCatalogJson: config.model_catalog_json }
      : {}),
    ...(typeof config.model_provider === "string" ? { modelProvider: config.model_provider } : {}),
    ...(modelProviders !== undefined ? { modelProviders } : {}),
    ...(typeof config.model_reasoning_summary === "string"
      ? { reasoningSummary: config.model_reasoning_summary }
      : {}),
    ...(typeof config.model_verbosity === "string" ? { verbosity: config.model_verbosity } : {}),
    ...(typeof config.personality === "string" ? { personality: config.personality } : {}),
    ...(typeof config.service_tier === "string" ? { serviceTier: config.service_tier } : {}),
  };
  return profile;
}
