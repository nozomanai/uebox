# Craft: feel, level, look, sound

## Contents

- Game feel checklist
- The first 30 seconds
- Difficulty and pacing
- Level design in a jam
- Art direction on a budget
- Lighting and post process
- Audio list
- Playtesting

## Game feel checklist

Every player action needs feedback in at least two channels (sight, sound, motion). Go through
the core actions one by one with the player:

| Action | Feedback to add |
| --- | --- |
| Move | Responsive acceleration; footstep sounds; dust on landing |
| Jump | Short anticipation, landing squash or camera dip, landing sound; coyote time and jump buffering |
| Hit / damage dealt | Hit flash, small camera shake, hit-stop of 0.05–0.1 s, impact sound, particles |
| Damage taken | Screen-edge flash, knockback, distinct sound, brief invulnerability |
| Pickup | Pop scale, sparkle, rising pitch on streaks, UI counter bump |
| Win | Slow motion or freeze, music sting, big text, confetti |
| Lose | Short pause before the screen, sound, instant restart option |

Tune numbers with the player playing: change one value at a time and ask how it feels.

## The first 30 seconds

Judges play many entries; most decide in the first minute.

- Start in the game, not in a long intro. Main menu with Play as the default focus.
- Teach by doing: the first room asks for the core action once, safely.
- On-screen hints for controls (English), shown only until used.
- The theme should be felt in this first stretch.
- A clear goal on screen (timer, counter, objective line).

## Difficulty and pacing

- Ramp: teach → test → twist → climax. Each step adds one thing.
- Short sessions (2–10 minutes) with instant restart beat long ones.
- Err on the easy side; judges who fail quickly leave. Offer an easy mode if it is cheap.

## Level design in a jam

- Block out with grey boxes first, play it, then dress it.
- Guide the eye with light, colour and landmarks; put the goal in view early.
- Keep one level well-made rather than several thin ones.
- Kill zones and resets: no softlocks, no falling forever.

## Art direction on a budget

- Pick one style and write it in the design: palette (3–5 colours), shape language
  (round/sharp/blocky), material approach (flat colour, toon, realistic).
- Generated images and 3D props: generate several, keep only those that match the palette and
  style; recolour in materials if needed.
- Use the asset library (`library_search`) and licensed Fab assets for what generation does
  badly; list them as sourced assets.
- Consistency beats detail: simple shapes with good lighting look intentional.
- UI: one font, one accent colour, large readable text.

## Lighting and post process

- One clear key light (directional for outdoor, a few strong point/spot lights indoor), a fill,
  and sky light for ambient.
- A post process volume set to unbound: exposure fixed or clamped so the mood is stable, a
  little bloom, colour grading toward the palette, vignette.
- Fog (exponential height fog) adds depth cheaply.
- Lumen is fine on a strong PC; check the packaged build still runs smoothly on the player's
  machine.

## Audio list

Write this list with the player on day 2 and fill it on day 3:

- Music: menu loop, gameplay loop (60–120 s, seamless), win sting, lose sting.
- Player: footsteps, jump, land, hurt, death.
- Core mechanic: one sound per action, varied pitch for repeats.
- Pickups and UI: pickup, button hover, button click, counter tick.
- World: one ambient loop per area.
- Voice (optional, English only): short barks or narration via `generate_speech`.

Balance: music lower than effects; nothing clips; mute option in the menu if cheap.

## Playtesting

- Day 3: one person who has never seen the game plays it without help while the player watches
  silently. Note where they get stuck, what they ignore, when they smile.
- Fix the top three problems only.
- Day 4: one last full playthrough of the packaged build before uploading.
