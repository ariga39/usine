import { Effect, Predicate, Schema } from "effect";
import {
  repositoryResourceEffectSchema,
  serverHealthSchema,
  serverSnapshotSchema,
  taskEventPageSchema,
  taskEventSchema,
  taskListPageSchema,
  taskResourceSchema,
  usageReportPageSchema,
  campaignResourceSchema,
  type CampaignResource,
  type RepositoryResource,
  type ServerHealth,
  type ServerSnapshot,
  type TaskEvent,
  type TaskEventPage,
  type TaskListPage,
  type TaskResource,
  type UsageReportPage,
} from "@usine/task-authority";
import {
  HttpApi,
  HttpApiClient,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "effect/unstable/httpapi";
import { FetchHttpClient } from "effect/unstable/http";

const validationError = Schema.Union([
  Schema.Struct({ code: Schema.Literal("validation"), message: Schema.String }),
  Schema.Struct({ error: Schema.Literal("validation"), message: Schema.String }),
]).pipe(HttpApiSchema.status(400));
const notFoundError = Schema.Union([
  Schema.Struct({ code: Schema.Literal("not_found"), message: Schema.String }),
  Schema.Struct({ error: Schema.Literal("not_found"), message: Schema.String }),
]).pipe(HttpApiSchema.status(404));
const capacityError = Schema.Struct({
  code: Schema.Literal("active_task_capacity"),
  message: Schema.String,
  retryable: Schema.Literal(true),
}).pipe(HttpApiSchema.status(429));
const retryConflictError = Schema.Struct({
  code: Schema.Literal("task_retry_conflict"),
  message: Schema.String,
  retryable: Schema.Literal(false),
  state: Schema.String,
}).pipe(HttpApiSchema.status(409));
const campaignContentConflictError = Schema.Struct({
  code: Schema.Literal("campaign_content_conflict"),
  message: Schema.String,
  retryable: Schema.Literal(false),
}).pipe(HttpApiSchema.status(409));
const campaignProposalConflictError = Schema.Struct({
  code: Schema.Literal("campaign_proposal_conflict"),
  message: Schema.String,
  retryable: Schema.Literal(false),
}).pipe(HttpApiSchema.status(409));
const quarantineError = Schema.Struct({
  taskId: Schema.String,
  error: Schema.Literal("task_state_quarantined"),
}).pipe(HttpApiSchema.status(503));
const forgeError = Schema.Struct({
  code: Schema.Literals(["malformed", "unauthorized", "repository_mismatch"]),
  message: Schema.String,
}).pipe(HttpApiSchema.status(500));
const serverError = Schema.Union([
  Schema.Struct({ code: Schema.Literal("server_error"), message: Schema.String }),
  Schema.Struct({ error: Schema.String, message: Schema.String }),
]).pipe(HttpApiSchema.status(500));

const limitQuery = { limit: Schema.optional(Schema.NumberFromString) };
const taskParams = { taskId: Schema.String };
const repositoryParams = { repositoryId: Schema.String };
const scopeQuery = {
  taskId: Schema.optional(Schema.String),
  repositoryId: Schema.optional(Schema.String),
};
const scopeSchema = Schema.Struct(scopeQuery);
const eventQuery = {
  ...scopeQuery,
  after: Schema.optional(Schema.NumberFromString),
  limit: Schema.optional(Schema.NumberFromString),
};
const eventQuerySchema = Schema.Struct(eventQuery);
const waitQuery = { ...eventQuery, timeoutMs: Schema.optional(Schema.NumberFromString) };
const eventPageQuery = {
  after: Schema.optional(Schema.NumberFromString),
  limit: Schema.optional(Schema.NumberFromString),
};
const taskListQuery = {
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
};
const usageQuery = {
  taskId: Schema.optional(Schema.String),
  repositoryId: Schema.optional(Schema.String),
  fromEpochMs: Schema.optional(Schema.NumberFromString),
  toEpochMs: Schema.optional(Schema.NumberFromString),
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
};
const usageQuerySchema = Schema.Struct(usageQuery);

const repositoryRegistrationSchema = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  owner: Schema.String,
  name: Schema.String,
  baseBranch: Schema.String,
  implementerProfile: Schema.String,
  reviewerProfile: Schema.String,
  forgeProfile: Schema.String,
  githubReadProfile: Schema.optional(Schema.NullOr(Schema.String)),
  projectCheck: Schema.Struct({ command: Schema.String, timeoutMs: Schema.Int }),
  gitAuthor: Schema.Struct({ name: Schema.String, email: Schema.String }),
});
const taskSubmissionSchema = Schema.Struct({
  contractPath: Schema.String,
  repositoryId: Schema.optional(Schema.String),
});
const campaignPublicationSchema = Schema.Struct({ contractPath: Schema.String });
const campaignProposalSubmissionSchema = Schema.Unknown;
const eventEnvelopeSchema = Schema.StructWithRest(
  Schema.Struct({
    taskId: Schema.String,
    repositoryId: Schema.String,
    event: taskEventSchema,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
).check(
  Schema.makeFilter((value) => {
    if (Object.keys(value).toSorted().join(",") !== "event,repositoryId,taskId")
      return "TaskEventEnvelope has unexpected fields";
    return value.taskId === value.event.taskId
      ? undefined
      : "event envelope Task ID is inconsistent";
  }),
);
const eventStreamReadySchema = Schema.Struct({ kind: Schema.Literal("ready") });
const eventStreamDataSchema = Schema.Union([eventEnvelopeSchema, eventStreamReadySchema]);
const eventStreamSchema = HttpApiSchema.StreamSse({ data: eventStreamDataSchema });
const eventStreamEnvelope = Schema.Struct({
  id: Schema.optional(Schema.String),
  event: Schema.String,
  data: eventStreamDataSchema,
});

const allErrors = [
  validationError,
  notFoundError,
  capacityError,
  retryConflictError,
  campaignContentConflictError,
  campaignProposalConflictError,
  quarantineError,
  forgeError,
  serverError,
] as const;

const ServerApi = HttpApiGroup.make("server", { topLevel: true }).add(
  HttpApiEndpoint.get("health", "/v1/health", { success: serverHealthSchema, error: allErrors }),
  HttpApiEndpoint.get("snapshot", "/v1/snapshot", {
    query: limitQuery,
    success: serverSnapshotSchema,
    error: allErrors,
  }),
);

const RepositoryApi = HttpApiGroup.make("repositories").add(
  HttpApiEndpoint.get("list", "/v1/repositories", {
    query: limitQuery,
    success: Schema.Struct({ repositories: Schema.Array(repositoryResourceEffectSchema) }),
    error: allErrors,
  }),
  HttpApiEndpoint.get("get", "/v1/repositories/:repositoryId", {
    params: repositoryParams,
    success: repositoryResourceEffectSchema,
    error: allErrors,
  }),
  HttpApiEndpoint.post("register", "/v1/repositories", {
    payload: repositoryRegistrationSchema,
    success: repositoryResourceEffectSchema,
    error: allErrors,
  }),
);

const TaskApi = HttpApiGroup.make("tasks").add(
  HttpApiEndpoint.get("list", "/v1/tasks", {
    query: taskListQuery,
    success: taskListPageSchema,
    error: allErrors,
  }),
  HttpApiEndpoint.get("get", "/v1/tasks/:taskId", {
    params: taskParams,
    success: taskResourceSchema,
    error: allErrors,
  }),
  HttpApiEndpoint.get("history", "/v1/tasks/:taskId/events", {
    params: taskParams,
    query: eventPageQuery,
    success: taskEventPageSchema,
    error: allErrors,
  }),
  HttpApiEndpoint.post("submit", "/v1/tasks", {
    payload: taskSubmissionSchema,
    success: taskResourceSchema,
    error: allErrors,
  }),
  HttpApiEndpoint.post("retry", "/v1/tasks/:taskId/retry", {
    params: taskParams,
    success: taskResourceSchema,
    error: allErrors,
  }),
);

const UsageApi = HttpApiGroup.make("usage").add(
  HttpApiEndpoint.get("report", "/v1/usage", {
    query: usageQuery,
    success: usageReportPageSchema,
    error: allErrors,
  }),
);

const CampaignApi = HttpApiGroup.make("campaigns").add(
  HttpApiEndpoint.post("publish", "/v1/campaigns", {
    payload: campaignPublicationSchema,
    success: campaignResourceSchema,
    error: allErrors,
  }),
  HttpApiEndpoint.get("get", "/v1/campaigns/:campaignId", {
    params: { campaignId: Schema.String },
    success: campaignResourceSchema,
    error: allErrors,
  }),
  HttpApiEndpoint.post("propose", "/v1/campaigns/:campaignId/proposals", {
    params: { campaignId: Schema.String },
    payload: campaignProposalSubmissionSchema,
    success: campaignResourceSchema,
    error: allErrors,
  }),
);

const EventApi = HttpApiGroup.make("events").add(
  HttpApiEndpoint.get("wait", "/v1/events/wait", {
    query: waitQuery,
    success: Schema.NullOr(eventEnvelopeSchema),
    error: allErrors,
  }),
  HttpApiEndpoint.get("subscribe", "/v1/events/subscribe", {
    query: eventQuery,
    success: eventStreamSchema,
    error: allErrors,
  }),
);

export const UsineApi = HttpApi.make("usine-loopback-api")
  .add(ServerApi)
  .add(RepositoryApi)
  .add(TaskApi)
  .add(UsageApi)
  .add(CampaignApi)
  .add(EventApi);

export type ApiEventScope = Schema.Schema.Type<typeof scopeSchema>;
export type ApiEventQuery = Schema.Schema.Type<typeof eventQuerySchema>;
export type ApiEventEnvelope = Schema.Schema.Type<typeof eventEnvelopeSchema>;
export type ApiTaskSubmission = Schema.Schema.Type<typeof taskSubmissionSchema>;
export type ApiTaskResource = Schema.Schema.Type<typeof taskResourceSchema>;
export type ApiError = Schema.Schema.Type<(typeof allErrors)[number]>;
export type ApiEventStreamValue = Schema.Schema.Type<typeof eventStreamDataSchema>;
export type ApiUsageQuery = Schema.Schema.Type<typeof usageQuerySchema>;
export type ApiUsageReport = UsageReportPage;
export type ApiCampaignPublication = Schema.Schema.Type<typeof campaignPublicationSchema>;
export type ApiCampaignResource = Schema.Schema.Type<typeof campaignResourceSchema>;
export type ApiCampaignProposalSubmission = Schema.Schema.Type<
  typeof campaignProposalSubmissionSchema
>;

export function encodeApiWaitResponse(value: ApiEventEnvelope | null): string {
  return JSON.stringify(Schema.encodeUnknownSync(Schema.NullOr(eventEnvelopeSchema))(value));
}

export function decodeApiEventEnvelope(input: unknown): ApiEventEnvelope {
  if (!Predicate.isObject(input)) throw new Error("TaskEventEnvelope must be an object");
  const keys = Object.keys(input).toSorted();
  if (keys.join(",") !== "event,repositoryId,taskId")
    throw new Error("TaskEventEnvelope has unexpected fields");
  return Schema.decodeUnknownSync(eventEnvelopeSchema)(input);
}

export function decodeApiEventStreamValue(input: unknown): ApiEventEnvelope | undefined {
  const value =
    typeof input === "object" && input !== null && "data" in input
      ? Schema.decodeUnknownSync(eventStreamEnvelope)(input).data
      : input;
  if (typeof value === "object" && value !== null && "kind" in value) return undefined;
  return decodeApiEventEnvelope(value);
}

export const makeUsineApiClient = (baseUrl: string) =>
  HttpApiClient.make(UsineApi, { baseUrl }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
  );

export {
  eventEnvelopeSchema,
  eventStreamSchema,
  repositoryRegistrationSchema,
  taskSubmissionSchema,
  campaignPublicationSchema,
  campaignResourceSchema,
  campaignProposalSubmissionSchema,
  campaignProposalConflictError,
  validationError,
  notFoundError,
  capacityError,
  retryConflictError,
  quarantineError,
  forgeError,
  serverError,
};

export type {
  RepositoryResource,
  ServerHealth,
  ServerSnapshot,
  TaskEvent,
  TaskEventPage,
  TaskListPage,
  TaskResource,
  CampaignResource,
};
