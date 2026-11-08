# Submitting on itch.io

## Contents

- Create the itch page (day two)
- A page that sells
- Upload the build
- Plan the video
- Host the video
- The jam submission form
- Declaration of tools prepared before the jam
- Sourced assets list
- Dev log skeleton
- Final checklist

## Create the itch page (day two)

1. itch.io → Dashboard → Create new project.
2. Title: the English game name. Kind of project: Downloadable. Classification: Games.
3. Visibility: Draft until the build is ready, then Public (judges must be able to open it).
4. Short description and the page text in English: one-sentence pitch, controls, how the theme
   is used, credits (team, tools), sourced assets.
5. Add 3–5 screenshots (`ue_screenshot` from gameplay) and the video link.

## A page that sells

Judges open many pages; the page decides whether they download.

- Cover image 630×500: the game's best moment, the title readable at small size. Generate a
  base with `generate_image` from a real screenshot, keep the real game recognisable.
- First line: the one-sentence pitch, then the theme take in one line.
- Controls in a small table.
- 3–5 screenshots from real gameplay (`ue_screenshot`), the video embedded near the top.
- Credits: team and roles, tools (UE Box and models), sourced assets with licences.
- Known issues, if any, in one honest line.

## Upload the build

- Zip from `project_zip_build`, named `TeamName_GameName.zip`, under 1 GB.
- Under 1 GB: upload in the browser on the project's edit page, tick "Windows" for the file.
  Upload hours before the deadline; large uploads from China can be slow or stall — retry on a
  stable connection.
- Over 1 GB: first try to shrink the build (see `troubleshooting.md`). Otherwise use itch's
  butler or the Blendo Itch Uploader. butler steps for the player:
  1. Download butler from itch.io (itch.io/docs/butler), unzip it, run `butler login` once.
  2. `butler push TeamName_GameName.zip username/game-slug:windows`
  Offer to run these for the player only if they ask.

## Plan the video

30–60 seconds, planned with the player before recording:

| Time | Shot |
| --- | --- |
| 0–5 s | Gameplay straight away — the core action, no logo screen |
| 5–20 s | The theme mechanic in action, the moment that explains the game |
| 20–40 s | Escalation: the hardest or most spectacular part |
| 40–55 s | The ending or a win, then the title card |

Record several takes with `record_gameplay_video`, pick the best. If the player wants cuts or
a title card, a simple editor is enough; keep the music from the game. No other trademarks or
logos in the video.

## Host the video

The rules ask for a video link. Pick a host judges outside China can open:

- YouTube (unlisted is fine) — safest for judges.
- Bilibili — opens abroad but can be slow; acceptable if YouTube is unavailable.
- Also embed or attach the video on the itch page so it is reachable from the entry itself.

Check before submitting: the link opens in a private browser window without logging in.

## The jam submission form

On the jam page → Submit your project → choose the itch project, then fill in English:

```
Team name: <Team>
Members:
- <Full name> — <email of their Epic Games account> (Team Owner)
- <Full name> — <email of their Epic Games account>
Game name: <Game>
Gameplay video (30–60 s): <link>
Dev log: <link to DevLog page or itch devlog post>
Sourced assets: <list, or "None">
Tools prepared before the jam: <see declaration below>
```

## Declaration of tools prepared before the jam

```
Prepared before the jam (allowed by the Official Rules, declared here):
- UE Box <version> (open-source AI agent for Unreal Editor) and its built-in skills,
  including the game-jam skill.
- AI models used through UE Box: <providers / plans>.
- MCP configuration for <Claude Code / Codex>, if used.
- Prompt libraries or scripts written before Nov 12: <list, or "None">.
All gameplay, levels and art were created during the jam period. Git history is available on
request.
```

## Sourced assets list

```
Sourced assets (not made by the team):
- <Asset name> — <source, e.g. Fab> — <licence>
AI-generated content made during the jam is not listed here.
```

## Dev log skeleton

Keep `DevLog.md` in the project root and publish it as an itch devlog post or a page linked
from the entry.

```
# <Game> — Dev Log (2026 Epic AI MegaJam)

Team: <names and roles>
Theme: <theme> — our take: <one sentence>
Tools: UE Box <version>, <models>, <other tools>

## Day 1 — <date>
- Built: ...
- Agents did: ... / We did: ...
- Broke and fixed: ...
- Screenshot: <path>

## Day 2 — ...

## What AI changed for us
- What took minutes instead of hours.
- Where we had to take over and why.
```

## Final checklist

- [ ] `project_smoke_test` passed on the final build.
- [ ] `project_find_non_english_text` shows nothing players can see; voice lines are English.
- [ ] Zip named `TeamName_GameName`, under 1 GB, uploaded and marked Windows.
- [ ] itch page public, English, screenshots, video embedded.
- [ ] Video 30–60 s, gameplay in the first five seconds, link opens without login.
- [ ] Form filled in English with every member's Epic email and the Team Owner.
- [ ] Sourced assets and tools prepared before the jam declared.
- [ ] Submitted before 2026-11-16 09:59 Beijing time; the entry appears on the jam page.
