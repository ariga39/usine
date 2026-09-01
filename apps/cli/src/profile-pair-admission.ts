export type ProfilePairChangedFactor = "model_stack" | "reasoning" | "developer_instructions";

export type ProfilePairField =
  | "model"
  | "modelProvider"
  | "modelProviders"
  | "modelCatalogJson"
  | "adapter"
  | "reasoningEffort"
  | "developerInstructions"
  | "reasoningSummary"
  | "verbosity"
  | "personality"
  | "serviceTier";

export interface ProfilePairProfileSelection {
  readonly model: string;
  readonly modelReasoningEffort?: unknown;
  readonly developerInstructions?: unknown;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly adapter: "sdk" | "app-server" | "opencode2";
}

export interface ProfilePairFieldSnapshot {
  readonly model: string;
  readonly modelProvider: unknown;
  readonly modelProviders: unknown;
  readonly modelCatalogJson: unknown;
  readonly adapter: ProfilePairProfileSelection["adapter"];
  readonly reasoningEffort: unknown;
  readonly developerInstructions: unknown;
  readonly reasoningSummary: unknown;
  readonly verbosity: unknown;
  readonly personality: unknown;
  readonly serviceTier: unknown;
}

export type ProfilePairAdmission =
  | { readonly accepted: true }
  | {
      readonly accepted: false;
      readonly reason: "unchanged_factor";
      readonly changedFactor: ProfilePairChangedFactor;
    }
  | {
      readonly accepted: false;
      readonly reason: "outside_factor";
      readonly changedFactor: ProfilePairChangedFactor;
      readonly fields: readonly ProfilePairField[];
    };

const changedFactorFields: Readonly<Record<ProfilePairChangedFactor, readonly ProfilePairField[]>> =
  {
    model_stack: ["model", "modelProvider", "modelProviders", "modelCatalogJson"],
    reasoning: ["reasoningEffort"],
    developer_instructions: ["developerInstructions"],
  };

const allProfilePairFields: readonly ProfilePairField[] = [
  "model",
  "modelProvider",
  "modelProviders",
  "modelCatalogJson",
  "adapter",
  "reasoningEffort",
  "developerInstructions",
  "reasoningSummary",
  "verbosity",
  "personality",
  "serviceTier",
];

export function isProfilePairChangedFactor(value: unknown): value is ProfilePairChangedFactor {
  return value === "model_stack" || value === "reasoning" || value === "developer_instructions";
}

export function profilePairFieldSnapshot(
  selection: ProfilePairProfileSelection,
): ProfilePairFieldSnapshot {
  const config = selection.config;
  return {
    model: selection.model,
    modelProvider: config?.model_provider ?? null,
    modelProviders: config?.model_providers ?? null,
    modelCatalogJson: config?.model_catalog_json ?? null,
    adapter: selection.adapter,
    reasoningEffort: selection.modelReasoningEffort ?? null,
    developerInstructions: selection.developerInstructions ?? null,
    reasoningSummary: config?.model_reasoning_summary ?? null,
    verbosity: config?.model_verbosity ?? null,
    personality: config?.personality ?? null,
    serviceTier: config?.service_tier ?? null,
  };
}

export function admitProfilePair(input: {
  readonly changedFactor: ProfilePairChangedFactor;
  readonly baseline: ProfilePairFieldSnapshot;
  readonly candidate: ProfilePairFieldSnapshot;
}): ProfilePairAdmission {
  const factorFields = changedFactorFields[input.changedFactor];
  const differs = (field: ProfilePairField): boolean =>
    stableJson(input.baseline[field]) !== stableJson(input.candidate[field]);
  if (!factorFields.some(differs))
    return {
      accepted: false,
      reason: "unchanged_factor",
      changedFactor: input.changedFactor,
    };
  const factorFieldSet = new Set<ProfilePairField>(factorFields);
  const unrelated = allProfilePairFields.filter(
    (field) => !factorFieldSet.has(field) && differs(field),
  );
  if (unrelated.length > 0)
    return {
      accepted: false,
      reason: "outside_factor",
      changedFactor: input.changedFactor,
      fields: unrelated,
    };
  return { accepted: true };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}
