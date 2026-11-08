# Working with UE Box during a jam

## Contents

- The loop
- Good requests
- Request examples by phase
- Who does what
- Modes: one agent, /goal, /team
- Keeping the quota and the context healthy
- When something goes wrong

## The loop

Every feature goes through the same five steps:

1. **Ask** for one feature with a way to check it.
2. **Build** — the agent changes the project, compiles and saves.
3. **Check** — `ue_playtest` for what runs on its own; the player plays anything that needs input.
4. **Tune** — numbers, timing, feel, in small follow-ups.
5. **Lock in** — save, git commit, one line in `DevLog.md`.

Coach the player into this rhythm in the warm-up. Big requests ("make the whole game") produce
big, untestable changes and burn quota.

## Good requests

A good request names: what to build, where it lives, how it should behave, and how to check it.

| Weak | Strong |
| --- | --- |
| 做一个敌人 | 在关卡里放一个敌人蓝图 BP_Chaser：玩家进入 8 米内就追，碰到玩家扣 1 点血，脱离 15 米后回原位。做完放三个在通道里，跑一次试玩看会不会报错。 |
| 加个界面 | 做一个 HUD：左上角显示剩余时间（倒计时 90 秒），右上角显示收集数 x/5。时间到弹出失败界面，有「Restart」按钮。文字全部英文。 |
| 让它好玩一点 | 跳跃手感太飘：重力加大到 1.6 倍，起跳速度调到落地时间约 0.6 秒，加 0.1 秒土狼时间。改完我来试。 |
| 换个风格 | 整体改成低多边形卡通风：主色调 #2B2D42、#EF233C、#EDF2F4，地面和墙用纯色材质，加一点描边后处理。先改主关卡，截图给我看。 |

When the player is vague, ask one clarifying question with two or three options rather than
guessing.

## Request examples by phase

- **Kickoff**: 列出能用的项目模板，用第三人称模板建一个叫 OrbRush 的 UE 5.5 工程并打开。
- **Day 1**: 读一下设计里的核心循环，先只做玩家能拾取发光球、计数、集满 5 个算赢。做完跑试玩。
- **Day 1**: 加失败条件：90 秒倒计时，到时间显示 Game Over，按 R 重开。
- **Day 2**: 做主菜单（Play / Quit）和结束界面，开局进主菜单。然后打一次包、冒烟、压 zip。
- **Day 3**: 按手感清单给拾取、受伤、胜利各加一个反馈：音效、屏幕抖动、粒子。
- **Day 3**: 给拾取、跳跃、受伤、胜利、失败各生成一个音效，再生成一段 90 秒循环的紧张电子乐。
- **Day 3**: 扫一下工程里还没换成英文的文字，玩家看得到的全部改成英文。
- **Day 4**: 用打包版录 45 秒玩法视频，跳过前 3 秒加载，我来玩。

## Who does what

| The agent is strong at | The player should own |
| --- | --- |
| Blueprint logic, UI widgets, data tables, placing actors | What is fun; final tuning of feel |
| Generating sounds, music, voice, images, 3D props | Art direction: picking what fits, rejecting what does not |
| Packaging, smoke tests, zips, English checks, recording | Playing the game and judging it |
| Writing the dev log from what happened | The pitch, the itch page voice, the video choice |
| Finding and fixing compile and runtime errors | Deciding what to cut |

Generated assets vary in quality; generate a few, let the player pick, and keep one style.

## Modes: one agent, /goal, /team

- **One agent (default)** — best for the loop above. Most of the jam happens here.
- **/goal** — one long task with a checklist the agent works through and an auditor checks, e.g.
  "every UI string English and every button works". Good for the English pass and polish lists.
- **/team** — a producer agent hires teammates and splits the work, then an acceptor plays the
  result against the design. Suits bigger scopes and teams that want parallel progress; it is
  the most expensive mode. Give it the one-page design and the must-have tier, not "make a game".

## Keeping the quota and the context healthy

- The MegaJam plan has a fixed quota for 7 days. Strong models cost more per request; use them
  for design questions and hard bugs, and a cheaper model for routine edits if the player has
  one configured.
- Long conversations get slow and expensive. Start a new conversation per feature or per day;
  `DevLog.md` carries the context across.
- When the plan quota runs out, switch models in Settings → Models. Nothing in the project is
  lost.

## When something goes wrong

- Wrong change: ask the agent to undo its last steps (`ue_undo` after `ue_undo_history`), or
  roll back with git.
- Repeated failures on the same thing: stop, describe the expected behaviour again in one
  sentence, and ask for a simpler approach.
- Editor crash or disconnect: see `troubleshooting.md`; work saved with `ue_save` is safe.
