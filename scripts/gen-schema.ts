import { writeFileSync, mkdirSync } from "node:fs";
import { buildRuleJsonSchema } from "../src/api/json-schema";

mkdirSync("schemas", { recursive: true });
writeFileSync("schemas/rule.schema.json", JSON.stringify(buildRuleJsonSchema(), null, 2) + "\n");
console.log("Wrote schemas/rule.schema.json");
