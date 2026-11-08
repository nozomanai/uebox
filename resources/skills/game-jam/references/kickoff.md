# Kickoff: getting the player started

## Contents

- The interview
- Choosing a jam style
- Scope tiers by available time
- The personal timetable
- Setting up the jam project
- The warm-up run
- What to have ready before the theme

## The interview

Ask in one message, short and friendly, so the player can answer in one go:

1. How much have you used Unreal before? (never / tutorials / shipped something / work with it daily)
2. Solo or team? If a team: how many, who does what.
3. How many hours a day can you put in between 11-12 13:00 and 11-16 09:59 (Beijing)?
4. What are you good at, and what do you want the AI to carry? (code, art, design, audio, writing)
5. Which UE version is installed, and is the PC comfortable with Lumen and Nanite?

If the player already answered some of these, do not ask again. If they skip questions, assume
the cautious answer (beginner, solo, 4 hours a day).

## Choosing a jam style

Match the plan to the player, then say why in one sentence.

| Player | Style | Why |
| --- | --- | --- |
| New to UE | Template-based, Blueprint only, one level, fixed or third-person camera | The template gives a working character and camera on hour one |
| Comfortable with UE, solo | One strong mechanic, stylized art, heavy use of generated audio and art | Time goes into feel instead of systems |
| Programmer, weak at art | Simple shapes plus one strong palette, lighting and post process doing the art | A consistent look scores better than detailed assets |
| Artist, weak at code | The agent builds all logic in Blueprints; the player owns look, level and feel | Logic is where the agent saves the most time |
| Team of 2–5 | Split by area (see `teamwork.md`), one person owns the build and the submission | Avoids asset conflicts and the last-hour scramble |
| Wants to win Glass Box | Same as above, plus a dev-log entry after every session from day one | The log cannot be written well at the end |

Templates to suggest (`project_manage` with `list_templates` shows what is installed):
Third Person for action and exploration, First Person for puzzle and horror, Top Down for
strategy and twin-stick, Blank for anything with its own camera. The template is only the
starting point — the rules require gameplay beyond it.

## Scope tiers by available time

| Total hours across the jam | Aim for |
| --- | --- |
| Under 12 | One mechanic, one small level, 2–3 minutes of play |
| 12–25 | One mechanic with 2–3 variations, one level with a ramp, 5 minutes |
| 25–40 | Two connected mechanics, 2–3 short levels or one larger one, 10 minutes |
| Team, 40+ | Same as above with stronger art and audio — not more systems |

## The personal timetable

Write it into `DevLog.md` under "Plan". Use real Beijing dates and the player's hours.
Template for an evening-only player:

```
11-12  13:00 theme read (done in the morning) / 19:00–23:00 core loop in grey boxes
11-13  19:00–23:00 menu, end screen, level block-out, first package, itch draft
11-14  19:00–23:00 feel, art, audio, English pass, one outside playtest
11-15  all day if possible: freeze at 12:00, bugs, final package, video, dev log
11-16  07:00–09:00 upload and submit — never later
```

For a full-time player, give each day a morning goal and an afternoon goal, and keep evenings
for playtesting and the dev log. Plan sleep in; the last night is not for features.

## Setting up the jam project

1. `project_manage` with `list_templates`, then `create_project` with the chosen template, a
   short English project name and the UE version the player uses.
2. Open it (`project_manage` with `open_project`); accept the UnrealAgentLink plugin install.
3. Ask the editor how many lights the level has. A number back means the link works; if not,
   see `troubleshooting.md`.
4. Git: initialise a repository with a standard Unreal `.gitignore` (Binaries,
   DerivedDataCache, Intermediate, Saved, `.vs`), and Git LFS for `.uasset` and `.umap` if the
   team shares the project. Offer to do it with the player's consent; commit the empty project.
5. Create `DevLog.md` in the project root (skeleton in `submission.md`) and fill Team, Tools
   and Plan.

## The warm-up run

Before the jam starts, spend about an hour on a throwaway practice game — for example "collect
five glowing orbs in 60 seconds" on the template level. Goals:

1. Learn the request pattern from `working-with-ue-box.md`: one feature, check it, next.
2. Make the player play every step, so they get used to judging feel.
3. Run the full pipeline once: `project_package` → `project_smoke_test` →
   `project_zip_build` → `record_gameplay_video` → `project_find_non_english_text`.
   The first package is slow and shows missing toolchains early.
4. Write one practice dev-log entry.

Then delete the practice content (or use a separate project) and note in the dev log that the
warm-up project was thrown away. Nothing of the jam game may exist before 11-12 13:00.

## What to have ready before the theme

- Jam project created, linked, packaged once, in git.
- Model working; the MegaJam plan claimed if the player wants it.
- Every team member joined the jam on itch.io with their own account.
- Tools declaration drafted (`submission.md`).
- A list of the player's favourite free assets on Fab, if they plan to use any (licences noted).
- Sleep before 03:00 or watch the theme reveal and sleep after — decide in advance.
