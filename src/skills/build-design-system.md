---
name: build-design-system
description: Build a design system in the document - tokens, themed aliases, and component masters - then verify and lint it.
args:
  - name: brand
    description: Brand name, mood, or reference to base the system on (optional)
    required: false
user-invokable: true
---

Build a design system inside the open document. Work in this order. Do not skip a step.

## 1. Check what exists

Call `get_design_system`. Note the tokens and components that are already there. Reuse them. Do not create a duplicate.

## 2. Define the primitive tokens

Call `set_variables`. Put raw values in one collection named `Primitives`. Use one mode.

- Colors: a neutral ramp and one brand ramp. Name them by step, for example `--neutral-900` and `--brand-500`.
- Type: font families, and a size scale.
- Shape: a radius scale and a spacing scale.

Do not use primitives directly in components.

## 3. Define the semantic aliases

Call `set_variables` again. Create a collection named `Theme` with the modes `light` and `dark`. Add semantic variables, for example `--bg`, `--surface`, `--fg`, `--muted`, `--primary`, `--primary-fg`, `--border`. Make each one an alias to a primitive: `"$--neutral-900"`. Give each mode its own target. Components use only these names.

## 4. Define the component masters

Call `define_component` once for each reusable element. Start with the elements that repeat most: button, input, card, badge.

- Use one root element with `data-c="KEY"`.
- Use a lowercase key such as `button`.
- Mark each slot with `data-c-slot="name"`. Put default content in the slot.
- Write each variant as a `data-v-<axis>="value"` attribute on the root. Pass the allowed values in `variants`.
- Use one `<style>` block. Start every selector with `[data-c="KEY"]`.
- Use `var(--token)` for every color, radius, and spacing value. Never write a raw value.
- Add a short `description`.

## 5. Verify

Call `get_design_system`. Check these points:

- Each component is listed with its slots and variants.
- `tokenUses` shows semantic tokens only.
- The values are correct in both Theme modes.

Fix any gap with `define_component` or `set_variables`.

## 6. Lint and fix

Call `lint_design`. Fix each finding. Then call `lint_design` again. Stop when it reports no findings, or only findings you can explain.

## 7. Document (optional)

If the user wants a written summary, call `load_skill` with name `document` and follow it.

## Rules

- Tokens first. Components second. Screens last.
- Never put a hex value, a pixel radius, or a font name inside a component. Put it in a token.
- To use a component later, write `<c-KEY>` in embed HTML. Do not copy the master markup.
