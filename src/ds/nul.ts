// jsonb refuses U+0000 in any string or key. One walker over the real parsed
// value (not its JSON text: JSON.stringify writes a NUL as the six characters
// `\u0000`, and the literal text `\u0000` in a string looks the same to a
// substring check), shared by snapshot validation and the route's text fields.
export function containsNul(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === "string") {
      if (v.includes("\0")) return true;
    } else if (Array.isArray(v)) {
      stack.push(...v);
    } else if (v !== null && typeof v === "object") {
      for (const [key, child] of Object.entries(v)) {
        if (key.includes("\0")) return true;
        stack.push(child);
      }
    }
  }
  return false;
}
