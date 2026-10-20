// Unbiased estimators from "Demystifying evals for AI agents".
// pass@k = 1 - C(n-c, k) / C(n, k);  pass^k = C(c, k) / C(n, k)  (null when n < k or n = 0: not estimable).

/** C(n, k) as a float, computed as a product to avoid factorial overflow. */
export function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  const kk = Math.min(k, n - k);
  let result = 1;
  for (let i = 1; i <= kk; i++) result = (result * (n - kk + i)) / i;
  return result;
}

export function passAtK(n: number, c: number, k: number): number | null {
  if (n < k || n === 0) return null;
  return 1 - choose(n - c, k) / choose(n, k);
}

export function passPowK(n: number, c: number, k: number): number | null {
  if (n < k || n === 0) return null;
  return choose(c, k) / choose(n, k);
}

/** Mean over the measurable (non-null) values; null entries are excluded, none left gives 0. */
export function meanDefined(values: Array<number | null>): number | null {
  const defined = values.filter((v): v is number => v !== null);
  return defined.length === 0 ? null : mean(defined);
}

export function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}
