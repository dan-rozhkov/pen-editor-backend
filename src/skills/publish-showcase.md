---
name: publish-showcase
description: Publish screens the user made on the canvas to the public showcase gallery at "/", using the publish_to_showcase tool.
user-invokable: true
---

## When to use this

The user asks to put screens they made in the editor onto the showcase / main
page ("выложи эти экраны на витрину", "put this on the showcase", "add this
to the gallery"). **Never call `publish_to_showcase` on your own initiative —
the gallery is public.** On a vague ask ("put it on the showcase"), confirm
which screens and under what app name *before* publishing.

## 1. Publishing is public and effectively permanent

There is no unpublish tool available to you. Removing an app requires the
operator to run `npm run showcase:delete` by hand. If the user seems unsure,
say this plainly before you publish, not after.

## 2. Pick the screens

1. Read the canvas first — `get_editor_state` and/or `batch_get` — to find
   the frames/embeds that make up the flow the user means.
2. Select the screens forming **one app's flow**, in reading order, **at most
   5**.
3. Never mix screens from different apps into one call — that's separate
   calls, since one call produces one gallery card. If the user points at
   screens from two different flows, ask which app they mean, or offer to
   publish each as its own app.

## 3. Size is a hard requirement

- Mobile screens must be exactly **390x844**.
- Desktop screens must be exactly **1440x1024**.

Any other size is rejected by the tool outright — it does not resize or crop
for you. If a screen is the wrong size, resize or rebuild it on the canvas
first, then publish.

## 4. Titles and cover

Give each screen a short, human title — "Onboarding", "Cart", "Checkout" —
never a raw layer name like "Frame 12". Mark exactly one screen `cover:
true`: the most representative screen, since it becomes the app's card image
in the gallery grid.

## 5. Call the tool

```
publish_to_showcase({
  theme: "Habit tracker",
  prompt: "A minimal daily habit tracker with streaks.",
  platform: "mobile",
  screens: [
    { nodeId: "<id>", title: "Onboarding", cover: true },
    { nodeId: "<id>", title: "Today" },
  ],
})
```

After a successful call, tell the user the app name and which screens were
published.

## 6. Failure handling

The tool returns a plain error string — read it and act on it:

- A size-mismatch error means fix the screen (see step 3) and try again.
- A 409 ("already in progress") means another publish is running — wait a
  moment and retry once.
- A 503 means the server has no storage/database configured (or publishing
  is disabled on this deployment) — you cannot fix this; tell the user
  publishing is unavailable right now.
- A 502 means the publish failed **partway through** — it is NOT atomic, so
  some of the screens in this call may already be live on the public gallery
  as a truncated app. **Do not retry** — a retry succeeding produces a
  second, complete card next to the broken one instead of fixing it. Read
  the `runId` out of the error response and tell the user: publishing failed
  partway (name which screens if known) and the partial app needs an
  operator to run `npm run showcase:delete --app <runId>` to remove it
  before trying again.

Never retry in a loop.
