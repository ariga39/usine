import { createOpenAI } from "@ai-sdk/openai";
import { generateText, Output } from "ai";
import { z } from "zod";

export interface ReviewerVerdictExtractorInput {
  deadlineEpochMs: number;
  extractorModel: string;
  extractorBaseUrl: string;
}

export interface ReviewerVerdict {
  sha: string;
  verdict: "approved" | "changes_requested" | "inconclusive";
  summary: string;
  findings: string[];
}

export class ElapsedBudgetError extends Error {
  constructor() {
    super("elapsed budget exhausted");
  }
}

const reviewerOutputSchema = z
  .object({
    sha: z.string().regex(/^[0-9a-f]{40}$/),
    verdict: z.enum(["approved", "changes_requested", "inconclusive"]),
    summary: z.string(),
    findings: z.array(z.string()),
  })
  .strict();

function operationTimeout(
  input: ReviewerVerdictExtractorInput,
  maximum = Number.POSITIVE_INFINITY,
): number {
  const remaining = input.deadlineEpochMs - Date.now() - 150;
  if (remaining <= 0) throw new ElapsedBudgetError();
  return Math.max(1, Math.min(remaining, maximum));
}

export function configuredExtractorBaseUrl(): string {
  return (
    process.env.USINE_EXTRACTOR_BASE_URL ??
    process.env.OPENAI_BASE_URL ??
    "https://api.openai.com/v1"
  );
}

export async function extractReviewerVerdict(
  input: ReviewerVerdictExtractorInput,
  transcript: string,
  sha: string,
): Promise<ReviewerVerdict> {
  const systemMessage = [
    "Extract exactly one reviewer verdict from this rendered Herdr transcript.",
    "The transcript may contain terminal hard wrapping. Reconstruct the verdict only from the transcript.",
    "If the verdict is missing, truncated, ambiguous, or malformed, return verdict inconclusive.",
    "Return only the schema-constrained JSON object described by the response format.",
  ].join("\n");
  const apiKey = process.env.USINE_EXTRACTOR_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("review verdict extractor credentials are not configured");
  const abortSignal = AbortSignal.timeout(operationTimeout(input));
  try {
    const openai = createOpenAI({
      baseURL: input.extractorBaseUrl,
      apiKey,
    });
    const { output } = await generateText({
      model: openai.chat(input.extractorModel),
      system: systemMessage,
      prompt: transcript,
      output: Output.object({ schema: reviewerOutputSchema }),
      maxRetries: 0,
      abortSignal,
    });
    if (output.sha !== sha) throw new Error("review verdict names a stale candidate SHA");
    return output;
  } catch (error) {
    if (abortSignal.aborted || Date.now() >= input.deadlineEpochMs - 100)
      throw new ElapsedBudgetError();
    throw new Error("review verdict extractor request failed", { cause: error });
  }
}
