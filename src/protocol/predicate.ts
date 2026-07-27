import type { Predicate } from "../schema/predicate.js";

function readPath(context: Readonly<Record<string, unknown>>, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    return (value as Record<string, unknown>)[key];
  }, context);
}

export function evaluatePredicate(
  predicate: Predicate,
  context: Readonly<Record<string, unknown>>,
): boolean {
  if ("all" in predicate) return predicate.all.every((item) => evaluatePredicate(item, context));
  if ("any" in predicate) return predicate.any.some((item) => evaluatePredicate(item, context));
  if ("not" in predicate) return !evaluatePredicate(predicate.not, context);
  const actual = readPath(context, predicate.field);
  switch (predicate.operator) {
    case "exists":
      return actual !== undefined;
    case "eq":
      return actual === predicate.value;
    case "neq":
      return actual !== predicate.value;
    case "lt":
      return (
        typeof actual === "number" &&
        typeof predicate.value === "number" &&
        actual < predicate.value
      );
    case "lte":
      return (
        typeof actual === "number" &&
        typeof predicate.value === "number" &&
        actual <= predicate.value
      );
    case "gt":
      return (
        typeof actual === "number" &&
        typeof predicate.value === "number" &&
        actual > predicate.value
      );
    case "gte":
      return (
        typeof actual === "number" &&
        typeof predicate.value === "number" &&
        actual >= predicate.value
      );
    case "in":
      return Array.isArray(predicate.value) && predicate.value.includes(actual as never);
  }
}
