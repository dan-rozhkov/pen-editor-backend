// Screens come back with image URLs the model typed out by hand, and the ones
// generate_image hands it are random UUIDs — 36 characters the model has to
// reproduce byte-for-byte inside a much larger HTML blob. It doesn't always:
// a real run produced `…e860af50a7f4.jpg` as `…e860af70a7f4.jpg`, one character
// off, which is a 403 from S3 and a broken <img> in the showcase.
//
// Rather than trusting the transcription, this repairs it: any URL that points
// at the same directory as an issued one but isn't an exact match is snapped to
// the nearest issued URL, as long as it's near enough to be a transcription
// slip rather than a different image.

// Max edit distance still treated as a typo. A UUID is 36 chars; a handful of
// wrong characters is a slip, while a wholly invented id lands far past this
// and is left alone (and logged) instead of being snapped to an unrelated
// image.
const MAX_TYPO_DISTANCE = 6;

function levenshtein(a: string, b: string, limit: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      curr.push(value);
      if (value < rowMin) rowMin = value;
    }
    // Every future row can only grow, so once the whole row is past the limit
    // the answer is too — bail instead of finishing the matrix.
    if (rowMin > limit) return limit + 1;
    prev = curr;
  }
  return prev[b.length];
}

function directoryOf(url: string): string {
  return url.slice(0, url.lastIndexOf("/") + 1);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface RepairResult {
  html: string;
  repairs: Array<{ from: string; to: string }>;
  unresolved: string[];
}

// `issued` is every URL generate_image actually returned during this run.
export function repairGeneratedImageUrls(
  html: string,
  issued: string[],
): RepairResult {
  const repairs: RepairResult["repairs"] = [];
  const unresolved: string[] = [];
  if (issued.length === 0) return { html, repairs, unresolved };

  const known = new Set(issued);
  const directories = [...new Set(issued.map(directoryOf))];
  // Only URLs under a directory we uploaded to are candidates — picsum links,
  // fonts and icon CDNs are none of this function's business.
  const pattern = new RegExp(
    `(?:${directories.map(escapeRegExp).join("|")})[A-Za-z0-9._%-]+`,
    "g",
  );

  const repaired = html.replace(pattern, (match) => {
    if (known.has(match)) return match;

    let best: string | undefined;
    let bestDistance = MAX_TYPO_DISTANCE + 1;
    for (const candidate of issued) {
      const distance = levenshtein(match, candidate, bestDistance);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }

    if (!best || bestDistance > MAX_TYPO_DISTANCE) {
      unresolved.push(match);
      return match;
    }
    repairs.push({ from: match, to: best });
    return best;
  });

  return { html: repaired, repairs, unresolved };
}
