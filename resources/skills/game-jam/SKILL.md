---
name: game-jam
description: Guides a player through a time-boxed Unreal game jam with UE Box from start to finish, with the 2026 Epic AI MegaJam as the main case - eligibility and setup, claiming the MegaJam plan, turning the theme into a four-day scope, the daily build plan, a test package on day two, the English-only pass, the final zip, the 30-60 second gameplay video, the dev log, the itch.io submission and the declaration of tools prepared before the jam. Use when the user says they are entering or preparing for a game jam or the Epic AI MegaJam, gives a jam theme or deadline, or asks things like "参加 MegaJam"、"比赛怎么准备"、"主题出来了做什么"、"今天该做什么"、"打包提交 itch"、"录一段玩法视频"、"检查还有没有中文"、"写开发日志"、"怎么填提交表"、"来得及吗". Do not use for ordinary feature work without a deadline, for publishing to a storefront, or for UEFN islands.
---

# Game jam with UE Box

A jam entry is judged on a packaged build, a short video and sometimes a dev log — not on the
project folder. This skill keeps the player on a schedule that ends with all three submitted
before the deadline, and routes each piece of work to the right tools.

Read these when the stage calls for them:

- Rules, dates, prizes and the claim flow for the 2026 Epic AI MegaJam:
  `references/epic-ai-megajam-2026.md`. Read it at the first mention of MegaJam, Epic's jam,
  eligibility, prizes or the deadline.
- Turning a theme into a scope that fits four days, and what the judges score:
  `references/scope-and-design.md`. Read it on theme day and whenever the plan starts slipping.
- itch.io page, upload, the submission form, the declaration and the dev log skeleton, all in
  English: `references/submission.md`. Read it on day two (to create the page early) and on the
  last day.
- Things that go wrong (editor not connecting, packaging errors, oversized builds, empty videos,
  plan quota): `references/troubleshooting.md`. Read it as soon as any step fails.

## How to talk to the player

- Speak the player's language (usually Chinese). Everything that ships — game text, voice,
  video, submission form, dev log — must be English; draft those in English.
- State times in Beijing time and say how much time is left whenever you plan or re-plan.
  The MegaJam deadline is **2026-11-16 09:59 Beijing time** (11-15 5:59 PM PST). People misread it
  as the evening of the 15th or the 16th; say "16 日早上 9:59" explicitly.
- Ask before deciding anything about the game itself: genre, look, mechanics. Propose, then build
  what the player picks.
- Do not promise that the AI makes the whole game alone. The player decides what is fun; the
  tools do the heavy lifting.

## Stage 0 — Before the jam starts (until 11-12 13:00)

Nothing of the game may be made before the start. Setup is allowed and expected.

1. **Eligibility** (see the reference): 18+, own Epic account that is not a cabined account,
   everything in English, Unreal Engine or UEFN but not both. Every team member joins the jam
   with their own itch.io account.
2. **Box version**: UE Box 1.0.12 or later. Older versions cannot claim the MegaJam plan.
3. **Model**: Settings → Models. Either the player's own provider, or Box Plan:
   Settings → Models → Box Plan → Connect, then fill the itch.io profile in the
   "MegaJam 激励套餐" row and press Claim. The plan lasts 7 days and covers the jam.
4. **Project**: make an empty UE 5.x project for the jam (Blueprint template unless the player
   writes C++ daily). Project library → Import → install the UnrealAgentLink plugin → Open.
   Check the link by asking how many lights the level has; a number back means it works.
5. **Git**: initialise a repository in the project folder now. Epic may ask for history to
   verify nothing was built early; it also makes risky changes reversible.
6. **Rehearse the pipeline once on the empty project**: `project_package` →
   `project_smoke_test` → `project_zip_build`. A first package takes long and is where missing
   toolchains surface — find out now, not on day four. See `references/troubleshooting.md` if it
   fails.
7. **Optional**: Settings → MCP → "写入 Claude Code" / "写入 Codex" if the player also works
   in those clients.
8. Start `DevLog.md` in the project root (skeleton in `references/submission.md`) and note the
   tools prepared before the jam — they must be declared.

## Stage 1 — Theme day (theme at 11-12 03:00, start at 13:00)

1. Read the theme with the player. Give the literal translation and one or two readings.
2. Use `references/scope-and-design.md`: three one-sentence game ideas, each with its core
   loop, the one mechanic that carries the theme, and what gets cut first. The player picks one.
3. Write the one-sentence game and the cut list at the top of `DevLog.md`.
4. Decide solo or `/team`. `/team` runs several agents under a producer and suits a bigger
   scope; it is the most expensive mode, so watch the plan quota. One agent with `/goal`
   suits a single long task with a checklist.

## Stage 2 — The build (schedule)

Scale the days if the player starts late; the order does not change.

