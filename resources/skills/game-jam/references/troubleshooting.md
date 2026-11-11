# Jam troubleshooting

## Contents

- UE Box does not see the editor
- Packaging fails
- The build is over 1 GB
- The smoke test fails
- The video is empty, black or shows the editor
- The English check still lists text
- Box Plan and the MegaJam plan
- Running out of time

## UE Box does not see the editor

- Run `ue_editor_health` first; it says whether the editor process is up and connected.
- The plugin is missing or outdated: `project_update_plugin` installs or updates it (the editor
  restarts).
- A proxy or VPN (Clash and similar) is running with system proxy or TUN mode: the editor's
  local connection to UE Box can be routed through the proxy and fail (the project log shows
  `LogUALNetwork: Error: Connection error` followed by a proxy hint). Unreal ignores the proxy's
  bypass list, so restart the editor without a proxy: have the player close the editor, find
  the engine with `list_engines`, then start it with `run_shell_command`:
  `"<engine>/Engine/Binaries/Win64/UnrealEditor.exe" "<project>.uproject" -ini:Engine:[HTTP]:HttpProxyAddress=`
  with `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` unset. Tell the player that Fab and online
  sign-in inside that editor also go direct until the next normal start.
- Two editors open on the same project: close one.

## Packaging fails

Read the key errors in the `project_package` result and fix the first one only.

| Symptom in the log | Cause | Fix |
| --- | --- | --- |
| Compiler or toolchain not found, "Visual Studio" mentioned | The project or a project plugin has C++ code and no build tools are installed | Install Visual Studio with "Game development with C++", or for a Blueprint-only project disable code plugins it does not need (`ue_manage_plugin`) and package again |
| Missing map, "no default map" | Default map not set or not saved | Project Settings → Maps & Modes: set Game Default Map and Editor Startup Map; save |
| Cook errors on one asset | A broken or half-edited asset | Open it, fix or delete it, save, package again |
| Out of disk space | Packaging writes several GB | Free space on the project's drive |
| Takes very long | All maps under Content are cooked | Remove demo and test maps from Content before packaging |

Package once on day two so these surface early.

## The build is over 1 GB

1. Remove unused content from Content (starter content, demo maps, unused Fab packs) — every
   map and everything it references is cooked.
2. Lower texture sizes on large textures (max 2048 for most props).
3. `project_zip_build` already drops `.pdb` files.
4. Still over: upload with butler (see `submission.md`).

## The smoke test fails

- "Exited early": open the game log the result names. Usually the default map or game mode
  points at something not cooked, or a Blueprint error on BeginPlay.
- "Fatal error" lines: fix the first one; re-run `ue_playtest` in the editor to reproduce.
- No game log: Shipping builds do not write one; package Development.

## The video is empty, black or shows the editor

- Empty or black: the game window was minimized or closed while recording. Keep it visible.
- Recorded the whole editor: PIE was in the level viewport. Use the packaged build with
  `exe_path`, or set PIE to open in a new window before recording.
- Wrong window: pass `window_title` with a part of the game window's title.

## The English check still lists text

- The check reads assets from disk: save in the editor, then run it again.
- Items in the "editor only" group (asset names, parameter names, tooltips) do not reach the
  screen and can stay.
- Text built at runtime from Blueprints (Append, Format Text) shows up through its pieces;
  fix the literals.

## Box Plan and the MegaJam plan

| Message | Meaning | What to do |
| --- | --- | --- |
| Wrong link format | Not an itch.io profile URL | Use `https://name.itch.io` |
| Already claimed | This account has a MegaJam plan | Each person claims with their own account |
| All claimed / claiming ended | No plans left, or past the deadline | Use another provider in Settings → Models |
| Authorization expired | The Box Plan key is no longer valid | Box Plan → Connect again |
| Quota used up | The plan's quota is spent | Switch the model in Settings → Models |

## Running out of time

- Under 24 hours: freeze features, package, start the English pass and the itch page.
- Under 12 hours with no successful package: stop all feature work, fix packaging only.
- Under 6 hours: upload whatever passes the smoke test, then improve and re-upload.
- Never let the last upload start in the final hour.
