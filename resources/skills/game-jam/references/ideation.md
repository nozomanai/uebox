# Ideation and design

## Contents

- Reading the theme
- Brainstorming fast
- Scoring and choosing
- The one-page design
- Scope tiers
- What to build on each day
- Scoring against the judging criteria
- Cutting when time runs short

## Reading the theme

1. Literal translation, then two or three readings:
   - **Mechanical** — the theme becomes a rule of play (a theme like "Out of Control" becomes
     controls that drift, or a character you steer only indirectly).
   - **Narrative** — the theme is what the story is about.
   - **Aesthetic** — the theme is how it looks and sounds.
2. Judges reward a "fresh, clever take". The mechanical reading usually scores best because the
   player feels the theme instead of reading about it. The strongest entries combine a
   mechanical reading with a matching look.
3. Watch for the obvious reading: if the first idea is what most entrants will do, keep it as a
   fallback and push for one more twist.

## Brainstorming fast (20–30 minutes)

Generate 6–10 ideas before judging any of them. Prompts that work:

- **Verb first**: list verbs that fit the theme (push, hide, merge, rewind, grow, split). For each
  verb, what game makes that verb the core action?
- **Flip a genre**: take a familiar genre (platformer, tower defense, stealth, racing) and change
  one rule with the theme.
- **Constraint**: one button only, no jumping, the player is the obstacle, everything shrinks.
- **Combine**: two small mechanics that interact through the theme.
- **Feeling first**: what should the player feel at the end (tense, clever, cozy, chaotic)?

Write each idea as: "The player [verb] to [goal], but [twist from the theme]."

## Scoring and choosing

Score each idea 1–5 on four axes, then talk through the top three with the player:

| Axis | Question |
| --- | --- |
| Theme | Would a judge see the theme within 30 seconds of play? |
| Fun | Is the core action satisfying on its own, even with grey boxes? |
| Feasibility | Can the core loop be playable by the end of day 1 with this team? |
| Originality | Is it more than a reskin of a known game or the template? |

Prefer feasibility when the player is new or short on time; prefer originality when the team is
strong. Prefer ideas that work with Blueprints, one level and a stock character or a fixed
camera — they package without a C++ toolchain and leave time for feel and audio.

## The one-page design

Write this into `DevLog.md` right after choosing, in English (it doubles as dev-log material):

```
## Design
Pitch: The player <verb> to <goal>, but <twist>.
Theme take: <how the theme changes the rules>
Core loop (10–30 s): <what the player does again and again>
Controls: <keys / mouse / gamepad>
Win / lose: <conditions>; restart: <how>
Session length: <minutes>
Look: <style in one line, palette, references>
Sound: <mood, music style, key sound effects>
Must-have: <the smallest version that is a game>
Should-have: <what makes it good>
Nice-to-have: <only if ahead of schedule>
Cut first: <ordered list>
```

## Scope tiers

- **Must-have** — the loop, controls, win/lose, restart, a menu, an end screen. Day 1–2.
- **Should-have** — feedback and juice, a difficulty ramp, art pass, music and sound on every
  action, onboarding. Day 3.
- **Nice-to-have** — extra levels, extra enemy or item types, cosmetic extras. Only if day 3 ends
  ahead.

Anything with networking, save systems, procedural generation from scratch, or more than one
camera mode is nice-to-have at best.

## What to build on each day

- **Day 1**: player control, the core mechanic, a win and a lose state, restart. Grey boxes. End
  by playing the loop start to finish.
- **Day 2**: main menu, end screen, the level in its final shape (still simple). Package. Create
  the itch page as a draft.
- **Day 3**: everything in `craft.md` on what the player sees most; music and sound; the English
  pass; one playtest with someone who has never seen the game.
- **Day 4**: freeze features at noon. Bug fixing, balance, final package, video, dev log,
  upload, submit.

## Scoring against the judging criteria

| Criterion | Cheapest way to score |
| --- | --- |
| Ambition and innovation | One unexpected rule; say in the dev log what agents made possible |
| Theme | The theme changes a rule of play; name it on the itch page |
| Fun factor | Short loop, instant restart, clear goal, a moment that makes people laugh or gasp |
| Gameplay | Responsive controls; tune speed, timing and forgiveness on day 3 |
| Visuals | One consistent style beats many detailed assets |
| Level design and progression | First 30 seconds teach the mechanic; then raise the stakes |
| Audio | A sound for every player action, music in menu and game, nothing silent |

## Cutting when time runs short

Cut in this order: nice-to-have → extra levels → extra enemy or item types → cosmetic polish on
rarely seen things → secondary mechanics. Never cut: the win/lose loop, restart, the menu, sound
on core actions, the English pass, the package and the upload.
