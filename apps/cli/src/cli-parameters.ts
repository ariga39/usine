import { Schema } from "effect";
import { Flag } from "effect/unstable/cli";

const boundedLimit = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 200 })));

export const jsonFlag = () => Flag.boolean("json").pipe(Flag.withDefault(false));

export const boundedLimitFlag = (defaultValue: number) =>
  Flag.integer("limit").pipe(Flag.withSchema(boundedLimit), Flag.withDefault(defaultValue));

export const naturalFlag = (name: string) =>
  Flag.integer(name).pipe(Flag.withSchema(Schema.Natural));
