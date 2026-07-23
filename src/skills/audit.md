---
name: audit
description: Perform comprehensive audit of interface quality across accessibility, performance, theming, and responsive design. Generates detailed report of issues with severity ratings and recommendations.
args:
  - name: area
    description: The feature or area to audit (optional)
    required: false
user-invokable: true
---

Run systematic **technical** quality checks and generate a comprehensive report. Don't fix issues; document them for other commands to address.

This is a code-level, web-only audit, not a design critique.

## Diagnostic Scan

Run comprehensive checks across 5 dimensions. Score each dimension 0-4 using the criteria below.

### 1. Accessibility (A11y)

**Check for**:
- **Contrast issues**: Text contrast ratios < 4.5:1 (or 7:1 for AAA)
- **Motion sensitivity**: `prefers-reduced-motion` needs an intentional alternative that preserves state change and hierarchy; flag a global `0.01ms` kill that destroys useful feedback, flashing above threshold, or motion that blocks focus, reading, or task completion
- **Missing ARIA**: Interactive elements without proper roles, labels, or states
- **Keyboard navigation**: Missing focus indicators, illogical tab order, keyboard traps
- **Semantic HTML**: Improper heading hierarchy, missing landmarks, divs instead of buttons
- **Alt text**: Missing or poor image descriptions
- **Form issues**: Inputs without labels, poor error messaging, missing required indicators

**Score 0-4**: 0=Inaccessible (fails WCAG A), 1=Major gaps (few ARIA labels, no keyboard nav), 2=Partial (some a11y effort, significant gaps), 3=Good (WCAG AA mostly met, minor gaps), 4=Excellent (WCAG AA fully met, approaches AAA)

### 2. Performance

**Check for**:
- **Layout thrashing**: Reading/writing layout properties in loops
- **Expensive animations**: Casual layout-property animation, unbounded blur/filter/shadow effects, or effects that visibly drop frames
- **Missing optimization**: Images without lazy loading, unoptimized assets, missing will-change
- **Bundle size**: Unnecessary imports, unused dependencies
- **Render performance**: Unnecessary re-renders, missing memoization

**Score 0-4**: 0=Severe issues (layout thrash, unoptimized everything), 1=Major problems (no lazy loading, expensive animations), 2=Partial (some optimization, gaps remain), 3=Good (mostly optimized, minor improvements possible), 4=Excellent (fast, lean, well-optimized)

### 3. Theming

**Check for**:
- **Hard-coded colors**: Colors not using design tokens
- **Broken dark mode**: Missing dark mode variants, poor contrast in dark theme
- **Inconsistent tokens**: Using wrong tokens, mixing token types
- **Theme switching issues**: Values that don't update on theme change

**Score 0-4**: 0=No theming (hard-coded everything), 1=Minimal tokens (mostly hard-coded), 2=Partial (tokens exist but inconsistently used), 3=Good (tokens used, minor hard-coded values), 4=Excellent (full token system, dark mode works perfectly)

### 4. Responsive Design

**Check for**:
- **Fixed widths**: Hard-coded widths that break on mobile
- **Touch targets**: Interactive elements < 44x44px
- **Horizontal scroll**: Content overflow on narrow viewports
- **Text scaling**: Layouts that break when text size increases
- **Missing breakpoints**: No mobile/tablet variants

**Score 0-4**: 0=Desktop-only (breaks on mobile), 1=Major issues (some breakpoints, many failures), 2=Partial (works on mobile, rough edges), 3=Good (responsive, minor touch target or overflow issues), 4=Excellent (fluid, all viewports, proper touch targets)

### 5. Anti-Patterns / Implementation Integrity (CRITICAL)

Check against ALL the **DON'T** guidelines from the frontend-design skill: AI-slop tells (AI color palette, gradient text, glassmorphism, hero metrics, card grids, generic fonts) and general design anti-patterns (gray on color, nested cards, bounce easing, redundant copy). Also look for repeated implementation shortcuts, design-system drift (values reinvented instead of reused from tokens/components), misleading or decorative content standing in for real data, and structure that reads as interchangeable with an unrelated product. Keep verified findings separate from visual judgment and call out any false positives.

**Score 0-4**: 0=AI slop gallery / systemic drift (5+ tells), 1=Heavy AI aesthetic or major repeated failures (3-4 tells), 2=Some tells (1-2 noticeable), 3=Mostly clean (subtle issues only), 4=No AI tells, coherent and intentional

