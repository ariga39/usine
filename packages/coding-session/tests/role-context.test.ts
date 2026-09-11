import { expect, test } from "vite-plus/test";
import { serializeRoleContext } from "@usine/coding-session";

test("role context has deterministic object order and native JSON omission semantics", () => {
  const left = { z: undefined, b: { y: 2, x: 1 }, a: ["second", "first", undefined] };
  const right = { a: ["second", "first", undefined], b: { x: 1, y: 2 } };
  expect(serializeRoleContext(left)).toBe(serializeRoleContext(right));
  expect(serializeRoleContext(left)).toBe('{"a":["second","first",null],"b":{"x":1,"y":2}}');
  expect(JSON.parse(serializeRoleContext(left))).toEqual(JSON.parse(JSON.stringify(left)));
  expect(serializeRoleContext({ a: ["first", "second"] })).not.toBe(
    serializeRoleContext({ a: ["second", "first"] }),
  );
});
