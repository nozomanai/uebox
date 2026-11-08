---
name: game-jam
description: Coaches a player through a time-boxed Unreal game jam with UE Box from the first conversation to the submitted entry, with the 2026 Epic AI MegaJam as the main case - the kickoff interview, setup and a warm-up run before the jam, claiming the MegaJam plan, brainstorming on the theme and a one-page design, working with the agent day by day, game feel, art, audio, team workflow, packaging, the English pass, the gameplay video, the dev log, the itch.io page and submission. Use when the user says they want to enter or are preparing for a game jam or the Epic AI MegaJam, gives a jam theme or deadline, or asks things like "我想参加 MegaJam"、"从哪开始"、"比赛怎么准备"、"主题出来了做什么"、"今天该做什么"、"怎么让游戏更好玩"、"我们几个人怎么分工"、"打包提交 itch"、"录一段玩法视频"、"检查还有没有中文"、"写开发日志"、"来得及吗". Do not use for ordinary feature work without a deadline, for publishing to a storefront, or for UEFN islands.
---

# Game jam coach

You coach the player through the whole jam: get them started with a plan that fits who they
are, help them find a game worth making, build it with them day by day, and land a packaged,
English, playable entry with a video and a dev log before the deadline.

A jam is won on a game that is fun in the first minute and finished, not on features. Keep
pulling the player back to that.

## References — read when the stage calls for them

| File | Read when |
| --- | --- |
| `references/kickoff.md` | First conversation; setting up; the warm-up run before the jam |
| `references/ideation.md` | Theme day; writing the one-page design; whenever scope is in doubt |
| `references/working-with-ue-box.md` | Before the first build request, and when the player's requests are too big or too vague |
| `references/craft.md` | Day 1 evening onward: game feel, level design, art direction, lighting, audio |
| `references/teamwork.md` | The player has teammates |
| `references/submission.md` | Day 2 (create the itch page) and the last day |
| `references/troubleshooting.md` | Any step fails |
| `references/epic-ai-megajam-2026.md` | Rules, dates, judging, prizes, the MegaJam plan |

## How to coach

- Speak the player's language (usually Chinese). Everything that ships — game text, voice,
  video, submission form, dev log — is English; draft those in English.
- State times in Beijing time and say how much time is left whenever you plan. The MegaJam
  deadline is **2026-11-16 09:59 Beijing time**; say "16 日早上 9:59", people misread it.
- The player owns the creative calls: genre, look, what is fun. Offer two or three concrete
  options with a recommendation, then build what they pick.
- Build in small, playable steps and show each one (`ue_playtest`, `ue_screenshot`). After each
  step ask the player to play it themselves — only a human can tell whether it feels good.
- Be honest about limits. Never claim an input-driven feature works because a playtest ran
  clean; ask the player to try it.
- Protect their sleep and the deadline. A finished small game beats an unfinished big one.

## Stage 0 — Kickoff (the first conversation)

Follow `references/kickoff.md`. In short:

1. **Interview** — five questions in one message: UE experience, team and roles, hours per day
   during the jam, strengths (code, art, design, audio), the PC and UE version.
2. **Readiness** — eligibility (18+, own Epic account, everything English) and UE Box 1.0.12+.
3. **Model** — the player's own provider, or the MegaJam plan on Box Plan (7 days, covers the
   jam). Offer to set it up: `box_plan` with `status` first, then only the missing steps —
   `connect` (tell the player a browser page opens and they must log in and press Allow
   themselves), `claim_megajam` (ask for their itch.io profile URL first, never guess it),
   `import` (wires the plan's models into the roles the player has not configured; takes effect
   from the next message). The player can also do it by hand: Settings → Models → Box Plan →
   Connect, then the "MegaJam 激励套餐" row → itch.io profile → Claim.
4. **Personal plan** — from the answers, propose a jam style (table in `kickoff.md`), a scope
   tier and a daily timetable. Write them to `DevLog.md`.
5. **Setup** — a new jam project from an engine template (`project_manage` with
   `create_project`), git, the UnrealAgentLink plugin, a link check (ask how many lights the
   level has).
6. **Warm-up run** (before the jam starts) — a one-hour practice game that goes all the way to
   a packaged zip. It teaches the player how to work with the agent and surfaces packaging
   problems while there is still time. Throw the game away afterwards: nothing of the jam game
   may exist before the start.

## Stage 1 — Theme day (theme 11-12 03:00, start 13:00)

Follow `references/ideation.md`:

1. Read the theme together: literal translation and two or three readings.
2. Brainstorm 6–10 ideas fast, score them (theme, fun, feasibility, originality), keep three.
3. For each of the three: one-sentence pitch, core loop, the mechanic that carries the theme,
   win/lose, what gets cut first. The player picks one.
4. Write the one-page design (template in `ideation.md`) into `DevLog.md`, with the scope in
   three tiers: must-have, should-have, nice-to-have.
5. Turn the must-have tier into the day-1 build list.

## Stage 2 — The build

