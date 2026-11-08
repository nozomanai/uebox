# Teamwork

## Contents

- Roles
- Sharing the project
- Avoiding asset conflicts
- Daily rhythm
- Each member and UE Box

## Roles

Assign an owner for each area; owners decide, others suggest.

| Role | Owns |
| --- | --- |
| Lead / producer | Scope, the cut list, the schedule, the final decision on features |
| Gameplay | Blueprints, input, the core loop |
| Art | Look, materials, lighting, generated and sourced assets |
| Level | Layout, pacing, onboarding |
| Audio | Music, sound effects, voice |
| Build owner | Packaging, English pass, itch page, video, submission |

Small teams combine roles; there is always exactly one build owner, and that person submits.

## Sharing the project

- Git with LFS for `.uasset` and `.umap`, and a standard Unreal `.gitignore`. A shared host
  (GitHub, Gitee, a self-hosted server) that every member can reach from where they are.
- Pull before work, commit small, push often. Never commit Binaries, Intermediate, Saved or
  DerivedDataCache.
- Everyone uses the same UE version and the same project plugins.

## Avoiding asset conflicts

Unreal assets are binary; two people editing the same asset cannot be merged.

- One owner per asset or folder (`Content/Characters` → gameplay, `Content/Environment` → art).
- Levels: one person edits the main level; others work in their own sublevels or test maps,
  or turn on One File Per Actor so actor edits land in separate files.
- Announce before touching someone else's asset; if a conflict happens, keep one version and
  redo the other change.

## Daily rhythm

- Start of day (10 minutes): what each person does today, against the timetable.
- Midday: merge, play the build together.
- End of day: everything committed, the build owner packages once, the dev log gets one entry
  per person.

## Each member and UE Box

- Each member runs UE Box on their own machine, connected to their own copy of the project.
- Each member claims their own MegaJam plan with their own account and itch.io profile.
- Agent work lands in the project like any other change: commit it, push it, tell the team.
- `/team` inside one member's UE Box is a different thing from the human team: it spawns agent
  teammates in that one project. Use it for parallel agent work on one machine, not to
  coordinate people.
