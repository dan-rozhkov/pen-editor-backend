import { describe, expect, it } from "vitest";
import { auditScreenHtml } from "../src/showcase/htmlAudit.js";

// A realistic clean mobile screen: Phosphor icons, organic (non-round)
// numbers, mixed timestamps, a tab bar drawn with real classes rather than
// hand-rolled chrome. Must produce zero findings — a false positive here is
// worse than a missed real defect.
const CLEAN_SCREEN = `<html><body>
<div class="screen">
  <div class="header"><span class="title">Wallet</span></div>
  <div class="card">
    <p>Balance</p>
    <p class="amount">$1,247.83</p>
  </div>
  <div class="list">
    <div class="row"><span>Groceries</span><span>-$42.19</span><span>3 hours ago</span></div>
    <div class="row"><span>Refund</span><span>+$18.50</span><span>Yesterday</span></div>
    <div class="row"><span>Paycheck</span><span>+$2,310.00</span><span>Just now</span></div>
  </div>
  <div class="stats">
    <span>+3.7%</span>
    <span>-1.2%</span>
  </div>
  <p>Welcome back, Alex Rivera. Your weekly summary is ready.</p>
  <button class="btn">Add funds</button>
  <a class="btn" href="#">See details</a>
  <div class="tabbar">
    <i class="ph ph-house"></i>
    <i class="ph ph-chart-line"></i>
    <i class="ph ph-user"></i>
  </div>
</div>
</body></html>`;

