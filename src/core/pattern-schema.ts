import { z } from "zod";

export const patternTypes = ["exact", "domain", "glob", "regex"] as const;

export const urlPatternSchema = z.union([
  z.string().min(1).max(1000),
  z.strictObject({ type: z.enum(patternTypes), value: z.string().min(1).max(1000) }),
]);
