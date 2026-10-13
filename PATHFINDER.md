# 寻路 / 防卡住：用现成的 mineflayer-pathfinder

怎么装、怎么跑自检、配置速查见 [README.md](README.md)；故障的完整根因见 [踩坑档案.md](踩坑档案.md)。

## 为什么换

之前是自己手写的走路器（`src/core.mjs` 的 `walkTo`），遇到坑/墙/1 格窄缝只能"跳一下、垫一格、横移一下"硬试。
实测两个毛病：

- **瞎跳**：每次判定卡住就 `setControlState('jump', true)` 跳 350ms，原地跳来跳去，用户原话"完全是瞎动"。
- **绕远/掉坑**：卡住的判据看"有没有动"，于是"一路挖一路走、挪了 25 格却离目标 49 格、还掉下 40 格"也算有进展。

所以按"先找现成方案"的原则，改用 PrismarineJS 官方项目
**[mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder)**（v2.4.5）：
A\* 寻路 + 挖穿挡路方块 + 垫 1×1 塔 / 搭桥 + 过门 + 卡住检测 + `NoPath` 判定，全是现成的。
手写的那套（含"卡住就盲跳"）**已整段删除**。

## 装在哪（重要）

```
%USERPROFILE%\.dsh\profiles\desktop\vendor\mc-deps\
  package.json
  node_modules\mineflayer-pathfinder\      ← 2.4.5
  node_modules\...（41 个包，版本跟宿主一致）
```

**故意不装进 profile 的 `node_modules`**：那里是 pnpm 的符号链接农场，跑一次 `pnpm install` 就会把
打过补丁的 `readable-stream` 冲掉（那个补丁没了 DSH 起不来）。`vendor\mc-deps` 是独立的 npm 树，互不影响。
装/重装：

```powershell
cd %USERPROFILE%\.dsh\profiles\desktop\vendor\mc-deps
npm install --no-audit --no-fund mineflayer-pathfinder@2.4.5
node %USERPROFILE%\Desktop\agent\dsh-mc-agent\tools\check-mc-deps.mjs   # 装完必跑
```

> 插件目录现在是 **junction**（profile 依赖写 `link:C:/Users/BLUE/Desktop/agent/dsh-mc-agent`），
> Node 会把符号链接解析成 realpath ⇒ 靠 `import.meta.url` 往上数三层的 `<profile>\vendor\...` 那条候选
> **会失效**（`../../../vendor` 变成 `%USERPROFILE%\Desktop\vendor`）。所以 `loadMcDep` 里加了一条
> **绝对路径兜底**（`$DSH_HOME\profiles\*\vendor\mc-deps\...`），见踩坑档案第 10 条。

## 怎么接上的

`src/core.mjs`：

| 东西 | 作用 |
| --- | --- |
| `loadPathfinder({log, logWarn, spec})` | 找并 `import()` 这个包。顺序：环境变量 `DSH_MC_AGENT_PATHFINDER`（给目录或 `index.js`）→ 插件包旁边的 `<profile>\vendor\mc-deps\node_modules\mineflayer-pathfinder\index.js` → **`$DSH_HOME\profiles\*\vendor\mc-deps\node_modules\...`（绝对路径兜底）** → 裸包名。`log` = 成功细节（调用方传 `logDebug`，默认不落盘），`logWarn` = 候选不可用/形状不对（info） |
| `resetPathfinderCache()` | 清缓存，重查（**只缓存成功、不缓存失败**） |
| `scaffoldingItemIds(bot)` | 算出"能拿来垫脚"的方块 **item id**（土/圆石/木板…，排除矿石、钻石/铁/金块、远古残骸；只认整方块，见踩坑档案第 6 条） |
| `McBot.setupPathfinder()` | `bot.loadPlugin(pathfinder)`，设 `thinkTimeout=8000`、`tickTimeout=40`、`searchRadius=192`，成功置 `pfReady=true`；`connect()` 里自动调。**`thinkTimeout` 原来是 4000，实机挖树频繁 `Took to long to decide path to goal!`（挖 4 根原木只拿到 1 根），改成 8000 后"目标在高处要垫脚"这类难想的目标才有机会想出来** |
| `McBot.#walkPathfinder()` | 真正走：`goals.GoalNear(x,y,z, arrive-0.6)` + `Movements`（`canDig`、`maxDropDown=3`、`liquidCost=4`、`digCost=4`、`dontMineUnderFallingBlock`、`scafoldingBlocks`）、超时/中断走 `raceAbort`，完了**自己再核一遍距离**（"说到了但人没到"一律报 `arrived:false, stuck:true`） |
| `McBot.walkTo()` | **只调用** `#walkPathfinder()`；pathfinder 没装上就停止移动并如实返回 `PathfinderUnavailable`，不再盲跳或退回手写逻辑 |

