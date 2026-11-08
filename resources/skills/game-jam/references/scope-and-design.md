# Scope and design for a four-day jam

## Contents

- From theme to idea
- Sizing the scope
- What to build on each day
- Scoring against the judging criteria
- Cutting when time runs short

## From theme to idea

1. Translate the theme literally, then list two or three readings (literal, mechanical,
   emotional). Judges reward a "fresh, clever take", so the mechanical reading usually wins:
   the theme should change how the game plays, not only how it looks.
2. For each idea write one sentence: "The player [verb] to [goal], but [twist from the theme]."
3. For each idea name:
   - the core loop (what the player does every 10–30 seconds);
   - the one mechanic that carries the theme;
   - the win and lose conditions;
   - the first three things to cut.
4. The player picks. Write the sentence and the cut list at the top of `DevLog.md`.

Prefer ideas that work with Blueprints, one level and a fixed camera or a stock character.
They package without a C++ toolchain and leave time for feel and audio.

## Sizing the scope

| Team | Realistic scope |
| --- | --- |
| Solo, evenings only | One mechanic, one level, 2–5 minutes of play, menu + end screen |
| Solo, full days | One mechanic with 2–3 variations, one level with a difficulty ramp, 5–10 minutes |
| 2–3 people | Up to two connected mechanics, 2–3 short levels or one larger one |
| 4–5 people | Same as 2–3 people plus stronger art and audio; do not add more systems |

Anything that needs networking, save systems, procedural generation from scratch, or more
than one camera mode is a stretch goal, not the plan.

## What to build on each day

- **Day 1**: player control, the core mechanic, a win and a lose state, restart. Grey boxes.
  End the day by playing the loop start to finish.
- **Day 2**: main menu, end screen, the level blocked out to its final shape. Package. Create
  the itch page as a draft.
- **Day 3**: art pass on what the player sees most, feedback (hit effects, screen shake,
  sounds on every action), music, the English pass, a short tutorial or on-screen hints.
- **Day 4**: freeze features at noon. Bug fixing, balance, final package, video, dev log,
  upload, submit.

## Scoring against the judging criteria

| Criterion | Cheapest way to score |
| --- | --- |
| Theme | The theme visibly changes a rule of play; name it on the itch page |
| Fun factor | Short loop, quick restart, clear goal |
| Gameplay | Responsive controls; tune speed and timing on day 3 |
| Visuals | One consistent style (palette, one material family) beats many detailed assets |
| Level design | Guide the eye with light and layout; first 30 seconds teach the mechanic |
| Audio | A sound for every player action, music in menu and game, nothing silent |
| Ambition | Show in the dev log what agents made possible in four days |

## Cutting when time runs short

Cut in this order: extra levels → extra enemy or item types → cosmetic polish on rarely seen
things → secondary mechanics. Never cut: the win/lose loop, restart, the menu, audio on core
actions, the English pass, the package and the upload.
