---
name: build-design-system
description: Build a design system in the document - color and type tokens with light and dark values, and component masters - then verify it.
args:
  - name: brand
    description: Brand name, mood, or reference to base the system on (optional)
    required: false
user-invokable: true
---

Build a design system inside the open document. Work in this order. Do not skip a step.

## 1. Check what exists

Call `get_variables`. Note the tokens that are already there. Reuse them. Do not create a duplicate. Call `get_editor_state`. Its `components` list holds every component that is already defined. Reuse those keys.

## 2. Define the primitive tokens

Call `set_variables`. Put the raw values here.

- Colors: a neutral ramp and one brand ramp. Name them by step, for example `--neutral-900` and `--brand-500`.
- Type: font families, and a size scale.
- Shape: a radius scale and a spacing scale.

Do not use primitives directly in components.

## 3. Define the semantic tokens

Call `set_variables` again. Add role tokens, for example `--bg`, `--surface`, `--fg`, `--muted`, `--primary`, `--primary-fg`, `--border`. Give each one a light value, and a dark value in `themeValues`: `{"--bg": {"type": "color", "value": "#ffffff", "themeValues": {"dark": "#0b0b0b"}}}`. Components use only these role names.

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

Call `get_variables`. Check these points:

- Every role token has a light value and a dark value.
- The values are correct in both themes.

Read each master back with `read_embed_html`. Check these points:

- Each component has its slots and variants.
- No component contains a raw color, radius, or font name.

Fix any gap with `define_component` or `set_variables`.

## 6. Document (optional)

If the user wants a written summary, call `load_skill` with name `document` and follow it.

## Rules

- Tokens first. Components second. Screens last.
- Never put a hex value, a pixel radius, or a font name inside a component. Put it in a token.
- To use a component later, write `<c-KEY>` in embed HTML. Do not copy the master markup.