行为变化：走路会**自己挖穿软方块、垫 1×1 塔**（用背包里的土/圆石之类）；`allowParkour=false`、
`maxDropDown=3`（不乱跳崖）、`liquidCost=4`（不太愿意下水）。
`#movements()` 造的那份 `Movements` 同时给 pathfinder / collectBlock / pvp 用 —— 免得"我自己走不乱跳、
插件走就乱跳"。

## 怎么关 / 怎么调

- **禁用**：`DSH_MC_AGENT_PATHFINDER=off`，或插件配置 `pathfinder: false`。禁用后移动会安全停止，不退回手写走路器。
- **调走路**：`walkCanDig`（默认 true，false = 只走不挖）、`walkDigCost`（默认 4，越小越愿意挖）、
  `walkMaxDropDown`（默认 3）、`walkAllowParkour`（默认 false = 不跳远；打开它对"1 格台阶卡住"没用）。
- **调寻路本身**：`setupPathfinder()` 里的 `thinkTimeout` / `tickTimeout` / `searchRadius`
  （配置键 `pfThinkTimeoutMs` / `pfSearchRadius`）。
- **查日志**：`已找到现成的寻路插件（…）` 这类"加载到哪一步"的细节行**默认不落盘**（降级到 debug，
  原来每个连接都重打一遍、占主日志三成）。要查加载过程就 `MC_LOG_LEVEL=debug` 重连一次；
  走路相关的 info 行仍在（`已进入` / `连接结束` / `⚠️ 寻路 超时…`）。

## 打过的补丁（都在 vendor 树里，`npm install` 不会冲掉）

| 包 | 补丁 | 体检 |
| --- | --- | --- |
| `mineflayer-pathfinder` | ①`lib/physics.js`：`collides()` + `simulateStraight()`（贴墙穿模不算"能直走"）②`lib/movements.js`：`getMoveDiagonal` 禁掉**斜切拐角**（"怎么不动了"的根因） | `check-mc-pathfinder.mjs` 24/0 |
| `mineflayer-tool` | `lib\Tool.js` 加 `_triedChest`（空手挖方块会无限递归到 OOM） | `check-mc-deps.mjs` 第 4 段 |
| `readable-stream` | 8 处 `require('X/')` → `require('X')`（尾斜杠地雷，会让整个 `import()` 失败） | `check-mc-deps.mjs` |

前两条的完整现象/根因/实机证据见 [踩坑档案.md](踩坑档案.md) 第 2、4 条；
成品备份在 `dsh-mc-agent\备份\pathfinder-补丁备份\`（可直接还原）。

## 上游复核（2026-10-06）：已经修了，只是没发布

把 npm 原版 2.4.5、上游 master（2026-10-03，PR #393 已合入）、本地两处补丁塞进同一个实机场景
（空背包站在 1 格深沟里，往东上 1 格台阶到 `(4,66,3)`）：

| 版本 | 结果 |
| --- | --- |
| npm 2.4.5 原版 | `arrived=false`，30 秒只挪 1.6 格，`path_reset('stuck')` 8 次 |
| 上游 master | `arrived=true`，1434 ms，挪 6.32 格，stuck 0 |
| 本地两处补丁 | `arrived=true`，1705 ms，挪 6.82 格，stuck 0 |

⇒ master 的 `getMoveDiagonal` 里 `if (y === 1) return` 治的是同一个病根；**npm latest 仍是 2.4.5，
没带上这个修复**，所以本地补丁照旧留着。**已决定不上报**（`#310` 还开着、`#393` 已合进 master，再开是重复）。

## 单次调用 ≤11 秒：走不到常常是"这一轮的时间到了"

`walkTo` 一次**最多走 10 秒**（`CALL_BUDGET_MS`，设计见 [README.md](README.md) 的「单次调用 ≤11 秒」一节）。
长路要分几次走，**到点返回不是失败**：

- 返回值 `arrived:false` 带 `moved` / `remaining`，告诉你走了多少、还差多少；
- `hint` 明确写"这一轮的走路时间用完了（单次调用最多 10 秒），**不是走不通**：直接再叫一次 mc_move
  往同一个目标走，会接着走"；
- 只有 `reason:"NoPath"`（真没路）才会建议"换个能走到的目标点，或先解除挡住它的方块"。

