import { createHash } from "node:crypto";
import {
  codingSessionAdapterForProfile,
  codingSessionAdapterProfilesFromEnvironment,
  resolveCodexProfile,
  type CodingSessionAdapterName,
} from "@usine/runtime";

export interface EvaluationProfileSelection {
  readonly model: string;
  readonly modelReasoningEffort?: string;
  readonly developerInstructions?: string;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly configSha256?: string;
  readonly adapter: CodingSessionAdapterName;
}

export interface ProfileIdentity {
  readonly configSha256: string | null;
  readonly model: string | null;
  readonly modelProvider: string | null;
  readonly reasoningEffort: string | null;
  readonly developerInstructionsSha256: string | null;
  readonly adapter: CodingSessionAdapterName | null;
}

export async function resolveEvaluationProfile(
  profile: string,
  environment: NodeJS.ProcessEnv,
): Promise<EvaluationProfileSelection> {
  const selection = await resolveCodexProfile(profile, environment);
  if (!selection.config) throw new Error("configuration unavailable");
  return {
    ...selection,
    adapter: codingSessionAdapterForProfile(
      profile,
      codingSessionAdapterProfilesFromEnvironment(environment),
    ),
  };
}

export function expectedProfileIdentity(selection: EvaluationProfileSelection): ProfileIdentity {
  const provider = selection.config?.model_provider;
  return {
    configSha256: selection.configSha256 ?? "",
    model: selection.model,
    modelProvider: typeof provider === "string" ? provider : null,
    reasoningEffort: selection.modelReasoningEffort ?? null,
    developerInstructionsSha256: selection.developerInstructions
      ? createHash("sha256").update(selection.developerInstructions, "utf8").digest("hex")
      : null,
    adapter: selection.adapter,
  };
}

export function matchesProfileIdentity(
  actual: ProfileIdentity,
  expected: ProfileIdentity,
): boolean {
  return (
    actual.configSha256 === expected.configSha256 &&
    actual.model === expected.model &&
    actual.modelProvider === expected.modelProvider &&
    actual.reasoningEffort === expected.reasoningEffort &&
    actual.developerInstructionsSha256 === expected.developerInstructionsSha256 &&
    actual.adapter === expected.adapter
  );
}
