# Third-party notices

The code in this repository is under the MIT License (see `LICENSE`), except for the files below. They are
derived from third-party work and stay under the terms of their original licenses.

## Impeccable design skills (Apache License 2.0)

The design-agent skills in `src/skills/` are adapted from Impeccable by Paul Bakaus
(https://github.com/pbakaus/impeccable, `skill/reference/`, tag `skill-v4.0.1` and earlier v3 releases).
They were rewritten as one self-contained file per skill and edited for this agent. The CLI and script
parts were removed.

Files: `adapt.md`, `animate.md`, `audit.md`, `bolder.md`, `clarify.md`, `colorize.md`, `craft.md`,
`critique.md`, `delight.md`, `distill.md`, `document.md`, `extract.md`, `harden.md`, `layout.md`,
`new-work.md`, `normalize.md`, `onboard.md`, `operate.md`, `optimize.md`, `overdrive.md`, `polish.md`,
`quieter.md`, `shape.md`, `teach-impeccable.md`, `typeset.md`, `visualize.md`, and the craft floor that is
inlined in `frontend-design.md`, `prototype.md` and `slides.md`.

License: Apache License 2.0, see `licenses/Apache-2.0.txt`.

## frontend-design skill (Apache License 2.0)

`src/skills/frontend-design.md` is based on Anthropic's frontend-design skill
(https://github.com/anthropics/skills/tree/main/skills/frontend-design), through Impeccable, and was
modified for this agent.

License: Apache License 2.0, see `licenses/Apache-2.0.txt`.

## pi (MIT)

`src/ai/retry.ts` ports the retry policy and error classifier of pi (https://github.com/earendil-works/pi,
`packages/ai/src/utils/retry.ts` and `packages/ai/src/utils/provider-retry.ts`).
Copyright (c) 2025 Mario Zechner. MIT License.

## Hermes Agent (MIT)

The memory character budgets in `src/ai/memory/types.ts` follow Hermes Agent
(https://github.com/NousResearch/hermes-agent). Copyright (c) 2025 Nous Research. MIT License.