判断"是不是被预算截断的"用 `#walkPathfinder` 的 `budgetAsked` 入参 —— 以前只看 `msLeft() <= 400`，
DSH 把截止时刻设成一整轮时，预算到点还剩约 1 秒 ⇒ 被误判成"真走不通"。

## 移动抢占：两份移动共用一个 `bot.pathfinder` 会互相停掉

自主层原来那份自保（被怪贴上时先跑）和 AI 那一轮的 `mc_move`/`mc_dig` 用的是**同一个** `bot.pathfinder`，
而 `#walkPathfinder` 的 `finally` 原来**无条件** `b.pathfinder.stop()` + 松控制位 ⇒ 先结束的那份会把
另一份一起停掉：**动一下就僵住**（用户 m10335「他动了一下不动了，应该是 move 的时候冲突了」）。

现在：

- 每次移动开始**领一个号**（`_moveGen` / `#beginMove()`），`finally` 里只有"号还是最新的"才允许动
  pathfinder 和控制位；
- 公开 `interruptMove(reason)` 用来**抢占**（号 +1、停 pathfinder、停采集任务、松控制位，立刻返回），
  现在只有 `mc_dig` / `mc_craft` 抢占用它 —— 自保反射已经**不再自己移动**（用户 m11410：把受到攻击
  自动跑离开去掉），所以它也不抢了；
- 被抢占的那次 `walkTo` 如实返回 `reason:"preempted"`，hint 写明"被另一次移动打断了，再叫一次 mc_move
  接着走，**不是走不通**"—— 不能让模型误以为路不通而换目标；
- `#cancelCollect` 和 `dig()` 的采集分支也各领一次号（collectBlock 自己走过去，同样算"一次移动"）。

细节与回归见 [踩坑档案.md](踩坑档案.md) 第 9 条（`check-call-budget.mjs` 第 ⑩ 节 17 条）。

## 已知能力缺口：掉进竖井 + 背包里一块方块都没有 = 出不来

实机踩到过（`mc_move` 连试 3 次全失败，90 秒只挪 0.2 格，`reason:"partial"` / `"stuck"`，
其中一次 `pillared:26` 全是白垫）：

- 机器人站在一个 **1 格宽、4 格高**的竖井里，头顶被 `jungle_planks` 封住。
- pathfinder 的 `canDig` **只挖路径前方的方块**；要往上走只能靠 `allow1by1towers` 垫 1×1 塔，
  而垫塔**需要背包里有 `scafoldingBlocks`**（土就行）—— 一块都没有就彻底出不来。
- 更细的一条：竖井里**必须先能跳**（头顶要有空位）才垫得动。实测让它先跳一下（y=79 → 80），
  之后同一次 `walkTo` **2825 ms 就到了**。

**"能挖"不等于"能爬"。这条目前没修** —— 补它必然要动"手写脱困逻辑"，而用户明确要求过
「删掉自写的脱困、只信 pathfinder，别又变成瞎动」。
（2026-10-06 曾按用户要求试做过一版 `walkTo` 里的"卡住自救"：就地挖垫脚料 → 跳 → 再走，实机验过确实能从
竖井里出来；但用户当天又说「先把你刚刚写的掉进竖井自己爬出来删了，我遇到问题再找你」，于是**已整段回退**，
`src/core.mjs` 里现在没有这层逻辑。记录在这儿只是免得以后重复踩坑。）

## 测试

- **离线**：pathfinder 的加载、`via:"pathfinder"`、不许谎报到达、`NoPath` 如实上报、超时和未加载时安全停止，
  随 `check-mc-observe-host.mjs` 的移动回归覆盖。
- **补丁体检**：`node tools\check-mc-pathfinder.mjs`（24/0）—— 两处补丁在不在、`collides()` 六种情形
  （穿模 0.06 算 / 擦到不算 / 半砖顶面不算 / 1 格宽走廊不算）、`simulateStraight()` 撞进方块标 `blocked`、
  `canStraightLine()` 老写法误判而补丁后不误判、`getMoveDiagonal()` 在台阶角上被禁而拐角空着时照旧允许。
  **给 vendor 树 `npm install` 之后也要跑。**
- **依赖体检**：`node tools\check-mc-deps.mjs`（9/0）。
- **真服**：`实机验证\走路\live-walk.mjs`（4/0，就是踩坑档案第 4 条那个卡点）；平时直接调 `mc_move` 验证。

## 生效

`src/core.mjs` 是 DSH 启动时加载的，**改完要重启 DSH** 才生效（重启会掉当前 MC 会话）。