| When (Beijing) | Goal | Done when |
| --- | --- | --- |
| Day 1 (11-12) | Core loop playable in PIE, grey boxes are fine | The player can start, play the loop once and reach a win or lose state |
| Day 2 (11-13) | **First packaged build**; itch page created as draft | `project_smoke_test` passes on the packaged exe |
| Day 3 (11-14) | Content, feedback, audio, menus; **English pass** | `project_find_non_english_text` lists nothing players can see |
| Day 4 (11-15) | **Feature freeze at noon**; polish, final package, video, dev log | Zip, video link and dev log ready by the evening |
| 11-16 before 09:59 | Submit | itch shows the entry in the jam |

At the start of every session: read `DevLog.md`, say the time left, say today's goal, and ask
what the player wants to tackle first.

### Routing work to tools

| Work | Use |
| --- | --- |
| Gameplay logic | `ue-blueprint-graph-editing` skill (Blueprints); `ue-cpp-workflow` only if the project already has C++ |
| HUD, menus, end screen | `ue-widget-umg-layout` skill (`widget_create`, `widget_add_child`, `widget_set_property`) |
| Placing and arranging the level | `ue-actor-placement` and `ue-level-organize` skills |
| Materials, look | `ue-material-authoring` skill |
| Concept art, textures, UI images | `image-generation` skill (`generate_image`) |
| 3D props and characters | `ai-3d-asset-production` skill (`generate_3d_model`, `rig_3d_model`) |
| Sound effects | `sound-effects` skill (`generate_sound_effect`) |
| Music | `generate_task_music` |
| Voice lines (English) | `generate_speech`; `design_voice` for a character voice |
| Data tables (enemy stats, levels) | `ue_datatable_describe`, `ue_datatable_edit` |
| Testing that it runs | `ue_playtest`; `ue_autoplay` to have a bot walk, jump and press inputs |
| Something slow or broken in the editor | `ue-system-diagnostics` skill |

Save after every working change (`ue_save`), and commit to git at every milestone.

### Packaging (day two, last day, and after any big change)

1. Save everything — packaging reads assets from disk.
2. `project_package` with `configuration: Development` (MegaJam asks for a Development build).
3. `project_smoke_test` on the returned exe. A build that does not start is not delivered.
4. `project_zip_build` with the team and game names in English. It drops `.pdb` files and
   reports the size. Over 1 GB: see `references/troubleshooting.md`.

Packaging cooks every map under Content. Delete or move out demo and test maps first; they
cost time and size.

### English pass (day three, again on the last day)

1. `project_find_non_english_text`.
2. Fix everything in the "players can see" group first: widget text, Text literals, DataTable
   text, subtitles, config lines such as the window title, source string literals. Use the
   widget, DataTable and Blueprint tools; translate with the player when meaning matters.
3. The second group (asset names, material parameter names, pin tooltips) never reaches the
   screen; rename only if time allows.
4. Save, run the tool again, repeat until the first group is empty.
5. The tool cannot hear audio. List every voiced asset and ask the player to confirm each is
   English; regenerate with `generate_speech` if not.

### Gameplay video (30–60 s, last day)

- Best quality: packaged build, the player playing. Tell the player a game window is about to
  open and to play until it closes, then call `record_gameplay_video` with `exe_path`.
- Without the player: call `record_gameplay_video` (no `exe_path`) and `ue_autoplay` in the
  same message so the bot plays while it records.
- Gameplay must be on screen in the first five seconds; skip loading with
  `start_delay_seconds`. Record two or three takes and let the player pick.
- Without FFmpeg the file is webm; that uploads to YouTube and Bilibili as is. Where to host the
  link: `references/submission.md`.

### Dev log (all the way through)

Append to `DevLog.md` after every milestone, in English: what was built, which agents and models
did which part, what broke and how it was fixed, one screenshot path (`ue_screenshot`).
The conversation can also be exported as Markdown (tools and changes per turn included) and
condensed into the log. The Glass Box prize only accepts a dev log submitted with the game.

## Constraints

- Nothing of the game before 11-12 13:00 Beijing time. Prepared prompts, skills, agent and MCP
  configuration are allowed but must be declared.
- Third-party assets (Fab, marketplace) need a licence and must be listed in the submission.
  AI-generated content is allowed and is not a sourced asset.
- No trademarks or logos in the game except the Unreal Engine logo.
- Gameplay must go beyond Epic's starter templates.
- Do not change engine version or major plugins mid-jam.
- Never submit late: the form closes at the deadline and late entries are disqualified.

## Failure Handling

Read `references/troubleshooting.md`. In short:

- Packaging fails: fix the first error in the tool result only, then package again.
- Smoke test fails: open the game log it names; usually the default map or game mode points at
  something that was not cooked.
- Video is empty or black: the window was minimized or closed while recording.
- Plan quota runs out: switch the model in Settings → Models to another provider the player
  has; the work so far is unaffected.
- Deadline at risk: cut scope from the cut list. Never skip the final package, smoke test,
  English pass or upload.

## Escalation

Stop and ask the player when:

- fewer than 12 hours remain and the build has never packaged;
- fewer than 6 hours remain and nothing is uploaded to itch;
- a rule is unclear for their case (eligibility, team size, sourced assets, video host) —
  point them to the official rules and the jam's forum, do not guess;
- a change would rewrite large parts of the game after the day-four freeze.
