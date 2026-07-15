// Regex PII scrubber — layer (a) of the three-layer defense described in the
// spec. Order matters: data URLs and URL credentials are matched before the
// generic email/token/blob rules would mangle them. All regexes use /g and are
// applied via String.replace (never .test, which is stateful for /g).
const RULES: Array<{ re: RegExp; replacement: string }> = [
  { re: /data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{50,}/gi, replacement: "[DATA_URL]" },
  { re: /(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, replacement: "$1[CREDENTIALS]@" },
  { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, replacement: "[EMAIL]" },
  // Canonical fixed-format keys shorter than the 64-char BLOB threshold:
  // AWS access key IDs, Google API keys, GitHub fine-grained PATs
  { re: /\b(?:AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z\-_]{35}|github_pat_[A-Za-z0-9_]{20,})\b/g, replacement: "[TOKEN]" },
  // Common secret prefixes (OpenAI/Stripe-style sk-, GitHub ghp_/gho_/ghs_, Slack xox*)
  { re: /\b(?:sk|pk|rk|ghp|gho|ghs|ghu|xox[bpas])[-_][A-Za-z0-9_-]{16,}\b/g, replacement: "[TOKEN]" },
  // Long unbroken base64-ish blobs (embedded images, signatures, keys)
  { re: /\b[A-Za-z0-9+/]{64,}={0,2}\b/g, replacement: "[BLOB]" },
  // Phone numbers: 10+ digits with separators, not part of a larger number/decimal
  { re: /(?<![\d.])\+?\d[\d ().-]{8,}\d(?![\d.])/g, replacement: "[PHONE]" },
];

export function scrubPii(text: string): string {
  return RULES.reduce((acc, rule) => acc.replace(rule.re, rule.replacement), text);
}

export function containsPii(text: string): boolean {
  return scrubPii(text) !== text;
}