describe("auditScreenHtml", () => {
  it("finds nothing on a realistic clean screen", () => {
    expect(auditScreenHtml(CLEAN_SCREEN)).toEqual([]);
  });

  it("flags lorem ipsum copy", () => {
    expect(auditScreenHtml("<p>Lorem ipsum dolor sit amet</p>")).toContain(
      "lorem ipsum placeholder copy",
    );
  });

  it("does not flag copy without lorem", () => {
    expect(auditScreenHtml("<p>Welcome back to your dashboard</p>")).toEqual([]);
  });

  it("flags a generic persona name", () => {
    expect(auditScreenHtml("<p>Posted by John Doe</p>")).toContain(
      "generic persona name (e.g. John Doe, @username)",
    );
  });

  it("does not flag a plausible name", () => {
    expect(auditScreenHtml("<p>Posted by Alex Rivera</p>")).toEqual([]);
  });

  it("flags a placeholder company name", () => {
    expect(auditScreenHtml("<p>Powered by Acme Inc.</p>")).toContain(
      "placeholder company name (e.g. Acme, Globex)",
    );
  });

  it("does not flag an unrelated word containing a similar substring", () => {
    expect(auditScreenHtml("<p>We hookup great deals for techies</p>")).toEqual([]);
  });

  it("flags a placeholder email domain", () => {
    expect(auditScreenHtml("<p>Contact jane@example.com</p>")).toContain(
      "placeholder email address (example.com / @test.com)",
    );
  });

  it("does not flag a real-looking email domain", () => {
    expect(auditScreenHtml("<p>Contact support@myrealapp.com</p>")).toEqual([]);
  });

  it("flags a text node that is literally a UI-kit slot name", () => {
    expect(auditScreenHtml("<div><span>Placeholder</span></div>")).toContain(
      'literal placeholder label left in copy (e.g. "Placeholder", "Card title")',
    );
  });

  it("does not flag the word inside a longer real sentence", () => {
    expect(auditScreenHtml("<div><span>The Title of this book</span></div>")).toEqual([]);
  });

  it("does not flag legitimate single-word tab/field labels (Card, Title, Description)", () => {
    const html =
      "<nav><span>Home</span><span>Card</span><span>Activity</span></nav>" +
      "<form><label>Title</label><input/><label>Description</label><textarea></textarea></form>";
    expect(auditScreenHtml(html)).toEqual([]);
  });

  it("flags the two-word UI-kit template phrase 'Card title'", () => {
    expect(auditScreenHtml("<h3>Card title</h3>")).toContain(
      'literal placeholder label left in copy (e.g. "Placeholder", "Card title")',
    );
  });

  it("flags the same relative timestamp repeated 3+ times", () => {
    expect(
      auditScreenHtml("<div>2 hours ago</div><div>2 hours ago</div><div>2 hours ago</div>"),
    ).toContain('the timestamp "2 hours ago" repeats 3 times');
  });

  it("does not flag mixed timestamps appearing twice each", () => {
    expect(
      auditScreenHtml("<div>2 hours ago</div><div>2 hours ago</div><div>Yesterday</div>"),
    ).toEqual([]);
  });

  it("flags the same round-number metric repeated 3+ times", () => {
    expect(
      auditScreenHtml("<div>$100.00</div><div>$100.00</div><div>$100.00</div>"),
    ).toContain('the metric "$100.00" repeats 3 times');
  });

  it("does not flag organic, distinct amounts", () => {
    expect(
      auditScreenHtml("<div>$1,247.83</div><div>$842.10</div><div>$18.50</div>"),
    ).toEqual([]);
  });

  it("does not flag an organic amount that legitimately repeats (a split share)", () => {
    expect(
      auditScreenHtml("<div>$22.67</div><div>$22.67</div><div>$22.67</div>"),
    ).toEqual([]);
  });

  it("does not flag a percentage that legitimately repeats (a tip rate)", () => {
    expect(auditScreenHtml("<div>20%</div><div>20%</div><div>Tip 20%</div>")).toEqual([]);
  });

  it("flags a generic CTA reused across buttons", () => {
    expect(auditScreenHtml("<button>Submit</button><button>Submit</button>")).toContain(
      'generic CTA "Submit" used 2 times',
    );
  });

  it("does not flag a CTA used only once", () => {
    expect(auditScreenHtml("<button>Submit</button>")).toEqual([]);
  });

  it("flags emoji in visible copy", () => {
    expect(auditScreenHtml("<p>Great job! 🎉</p>")).toContain(
      "emoji used in UI copy instead of an icon",
    );
  });

  it("does not flag Phosphor icon markup as emoji", () => {
    expect(auditScreenHtml('<i class="ph ph-house"></i>')).toEqual([]);
  });

  it("flags emoji on repeated calls without the regex's lastIndex leaking between screens", () => {
    // A module-level regex with the `g` flag used via `.test()` advances its
    // own `.lastIndex` on a match; called on the same single-emoji string
    // twice in a row, screen 2 must still be flagged, not silently skipped
    // because screen 1 already consumed the match position.
    const html = "<p>Nice! 🎉</p>";
    expect(auditScreenHtml(html)).toContain("emoji used in UI copy instead of an icon");
    expect(auditScreenHtml(html)).toContain("emoji used in UI copy instead of an icon");
  });

  it("does not flag a copyright/trademark symbol as emoji", () => {
    expect(auditScreenHtml("<p>© 2026 Northwind. All rights reserved.</p>")).toEqual([]);
  });

  it("does not flag a trend arrow as emoji", () => {
    expect(auditScreenHtml("<div>+3.7% ↗</div>")).toEqual([]);
  });

  it("flags a fake status bar: clock token plus a status icon", () => {
    const html =
      '<div><span>09:41</span><i class="ph ph-cell-signal-full"></i></div>' +
      "<p>rest of a long screen with plenty of other content to pad out the lead-text window so the clock is measured within it, lots of words here to dilute the percentage further and further</p>";
    expect(auditScreenHtml(html)).toContain(
      "fake status bar (clock + signal/battery glyphs drawn into the screen)",
    );
  });

  it("does not flag a bare clock time with no status icons", () => {
    expect(
      auditScreenHtml("<div><span>10:30</span></div><p>no status icons anywhere here</p>"),
    ).toEqual([]);
  });

  it("does not flag a clock-shaped token whose only status icon is far below in the document", () => {
    const html =
      '<div class="header">Next class 9:30</div>' +
      '<div class="body">' +
      "content ".repeat(100) +
      "</div>" +
      '<div class="footer"><i class="ph ph-wifi"></i></div>';
    expect(auditScreenHtml(html)).toEqual([]);
  });

  it("flags a clock token paired with a status icon in the same top container", () => {
    const html =
      '<div class="status"><span>9:41</span><i class="ph ph-cell-signal-full"></i></div>' +
      "<p>rest of the screen padded out with enough words that the lead-text window used to locate the clock token comfortably contains it, since that window is a percentage of the total visible text length</p>";
    expect(auditScreenHtml(html)).toContain(
      "fake status bar (clock + signal/battery glyphs drawn into the screen)",
    );
  });

  it("flags wifi and battery icon classes clustered at the top of the screen", () => {
    const statusBar =
      '<div class="status"><span>9:41</span><i class="ph ph-wifi"></i><i class="ph ph-battery-full"></i></div>';
    const html = statusBar + '<div class="body">' + "content ".repeat(80) + "</div>";
    expect(auditScreenHtml(html)).toContain("fake status bar (wifi + battery cluster)");
  });

  it("does not flag a single status-style icon in a tab bar", () => {
    expect(auditScreenHtml('<i class="ph ph-wifi"></i>')).toEqual([]);
  });

  it("does not flag wifi and battery icons listed separately further down a settings screen", () => {
    const html =
      '<div class="header">' +
      "Settings ".repeat(60) +
      "</div>" +
      '<ul><li>Wi-Fi <i class="ph ph-wifi"></i></li>' +
      "<li>" +
      "x".repeat(500) +
      "</li>" +
      '<li>Battery <i class="ph ph-battery-full"></i></li></ul>';
    expect(auditScreenHtml(html)).toEqual([]);
  });

  it("flags a pill-shaped element sized like the home indicator", () => {
    const html =
      '<div style="width:134px;height:5px;border-radius:9999px;position:absolute;bottom:8px"></div>';
    expect(auditScreenHtml(html)).toContain("fake home indicator drawn as a pill bar");
  });

  it("also catches the home-indicator shape via a CSS rule, not just inline style", () => {
    const html =
      '<style>.home{position:absolute;bottom:8px;left:128px;width:134px;height:5px;border-radius:999px}</style><div class="home"></div>';
    expect(auditScreenHtml(html)).toContain("fake home indicator drawn as a pill bar");
  });

  it("does not flag an ordinary rounded pill button", () => {
    const html = '<button style="border-radius:9999px;height:44px;width:160px">Add</button>';
    expect(auditScreenHtml(html)).toEqual([]);
  });

  it("does not flag a fully-rounded progress-bar track with no position/bottom offset", () => {
    const html = '<style>.track{width:140px;height:4px;border-radius:999px}</style><div class="track"></div>';
    expect(auditScreenHtml(html)).toEqual([]);
  });

  it("flags a top-level wrapper drawn as the phone bezel", () => {
    const html = '<div style="width:390px;height:844px;border-radius:40px"></div>';
    expect(auditScreenHtml(html)).toContain("phone bezel drawn around the screen");
  });

  it("does not flag a device-sized box without heavy corner rounding", () => {
    const html = '<div style="width:390px;height:844px;border-radius:0"></div>';
    expect(auditScreenHtml(html)).toEqual([]);
  });

  it("does not flag trigger words inside a direction-contract HTML comment", () => {
    const html =
      "<!-- THESIS: list -> item. never lorem, not John Doe --><p>hi</p>";
    expect(auditScreenHtml(html)).toEqual([]);
  });

  it("dedupes repeated findings into a single note", () => {
    const html = "<p>lorem ipsum</p><p>more lorem text here</p>";
    const notes = auditScreenHtml(html);
    expect(notes.filter((n) => n === "lorem ipsum placeholder copy")).toHaveLength(1);
  });
});
