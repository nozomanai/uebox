---
name: game-jam
description: Runs a time-boxed game jam entry in Unreal from theme to submission - scoping, a test package on day two, the English-only pass, the final zip, the 30-60 second gameplay video and the dev log. Use when the user says they are entering a game jam or the Epic AI MegaJam, gives a jam theme or deadline, or asks things like "参加 jam"、"MegaJam 怎么交"、"打包提交 itch"、"录一段玩法视频"、"检查还有没有中文"、"写开发日志". Do not use for ordinary feature work without a deadline, for publishing to a storefront, or for UEFN islands.
---

# Game jam entry

A jam is judged on a packaged build, a short video and sometimes a dev log — not on the
project folder. Everything below serves getting those three out before the deadline.

Rules, dates and the submission checklist for the 2026 Epic AI MegaJam:
`references/epic-ai-megajam-2026.md`. Read it whenever the user mentions MegaJam, Epic's jam
or itch.io submission.

## Quick Start

1. Ask for, or read from the conversation: theme, deadline (with time zone), team name,
   game name (English), solo or team. Write them at the top of `DevLog.md` in the project root.
2. Agree a one-sentence game and a core loop that can be played in under two minutes.
   Scope it so that day one ends with that loop playable, however ugly.
3. Work through the schedule below. Package on day two, not on the last day.

## Schedule

Scale the days to the jam length; the order does not change.

| When     | Goal                                                    | Tools                                                          |
| -------- | ------------------------------------------------------- | -------------------------------------------------------------- |
| Day 1    | Core loop playable in PIE                               | blueprint / C++ tools, `ue_playtest`, `ue_autoplay`            |
| Day 2    | **First packaged build** that starts and does not crash | `project_package` → `project_smoke_test` → `project_zip_build` |
| Day 3    | Content, feedback, audio, menus; **English pass**       | `project_find_non_english_text`, asset and audio tools         |
| Last day | Freeze features. Final package, zip, video, dev log     | `project_package`, `project_zip_build`, `record_gameplay_video` |

Building a whole game with several agents: use `/team`; the producer delivers against a
packaged build. `/goal` suits one long task with a checklist (for example "every string in
English").

## Workflow details

### Packaging (day two and last day)

1. Save everything in the editor — packaging reads assets from disk.
2. `project_package` with `configuration: Development` (that is what MegaJam asks for).
3. `project_smoke_test` on the returned exe. A build that does not start is not delivered.
4. `project_zip_build` with the team and game names. It drops `.pdb` files and reports the
   size; over 1 GB the user needs itch's `butler` or a smaller build.

### English pass

Run `project_find_non_english_text`. Fix everything in the "players can see" group first:
widget text, Text literals, DataTable text, subtitles, config lines such as the window title,
source string literals. The second group (asset names, material parameter names, pin
tooltips) does not reach the screen; rename only if time allows. Save, then run the tool again
until the first group is empty. Voice lines must be English as well — the tool cannot hear
audio, so list any voiced assets and ask the user.

### Gameplay video (30–60 s)

- Packaged build, human playing: `record_gameplay_video` with `exe_path`. Tell the user before
  calling that a window will open and they should play while it records.
- PIE, bot playing: call `record_gameplay_video` (no `exe_path`) and `ue_autoplay` in the same
  message so they run together. Use `start_delay_seconds` to skip loading.
- Gameplay must be on screen in the first five seconds. Without FFmpeg the file is webm; that
  uploads fine to YouTube and Bilibili.

### Dev log

Keep `DevLog.md` in the project root, in English, and append after every milestone:
what was built, which agents and models did which part, what broke and how it was fixed,
one screenshot path. Short entries as you go beat a long write-up at the end, and the
MegaJam "Glass Box" prize only accepts a dev log submitted with the game.

## Constraints

- Nothing of the game may be made before the jam starts. Prompts, skills, agent and MCP
  configuration may be prepared earlier but must be declared; keep the project in git so the
  history can be shown if asked.
- Third-party assets (Fab, marketplace) need a licence and must be listed in the submission.
- No trademarks or logos in the game except the Unreal Engine logo.
- Do not change engine version or major plugins mid-jam.

## Failure Handling

- Packaging fails: read the key errors in the tool result; the full UAT log path is there too.
  Fix the first error only, then package again.
- Smoke test fails: open the game log it names; a missing map or a startup crash usually means
  the default map or game mode in project settings points at something not cooked.
- Video is empty or black: the window was minimized or closed while recording.
- Deadline at risk: cut scope, never skip the final package and smoke test.

## Escalation

Stop and ask the user when the deadline is less than six hours away and the build still does
not package, or when a rule in the references is unclear for their case (eligibility, team
size, sourced assets). Do not guess rules.
