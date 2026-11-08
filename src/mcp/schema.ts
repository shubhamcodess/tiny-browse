/**
 * The small subset of JSON Schema used by our tool definitions, plus a
 * validator for it. Keeps us free of ajv/zod.
 */
export interface Schema {
  type?: "object" | "string" | "integer" | "number" | "boolean" | "array";
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Schema;
  enum?: readonly unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  /** Only "uri" is checked: an absolute http(s) URL. */
  format?: "uri";
}

/** Returns a list of human-readable problems; empty means valid. */
export function validate(schema: Schema, value: unknown, path = "arguments"): string[] {
  const errors: string[] = [];

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`);
    return errors;
  }

  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        errors.push(`${path} must be an object`);
        return errors;
      }
      const obj = value as Record<string, unknown>;
      for (const req of schema.required ?? []) {
        if (obj[req] === undefined) errors.push(`${path}.${req} is required`);
      }
      for (const [key, v] of Object.entries(obj)) {
        const sub = schema.properties?.[key];
        if (!sub) {
          if (schema.additionalProperties === false) errors.push(`${path}.${key} is not a known parameter`);
          continue;
        }
        if (v === undefined) continue;
        errors.push(...validate(sub, v, `${path}.${key}`));
      }
      return errors;
    }
    case "array": {
      if (!Array.isArray(value)) {
        errors.push(`${path} must be an array`);
        return errors;
      }
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        errors.push(`${path} must have at least ${schema.minItems} item(s)`);
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        errors.push(`${path} must have at most ${schema.maxItems} item(s)`);
      }
      if (schema.items) value.forEach((v, i) => errors.push(...validate(schema.items!, v, `${path}[${i}]`)));
      return errors;
    }
    case "string": {
      if (typeof value !== "string") {
        errors.push(`${path} must be a string`);
        return errors;
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        errors.push(`${path} must not be empty`);
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        errors.push(`${path} must be at most ${schema.maxLength} characters`);
      }
      if (schema.format === "uri" && !isHttpUrl(value)) {
        errors.push(`${path} must be an absolute http(s) URL`);
      }
      return errors;
    }
    case "integer":
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value))) {
        errors.push(`${path} must be ${schema.type === "integer" ? "an integer" : "a number"}`);
        return errors;
      }
      if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} must be >= ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} must be <= ${schema.maximum}`);
      return errors;
    }
    case "boolean":
      if (typeof value !== "boolean") errors.push(`${path} must be true or false`);
      return errors;
    default:
      return errors;
  }
}

export function isHttpUrl(s: string): boolean {
  if (!URL.canParse(s)) return false;
  const { protocol } = new URL(s);
  return protocol === "http:" || protocol === "https:";
}
