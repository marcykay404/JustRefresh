import { z } from "./zod";

export const patternTypes = ["exact", "domain", "glob", "regex"] as const;

export const urlPatternSchema = z.union([
  z.string().check(z.minLength(1), z.maxLength(1000)),
  z.strictObject({ type: z.enum(patternTypes), value: z.string().check(z.minLength(1), z.maxLength(1000)) }),
]);
