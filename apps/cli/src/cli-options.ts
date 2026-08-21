import { usageFailure } from "./cli-failure.js";

export interface ParsedOptions {
  readonly json: boolean;
  readonly values: string[];
}

export function parseOptions(args: string[]): ParsedOptions {
  return {
    json: args.includes("--json"),
    values: args.filter((value) => value !== "--json"),
  };
}

export function optionIndex(values: string[], option: string): number {
  return values.indexOf(option);
}

export function withoutOption(values: string[], index: number): string[] {
  return values.filter((_, valueIndex) => valueIndex !== index && valueIndex !== index + 1);
}

export function parseBoundedLimit(value: string | undefined, usage: string): number {
  return parseBoundedNumber(value, usage, 1, 200);
}

export function parseNonNegativeNumber(value: string | undefined, usage: string): number {
  if (!value || !/^\d+$/.test(value)) throw usageFailure(usage);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw usageFailure(usage);
  return parsed;
}

function parseBoundedNumber(
  value: string | undefined,
  usage: string,
  minimum: number,
  maximum: number,
): number {
  if (!value || !/^\d+$/.test(value)) throw usageFailure(usage);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    throw usageFailure(usage);
  return parsed;
}