## Generate Report

### Audit Health Score

| # | Dimension | Score | Key Finding |
|---|-----------|-------|-------------|
| 1 | Accessibility | ? | [most critical a11y issue or "--"] |
| 2 | Performance | ? | |
| 3 | Responsive Design | ? | |
| 4 | Theming | ? | |
| 5 | Anti-Patterns / Implementation Integrity | ? | |
| **Total** | | **??/20** | **[Rating band]** |

**Rating bands**: 18-20 Excellent (minor polish), 14-17 Good (address weak dimensions), 10-13 Acceptable (significant work needed), 6-9 Poor (major overhaul), 0-5 Critical (fundamental issues)

### Anti-Patterns Verdict
**Start here.** Pass/fail: Does this look AI-generated, or express a coherent product-specific system? List specific tells and cite verified evidence. Be brutally honest.

### Executive Summary
- Audit Health Score: **??/20** ([rating band])
- Total issues found (count by severity: P0/P1/P2/P3)
- Top 3-5 critical issues
- Recommended next steps

### Detailed Findings by Severity

Tag every issue with **P0-P3 severity**:
- **P0 Blocking**: Prevents task completion. Fix immediately
- **P1 Major**: Significant difficulty or WCAG AA violation. Fix before release
- **P2 Minor**: Annoyance, workaround exists. Fix in next pass
- **P3 Polish**: Nice-to-fix, no real user impact. Fix if time permits

For each issue, document:
- **[P?] Issue name**
- **Location**: Component, file, line
- **Category**: Accessibility / Performance / Theming / Responsive / Anti-Pattern
- **Impact**: How it affects users
- **WCAG/Standard**: Which standard it violates (if applicable)
- **Recommendation**: How to fix it
- **Suggested command**: Which command to use (prefer: /adapt, /animate, /audit, /bolder, /clarify, /colorize, /critique, /delight, /distill, /document, /harden, /layout, /onboard, /optimize, /overdrive, /polish, /quieter, /shape, /typeset)

### Patterns & Systemic Issues

Identify recurring problems that indicate systemic gaps rather than one-off mistakes:
- "Hard-coded colors appear in 15+ components, should use design tokens"
- "Touch targets consistently too small (<44px) throughout mobile experience"

### Positive Findings

Note what's working well: good practices to maintain and replicate.

## Recommended Actions

List recommended commands in priority order (P0 first, then P1, then P2):

1. **[P?] `/command-name`**: Brief description (specific context from audit findings)
2. **[P?] `/command-name`**: Brief description (specific context)

**Rules**: Only recommend commands from: /adapt, /animate, /audit, /bolder, /clarify, /colorize, /critique, /delight, /distill, /document, /harden, /layout, /onboard, /optimize, /overdrive, /polish, /quieter, /shape, /typeset. Map findings to the most appropriate command. End with `/polish` as the final step if any fixes were recommended.

After presenting the summary, tell the user:

> You can ask me to run these one at a time, all at once, or in any order you prefer.
>
> Re-run `/audit` after fixes to see your score improve.

**IMPORTANT**: Be thorough but actionable. Too many P3 issues creates noise. Focus on what actually matters.

**NEVER**:
- Report issues without explaining impact (why does this matter?)
- Provide generic recommendations (be specific and actionable)
- Skip positive findings (celebrate what works)
- Forget to prioritize (everything can't be P0)
- Report false positives without verification

## Quality floor

**Verify**
- Contrast: body/placeholder text ≥4.5:1, large text ≥3:1; secondary text tinted from the surface hue, never generic gray.
- Depth: shadows need an offset plus soft blur; a zero-offset colored halo is not a shadow.
- Spacing: tight groups, generous separation between groups, more space above a heading than below it.
- Type: measure 65–75ch, tracking floor -0.04em (usually -0.02 to -0.03em reads better).
- Motion: one authored moment per surface, not decoration repeated on every section; `prefers-reduced-motion` has a real alternative.
- States: hover, disabled, loading, error, and empty states all exist and are real, not implied.
- Copy: honest, specific, in the product's own language — controls name their action, errors name problem + recovery.

**Refuse**
- Reporting an issue without impact, skipping positive findings, or flagging false positives without verification — an audit that can't distinguish real drift from stylistic taste is not actionable.

Full floor lives in the `frontend-design` skill.