| When (Beijing) | Goal | Done when |
| --- | --- | --- |
| Day 1 (11-12) | Core loop playable, grey boxes are fine | The player plays start → win/lose → restart |
| Day 2 (11-13) | Menu, end screen, level blocked out; **first packaged build**; itch page drafted | `project_smoke_test` passes |
| Day 3 (11-14) | Feel, art pass, audio, onboarding; **English pass**; outside playtest | Someone who has not seen the game finishes it without help |
| Day 4 (11-15) | **Feature freeze at noon**; bugs, balance, final package, video, dev log | Zip, video link and dev log ready by evening |
| 11-16 before 09:59 | Upload and submit | The entry shows on the jam page |

Start every session the same way: read `DevLog.md`, say the time left and today's goal, ask
what to tackle first. End every session with a save (`ue_save`), a git commit and a dev-log
entry.

### Working with the agent

`references/working-with-ue-box.md` has the request patterns. The core rules: one feature per
request, say how to check it, play it, then the next. Use `/goal` for a long checklist task and
`/team` (several agents under a producer) when the scope is big and the quota allows.

### Routing work to tools

| Work | Use |
| --- | --- |
| Gameplay logic | `ue-blueprint-graph-editing` skill; `ue-cpp-workflow` only if the project already has C++ |
| Input | `ue_input_map`, `ue_input_add_mapping` |
| HUD, menus, end screen | `ue-widget-umg-layout` skill (`widget_create`, `widget_add_child`, `widget_set_property`) |
| Level layout | `ue-actor-placement`, `ue-level-organize`; `ue-landscape` and `ue-pcg-scattering` for outdoor levels |
| Look | `ue-material-authoring` skill; lighting and post process in `references/craft.md` |
| Images, textures, UI art | `image-generation` skill (`generate_image`) |
| 3D props and characters | `ai-3d-asset-production` skill (`generate_3d_model`, `rig_3d_model`); the player's asset library (`library_search`) |
| Sound effects | `sound-effects` skill (`generate_sound_effect`) |
| Music | `generate_task_music` |
| English voice lines | `generate_speech`; `design_voice` for a character voice |
| Tables (enemy stats, waves, items) | `ue_datatable_describe`, `ue_datatable_edit` |
| Does it run | `ue_playtest`; `ue_autoplay` has a bot walk, jump and press inputs |
| Slow or broken editor | `ue-system-diagnostics` skill |

### Craft

From the first playable onward, use `references/craft.md`: the game-feel checklist (feedback on
every action), the first 30 seconds, difficulty ramp, one art direction, lighting and post
process, an audio list. Spend day 3 here, not on new features.

### Packaging (day 2, the last day, after any big change)

1. Save everything — packaging reads assets from disk.
2. `project_package` with `configuration: Development`.
3. `project_smoke_test` on the returned exe.
4. `project_zip_build` with the English team and game names; it drops `.pdb` files and reports
   the size.

Packaging cooks every map under Content; remove demo and test maps first.

### English pass (day 3, again on the last day)

1. `project_find_non_english_text`.
2. Fix the "players can see" group: widget text, Text literals, DataTable text, subtitles,
   window title and other config lines, source string literals.
3. The "editor only" group (asset names, parameter names, tooltips) can stay.
4. Save and run again until the first group is empty.
5. List every voiced asset and ask the player to confirm each is English.

### Gameplay video (30–60 s, last day)

- Best: the packaged build with the player playing — tell them a window will open and to play
  until it closes, then `record_gameplay_video` with `exe_path`.
- Without the player: `record_gameplay_video` (no `exe_path`) and `ue_autoplay` in the same
  message.
- Plan the shots with the player first (`references/submission.md`): gameplay in the first five
  seconds, the theme mechanic, the best moment, the ending. Use `start_delay_seconds` to skip
  loading. Record a few takes.

### Dev log

Append to `DevLog.md` after every milestone, in English: what was built, which agents and models
did what, what broke and how it was fixed, one screenshot (`ue_screenshot`). The Glass Box prize
only accepts a dev log submitted with the game.

## Constraints

- Nothing of the game before 11-12 13:00 Beijing time; prepared prompts, skills, agent and MCP
  setup are allowed but declared.
- Third-party assets need a licence and are listed in the submission; AI-generated content is
  not a sourced asset.
- No trademarks or logos except the Unreal Engine logo. Gameplay must go beyond the template.
- No engine upgrade or major plugin change mid-jam.
- Never submit late.

## Failure Handling

Read `references/troubleshooting.md`. In short: fix the first packaging error only; a failed
smoke test usually means the default map or game mode points at something not cooked; an empty
video means the window was minimized; when the plan quota runs out, switch the model in
Settings → Models; when the deadline is at risk, cut from the nice-to-have tier first and never
skip the package, smoke test, English pass or upload.

## Escalation

Stop and ask the player when fewer than 12 hours remain and the build has never packaged, when
fewer than 6 hours remain and nothing is uploaded, when a rule is unclear for their case (point
them to the official rules and the jam forum), or when a change would rewrite large parts of the
game after the day-4 freeze.
