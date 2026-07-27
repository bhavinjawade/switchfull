import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import type { TSchema, Static } from "@sinclair/typebox";
import { SwitchError } from "../domain/errors.js";

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  allowUnionTypes: true,
});
ajv.addFormat("uuid", {
  type: "string",
  validate: (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
});
ajv.addFormat("date-time", {
  type: "string",
  validate: (value: string) => !Number.isNaN(Date.parse(value)),
});

function describeErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors?.length) return "Schema validation failed.";
  return errors
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
}

export function compileValidator<T extends TSchema>(schema: T): (value: unknown) => Static<T> {
  const validate: ValidateFunction<Static<T>> = ajv.compile(schema);
  return (value: unknown): Static<T> => {
    if (validate(value)) return value;
    throw new SwitchError({
      code: "validation_error",
      message: describeErrors(validate.errors),
      retry: "non_retryable",
      details: { errors: validate.errors ?? [] },
    });
  };
}

export function exportJsonSchema<T extends TSchema>(schema: T): T {
  return schema;
}
