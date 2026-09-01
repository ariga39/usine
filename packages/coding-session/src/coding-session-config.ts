import { validateCodexProfile } from "./codex-profile.js";

export type CodingSessionAdapterName = "sdk" | "app-server" | "opencode2";

export class CodingSessionAdapterConfigurationError extends Error {
  readonly code = "coding_session_adapter_configuration_invalid" as const;
  readonly kind = "validation" as const;

  constructor(profile: string) {
    super(`coding session profile "${profile}" is assigned to both codex-app-server and opencode2`);
    this.name = "CodingSessionAdapterConfigurationError";
  }
}

/** Static host composition for the task-oriented Coding Session port. */
export interface CodingSessionAdapterProfiles {
  readonly appServerProfiles: readonly string[];
  readonly openCode2Profiles: readonly string[];
}

export function codingSessionAdapterProfilesFromEnvironment(
  environment: NodeJS.ProcessEnv,
): CodingSessionAdapterProfiles {
  return normalizeCodingSessionAdapterProfiles({
    appServerProfiles: profileListFromEnvironment(environment.USINE_CODEX_APP_SERVER_PROFILES),
    openCode2Profiles: profileListFromEnvironment(environment.USINE_OPENCODE2_PROFILES),
  });
}

/** Copy only host-private adapter selection inputs for Coding Session construction. */
export function codingSessionAdapterSelectionEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const selectionEnvironment: NodeJS.ProcessEnv = {};
  for (const key of ["USINE_CODEX_APP_SERVER_PROFILES", "USINE_OPENCODE2_PROFILES"] as const) {
    if (environment[key] !== undefined) selectionEnvironment[key] = environment[key];
  }
  return selectionEnvironment;
}

export function normalizeCodingSessionAdapterProfiles(
  profiles: CodingSessionAdapterProfiles,
): CodingSessionAdapterProfiles {
  const appServerProfiles = [...new Set(profiles.appServerProfiles)];
  const openCode2Profiles = [...new Set(profiles.openCode2Profiles)];
  const overlap = appServerProfiles.find((profile) => openCode2Profiles.includes(profile));
  if (overlap !== undefined) throw new CodingSessionAdapterConfigurationError(overlap);
  return { appServerProfiles, openCode2Profiles };
}

export function codingSessionAdapterForProfile(
  profile: string,
  profiles: CodingSessionAdapterProfiles,
): CodingSessionAdapterName {
  const normalized = normalizeCodingSessionAdapterProfiles(profiles);
  if (normalized.openCode2Profiles.includes(profile)) return "opencode2";
  if (normalized.appServerProfiles.includes(profile)) return "app-server";
  return "sdk";
}

function profileListFromEnvironment(value: string | undefined): readonly string[] {
  const configured = value?.trim();
  if (!configured) return [];
  return configured.split(",").map(validateCodexProfile);
}
