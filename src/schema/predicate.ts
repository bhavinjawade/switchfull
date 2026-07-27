import { Type, type Static } from "@sinclair/typebox";

export const ComparisonOperatorSchema = Type.Union([
  Type.Literal("eq"),
  Type.Literal("neq"),
  Type.Literal("lt"),
  Type.Literal("lte"),
  Type.Literal("gt"),
  Type.Literal("gte"),
  Type.Literal("in"),
  Type.Literal("exists"),
]);

export const PredicateSchema = Type.Recursive(
  (Self) =>
    Type.Union([
      Type.Object(
        {
          field: Type.String({ minLength: 1 }),
          operator: ComparisonOperatorSchema,
          value: Type.Optional(
            Type.Union([
              Type.String(),
              Type.Number(),
              Type.Boolean(),
              Type.Null(),
              Type.Array(Type.Union([Type.String(), Type.Number(), Type.Boolean()])),
            ]),
          ),
        },
        { additionalProperties: false },
      ),
      Type.Object({ all: Type.Array(Self, { minItems: 1 }) }, { additionalProperties: false }),
      Type.Object({ any: Type.Array(Self, { minItems: 1 }) }, { additionalProperties: false }),
      Type.Object({ not: Self }, { additionalProperties: false }),
    ]),
  { $id: "https://switch.dev/schema/predicate/v1alpha1" },
);
export type Predicate = Static<typeof PredicateSchema>;
