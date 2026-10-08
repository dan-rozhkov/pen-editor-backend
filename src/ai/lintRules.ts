// The rule ids of lint_design. Neutral module: the tool schema (tools.ts) and
// the design-system usage reports (src/ds/usage.ts) both import this list, so
// they cannot drift and usage code does not pull in the whole tool module.
export const LINT_RULE_IDS = [
  "hardcoded-value",
  "off-scale-value",
  "contrast",
  "deprecated-token",
  "deprecated-component",
  "embed-literal",
  "component-drift",
] as const;
