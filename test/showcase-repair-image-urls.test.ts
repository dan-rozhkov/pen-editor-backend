import { describe, it, expect } from "vitest";
import { repairGeneratedImageUrls } from "../src/showcase/repairImageUrls.js";

const BASE = "https://s3.example.com/bucket/pen-editor";
const ISSUED = [
  `${BASE}/dbfc34e2-504b-406f-9ad1-e860af50a7f4.jpg`,
  `${BASE}/2dc28a06-7af3-446f-9af8-9d53a865463d.jpg`,
];

describe("repairGeneratedImageUrls", () => {
  it("snaps a one-character UUID typo back to the issued URL", () => {
    // Verbatim from the run that surfaced this: `…af50a7f4` came out `…af70a7f4`.
    const html = `<img src="${BASE}/dbfc34e2-504b-406f-9ad1-e860af70a7f4.jpg">`;
    const { html: repaired, repairs, unresolved } = repairGeneratedImageUrls(
      html,
      ISSUED,
    );

    expect(repaired).toBe(`<img src="${ISSUED[0]}">`);
    expect(repairs).toEqual([
      { from: `${BASE}/dbfc34e2-504b-406f-9ad1-e860af70a7f4.jpg`, to: ISSUED[0] },
    ]);
    expect(unresolved).toEqual([]);
  });

  it("repairs URLs inside CSS as well as img tags", () => {
    const html = `<div style="background-image:url('${BASE}/2dc28a06-7af3-446f-9af8-9d53a865463e.jpg')"></div>`;
    const { html: repaired, repairs } = repairGeneratedImageUrls(html, ISSUED);
    expect(repaired).toContain(ISSUED[1]);
    expect(repairs).toHaveLength(1);
  });

  it("leaves exact matches and foreign hosts alone", () => {
    const html =
      `<img src="${ISSUED[0]}">` +
      `<img src="https://picsum.photos/seed/movie6/200/300">` +
      `<link href="https://fonts.googleapis.com/css2?family=Outfit">`;
    const { html: repaired, repairs, unresolved } = repairGeneratedImageUrls(
      html,
      ISSUED,
    );
    expect(repaired).toBe(html);
    expect(repairs).toEqual([]);
    expect(unresolved).toEqual([]);
  });

  it("reports a wholly invented id instead of snapping it to an unrelated image", () => {
    const invented = `${BASE}/00000000-0000-0000-0000-000000000000.jpg`;
    const { html: repaired, repairs, unresolved } = repairGeneratedImageUrls(
      `<img src="${invented}">`,
      ISSUED,
    );
    expect(repaired).toContain(invented);
    expect(repairs).toEqual([]);
    expect(unresolved).toEqual([invented]);
  });

  it("is a no-op when no images were generated", () => {
    const html = `<img src="${BASE}/whatever.jpg">`;
    expect(repairGeneratedImageUrls(html, []).html).toBe(html);
  });
});
