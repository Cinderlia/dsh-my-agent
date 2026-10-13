# dsh-mc-agent —— DSH 的「我的世界」插件（魔改版）

DSH 原生 Minecraft Agent 插件：一台无头机器人（mineflayer）跑在 DSH 进程里，模型用 `mc_*` 工具
走路、挖建、合成、熔炼、存取箱子、打怪、用物品（扔眼睛/射箭/喝药水）、聊天、看第一人称截图。

上游是 [whale-craft](https://github.com/yzi1b/whale-craft)（作者 yzi1b）；**本项目已改名为
`dsh-mc-agent`** 并做了大量魔改，本仓库在 <https://github.com/blueziii/dsh-mc-agent>，
上游原版的完整插件说明在 [插件说明.md](插件说明.md)。

| | |
| --- | --- |
| 项目目录（**唯一可编辑源**） | `%USERPROFILE%\Desktop\agent\dsh-mc-agent` |
| 安装位置 | `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-mc-agent` —— **指向本项目目录的 junction**（profile 里写的是 `link:…`）⇒ 改完**不用再往包里拷**，重启 DSH 即生效 |
| 本目录的 `node_modules\` | 103 个 junction，指回 profile 的 `node_modules`（与宿主共用同一份依赖，不用自己 `pnpm install`） |
| vendor 依赖 | pathfinder / collectBlock / tool / pvp / autoEat 在 `<profile>\vendor\mc-deps\`（见 [PATHFINDER.md](PATHFINDER.md)）；`loadMcDep` 还有 `$DSH_HOME\profiles\*\vendor\mc-deps\…` 兜底，插件包装成链接也不会静默丢 |
| 上游仓库 / `CHANGELOG.md` 里的旧名字 | **历史，保持原样**（`github.com/yzi1b/whale-craft`） |

## 装到自己的 DSH

前提：DeepSeek Harness 桌面版（`node >= 22`）、一台能连的 Minecraft Java 服务器（离线登录也支持）。

```powershell
# 1) 插件本体（profile 目录，默认 %USERPROFILE%\.dsh\profiles\desktop）
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm add github:blueziii/dsh-mc-agent

# 2) 5 个 mineflayer 插件：走路 / 挖矿采集 / 自动换工具 / 打怪 / 自动吃
pnpm add mineflayer-pathfinder mineflayer-collectblock mineflayer-tool mineflayer-pvp mineflayer-auto-eat
```

然后在同一个 `package.json` 的 `dsh.profile.bundles` 数组里加一项 `"dsh-mc-agent"`，重启 DSH。

- **第 2 步别省**：少装哪个就少一项能力，而**没装 `mineflayer-pathfinder` 时 `mc_move` 的走路会直接拒绝**
  （`via: "pathfinder-unavailable"` —— 宁可不动也不盲跳；只有"在水里游"和"原地跳"还能用）。
  插件按 `vendor 树 → 宿主 node_modules` 的顺序找它们，`pnpm add` 装在 profile 里就能被找到。
- 想改代码：把仓库 clone 到任意位置，依赖那行写成 `"dsh-mc-agent": "link:C:/你的路径/dsh-mc-agent"`
  （软链，改完不用往包里拷，重启 DSH 即生效）。
- 装完体检：`node tools\check-mc-deps.mjs`（5 个插件都解析得到、宿主解析器那个尾斜杠地雷不在）。
- 离线自检（29 个套件 + selfcheck，不需要游戏服务器）：`node tools\check-all.mjs`。
- 进游戏：跟它说"连 127.0.0.1:25565，名字叫 xxx"，或者直接让它调 `mc_connect`。
  装好后 DSH 设置里会多一个「MC设置」页（改 `RULES.md`、看记忆目录、开关看门狗）。

## 跑自检

一条命令跑完（推荐）：

```powershell
cd %USERPROFILE%\Desktop\agent\dsh-mc-agent
node tools\check-all.mjs                 # 全部 31 项（30 个套件 + selfcheck），最后给一张 ✓/✗ 表
node tools\check-all.mjs --fast          # 跳过 selfcheck
node tools\check-all.mjs --only mc_auto  # 只跑名字里带这段的
```

套件自己会收拾现场：建过临时目录的（`check-mc-auto`、`check-mc-observe-host`）跑完就删，
想留现场加 `--keep`。（2026-10-08 发现 `check-mc-auto` 每跑一次往 `%TEMP%` 留 2 个
`mc-auto-mem-*`/`mc-auto-wsmem-*`，已经堆到 206 个，那次一起清了。）

单跑某一条也行（括号里是期望结果）：

```powershell
node tools\check-mc-craft.mjs            # 184/0（含"窗口事件丢了但东西到手了"不谎报失败、⑧ 合成窗口失步、缺料报链条、⑨ 一次只做一批会自己补上、⑩⑪ 挂了太久不悄悄开第二条链）
node tools\check-mc-furnace.mjs          # 267/267（含"取成品后背包晚 2.5 秒才同步也不谎报失败"、"放熔炉被拒就换点位重试"）
node tools\check-mc-chest.mjs            # 126/126
node tools\check-mc-auto.mjs             # 233/0（含 3.5 自保：被打了只叫醒 AI、不自己跑也不还手；3.6 憋气；3.7 busy 期间照样检测）
node tools\check-call-budget.mjs         # 139/139（单次调用 ≤11 秒 + ⑩ 移动抢占 + ⑩.5 别人的 goal_reached + ⑪ 领号/认中断/预算到点三件套：jump·swim·flyTo 的 abort 与抢占、收尾调 setGoal(null)、waitForChunks 上限、控制位租约、runSequence 的 wait 不谎报）
node tools\check-token-budget.mjs        # 33/0（省 token：描述/参数体积上限 + 结果不许回 pretty-print JSON + 真跑一遍 mc_status 默认视图 + `mc_entities` 不再单独注册）
node tools\check-core-place.mjs          # 73/0（选料只认整方块：火把/门/半砖/楼梯都不拿去搭）
node tools\check-core-entities.mjs       # 46/0（附近有谁：分类/排序/血量走现成助手；实体列表已并进 `mc_observe` 的"程序检测到"，不再单独注册工具）
node tools\check-core-attack.mjs         # 75/0（打谁 + 真打得着：who 认中英文/找不到列名单；⑥ pvp.attack() 立刻 resolve ⇒ 自己等目标死或预算用完、killed/waitedMs/targetHealth 如实报；打死 + 地上有掉落物 ⇒ 结果里带 `pickup` 提醒去捡）
node tools\check-core-dig.mjs            # 42/0（采集超时/出错必须 cancelTask + 松开控制位 + 清僵尸队列；⑥ 够得着就原地挖、按"眼→方块中心"判 reach、要服务端 `block_change` 回包才算挖掉、等回包最多 1200ms（`#awaitServerBreak`）、掉落物按背包差如实报、一个都没捡到时点一句"地上还有 N 个没捡"；②′ 服务端把方块**改回来**（复原）时不许报成功、`multi_block_change` 要按位段真解）
node tools\check-core-digtime.mjs        # 27/0（"挖铁矿要 4.5 秒"：先复刻上游错值证明坑存在（铁矿石镐 4550ms），再验 `bot.digTime` 被修成原版真值（石镐 1302 / 铁镐 870 / 钻石镐 708 / 下界合金 600），以及**拿错工具/品级不够/有药水效果时一个都不许改小**）
node tools\check-core-useitem.mjs        # 37/0（用物品：空手拒绝、hold 上限 3 秒、松手包必须留 400ms 余量）
node tools\check-core-swim.mjs           # 93/93（别淹死：上浮换气、水挖不掉、status 报"头在水下"；⑦ 在水里绕开寻路直接游；⑧ 上浮认中断/领移动号/只松自己的 jump）
node tools\check-core-map.mjs            # 54/0（mc_map 洞穴层：自动判"在地下"、能站/墙/会掉下去、图例不再 [object Object]）
node tools\check-core-inventory.mjs      # 24/24（mc_inventory：同名格子合计成一条、手上那叠不再重复数一遍）
node tools\check-core-equip.mjs          # 56/0（动手前换对工具 + **时间不够就不开始挖**（挖一半到点松手 = 进度清零）、换不上直接拒绝、挖不动按 digTime 说实话）
node tools\check-core-evidence.mjs       # 40/0（**报了成功有没有证据**：chatSay 拒斜杠指令、toss 对账、useBlock 容器/门/实体三种返回、#aimAt 不依赖 lookAt）
node tools\check-session-memory.mjs      # 13/0（记忆按会话分：落点/兜底/播种/默认关）
node tools\check-rules-file.mjs          # 78/0（规则放在文件里：注入只投一行指针、版本提示.md 可改可恢复、新会话从基根播种它）
node tools\check-mc-observe-host.mjs        # 96/0（默认=AI 自主；--gate-on 110/0）（含三段式感知：看到/检测到/不确定、两套射线互相印证、`percept:false` 退回旧摘要）
node tools\check-mc-view-render.mjs      # 112/0（含手持物色块：带 xN 后缀也要认得出是什么）
node tools\check-mc-skin.mjs             # 78/0（含"坏响应不落盘、坏缓存删掉重下、失败 30 秒后可重试"）
node tools\check-mc-pathfinder.mjs       # 24/0（"走不动"的回归：贴墙穿模算碰撞、斜切拐角禁掉）
node tools\check-watch-chat.mjs          # 21/21（"我打的字它看不到"的回归：旁观模式靠 anyChat 兜底）
node tools\check-audit-session.mjs       # 44/0（会话/状态层审计 F1–F12：自动重连真的连得上、满 200 条也能等到新事件、幽灵在线不再报 online:true、注入失败会留话）
node tools\check-logging.mjs             # 52/52（本地时间/级别/进程内去重/轮转 + 旧噪声不许回潮）
node tools\check-mc-deps.mjs             # 9/0（**给 vendor 树 npm install 之后必跑**）
node tools\check-module-load.mjs         # 30/0（拆分之后：51 个 src 模块 + 扩展全部还能 import、core 仍然只是外壳、六条路线图关键件都在）
node selfcheck.mjs                       # exit 0；**任何 ❌ 就 exit 1**（2026-10-08 起）
```

拆分 `core.mjs` 时另有一个**顾问型**脚本（不判红、不在 `check-all` 里，结果要人看）：

```powershell
node tools\scan-moved-assertions.mjs     # 两遍扫描：①按导出名找 ②把断言的正则拿去目标文件里试（搬模块后先跑它，见迁移规矩第 21 条）
```

**改完要重启 DSH**（重启会掉当前 MC 会话）。`index.js`、`selfcheck.mjs`、`src\*.mjs`、
`extensions\*.mjs`、`tools\check-*.mjs` 和这些文档都是可编辑的，改完直接生效（不用同步）；
只有 pnpm 硬链接的文件不能改（见「踩坑档案」第 1 条）—— 本项目里已经没有那种文件了。

## 配置速查

记忆根：`%USERPROFILE%\.dsh\dsh-mc-agent\memory`（由 `memoryDir` 指定）。**下面这些是我加的键**，
上游原有的键（`host`/`port`/`authUrl`/`timeouts`/`chatHistory`…）见上游 README。

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `memoryDir` | `<会话工作区>\.dsh-mc-agent` | 记忆根（`RULES.md`/`版本提示.md`/`auto.json`/`view.json`/`skins\` 都在这儿） |
| `memoryPerSession` | `false` | `true` = 每个会话一份记忆（`<memoryDir>\sessions\<短会话 id>\`），新会话从基根播种 |
| `pathfinder` | `true` | `false` = 不走路（安全停止，不退回手写走路器） |
| `walkCanDig` / `walkDigCost` | `true` / `4` | 走路时挖不挖软方块、挖的代价（越小越愿意挖） |
| `walkMaxDropDown` | `3` | 允许往下跳几格（不乱跳崖） |
| `walkAllowParkour` | `false` | 跳远（打开它对"1 格台阶卡住"没用，见踩坑档案第 4 条） |
| `pfThinkTimeoutMs` / `pfSearchRadius` | `8000` / `192` | A\* 思考上限、搜索半径 |
| `autoEatAt` | `14` | 饥饿值低于它自动吃 |
| `moveBudgetMs` / `collectBudgetMs` | 很大 | 走路/采集预算，**都会被 10 秒上限钳住** |
| `wearArmor` | `true` | 空着的盔甲位就从背包里穿上（不动位置、不打怪） |
| `avoid` | `true` | 自保：躲岩浆/火/仙人掌 + 被怪打时**只叫醒 AI**（不自己跑、不还手） |
| `idleWakeSec` / `idleWakeMaxPerHour` | `5` / `120` | 待机几秒叫醒它、每小时最多叫几次 |
| `minIdleGapSec` / `idleWakeNearPlayerSec` | `5` / `5` | 两次唤醒最小间隔、玩家在旁边时用几秒 |

单独文件（不在 `config.json` 里）：

| 文件 | 内容 |
| --- | --- |
| `<memoryDir>\auto.json` | 自主层：`enabled`/`follow`/`pickup`/`avoid`（自保：被打了只叫醒 AI）/`standing`（长期目标）… |
| `<memoryDir>\view.json` | 看图门禁：`{"gate":true,"maxActions":8,"maxAgeMs":120000}`（默认不强制） |
| `<memoryDir>\RULES.md` | 行事准则（游戏内 AI 自己读；含「说话方式」「打怪与保命」「工具速查」「不用替我省 token」等节；**单次调用 ≤11 秒、到点再叫一次同一个工具**这条规则也在这儿）。2026-10-08 重写过一次：**内置默认与记忆里这份是同一份文本**了（以前分叉，点「恢复默认」会丢节） |
| `<memoryDir>\版本提示.md` | 版本提示（每个版本的时效性注意事项；**以前是硬编码在提示词里注入，现在也只投一行指针**）。在「MC设置 → 提示词」里能直接改、能恢复默认；「随版本更新」打开时插件升级会替换它 |

环境变量（都可选）：`DSH_MC_AGENT_PATHFINDER`（`off` 或给路径）、`DSH_MC_AGENT_MC_DEPS`、
`DSH_MC_AGENT_MEMORY_DIR`、`DSH_MC_AGENT_AUTO`、`DSH_MC_AGENT_VIEW_GATE` /
`_VIEW_GATED` / `_VIEW_MAX_ACTIONS` / `_VIEW_MAX_AGE_MS`、`DSH_MC_AGENT_SKIN_TIMEOUT_MS`、
`MC_LOG_LEVEL`（`quiet|info|debug`）、`MC_LOG_MAX_BYTES`、`MC_LOG_KEEP`、`MC_HOST`/`MC_PORT`。

## 我改了什么（一览）

细节在 [踩坑档案.md](踩坑档案.md) 与 [PATHFINDER.md](PATHFINDER.md)。

| 文件 | 一句话 |
| --- | --- |
| `src\core.mjs` | 走路**只用** `mineflayer-pathfinder`（**在水里除外**：`#walkSwim()` 绕开它直接 `forward+jump` 游，2 格/秒，上岸再交回寻路）；`MC_DEPS`+`loadMcDep()` 统一加载 vendor 树里的现成插件；`dig()` **只有一条路**：够得着（`#reachOf()` 按"眼→方块中心"算，生存 4.5）就原地挖、够不着就 `mc_move` 走过去再挖，**不再交给 `collectBlock`**（它用 `GoalLookAtBlock`，"看得见"就算到 ⇒ 服务端拒收 + `diggingTask` 永不 resolve ⇒ 采集僵尸，之后几分钟走不了路；`#cancelCollect` 末尾 `targets.clear()` 兜底、`#grabDrops` 超时也取消）；**先拒流体**（水/岩浆挖不掉）；**"服务端认没认"是三态**（`#watchServerBreak`）：原版**拒绝**破坏时会把**原方块**发回来纠正客户端（玩家看到"复原"），旧代码把这个复原包当成"认了" ⇒ 现在 `hit()`（服务端说这块变空气）/ `restored()`（服务端把方块改回来）/ 都没收到，分别报"挖掉（服务端已确认）"/"服务端把这块改回了 X（复原）"/"没收到服务端的破坏回包"；`multi_block_change` 按 mineflayer 的位段格式真解；`attack()` 交 `pvp`（**自己等目标死 / 等预算用完**：`pvp.attack()` 是立刻 resolve 的后台循环，await 完就 `stop()` 等于一下都没打，结果如实报 `killed`/`waitedMs`/`targetHealth`）；**动手前自动换对的工具**（`#equipFor()`：攥着泥土挖石头会先拿镐，换不上直接拒绝、不白挖一轮）、**动手后如实报手上是什么**（`#heldText()`/`#withHeld()`，`breakBlock` 带 `held`/`digMs`，`build` 带 `used`/`held`，垫路带 `pillaredWith`/`held`）；`entities()` 补上分类/血量/远程标记（血量和距离走 `bot.util.entity`）；**`useItem()` 用物品**（`use_item` + `release_use_item`，松手留 400ms 余量）；**`swimUp()` 上浮换气**（按住 jump，到点松手）；**`inventory()` 同名格子合计成一条**（手上那叠明说"已经算在合计里，别再加一遍"）；`status()` 报 `air`/`submerged`（憋气判据）；**`heightmap()`/`mapImage()` 会按 `isUnderground()` 自动切成洞穴层视图**（`mode`/`slab`）；**别挖到一半松手**（`#digMsFor()` 先估这块要多久、时间不够就一个挖矿包都不发；换工具按"快多少"来 `#bestToolFor()`；`dig()` 留 900ms 收尾）；单次调用压到 11 秒以内；日志基建（本地时间/级别/去重/轮转）；**自动重连真的连得上**（记下含 auth 的连接参数、重试有上限 `maxReconnectAttempts`、耗尽或没参数时如实回 `willReconnect:false`）、`redactPath()` 把家目录换成 `$DSH_HOME/`；**移动/寻路审计（第二轮）**：每个长动作都**领号**（`_moveGen`/`#beginMove()`，收尾凭号确认"还是我"）、**每轮查中断**（`swimUp`/`flyTo`/`#runStep` 的 wait 以前都不认 abort）、**预算到点如实说**（不再把"没做完"说成"做完了"）；`#stopPathing()` = `setGoal(null)` + `stop()`（vendor 的 `stop()` 只置标志）；`_ctrlLease`/`holdControl()` 控制位租约（别人刚按下的键收尾的一方不许松）；空路径的 noPath 不再报 `preempted` 而报 `NoPath`/`goal-reached-elsewhere`；**挖矿速度按原版真值**（`#fixDigMs()` + `#patchDigTime()`：上游 1.21.9 的 108 个方块 `material` 写错成 `incorrect_for_wooden_tool` ⇒ 工具倍率查不到 ⇒ 铁矿永远 4550ms，改成真值 1302/870/708 并留 8%+60ms 余量；拿错工具/品级不够/有药水效果时一律不插手）；**"东西还在地上"点一句**（`#dropsNear()`/`#dropHint()`：`mc_dig` 一个都没捡到时、`mc_act{attack}` 打死目标后、`mc_act{break}` 真挖掉后都带 `pickup` 提醒走过去捡；掉落物判据抽成模块级 `isDropEntity()`，与 `#grabDrops` 同一份） |
| `src\format.mjs` | **路线图第 ④ 条的第一刀**（渐进拆分 `core.mjs`）：先搬**纯函数** —— `lossless()`（无损 JSON：类实例只留自有属性、Map/Set 转普通类型、循环引用 `'[circular]'`、NaN/-0 归一）、`redactPath()` + `resolveHarnessHome()`（家目录脱敏成 `$DSH_HOME/...`）。三个名字在 `core.mjs` 里**照样导出**（`export { … } from './format.mjs'`），外部 import 一行都不用改；它们没有 `this`、没有事件、没有异步，搬走之后行为一字不变 |
| `src\block-names.mjs` | **路线图第 ④ 条的第二刀（+ 第八刀并进来的三个）**：只认字符串/方块对象的那一层 —— `isAir()` / `isLiquid()` / `isPassable()` / `SOFT_ROOF`（软顶名单）、地形图的字形与配色 `glyphOf()` / `colorOf()` / `CAVE_GLYPH` / `CAVE_LABEL` / `COLORS`，以及**第八刀**并进来的右键交互判据 `CONTAINER_RE`（能打开窗口的方块）/ `TOGGLE_RE`（门/按钮/拉杆）与 `canPlaceInto(blk)`（这格能不能放方块）。`core.mjs` 保留 `export { glyphOf } from './block-names.mjs'`，`tools\check-core-map.mjs` 照旧能从 `core.mjs` 拿到它 |
| `src\async-util.mjs` | **路线图第 ④ 条的第三刀**：异步叶子 —— `sleep()` / `withTimeout()`（超时带 `mcTimeout: true`，文案如实说"常见原因是目标够不着"而不是"失步"）/ `raceAbort()`（让宿主那个只会 abort signal 的停止链路真的立刻结算）/ `abortError()`。`withTimeout` 被 4 个扩展从 `../src/core.mjs` 导入、`raceAbort` 被 `selfcheck.mjs` 导入 ⇒ `core.mjs` 必须 `export { withTimeout, raceAbort } from './async-util.mjs'`（少这一行是**加载期**报错） |
| `src\entity-names.mjs` | **路线图第 ④ 条的第四刀**："谁是谁"那一层 —— `HOSTILE_RE` / `RANGED_RE`（敌对与远程名单，与 `extensions\mc_auto.mjs` 的 `HOSTILE` / `RANGED` 逐字一致）/ `JUNK_RE` / `NOT_DROP_RE` + `isDropEntity()`（掉落物判据只有这一份：掉落物实体的 `type` 是 `'other'`，不能拿 `displayName` 兜底）/ `NAME_ALIAS`（中文叫法 → 实体名）/ `entityNameOf()` / `nameFieldsOf()` / `matchNameOf()` / `pickEntity()`。全是纯函数与常量（不碰 `bot`/世界/事件）⇒ 这批名字**没有一个是外部 import 的**，所以 `core.mjs` 只 import、不 re-export |
| `src\log.mjs` | **路线图第 ④ 条的第五刀**：日志基建 —— `stamp()`（本地 `MM-DD HH:MM:SS`）/ `logLevel()` / `logLine()` / `logDebug()` / `logOnce()`（`globalThis` 判重，跨模块实例）/ `appendLog()`（自动建目录 + 轮转）/ `rotateLogIfNeeded()` / `LOG_LEVELS`。**唯一"自带默认值"的一刀**：`logLine` 要写 `DEFAULTS.logFile`，而 `DEFAULTS` 在 `core.mjs` 里 ⇒ 由 `core.mjs` 用 `setDefaultLogFile()` **注入**（不反向 import，避免循环导入）；`MC_LOG_MAX_BYTES` / `MC_LOG_KEEP` 改成轮转时**现读**（这个模块整个进程只加载一次） |
| `src\place-items.mjs` | **路线图第 ④ 条的第六刀**："挑方块 / 垫脚料"那一层 —— `NON_FULL_BLOCK`（形状不是整方块的方块名黑名单：半砖/楼梯/墙/栅栏/地毯/耕地/土路/头颅/铁砧…）、`isFullBlockItem(bot, name)`（三段判据：`boundingBox === 'block'` + `transparent === false` + 黑名单 —— 光看 `boundingBox` 不够，用户 2026-10-06 报的"它搭方块会用非实体方块搭"就踩在这）、`NO_SCAFFOLD`（贵重方块与家当不拿去垫）、`scaffoldingItemIds(bot)`（交给 pathfinder 的 `scafoldingBlocks`，**item id**、按存货多少排序）、`pickPlaceItem(bot, want)`（没点名时**只挑整方块**）。都是"读 `bot` 但不改状态"的纯函数 ⇒ `core.mjs` 照样导出三个公开件（`tools\check-core-place.mjs` 与 `实机验证\搭方块\live-place.mjs` 都从 `core.mjs` 导入） |
| `src\inventory.mjs` | **路线图第 ④ 条的第七刀**：背包那一层（**2026-10-13 加装备栏**：`EQUIP_SLOTS` / `equipmentOf(b)` / `equipmentText(b)` / `equipDestOf(name)`；`inventoryView()` 多一行 `🛡 装备栏`） —— `heldText(b)`（`dirtx18` / `空手`，AI 判断"我手里现在是什么"的唯一来源）、`invSnap(b)` / `invUsed(b, snap)`（走路挖矿前后比"路上用掉了什么"）、`canHarvestNow(b, blk)` / `toolKinds(b, blk)`（手上这叠能不能挖 / 人话版"需要镐／斧／锹"）、`countOf(b, name)`（同名合计，**读不到回 `null`、不是 `0`**）、`freeSlot(b, itemName)`（优先复用同款槽）。这一刀是第一次搬"**读 bot 实时状态**"的东西：只读、不 await、不改状态；签名比原来多一个 `b`（原来是 `this.#heldText(b)` 这种私有方法），`countOf` 在 `core.mjs` 里留成薄包装（公开面一行都没少） **第十九刀又把这层的"动作"也收进来**：`inventoryView(b)`（`mc_inventory` 的正文：同名合计 + 只报一次手上 + 叠数/样数/空位）、`giveItem(b, opts, ctx)`（创造取物，`slot` 钳到 9-44 并如实说被挪过；那格还是空的就**不许**说"已放进背包"）、`clearInventory(b, ctx)`（清完抽查一遍再说结果）、`tossItem(b, opts, ctx)`（按**背包数量差**说丢掉了几个）—— 这四个要发包，所以 `ctx = { t, makeItem }` 由薄包装传进去（`t` 是本轮 11 秒闸门，`makeItem` 是造 prismarine-item；模块自己**不 import 游戏库**） | **第三十二刀**：`equipFor(self, b, blk, label, ctx)`（动手前换对的工具：手上不能挖、或背包里有明显更快的就换；换不上就照旧返回 `changed:false`，调用方按"手上还是不对"如实拒绝）。
| `src\budget.mjs` | **路线图第 ④ 条的第九刀**：单次调用的时间预算 —— `TIMEOUTS`（各类操作的默认超时）、`CALL_MS = 11_000`（硬上限）、`CALL_BUDGET_MS = 10_000`（长动作默认预算）、`callBudget(v)`（钳进 `[200, 10_000]`）、`callDeadline(ms)`、`callSecText()` / `budgetSecText()`（文案秒数跟着常量走）。全是纯常量与纯函数；`setCallDeadline()` / `msLeft()` / `callLeft()` 是**实例状态**，留在 `core.mjs` 的类里。`CALL_MS` / `CALL_BUDGET_MS` / `callBudget` / `callDeadline` 被 `index.js`、4 个扩展、`tools\check-call-budget.mjs` 从 `core.mjs` 导入 ⇒ 七个名字原样 re-export |
| `src\world-observer.mjs` | **路线图第 ④ 条的第十刀**：**只读观察**那一层 —— `entityHealth(b, e)`（读血量，读不到回 `null`，**不编**）、`inWaterNow(b)`（脚在水的 AABB 里**或**眼睛那格是水 —— `entity.isInWater` 浮在水面时读出来是 false）、`slowDigWhy(b)`（"我在水里 / 我在空中，挖方块慢 5 倍"）、`dropsNear(b, radius)` / `dropHint(b, {radius})`（附近还没捡的掉落物 + "东西还掉在地上"那句话）、`blockReachOf(b, blk)`（**眼睛 → 方块中心**，服务端/上游的判据；原来叫 `#reachOf`，改名是为了跟 `mc_craft.mjs` 那个"材料够不够做"的 `reachOf` 分开）、`stateNameOf(b, stateId)`。都是"收 `bot` 当参数、只读、不 await"的模块级函数，只往下依赖 `src\entity-names.mjs` |
| `src\map-render.mjs` | **路线图第 ④ 条的第十一刀**：**地图那一层** —— `isUnderground(b)`、`caveCell(b, x, cy, z, slab)`（洞穴层一格：先看身体那两格、再看脚下）、`heightmapOf(b, {radius, yTop, yBottom, mode, slab})`（俯视地形，自带 2.5 秒软上限）、`glyphMapText(names, step, selfIndex)`（字符图）、`mapImageOf(b, {…, scale})`（RGBA 像素图）。只借 `vec3`（`blockAt()` 要真 Vec3），不反向 import core；`core.mjs` 里留四个同名薄包装（公开面不变） |
| `src\world-scan.mjs` | **路线图第 ④ 条的第十二刀**：**感知的最后两块** —— `scanAround(b, {radius, height, name, limit})`（周围方块：不点名给计数（前 25 种），点名给坐标列表，**按到我的距离升序**取前 N 个）、`entitiesNear(b, radius, {kind, limit})`（附近有谁：分类 / 血量 / 远程标记 / 上下差；血量与距离优先用现成的 `bot.util.entity.*`，助手不在或抛错就退回自己算，**读不到血量就不写这个字段**）。只依赖 `vec3` + `block-names.mjs` + `entity-names.mjs`；`core.mjs` 里留两个同名薄包装（`scan()` / `entities()`，公开面不变） |
| `src\status.mjs` | **路线图第 ④ 条的第十三刀**：**连接/状态视图** —— `connectionViewOf(profile)`（只给 `host` / `port` / `subserver`，**不含账号名与认证模式**）、`statusOf(b, ctx)`（离线分支给 `ghost` / `reconnecting` 与两种提示；在线分支给坐标 / 朝向 / 模式 / 血量 / 饥饿 / 氧气 / 手持 / 在线时长，`submerged` 用"眼睛那格是不是液体"）。**签名比原来多一个 `ctx`**：`sub()`、连接参数、`lastError`、是否在重连、连上时间这些**属于实例、不属于 `bot`**，由 `core.mjs` 的薄包装打包传进来（模块保持"只吃参数"的形状）；`core.mjs` 里留两个同名薄包装（`connectionView()` / `status()`，调用点一行没改） |
| `src\dig-speed.mjs` | **路线图第 ④ 条的第十四刀**：**挖掘速度那一层** —— `digMsFor(b, blk, itemType)`（拿某件工具挖这块要多久）、`fixDigMs(b, blk, itemType)`（上游 108 个方块的 `material` 写成 `incorrect_for_wooden_tool` 的兜底：按原版公式重算，**只往"更快"修**、判定不了回 `null`）、`digToolKindOf(name)` / `digToolSpeedOf(reg, itemType)`（工具种类与品级倍率）、`patchDigTime(b)`（把 `bot.digTime` 换成修过的值，+8% + 60ms 余量）、`bestToolFor(b, blk)`（背包里挖这块最快的那件）。只有 `patchDigTime` 在 `core.mjs` 里留**同名薄包装**（`tools\check-core-digtime.mjs` 六处在调），其余只 import、不 re-export |
| `src\dig-guard.mjs` | **路线图第 ④ 条的第十五刀**：**采集/落地守卫** —— `collectBusy(b)`（`mineflayer-collectblock` 还有任务在跑吗）、`cancelCollect(b, ctx)`（**停掉后台采集任务 + 松控制位**：`cancelTask()` 最多等 `budgetMs`（默认 1500ms），等不到就 `targets.clear()` 清队列兜底，两句告警如实说）、`waitGrounded(b, {maxMs, signal})`（站到地上再动手 —— 人在空中挖方块慢 5 倍）、`withHeld(out, b, before)`（结果里补一行"手上变了"）。**签名多一个 `ctx`**：`this._moveGen` / `#stopPathing` / `#releaseControls` / `this.log` / `this.abortSignal` 都属于实例，由薄包装打包传进来；`core.mjs` 里留**四个同名薄包装**（`#collectBusy` / `#cancelCollect` / `#waitGrounded` / `#withHeld`），调用点一行没改 |
| `src\chat.mjs` | **路线图第 ④ 条的第十六刀**：**聊天记录那一层** —— `wireChatEvents(self, b)`（把 mineflayer 的聊天/系统消息接到实例事件上：签名聊天走 `player_chat`、未签名 `system_chat` 按 positionId 分流、`position:'system'` 还要按渲染形状再判一次）、`plainText(msg)`（去颜色码 §x）、`playerChatFrom(msg, plain)`（认出"玩家在说话"：队伍聊天 / 公屏 / 私聊 / `<名字> 正文` 兜底）、`emitPlayerChat(self, who, text, selfName)`（唯一入口：1.5 秒去重 + 自己说的话不重复记 `player` 那条）、`pushChat(self, kind, who, text)`（按 `cfg.chatHistory` 截断）。**这一层有可变实例状态 ⇒ 第一参数直接收 `self`**（迁移规矩第 20 条）；**第二十六刀**又把 `chatSay(self, text)`（往公屏说话，`/` 开头直接拒）也收了进来，聊天那一层就此完整 |
| `src\camera.mjs` | **路线图第 ④ 条的第十七刀**：**朝向/相机那一层** —— `lookAnglesTo(from, to)`（目标点 → mineflayer 的 yaw/pitch）、`aimAt(b, point)`（**直接写 `b.entity.yaw/pitch`**，绕开会挂住的 `bot.lookAt()`：物理循环在"站着不动/骑乘/刚死"时整个 early return，`await lookingTask.promise` 就永远不 resolve）、`lookAt(b, {x,y,z,who})`（看向坐标或某个玩家/怪物：英文名 / 玩家名 / 中文别名都认，实体表里没有时退回 `b.players`）。**只吃一个 `bot`、不碰实例状态**；`core.mjs` 里留**三个同名薄包装**（`static lookAnglesTo` / `#aimAt` / `async lookAt`），调用点一行没改 |
| `src\server-break.mjs` | **路线图第 ④ 条的第十八刀**：**"服务端到底认没认这次破坏"的判决层** —— `watchServerBreak(b, pos)` 挂原始包监听（`block_change` / `block_update` / `multi_block_change`，位段格式照抄 mineflayer `blocks.js:363-394`），把服务端的话翻成**三态**：`hit()` = 改成了**空气**（真挖掉）、`restored()` = 改成了**非空气**（＝把原方块发回来"复原"，说明服务端**拒了**这次破坏）、其余一律当**没有证据**；`watching === false`（假 bot 挂不上监听）时调用方**别下结论**。`awaitServerBreak(b, watch, {maxMs, callLeft, signal})` 等这份判决（服务端的包**可以晚到约 1 秒**，只 `sleep(200)` 会把好端端挖掉的方块报成"没收到回包"）。**只认服务端的包，不认客户端那个预测的 air**；`core.mjs` 里留**两个同名薄包装**（`#watchServerBreak` / `#awaitServerBreak`），调用点一行没改 |
| `src\world-use.mjs` | **路线图第 ④ 条的第二十刀**（**2026-10-13**：`equip` 支持穿甲/脱甲 —— `to` 指定 `head`/`torso`/`legs`/`feet`/`off-hand`，不写 `to` 按物品名猜，只给 `to` = 脱下来，换下来的报 `swappedOut`）：**“使用/交互”那一层** —— `useBlock(b, {x,y,z,who}, ctx)`（右键方块或实体：开箱子/按按钮/开门/喂动物/上船；**服务端不回执** ⇒ 按“窗口开没开、方块属性翻没翻”复核）＋ `useItem(b, {hold}, ctx)`（对着空气用手上的东西：扔末影之眼/珍珠、拉弓、喝药水；`hold` 最多 3 秒且**给松手包留 400ms**）。两者都要 `ctx.t`（预算闸门）与 `ctx.callLeft`（`useItem` 钳 hold），所以走 `ctx` 不走 `self`；**第二十七刀**又把 `interact(self, args)`（`mc_act` 的 look/place/break/toward 四个 mode 在这里分流）与 `equip(self, opts, ctx)`（装备到手上；`held` 必须**读回来**，换手静默失败要如实说）收了进来 |
| `src\attack.mjs` | **路线图第 ④ 条的第二十一刀**：**攻击那一层** —— `attack(b, {who, budget}, ctx)`（给 `who` 就按英文名/玩家名/中文别名找，不给就打最近的那个：敌对不限距、动物/玩家限 4.5 格、掉落物垫底；**`pvp.attack()` 是立刻 resolve 的后台循环** ⇒ 自己轮询等目标消失，`pvp.stop()` 不 `await`；动手前记血量，回来如实报 `killed`/`targetHealth`/`waitedMs`，地上有掉落物就补一句"先捡东西"） |
| `src\sequence.mjs` | **路线图第 ④ 条的第二十二刀**：**连串动作的调度层** —— `runSequence(self, steps, {stopOnError, budgetMs})`（按顺序跑一串步骤，到点/被打断就停下并给出 `stoppedAt`/`remaining`/`hint`，让模型**从第几步接着发**）+ `runStep(self, s)`（op → 具体动作：wait/move/look/toward/place/break/dig/use/useitem/attack/equip/give/toss/say/jump/swim）。**第一参数收 `self`**（要回调一堆实例方法，见迁移规矩第 27 条）；不为没执行的步骤记 `ok:false`、`move` 的 `ok` 看 `arrived`、步骤自己发现预算用尽一样给 `stoppedAt` |
| `src\pickup.mjs` | **路线图第 ④ 条的第二十三刀**：**捡掉落物那一层** —— `grabDrops(self, b, {radius, budgetMs}, ctx)`（挖完/打完顺手把地上的 `item` 捡回来；**报"捡回几个"按背包差算**，不看 `entity.isValid`；捡不到时**显式收尾** `ctx.cancelCollect({budgetMs:300})`，别让 collectBlock 的实体目标挂着）。收 `self`（要回调 `self.callLeft()` / `self.walkTo()`），私有方法 `#cancelCollect` 由 core 塞进 `ctx`（迁移规矩第 28 条） |
| `src\task-report.mjs` | **路线图第 ④ 条的第二十四刀**：**任务收工报告那一层** —— `taskHave(b, item)`（现场进度：方块名 → 掉落物名 → 背包数量，认不出就如实回 `null`）、`verdictLine(out, okCount, wantTotal)`（把"这一轮成了没"写成**已确认成功 / 动作失败 / 结果未知**三态之一）、`taskSettle(self, task, out, okCount, wantTotal)`（收工处**统一**判失败分类 + 记 checkpoint + 附一行进度）。**同一个模块里三种形状并存**：纯参数 / 纯函数 / 收 `self`（迁移规矩第 17·27·28 条） **路线图第 ④ 条的第四十二刀**：又并进**任务门面** —— `taskStart` / `taskList` / `taskGet` / `taskResume` / `taskNote` / `taskDone` / `taskCancel` / `taskForget` 八个记账动作（全是"读 `self.tasks` 记一笔"，与下面三个同一层）。 |
| `src\observer.mjs` | **路线图第 ④ 条的第二十五刀**：**世界观察器那一整层** —— `invSignature(b)`（背包签名：总数 + 每样多少个）、`observeTick(self)`（每 1s 对比快照，产出 mineflayer 不提供的语义事件：`teleport` >24 格/秒 / `pushed` 没按键却位移 / `pickup` 总数变多 / `playerJoin` / `playerLeave`）、`startObserver(self, ctx)` / `stopObserver(self)`（定时器生命周期；**回调里抛错 = uncaughtException = 宿主进程死**，所以回调自己兜异常、异常交给 `ctx.reportError`）。收 `self`（要读 `self.bot`/`_obs`/`position`/`_selfMovingAt`、要 `self.emit`） |
| `src\plugins.mjs` | **路线图第 ④ 条的第二十八刀**：**vendor 依赖加载器** —— `MC_DEPS`（五个生态插件的清单：包名 / 入口 / 中文说明）、`loadMcDep(key, opts)`（按 ① `DSH_MC_AGENT_MC_DEPS` ② 插件包旁边的 `vendor/mc-deps` 相对路径 ③ `$DSH_HOME\profiles\<profile>\vendor\mc-deps` 绝对路径 ④ 裸包名 的顺序找，`import()` 进来并**只缓存成功**）、`loadPathfinder()`（兼容旧名字）、`resetMcDepCache()` / `resetPathfinderCache()`（自检脚本用）。**这几个名字仍然从 `core.mjs` re-export**（第一版起就是公开导出，调用点一行不用改） |；**第二十九刀**：装配也搬进来了（`setupPathfinder` / `movements` / `setupPlugins` —— 加载器和装配本来就是一件事）
| `src\connection.mjs` | **路线图第 ④ 条的第三十一刀**：**连接与保活层** —— `connect(self, opts, ctx)`（守卫、`force` 强制重连、`attemptOnce` 顶号重试、连上后挂事件 + `setupPlugins` + `writeLock`）、`scheduleReconnect(self, sub, ctx)`（审计 F1：用记下的真参数重连 + 重试上限 + 试满 `emit offline{willReconnect:false}`）、`disconnect(self, reason, {graceMs})`（先优雅后强断）。收 `self`；`DEFAULTS` / 私有 `#reportError` / 三个认证助手走 `ctx`（core 打包成 `#connCtx()`） |
| `src\auth-session.mjs` | **路线图第 ④ 条的第三十刀**：**认证/会话层**（全插件唯一碰凭据的地方）—— `authOnly(self, auth, {onSession})`（只认证不连服；返回值**脱敏**：只有 `ok` / `name` / `uuid` / `hasToken`，完整 session 只走回调）、`makeSession(self, auth)`（账户描述符 → mineflayer 能用的 session：`offline` 自己造、`yggdrasil` 先 `refresh` 失败再 `authenticate`）、`refresh({authUrl, accessToken, clientToken})`、`authenticate({authUrl, authUser, authPass})`、`normalizeBaseUrl(url)` |

| `src\runtime.mjs` | **路线图第 ④ 条的第三十三刀**：**运行时管线** —— `reportError(self, e)`（唯一错误上报口：记 `lastError` + 一行日志 + 只在真有监听者时才 emit，绝不 throw）、`withBudget(self, promise, kind, label, ctx)`（所有打给 mineflayer 的 await 都过它：本轮 abort signal + 本地 deadline 双保险）、`stopPathing(b)`（`stop()` 只置标志，`setGoal(null)` 才走 resetPath）、`interruptMove(self, reason, ctx)`（推移动号 + 停采集 + 松控制位）、`setAbortSignal(self, signal)`（signal 一 abort 就立刻真停）。两个私有件（`#releaseControls` / `#cancelCollect`）由 core 的薄包装包成箭头函数从 `ctx` 递进去。  **第四十一刀**：`holdControl(self, key, ms)` / `releaseControls(self)`（自保反射的控制位**租约**）也并进来了 —— 租约表 `_ctrlLease` 是实例状态留在 `core.mjs`，只有读写搬进模块。 **路线图第 ④ 条的第四十三刀**：又并进两个"跟 bot 打交道的小关口" —— `waitForChunks(self, timeoutMs = 20_000)`（等区块加载，算进本轮 11 秒，用完立刻回 `false`，aborted 就抛中断）、`requireBot(self)`（要一个一定在线的 bot，否则抛出带原因的错；用 `online` 而不是只看 `bot.entity`，认得出幽灵在线）。 |

| `src\build.mjs` | **路线图第 ④ 条的第三十四刀**：**搭建那一层** —— `build(self, opts)`（`mc_build` 的正文：范围 → 一堆坐标 → 逐个 `placeBlock`，自己不放方块）。三条判据：① 只有 `placeBlock` 回 `placed`（复核过真放上去了）才算 placed；② 不给 `name` 时格子已有东西就跳过并如实说；③ 单次调用到点带着已放好的返回，再叫一次同一个范围就行（放对的会跳过）。 |
| `src\movement.mjs` | **路线图第 ④ 条的第三十五刀**：**移动原语** —— `jump(self, ctx)`（原地蹦一下：领 `_moveGen` 号、只在还是自己时才松 `jump`、落地缓冲不超本轮剩余时间）、`swimUp(self, opts, ctx)`（水里按住 `jump` 上浮换气；判据用 `inWaterNow(b)` 而不是 `entity.isInWater`）。大件（`walkTo` / `#walkPathfinder` / `flyTo` / `#walkSwim`）按路线图留到最后；**第三十六刀**把移动主体（`walkSwim` / `walkTo` / `flyTo`）搬了进来；**第三十七刀**把 `walkPathfinder`（移动最后一块：事件监听 / 移动编号 / 控制位租约）也搬了进来 |
| `src\mining.mjs` | **路线图第 ④ 条的第三十八刀**：**挖掘那一层** —— `breakBlock(self, {x,y,z}, ctx)`（`mc_act {mode:"break"}` 的正文：按坐标破坏一块方块）。**第四十刀**：`dig(self, {name,pos,maxDistance,count}, ctx)`（`mc_dig` 的正文）也并进来了 —— 一条路，没有兜底：`interruptMove` 领号 → 列目标（`findBlocks` 按距离从近到远）→ 生存模式先查工具 → 够不着先 `walkTo` 过去再复核 → 等落地 → 换工具 → 时间够才 `bot.dig` → 认服务端的破坏回包（空气＝挖掉、非空气＝复原）→ `ctx.grabDrops` 捡掉落物；`count >= 4` 时自己开一条任务（`self.tasks`）并按成功点记进度，收工 `ctx.taskSettle` 分类失败 + `ctx.verdictLine` 出判决行。六条判据：① 够不着（`blockReachOf` 眼睛→中心 > 4.5 / 创造 5.0）**不动手**；② 没落地（空中挖慢 5 倍）**不动手**；③ 动手前 `ctx.equipFor` 换对的工具，换不上**直接拒绝**（不硬挖）；④ 时间不够（`digMsFor` + 900ms 余量）**不开始挖**（挖一半到点松手 = 破坏进度清零）；⑤ 服务端的判决才是判决（`ctx.watchServerBreak`：改空气＝挖掉、改非空气＝**复原**、其余＝没证据）；⑥ 超时**不等于**没挖掉，多等一会儿服务端包再复查。自己不放方块、不碰 `this`（`self` 只读 `callLeft`/`log`/`requireBot`，五个私有件走 `ctx`）。 |
| `src\place.mjs` | **路线图第 ④ 条的第三十九刀**：**放置那一层** —— `placeRef(self, pos)`（在目标格的 6 个邻居里找可依附的面，顺序是下→上→±x→±z，要 `boundingBox === 'block'`）+ `placeBlock(self, {x,y,z,name}, ctx)`（`mc_build`/垫脚/放工作台都走它）。七条判据：① 背包空且没点名 ⇒ 直接说"背包是空的"；② 点了名却没有 ⇒ 说缺哪个；③ 创造模式先 `self.giveItem` 取物；④ 目标格已被占住 / 没加载 ⇒ 不动手；⑤ 够不着先 `walkTo` 走过去；⑥ **悬空**（6 个邻居都没依附面）时先在自己**脚下那格**垫一块再重找；⑦ 放完**回读** `blockAt`，还是空气就报 `placed:false`（服务端拒了就把英文原文翻成"离得有点远/可能被挡"）。自己不放方块（真发 `place_block` 包的是 `b.placeBlock`），不碰 `this`（`self` 只读 `requireBot`/`giveItem`/`walkTo`/`flyTo`/`_selfMovingAt`，预算闸门 `#t` 走 `ctx.t`）。 |
| `src\task-runner.mjs` | **可恢复的任务状态机**（路线图第 ③ 条）：只记账、不碰 mineflayer、不下发动作；任务落到 `<记忆根>/tasks.json`（tmp + `renameSync` 原子替换，坏了从空表开始，最多留 24 条）；十类失败分类各带"下一步该干什么"，**`budget`/`timeout`/`preempted` 不进循环检测**（长活儿跑三轮很正常）；同一动作同一原因连着 3 次 ⇒ `blocked`；`resume()` 用现场背包复核进度并给出下一个工具调用；**三种结局**（路线图第 ⑥ 条）：`outcomeOf()`/`verdictText()` 把动作结果判成"已确认成功 / 动作失败 / 结果未知"—— **时间到 ≠ 没做成**（那一镐可能已经挖下去了），"未知"要模型先看一眼再决定、别直接重做 |
| `src\memory.mjs` | **长期记忆分四类**（路线图第 ⑤ 条）：世界事实 `world.md` / 操作经验 `lessons.md` / 任务记录 `tasks.md` / 用户规则 `RULES.md`（**受保护、只读**）；每条带"来源 · 更新时间 · 成功/失败次数 · 适用版本 · 发生条件"；同 key 再记**累加次数**而不是新增一条；**`ok:false` 不给 `condition` 直接拒收**（失败必须写清"什么条件下会失败"，不许写成"X 永久不可达"）；`parseEntry()` 能读回元数据，老格式的自由 bullet 不受影响 |
| `src\watchdog.mjs` | 唤醒矩阵新增 `wakeOn.anyChat`（默认开，任何玩家说话都叫醒）；掉血提醒里补一句"我在水里：可能是憋气"；**注入失败会留话**（打断只在注入成功之后做，失败走 `#injectFailed` 写进 `mc_events`）；被闸门挡下的唤醒真的记进 `stats.suppressed`；`LABEL` 补 `disconnect` |
| `index.js` | 记忆根/按会话分（含打断硬链接）；**规则只投一行指针**（`rulesPointerText()`：`RULES.md` 与 `版本提示.md` 的正文都不再进提示词，会话自己去读）；`/api/mc/agents-md` 支持 `target:"version"` 改版本提示文件；启动行带版本号；噪声降级 + `logOnce` 去重；`mc_entities` 参数与输出补强（**没有另开 `mc_mobs`**；**2026-10-08 该工具已下掉、并进 `mc_observe` 的三段式感知**）；`mc_act` 加 `useitem`（对着空气用手上的东西：扔眼睛/射箭/喝药水）；**`mc_act` 的 `break`/`place` 与 `mc_move`/`mc_build`/`mc_dig` 描述里写明会自动换工具、结果带 `held`/`used`/`pillaredWith`**；`mc_move` 加 `mode:"swim"`（**给坐标=游过去，不给=只上浮**）；**`mc_map` 在地下自动切洞穴层**（`mode`/`slab`，顺手修掉图例一直打 `[object Object]`）；**省 token**：`mc_status`/`mc_entities`/`mc_events`/`mc_map` 默认只回紧凑文本；**会话/状态层审计（F1–F12）**：事件带单调 `seq`（队列满 200 条也能等到新事件）、`peek` 与消费同方向、`mc_diag` 不再在幽灵在线时报 `online:true`、`mc_ping` 回传生效超时、`mc_lan` 会报 warning、`mc_config` 只读不挂看门狗、`mc_disconnect` 三态、`mc_capabilities` 的路径脱敏成 `$DSH_HOME/...`；**新增 `mc_task`**（长活儿进度台账：`list`/`get`/`resume`/`note`/`done`/`cancel`/`forget`），`asTool` 每次调用顺手喂一次记忆根（`setTaskDir()`），工具数 28 → 29；**`mc_kit_memory` 新增 `kinds`/`record` 两个动作**（记忆四分类 + 元数据，来源参数叫 `from` —— `source` 这个名字留给 `put` 传工作区源文件路径）；**`withOutcome()`**：给动作结果统一补 `outcome`/`outcomeText`（三种结局） |
| `src\version-prompt.mjs` | 版本提示从"硬编码字符串"变成**记忆根里的真文件 `版本提示.md`**（读/写/恢复默认/按版本同步；用户能在设置页直接改） |
| `src\agentsmd.mjs`、`src\protected.mjs`、`src\wsconfig.mjs` | 行事准则文件（`RULES.md`，2026-09-16 从 `AGENTS.md` 改名，免得被宿主当指令文件投两遍）；受保护文件名单加了 `版本提示.md`，**2026-10-08 又加了记忆写动作 `record`**（新写动作必须登记，否则 guard 不检查它）；工作区配置多了 `versionPromptVersion` 标记 |
| `selfcheck.mjs` | 跑之前截断自己的 `logs\selfcheck.log`；**任何 ❌ 就 exit 1**（以前永远 exit 0，❌ 会静默腐烂） |
| `extensions\mc_observe.mjs`、`mc_view-render.mjs`、`mc_skin.mjs` | 第一人称截图（门禁默认关，AI 自主决定何时看）、**三段式感知**（我看到 / 程序检测到 / 不确定，`percept:false` 可关；实体信息并进来了）、**统一感知**（一次给齐坐标/朝向/血量/饥饿/氧气/手持/背包/附近实体/目标方块 + `capturedAt`；`image:false` 不画图只要结构化状态）、纯函数渲染内核、皮肤下载/解码/UV 采样 |
| `extensions\mc_auto.mjs` | 自主行动层：待机唤醒、长期目标、**被打了只叫醒 AI 定策略（不自己跑也不还手）**、**在水里憋气（头在水下）也叫醒 AI 上浮**、反射层换成现成插件 |
| `extensions\mc_craft.mjs`、`mc_furnace.mjs`、`mc_chest.mjs` | 合成（掐断后自动关窗口把材料收回背包、**动手前先 `_syncWindow` 跟服务端对账再把 2×2 合成格里的东西点回背包**、同一个 bot 不并行两条合成链、**缺料时报整条链条 + "要同一种木头"**、`count` 已经够了就如实说"一个都没做"（`more:true` 才是"再做 N 个"））、熔炼（按数量挑正经燃料、装好料就返回）、存取箱子 |
| `extensions\mc_util.mjs` | 扩展共用件（**不是扩展**）：名字/id 互转、`countOf`、`clamp`、放得下吗、`findPlaceSpots()`（放熔炉被服务端拒时能换下一个点位重试）… 原来 `clamp` 抄了 4 份、`countOf` 抄了 3 份，而且箱子/熔炉要去 `import` 合成模块（方向不对） |
| `vendor\mc-deps\...` | 给 `mineflayer-pathfinder`（2 处）和 `mineflayer-tool`（1 处）打的补丁，见 PATHFINDER.md |

## 各功能怎么用

### 记忆根搬出工作区（`memoryDir`）

用户要求"工作区里别再冒出插件的东西"，所以把记忆根挪到插件自己的家：
`%USERPROFILE%\.dsh\dsh-mc-agent\memory`（工作区 `%USERPROFILE%\Desktop\agent` 里不再有 `.dsh-mc-agent\`）。
代价：`memoryDir` 是全局的，所有工作区共用一份。写死 `<工作区>/.dsh-mc-agent` 的地方都改过了
（三个扩展走 `memoryFor(ws).root`；宿主 `index.js` 的出图路径、文件工具守卫、注入的「长期记忆」提示）。
老世界的记忆归档在 `<memoryDir>\_archive\旧世界-192.168.1.104\`。

### 记忆按会话分（`memoryPerSession`）

打开后某个会话的记忆落在 `<memoryDir>\sessions\<短会话 id>\`（会话 id 去掉 `session-`、留 24 字）。
新会话根会从**基根播种** `RULES.md`/`版本提示.md`/`config.json`/`auto.json`/`view.json`（你改过的 `RULES.md` 会带过去），
插件自己写的 `README.md` 和旧世界存档目录不播种；只拿得到工作区路径的调用点靠 `lastAgentByCwd` 兜底。
**默认关**（关着时行为与以前一字不变）—— 上游 `selfcheck.mjs` 有 5 处靠"删掉 `DSH_MC_AGENT_MEMORY_DIR`
⇒ 记忆根跟着工作区"来断言，默认开会把上游自检打穿。回归：`check-session-memory.mjs` 13/0。

### 看图门禁默认关（AI 自主决定何时看）

`mc_observe` 的门禁**机制保留、默认不生效**：门禁总是注册、每次判定时现算，所以
`view.json` 写 `{"gate":true}` 就能当场变回强制模式（不用重启）。强制模式下的尺度是
"看一眼可做 N 个动作 / T 秒"（默认 4 个 / 60 秒）。叫醒文案里 `mc_observe` 写成"需要就看一眼"，不强制。

### 玩家在游戏里说话，AI 要能立刻被叫醒（`wakeOn.anyChat`）

用户报"我游戏里输入的它好像看不到了"，定位出来是两件事叠在一起：①唤醒条件一条都没命中 ——
玩家切旁观模式后 `bot.players[who].entity` 是 `undefined`，`nearbySpeech` 永远不成立，而那两句话里又没点名；
②后来机器人**根本不在游戏里**（用户按了"强制停止"，`stopSession` 第 ③ 步就是 `bot.disconnect`）。

- 改法：唤醒矩阵新增 **`wakeOn.anyChat`（默认开）** —— 任何玩家在公屏说话都叫醒，标签「有人说话」，
  仍受 `maxWakePerMinute` 限流；优先级 **点名 > 身边有人说话 > 兜底**。嫌吵用
  `mc_config {"wakeOn":{"anyChat":false}}` 关掉（关掉后照样记档，`mc_events` 仍看得到）。
- **"强制停止"的语义没动**（用户明确要求维持原样）：停止 = 停 LLM + 拆看门狗 + **优雅退出游戏**，
  所以按过停止之后游戏里说话它是听不到的，得先让它连回来。
- 回归：`check-watch-chat.mjs` 21/21，另在 `selfcheck.mjs` 里补了 4 条唤醒矩阵断言。

### 会话/状态层不再给 AI 一个"看起来正常"的错误世界（审计 F1–F12）

2026-10-08 拿子代理把**会话/状态层**（`mc_status`/`mc_diag`/`mc_connect`/`mc_events`/`mc_lan`/`mc_ping`/
`mc_config`/`mc_capabilities` + `src\watchdog.mjs` 的唤醒注入链）整条审了一遍，12 条 bug 形状完全一样：
**只有主路径判了状态，旁路没判**。它们都不崩，而是让 AI 拿到一个自洽但错误的世界观。最要命的两条：

- **自动重连永远连不上**：`#scheduleReconnect(sub)` 把**子服名字符串**当 opts 传给 `connect()`，
  而 `connect` 读的是 `opts.host` / `opts.auth` ⇒ 每次必抛 `缺少登录账户…`，再被 catch 无限重试。
  看门狗还照着注入"插件正在自动重连，先别再操作角色" ⇒ **AI 停手死等一个永远不会来的重连**。
  现在连接成功前记下 `_connectOpts`（含 auth，只存内存、不进任何工具返回），重连用它；
  重试有上限（`maxReconnectAttempts`，默认 5），耗尽或没登录参数时如实回 `willReconnect:false`。
- **长挂机时 `mc_events {waitSec}` 永远等不到新事件**：事件队列满了从**头部** `splice`，
  而 `waitSec` 拿 `events.length` 当游标 ⇒ 饱和时 `slice(200)` 恒空。现在每个事件带单调 `seq`，
  按 `e.seq > fromSeq` 判新鲜度。

其余：`mc_diag` 在"幽灵在线"（`_client.ended` 但 `bot.entity` 还在）不再报 `online:true`；
看门狗注入失败**不再"先打断等待、然后什么都不给"**（改成注入成功后才打断，失败写进 `mc_events`）；
`peek` 与消费统一成"最早的先出"并写进描述；`mc_lan` 的 socket 错误不再吞成"没听到"；
`mc_ping` 回传**生效**超时（传 50 时不再回传 50）；`LABEL` 补 `disconnect`；
`stats.suppressed` 不再恒 0；`mc_disconnect` 区分"关不掉"和"本来就没挂"；
`mc_config` 只读时不再凭空创建看门狗；`mc_capabilities` 的路径字段脱敏成 `$DSH_HOME/...`（不再泄露家目录）。

- 回归：新增 `check-audit-session.mjs` **44/0**，其中四条是**真跑**的行为断言（满 200 条仍能等到新事件、
  非法多播组会报 warning、`statusPing({timeoutMs:50}).timeoutMs === 1000`、`redactPath` 真换前缀）。
- 细节：见 [踩坑档案.md](踩坑档案.md) 第 33 条。

### 看得见附近有谁（实体列表已并进 `mc_observe` 的三段式感知）

> **2026-10-08 更新**：`mc_entities` **工具已经下掉**，实体信息并入 `mc_observe` 的
> 「🎯 程序检测到」那段（同一次调用同时给你截图 + 朝向 + 实体 + 手持 + 血量/饥饿 + 准星方块 +
> 哪些信息不确定）。下面的分类/血量/排序判据**一个字没变**，还是 `src\core.mjs` 的 `entities()`，
> 只是出口从独立工具换成了感知块 —— 少一个工具 = 少一份固定前缀，也少一次调用。
> 细节见「三段式感知」那一节。

以前 AI 想知道"骷髅在哪"只能靠 `mc_observe` 看截图，或者用 `mc_scan` 扫方块 —— 实体没有正经出口。
上游**本来就有** `mc_entities`（`bot.entities(radius)`），但只给"名字 / 类型 / 坐标 / 距离"；
当时**就地把它补强，没有另开平行工具**（两个重叠的工具只会让模型挑花眼）。
**不用自己算**：mineflayer 内核本来就把周围实体放在 `bot.entities`（服务端 spawn / teleport /
relative-move 包喂进去的），每条都带 `.name`/`.position`/`.kind`/`.metadata`；这里只是"读出来 +
分类 + 排序 + 截断"的薄封装。

- 数据源：`entities(radius, {kind, limit})` —— `kind` 取 `all`/`hostile`/`player`/`mob`，`radius` 默认 24
  （钳在 1..128），`limit` 默认 40（最多 64）。返回每条的**名字、坐标、距离、上下差、血量、是不是远程**，
  外加"自己 + 各分类计数"。**只读**：不碰世界、不按控制位，也不受看图门禁限制。
- **血量走现成的助手**：mineflayer **不给别的实体**暴露 `.health`（只有 bot 自己的），所以接的是
  `@nxg-org/mineflayer-util-plugin` 的 `bot.util.entity.getHealth(e)`（`mineflayer-auto-eat` 的依赖，
  加载 auto-eat 时 `bot.loadPlugin` 进来的；它按版本挑 metadata 槽位，1.17+ 用 9）。距离同理走
  `bot.util.entity.entityDistance(e)`。**助手不在或抛错时退回自己算**（`e.position.distanceTo`），不炸。
- 判据：`HOSTILE_RE` 名单命中 **或** `e.kind === 'Hostile mobs'` ⇒ 敌对；有 `username` 就是玩家
  （名字里带 skeleton 也不会误判）；远程名单 `RANGED_RE` 与 `extensions\mc_auto.mjs` 的
  `HOSTILE`/`RANGED` **逐字一致**（套件里有一条断言钉死，防止两份名单漂移）。
- 回归：`check-core-entities.mjs` 46/0。

### 三段式感知：一次调用里分开"我看到 / 程序检测到 / 哪些不确定"（2026-10-08）

用户原话："不要只让 AI 看截图，也不要只让 AI 读取方块坐标。把截图、朝向、附近实体、手持物、血量、饥饿度
和目标方块合并成一次感知结果。让 AI 能判断**我看到什么、程序实际检测到什么、哪些信息不确定**。"

以前 `mc_observe` 给的是**混在一起**的一段摘要：图里数出来的命中率、`blockAt` 读的准星、`bot.entities` 的列表、
`status()` 的血量 —— 谁是哪来的、哪条可能过期，模型只能猜。现在同一次 `mc_observe` 调用会多出**三段**：

| 段 | 内容 | 来源 |
| --- | --- | --- |
| 👁 **我看到** | 命中/天空/未加载占比、画面里最多的方块、准星压在什么上、图右下角手里是什么、脚下是什么、图里几个实体 | **只从渲染出来的那张图**数出来（`frame`），不看游戏数据 |
| 🎯 **程序检测到** | 我的坐标/朝向/维度/时间、**独立射线**打到哪块方块、N 格内实体分类计数 + 逐条（名字/坐标/距离/上下/血量）、生命/饥饿/模式/手持、脚下·脚内·头上一格·正前方一格 | 游戏数据：`bot.entity`、`bot.world.raycast()`、`entities()`、`status()` |
| ⚠️ **不确定** | 最多 6 条（超了留前 5 + 最后 1），按重要性排 | 上面两段各自的"盲区" |

**为什么要两套射线**：渲染内核自己 `castRay` 出一条准星结果，程序侧再调
`bot.world.raycast(eye, dir, distance)`（prismarine-world 的 `RaycastIterator`）打一条 —— 两者都指向同一块方块时
文本写"（和渲染一致）"，不一致时点名"（**渲染说 X**）"并进不确定清单。**以程序射线为准**（渲染图是按方块数据
重建的，程序射线读的是 mineflayer 手里的世界）。这一条是给"图看着像但数据不是那样"准备的保险。

**不确定清单里写死的几条**（都是真的会坑到模型的）：① 方块世界是**客户端预测**的 —— 服务端没认的破坏会"复原"
（就是挖矿复原那个 bug 的教训，看着挖掉了其实没挖）② 画面里没加载的区块占比 ③ 准星撞在未加载区块上
④ N 个实体读不到血量（如兔子）⑤ 还有 N 个更远的实体没画（图只画最近的 96 个）⑥ 地上有 N 个掉落物（同步延迟）
⑦ 程序射线没跑出来 / 两套射线不一致 ⑧ **图是按方块数据重建的，不是游戏真实画面**（没有真实光照/粒子/手臂动作）。

**开关**：默认开。`percept:false` 退回原来的**一段式旧摘要**（省 token）；`entities:false` 现在**两段都不收集实体**
（以前只关图里的，程序侧还照列，两段对不上）。工具总数因此从 29 变 28 —— `mc_entities` **下掉了**，
实体信息全并进第二段（同一份 `entities()` 判据，功能没损失，还少一份固定前缀）。

- **回归**：`check-mc-observe-host.mjs` **72/0 → 96/0**（`--gate-on` **86/0 → 110/0**）、`check-token-budget.mjs`
  **32/0 → 33/0**、`check-core-entities.mjs` 46/0、`check-mc-auto.mjs` 233/0；`selfcheck` 的工具数断言 29 → 28。
- **实机验证**：`实机验证\感知\live-percept.mjs`（账号 `wcpercept_live`）**26/0**，证据：程序射线
  `grass_block @ (-38,64,39) face=1` 与渲染准星 `grass_block 1.7 格` 打在同一块方块、文本写"和渲染一致"；
  `24 格内实体：敌对 0 ｜ 玩家 0 ｜ 其它 2`（两只兔子，读不到血量 ⇒ 不确定清单如实写"3 个实体读不到血量"）；
  `percept:false` 退回旧摘要；`entities:false` 两段都说"这次没收集实体"；PNG 9424 B 落盘。
- **🔴 这两个 bug 是实机才抓到的**（离线套件全绿，因为假件刚好也有同样的缺陷）：① 感知块里
  `bot.entities(...)` 调的是**裸 mineflayer bot**，而它的 `.entities` 是**实体映射对象**（渲染要用），
  真服上永远报 `bot.entities is not a function` ⇒ 改成调**会话上的 McBot**（`sess.bot.entities(...)`）并加
  `typeof !== 'function'` 兜底；② `world.raycast(from, dir, …)` 内部用 `pos.plus()`/`dir.scaled()`，
  **必须喂真 Vec3**，传 `{x,y,z}` 直接抛 `this.pos.minus is not a function` ⇒ 改成
  `new (bot.entity.position.constructor)(…)`。细节见 [踩坑档案.md](踩坑档案.md) 第 41 条。
- **顺手改的**：`mc_observe` 描述从 1,678 字符压回 ≤1,600（单个工具上限），四个参数说明也缩短了。

### 统一感知：一次调用 = 截图 + 坐标/朝向 + 生存状态 + 背包 + 附近实体 + 目标方块（2026-10-08 第二次升级）

用户原话（路线图第 1 条）："不要只让 AI 看截图，也不要只让 AI 读取方块坐标……**截图不应该每次都强制生成**。
没有视觉需求的普通寻路、换工具、整理背包，直接用结构化状态即可。"

上一节解决的是"**哪条信息是哪来的**"（图里数的 / 程序读的 / 不确定的）；这一节解决的是"**一次调用要凑齐多少东西**"。
以前模型想判断"我现在能不能挖这块矿"，得连着调 `mc_observe`（图）+ `mc_status`（血/饿/氧气）+ `mc_inventory`（镐/空位）
+ `mc_entities`（附近的怪）—— 四次调用、四份各自有时差的快照，还要自己对齐。现在**一次 `mc_observe` 全给**：

| 字段 | 内容 | 备注 |
| --- | --- | --- |
| `capturedAt` / `capturedAtLocal` | 这份快照的采样时刻（毫秒 + 本地 `HH:MM:SS`） | 防"把三轮前的截图当现在"；文本第二段标题也带采样时间 |
| `position` / `facing` / `yawDeg` / `pitchDeg` | 坐标与视角 | 渲染与程序射线共用同一组 yaw/pitch |
| `health` / `food` / `air` / `submerged` | 生命 / 饥饿 / 氧气 / 头是否在水下 | `air` 读不到就是 `null`（这个服的 `oxygenLevel` 有时读成 null） |
| `heldItem` / `gamemode` / `inventory` | 手持 / 模式 / 背包（同名合计、按数量降序，带 `stacks`/`kinds`/`free`） | 背包没空位会写进不确定清单 |
| `targetBlock` | 程序射线打到的方块（坐标 + 面） | 与渲染准星互证，不一致会点名 |
| `visibleEntities` | N 格内实体（名字/坐标/距离/上下/血量，按 `kind` 分类） | 走 `src\core.mjs` 的 `entities()`，与待机层同一份判据 |
| `image` | `{width, height, bytes, renderMs}` 或 `null` | 不画图时是 `null`，**不是**"截了但没截到" |
| `uncertainties`（别名 `uncertain`） | 不确定清单 | 8 类盲区，见上一节 |

**`image:false`：这次不画图。** 纯寻路、换工具、整理背包、查背包数字这类不需要看画面的活，
调 `mc_observe {"image":false}` 就只回结构化状态 —— 不渲染、不落盘、不生成附件（省几百毫秒和一张 PNG）。
两条硬约束：① `image:false` 与 `percept:false` **不能同时给**（那样什么都不剩了，直接报错）；
② **`image:false` 不算"看过画面"**，门禁开着时它糊弄不过去（想动手还是得真看一眼）。

体积：加 `image` 参数和这些字段后，`mc_observe` 的描述 + 参数静态体积 **1,565** 字符（单工具上限 1,600）；
顺手把两段门禁说明压短约 118 字符，全局合计回到 18,000 以内。

### 打怪与保命（被打了只叫醒 AI，反射层不自己跑）

用户报两次：先是"刚刚遇到怪了，但是他动了一下不动了，应该是 move 的时候冲突了。被攻击先逃跑，
让 ai 决定用那种策略"，随后补一句"别忘了还有远程攻击的怪物"。**两个根因**：

1. **移动冲突**：`#walkPathfinder` 的 `finally` 原来**无条件** `b.pathfinder.stop()` + 松控制位，而自主层的
   逃跑和 AI 那一步的 `mc_move`/`mc_dig` 共用**同一个** `bot.pathfinder` —— 先结束的那份把另一份一起停掉，
   于是"动了一下就不动了"。现在每次移动**领号**（`_moveGen` / `#beginMove()`），收尾时只有"号还是最新的"
   才允许动 pathfinder 和控制位；`interruptMove(reason)` 负责抢占（停 pathfinder + 停采集 + 松控制位，
   立刻返回），被抢占的那次 `walkTo` 如实返回 `reason:'preempted'`，hint 写明"再叫一次 mc_move 接着走，
   **不是走不通**"。（这套机制现在只给 `mc_dig` / `mc_craft` 抢占用 —— 自保已经不抢了。）
2. **反射层没有真正的自保**：原来只有"血 ≤ 7 且 8 格内有敌对 → 往反方向走 7 格"，而且每 tick 无条件跑、
   不看 AI 有没有正在动手。

**随后又改了一次**（用户 2026-10-06："既然选择可以获取怪物位置，把受到攻击自动跑离开去掉。"）：
反射层**不再替 AI 移动**，只报信。

现在的行为：

- **判据**：`entityHurt`（挨打的是自己）+ **掉血 ≥ 0.5 也算挨打** ⇒ `hurtRecently`（4 秒内）。威胁 =
  22 格内的敌对实体：近战 ≤ 8 格；远程（骷髅/流浪者/沼骸/掠夺者/卫道士/女巫/烈焰人/恶魂/守卫者/潜影贝/
  羊驼/幻术师/唤魔者/旋风人/凋灵/溺尸）≤ 22 格**且看得见我**（`losBlocked()` 查视线，隔墙不算威胁）。
- **A 不自己跑、不抢控制权**：挨打/怪贴上来时反射层**不动位置**（不调 `walkTo`、不调 `interruptMove`），
  只把**怪名 + 坐标 + 距离 + 血量 + 我手上/我在哪**报给 AI。原来那套"撤 8 格 + 远程优先挑掩体 + 看不到怪
  就 blindSpot 先离开原地"的代码（`fleeSpot`/`blindSpot`/`groundYAt`）已整体删掉，套件里有静态断言钉死。
- **B 叫醒 AI 定策略**：`wakeForDanger()` 立刻 steer 一条 `【自保：…】`，文案里写明"**我这次没有自己跑、
  也没打断你手上的动作** —— 打、撤、躲、垒墙都由你定"，并给三个选项（还手
  `mc_act{action:"attack",who}`、撤 `mc_move` 或 `mc_act{toward,who:玩家}`、躲起来 `mc_build` 挡视线或
  挖洞）+ "选一个直接做，不用问我"。挨了打却看不到怪（隔墙/超远射）时，除了点明"多半是远程怪隔着墙"，
  还会把**上次看到它在哪**报上去，并让它用 `mc_observe {"distance":48}` 看「程序检测到」那段自己定位。
  只受 15 秒间隔 + 每小时配额限流，**不受空闲间隔/退避限制**。
- **C 没人值守也只记档（反射层永不还手）**：没有 steer 通道（没人值守 / 本小时叫醒配额用完）时，反射层
  **既不移动也不还手**，只把这次挨打记进 `stats.alerts` 和日志。原来那套"叫不醒就自己判断打得过打不过"
  的兜底（`judgeFight()` + `NEVER_FIGHT`/`MELEE_EASY`/`WEAPON`/`TIER` 名单 + `weaponInHand`/`weaponInBag`/
  `holdWeapon`）已整段删掉，套件里有静态断言钉死。打不打全由 AI 定。
- **不打扰**：AI 正在动手（`s.inFlight > 0`）且怪没贴到 4 格内、也没挨打 → 连叫醒都不叫，让它把这一轮跑完。
- **危险方块是唯一还会动的情况**：岩浆/火/仙人掌踩在脚下/身上仍然按后退（岩浆再加跳）—— 这条不能跟着
  一起删，站着不动会死。
- `mc_auto status` 显示 `｜自保 开（被打了只叫醒 AI，不自己跑也不还手）｜自动穿甲 开`，
  累计 `｜自保提醒 N（叫醒 M）｜脱险 N`。

**实机验证**（`实机验证\打怪\live-pve.mjs`，2026-10-06，真服 `127.0.0.1:25565` + 真怪 + **产品里那份**
`extensions\mc_auto.mjs`，只把宿主 ctx/api 换成最小假件，`agent.steer` 收到什么就原样打印）。
最近这一轮（**去掉自保移动 + 去掉兜底还手之后**）跑的是 `--seconds=180 --observe=20`，夜里被骷髅射、
被蜘蛛追：

- **阶段 2（找怪路上）真的挨了打**：骷髅把血从 20 打到 **9/20**，反射层**叫醒 AI 1 次**
  （`stats.dangerWakes: 1`），文案含血量 / `mc_act {"action":"attack"}` / "不用问我"；
  怪名是 false —— 那一次走的是"**挨了打但看不到怪**"的 blind 分支（隔墙/超远射），文案写的是"看不到怪"。
- **A 有人值守**（20 秒观察窗口）：抢占 **0**、自己撤 **0**、还手 **0**、移动 **0.0 格**；
  窗口末尾脚本伪造了一次 `entityHurt`，但距上次叫醒不到 **15 秒**（`DANGER_WAKE_GAP_MS`）⇒ 被**限流**，
  只在 `stats.alerts` 上留痕、没有重复刷 AI。限流按设计生效。
- **B 没人值守**（`agent.steer` 拿掉）：抢占 **0**、自己撤 **0**、还手 **0**（`attack` 调用 0 次）。
  这一轮**被蜘蛛咬死了一次**（血 20 → 0）—— 没人值守时反射层只记档，这是设计，不是漏跑。
- `stats`：`{"wakes":0,"dangerWakes":1,"alerts":5,"nudges":0,"looks":0,"watches":0,"eats":0,"pickups":0,
  "escapes":0,"follows":0,"denied":0}`、`lastError: null`（旧版本那几轮"自己跑 6 次"的记录作废）。
- 顺带：脚本现在**手里已经有剑就跳过备料**（不再为了测一次砍一棵树）；被咬死掉了剑才会重新备料。

**上一轮（还会自己跑的旧版本）**挖出踩坑档案 **第 11 条**：那次"连叫 19 次 `mc_move` 都秒返回
`moved=0`、`reason:goal_reached-but-far`"不是走不通，是**自主层那次撤退到点了**，而 vendor 的 `goto.js`
把**全局** `goal_reached` 一起 resolve 给我了。（现在自保不移动了，这条只在 `mc_dig`/`mc_craft`
抢占时还会遇到。）

回归：`check-mc-auto.mjs` **224/0**（3.5 节 18 条，含静态断言"自保段里没有 `walkTo` / `interruptMove` /
`fleeSpot` / `judgeFight`"；3.6 节 14 条憋气）+ `check-call-budget.mjs` **111/111**（⑩ 移动抢占 17 条 +
⑩.5 三条"别人的 `goal_reached` 不算我走到了"）。

### 打了半天其实一下都没打（`pvp.attack()` 立刻 resolve）

用户报过："现在攻击用不了"（2026-10-08）。插件日志里没有攻击记录（attack 不写日志），但会话转写里
AI 打一条 **0.6 格**外的船，返回 `attacked: oak_boat`，而**船一点没坏** —— 它自己都得出
"the attack didn't work"。

根因在 vendor 那份 `mineflayer-pvp`（`lib/PVP.js:60-76`）：`attack(target)` 只做三件事 ——
`await this.stop()`、`this.target = target`、`pathfinder.setGoal(new goals.GoalFollow(target, followRange), true)`、
发 `startedAttacking` 事件，**然后立刻 resolve**。真正挥拳的是 `physicTick` 上的后台循环
（`PVP.js:51` `bot.on('physicTick', () => this.update())`）。

我这边（m00589 把自保层换成现成插件时）写的是
`await raceAbort(withTimeout(b.pvp.attack(target), bd, '打怪'), this.abortSignal, '打怪')`，
`finally` 里再 `b.pvp.stop()` ⇒ **一毫秒就返回**，`stop()` 又把刚设好的"追过去"的 goal 停掉：
**一下都没打，却回 `attacked: X`**。上游原版用的是 mineflayer 自带的 `bot.attack()`（单次挥拳、
4.5 格内真能打中）—— 换成 pvp 时我把"后台循环"当成了"同步动作"。

改法（`src\core.mjs` 的 `attack()`）：

- 还是 `await b.pvp.attack(target)`（它负责设目标 + 追过去），但**之后自己等**：
  `while (Date.now() - t0 < bd) { if (!b.entities?.[target.id] || target.isValid === false) break; await sleep(120) }`
  —— 目标从实体表里没了（打死/跑远出加载）或这一轮的时间用完才收工。
- `finally` 里 **`Promise.resolve(b.pvp.stop()).catch(() => {})`，绝不 await**：`stop()` 里
  `onceWithTimeout('path_stop', 5000)` 最多等 5 秒，await 它就把整轮预算吃光（pathfinder 的 stop
  在它第一行就已经做了）。
- 返回值如实：`killed`（目标还在不在）、`waitedMs`、血量有变就 `targetHealth: "10 → 4"`
  （读不到就不报，走新增的 `#entityHealth()`）；两种 `note` —— 进了攻击距离（`b.pvp.wasInRange`）是
  "打了 N 秒还没打死，再叫一次 `mc_act{attack}` 接着打"，一直没进距离是"追了 N 秒还没进到攻击距离
  （3.5 格）—— 走不过去 / 被方块挡住 / 目标跑太快；先 `mc_move` 到它旁边"。
- 没有 pvp 插件时退化成"按预算多挥几下"（`b.attack()` 每 620ms 一次，只在 4.5 格内），返回 `swings`。

验证：`check-core-attack.mjs` **47/0 → 70/0**（新增第 ⑥ 节 13 条：打死 ⇒ `killed:true` 且立刻返回、
没打死分"没追上/没打死"两种文案、`stop()` 挂住也按时返回、血量如实报/读不到不报、无 pvp 时挥 ≥2 下）；
实机探针（真服 `127.0.0.1:25565`，账号 `wcattack3`）：

- 修复前：`attack({who:"cow"})` 在 **21.6 格**处 ⇒ 立刻回 `{"attacked":"cow","distance":21.6,"via":"pvp"}`，
  **牛一点事没有、机器人一步没动**。
- 修复后：远处一头牛 ⇒ `{"attacked":"cow","distance":17.9,"killed":false,"waitedMs":10081,
  "note":"打了 10.1 秒还没打死（这一轮的时间到了）—— 再叫一次 mc_act{attack} 接着打"}`（真追过去了，
  牛一直逃）；不给 `who` 时 ⇒ `{"attacked":"cow","distance":3.4,"killed":true,"waitedMs":250}`，
  **牛被真打死**，机器人捡到了 `leather`。
- 脚本化复跑：`实机验证\攻击\live-attack.mjs` **17/0** —— `who:"cow"` / `"COW"` / `"牛"` 三次都追过去打到；
  ①.5 节**真打死一头牛** ⇒ `{"attacked":"cow","distance":2.7,"killed":true,"waitedMs":6841}`，
  而且 `killed` 与实体表一致（表里真没了，没谎报）。

### 打谁 / 挖哪块 / 真重连（2026-10-08 的四条实机反馈）

用户在游戏里把 AI 的原话转了过来：

> 1) mc_act attack 指定 who 会报"附近找不到"，不带 who 才打得着 2) mc_craft 合木板巨亏，
> 9 根原木只出 10 块板 3) mc_dig 挑到够不着的目标就超时，得用 mc_sequence 连着 break
> 4) 重连清不掉客户端区块缓存，挖着挖着就"那里本来就是空气"

四条**都成立**，根因各不相同：

1. **`who` 匹配太窄**：旧代码只拿 `String(e.username ?? e.name)` 去 `includes()`。玩家实体的 `name`
   是注册表里的 `'player'`（分不清谁是谁），怪的中文名根本不在字段里，实体列表显示的名字和
   `attack` 认的名字对不上就只会丢一句"附近找不到"（模型没有任何线索改名重试）。
2. **合成一次要太多批**：`bot.craft(rec, N)` 不保证做够 N 批（实机要 8 块木板只出 4 块），
   后面那一步就拿着"只有 2 块木板"去撞 `原料对不上`；点格子点了一半被 11 秒掐断还会把材料留在合成格里。
3. **`dig` 挑目标不看远近**：`findBlocks` 的返回顺序不保证是最近的，而每个目标都拿**整轮剩下的时间**
   去喂 collectBlock ⇒ 第一个够不着的就能把 11 秒吃光。
4. **"重连"其实没重连**：`connect()` 里"已连着且同一个地址就 `return this.bot`"—— 空操作。
   客户端区块缓存旧了的时候（挖到 `air`），叫多少次 `mc_connect` 都不会刷新。

改法：

- **`attack`**：匹配所有名字字段（`username`/`name`/`displayName`/`type`/`kind`）+ **中文别名表**
  （`僵尸`→zombie、`苦力怕`→creeper… 40 多个）；**找不到时列出半径内实际有谁**（名字 + 距离），
  模型照着改一次名就能打对。不给 `who` 时按 **敌对 > 玩家 > 动物 > 掉落物** 排序，而且**只追怪**
  （动物/玩家仍限 4.5 格内 —— 不然会跑 6 格去揍玩家拴着的马）；实体列表里玩家显示 `username`
  而不是 `player`。
- **`mc_craft`**：主调用改成**一次一批**（`bot.craft(rec, 1, tbl)`），由补做循环按批对账做到 `s.times` 批
  （轮数跟批数挂钩，不写死）；每批都比对背包快照。
- **`mc_dig`**：目标**按距离升序**（显式给的 `pos` 仍排第一）；单个目标的预算封顶在"剩余时间的一大半"
  （`min(collectBudget, left, max(2500, left*0.6))`），并在采集期间把 `pathfinder.thinkTimeout` 临时压到
  ≤4 秒（用完还原）⇒ 走不过去的目标**快点失败**，把时间让给下一个；失败文案补"先 `mc_move` 到它旁边再挖"。
- **`mc_connect {force:true}`**：先 `old.quit()` + 关掉自动重连 + `await sleep(600)` 让服务端放掉旧会话，
  再真连一次（世界与实体全部重收）。空气方块那句 `note` 也改成直接教它用 `force:true`（或走远 32 格）。

验证：`check-core-attack.mjs` **70/0**（who 中英文/大写/找不到列名单、不给 who 只追怪、dig 距离排序 +
预算封顶 + `thinkTimeout` 还原、`force` 的 `quit → createBot` 顺序）；全量 `check-all.mjs` **26/26**；
实机 `实机验证\攻击\live-attack.mjs` **13/0**（真服 `wcattack_live`）：

- `mc.attack({who:"squid"})`（**12.56 格**）⇒ `{"attacked":"squid","distance":12.6,"health":20,"via":"pvp"}`
  —— 自己追过去打到了；`"SQUID"` 与中文 `"鱿鱼"` 同样打到同一只（大小写 + 别名表都成立）。
- 名字不存在 ⇒ `附近找不到 "enderman-绝对没有这个"（24 格内实际有：cod 6.7 格、cod 8.6 格、cod 9.0 格、
  squid 12.6 格、cod 19.4 格、dolphin 19.4 格）`。
- `connect({force:true})` ⇒ 换成新的 bot 对象、时间戳更新、区块照旧能加载、重连后 24 格内 21 个实体照读。
- "不给 who 时只追怪"那一条这一轮**如实报"验不成"**（打完那只鱿鱼时它已经在 12.6 格外，超过 4.5 格）。



用户报过："现在容易被淹死"（2026-10-07）。日志里的现场是这样的：

```
[14:09:34] mc_auto：挨了打但看不到怪 → 已叫醒 AI 定策略（血 3/20）
[14:10:01] ⚠️ 破坏 water 这一轮的时间用完了（还剩 5000ms）
```

机器人在红树林沼泽里泡水，**缺氧掉血**被反射层当成了"被远程怪隔墙射"（掉血 + 22 格内看不到怪），
于是 AI 被派去找一个不存在的敌人；它还试着 `mc_dig water`（水挖不掉，白花一次调用）。三处改动：

- **判据（`extensions\mc_auto.mjs`）**：`submerged` = `entity.isInWater` **且眼睛那一格是液体**
  （`submergedIn()`）。三条路都要求它：① 头在水下**超过 10 秒**（`DROWN_SUBMERGE_MS`）就叫醒；
  ② 头在水下**掉血**（缺氧掉血就长这样）立刻叫醒；③ 氧气读数 `<= 6`（`DROWN_AIR`）或 `< 12` 且刚掉血。
  叫醒文案和"被打"完全分开：`【自保：我在水里快憋死了｜氧气 N/20｜血 N/20】` / 读不到氧气时
  `【自保：我在水底下（憋气）｜血 N/20】`，正文写清"**这不是被打**，别去找什么远程怪"，并给四条
  （`mc_move {"mode":"swim"}` 上浮 / `mc_scan` 找岸 / **水是流体挖不掉** / 血少先换气再吃躲）。
  濒死（氧气 ≤4 或头在水下 12 秒以上且刚掉血）只按住 jump 600ms 抬一下 —— 和"脚下是岩浆"同类，
  仍然**不横向跑、不还手**。
- **工具（`src\core.mjs` + `index.js`）**：新增 `mc_move {"mode":"swim"}`（按住 jump 上浮，默认 3 秒、
  上限 3 秒，出水/气恢复就提前收手，没出水就返回 `remaining` + hint 让 AI 再叫一次）；
  `mc_status` 加 `air`（氧气，读不到就不给）与 `submerged`（头在水下）；`mc_dig` 对
  水/岩浆**直接拒绝**并告诉它改用 `swim`（旧日志里那条"破坏 water"就是白花的调用）。
- **看门狗（`src\watchdog.mjs`）**：掉血提醒里补一句"我在水里：可能是憋气，用 `mc_move {"mode":"swim"}` 上浮换气"。

**两条实测教训**（都写进踩坑档案第 18 条）：

1. `bot.oxygenLevel` **只在头入水之后才有读数**（服务端发 `air_supply` 元数据时才设），水面上是 `null`
   —— 所以判据不能只看氧气，必须有"头在水下"这一路。
2. 读数还可能是**旧的**：mineflayer 不在客户端让它自己往下走，潜过水之后站在浅水里 `air` 可能还是 `0/-1`
   ⇒ 只按氧气判会**误报"憋气"**（第 2 轮实机就误报两次）。所以氧气那一路也要求"头在水下**或**读数正在往下掉"。

**验证**：`check-mc-auto.mjs` **224/0**（3.6 节 14 条：叫醒文案 / 不自己跑不还手 / 限流 6 秒 /
头在水下 10 秒 / 掉血立刻 / 旧读数不许误报 / 读数在掉算兜底）+ `check-core-swim.mjs` **82/82**。
**实机**（`实机验证\溺水\live-swim.mjs`，真服 + 真物理）：挑 ≥2 格深的水走进去、按住 sneak 沉下去 ⇒
`submerged=true`（氧气读到 6/20）、反射层叫醒 1 次且文案正确、**自己跑 0 次、还手 0 次**；
`mc.swimUp()` 从 **y 59.88 → 62.82（涨 2.94）**、出水后氧气 6 → 8；`dig water` 逐字拒绝；
收尾回到下水前的岸边，**13/0**，世界无改动。

### 在水里也能走（`mc_move` 自动改成"直接游"）

用户转来游戏里 AI 的话（2026-10-08）："我在水里横着游，**4 秒只能挪一格**，我的寻路在水里基本废了。
浮起来没问题，往下沉也能跳回来。"

根因在 vendor 里那份 `mineflayer-pathfinder`：它的 **A\* 明确拒绝把水当节点** ——
`lib\movements.js:503` `if (blockC.liquid) return // dont go underwater`、`:523` 同一句、
`:571` `if (this.getBlock(node,0,0,0).liquid) return // cant jump from water`；
控制器在水里也只会按住 jump（`index.js:611-613`）。所以"泡在水里、目标在岸上"时它要么只给
一条只有一个节点的路、要么直接 `NoPath` —— 表现就是原地蹭。

**修法**：`src\core.mjs` 新增 `#walkSwim(target, {arrive, budget})`，**在水里绕开 pathfinder**：

- 每 **250ms** 重新 `lookAt(目标 + 1 格高)`（水流/撞岸会把朝向推偏），按住 `forward` + `jump`
  —— **jump 不是为了跳，是浮在水面游**（贴底会卡、也慢）；
- 到 `arrive` 内就返回 `via:'swim'`；**已经上岸**（`!isInWater && onGround`）就收手返回
  `outOfWater:true`，`walkTo` 再把剩下的路交给 pathfinder（返回里带 `swam`/`swimMoved`）；
- 这一轮时间到了就如实报 `reason:'swim-budget'` + `remaining` + hint（"再叫一次 mc_move 接着游"）；
- `mc_move` 的 `mode:"swim"` **给了 x/y/z 就游过去**，不给坐标才是原来那个"只上浮换气"。

**为什么快**：`prismarine-physics\index.js:472-501` 水里 `acceleration = liquidAcceleration`（0.02）、
`inertia = waterInertia`（0.8）⇒ 水平极限 `0.02/(1-0.8) = 0.1 格/tick` = **2 格/秒**。
实测（真服，裸控制）`forward+jump` = **2.04 / 2.13 / 2.32 格/秒**（4 次）—— 正好是理论上限，
比用户报的 0.25 格/秒快 **8 倍**。

**实机**（`%TEMP%\wc-water-probe.mjs` 临时探针，真服）：在水里（脚下方块是 water）调
`mc.walkTo(岸)` ⇒ `{"arrived":true,"ms":2811,"moved":5.98,"via":"swim","remaining":1.59}`
= **5.96 格 / 2.8 秒（2.13 格/秒）**，`via` 是 `swim`（走的新那条）。
**回归**：`check-core-swim.mjs` ⑦ 节 5 组（水里游到目标 / 没挂 pathfinder 也能游 / 上岸交给寻路 /
预算到点如实报 / 陆地不误按控制位）+ ⑧ 节静态接线，**82/82**。

### 在地底下自动看洞穴层（`mc_map`）

用户报过："map工具ai说只能看地表的，添加在地下变成看以自身为中心上下2格洞穴。就像地图模组那样。"（2026-10-08）

**问题**：`heightmap()` 只会画**地表** —— 每列从 `cy+yTop` 往下扫，取第一块非空气。在地下，这张图
要么是头顶那层岩石（看不出哪儿能走），要么干脆一片"未加载"。洞穴里想知道"哪边是通道、哪边是墙、
脚下会不会掉下去"，地表图一点用没有。

**判据（`isUnderground()`）**：看我**头顶 2~40 格**那一列，遇到第一块实心遮挡就算在地下。树叶/原木/
竹子/雪层/藤蔓这类"软顶"**不算**（不然站在树下、在屋里都成了地下），花草火把这类能穿过去的也不算；
那一列**没加载**就保守当露天（宁可给地表图，也不给一张全 `?` 的图）。

**洞穴层视图**：以我为中心、上下各 `slab` 格（默认 2，可 1~8）。每一格**先看我身体那两格被没被占，
再看脚下**：

| 字符 | 含义 | 判据 |
| --- | --- | --- |
| `#` | 墙 | 身体那两格里有方块（站不下） |
| `*` | 矿石 | 同上，而且那块是 `_ore`（想挖就挖） |
| `~` / `≈` | 水 / 岩浆 | 身体或脚下那格是水/岩浆 |
| `·` | 能站 | 身体空着、脚下 `cy-1` 就是地面 |
| `↓` | 低一格 | 地面在 `cy-2`（要走下去） |
| `v` | 会掉下去 | 地面更低（`slab` 内）或再往下 4 格才找到地面 |
| `?` | 未加载/深不见底 | 方块读不到，或脚下找不到地面 |

配色跟着走：**能走=亮、墙=暗**，一眼看出通道（像地图模组那样）。参数 `mode` 三态 ——
`auto`（默认，按 `isUnderground()` 自动切）/ `surface`（强制地表）/ `cave`（强制洞穴层）；
`mapImage()` 也跟着切（标题变 `🕳️ 洞穴层图` / 图像变 `🖼️ 洞穴层俯视图`），文案里还告诉 AI
"想强制看地表就 `mode:"surface"`"。

**顺手修的老 bug**：图例那行以前是 `hm.legend.slice(0, 15).join(' ')`，可 `legend` 里是
`{name, count}` 对象 ⇒ 每次都在给 AI 打 **`[object Object]`**。现在渲染成 `#墙×12 ·能站×40`。

**回归**：`tools\check-core-map.mjs` **54/0**（假世界逐格造地形；其中一条专门盯"2 格高的巷道
（天花板在 `cy+2`、地面在 `cy-1`）不许被误判成会掉下去" —— **第一版真写错了**：只看"最高的那块"
会先看到天花板，于是把能站的地方说成会掉下去）。细节见「踩坑档案」第 20 条。

**实机**（`实机验证\地图\live-map.mjs`，真服 `127.0.0.1:25565`，**不挖不放**）：地表 `isUnderground()`
判 false 且自动给地表图、`mode:"cave"` 出洞穴层图（图例 `#墙×135 v会掉下去×89 ~水×25 ·能站×7`）、
`slab:8` 读得到脚下（我这一列 `cave_open`）、128 格内找到真 `cave_air`（它上面是 `deepslate`）⇒
**16/0**，位移 0.00 格。

### 合成不会再把材料"吞"在合成格里（`mc_craft`）

用户报过："我背包里那 10 根橡木刚才突然没了，还多了个橡木按钮 —— 你是不是动了我的背包？合成也卡住了，
做木板一直超时。"（2026-10-07）

**根因**：`bot.craft()` **不可取消** —— 单次调用 11 秒预算到点只是"我们不等了"，它内部点格子的循环还在跑
（`clickWindow` 最多再挂 20 秒，`once('windowOpen')` 根本没有超时）。这时 AI 再调一次 `mc_craft`，
两条链就抢同一个窗口；`craft.js` 的 `clickWindow` 又**不传窗口参数** ⇒ 拿背包窗口的格子号去点工作台窗口
⇒ 服务端"格子里剩什么就做什么"（格子里剩 1 块木板 → **`oak_button`**）。材料留在合成格/窗口里，
而 `bot.inventory.items()` **不含合成格** ⇒ "背包里 0 根原木，可我明明有"、`missing ingredient`。
（材料没真丢：转写里原木后来自己回来了 —— 是**视图失步**。）

**修法**：

- 同一个 bot **同时只允许一条合成链**（`craftBusy` WeakMap）；再进来先关窗口、等最多 1.5 秒，
  还挂着就如实拒绝并教它 `mc_connect` 重连（重连也会把合成格里的东西退回背包）。
- **每次动手前先关掉残留窗口**（失败/中断/结束的每条路径都关）—— 关窗口 = 服务端把合成格里的东西**退回背包**。
- 背包前后快照对账：craft 报错时如果背包里**多出了别的东西**，如实写
  `⚠️ 服务端其实做出了别的东西：oak_button×1`，不让它悄悄躺着让 AI 困惑。
- 工作台要**够得着（≤4 格）且看得见**（`bot.canSeeBlock`）才算数，否则当"附近没有"
  （会走"把背包里的工作台放到脚边"那条路）。
- **`bot.craft(rec, N)` 有时候只做一批就返回**（实机：要 8 块木板只出 4 块）⇒ 下一步就撞
  `原料对不上：oak_planks 要 3 个、背包里只有 2 个`。现在会**一次一批地补做**（最多 8 轮，
  每轮都先查材料、查这一轮还剩多少时间），补不动才如实报"只做出来 4 个"。
- `mc_diag` 新增 `crafting` 字段：**开着的窗口 + 合成格（含自己背包的 2×2 槽 1~4）里的东西**直接摊出来。

回归：`tools\check-mc-craft.mjs` **176/0**（第 ⑧ 节 15 条 + 缺料报链条 4 条 + ⑨ 只做一批补做）；细节见「踩坑档案」第 16、24 条。

### 材料不再卡在合成格里：点格子之前先跟服务端**要一次整窗内容**（`mc_craft`，2026-10-13）

用户报过："合成方块还是会卡在合成栏里。"

**根因**：`clearCraftGrid()` 照着客户端那份 `bot.inventory.slots[1..4]` 去点，而 1.17.1+ 的服务端
**只在它认为客户端记录过期时才回包** —— 被它忽略的点击永远不回 ⇒ 客户端模型会一直停在"合成格是空的"，
而服务端里其实还压着东西；循环里那 4 格全是 `null`，一个 `continue` 就跳过去了。
另外 `bot.moveSlotItem()` 是"拿起来 + 放下"两次点击，第二次超时会把东西留在**光标**上，关窗口就掉地上了。

**修法**：

- 新增 `resyncInventory()`：动手前发一个 `stateId:-1` 的空点击（mineflayer 的 `bot._syncWindow`），
  服务端**必回**整窗内容 ⇒ 客户端模型被刷成真实状态。**只在 4 个格子看起来全是空的时做**，
  `withTimeout` 包住，**失败退避 8 秒**（服务端不回包时别每次关窗口都白等），成功 0.8 秒内不重复。
- `clearCraftGrid()` 先对账再点；点完检查光标，还捏着东西就放回背包。
- 上一条链**挂住超过 3 秒**时，拒绝开第二条链的同时顺手清合成格（3 秒是留给"正常但慢的合成"的余地）。

回归：临时 A/B 冒烟 **19/0**（模型空/服务端有东西 ⇒ 先对账再点回；只点了一半 ⇒ 光标那件放回背包；
`_syncWindow` 挂住 ⇒ 2.4 秒收工且只对账一次）；细节见「踩坑档案」第 79 条。

### 背包数字不会数两遍（`mc_inventory`）+ 缺料时报整条链条（`mc_craft`）

用户 2026-10-07 转来游戏里 AI 的原话："在弄熔炉，卡住了——我手上 4 个木板它非说不算，让我去砍原木。"

**根因**：`mc_inventory` 的输出把同一叠东西印了**两遍**。`McBot.inventory()` 回 `{ held, items }`，
而 mineflayer 的 `bot.inventory.items()` **本来就包含手上那一格** ⇒ 实机输出长这样：

```json
{"held":"oak_planksx2","items":[…,"oak_planksx2",…]}
```

模型当场数了两遍（它的 reasoning 原文：`inventory shows "oak_planksx2" twice (two stacks of 2) = 4 total`），
于是断定"工具在骗我"、跑去找原木。**插件判据其实是对的**：它只有 2 块木板，而工作台要 4 块同一种木板。

**修法**：

- `inventory()` 改成**按名字合计**（`totals` Map）：两格各 2 块 ⇒ 只报 `oak_planksx4` 一条；
  `held` 保留但写明"这一叠已经算在下面的合计里，**别再加一遍**"；再给一行 `共 3 格 / 2 样`；
  回 `text`（宿主直接渲染，不再 pretty-print JSON），`items` 仍是数组给扩展用。
- `mc_craft` 缺料时**把整条链条摊出来**（`planCraft` 里带一个递归栈 `path`，`lack()` 把祖先记进 `via`）：

  ```text
  ❌ 原料不够，做不了：
    · oak_log：需要 1，背包里有 0（没有配方：这个物品不能合成，要去挖/找（或名字写错了））
        ↳ 卡在 **oak_planks**：要 4、现在只有 2（差 2）｜链条：crafting_table → oak_planks → oak_log
  ```

  外加一句 `木板：**要同一种木头**（oak_planks 要 4 块、现在只有 2 块）—— 先 mc_dig {name:"oak_log",count:1}`
  `砍一根原木（1 根 = 4 块木板），再叫一次 mc_craft`。以前它只会说"oak_log：需要 1，背包里有 0"，
  模型就以为"工作台要用原木做"。链条被 `maxDepth` 截断时不摆（那时链条本来就不完整）。
- 顺手修掉两处**死代码**：`mc_craft` / `mc_furnace` 报告里那行"背包：…"以前写成
  `Array.isArray(inv) ? … : []`，而 `mc.inventory()` 回的是**对象** ⇒ 条件永远为假、这行**从来没打印过**。

**回归**：`tools\check-core-inventory.mjs` **24/0**（合计/手上不重复/空背包/静态接线），
`check-mc-craft.mjs` **176/0**（新增 4 条链条断言 + "背包：…"不再死），`check-mc-furnace.mjs` **237/0**；
**实机**（`实机验证\背包\live-inventory.mjs`，真服 + 真 `recipes.json`）**14/0**：空背包
`mc_craft crafting_table` 真的报出上面那三行 + `→ 木板：**要同一种木头**`，"正好 2 块木板"那段
因为机器人周围 128 格内已经没原木了（被 AI 清过）跳过；细节见「踩坑档案」第 22 条。

### 手上攥着泥土就别去刨石头（动手前自动换工具 + 如实报手上是什么）

用户 2026-10-07 转来游戏里 AI 的原话："搭路以后 ai 不知道手里的东西是什么，刚刚它拿稿子搭完以后它不知道，
在用泥土挖石头。"（玩家在游戏里那句更直接：**"怎么用手挖方块"**。）

**根因**：机器人垫方块爬出矿坑（`mc_move` 回 `pillared: 8`）之后，**手上还攥着垫路用的 `dirt×18`**；
而 `mc_act {mode:"break"}` 走的是 `breakBlock()`，它**从不换工具** ⇒ 徒手（拿着泥土）挖石头要 **7.5 秒**，
比一轮预算还长 ⇒ 每次调用都超时；更糟的是失败文案写的是「方块还在（stone）——服务端可能拒了这次破坏」，
模型根本看不出真因（它靠玩家在游戏里提醒才反应过来，然后自己 `mc_act{mode:"equip"}` 换镐）。
`mc_build`/`mc_move` 也从不说"手上还剩什么"。

**修法**（`src\core.mjs`，全是"少骗人"的改动）：

- **动手前换对工具**：`breakBlock()` 先调 `#equipFor()` —— 手上这叠能挖就直接挖（`canHarvestNow()`，已搬到 `src\inventory.mjs`），
  否则交 `mineflayer-tool` 的 `equipForBlock(blk, {requireHarvest:false})` 从背包里换一把；换工具发生在 `dig` **之前**。
- **换不上就直接拒绝**：`手上是 dirtx18，挖 stone 需要镐 —— 背包里也没有能挖它的东西。先 mc_craft 一把
  （木镐 = 3 木板 + 2 木棍）… 硬挖会一直超时。`（`toolKinds()` 把 `pickaxe` 翻成人话"镐"，已搬到 `src\inventory.mjs`）——
  不再白花一轮去硬挖。
- **挖不动按 `digTime()` 说实话**：`breakBlock` 的结果带 `digMs`（这块按手上的东西要挖多久），
  超时文案改成「挖了 11 秒还没挖掉（手上是 X，这块要 7.5 秒）—— 换个对的工具，或换个更近的点位；
  **别当成"服务端拒绝"**」。
- **结果里如实报手上是什么**：`breakBlock`/`dig` 带 `held`（换过工具再带 `tool: "dirtx18 → iron_pickaxex1"`），
  `placeBlock`/`build` 带 `used`（实际用了哪种方块）+ `held`/`heldBefore`，
  `#walkPathfinder` 垫路时带 `pillaredWith`（垫的是哪种）+ `held`（垫完还剩几块）——
  所以"垫完路上手上变成泥土"这件事，模型从工具结果里就能看见。
- 工具描述同步写明（`mc_act` 的 `break`/`place`、`mc_move`、`mc_build`、`mc_dig`）。

**回归**：`tools\check-core-equip.mjs` **43/0**（① 泥土在手 + 背包有镐 ⇒ 先换再挖、报 `tool`；② 换不上 ⇒
抛错且 `dig` 一次都没调；③ 手上已经是镐 ⇒ 一次换工具都不调；④ 工具对但挖不动 ⇒ 报 `digMs`/不赖服务端；
⑤ `mc_build` 带 `used`/`held`；⑥ 垫路带 `pillaredWith`/`held`；⑦ 静态接线 15 条）。
细节见「踩坑档案」第 23 条。

**实机**（`实机验证\换工具\live-equip.mjs`，真服 + 真 `digTime`）：空手挖石头 **`digTime()` = 37500ms**（比估的
7.5 秒惨得多），木镐 1150ms。③ 自动换镐：`{"broken":"stone","held":"wooden_pickaxex1",
"tool":"dirtx11 → wooden_pickaxex1","digMs":1150}`；④ 只给 400ms：`{"broken":false,"now":"stone",
"digMs":5650,"note":"挖了 11 秒还没挖掉（手上是 wooden_pickaxex1，这块按手上的东西要 5.7 秒）……
别当成\"服务端拒绝\"。"}`；① 空手拒绝文案逐字对上。
⚠️ 这片测试区同时有玩家和游戏里那个 AI 在挖补（出现过"挖完 1 秒就被填回"、`原 dirt→water`），
所以 ①/⑤/⑥ 那些"世界状态"断言会飘，**③④ 这两条核心断言连绿两次**。

### 挖方块别挖到一半松手 + 合成别在"已经够了"时报成功（2026-10-08 实机反馈）

用户说：

> 箱子挖方块，快挖完的时候会重置。 这是ai说的：材料像是被吞了。挖方块也老报"超时"，其实方块早挖掉了。我慢慢磨吧

游戏里那个 AI 自己（公屏）的原话：

> 合成这工具老抽风。刚才想拿原木做木板，卡了两次，材料像是被吞了。挖方块也老报"超时"，其实方块早挖掉了。我慢慢磨吧

三条根因（都在插件这边，跟服务端没关系）：

- **"快挖完的时候会重置" = 到点松手**。`breakBlock` 先花时间换工具，剩下的预算只够挖一小截；
  单次调用的截止时刻一到，`#releaseControls()` 把控制位全松开 ⇒ **破坏进度清零**，方块还在。
  模型再叫一次，又从 0 开始挖 ⇒ 看着就是"挖到八成又从头来"。
- **"挖方块老报超时，其实方块早挖掉了"** = 我们自己的工具冲出了宿主层的超时。旧日志里
  `Error: tool call timed out after 6000ms`：`dig()` 的 deadline 没留收尾时间，而 `#cancelCollect`
  固定最多等 1.5 秒、**不计入任何预算** ⇒ 两个目标就冲出 6 秒（那时 `CALL_MS = 5000`）。
  同时 `withTimeout` 只是"我们不等了"，mineflayer 的挖矿循环还在发包 ⇒ 方块过一会儿真没了，
  下一次 `mc_act {mode:"break"}` 就回"那里本来就是空气"。
- **"材料像是被吞了" = `mc_craft` 在背包已经够的时候回 `✅ 合成完成（0 步 / 0ms）`**。
  `count` 的语义是"背包里**一共**要到几个"，已经有 13 块木板时叫 `{count:4}` 当然一步都不用做，
  但文案读起来像"刚做过了"，而背包数字没变 ⇒ 模型以为材料被吞。另外 2×2 合成格里的残留材料
  以前从不回收（`closeMaybeWindow()` 只关容器窗口，自己背包的合成格**没有窗口可关**）。

**修法**：

- **时间不够就不开始挖**：`breakBlock` 用 `#digMsFor()`（= `block.digTime(物品type, …)`，能算
  "换成背包里那把会快多少"，不用真换到手上）先估这块要几毫秒；`this.callLeft() < digMs + 900` 就
  **一个挖矿包都不发**，如实回 `{broken:false, digMs, budgetMs, note:"…**我没开始挖**（挖到一半到点
  松手，破坏进度会清零，白费一次调用）…"}`。
- **超时后先复查再报**：`sleep(timedOut ? min(700, msLeft()-200) : 150)` 之后再看方块是不是已经没了，
  不急着报"没挖掉"。
- **`dig()` 留 900ms 收尾**：`deadline = Date.now() + max(0, callLeft() - 900)`；`#cancelCollect` 新增
  `budgetMs`（调用方把"距该返回还剩多少"传下去，`budgetMs == null` 才算"没指定"）；单个目标预算
  `min(collectBudgetMs, left, max(2500, left*0.6))`。
- **换工具按"快多少"来**（`#bestToolFor` + `#equipFor` 重写）：手上是 `stone_sword` 去砍原木
  （剑砍木头约 3 秒、石斧约 0.9 秒）时会自动换成斧头；只有在快 28% 以上才换，避免来回换。
- **`mc_craft` 如实报"没做新的"**：`{count:N}` 已经够了 ⇒ `ℹ️ 一个都没做：背包里已经有 X ×N…`
  + `→ 要**再做** N 个：mc_craft {name:"X", count:N, more:true}`（新增 `more` 参数）；
  日志也写"没做新的（背包里已经够了）"。
- **每次动手前把 2×2 合成格里的东西点回背包**（`clearCraftGrid()`，走 `bot.moveSlotItem(slot, dest)`），
  `closeMaybeWindow()` 的 8 个调用点自动都做 ⇒ 掐断后材料不再留在格子里（既不会"报缺料"，
  也不会让服务端拿错位的格子号去点）。

**回归**：`tools\check-core-equip.mjs` **56/0**（④ 新增"时间不够 ⇒ `dig` 一次都没调、世界不变"）、
`check-call-budget.mjs` **111/111**（⑨ 新增 dig 的 900ms 收尾 + `budgetMs: leftOf() - 200` +
`budgetMs == null`）、`check-core-dig.mjs` **18/0**、`check-mc-craft.mjs` **176/0**、
`check-token-budget.mjs` **32/0**、全量 **27/27**；细节见「踩坑档案」第 27 条。

**实机**（`实机验证\挖方块\live-dig.mjs`，真服 `127.0.0.1:25565` survival，账号 `wcdig_run4`）
**23/0（跳过 1）**：

- ⓪ `mc.dig` 两轮分别 **10100ms / 8711ms** 返回（工具超时是 12000ms）⇒ **不再冲出工具超时**；
  第一轮"挖掉 1 根 + 2 根如实报超时"、共拿到 4 根 `birch_log`。
- ① 备料全通：`birch_planks ×4`（32ms）、`stick ×4`（50ms）、`crafting_table`（196ms）、
  `wooden_pickaxe`（731ms，**自己把工作台放到 (-29,66,334)**）。
- ② `{count:1}` 已经够了 ⇒ 3ms 回 `ℹ️ 一个都没做：背包里已经有 birch_planks ×3`（**不再是
  `✅ 合成完成`**）；`{count:1, more:true}` ⇒ 真做了 1 块（3 → 7）。
- ③ 先往 2×2 合成格塞 `birch_planks×7`，再叫合成 ⇒ 回 `（合成格里还剩 birch_planksx7：已经点回背包了）`，
  合成格变空。
- ④a `setCallDeadline(1300)` 后 `breakBlock` 石头 ⇒ **1ms 返回**
  `{"broken":false,"digMs":1150,"budgetMs":1299,"tool":"stickx2 → wooden_pickaxex1","note":"这一轮只剩 1299ms，
  这块按手上的东西要 1.1 秒 —— **我没开始挖**…"}`，世界 `stone → stone`；
  ④b 给足预算 ⇒ **5814ms** 真挖掉（`digMs:1150`）。
- ⑤ 跳过（48 格内没有"18 格外还够不着"的原木，不算失败）；⑥ 挖掉的 1 格用 dirt 填回，**1/1** 对账干净。

### 报了成功其实没做（2026-10-08 全工具审计）

用户原话："你全部工具都查一遍，怎么这么多bug"。这一轮把每个 `mc_*` 工具都按同一个问题过了一遍：
**它说"做成了"，凭什么？** 结论是有一批工具在"命令发出去了"和"事情真的发生了"之间划了等号。

**根因（mineflayer 的 API 语义）**

- `bot.activateBlock` / `bot.activateEntity`（`node_modules\mineflayer\lib\plugins\inventory.js:195-258`）
  内部**只 `await bot.lookAt(...)` 再写一个包 + `swingArm()`** —— 服务端**不回执**，resolve 只说明"包发出去了"。
- 而 `bot.lookAt` 不带 `force` 时会挂：`physics.js:333-359` 的 `bot.look` 只在物理循环发出 `look` 包时
  才 finish，而 `updatePosition()` 在"刚死（`deadTicks >= 20`）/坐标非有限"时**整个 early return**
  （`physics.js:158-162`）⇒ 站着不动 / 骑在船里 / 刚死时 `lookAt` 永远挂着（实机 `mc_act {mode:"use"}` 卡满 5000ms 就是这么来的）。
- 合成超时那条老 bug 也在这里：`inventory.js:476-507` 的 `waitForWindowUpdate` 等的是
  `once(win,'updateSlot:0')`，`once` 默认 20 秒 ⇒ `Event updateSlot:0 did not fire within timeout of 20000ms`；
  而 mineflayer 自己留了后门 `bot._syncWindow(win)`（`inventory.js:856-870`：发一个 `stateId:-1` 的"不可能"点击，
  服务端一定会把整窗状态回给你）。
- `bot.chat('/…')` 走的是 `chat_command` 包 ⇒ `mc_say` 能绕过 `mc_command` 的指令白名单。

**改法（`src\core.mjs` / `index.js` / `extensions\*`）**

1. 新增 `#aimAt(b, point)`：自己算 yaw/pitch 并**直接写 `b.entity.yaw/pitch`**，绕开会挂的 `lookAt`；
   之后 mineflayer 内部那次 `lookAt` 会算出同样角度 ⇒ 走 `yawChange === 0` 快速返回。
2. `useBlock` 重写：容器（箱子/熔炉/工作台…）开完等 ≤1.2s 看 `b.currentWindow !== b.inventory`
   ⇒ `{opened}` / `{opened:false, note:"没有打开"}`；门/活板门/栅栏门/按钮/拉杆隔 280ms 重读
   `getProperties()` 比差异 ⇒ `{toggled, changed}` / `{toggled:false, note:"一点没变"}`；
   实体 ⇒ `{usedEntity, distance}` + "服务端不回执"；其它方块 ⇒ 明说"没法确认"。
3. `build` 只把**复核过**的格子算成 placed（`placed:false` 进失败列表）；不给 `name` 时已占用的格子
   进 `skipped`（旧版会攒够 5 个"已被 X 占住"直接报失败）。
4. `equip` 读回 `heldText(b)`（已搬到 `src\inventory.mjs`）并比对 `b.heldItem.name`；`dig` 兜底分支复核过才写"挖掉"；
   `giveItem` 按目标格实际内容说话；`tossItem` 按背包数量差对账；`chatSay` 拒 `/` 开头；
   `lookAt`/`useBlock` 的 `who` 走 `pickEntity`（中英文别名都认，找不到列出"附近实际有"）。
5. `#walkPathfinder` 的 catch：`reason` 不再漏出 `Error`/`block_updated`（映射成
   `walk-failed`/`block-changed`…）；新增 `noProgress`（`moved < 0.6 && remaining >= startRemaining - 0.3`）
   ⇒ 一格没挪就如实说"**是真没走通**"，不再套用"不是走不通、再叫一次"的模板。
6. `mc_craft`：catch 里识别 `updateSlot/did not fire/超时` ⇒ 调 `bot._syncWindow(win)` 同步窗口（1.2s 上限）
   再对账，不再干等 20 秒。
7. `mc_chest`：按**箱子数量差**对账（`chestSnap(win)` 前后各拍一次），数量没变就明说
   "动作发出去了但箱子里的数量没变"。
8. 视角/自主层（子代理审计报告）：皮肤**先校验后落盘** + 坏缓存删掉重下 + 失败 30 秒后可重试；
   皮肤阶段共享 11 秒预算（`withTimeout(…, callLeft() - 800)`，单请求超时降到 3 秒）；
   手持物名先归一化再匹配颜色（`oak_planksx1` 不再永远 fallback 灰）；`paintHand` 右边框笔误修掉；
   重连复位 `s.eatHooked`；`avoid()` 的 `busy` 只挡动作、不挡检测与叫醒；加载日志不再写死 180s/60s。

**验证**：`check-core-evidence.mjs` **40/0**（新套件）、`check-core-equip` 56/0、`check-call-budget` 112/112、
`check-mc-craft` 176/0、`check-mc-chest` 105/0、`check-mc-skin` **69/0 → 78/0**、
`check-mc-view-render` **109/0 → 112/0**、`check-mc-observe-host` **67/0 → 72/0**、
`check-mc-auto` **224/0 → 232/0**，全量 28 项全绿。

### 移动/寻路的"体系外旁路"：领号、认中断、预算到点（2026-10-08 审计第二轮）

第一轮审计修的是"**报了成功其实没做**"；这一轮（两份移动/寻路子代理报告，12 + 10 条）修的是另一类：
**动作循环本身做对了事，但"谁来收尾 / 能不能停下来 / 到点算不算做完"没写对**。

- **`swimUp()` 一个人犯了三个病**：不认中断（60ms abort 后仍跑满 3051ms，`heldMs` 报 3051 实际只按了 61ms）、
  不领 `_moveGen` 号（收尾时把**接管者**正按着的 `jump` 一起松掉 ⇒ 水里停止上浮）、
  预算归零时 `Math.max(200, …)` 白送 200ms。现在：入口看 `callLeft()`、领号、每轮查 abort/号、
  `heldMs` 报实际按住时长、`hold: 0` 不再被 `|| 3_000` 吃掉。
- **`mc_sequence` 的 `wait` 两头都不对**：不可中断（60ms abort 后仍等满 2009ms）；
  被预算截到 300ms 却报 `ok:true`（模型以为"等够了"，跑去收熔炉）。现在 `raceAbort` 包住 sleep，
  没等完就如实返回 `{ok:false, requestedMs, note:'只等了 X 秒（想要 Y 秒）…再叫一次接着等'}`。
- **`flyTo()` 是"体系外的一块"**（直接写 `b.entity.position`）：不领号 ⇒ 创造模式下抢占无效、最多继续飞 10 秒，
  还一直改着 `physics.gravity`。现在领号 + 每轮查号 + `raceAbort(sleep(60))` + `finally` 只在号是自己的时候收手。
- **`pathfinder.stop()` 只是置个标志**（vendor `index.js:394`）⇒ 得 `setGoal(null)` 才真停，
  否则控制位会被插件按回去。新增 `#stopPathing(b)` 统一走这两步。
- **控制位租约**：新增 `_ctrlLease` + `holdControl(key, ms)`，`#releaseControls()` 尊重租约 ——
  别人刚按下的键，收尾的一方不许松。
- **空路径不算"到了"**：vendor 的 `lib/goto.js:22-30` 对**空路径**的 noPath 是"无错 resolve"，
  旧代码把这种"离目标还很远的成功"报成 `preempted`（"不是走不通"）⇒ 模型反复重发同一个到不了的点。
  现在分别如实报 `NoPath`（"**没路可走**"）/ `goal-reached-elsewhere`（"**不是我这次的目标**"）；
  另外 `reason` 的优先级也改了：时间到点 + 有进展 ⇒ 报 `budget`/`timeout`，不再一律 `path-reset`。
- **`runSequence` 的账目**：补 `attempted`，并写明"没做完的那一步**同时**进 `results` 和 `remaining`"，
  所以不变式是 `succeeded === stoppedAt`，不是 `results.length + remaining === requested`。
- 顺手：`#walkSwim` 非水分支的 `budget` 也按 `msLeft()` 钳一遍（原来是埋着的雷）；
  "真没走通"的 hint 补一句"脚下明明没东西却还是走不动 ⇒ 可能是我这边的世界和服务端对不上，
  `mc_connect {force:true}` 刷一遍"。

**验证**：`check-call-budget` **139/139**（新增第 ⑪ 节 10 组：jump abort/预算、swim abort、swim 抢占、
收尾调 `setGoal(null)`、`runSequence` move、`waitForChunks` 上限 0/中断、控制位租约、abort→interruptMove）、
`check-core-swim` **93/93**、`check-core-evidence` **40/0**、全量 `check-all.mjs` **29/29**。
"走不动"专项：两次实机探针各 4 次（地面 + 自己挖的坑里）都没能复现 `moved: 0.01 / reason: path-reset`。

### 熔炼备料挖出的五条：判据的参照物必须和服务端一致（2026-10-08）

跑 `实机验证\熔炼\live-furnace.mjs` 备料时，连着撞了五个**都不报错、都"看起来成功了"**的坑，
最后表现为"挖了 3 根原木背包里只有 1 根""连报 5 条'挖掉 stone'但圆石 0 个""淹在水里却说自己没在水里"。
细节见 [踩坑档案.md](踩坑档案.md) 第 34 条。

1. **`entity.isInWater` 在"泡在水柱里"时读不出来**（`prismarine-physics` 的入水 AABB 从底部缩了 0.401）
   ⇒ 憋气、上浮、走水路、`status().submerged` 全哑。新增 `#inWaterNow(b)`（`isInWater` **或**
   眼睛那格是 `water|flowing_water`）并换掉所有判据；`mc_auto` 的憋气分支改成
   `inWater = submerged || Boolean(e?.isInWater)`。
2. **挖方块估时放大 5 倍**（`prismarine-block` 的 `digTime`：在水里 / 不在方块上 `/= 5`）
   ⇒ 掉坑里挖原木真值 15 秒、估成 3 秒 ⇒ 放行 ⇒ 挂满整轮只回"超时"。`#digMsFor` 的 `notOnGround`
   改成"真在下落"（`!onGround && vY < -0.02`），新增 `#waitGrounded(b, 1_200)` 接进三条挖掘路径
   —— **落地再挖**。
3. **够不着却报"挖掉"**（审计①那次现形）：reach 判据原来用"**脚 → 方块坐标**"，服务端用
   "**眼睛 → 方块中心**"（4.5）。新增 `#reachOf(b, blk)`（纯算术，缺失就回 `Infinity`）替换两处原地挖 +
   `breakBlock` 的判据；把早就在用的 `#watchServerBreak` 接到原地挖上（`block_change` 才算数），
   返回值加 `watching`（判不了就不下结论）：收到服务端回包才说"（服务端已确认）"，
   否则如实说"没收到服务端的破坏回包 … 先 `mc_scan` 复核"。
4. **挖到了却没捡**：原地挖绕过了 `collectblock`（平时是它捡掉落物）⇒ 新增
   `#grabDrops(b, { radius: 8, budgetMs: 3_000 })` 接进原地挖两处，报数改成**背包差**
   （`e.isValid` 实机上来不及变 false，按它数永远是 0）。
5. **`findBlocks` 的 matcher 里碰 `.position` 会抛**（matcher 拿到的是没有 position 的 Block 原型）
   ⇒ 规矩定死：**matcher 只按 `.name` 筛**，要位置就 `bot.blockAt(p)` 转回真方块再过滤。

**回归**：`check-core-dig` **20/0 → 27/0**、`check-core-attack` **70/0 → 71/0**、
`check-core-equip` 56/0、`check-core-swim` **88/88 → 93/93**、`check-call-budget` 139/139、全量 29/29。

### 熔炼跑通后又挖出的五条：判据/记账/同步各错一处，条条都是"谎报"（2026-10-08）

熔炼实机跑到"装料 → 盯着烧 → 取成品"这一步时又抓出五条，细节见 [踩坑档案.md](踩坑档案.md) 第 35 条。

1. **认掉落物不能按 `type`**：`entities.json` 里掉落物是 `{ name:'item', type:'other', displayName:'Item' }`
   —— `type` 是 `'other'` 不是 `'object'`（经验球也是），旧判据**永远 false** ⇒
   "挖掉 3 根原木、服务端都确认了，一条'顺手捡回'都没有"。也不能拿 `displayName` 兜底
   （**牛也有 displayName**）。两处 `isDrop`（`core.mjs` 的 `#grabDrops` + `mc_auto.mjs` 的待机捡东西）
   都改成**按名字认**（`item` / `experience_orb`）—— 顺带说明 `mc_auto` 那条"待机顺手捡东西"
   此前在这个服上**从来没生效过**。
2. **"圆石 8 → 5 → 2 → 0"不是插件吞材料**：`mc_craft furnace` 本来就要吃 8 个圆石，
   `mc_furnace` 紧接着把它放出去。排查时把"collectblock 往箱子倒""tool 层藏东西""挖掘路径扔东西"
   三条都读码排除了（`emptyInventoryIfFull` 只在 0 空位才走、`mineflayer-tool` 只有 withdraw 没有 deposit）。
3. **ETA 把"正在烧的那个"算两遍**：输入槽那叠**包含正在烧的** ⇒ `rest = count - 1`
   （2 个 ×10 秒报"还要 30 秒"，实际 20 秒）。
4. **取成品后"背包差"读早了**：服务端 `set_slot` 会晚到 1 秒以上 ⇒ 旧代码谎报"只多出 0 个"。
   等待窗口 1.2 秒 → **3 秒**，并加**第三态**：`real >= took` → "✅ 这一轮收到"；
   **输出槽空了** → "✅ 收走了 …（输出槽已经空了；背包同步慢一拍）"；只有输出槽还有货才 `⚠️`。
5. **放熔炉被服务端拒就换点位**：`mc_util` 新增 `findPlaceSpots()`（有序候选），`mc_furnace` 最多试 3 个，
   文案如实说"前 N 个点位服务端没收"（实机见过"这一次拒、下一次成"）。

**回归**：`check-mc-furnace` **258/258 → 267/267**、`check-core-dig` 27/0、`check-mc-auto` 233/0、全量 29/29。

### 挖矿"复原"：服务端**拒绝**破坏时发回来的原方块包，被当成了"服务端认了"（2026-10-08）

用户 m19917「挖石头不会复原了，但是挖矿还是会」→ m20106「煤矿是正常的，但是铁矿不对」。
现象是**方块挖掉又在眼前出现**、`raw_iron` 不涨，而插件报 `挖掉 iron_ore …（服务端已确认）`
（`mc_act {mode:"break"}` 也一样 `confirmed: true`）。细节见 [踩坑档案.md](踩坑档案.md) 第 37 条。

1. **先砍掉那条路**：`dig()` 里"够不着就交给 `mineflayer-collectblock`"的分支 + 后面"② 退回：原地挖"
   的兜底循环**整段删掉**，只留**一条路** —— 够得着就原地挖、够不着就 `mc_move` 走过去（`arrive: 2.2`）
   再挖，走过去还是够不着就**如实说**"站远了挖服务端不认，方块会'复原'"。原因是 collectBlock 用
   `GoalLookAtBlock`（**看得见就算到**），够不着也照样挖 ⇒ 服务端拒收 + `diggingTask` 永不 resolve
   ⇒ 采集僵尸（`collectBlock` 的 `cancelTask` 等的是 `collectBlock_finished` 事件，而 `CollectBlock.js`
   在 `finally` 里才 emit ⇒ 卡住时永远等不到）⇒ 之后几分钟**走不了路**（插件日志里连着 20 条
   `⚠️ 上次的采集任务还在后台跑（超时没停掉）`）。所以 `#cancelCollect` 末尾补了
   `b.collectBlock?.targets?.clear?.()` 兜底，`#grabDrops` 超时后也调它取消（Entity 目标卡在 `GoalFollow`）。
2. **"服务端认没认"要三态**：`#watchServerBreak` 原来把 `multi_block_change` 一律算"认了"、把**没有坐标的包**
   也算"认了"，最要命的是 `block_change` **只看坐标不看新方块是什么** —— 而原版**拒绝**破坏时会把该位置的
   **原方块**用同一个 `block_change` 发回来纠正客户端（mineflayer `blocks.js:396-399` 照着改回去，
   玩家就看到"复原"）。现在 `hit()` = 服务端说这块变**空气**了、`restored()` = 服务端把方块**改回来**了、
   两者都没有 = 没有证据（如实说"没收到服务端的破坏回包"）。
3. **`multi_block_change` 真解位段**（不能整包当"没有证据"，也不能整包算"认了"）：按 mineflayer
   `blocks.js:363-394` 的格式 —— 1.18+ 每个 record 一个数字，`y = record & 0x0f`、`z = (record >> 4) & 0x0f`、
   `x = (record >> 8) & 0x0f`、状态 = `record >> 12`，坐标原点 = `chunkCoordinates`（区块段坐标）×16。
   顺带查清：`packet_block_update` / `packet_block_destruction` 在 1.21.9 **根本不存在**（旧代码白过滤）。
4. **复原了就如实说没挖掉**：`breakBlock()` 返回 `{ broken: false, restored: true, now: '…' }`，
   `dig()` 的原地挖分支报 `没挖掉 iron_ore @ (…)：服务端把这块**改回了 iron_ore**（复原）—— 多半是我离得远，
   或客户端区块旧了。先 mc_move 走到它旁边（3 格以内）再叫一次；连着两三次都这样就用
   mc_connect {force:true} 重连刷新区块`，同时写插件日志 `⚠️ 服务端把 … 复原了（…）—— 这次破坏没被认`。
   报"复原成什么"时**优先用服务端包里的状态 id**（新增 `#stateNameOf()`），本地 `blockAt` 只作兜底
   —— 本地可能还没应用上那个包，会读成 air。
5. **等真正的服务端回包**（新增 `#awaitServerBreak()`）：原来挖完只 `await sleep(200)` 就下结论，而实机量到
   服务端的 `block_change{type:0}` **可以晚到约 1 秒**（眼距 4.61 格的一次挖掘：`mc.dig` 204ms 就"完事"了，
   服务端的包 ~970ms 才到；同一位置另一跑只用了 54ms）⇒ 好端端挖掉的方块会被报成"没收到服务端的破坏回包"。
   现在每 60ms 看一次 `hit()`，服务端说"变空气了"就提前收手，最多等 1200ms（超时路径 900ms，
   上限还会被这一轮的剩余时间钳住）。

**实机验证**：新增 `实机验证\挖方块\live-restore.mjs` —— A 段（眼距 ≤4.5 必须报"服务端已确认"）、
B 段（眼距 4.6–5.0，用 `gameMode='creative'` 骗过插件那道 4.5 守卫，报告必须和
`bot._client.on('packet')` 观察到的**服务端判决**逐字一致）、C 段（挖完立刻走 6 格，必须真动、控制位松开、
没有僵尸采集任务）。三个账号 **9/1 → 13/0 → 11/0**；那个 fail 是**脚本自己**用 `bot.blockAt(pos)==='air'`
推断"服务端认了"—— 正是审计第 ① 条的现场（客户端预测），改听原始包后全绿。
顺手量到两条：这台 vanilla 服的 reach **比客户端宽**（眼距 4.61/4.80 都接受，原版
`canInteractWithBlock(pos, 1.0)` 的有效上限 ≈ 5.5，而客户端上游只允许 5.1）⇒ reach 引起的"拒收"在这台服上
复现不出来；转写里 5 条 `iron_ore` 挖掘只有 `-79,10,-32` 重复过两次 ⇒ 不能断定方块真复原过，
能断定的是旧代码那句"服务端已确认"本来就不成立。

**回归**：`check-core-dig` **27/0 → 38/0**（新增第 ②′ 节 7 条：复原包不许报成功、`type:0` 正对照照旧报确认、
`multi_block_change` 解出 air / 解出别的方块当复原、`没挖掉` 不算"报了挖掉"）、`check-core-attack` 71/0、
`check-call-budget` 139/139、全量 29/29。

### 挖铁矿要 4.5 秒：上游把 108 个方块的 `material` 写成了品级门标签（2026-10-08）

用户的第二条反馈：`mc_dig` 挖**煤**正常，挖**铁**却总要 4.5 秒。查下来**不是我们的代码**：

- mineflayer 的 `dig()` 把 `bot.digTime(block)` 当成**实际挖掘时长**用
  （`lib/plugins/digging.js:27` → `:135 setTimeout(finishDigging, waitTime)` → 到点才发 STOP_DESTROY_BLOCK），
  而 `bot.digTime` → `block.digTime(heldItem.type)` **只在 `registry.materials[blk.material][itemType]`
  有倍率时**才算工具速度，否则 `blockBreakingSpeed = 1`。
- minecraft-data 1.21.9 把 **108 个"要石镐以上"的方块**（铁矿/金矿/钻石矿/青金石/红石/绿宝石/黑曜石/
  铁块金块钻石块…）的 `material` 写成了 **`incorrect_for_wooden_tool`** —— 那是原版的**品级门标签**，
  那张表里只有木工具（`{912:2, 913:2, 914:2, 915:2}`）⇒ 拿石/铁/钻石/下界合金镐**查不到倍率** ⇒
  速度按 1 算 ⇒ **铁矿永远 4550ms**（真值：石镐 1150、铁镐 750、钻石镐 600、下界合金 500）。
  煤正常，是因为 `coal_ore` 的 `material` 是正常的 `mineable/pickaxe`。
- **修法**（`src/core.mjs`）：`#fixDigMs()` 按原版公式重算，**只在能证明上游缺倍率时才出手**
  （手上这把确实是这类方块该用的工具 + 品级够采 + 没有药水效果）；`#patchDigTime()` 把 `bot.digTime`
  换成修过的值（**+8% + 60ms 余量**：服务端按自己的进度判定，STOP 到早了会被判"没挖掉"、方块发回来 ——
  就是上一条那个"复原"）。拿错工具（石镐砍原木）、品级不够（木镐挖铁矿）、有药水效果时**一律不插手**，
  宁可慢也不估快（估快 = 方块复原 + 不掉东西）。

**回归**：`check-core-digtime.mjs` **27/0**（先复刻上游错值证明坑存在，再验真值，再验"不许估快"）。

### 用物品（`mc_act {mode:"useitem"}`：扔眼睛、射箭、喝药水）

`mc_act` 原来只有 `use`（= `activateBlock` / `activateEntity`），**只能右键方块或实体**；而"扔末影之眼、
扔末影珍珠、扔雪球/鸡蛋、拉弓射箭、喝药水"在协议层都是**对着空气用物品**（`use_item` 包），
所以这些事原来一件都做不到 —— 这正是"能不能通关"评估里的**第 1 个硬缺口**（没有它就没法定位要塞，
后面下界、末地都接不上）。

- **怎么用**：`mc_act {"mode":"useitem","hold":1000}`。`hold` = 按住多少毫秒再松手（拉弓 1000、
  喝药水 1600；默认 0 = 只按一下）。`use` 在**不给坐标也不给 who** 时自动当成 `useitem`；
  `mc_sequence` 里也有 `useitem(hold)` 这一步。
- **实现**：`core.mjs` 的 `useItem({hold})` —— `activateItem()` 发 `use_item`，`hold > 0` 时 `sleep` 之后
  `deactivateItem()` 发 `release_use_item`。`hold` 上限 3000ms，而且**给松手留 400ms 余量**：
  不然按住就把这一轮的时间吃干，松手包会被"这一轮的 11 秒用完了"的预算闸门拒掉 ⇒ 弓一直举着、箭永远射不出去
  （这个 bug 是套件第一次跑就抓出来的）。空手直接报错并提示先 `equip`。
- **验证**：`check-core-useitem.mjs` **37/0**（空手拒绝 / hold 上限 / 三档预算 / 松手包余量 / 静态接线 14 条）
  + 全量 24 项 + `selfcheck` 全绿。**实机**（真服 `127.0.0.1:25565`，玩家给了 6 个鸡蛋）：
  `equip egg` → `useItem` 1ms 返回 `{"used":"egg","count":6,"heldMs":0}` → **egg 6 → 5**，
  而且 `bot.entities` 里**多出一个投掷物实体** `egg id=277228 @(-177,83,278)`；再跑一次 **5 → 4**、
  `egg id=277665`。脚本在 `实机验证\用物品\live-useitem.mjs`（没可扔物时会自己在游戏里喊话、
  等玩家给一个再真扔；`--wait=0` 就不等）。
- **别拿"放方块"当证据**（踩坑档案第 14 条）：1.21 上光发 `use_item` **不会放置方块**，
  放方块走的是 `player_block_placement`（`placeBlock` / `_placeBlockWithOptions`，也就是
  `mc_act {mode:"place"}` 好用的原因）。另外**别在自己身体占的那一格放方块**（第 15 条）。

### 规则放在文件里，会话自己去读（2026-10-08）

用户原话：**"把规则放在文件里，让每个新会话直接去读文件"**。以前两条"开场必读"的东西是**把正文整段注入**进提示词：

| | 以前 | 现在 |
| --- | --- | --- |
| 行事准则 | 注入 `RULES.md` 全文（`【dsh-mc-agent 行事准则（…）】` + 正文） | **只投一行指针**：文件绝对路径 + 怎么读 |
| 版本提示 | 注入 `versionPromptText()`（硬编码在 `src\version-prompt.mjs` 里，用户改不了） | 挪进真文件 **`<记忆根>\版本提示.md`**，同样**只投一行指针** |

指针长这样（`index.js` 的 `rulesPointerText()` 组装，`reconcileNotices()` 里两条都走它）：

```
📖 行事准则（Master 自定义版，长期有效）在文件里，**以文件为准**（改了立刻生效，不用重启）：
   `%USERPROFILE%\.dsh\dsh-mc-agent\memory\RULES.md`
   开工前先读一遍：`mc_kit_memory {action:"read", path:"RULES.md"}`（或 `read {file_path:"<绝对路径>"}`）
```

**为什么这么改**：正文只在"读的那一刻"占上下文，平时每次请求都省下这几千字符；而且**改文件立刻生效**，
不用重启、不用等插件重投（以前改 `RULES.md` 也要等下一次注入才会进上下文）。

配套的四件事：

- **`版本提示.md` 是文件了**：`src\version-prompt.mjs` 现在有 `readVersionPrompt`/`writeVersionPrompt`/
  `resetVersionPrompt`/`syncVersionPrompt`（四态 `created`/`marked`/`replaced`/`kept`，与 `agentsmd.mjs` 同构），
  版本标记存在 `config.json` 的 `versionPromptVersion`。默认正文 = `# dsh-mc-agent 版本提示` + 说明
  + 原来那两条规矩（先自己动手、指令只在必要时用；分享文件先放 `.dsh-mc-agent/.express/` 再 `mc_kit_express`）。
  正文里**不写版本号**（"是不是 Master 自定义过"是按内容判定的，写死版本号会让"随版本更新关掉"的旧文件被误判成自定义版）；
  版本由来源行 `dsh-mc-agent@<版本>（版本提示文件）`、设置页标题、`config.json` 三处携带。
- **设置页能改它**：「MC设置 → 提示词」里版本提示从"只读展示"变成**可编辑**（保存 / 恢复默认（二次确认）/ 看内置默认）。
  接口是 `/api/mc/agents-md` 加 `target:"version"`（不带 `target` 还是改 `RULES.md`）。
- **新会话会播种它**：`SESSION_SEED_FILES` 加上 `版本提示.md` ⇒ 开 `memoryPerSession` 时，你改过的那份会被带到
  新会话根（不会被内置默认盖掉）。
- **它和 `RULES.md` 一样是受保护文件**：`PROTECTED_FILES = ['RULES.md','AGENTS.md','版本提示.md','config.json']`
  ⇒ MC 模式里 AI **可读不可写**，要改只能由你在设置页改。

回归：`check-rules-file.mjs` **78/0**（真起一套假宿主 + 假状态目录，走 HTTP 接口改/读/恢复、真跑
`syncVersionPrompt` 的四态、静态钉死"注入里不再有正文"）。注意：**要重启 DSH 才生效**。

### 行事准则重写：内置默认和记忆里那份终于合成一份（2026-10-08）

用户原话：**"优化一下规则文件"**。查出来两处真问题：

- **两份准则已经分叉**：`src\agentsmd.mjs` 的 `DEFAULT_AGENTS_MD` 还停在 2026-09-18 的第五版，而记忆根里那份
  早被加了「说话方式」「打怪与保命」和「省算力」的其余五条 —— 也就是说**点一下「恢复默认」会把这几节全丢掉**
  （`readAgentsMd` 按内容判定，两份不一样就标成"Master 自定义版"）。现在两份是**同一份文本**，`source` 回到 `default`。
- **版本提示第 1 条在教它走歪路**：原文是"`mc_move`/`mc_act`/`mc_build` 还不成熟，先试 `mc_command` 发 `/tp`"。
  可现在寻路补丁、挖矿速度修正、自动换工具都上了，而**这台服的机器人没有 OP** —— 按这条走，第一步永远是
  发一条必定失败的指令。现在改成"**先自己动手**；指令只在用户明确要求、或自己动手确实做不到时用，
  真要用时可以先试一次；被拒就如实说，回到自己动手"。

顺手做的五件事：

- **修掉过时路径**：`## 记忆` 那节原来写死 `.dsh-mc-agent/`，可记忆根是可以配的（`memoryDir`），开了
  `memoryPerSession` 之后每个会话一个根。现在写"本文件所在的文件夹（绝对路径看注入的那行指针）"。
- **补「工具速查」整节**：一行一族（看 / 动 / 手 / 做 / 查 / 说与存 / 自主），把 `mc_craft`、`mc_furnace`、
  `mc_chest`、`mc_auto`、`mc_sequence`、`mc_kit_*` 这些后来加的工具都点了名 —— 以前准则里只提得到登录和看门狗那几个。
- **补「硬规矩」一条**：不许用 `/give`、`/gamemode`、`/effect` 给自己刷东西、变强、挪位置（当初 `/clear` 道歉那件事的教训）。
- **宗旨里写上长期目标**：木头 → 石器 → 铁 → 钻石 → 下界 → 末地 → 击败末影龙；没人安排就自己往前走。
- **补「干活习惯」整节**（用户随后提的三件事："挖完方块或者打完动物以后老是忘记走过去拾取，还有工作台和
  熔炉老是忘了带。一开始挖的木头不够多，老是上去砍木头"）：**挖完/打完先捡东西**（`mc_observe` 看「程序检测到」
  那段里地上的 `item`
  → `mc_move` 走过去站上去等它进背包；没进背包不算干完）· **出门带齐家伙**（`mc_craft` 做一张工作台、一座
  熔炉随身带，出门前 `mc_inventory` 过一眼镐/斧/锹/剑/火把/吃的）· **木头一次砍够**（开工先
  `mc_dig {name:"oak_log", count:16}`，16 根 = 64 块木板，中途缺就一次砍够再回去）。这三条终究是**决策**：
  `mc_dig` 只会顺手捡**脚边**那几个，`mc_auto` 待机才去捡地上的东西 ⇒ 插件层又补了一句提醒（下一节）。

份量：`RULES.md` 10813 → **12699** 字节（多出来的都是新增的工具速查、干活习惯与目标，正文里的散文压成了要点）；
`版本提示.md` 1915 → **2025** 字节。基根 + 8 个会话根全部写成同一份，所以
`mc_kit_memory {action:"read", path:"RULES.md"}` 读到的就是内置默认那一份。

### 插件层补一句"东西还在地上"（2026-10-08）

准则能提醒模型，但模型未必真去捡 —— 用户接着说"加一下"，于是插件层也补上（**只点一句，不替它走过去**：
先捡哪个、走多远是决策，而且打死怪 / 挖完方块时这一轮的预算基本已经花完了）：

- **`mc_act {mode:"attack"}`**：打死目标后结果里多一个 `pickup` 字段 ——
  `地上还有 1 个掉落物没捡（最近 2.5 格）—— 先 mc_move 走过去站上去，一两秒就飞进背包（掉落物几分钟就消失）`。
- **`mc_act {mode:"break"}`**：真挖掉之后同样带 `pickup`（这条路从来不自己捡东西）。
- **`mc_dig`**：原来只在捡到手时报"顺手捡回 N 个"；现在**一个都没捡到**（走不过去 / 卡住 / 背包满）时补一句
  "地上还有 N 个没捡"。捡到手时不提醒 —— 服务端把掉落物实体移出视野有延迟，刚捡完那一下它还挂在
  `bot.entities` 里，提醒会变成假警报。
- 判据只有一份：模块级 `isDropEntity()`（`#grabDrops` 与新增的 `#dropsNear` / `#dropHint` 共用）——
  以前 `#grabDrops` 里那份写错成 `e.type !== 'object'`，整条捡东西的功能静默失效（踩坑档案第 35 条）。

验证：`check-core-dig.mjs` **38/0 → 42/0**（新增"一个都没捡到 ⇒ 点一句"、"背包满了 ⇒ 提醒先存箱子"）、
`check-core-attack.mjs` **71/0 → 75/0**（新增"打死 + 地上有掉落物 ⇒ 带 `pickup`，牛不算掉落物"）。

顺手修掉的一个自检事故（踩坑档案第 26 条）：`selfcheck.mjs` 那套"❌ 不再静默腐烂"的记录器把**打印失败清单**
也记了一遍（清单每条以 `❌ ` 开头 ⇒ 打印出来的行又命中判据、又被 push 回去），`for...of` 边遍历边长
⇒ 死循环：输出涨到 **2.7 GB**、堆 OOM（exit 134）。现在打印走未被包装的 `__scLog` + 遍历副本，
`check-all.mjs` 也给每个子进程加了 5 分钟 `timeout`（跑飞的套件按失败报，不会把磁盘写满）。

### 长活儿有进度台账，不用模型自己记（2026-10-08 路线图第 ②③ 条）

用户 2026-10-08 的路线图里，第 ② 条是"高频动作批处理、减少重复推理"，第 ③ 条是
"`src/task-runner.mjs` 可恢复任务状态机"。两条合起来做的是同一件事：
**把"挖 16 根原木"这种长活儿变成一条有进度、有失败分类、有恢复入口的任务**，而且进度写在磁盘上。

- **什么时候开任务**：`mc_dig` 一次要挖 **4 个以上**就自动开一条。挖 1 个、或只给坐标不建任务
  —— 那种调用不需要记账，建了只是噪声。同一件事再叫一次会**接到同一条任务上**
  （按 `kind + item` 找活跃任务，不是"最近那个"：挖原木挖到一半跑去挖石头，回头再挖原木仍然接
  原来那条，进度不会从 0 开始）。
- **进度写在哪**：`<记忆根>/tasks.json`（`<记忆根>` = `RULES.md` 所在的目录）。
  **掉线、重连、换一轮对话回来都还在** —— 用户原话"**任务进度不能只保存在 AI 的对话上下文里**"。
  写入是 tmp + `renameSync` 原子替换（写到一半掉线不会留半截 JSON）；文件读坏了只记一条日志、
  从空表开始，不让整个插件崩；最多留 24 条（活跃的永远留）。
- **失败要分类，超时不算失败**：十类 `no-tool` / `no-target` / `unreachable` / `server-refused` /
  `budget` / `timeout` / `preempted` / `full` / `aborted` / `unknown`，每类带一个"下一步该干什么"
  （`craft-tool` / `scan` / `move-closer` / `reconnect` / `continue` / `store` / `stop`）。
  🔴 `budget` / `timeout` / `preempted` **不进循环检测**：一个长活儿跑三轮很正常，把它们算成
  "同一个动作连着失败 3 次"会让任务莫名其妙变成"卡住"（假警报）。用户原话
  "**超时不能自动当作失败，因为服务器可能已经执行了动作**"。
- **循环检测**：同一个动作 + 同一个原因连着 3 次 ⇒ 任务标 `blocked`，输出里说
  "别再原地重试：换个目标 / 换工具 / 或者取消"。被新指令抢占（`interruptMove` / abort）走
  `pause` —— **不是失败**，进度留着（用户原话"玩家发出新命令可取消或抢占旧任务"）。
- **恢复不重新规划**：`mc_task {action:"resume"}` 用**现场背包**复核进度
  （`oak_log` 数掉落物 `oak_log`、`stone` 数 `cobblestone`；认不出掉落物就如实 `verified:false`），
  再给出下一步该调哪个工具（`mc_dig {name,count,maxDistance}` / `mc_craft` / `mc_furnace` /
  `mc_chest` / `mc_move`）。
- **新工具 `mc_task`**：`list`（默认，看在做的事）/ `get`（明细 + 最近 8 条历史）/ `resume` /
  `note` / `done` / `cancel` / `forget`。`mc_dig` 收工时输出末尾会附一行
  `📋 t-20261008-… · dig · oak_log · 6/16个 · 进行中（再叫一次 mc_dig 接着挖；不想做了就 mc_task {action:"cancel"}）`
  —— 所以大多数时候不用单独调它。
- **`src/task-runner.mjs` 只记账，不抢控制权**：不 import 任何游戏库、不下发动作；移动编号
  （`#beginMove`）、控制位租约、11 秒预算、服务端破坏确认都还在 `core.mjs` 里。用户原话
  "新批处理层要**复用**已有的移动编号/控制位租约/服务端挖掘确认，别再造一套竞争的控制逻辑"。
- **规则也写了**：`RULES.md` 的 `## 省算力` 里加了"长活儿靠任务记账，别靠脑子记"（`resume` 怎么用、
  干完 `done`、不干 `cancel`），并明说"这一轮的 11 秒用完了"**不是失败**。
- **回归**：`selfcheck` 的工具数断言 28 → 29（新增 `mc_task`）；按
  `tools\check-token-budget.mjs` 的口径，`mc_*` 描述+参数合计 **17,859 / 18,000 字符**
  （`mc_task` 自己 290 字符）。⚠️ **本轮按用户要求没有跑套件与实机**（用户："你之后不要做测试了，
  我自己来测试"），只做了 `node --check` 与静态度量。

### 记忆分四类，每条带"来源/更新时间/成功失败次数"（2026-10-08 路线图第 ⑤ 条）

用户路线图第 ⑤ 条："长期记忆分四类（世界事实/操作经验/任务记录/用户规则）+ 每条加来源·更新时间·
成功次数·失败次数·适用版本；**失败记录要写发生条件，不能把目标标成永久不可达**。"

四类各有一个固定文件（每服一份，落在 `<记忆根>/<服名>/` 下）：

| 类 | 文件 | 装什么 |
| --- | --- | --- |
| 世界事实 `world` | `world.md` | 坐标、地标、基地布局、箱子/熔炉在哪、生物群系 —— "这里有什么" |
| 操作经验 `exp` | `lessons.md` | 怎么挖得动、哪条路好走、什么条件下会失败 |
| 任务记录 `task` | `tasks.md` | 干过什么长活儿、结果如何（**机器可读的进度在 `tasks.json`**） |
| 用户规则 `rule` | `RULES.md` | 用户定的规矩（**受保护文件，只读** —— 要改请让用户在「MC设置 → 提示词」里改） |

写法是一条一行、带元数据尾巴：

```
- **exp** — 红树林沼泽夜里别挖沙　｜　来源 玩家 Bluezi · 更新 2026-10-08 · 成功 1 / 失败 2 · 适用 1.21.9 · 条件 夜里怪太多
```

三个刻意的设计（都在 `src\memory.mjs` 的 `record()` 里）：

- **同 key 再记一次 = 累加次数**，不是新增一条。所以"这件事我试过 3 次成了 2 次"是一条记录，
  而不是三条会互相矛盾的记录。
- **失败必须写 `condition`**：`record({ok:false})` 不给条件**直接拒收**，报错文案就是那句
  "失败记录要写清**发生条件**……别写成永久结论（'X 不可达'）"。理由很实际：模型最容易把
  "这次没成"记成"这里没有" —— 之后每次路过都绕开，明明只是当时背包里没镐。
- **规则类不许写**：`kind:"rule"` 直接抛错并指路「MC设置 → 提示词」，免得模型自己改用户的规矩。

用法：`mc_kit_memory {action:"record", kind:"exp", key:"沼泽夜里挖沙", text:"…", ok:false, condition:"夜里怪太多"}`
（`kinds` 看四类各有几条）。工具动作从 7 个变成 9 个：`index/kinds/record/read/append/write/put/delete/search`。

### 三种结局：已确认成功 / 动作失败 / 结果未知（2026-10-08 路线图第 ⑥ 条）

用户路线图第 ⑥ 条："统一任务取消/超时/重连/恢复，区分'动作失败''结果未知''已确认成功'。"

关键认识是 **时间到 ≠ 没做成**。`mc_dig` 被 11 秒预算截断时，那一镐可能已经挖下去了；
`mc_move` 被新指令抢占时，人可能已经挪了两格；断线重连回来时，断线前那一轮的动作
**服务端已经执行了**（服务端不知道客户端断过线）。所以 `src\task-runner.mjs` 里加了
`outcomeOf()` / `verdictText()`，只认**证据**：

| 结局 | 判据（有证据才算） | 给模型的话 |
| --- | --- | --- |
| ✅ 已确认成功 | 那格变 air 且服务端回包确认 / `dug`·`placed`·`got` > 0 / `arrived` / `killed` / `broken` | `✅ 已确认成功（挖到 3/16 个）` |
| ❌ 动作失败 | 服务端复原、明确被拒、够不着、`NoPath`、没有能用的工具 | `❌ 动作失败（…）` |
| ❓ 结果未知 | `budget`/`timeout`/`preempted`，或读不出任何证据 | `❓ 结果未知（…）—— 时间到了/被打断，但**服务器可能已经做了**：先看一眼（`mc_observe`/`mc_inventory`/`mc_status`）再决定，别直接重做。` |

落点：

- `mc_move` / `mc_act` 的 `place`·`break`·`use`·`attack`：`index.js` 里一个 `withOutcome()` 统一补
  `outcome`/`outcomeText` 两个字段（`text()` 的渲染是 `JSON.stringify`，新字段自动出现在输出里）。
- `mc_dig`：返回的是**数组**（`#withHeld()` 的既有形状，不动它），所以改成往数组里 push 一行判决。
  🔴 **顺序必须是"先 `#taskSettle`、后 `#verdictLine`"** —— 判决行里含"动作失败"四个字，而
  `#taskSettle` 是靠扫输出里的关键词判失败的，先写判决会把**没失败的那一轮**记成失败。
- **断线**：`'end'` 处理器把在跑的任务标成 `paused`（理由"断线了"）—— 不标失败，因为服务端那边
  可能已经做了；**重连成功**时给当前任务留一句话（"进度还在，先 `mc_task {action:"resume"}` 复核"），
  并在日志里记一行。用户路线图原话"断点续跑（重连后恢复而不是重新规划）"。
- **规则也写了**：`RULES.md` 的 `## 干活习惯` 新增一条"看结果里那句结局"。

### 渐进拆分 `core.mjs`：第一刀先把纯函数搬出去（2026-10-08 路线图第 ④ 条）

用户路线图第 ④ 条："**渐进拆分** `src\core.mjs`（当时约 4,565 行）：先抽纯函数，再实体/背包/感知，
**移动和挖掘最后拆**（共享状态、异步中断、事件监听最密）；每次只迁一个模块并要求旧测试全过。"

第一刀落在 `src\format.mjs`，只搬了三个**没有 `this`、没有事件、没有异步**的函数：

| 搬走的 | 为什么它可以先搬 |
| --- | --- |
| `lossless()` | 递归纯函数，只碰 JS 内建类型（连一个 import 都不需要） |
| `redactPath()` | 只读环境变量 + `node:path`（把 `$DSH_HOME` 前缀换成 `$DSH_HOME/...`） |
| `resolveHarnessHome()` | 同上（`DSH_HOME` → `~/.dsh`），本来就是 `redactPath` 的私有依赖 |

迁移规矩（后面继续拆时照这个来）：

1. **`core.mjs` 里保留同名导出**：`export { lossless, redactPath } from './format.mjs'` ——
   外部（`index.js` 的 `import { lossless, redactPath } from './src/core.mjs'`、`tool-def.mjs`）
   **一行都不用改**，`core.mjs` 的公开面一点没变。
2. **一次只搬一个模块**，搬完立刻 `node --check` + 把 `core.mjs` 导入一遍，确认导出还在、行为没变。
3. **移动和挖掘最后再拆**：`#walkPathfinder()` / `dig()` 共享 `_moveGen`（移动编号）、
   `_ctrlLease`（控制位租约）、11 秒预算和一堆事件监听，是最容易"拆完看着没事、跑起来才怪"的部分。
4. **静态断言也要跟着搬**：套件里有"`core.mjs` 里有没有 `const SOFT_ROOF = `"这种**按文件找代码**的断言，
   代码一搬它就红 —— 红的是断言指错了文件，不是行为坏了。第二刀就踩到这个（见下）。
5. **先 `grep` 谁在 import 这个文件里的名字**：搬走的名字如果被**别的模块**从 `core.mjs` 导入，
   `core.mjs` 就必须 re-export 它，否则报的是 `The requested module '../src/core.mjs'
   does not provide an export named '…'` —— 那是**加载期**错误（整个扩展起不来），不是运行期。
   第三刀就是这种情况：`withTimeout` 被 `mc_chest` / `mc_craft` / `mc_furnace` / `mc_observe`
   四个扩展从 `../src/core.mjs` 导入，`raceAbort` 被 `selfcheck.mjs` 导入。
6. **`grep` 要 grep 整个仓库，不只 `import`**：套件里有一批断言是**按名字找代码**的
   （`has(coreNo, 'const JUNK_RE =')`、`pick(core, 'HOSTILE_RE')`、`/const pickEntity = \(list, who\)/`），
   文档里也会写这些名字。搬完先 `grep` 一遍**整个仓库**（`tools\` 与 `*.md` 都算），
   把"定义位置"和"调用点 / 断言 / 文档"分开看 —— 第四刀就是三处套件断言 + 四处文档要跟着改。
7. **搬家脚本别手写"要加 `export` 的白名单"**：第四刀那个脚本按名字白名单加 `export ` 前缀，
   漏写了 `isDropEntity` ⇒ 新模块导出不全，而 `node --check` **只查语法、不查导出**，
   要等真的 `import` 一次才报 `does not provide an export named '…'`（加载期错误）。
   所以每一步都要有一个**真的 import 一遍**的冒烟（构造一次 `McBot` 就够）。
8. **新模块不许反向 `import` 回 `core.mjs`**：如果被搬走的代码要读 `core.mjs` 里的东西
   （第五刀的 `logLine` 原来直接读 `DEFAULTS.logFile`），**别 import 回去** —— 那会造出
   `core ↔ 新模块` 的循环导入。改成"由 `core.mjs` 注入"：新模块开一个 `setXxx()`，
   `core.mjs` 定义完 `DEFAULTS` 之后调一次。冒烟里加一条"新模块里没有 `from './core.mjs'`"。
9. **"模块加载时读一次"的环境变量，搬进单例模块后要改成现读**：`MC_LOG_MAX_BYTES` /
   `MC_LOG_KEEP` 原来是 `core.mjs` 的模块级常量 —— 而 `core.mjs` **每个连接都会重新 import 一份**
   （`check-logging.mjs` 的 ⑥ 就是靠"改环境变量 → 重新 import 一份 core.mjs"来测轮转的）。
   搬进 `src/log.mjs` 之后它**整个进程只加载一次**，加载时读死就永远读到第一次那个值 ⇒ ⑥ 直接红。
   改法：把上限做成函数里现读（`logLimits()`）。**搬家前先问一句"这个模块会被加载几次"。**
10. **搬"私有方法"比搬"纯函数"多两件事**（第七刀）：① 签名要多一个 `b` —— `this.#heldText(b)`
   变成 `heldText(b)`，`#invUsed` 里那句 `this.#invSnap(b)` 也要改成 `invSnap(b)`，
   **所有调用点都得改**（第七刀是 15 处）；② 如果它是**公开方法**（`countOf(name)`），
   `core.mjs` 里要**留一个薄包装**（`countOf (name) { return countOf(this.bot, name) }`）——
   私有方法（`#`-名字）一个都不用留。这时**"逐字等价"验证法失效**（签名变了），
   要换成**行为对照**：把 `git HEAD` 里原来那批方法抽出来拼成"旧模块"，
   跟新模块在同一批假 bot × 同一批输入上逐条比对（第七刀是 189 条全等）。
11. **"grep 整个仓库"里必须有 `selfcheck.mjs`**（第八刀）：它里面有一批"读源码文本 → 逐条打 ✅/❌"的
   检查（例如 `selfcheck.mjs:3470` 的"放置可行性判据"五条），**它们不打 `fail`、不影响退出码** ——
   搬走一段代码之后，它会安静地留一个 ❌ 在满屏绿字里，而 `node tools\check-all.mjs` 照样"通过"。
   所以搬完除了 grep 套件，还要 grep 自检；改的时候把"查函数体字符串"的那几条改成
   `const both = coreSrc + '\n' + 新模块Src`（查名字的那几条仍查 `core.mjs`，因为"确实 import 了"
   只有 `core.mjs` 能证明）。
12. **能并进已有模块就别新开**（第八刀）：`CONTAINER_RE` / `TOGGLE_RE` / `canPlaceInto()` 跟
   `block-names.mjs` 里已有的 `isAir()` / `isLiquid()` 是同一层（都是"给方块名或方块对象做判断"的纯函数），
   而且 `canPlaceInto()` 内部就要调它们 ⇒ 并进去**依赖方向天然是顺的**，不用反向 import、不用注入。
   "一次只搬一个模块"里的"模块"可以是**已有的那个文件**。
13. **搬常量/工具函数时，先分清"哪部分是纯的、哪部分绑在实例上"**（第九刀）：预算这组里
   `TIMEOUTS` / `CALL_MS` / `CALL_BUDGET_MS` / `callBudget()` / `callDeadline()` / `callSecText()` /
   `budgetSecText()` 全是纯的 ⇒ 进模块；而 `setCallDeadline()` / `msLeft()` / `callLeft()` 读的是
   `this.callDeadlineAt` ⇒ **留在类里**，只是它们读的常量从模块导入。搬之前还要 grep 两遍：
   ① **谁 import 它**（`CALL_MS` / `CALL_BUDGET_MS` / `callBudget` / `callDeadline` 被 `index.js`、
   4 个扩展和 `tools\check-call-budget.mjs` 从 `core.mjs` 导入 ⇒ 必须原样 re-export，否则加载期就报
   `does not provide an export named …`）；② **谁在源码文本里找它**（`selfcheck.mjs` 那种 ✅/❌ 检查）。
   注意"公开面不变"的判据是**"以前 `export` 过"**，不是"有没有人用" —— `TIMEOUTS` / `callSecText` /
   `budgetSecText` 现在没人从外部引用，但以前是导出的，所以照样 re-export。
14. **一个名字在两个模块里表示两件事时，搬家顺手改名**（第十刀）：`core.mjs` 的 `#reachOf(b, blk)` 是
   "我离这块方块多远"（眼睛→方块中心），而 `extensions\mc_craft.mjs:77` 的 `reachOf(bot, id, need, …)`
   是"这个材料我够不够得着**做**出来" —— 两者无关却同名。搬进 `src\world-observer.mjs` 时把它改成
   `blockReachOf`，免得下一刀的人以为它们是同一个东西（改名时**用脚本统计命中数**，命中 0 处就抛错，
   否则"改名改漏一处"会变成运行期才发现的 `undefined`）。

15. **搬"公开方法"要给类留同名薄包装**（第十一刀）：`isUnderground()` / `heightmap()` / `mapImage()` /
   `static glyphMap()` 都被 `index.js`、套件和实机脚本从**实例/类**上调 —— 实现搬进 `src\map-render.mjs`
   之后，`core.mjs` 里必须留 `heightmap (opts = {}) { return heightmapOf(this.requireBot(), opts) }`
   这样的**同名薄包装**（顺带保住 `requireBot()` 的"不在线就抛"语义），而不是 re-export ——
   公开面靠包装活着，调用方一行都不用改。**验证也因此是 A/B 对照**：把 `git HEAD` 的 `core.mjs`
   临时拷回 `src\`（跑完即删）并 import 成第二个 `McBot`，同一批假世界上比 `heightmap()` / `mapImage()`
   的**逐字段、逐字节（RGBA）**结果（第十一刀 259 条全等）。

16. **薄包装的参数形状要跟原来一模一样**（第十二刀）：`scan()` 原来是 `scan ({ radius = 8, height = 4,
   name = null, limit = 10 } = {})`（收一个对象），`entities()` 是 `entities (radius = 24,
   { kind = 'all', limit = 40 } = {})`（**位置参数 + 可选对象**）。搬走之后包装写成
   `scan (opts = {})` / `entities (radius = 24, opts = {})` —— 位置参数、默认值、可选对象全都留着。
   调用方是**照签名**调的（`index.js` 给对象、`mc_observe` 给 `sess.bot.entities(distance, {…})`、
   套件给 `mc.entities(24, { kind: 'hostile' })`），签名一改就是**静默改行为**，而套件未必测到那一组
   ⇒ 所以这一刀的 A/B 把**每个参数组合**都过了一遍（3 种假世界 × 11 组 `scan` 选项 + 5 种假 bot ×
   16 组 `entities` 参数，全等）。

17. **实例状态不属于 `bot`：多给模块一个 `ctx` 参数**（第十三刀）：`status()` 除了 `bot` 还要读
   `this.sub` / `this._connectionProfile` / `this.lastError` / `this.reconnecting` /
   `this.reconnectPending` / `this.connectedAt` —— 这些**不属于 mineflayer 的 bot**，是插件的实例状态。
   硬把它们塞进假 bot 里会把模块污染成"半个类"；正确做法是薄包装把这几项**打包成一个 `ctx` 对象**
   传进去（`statusOf(b, ctx)`），模块本身保持"只吃参数、不反向 import core"的纯形状。判据：
   **凡是被搬走的代码里出现 `this.xxx`，就要问一句"这个 xxx 是 bot 的还是插件的"** ——
   是 bot 的（`this.bot`）当参数传，是插件的（`this.sub` 这类）进 `ctx`。

18. **A/B 的假数据必须复刻真实数据的形状，否则"等价"可能只是"两边都走了同一条死路"**（第十四刀）：
   `src\dig-speed.mjs` 的第一版冒烟**全绿（82/0）**，可那条最要紧的路一次都没走到 ——
   假 registry 里把 `incorrect_for_wooden_tool` 写成 `{900: 2, 901: 2}`（900/901 恰好是石镐/铁镐），
   于是 `fixDigMs` 一进门就撞上"这张表里有这把工具的倍率 ⇒ 数据没问题"直接返回 `null`，
   旧实现新实现**都**返回 `null` ⇒ 逐条比对当然一致。真实数据里那张表**只有木工具**
   （`{wooden_sword:2, wooden_pickaxe:2, wooden_axe:2, wooden_shovel:2}`）。按真实形状改完，
   样例才打出 `fixDigMs = 1150`（石镐挖铁矿）与 `patchDigTime` 后 `1302ms`
   —— 和 2026-10-08 实机 `live-digtime.mjs` 量到的 1302ms 对得上。
   判据：**搬完先看"这条路的输出是不是非空/非 null"，再看两边一不一致**；
   只比"两边相等"而不看"这条路到底走没走到"，等于给死代码发合格证。

19. **搬"实例状态 + 收尾动作"混在一起的方法：模块只做动作，状态全走 `ctx`**（第十五刀）：
   `#cancelCollect` 里既有"停后台采集任务"（纯动作）又有 `this._moveGen++` / `this.#stopPathing()` /
   `this.#releaseControls()` / `this.log()`（全是实例状态）。做法是模块签名 `cancelCollect(b, ctx)`，
   `ctx = { force, budgetMs, bumpGen, stopPathing, releaseControls, log }`，
   `core.mjs` 的薄包装把它们打包传进去 —— **薄包装里保留字面 `this._moveGen++`**，
   因为 `tools\check-call-budget.mjs` 有一句"抢占时把代号往前推（≥2 处）"是**按字面数**的。
   另外**收尾类动作一律"能失败"**：`try { … } catch {}` 包住每一步，别让"停任务失败"把主流程带崩。

20. **有可变实例状态的层，第一参数直接收 `self`（不是 `ctx`）**（第十六刀）：规矩第 17 条那个 `ctx`
   适合"只读几项实例状态"（`statusOf(b, ctx)`）；但聊天层要**改**状态 —— `self.chat` 是环形数组、
   `self.stats.chats` / `self._lastChatKey` 要累加、`self.emit()` 要发事件。硬套 `ctx` 就得写一堆
   `lastKey()` / `setLastKey()` getter/setter，只会更难读。所以判据补一句：**"要读"进 `ctx`，
   "要改"就直接收 `self`**；模块依旧不 import `core.mjs`、不 import 任何游戏库
   （聊天层只认 `{ on, _client, username }`）。公开方法照样留同名薄包装（规矩第 15 条）。

21. **每搬一个模块，都要跑一次"全仓断言扫描"**（第十六刀）：规矩第 6 条说"grep 整个仓库"，
   但人肉 grep 会漏 —— 第十二刀只改了 `check-core-entities.mjs`，漏了 `check-token-budget.mjs`
   第 5 节两条同款断言，它俩从那以后一直红着，直到第十六刀才发现。现在有
   `node tools\scan-moved-assertions.mjs`（顾问型、不判红、不进 `check-all` 的 ORDER）：
   收集 `src/*.mjs` 的导出名 → 扫 `tools\check-*.mjs` + `selfcheck.mjs` 里所有
   `.test(CORE|core|coreSrc|src|INDEX)` → 列出"提到这些名字 **且** 正则带实现细节"的断言，
   逐条人工确认它断言的是**薄包装**（没事）还是**已搬走的方法体**（改成查新模块 + 补接线断言）。
   搬完先跑它，再跑自己的临时静态对照脚本。
   **第二十三刀补**：第一遍是"按名字"扫，断言里没提名字的实现细节（`/budgetMs: 300/`）一条也看不到 ⇒ 加了**第二遍"按内容"扫**：把每条断言的正则直接拿去它断言的文件里试，在 core 里找不到、却能在别的 `src/*.mjs` 里找到的就报出来。
22. **一个 `ok()` 里塞两条正则时，扫描器可能只看到第一条**（第十七刀）：`check-core-evidence.mjs` 有一行
   `ok(/#aimAt \(b, point\)/.test(coreSrc) && /b\.entity\.yaw = yaw/.test(coreSrc), …)` —— 搬走 `#aimAt` 之后
   前半条（薄包装）照样绿、**后半条才是被搬走的实现**（`b.entity.yaw = yaw`），而扫描器当时把第一个
   `.test(` **之后**的内容整段切掉再判"有没有实现细节"，于是只看到 `/#aimAt \(b, point\)/`、判成
   "没有实现细节"直接跳过 ⇒ 又一次"扫描器没报，套件其实已经红了"。已修：抠掉整行**所有** `.test(<ident>)`
   再判，并把 `= `、`.方法(`、`??`、`||` 也算实现细节（命中数 24 → 36）。教训：**两条正则都要单独看一眼**。
23. **`lines.splice(n, …)` 是 0-based，锚点自检用的是 1-based**（第十八刀）：脚本里 `chk(2559, '  /**')`
   通过、紧接着 `lines.splice(2559, …)` 就把**第 2560 行**开始的那段删掉 ⇒ 第 2559 行那行 `/**` 留在原地，
   结果薄包装上方多出一行孤零零的 `/**`。**`node --check` 不会报**（那只是注释，语法完全合法），
   是靠搬完回读薄包装那一段才发现的。两条路选一条：喂进 `splice` 前统一 `- 1`，或者搬完立刻 `read`
   一下插入点前后 10 行。顺带：`split('\n')` 后每行带 `\r`，锚点比对要 `.replace(/\r$/, '')`。
24. **搬"要发包的动作"时，模块只做动作，实例/库相关的东西全走 `ctx`**（第十九刀）：`giveItem` / `clearInventory` /
25. **搬“服务端不回执的动作”：把 `await` 留在模块里，别把 promise 交回实例**（第二十刀）：`activateBlock` / `activateEntity` 的 promise 既可能挂着（内部那次不带 `force` 的 `lookAt`），也可能已经生效；模块自己 `await` + 复核（容器看 `currentWindow`、门看 `getProperties()` 翻没翻），core 只留一行 `return await useBlock(this.requireBot(), opts, ctx)`。一旦把 promise 交回去让调用方 `await`，就又会绕开复核、回到“我瞄了一下”报成“我用过了”的老坑（`踩坑档案.md` 第 9 条）。
    `tossItem` 都要 `await`（发包），而且分别需要"本轮还剩多少时间"（`this.#t`）和"造一个 `prismarine-item`"
    （`itemLoader()(b.registry)`）—— 前者是插件实例状态、后者是游戏库，都属于"模块不该知道"的东西。
    做法：薄包装把它们打包成 `ctx = { t, makeItem }` 传进去，模块继续**不 import 任何游戏库**。
26. **混合行尾的文件不能按行号切**（第二十一刀）：`core.mjs` 里既有 CRLF、又有少量孤立的 LF（历史上某些工具写进去的）
    ⇒ `raw.split('\r\n')` 得到的行号和 `Get-Content` / 编辑器看到的**不是一回事**，从第一个孤立 LF 起整体错开
    （这次偏了 28 行）。手术脚本要么**按内容定位**（`raw.indexOf(锚点)` + 括号配平 —— 第二十一刀最终就是这么改的），
    要么先 `raw.replace(/\r\n/g, '\n')` 统一了再切、搬完换回去。自检办法：`(raw.match(/\r\n/g)||[]).length`
    与 `raw.split('\n').length - 1` 对不上就说明是混合行尾。
27. **要回调一堆实例方法的层，第一参数收 `self`**（第二十二刀）：第 17 条的 `ctx` 只适合"读几项实例状态"，
    第 20 条的 `self` 是"要改状态"。还有一种：**既不改状态、又要调一堆实例方法**（`runSequence` 要回调
    `self.walkTo` / `self.placeBlock` / `self.dig` / `self.attack` …，还要读 `self.msLeft()` / `self.abortSignal` /
    `self.bot`）—— 把这一堆打包成 `ctx` 反而更绕，直接收 `self`。判据一句话：**"只读几项"用 `ctx`，
    "要改"或"要回调"用 `self`**。
28. **模块够不着私有方法，就把它塞进 `ctx`**（第二十三刀）：`#grabDrops` 搬进 `src\pickup.mjs` 之后，
    它还要调 `McBot` 的**私有**方法 `#cancelCollect` —— 私有名在模块外面**不能用字符串取**，所以薄包装把
    `cancelCollect: (bb, o) => this.#cancelCollect(bb, o)` 递进 `ctx`。判据：`self` 用来调**公开**实例方法，
    **私有**方法一律走 `ctx`（和第 19 条的 `makeItem`、第 24 条的 `ctx.t` 是同一个套路）。
29. **搬方法时，JSDoc 也要一起搬**（第二十四刀）：手术脚本删的范围是从 **JSDoc 开头**算起的，
    而写进新模块的只有**方法体** ⇒ 那些"为什么必须这么写"的注释直接从仓库里消失。
    这一刀 `#verdictLine` / `#taskSettle` 的整段 JSDoc 就是这么丢的（回读模块才发现；
    `node --check` 与冒烟照样全绿 —— 注释丢了不影响任何自动检查）。
    判据：**脚本删到哪儿，就把那儿的 JSDoc 也写进新模块**（或在 core 原位留一行指针）。
    第二十五刀补：**分节注释**（`/* ─── 世界观察器 ─── */`）同样跟着走，core 原位换成一行指针。
30. **薄包装和 import 撞名时，import 取别名**（第二十五刀）：`startObserver` / `stopObserver` 的薄包装
31. **搬进"已经存在的模块"时，那个模块头注释里的"N 件事"也要跟着改**（第二十六刀）：`src\chat.mjs` 从
32. **搬进"已经存在的模块"时，把新成员要用的兄弟依赖补进那个模块的 import**（第二十七刀）：`src\world-use.mjs`
33. **新写的头注释里不许出现 `*/`**（第二十八刀）：文档里写"按 `$DSH_HOME/profiles/*/vendor` 找"这种 glob，
    里面的 `*/` 会**提前把块注释关掉**，后面的注释行全变成代码（`node --check` 报 `SyntaxError: Unexpected identifier`，
    而且报的行号在注释中间，很迷惑）。写路径用 `<profile>` 占位，或者干脆换成反斜杠 `\` 分隔的写法。
    原来只 import `camera` / `block-names` / `entity-names` / `async-util`，收下 `equip` 之后要补
    `import { heldText } from './inventory.mjs'` —— 补之前先确认**不会成环**（`inventory.mjs` 不反向 import `world-use.mjs`）。
    "五件事"改成"六件事"，并把 `chatSay` 写进去 —— 头注释是这个项目"这个模块负责什么"的索引，落了新成员不改，
    下一个人就会按旧索引找（`src\inventory.mjs` 第 19 刀也是这么改的）。
    与搬出去的同名导出撞了名 —— JS 里能跑（**类方法名不进词法作用域**，方法体里的 `startObserver` 解析到模块导入），
    但读的人会以为是递归。做法：`import { startObserver as startObserverImpl, … }`，薄包装里调 `startObserverImpl(this, …)`。
    判据：模块里出现 `mineflayer` / `prismarine` 字样（哪怕只是 `import`）就该停下来看看。
    另外 `t` 的兜底写成 `ctx.t ?? ((p) => p)` —— 自写冒烟只关心行为，不必每次造一个真的闸门。
34. **A/B 两边抛同一个错，也算"通过"**（第二十九刀）：冒烟里 `try { a = f() } catch (e) { ea = e.message }` 这种写法，两边都抛同一个错时 `JSON.stringify(a) === JSON.stringify(b) && ea === eb` **照样绿** —— 而这条路一次都没走通。所以每条 A/B 都要配一条"真的走通了吗"的断言（输出非 `null`、`!ea && !eb`）。这一刀就撞上了：假 registry 让 `new Movements(bot)` 一路 `reading 'xxx'`（air / chest / fire / lava / water / sand / gravel / ladder / biomes…），六组 `movements` 全绿其实是六组空对空。
36. **改调用点的正则要连"尾参"一起改**（第三十一刀）：`await this.connect({ ...o, subserver: sub })` → `await connect(self, { ...o, subserver: sub }, ctx)` —— 只换前缀会漏掉第三个参数 `ctx`；自检里加一条"新调用点的参数个数对得上"（这次就是它把错误挡在写盘之前）。
35. **手术脚本的"不许残留 `this.`"自检要先把注释剥掉**（第三十刀）：`authOnly` 搬走的那段 JSDoc 里
    引用着旧 bug 的原话（"函数体还在读 `this.cfg.authUrl`"），`/\bthis\./` 一跑就报"authenticate 里还有 this."，
    脚本当场中止。做法：`const bare = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')`，
    再对 `bare` 断言 —— **注释里的 `this.` 是踩坑说明，代码里的才是残留**。
    另外手术脚本要保持"先全查、后写盘"的顺序：这次中止发生在写文件之前，仓库一点没被动过。
40. **A/B 两边不能共用一份"状态会变"的假件**（第三十五刀）：假 bot 的 `entity.isInWater` 是**时变**的
41. **按签名找函数体时，`indexOf('{')` 会先撞上参数里的解构 `{`**（第三十七刀）：`async #walkPathfinder (target, { arrive = 1.6, … } = {}) {` 这一行里**第一个 `{` 是参数的解构**，从它开始数花括号会在参数那个 `}` 就配平 ⇒ 抠出来的段落被截断在参数行，而 `node --check` 不会报（截出来的是半行源码，脚本自己写的"签名换成功了没"检查才会红）。判据：**先取第一个换行，再 `lastIndexOf('{', nl)`** 才是函数体那个 `{`。
42. **手术脚本要"先全查、后写盘"**（第三十八刀）：校验了"要删的那段"，却没校验"要插的锚点" —— 脚本先写了新模块、再去 core 插 import，锚点没命中就 `exit 1` ⇒ 仓库里留下一个**孤儿模块**（`src\mining.mjs` 已存在、core 一点没动），重跑还会被"文件已存在"挡住。做法：**所有锚点先验完**（要删的、要插的、import 的），最后才写文件；或者把写盘顺序反过来（先改 core、再写模块）。顺带一条：import 锚点**别按"单行 import"去猜** —— 这一刀 movement 的 import 是多行的（`import {` + 五行 + `} from './movement.mjs'`），锚点只取 `} from './movement.mjs'` 才稳。
43. **A/B 全绿不等于那条路走到了**（第三十九刀）：这一刀的冒烟 §A–§C 一开始就"旧新逐条一致"全绿，但其中两组用例（悬空垫脚）**两边都没走那条分支** —— 机器人脚下那格本身就是空气，代码连 `underFeet && !isAir(underFeet.name)` 都没进去。做法：写完用例回头问一句"这条分支的**前置条件**是什么"，照着摆世界（`#placeRef` 只在目标格的 6 个邻居里找依附面，而垫脚垫的是**自己脚下那格** ⇒ 要让目标紧挨着脚上方、脚下放一块实心）。
44. **A/B 全绿 + 调用序列一致，也可能是同一份用例把两边带到了同一条错路上**（第四十刀）：`dig` 的冒烟 40 条断言一次全绿，可 §B 那四条出口（服务端确认 / 复原 / 没收到回包 / 还是原方块）**全都走的是"够不着"那条** —— 目标摆在 `z: 5`，眼睛→方块中心 5.6 格 > 4.5，`dig` 在"够不着"检查那里就 `continue` 了，四条出口一条没走到。做法：① 每条用例配一条"**这条路真的走到了**"的断言（输出里那句特有的话、或调用序列里那个特有的计数）；② 写完把**输出打出来看一眼**（这次就是 `node` 打印三组返回值才看出来的）。
45. **带定时器的状态层：状态字段留在实例，读写逻辑搬进模块**（第四十一刀）：`holdControl` / `#releaseControls` 既读 `self._ctrlLease`（`{控制位: 到期时刻}`），又自己 `setTimeout` 到点松手 —— 搬的时候**只搬读写**，租约表本身留在 `core.mjs`（它是实例状态，模块不碰 `this`）。判据：先问"这个方法动的是**实例字段**还是**纯数据**"；实例字段留原地，方法体收 `self` 进去。
    （过了 `waterAfter` 就"出水"），`pair()` 里新旧共用一份、而且**同时**造出来 ⇒ 先跑的那边耗掉 200ms，
46. **"抠旧实现"要连它依赖的模块级 import 一起搬**（第四十二刀）：从旧 `core.mjs` 里按签名抠出方法当 A/B 的"旧实现"时，方法体里除了 `this.xxx`，还可能直接调**模块级函数**（`taskStart` 调的是导入进来的 `taskHave(self.bot, …)`，不是私有方法）—— 只把方法体搬进临时 `class Old` 会缺这个标识符，冒烟 7 条全红在"旧侧 `taskHave is not defined`"。做法：把新模块的 import 也照抄进临时旧模块（`import { taskHave } from './task-report.mjs'`）。 **第四十三刀又踩到同一处**（旧侧 `raceAbort is not defined` / `abortError is not defined`）⇒ 判据扩成"方法体 + 它引用的**所有**模块级标识符（函数、常量、类）"，不只是 import 名。
    后跑的那边一进门就"已经不在水里"，比出来的差异全是测试自己的锅。做法：新旧**各造一份**假件，
    而且 **B 要在 A 跑完之后再造**（不然 B 的时钟也从同一刻起算）；要"推号"就推到**旧实现真正在用的那个实例**上。
    判据：假件里带**时间 / 次数 / 状态**的字段，A/B 就不能共享。

**第二刀（`src\block-names.mjs`）**：搬的是"只认字符串"的那一层 ——
`isAir()` / `isLiquid()` / `isPassable()` / `SOFT_ROOF`，以及地形图的 `glyphOf()` / `colorOf()` /
`CAVE_GLYPH` / `CAVE_LABEL` / `COLORS`。它跟第一刀的区别是：**这些名字在 `core.mjs` 里被 27 处调用**
（洞穴层分类、`build` 跳过空气、`dig` 拒流体、地表图着色…），所以搬完必须确认导入的名字一个不少 ——
`glyphOf` 还是 `core.mjs` 的导出（`tools\check-core-map.mjs` 就靠它），另外两个纯内部。

**验证**：临时冒烟脚本（跑完即删）**42/0**（公开面、三种空气/液体/能穿过去、洞穴字形 8 个、
地表字形逐类、`colorOf` 后缀规则与兜底、`core.mjs` 里没有残留定义、`McBot` 仍能构造），
外加一份**行为对照**：把 `git HEAD` 里搬走前那份原样抽出来，对 **108 个方块名 × 6 个函数**
逐条比对 ⇒ **664/0**（旧代码和新模块的输出一字不差）。⚠️ 本轮按用户要求没有跑项目套件。

**第三刀（`src\async-util.mjs`）**：搬的是**异步叶子** —— `sleep()` / `withTimeout()` /
`raceAbort()` / `abortError()`。它们不碰 `this`、不碰 mineflayer、不碰事件、不碰世界，
只是 Promise 与 AbortSignal 的算术，`withTimeout` 里那句"超时常见原因是目标够不着，
不是失步"的文案也原样搬了过去（改文案的教训见踩坑档案）。

它的关键约束正是迁移规矩第 5 条：`withTimeout` 有**四个扩展**从 `../src/core.mjs` 导入，
`raceAbort` 被 `selfcheck.mjs` 导入 ⇒ `core.mjs` 里 `export { withTimeout, raceAbort } from
'./async-util.mjs'` 一行不能少。`sleep` 和 `abortError` 在 `core.mjs` 里本来就是**私有**的
（没有导出），所以不用 re-export，只 import 进来用。`core.mjs` 4832 → **4776 行**。

**验证**：冒烟 **32/0**（同名导出的**函数对象**相等、`withTimeout` 的正常/超时/非超时/定时器清理、
`raceAbort` 的透传/立刻结算/已 abort/先完成、`abortError` 带 `mcAborted` 与 `reason`、
`core.mjs` 里没有残留定义且确实 import 了、`async-util.mjs` 不 import mineflayer、`McBot` 仍能构造），
外加一份**逐字等价**证明：把 `git HEAD` 里搬走前那四段原文抽出来与新模块比对 ⇒ **4/4 完全相同**
（只差一个 `export ` 前缀）—— 这是这一刀最硬的证据：代码是原文搬过去的，不是重写的。
⚠️ 本轮按用户要求没有跑项目套件。

**第四刀（`src\entity-names.mjs`）**：搬的是"**谁是谁**"那一层 —— `HOSTILE_RE` / `RANGED_RE`
（敌对与远程名单）、`JUNK_RE`（掉落物/投掷物）、`NOT_DROP_RE` + `isDropEntity()`（掉落物判据，
只有这一份）、`NAME_ALIAS`（中文叫法 → 实体名）、`entityNameOf()` / `nameFieldsOf()` /
`matchNameOf()` / `pickEntity()`（名字匹配与挑选）。全是**纯函数与常量**：只认传进来的实体对象，
不碰 `bot`、不碰世界、不碰事件 —— 是"实体层"里唯一不读实时状态的那半，所以排在实体/背包/感知之前搬。
`core.mjs` 4777 → **4702 行**。

这一刀跟前三刀有两个不同：① 这批名字**一个都没被外部 import**（全是 `core.mjs` 私有件）
⇒ 不用 re-export，只 import 进来用；② 但**三处套件断言按名字找它们**、**四处文档写着它们**
（迁移规矩第 6 条）⇒ `tools\check-core-attack.mjs`（四条改成读 `entity-names.mjs`）、
`tools\check-core-entities.mjs`（逐字比对两份名单改成读新文件）、
`tools\check-core-evidence.mjs`（`matchNameOf` / `pickEntity` 改读新文件）都要跟着改，
并且各自补一条"`core.mjs` 确实从 `entity-names.mjs` 导入了"（否则"搬走 + 忘接"也会绿）。

**验证**：冒烟 **40/0**（十个导出齐全、两份名单与 `mc_auto.mjs` 的 `HOSTILE` / `RANGED`
逐字一致、敌对/远程/掉落物判据正反例、`entityNameOf` 玩家优先 `username`、
`matchNameOf` 前缀与中文别名、`pickEntity` 按距离排序与找不到给 `null`、
`core.mjs` 里没有残留定义且十个名字都导入了、新模块不 import 游戏库、`McBot` 仍能构造），
外加**逐字等价 2/2**（`git HEAD` 里搬走前那两段原文与新模块比对，只差 `export ` 前缀）。
⚠️ 本轮按用户要求没有跑项目套件。

**第五刀（`src\log.mjs`）**：搬的是**日志基建** —— `stamp()` / `logLevel()` / `logLine()` /
`logDebug()` / `logOnce()` / `appendLog()` / `rotateLogIfNeeded()` / `LOG_LEVELS`，
`core.mjs` **4702 → 4623 行**。它跟前四刀都不同，是唯一"**自己带默认值**"的一刀：

- `logLine()` / `logDebug()` 原来直接读 `DEFAULTS.logFile`，而 `DEFAULTS` 定义在 `core.mjs` 里
  ⇒ **不能 import 回去**（循环导入）。改成"由 `core.mjs` 注入"：新模块给一个
  `setDefaultLogFile(file)`，`core.mjs` 在 `DEFAULTS` 之后调一次（迁移规矩第 8 条）。
- `MC_LOG_MAX_BYTES` / `MC_LOG_KEEP` 原来是模块级常量。`core.mjs` 每个连接都会重新 import 一份，
  所以"加载时读一次"没问题；搬进 `log.mjs` 之后它整个进程**只加载一次**
  ⇒ 必须改成轮转时**现读**（`logLimits()`），否则 `check-logging.mjs` 的 ⑥
  （改环境变量 → 重新 import 一份 `core.mjs` → 看轮转）会永远读到旧上限（迁移规矩第 9 条）。
- 公开面照旧 re-export（`logLine` / `logDebug` / `logOnce` / `logLevel` / `stamp` 被 `index.js`、
  4 个扩展、8 个套件从 `core.mjs` 导入），`LOG_LEVELS` / `appendLog` / `setDefaultLogFile`
  只 import 不 re-export（以前就是私有件）。

**验证**：冒烟 **31/0**（re-export 是同一批函数对象、`LOG_LEVELS`/`appendLog` 没被多导出、
注入的默认落点就是 `DEFAULTS.logFile`、`logLine` 本地时间前缀、`logDebug` 默认不落盘、
`logOnce` 跨实例只打一次（换一份 `log.mjs` 实例仍然认得出）、`McBot.log` 写自己的
`cfg.logFile` 且带短标签、轮转**现读**上限与 `MC_LOG_KEEP`、`core.mjs` 无残留定义、
`log.mjs` 不反向 import `core.mjs`、不碰游戏库）+ **逐字等价 7/7**（七个函数的正文与
`git HEAD` 比对，只差 `export ` / 注入 / 现读上限三处有意改动）+ 7 个扩展模块逐个 import 成功。
`tools\check-logging.mjs` 的 ⑦ 静态断言改成查 `src\log.mjs`（并补"`core.mjs` 确实 re-export"、
"轮转上限是现读"两条），④ 的"换个模块实例"改成换 **`log.mjs`** 的实例。
⚠️ 本轮按用户要求没有跑项目套件。

**第六刀（`src\place-items.mjs`）**：搬的是"**挑方块 / 垫脚料**"那一层 ——
`NON_FULL_BLOCK`（形状不是整方块的方块名黑名单）/ `isFullBlockItem(bot, name)`（三段判据）/
`NO_SCAFFOLD`（贵重方块与家当不拿去垫）/ `scaffoldingItemIds(bot)`（交给 pathfinder 的
`scafoldingBlocks`）/ `pickPlaceItem(bot, want)`。`core.mjs` **4624 → 4561 行**。

这一刀是 ④ 里**第一个碰 `bot` 的模块**（前五刀都不碰）：但判据只读
`bot.registry.blocksByName` 与 `bot.inventory.items()` —— 不看世界、不发包、不改状态，
所以仍在"搬走不会动到异步流程"的安全区里（这也是路线图里"再实体/背包/感知"的第一小步）。

- 三个公开件（`isFullBlockItem` / `scaffoldingItemIds` / `pickPlaceItem`）**被外部从
  `core.mjs` import**（`tools\check-core-place.mjs:53`、`实机验证\搭方块\live-place.mjs:18`）
  ⇒ 必须 re-export（迁移规矩第 5 条）；`NON_FULL_BLOCK` / `NO_SCAFFOLD` 是私有件
  ⇒ 只 import、不多导出（公开面一点没变）。
- 这一刀**没有**"按文件找代码"的硬断言会红：`check-core-place.mjs` 是行为断言，
  外加一份**故意写得和源码不一样**的独立词表做交叉验证 —— 只有一行注释写着
  "`src/core.mjs` 里的 `NON_FULL_BLOCK`"。顺手改掉，并按迁移规矩第 6 条补了
  **⑥ 接线**四条静态断言（core 确实 import / 确实 re-export / 两份名单在新模块 /
  core 里没有残留定义）。

**验证**：冒烟 **40/0**（五个导出、三个公开件是同一个函数对象、`NON_FULL_BLOCK`/`NO_SCAFFOLD`
没被多导出、`isFullBlockItem` 三段判据正反例、`scaffoldingItemIds` 只认整方块/排除家当/按存货排序/
同种方块只留一个 id、`pickPlaceItem` 跳过火把与半砖但显式点名不拦、`core.mjs` 无残留定义、
新模块不反向 import core 也不碰游戏库、`McBot` 仍能构造）+ **逐字等价 68/68**
（`git HEAD` 里那 68 行与新模块正文逐字比对，只差两个 `export ` 前缀）+ 7 个扩展逐个 import 成功。
⚠️ 本轮按用户要求没有跑项目套件。

**第七刀（`src\inventory.mjs`）**：搬的是**背包那一层** —— `heldText` / `invSnap` / `invUsed` /
`canHarvestNow` / `toolKinds` / `countOf` / `freeSlot`（原来是 `McBot` 的五个私有方法
`#heldText` / `#invSnap` / `#invUsed` / `#canHarvestNow` / `#toolKinds`、一个私有方法 `#freeSlot`、
一个公开方法 `countOf`）。`core.mjs` **4560 → 4500 行**（七刀累计 4896 → 4500）。

这一刀跟前六刀**有本质区别**，所以验证手法也换了：

- **前六刀是"原文搬出"**：函数体一个字不改，靠"逐字等价"证明安全。
  **这一刀签名变了**：私有方法 `this.#heldText(b)` 变成模块函数 `heldText(b)`，
  调用点从 `this.#heldText(b)` 改成 `heldText(b)`（**15 处**），`#invUsed` 里那句
  `this.#invSnap(b)` 改成 `invSnap(b)`。所以验证改成**行为对照**：把 `git HEAD` 里原来那七个方法
  抽出来拼成一份"旧模块"，跟新模块在同一批假 bot × 同一批输入上逐条比对 ——
  **189 条全等**（7 种假 bot × 4 份背包快照 × 6 种方块 × 名字/槽位各种边界）。
- **公开面必须留薄包装**：`countOf(name)` 是 `McBot` 的公开方法（任务台账在用），
  搬走函数体之后在 `core.mjs` 里留成 `countOf (name) { return countOf(this.bot, name) }` ——
  方法名和模块函数同名（`this.countOf` 是方法、裸 `countOf` 是 import），外部调用点一行都不用改。
  私有方法则**一个都不留**（`#`-名字本来就不是公开面）。
- **静态断言这次逮到两处**（迁移规矩第 6 条又救了一次）：`tools\check-core-equip.mjs` ⑦ 有
  `/#heldText \(b\) \{/`、`/#canHarvestNow \(b, blk\) \{/`、`/#toolKinds \(b, blk\) \{/`、
  `/#invSnap \(b\) \{/`、`/if \(!this\.#canHarvestNow\(b, blk\)\) \{/`、`/const held = this\.#heldText\(b\)/` 六条，
  `tools\check-core-evidence.mjs` 有 `this\.#invSnap\(b\)` 与 `#heldText \(b\)` 两条 —— 全部改成查
  `src\inventory.mjs` 的 `export function …`，并**各补一条"`core.mjs` 确实 import 了"**
  （否则"搬走 + 忘接"也会绿）。

**验证**：冒烟 **225/0**（含 189 条行为对照 + 结构断言：七个导出、`core.mjs` 无残留定义、
保留公开方法 `countOf` 且是薄包装、没有多写 re-export、新模块不反向 import core 也不碰游戏库、
`McBot` 仍能构造且 `prototype.countOf` 还在、语义抽查：`dirtx18` / `空手` / 读不到回 `null` 而
确实没有回 `0` / 同名两叠合计 / 创造模式永远能挖 / `需要斧／剪刀` / 优先复用同款槽）
+ `node --check`（`core.mjs` / `inventory.mjs` / 两个套件）+ 两个套件里那 17 条判据逐条跑过
+ 8 个扩展文件逐个 import 成功。

⚠️ 本轮按用户要求没有跑项目套件。

**第八刀（并进 `src\block-names.mjs`，没有新建模块）**：搬的是**右键交互判据 + 能不能放方块** ——
`CONTAINER_RE`（右键能打开窗口的方块：箱子/熔炉/工作台/漏斗… —— `use` 之后窗口该出现，这就是
"交互成功"的硬证据）、`TOGGLE_RE`（右键会翻转状态的：门/活板门/栅栏门/按钮/拉杆 —— 可以复核状态变没变）、
`canPlaceInto(blk)`（这个位置能不能放方块进去：判据是 `boundingBox === 'empty'`，**不是**"名字是不是 air"
—— 水/岩浆/草/花/火把/铁轨都能放，石头/木板/台阶不能）。`core.mjs` **4501 → 4478 行**（八刀累计 4896 → 4478）。

- **为什么并进 `block-names.mjs` 而不是新开一个**：这三个都是"给方块名或方块对象做判断"的纯函数，
  而且 `canPlaceInto()` 内部要调 `isAir()` / `isLiquid()` —— 它们已经住在这个模块里，
  搬过来**依赖方向天然是顺的**（新模块 → 已有模块），不用反向 import、不用注入。
  这也让迁移规矩"一次只搬一个模块"里的"模块"落到已有的那个文件上。
- **这一刀没有任何 re-export**：三个名字在 `core.mjs` 里本来就是私有件（`const` 不导出），
  外部（`index.js`、`extensions\*.mjs`、`tools\*`）一处都没引用过 —— 全仓 grep 只有两处调用点
  （`if (CONTAINER_RE.test(blk.name))` 在 `useBlock`、`if (!canPlaceInto(targetBlock))` 在 `build`）。
  ⚠️ 注意 `extensions\mc_util.mjs` 里**自己有一份 `canPlaceInto`**（扩展层不能 import core，
  所以是平行实现，`mc_craft` 用它的）—— 搬 core 这份不影响扩展那份。
- **静态断言又逮到两处（第九次）**：`tools\check-core-evidence.mjs` 的
  `/const CONTAINER_RE = /.test(coreSrc) && /const TOGGLE_RE = /.test(coreSrc)` 改成查 `block-names.mjs`
  的 `export const …`，并补一条"`core.mjs` 确实从 `block-names.mjs` 导入了 `CONTAINER_RE`"。
- **🔴 这一刀暴露了一个新变体：`selfcheck.mjs` 里那种"逐条打印 ✅/❌"的检查不会让自检失败**。
  `selfcheck.mjs:3470` 那段"放置可行性判据"读的是 `./src/core.mjs`，检查五条：`boundingBox === 'empty'`、
  `isLiquid`、`canPlaceInto`、`未加载（区块还没到）`、`占住，放不进去`。其中 `boundingBox === 'empty'`
  是**函数体里的字符串**，搬走之后 `core.mjs` 里就没有了 ⇒ 自检会**安静地打一个 ❌ 然后继续跑完、退出码 0**。
  前两条（`isLiquid`、`canPlaceInto`）只查名字，import 行里还有、照样绿 —— 所以**光看"自检退出码 0"看不出来**。
  修法：那一段改成 `const both = src + '\n' + blockNamesSrc`（连新模块一起读），
  并在 `踩坑档案.md` 第 49 条记下这个变体。

**验证**：冒烟 **46/0**（22/22 逐字等价 + 结构 12 条 + 行为 30 条 + 能构造）
+ `node --check`（`core.mjs` / `block-names.mjs` / `check-core-evidence.mjs` / `selfcheck.mjs`）
+ 两个套件里我改过的那几条判据**逐条原文跑过**（含一条"反面断言"：确认 `core.mjs` 里确实已经
没有 `boundingBox === 'empty'` 了，证明自检那段确实必须连新模块一起读）
+ `index.js` 与 8 个扩展逐个 import 成功。

⚠️ 本轮同样按用户要求没有跑项目套件。

**第九刀（`src\budget.mjs`）**：搬的是**单次调用的时间预算** ——
`TIMEOUTS`（十类操作的默认超时）、`CALL_MS = 11_000` / `CALL_BUDGET_MS = 10_000`、
`callBudget(v, def, cap)`（把预算钳进 `[200, cap]`；`0`/负数/非数字一律当"没给"）、
`callDeadline(ms)`、以及两个文案函数 `callSecText()` / `budgetSecText()`（秒数跟着常量走，
以后改上限不用再挨个改文案）。共 38 行，逐字搬出（`export const` 原样，一个字符没改）。
`core.mjs` **4477 → 4441 行**（九刀累计 4896 → 4441）。

- **这一刀第一次遇到"必须 re-export 四个名字"**：`CALL_MS` / `CALL_BUDGET_MS` / `callBudget` /
  `callDeadline` 被 `index.js`、`extensions\{mc_chest,mc_craft,mc_furnace,mc_observe}.mjs` 和
  `tools\check-call-budget.mjs` 从 `core.mjs` 导入 ⇒ `core.mjs` 里那句
  `export { TIMEOUTS, CALL_MS, CALL_BUDGET_MS, callBudget, callDeadline, callSecText, budgetSecText } from './budget.mjs'`
  一个都不能少（少了是**加载期**报 `does not provide an export named …`，不是运行期）。
  五个扩展里那四行 `import { withTimeout, CALL_MS, callBudget } from '../src/core.mjs'` 一行都不用改。
- **"公开面不变"的判据是"以前 `export` 过"**：`TIMEOUTS` / `callSecText` / `budgetSecText` 现在
  全仓没人从外部引用，但以前是导出的 ⇒ 照样 re-export（这是迁移规矩第 13 条）。
- **纯的进模块、绑实例的留类里**：`setCallDeadline()` / `msLeft()` / `callLeft()` 读 `this.callDeadlineAt`
  ⇒ 留在 `core.mjs` 的类里，只是它们读的 `CALL_MS` 改成从模块导入。
- **这一刀没有新的"被断言逮住"**：`tools\check-call-budget.mjs:143` 那两条
  （`CALL_MS === 11_000`、`CALL_BUDGET_MS === 10_000`）是**行为断言**（对导入进来的值比较），
  不是"按源码文本找定义"，所以 re-export 之后照旧绿；`selfcheck.mjs` 里也一处都没引用这些名字。

**验证**：冒烟 **51/0**（7 个导出 + 6 个 re-export 同一性 + 常量与十类超时取值 + `callBudget` 12 条钳制
+ `callDeadline` 两条 + core 无残留定义/确实 import/确实 re-export + 新模块不反向 import core 也不碰游戏库
+ **38/38 逐字等价**（与 `git HEAD` 比对）+ 实例侧 `msLeft`/`setCallDeadline(0)`/`callLeft` 照旧）
+ 接线 **17/0**（`index.js` 与 8 个扩展逐个 import 成功、`core.mjs` 仍对外提供那七个名字、
`selfcheck.mjs` 里零引用）+ `node --check`（`budget.mjs` / `core.mjs`）。

⚠️ 本轮同样按用户要求没有跑项目套件。

**第十刀（`src\world-observer.mjs`）**：搬的是**只读观察**那一层 —— 七个原来住在类里的私有方法：
`#entityHealth`（读血量，读不到回 `null`，**不编**）、`#inWaterNow`（脚在水的 AABB 里**或**眼睛那格是水 ——
`entity.isInWater` 浮在水面时读出来是 false）、`#slowDigWhy`（"我在水里 / 我在空中，挖方块慢 5 倍"）、
`#dropsNear` / `#dropHint`（附近还没捡的掉落物 + "东西还掉在地上"那句话）、`#reachOf`、`#stateNameOf`。
共 102 行（含各自的 JSDoc），`core.mjs` **4440 → 4338 行**（十刀累计 4896 → 4338）。

- **搬的是"私有方法"而不是纯函数**（第七刀那类）：签名比原来多一个 `b`（原来是 `this.#x(b)`），
  所以验证方式不是"逐字等价"而是**行为对照** —— 冒烟从 `git HEAD` 抽出那七个旧方法写成临时模块，
  与 `src\world-observer.mjs` 在 7 种假 bot 上逐条比对（69/0，其中 30 条是"与 HEAD 一致"）。
- **顺手改了名**：`#reachOf` → `blockReachOf` —— `extensions\mc_craft.mjs:77` 里有一个同名的
  `reachOf(bot, id, need, …)`，那个是"这个材料我够不够得着**做**"，跟"我离这块方块多远"不是一回事，
  留在同一个仓库里同名会让下一刀的人以为它们是同一个东西（迁移规矩第 14 条）。
- **没有 re-export**：七个名字以前都是私有件（全仓只有 `core.mjs` 自己用），公开面一行都没变。
- **两个套件按名字找它们**（第 46 条那个坑，第十次）：`tools\check-core-attack.mjs` 的
  `has(coreNo, '#entityHealth (b, e)')` / `has(coreNo, 'const hpBefore = this.#entityHealth(b, target)')` /
  `has(coreNo, 'if (this.#reachOf(b, fresh) > reachMax) {')`，以及 `tools\check-core-swim.mjs` 的三条
  `this.#inWaterNow(b)` ⇒ 全部改成新模块里的 `export function …` 与改名后的调用点，并**各补一条
  "`core.mjs` 确实 import 了"**（否则"搬走 + 忘接线"也会绿）。
- **这一刀没有新 bug**：唯一红的三条是**我自己的断言写错了**（我以为 `isDropEntity` 认经验球，
  实际 core 那份只认 `item` —— 认经验球的是 `extensions\mc_auto.mjs` 自己那份，
  两份的差别是有意的：`#grabDrops` 要的是"能捡起来的掉落物"）。

**验证**：冒烟 **69/0**（7 个导出 + 结构 10 条 + **30 条与 HEAD 行为一致** + 文案/边界 + `McBot` 仍能构造）
+ 改过的断言逐条重跑 **33/0**（含反面断言"旧写法已经消失"）+ 接线（`index.js` 与 8 个扩展逐个 import 成功、
`core.mjs` 没多导出这七个）+ `node --check`（`core.mjs` / `world-observer.mjs` / 两个套件）。

⚠️ 本轮同样按用户要求没有跑项目套件。

**第十一刀（`src\map-render.mjs`）**：搬的是**地图那一层** —— `isUnderground()`（头顶 40 格内有没有实心遮挡，
树叶/竹子/雪层这类"软顶"不算）、`#caveCell`（洞穴层一格：先看身体那两格、再看脚下）、`heightmap()`（俯视地形，
`mode: auto|surface|cave` + `slab`，自带 2.5 秒软上限）、`static glyphMap()`（字符图）、`mapImage()`（RGBA 像素图）。
共 213 行（含各自的 JSDoc），`core.mjs` **4338 → 4134 行**（十一刀累计 4896 → 4134）。

- **这一刀第一次搬"公开方法"**：`isUnderground` / `heightmap` / `mapImage` / `static glyphMap` 都被
  `index.js`、`tools\check-core-map.mjs`、`实机验证\地图\live-map.mjs` 从实例/类上调 ⇒ `core.mjs` 里留
  **四个同名薄包装**（迁移规矩第 15 条），**不 re-export**；`#caveCell` 是私有件，去掉井号变成模块级
  `caveCell(b, x, cy, z, slab)`。
- **新模块只借 `vec3`**（不是 mineflayer）：`bot.blockAt()` 必须喂**真 Vec3**，传普通 `{x,y,z}` 会在
  `prismarine-world` 里报 `pos.floored is not a function` —— 这条坑在 `eyeOf()` 那次已经踩过。
- **顺手瘦身**：`CAVE_LABEL` / `CAVE_GLYPH` / `colorOf` / `isPassable` / `SOFT_ROOF` 搬走后在 `core.mjs`
  里再没有调用点，于是从 `core.mjs` 的 `block-names` 导入行里删掉（`glyphOf` 留着，它仍是 `core.mjs`
  的导出，套件靠它）。
- **`tools\check-core-map.mjs` 的静态断言又按名字找代码**（第 46 条那个坑，**第十一次**）：原来查的是
  `core.mjs` 里的 `#caveCell (b, x, cy, z, slab) {`、`const cave = … this.isUnderground()`、
  `mapImage ({ radius = 32, … } = {})` ⇒ 改成查 `src\map-render.mjs` 里的 `export function …`，并补
  "`core.mjs` 确实从 `map-render.mjs` 导入" + "四个薄包装都在" + 两条反面断言（没有残留 `#caveCell`、
  没有多写 re-export）—— 否则"搬走 + 忘接线"也会绿。

**验证**：冒烟 **306/0**（5 个导出 + 结构 20 条 + **259 条 A/B 对照**：7 种假世界（露天/石头地面/树冠/
2 格高巷道/深坑/区块没加载/岩浆）× 7 组 `mode`+`slab`，逐条比 `heightmap()` 全字段、`mapImage()` 尺寸与
**RGBA 逐字节**、`glyphMap()` 字符、`isUnderground()`；外加"模块级 `heightmapOf(bot, …)` 与薄包装同结果"
+ 边界（`radius` 上下限、`slab` 0/99、掉线仍抛）+ 接线）
+ 改过的断言逐条重跑 **27/0**（含反面断言）+ `node --check`（`core.mjs` / `map-render.mjs` / 套件）
+ `index.js` 与 8 个扩展逐个 import 成功。

⚠️ 本轮同样按用户要求没有跑项目套件。

**第十二刀（`src\world-scan.mjs`）**：搬的是**"感知"里最后两块** —— `scan()`（周围方块：不点名给计数、
点名给坐标列表）与 `entities()`（附近有谁：名字 / 坐标 / 距离 / 上下差 / 血量 / 是不是远程）。
两个都是**公开方法**（`index.js` 的 `mc_scan` 调 `sess.bot.scan()`、`extensions\mc_observe.mjs` 的
"程序检测到"调 `sess.bot.entities()`、`tools\check-core-entities.mjs` 直接调 `mc.entities(24, {…})`）
⇒ 照第十一刀的做法留**两个同名薄包装**，包装里照样先 `requireBot()`（不在线就抛的语义不变）。
新模块只依赖 `vec3` + `src\block-names.mjs` 的 `isAir` + `src\entity-names.mjs` 的三件
（`entityNameOf` / `HOSTILE_RE` / `RANGED_RE`），**不反向 import core、不碰 mineflayer、没有一处 `await`**。

- **顺手瘦身**：这次 `Vec3` 与 `isAir` 在 `core.mjs` 里还有别的调用点（`placeBlock` / `breakBlock` /
  `build` 等），所以导入行一个字都不用删 —— 搬家前先 grep 一遍"这两个名字还有谁在用"。
- **静态断言第十二次逮到我**：`tools\check-core-entities.mjs:271` 原来是
  `/entities \(radius = 24, \{ kind = 'all', limit = 40 \} = \{\}\)/` 查 `core.mjs` 文本 ⇒ 改成查
  `src\world-scan.mjs`，并补"确实 import 了"+"两个薄包装都在"+"core 里没有残留实现"三条。
  `selfcheck.mjs` 里对这两个名字**零引用**（不像第十一刀那次）。

**验证**：冒烟 **146/0**，其中 **113 条 A/B 对照**（把 `git HEAD` 的 `core.mjs` 临时拷回 `src\` 当
第二个 `McBot`：**3 种假世界 × 11 组 `scan` 选项** + **5 种假 bot（有助手 / 没助手 / 助手抛错 /
没位置 / 站在别处）× 16 组 `entities` 参数**，逐条 `JSON.stringify` 比对）+ 结构 12 条 + 行为 8 条
（助手给的距离/血量被采纳、助手报 0 血不写成 0、没有 `position` 的实体不进列表、助手抛错不炸、
没有位置信息时如实说）+ 接线 11 条（`index.js` 与 8 个扩展逐个 import、`mc_scan` 与 `mc_observe`
的调用点一行没改）+ 改过的断言逐条重跑 **19/0**（含三条反面断言）+ `node --check`。

⚠️ 本轮同样按用户要求没有跑项目套件。

### 连接/状态视图搬出去：模块只吃参数，实例状态打包成 `ctx`（路线图第 ④ 条第十三刀）

第十三刀搬的是**最常用的那个读取器** —— `connectionView()`（连接信息）与 `status()`（状态视图），
进新模块 `src\status.mjs`（`core.mjs` 3984 行，十三刀累计 4896 → 3984）。

| 搬走的名字 | 新模块里的形状 | 说明 |
| --- | --- | --- |
| `connectionView()` | `connectionViewOf(profile)` | 只给 `host` / `port` / `subserver`；`authMode` / `account` **不发出去**（用户 2026-09-16 要求状态条显示地址，但不许带账号） |
| `status()` | `statusOf(b, ctx)` | 离线分支给 `ghost` / `reconnecting` + 两种提示文案；在线分支给坐标 / 朝向 / 模式 / 血量 / 饥饿 / 氧气 / 手持 / 在线时长 |

- **这一刀的新问题：被搬走的代码读的是 `this.xxx`，而不是 `bot.xxx`**。`status()` 要读
  `this.sub`（子服名）/ `this._connectionProfile`（连接参数）/ `this.lastError` / `this.reconnecting` /
  `this.reconnectPending` / `this.connectedAt` —— 这些是**插件实例的状态**，不属于 mineflayer 的 bot。
  解法：薄包装把它们**打包成一个 `ctx` 对象**传进去（`statusOf(this.bot, { sub, connection, lastError,
  reconnecting, reconnectPending, connectedAt })`），模块保持"只吃参数、不反向 import core"的纯形状
  （写成迁移规矩第 17 条）。
- **两个同名薄包装**（迁移规矩第 15 条），**不 re-export**：`connectionView () { return connectionViewOf(this._connectionProfile) }`、
  `status () { return statusOf(this.bot, {…}) }`。调用点一行都没改 —— `index.js` 六处（`sess.bot.status()` /
  `.connectionView()`）、`extensions\mc_observe.mjs` 一处、`selfcheck.mjs` 四处。
- **静态断言这次没逮到我**：全仓没有"按文本找 `status () {` / `connectionView () {`"的断言
  （`grep` 只命中 `core.mjs` 自己与 `watchdog.mjs:229` 那个同名局部函数）。
  `selfcheck.mjs:1242-1255` 那批是**行为断言**（离线也给地址、连接信息不含 `account|authMode|version`、
  在线同样带地址、从没连过 ⇒ `connection === null`），用的假 bot 位置是**普通对象** `{x,y,z}`
  （`submerged` 靠 try/catch 兜住）—— 这一组 A/B 里专门过了一遍，两边一致。
- **验证**：`node --check` + 冒烟 **60/0**，其中 **A/B 32 条**（`git HEAD` 的 `core.mjs` 拷回 `src\` 当第二个
  `McBot`：16 种状态 —— 从没连过 / 有 profile 没 bot / profile 只有 host / profile 空对象 / 离线 + lastError /
  离线 + sub / 幽灵在线 / 幽灵在线 + reconnecting / + reconnectPending / 在线（干地、水里、氧气读不到、
  位置是普通对象、空手、game 缺失）/ 在线 + sub + lastError，`connectionView()` 与 `status()` 逐条
  `JSON.stringify` 比对，`uptimeSec` 抹成 `'~'` 避免跨毫秒抖动）+ 结构 11 条 + 行为 7 条 + 接线 11 条
  （`index.js` 与 8 个扩展逐个 import）。

⚠️ 本轮同样按用户要求没有跑项目套件。

### 挖掘速度搬出去：A/B 全绿但那条路根本没走到（路线图第 ④ 条第十四刀）

第十四刀搬的是**"拿某件工具挖这块要多久"** —— `#digMsFor` / `#digToolKindOf` / `#digToolSpeedOf` /
`#fixDigMs` / `#patchDigTime` / `#bestToolFor`，进新模块 `src\dig-speed.mjs`
（`core.mjs` 3984 → 3801 行，十四刀累计 4896 → 3801）。

| 搬走的名字 | 新模块里的形状 | 说明 |
| --- | --- | --- |
| `#digMsFor(b, blk, itemType)` | `digMsFor(b, blk, itemType = null)` | 走 `block.digTime(itemType, creative, inWater, notOnGround, enchants, effects)`；没有 `digTime` 的假件退回 `__wcOrigDigTime`（**不能直接调 `b.digTime`，会递归**） |
| `#digToolKindOf(name)` | `digToolKindOf(name)` | 工具种类（`stone_pickaxe` → `pickaxe`），认不出回 `null` |
| `#digToolSpeedOf(reg, itemType)` | `digToolSpeedOf(reg, itemType)` | 品级倍率：在 registry 的**所有** material 表里取最大（`mineable/pickaxe` 里 stone=4 / iron=6 / diamond=8 / netherite=9 / golden=12） |
| `#fixDigMs(b, blk, itemType)` | `fixDigMs(b, blk, itemType)` | 上游 108 个方块 `material` 写成 `incorrect_for_wooden_tool` 的兜底：按原版公式重算，**只往"更快"修**，判定不了回 `null`（估快会让服务端判进度不够、把方块发回来） |
| `#patchDigTime(b)` | `patchDigTime(b)` | 把 `bot.digTime` 换成修过的值（`min(上游, 修正)` 再 `×1.08 + 60ms`）；`bot.__wcDigTimePatched` 防重复挂，重复调用回 `false` |
| `#bestToolFor(b, blk)` | `bestToolFor(b, blk)` | 背包里挖这块**最快**的那件（只考虑挖得动的，算不出时间的跳过） |

- **只有 `patchDigTime` 需要公开薄包装**（迁移规矩第 15 条）：`core.mjs` 里
  `patchDigTime (b) { return patchDigTime(b) }` —— `tools\check-core-digtime.mjs` 六处是拿
  `mkMc(bot).patchDigTime(bot)` 调的，`core.mjs` 自己挂 `bot.digTime` 那一步（`setupPlugins` 第 ⑤ 步）也走它。
  其余五个名字**全仓只有 `core.mjs` 自己用**（`digMsFor` 三处调用点：`#equipFor` 挑工具 / `breakBlock` 算"这块要几秒" /
  原地挖兜底），所以只 import、**不 re-export**。
- **这一刀的新问题在"怎么验证"上**：前面几刀的 A/B 都是把 `git HEAD` 里搬走前的实现抽出来当第二个实现，
  喂同一批假件逐条比 —— 这次第一版冒烟**全绿（82/0）**，可那条最要紧的路一次都没走到：
  假 registry 里我把 `incorrect_for_wooden_tool` 写成了 `{900: 2, 901: 2}`（900/901 恰好是石镐/铁镐），
  于是 `fixDigMs` 一进门就撞上"这张表里有这把工具的倍率 ⇒ 数据没问题"直接返回 `null`，
  旧新两边**都**返回 `null` ⇒ **"等价"只等于"两边都走了同一条死路"**。
  按真实数据（那张表里**只有木工具**）改成 `{910: 2, 911: 2}` 之后，样例才打出
  `fixDigMs = 1150`（石镐挖铁矿，真值）与 `patchDigTime` 后 **1302ms** ——
  和 2026-10-08 实机 `live-digtime.mjs` 量到的 1302ms 一模一样。写成迁移规矩第 18 条。
- **静态断言这次逮到 5 条**（迁移规矩第 6 条）：`tools\check-core-equip.mjs` ⑦ 里有
  `const digMs = this\.#digMsFor\(b, blk`、`#digMsFor \(b, blk, itemType = null\)`、
  `const vY = Number\(b\?\.entity\?\.velocity\?\.y \?\? 0\)`、
  `const notOnGround = !b\?\.entity\?\.onGround && vY < -0\.02`、
  `!/const notOnGround = !b\?\.entity\?\.onGround\s*$/` —— 全改成查新模块，
  并补了六条"别只搬不接"的接线断言（`from './dig-speed.mjs'`、core 里没有残留的
  `#digMsFor (b` / `#fixDigMs (b` / `#patchDigTime (b)` …、公开薄包装还在）。
- **验证**：`node --check`（`core.mjs` / `dig-speed.mjs` / `check-core-equip.mjs`）+ 冒烟
  **82/0**（14 种假件 × 5 个函数 + `patchDigTime` 挂载 / 重复挂 / 没有 `digTime` 的 bot）
  + 静态断言核对 **14/14**（照着我改过的那几条正则，直接对两个文件跑一遍）。
- 搬家脚本（`%TEMP%\wc-split14.mjs`）行号锚点自检 **17 处**，删 6 段共 **186 行**、原位插 3 行薄包装、
  6 类 `this.#xxx(` → `xxx(` 调用点改写（`digMsFor` 3、`bestToolFor` 1、`patchDigTime` 1）。

⚠️ 本轮同样按用户要求没有跑项目套件。

### 采集/落地守卫搬出去：薄包装同名，调用点一行没改（路线图第 ④ 条第十五刀）

`#collectBusy` / `#cancelCollect` / `#waitGrounded` / `#withHeld` 四个私有方法进了新模块
`src\dig-guard.mjs`（`core.mjs` 3801 → 3728 行；十四刀累计 4896 → 3728）。

- 搬的是**"动手之前 / 动手之后"的四件小事**：`collectBusy(b)`（后台采集任务还在吗）、
  `cancelCollect(b, ctx)`（停掉它 + 松控制位）、`waitGrounded(b, {maxMs, signal})`（站到地上再挖）、
  `withHeld(out, b, before)`（结果里补"手上变了"）。模块只往下 import `async-util.mjs`（`sleep` / `abortError`）
  和 `inventory.mjs`（`heldText`），**不反向 import `core.mjs`**。
- **这一刀的麻烦是"实例状态"**（迁移规矩第 19 条）：`#cancelCollect` 里要 `this._moveGen++`、
  `this.#stopPathing()`、`this.#releaseControls()`、`this.log()`；`#waitGrounded` 里要 `this.abortSignal`。
  做法还是第十三刀那个形状 —— 模块签名收一个 `ctx`，`core.mjs` 的薄包装打包传进去：
  ```js
  async #cancelCollect (b, opts = {}) {
    return await cancelCollect(b, {
      ...opts,
      bumpGen: () => { this._moveGen++ },
      stopPathing: (bb) => this.#stopPathing(bb),
      releaseControls: () => this.#releaseControls(),
      log: (m) => this.log(m)
    })
  }
  ```
  **`bumpGen` 里必须保留字面 `this._moveGen++`**：`tools\check-call-budget.mjs` 有一句
  "抢占时把代号往前推（≥2 处）"是**按字面数**的，写成 `this._moveGen = this._moveGen + 1` 会让它变红。
- **四个同名薄包装**（迁移规矩第 15 条），**不 re-export**：`#collectBusy` / `#cancelCollect` /
  `#waitGrounded` / `#withHeld` —— 三个调用点（`#walkPathfinder` 的采集预清理、`#grabDrops` 的收尾、
  `dig` 与 `breakBlock` 的落地等待、`dig` 两处补"手上"）**一行都没改**。
- **验证（按用户要求没跑项目套件与实机）**：`node --check`（`core.mjs` / `dig-guard.mjs` /
  `check-core-equip.mjs` / `check-call-budget.mjs`）+ 冒烟 **26/0** —— 从 `git show HEAD:src/core.mjs`
  里把那四个方法**原样抠出来**（私有方法名照抄，包在一个带 `#stopPathing` / `#releaseControls` / `log` 的类里）
  当旧实现，与 `dig-guard.mjs` + 薄包装逐条对照：没有插件 / `targets.empty` / `cancelTask` 正常返回 /
  `cancelTask` 永远不返回（看 cap 生效 + 清队列 + 两句告警）/ `budgetMs` 的四种写法
  （`null` 当"没指定"、`0` 一秒不等、`'abc'` 回默认、负数钳到 0）/ `waitGrounded` 六种情形
  （站着、没有 `entity`、一直在空中、中途落地、已 abort 抛 `abortError`、`maxMs` 再大也钳到 2 秒）/
  `withHeld` 三种。**这一刀没再犯第十四刀那个错**：冒烟里每条路都断言了"输出是不是非空"，
  不只看"旧新一不一致"。
- **静态断言**：`tools\check-core-equip.mjs` ⑦ 新增 6 条（模块里四个 `export function`、
  `core` 确实 import、薄包装推进代号、core 里没有残留的旧方法体），并把 `#withHeld` 那条从
  "core 里有 `#withHeld`"改成"core 里是**薄包装**、实现在新模块"；`tools\check-call-budget.mjs`
  那句 `budgetMs == null` 改成查 `src\dig-guard.mjs`，另补一条"薄包装推进代号"。

### 聊天层搬出去：有可变实例状态的层，第一参数直接收 `self`（路线图第 ④ 条第十六刀）

（2026-10-08）`src\core.mjs` **3728 → 3616 行**（十六刀累计 4896 → 3616）。搬走五个成员：
`wireChatEvents()`（公开）、`#plain()`、`#emitPlayerChat()`、`#playerChatFrom()`、`#pushChat()`；
`recentChat(n = 10)` 留在 `core.mjs`（`index.js:1825/1843` 与 `extensions\mc_auto.mjs:965` 在用）。

- **规矩第 17 条（实例状态打包成 `ctx`）在这里不够用**：`chat` 是**可变**的实例状态
  （`self.chat` 环形数组、`self.stats.chats`、`self._lastChatKey` 去重键、`self.emit()`），
  写成 `ctx = { chat, stats, lastKey(), setLastKey() … }` 会变成一堆 getter/setter，比原来更难读。
  所以这一刀**第一参数直接收 `self`**（迁移规矩第 20 条）：模块仍然不 import `core.mjs`、
  不 import 任何游戏库，只认 `{ on, _client, username }` 这么几个字段 —— 自检拿假 bot 就能走同一条路
  （`selfcheck.mjs:1189` 走的就是公开薄包装 `wireChatEvents(b)`）。
- **五个同名薄包装，调用点一行没改**（迁移规矩第 15 条）：`wireChatEvents (b) { return wireChatEvents(this, b) }` 等；
  私有件 `#plain` / `#playerChatFrom` / `#emitPlayerChat` / `#pushChat` 也留同名薄包装，是为了
  `tools\check-token-budget.mjs` 第 4 节那句"`#emitPlayerChat` 仍带 `selfName` 参数"能继续成立。
- **验证**：`node --check` + 自写冒烟 **44/0**（旧实现从 `git show HEAD:src/core.mjs` 里按锚点抠出、
  机械变换成模块当第二个实现，同一批假件逐条比对：`plainText` 4 种输入、`playerChatFrom` 12 种消息形状、
  `pushChat` 截断、`emitPlayerChat` 用可控 `Date.now` 测 1.5 秒去重与自己说话回显、
  `wireChatEvents` 两条路全链路 6 次投喂）。
- 🔴 **这一刀最大的收获是"全仓扫描"**：第十二刀（`world-scan`）我只改了
  `tools\check-core-entities.mjs`，漏了 `tools\check-token-budget.mjs` 第 5 节两条同款断言
  （`/entities \(radius = 24, \{ kind = 'all', limit = 40 \} = \{\}\)/` 与 `/const R = Math\.min\(…128\)/`）
  —— 它俩从那以后一直是红的，直到这一刀做全仓扫描才发现（见下条与踩坑档案第 54 条）。
  为此加了 **`tools\scan-moved-assertions.mjs`**（顾问型、不判红、不进 `check-all` 的 ORDER）：
  自动收集 `src/*.mjs` 的导出名，扫 `tools\check-*.mjs` + `selfcheck.mjs` 里所有
  `.test(CORE|core|coreSrc|src|INDEX)` 的断言，把"提到这些名字 **且** 正则里带实现细节"的列出来
  ⇒ 写成迁移规矩第 21 条，后面每一刀都先跑它。
- **第二十三刀给扫描器补了第二遍**：第一遍要求"这一行里出现某个已搬走的导出名"，于是 `ok(/budgetMs: 300/.test(src), …)` （名字只写在旁边注释里）扫不到 ⇒ 第二遍改成**拿正则去目标文件里试**："在 core 里找不到、却能在别的 `src/*.mjs` 里找到"就是陈旧断言。一上线就抓出 **6 条**（`redactPath` 第二刀、`tossItem` 第十九刀、`status()` 第十三刀五条），详见 `踩坑档案.md` 第 61 条。

### 朝向/相机搬出去：扫描器自己也有"只看到半条断言"的盲区（路线图第 ④ 条第十七刀）

`lookAnglesTo` / `#aimAt` / `lookAt` 进新模块 `src\camera.mjs`（`core.mjs` 3616 → 3548 行，十七刀累计 4896 → 3548）。
这三个只吃一个 `bot`：`aimAt()` 直接写 `b.entity.yaw/pitch`（绕开会挂住的 `bot.lookAt()`，理由见模块头注释）、
`lookAt()` 认英文名/玩家名/中文别名、实体表里没有时退回 `b.players`。core 里留三个同名薄包装，调用点一行没改。

这一刀顺手补了扫描器自己的盲区：`check-core-evidence.mjs` 有一行 `ok(/…/.test(coreSrc) && /…/.test(coreSrc), …)`，
扫描器原来只拿**第一个** `.test(` 之前的内容判"有没有实现细节" ⇒ 后半条（真正被搬走的 `b.entity.yaw = yaw`）
根本没进判断 —— **"扫描器没报"不等于"断言没事"**。现在抠掉整行所有 `.test(<ident>)` 再判，并把 `= `、
`.方法(`、`??`、`||` 也算实现细节（命中 24 → 36 条）。

验证：`node --check` ×2；自写冒烟 **31/0**（`lookAnglesTo` 8 组、`aimAt` 9 组含 `null` / `NaN` / 缺实体、
`lookAt` 11 组走两个 `McBot` 实例逐条比对返回值与写进去的 yaw/pitch、接线 6 条）；静态对照 **8/0**。
按用户要求没跑项目套件与实机。

### 服务端判决层搬出去：三态判据单独一层，顺手逮到手术脚本的 0/1 起行号（路线图第 ④ 条第十八刀）

`#watchServerBreak` / `#awaitServerBreak` 进新模块 `src\server-break.mjs`（`core.mjs` 3548 → 3463 行，十八刀累计 4896 → 3463）。
这一层的价值不在"搬"，而在它把**一条判据**圈成了一个文件：**只认服务端的包，不认客户端那个预测的 air** ——
`hit()`（服务端说这块变空气）/ `restored()`（服务端把原方块发回来 = 拒了这次破坏）/ 其余当没有证据；
`watching === false`（假 bot 挂不上 `_client.on('packet')`）时调用方不许下结论。core 里留两个同名薄包装，调用点一行没改。

- **只吃 `bot` + `pos`**；等包的那 10 行要"这一轮还剩多少时间"和停止键，由薄包装打包成参数传进来
  （`callLeft: () => this.callLeft()`、`signal: this.abortSignal`）—— 迁移规矩第 17 条的老办法。
- **验证 50/0**（`node --check` ×2 + 自写冒烟）：从 HEAD 版 core.mjs 里按花括号配平抠出两个旧方法做成 `Old` 类，
  与 `src\server-break.mjs` 逐条 A/B —— 18 组包序列（含"没有坐标"这个旧假阳性、"先 air 再复原"、"先复原再 air"、
  "两次复原取第一次"、老格式对象记录、NaN 记录）、2 组挂不上监听、11 组 `awaitServerBreak` 真跑时间
  （提前收手 / 等满 maxMs / 已 aborted 抛同一句 / `callLeft - 500` 截断 / `callLeft < 500` 不许负数死循环 /
  `maxMs` 给字符串当 0）、6 条接线。
- 🔴 **第一版冒烟全绿但那条路一次没走到**（第 52 条那个坑的复现）：我把 `multi_block_change` 的位段按
  `0 | 3<<4` 拼，解出来是 `(0, 64, 3)`，而目标是 `(1, 64, 2)` ⇒ 新旧都"没命中"、照样全绿。补了一整节
  **①′「multi 那条路真的走到了」**（直接断言 `sawMulti() === 1` 和 `hit()`/`restored()` 的值），并把
  "区块原点算错就认不出来"也钉成一条。**判据：先断言"这条路的输出是不是非空"，再比"新旧一不一致"。**
- **手术脚本的 0/1 起行号**：锚点自检用 1-based 行号，`lines.splice(n, …)` 用的是 **0-based** —— 同一个数字
  直接喂进去就少删一行，结果 core.mjs 里多出一行孤零零的 `/**`。**`node --check` 不报**（注释而已），
  是回读薄包装那一段才看出来的。写成迁移规矩第 23 条。

### 背包动作搬出去：读和动放同一个模块，实例/库相关的东西靠 `ctx` 传（路线图第 ④ 条第十九刀）

前十八刀里，`src\inventory.mjs` 一直是**只读**的（`heldText` / `invSnap` / `countOf` / `freeSlot`…）。
这一刀把 `McBot` 上四个**要发包**的成员也收了进去：

- `inventory ()` → `inventoryView(b)`（纯读，`mc_inventory` 的正文）；
- `async giveItem ({name,count,slot})` → `giveItem(b, opts, ctx)`（创造取物）；
- `async clearInventory ()` → `clearInventory(b, ctx)`（清空）；
- `async tossItem ({name,count})` → `tossItem(b, opts, ctx)`（丢弃）。

它们跟前面几刀最大的不同：**要发包、要 await**。而它们又分别需要两件"模块不该知道"的东西 ——
本轮还剩多少时间（`this.#t`，插件实例状态）和怎么造一个 `prismarine-item`（游戏库）。做法是薄包装把它们
打包成 `ctx = { t, makeItem }` 传进去，模块自己仍然**一行游戏库都不 import**（写成迁移规矩第 24 条）。
`core.mjs` 里的四个同名方法保留成薄包装，`index.js`（`mc_inventory` / `mc_give` / `mc_toss`）与
`selfcheck.mjs` 的调用点一行都没改。

- **A/B 冒烟 48/0**：从 `git show HEAD:src/core.mjs` 把旧实现抠出来放进一个 `Old` 类（公开转发 `inv()` / `give()` /
  `clear()` / `toss()`，因为私有方法没法用字符串名取），与 `src\inventory.mjs` 逐条比对 —— `inventoryView` 5 组
  （空背包 / 一叠 / 同名两叠+手上那叠 / 没有 `emptySlotCount` / `items()` 抛错）、`giveItem` 14 组 + 4 条行为
  （`slot` 0→9、50→44、字符串数字、`NaN`、服务端没认时不许说"已放进背包"、`setInventorySlot` 收到的是物品 id）、
  `clearInventory` 4 组、`tossItem` 8 组 + 1 条行为（丢失败时如实说"只少了 N 个"）、接线 9 条。
- **扫描器**（`node tools\scan-moved-assertions.mjs`）这次没有新命中：`tools\check-*.mjs` 里对这四个名字的引用
  全是**行为调用**（`check-core-evidence.mjs` 的 `mc.tossItem({name:"dirt",count:2})`），没有按文本找实现体的断言 ——
  所以这一刀没有第 53/54 条那种漏改。
- `core.mjs` **3463 → 3376 行**（十九刀累计 4896 → 3376）；`src\inventory.mjs` 98 → 225 行。

### 使用/交互层搬出去：服务端不回执的动作，靠“窗口开没开 / 属性翻没翻”复核（路线图第 ④ 条第二十刀）

`useBlock()` / `useItem()` 搬进 `src\world-use.mjs`（`core.mjs` 3376 → 3241 行，二十刀累计 4896 → 3241）：

- **为什么这两个是“证据类”动作**：mineflayer 的 `activateBlock` / `activateEntity` 内部只 `await lookAt` 再发包，`activateItem` 连回执都没有 —— 服务端**从不告诉客户端“这一下成没成”**。旧实现拿到 promise 就 `return { usedBlock }`，等于“我瞄了一下”报成“我用过了”（`踩坑档案.md` 第 9 条）。搬走时把复核逻辑一起搬：容器看 `currentWindow` 开没开、门/拉杆/按钮看 `getProperties()` 翻没翻，翻不了就如实说“包发出去了，我没法确认”。
- **实例状态怎么进去**：这两个动作要 `this.#t`（预算闸门，会抛“这一轮的时间用完了”）和 `this.callLeft()`（`useItem` 用它给松手包留 400ms 余量），但**不改任何实例状态** ⇒ 按迁移规矩第 17 条走 `ctx = { t, callLeft }`，不是第 20 条的 `self`。
- **这一刀逮到的静态断言**：`tools\check-core-useitem.mjs` 的 ⑦ 段有 5 条按 core 文本找实现的断言（`async useItem ({ hold = 0 } = {})`、`b.activateItem()`、`this.callLeft() - 400` …）⇒ 改成读 `src\world-use.mjs`，并补“core 的薄包装 + 确实 import 了 + 把 callLeft 传进去了”的接线断言（迁移规矩第 21 条的扫描器这次列了 40 条，其中只有这 5 条是真要改的）。
- **验证**（按用户要求不跑项目套件）：`node --check` ×2；自写 A/B 冒烟 **36/0** —— 从 `git show HEAD:src/core.mjs` 抠出两个旧方法体当第二个实现，21 组场景逐条比 JSON（实体：命中 / 中文别名 / 太远 / 找不到 / 上船 / 没有 position；方块：容器开窗 / 门翻 / 门没翻 / 床没变 / 属性变 / 未加载 / 小数坐标；物品：没东西 / 正常 / 没少 / 弓不提示 / 时间不够钳制 / hold 0 / 没有 deactivateItem / callLeft 非数字 / `inventory.items()` 抛错），并另比了“瞄准真的写了 `entity.yaw/pitch`”。
- **没跑的**：`tools\check-*.mjs` 与 `实机验证\*.mjs` 由你自己跑；`check-core-evidence.mjs` 的 ③④ 段是**行为断言**（走薄包装 `mc.useBlock(...)`），这次不用改。

### 攻击层搬出去：`pvp.attack()` 只是“设了个目标”，不能 await 完就 stop（路线图第 ④ 条第二十一刀）

`attack()` 搬进 `src\attack.mjs`（`core.mjs` 3241 → 3123 行，二十一刀累计 4896 → 3123）：

- **搬之前这里有过两个真 bug**（这一刀顺手钉住）：① `await withTimeout(b.pvp.attack(e))` + `finally { b.pvp.stop() }` —— `mineflayer-pvp` 的 `attack()` 是**立刻 resolve 的后台循环**（真挥拳在 `physicTick`），于是"报了 attacked、一下没打"（`踩坑档案.md` 第 20 条）；② `pvp.stop()` 会等 `path_stop`，最多 5 秒，`await` 它等于把本轮预算吃光。现在模块自己 120ms 一步轮询"目标还在不在"，`Promise.resolve(b.pvp.stop()).catch(() => {})` 不 await。
- **实例状态怎么进去**：这个动作要 `this.#t`（预算闸门）、`this.callLeft()`、`this.abortSignal`，还要知道 `this.mcPlugins.pvp` 挂没挂 ⇒ 按迁移规矩第 17 条走 `ctx = { t, callLeft, abortSignal, hasPvp }`（不改实例状态，所以不是第 20 条的 `self`）。模块只 import 兄弟叶子模块（`async-util` / `budget` / `entity-names` / `world-observer`），一行游戏库都不 import。
- **这一刀逮到的静态断言**：`tools\check-core-attack.mjs` ④ 段有 13 条按 core 文本找实现的断言（`await b.pvp.attack(target)`、`const inReach = needle ? …`、`Promise.resolve(b.pvp.stop())…` …）⇒ 全部改成读 `src\attack.mjs`，并补三条接线断言（core 确实 import 了 / 是薄包装 / 没有残留实现）。顺手清掉 core 里 `entity-names` 的 9 个已经没人用的 import（只剩 `isDropEntity`）。
- **验证**（按用户要求不跑项目套件）：`node --check` ×2；自写 A/B 冒烟 **34/0** —— 从 `git show HEAD:src/core.mjs` 抠出旧的 `attack()` 当第二个实现，① 没给 who 的排序与边界 6 组、② 给 who 的名字匹配 5 组、③ pvp 那条路 8 组（打死 / 打不死 / `wasInRange=false` / attack 抛错 / stop 抛错 / 预算用完 / 没挂 pvp / 已中止）、④ 血量差与返回形状 2 组、⑤ 接线 11 条，逐条比 JSON（`waitedMs`/`note` 这类时间字段做归一化）。
- **没跑的**：`tools\check-*.mjs` 与 `实机验证\*.mjs` 由你自己跑。

### 连串动作的调度层搬出去：要回调一堆实例方法的层，第一参数收 `self`（路线图第 ④ 条第二十二刀）

`runSequence()` / `#runStep()` 搬进 `src\sequence.mjs`（`core.mjs` 3123 → 3009 行，二十二刀累计 4896 → 3009）：

- **为什么收 `self`**：这一层不改实例状态，但它要**调**一堆实例方法（`self.walkTo` / `self.placeBlock` / `self.dig` / `self.attack` …）还要读 `self.msLeft()` / `self.abortSignal` / `self.bot`。按第 17 条的判据（"只读几项实例状态"才打包 `ctx`）这里既多又杂还得回调回去 ⇒ 收 `self`（写成迁移规矩第 27 条）。`#runStep` 只在 `runSequence` 里用，所以 core 里**不再留** `#runStep`，只留 `runSequence` 的薄包装。
- **三条容易改回去的语义**（都写在模块头注释里）：① 不为没执行的步骤记 `ok:false`（审计⑪，否则 `succeeded + failed + remaining > requested`，模型以为"那步做失败了"）；② `move` 的 `ok` 必须看 `arrived`（审计⑧，`walkTo` 走不通时返回 `{arrived:false, stuck:true}`）；③ 步骤自己发现预算用尽（`mcCallOver`）一样给 `stoppedAt`（审计⑦，不然模型从第 1 步整串重来）。`wait` 走 `raceAbort`，被打断真的会停。
- **这一刀逮到的静态断言**：`tools\check-core-useitem.mjs` 和 `tools\check-core-swim.mjs` **两个套件各自**断言了 `#runStep` 里的一个 case（`case 'useitem'` / `case 'swim'`）⇒ 都改成读 `src\sequence.mjs`（那边是 `self.`），并补接线断言。这就是迁移规矩第 21 条那个扫描器的用处：同一段代码被两个套件分别盯着。
- **验证**（按用户要求不跑项目套件）：`node --check` ×2；自写 A/B 冒烟 **51/0** —— 从 `git show HEAD:src/core.mjs` 抠出旧的 `runSequence`（66 行）和 `#runStep`（52 行）塞进一个 `class Old` 当第二个实现，10 组场景（正常跑完 / 预算一点没有 / 中途到点 / 被打断 / `move` 的 `arrived:false` / `wait` 被截断 / 未知 op / `mcCallOver` / `stopOnError:false` / 入参校验）+ 18 条分发（每个 op 落到哪个方法、`swim` 两种、`dig` 包成 `{result}`、创造模式默认 `fly`、`budgetMs` 传下去）+ 9 条接线，逐条比 JSON（`elapsedMs`/`waitedMs` 归一化）。
- **没跑的**：`tools\check-*.mjs` 与 `实机验证\*.mjs` 由你自己跑。

### 捡掉落物那一层搬出去：要回调实例方法、还要借一个私有方法（路线图第 ④ 条第二十三刀）

`#grabDrops()` 搬进 `src\pickup.mjs`（60 行，`core.mjs` 3009 → 2974 行，二十三刀累计 4896 → 2974）：

- **为什么收 `self`**：这一层不改实例状态，但要回调 `self.callLeft()`（预算）和 `self.walkTo()`（没有 collectBlock 时的兜底走路）⇒ 按第 27 条收 `self`。
- **🔴 这一刀唯一的新问题**：它还要调 `McBot` 的**私有**方法 `#cancelCollect` —— 私有名在模块外面够不着（不能用字符串取），所以由 core 的薄包装把 `cancelCollect: (bb, o) => this.#cancelCollect(bb, o)` 塞进 `ctx`。写成迁移规矩第 28 条。
- **验证**（按用户要求不跑项目套件）：`node --check` ×2；自写 A/B 冒烟 **33/0**（从 `git show HEAD:src/core.mjs` 抠出旧方法塞进 `class Old`：11 组返回值 + 9 组行为（预算怎么花、collect 超时要不要收尾、walkTo 参数）+ 8 条接线）；静态对照 **20/0**。
- **扫描器升级 + 抓到 6 条陈年旧账**：第一遍按**导出名**扫，`ok(/budgetMs: 300/.test(src), …)` 这种"断言里没提名字"的一条也扫不到 ⇒ 加了**第二遍**：把每条断言的正则直接拿去它断言的文件里试，**在 core 里找不到、却能在别的 `src/*.mjs` 里找到**的就报出来（顺带解析"这个变量读的是哪个文件"，免得把断言 `index.js`/扩展的 112 条也算进来）。第二遍一上来就找出 **6 条**：`check-audit-session.mjs:191`（`redactPath` 第二刀搬进 `src/format.mjs`）、`check-core-evidence.mjs:288`（`tossItem` 第十九刀搬进 `src/inventory.mjs`）、`check-core-swim.mjs:380/382/383/384/385`（`status()` 第十三刀搬进 `src/status.mjs`）。全改成查新模块 + 补接线断言（见 `踩坑档案.md` 第 61 条）。
- **没跑的**：`tools\check-*.mjs` 与 `实机验证\*.mjs` 由你自己跑。

### 任务收工报告搬出去：同一个模块里三种形状并存（路线图第 ④ 条第二十四刀）

`#taskHave()` / `#verdictLine()` / `#taskSettle()` 搬进 `src\task-report.mjs`（86 行，`core.mjs` 2974 → 2922 行，二十四刀累计 4896 → 2922）：

- **为什么这三个放一起**：同一条链上的三件事 —— 干活前看"现在手里有几个" → 收工时判"这一轮成了没" → 再把结果记到任务上、附一行进度。
- **这一刀的形状最杂，正好说明规矩是按成员各自的需要定的**：`taskHave(b, item)` 只读 bot 背包 ⇒ 参数就是 `b`；`verdictLine(out, okCount, wantTotal)` 一个实例状态都不碰 ⇒ 纯函数；`taskSettle(self, …)` 要读 `self.tasks` / `self.position`、要调 `self.tasks.fail/checkpoint/get` ⇒ 按第 27 条收 `self`。**三种形状并存，不需要统一。**
- 🔴 **顺序不能反**：`verdictLine` 必须在 `taskSettle` **之后**（`dig()` 就是这么排的）—— 判决行里含"动作失败"四个字，而 `taskSettle` 是靠扫 `out` 里的关键词判失败的，先 push 判决行会让**没失败的那一轮**被记成失败。
- 🔴 **进度不在这里记**：`progress.done` 由 `dig()` 的每个"复核过的挖掉"成功点自己 `progress(add:1)`（`TaskRunner.progress()` 在 `done >= total` 时把状态改成 `done`）。这里只 checkpoint + 分类，所以 `now.status === 'done'` 那个分支要等成功点记满、或 AI 手动 `mc_task {action:"done"}` 之后才走得到。
- **验证**（按用户要求不跑项目套件）：`node --check` ×2；自写 A/B 冒烟 **53/0**（从 `git show HEAD:src/core.mjs` 抠出三个旧方法包成 `class Old`，配**固定时钟**的真 `TaskRunner` 逐条比对输出与任务状态：`taskHave` 10 组、`verdictLine` 10 组、`taskSettle` 7 组 ×2 项、边界 5 组（`task=null` / 只 settle 不 progress / progress 满了 / 连失败 4 次进 blocked / 连 5 次"11 秒用完了"仍 running）+ 接线 12 条）；扫描器第二遍 **0 条**。
- **🔴 这一刀自己的教训**：手术脚本删的是"**JSDoc + 方法体**"，写进新模块的却只有**方法体** ⇒ 三段 JSDoc 直接从仓库消失，而 `node --check`、冒烟、扫描器**全都照绿**（注释丢了不影响行为）。回读模块才发现，补回来 63 → 86 行。写成迁移规矩第 29 条 + `踩坑档案.md` 第 62 条。
- **没跑的**：`tools\check-*.mjs` 与 `实机验证\*.mjs` 由你自己跑。

### 世界观察器整层搬出去：定时器回调里的异常也得有去处（路线图第 ④ 条第二十五刀）

`startObserver()` / `stopObserver()` / `#invSignature()` / `#observeTick()` 搬进 `src\observer.mjs`（100 行，`core.mjs` 2922 → 2853 行，二十五刀累计 4896 → 2853）：

- **搬的是一整层（含定时器）**：分节注释、四个成员、连"为什么放这里而不是看门狗里"的 JSDoc 一起走；core 原位只留一行指针 + 四个薄包装。
- **形状**：`invSignature(b)` 只读背包 ⇒ 参数是 `b`；其余三个都要读 `self.bot` / `self._obs` / `self.position` / `self._selfMovingAt`、要 `self.emit(...)` ⇒ 按第 27 条收 `self`。
- 🔴 **定时器回调里的异常上报是私有方法**（`#reportError`）⇒ 按第 28 条由薄包装塞进 `ctx.reportError`。这一条在这里特别要紧：`setInterval` 回调里抛错 = **uncaughtException** = 整个宿主进程死（宿主只对 `unhandledRejection` 做 fail-loud，这条通道它不防），所以"异常有去处"是这一层的硬需求。冒烟里专门造了一个 `get players () { throw new Error('boom') }` 的假 bot 等 1.2 秒，验证错误确实落进 `ctx.reportError` 而不是冒泡出去。
- **新规矩**：薄包装与 import 撞名时给 import 取别名（`startObserver as startObserverImpl`）—— 写成迁移规矩第 30 条。
- **验证**（按用户要求不跑项目套件）：`node --check` ×2；自写 A/B 冒烟 **56/0**（`invSignature` 7 组；`observeTick` 14 种场景 ×2 项（事件 + 快照）：玩家上下线、自己上线不算 join、瞬移 30 格、被推 3 格、按着前进不算被推、刚自己飞过不算瞬移、只挪 1 格、捡到东西、背包变少、没有 entity、`_obs` 为空、`lastPos` 为空；`startObserver`/`stopObserver` 的初始快照 / 1000ms / 重复 start 不开第二个定时器 / stop 清干净 / 重复 stop 安全 / 抛错落进 `ctx.reportError`；接线 13 条）；扫描器第二遍 **0 条**。
- **这一刀没抓到新 bug**（`踩坑档案.md` 不动）。
- **没跑的**：`tools\check-*.mjs` 与 `实机验证\*.mjs` 由你自己跑。

### 聊天那一层补齐：搬进已存在的模块，头注释的"N 件事"也要改（路线图第 ④ 条第二十六刀）

`chatSay()` 搬进 `src\chat.mjs`（160 行，`core.mjs` 2853 → 2845 行，二十六刀累计 4896 → 2845）：

- **这一刀不是"再开一个模块"，而是补齐一个已有模块**：`src\chat.mjs` 是第十六刀建的，当时留了 `chatSay` 没搬（它要 `this.requireBot()`，属于"要读实例状态"）；这一刀把它收进去，聊天那一层（接消息 / 转文本 / 认玩家说话 / 进账 / 环形数组 / 往公屏说）就完整了。
- **形状**：`chatSay(self, text)` —— 要 `self.requireBot()`、要 `pushChat(self, …)` ⇒ 按第 27 条收 `self`。
- 🔴 **又是"薄包装和 import 撞名"**（第 25 刀刚记的规矩第 30 条，这一刀立刻第二次踩到）：`chatSay` 方法名与导入名同名 ⇒ `import { …, chatSay as chatSayImpl }`，薄包装调 `chatSayImpl(this, text)`。
- **新规矩第 31 条**：搬进已存在的模块时，模块头注释里的"N 件事"也要跟着改。
- **验证**（按用户要求不跑项目套件）：`node --check` ×2；自写 A/B 冒烟 **47/0**（12 组输入 ×3 项（返回值/报错、真的发出去的内容、聊天记录）：普通一句、`/` 开头、全角斜杠、斜杠在中间、`\n` 折叠、`\r\n` 折叠、超长截断到 220、空串、数字、`null`、`undefined`、前后空格；边界：`b.chat` 抛错照原样冒泡、`chatHistory=3` 截断一致、`username` 缺失一致；接线 7 条）；扫描器第二遍 **0 条**；`tools\check-core-evidence.mjs:287` 那条静态断言改成读 `src\chat.mjs` 并补"core 薄包装 + import 别名"的接线断言。
- **这一刀没抓到新 bug**（`踩坑档案.md` 不动）。
- **没跑的**：`tools\check-*.mjs` 与 `实机验证\*.mjs` 由你自己跑。

### 交互入口与装备搬进 world-use：扫描器第二遍一次逮到 3 条漏改的断言（路线图第 ④ 条第二十七刀）

`interact()` / `equip()` 搬进 `src\world-use.mjs`（220 行，`core.mjs` 2845 → 2812 行，二十七刀累计 4896 → 2812）：

- **形状**：`interact(self, args)` 只调公开方法（`self.lookAt` / `self.placeBlock` / `self.breakBlock` / `self.walkTo` / `self.position`）⇒ 收 `self` 就够；`equip(self, opts, ctx)` 要用实例的 `#t`（本轮 11 秒闸门）⇒ 按第 24 条塞进 `ctx.t`，模块里写 `const t = ctx.t ?? ((p) => p)`。
- **新规矩第 32 条**：搬进已存在的模块时，把新成员要用的兄弟依赖补进那个模块的 import（这里补了 `heldText`），补之前确认不成环。
- 🔴 **扫描器第二遍第一次真正派上用场**：它一次报出 3 条"正则只在别的模块里找得到"的断言 —— `tools\check-core-equip.mjs:317/318` 与 `tools\check-core-evidence.mjs:299` 都还在拿 `coreSrc` 找 `equip` 的实现体（`const ok = b.heldItem?.name === item.name` 等）。三条都改成查 `src\world-use.mjs`，并补了"core 确实 import 了 + 薄包装在"的接线断言。**这说明第十二刀那个漏改不是偶然**：同一段实现会被多个套件各自断言，搬完必须跑扫描器。
- **新坑（踩坑档案第 63 条）**：自写 A/B 冒烟用 `git show HEAD:src/core.mjs` 取旧实现时，**git 输出的文本是 LF**（`.gitattributes` 里 `* text=auto eol=lf`），而工作区文件是 CRLF ⇒ 用带 `\r\n` 的锚点会找不到（这一刀撞了两次：锚点找不到、`split('\r\n')` 切不开）。做法：取出后先 `.replace(/\r?\n/g, '\r\n')` 再比。
- **验证**（按用户要求不跑项目套件）：`node --check` ×3（core / world-use / 两个套件）；自写 A/B 冒烟 **44/0**（`interact` 9 组 ×（返回值 + 调用序列）：四个 mode、默认 look、`toward` 带/不带 `approach`、`toward` 没给 who、未知 mode、mode 是数字；`equip` 4 组 A/B + 换手静默失败（要带 note、不给 before）/ 换成另一样（带 before、不带 note）/ `ctx.t` 收到 `(promise, "equip", "手持 X")` / `ctx.t` 缺省不炸；接线 11 条）；扫描器第二遍 **3 条 → 修完 0 条**。
- **没跑的**：`tools\check-*.mjs` 与 `实机验证\*.mjs` 由你自己跑。

### vendor 依赖加载器搬出去：这几个名字仍然 re-export（路线图第 ④ 条第二十八刀）

`MC_DEPS` / `loadMcDep` / `loadPathfinder` / `resetMcDepCache` / `resetPathfinderCache`（连 `pickExport` / `DEP_OFF` / `_depCache`）搬进 `src\plugins.mjs`（159 行，`core.mjs` 2812 → 2676 行，二十八刀累计 4896 → 2676）：

- **这一刀第一次用 re-export**：这几个名字从第一版起就是 `core.mjs` 的公开导出（`export const MC_DEPS` / `export async function loadMcDep` …），搬走之后 core 原位换成 `export { … } from './plugins.mjs'` —— 名字还在、调用点一行不用改。全仓 grep 过：目前没有外部调用点，但**公开导出是契约**，不靠"现在没人用"来省这一行。
- **相对路径那条候选不受影响**：`new URL('../../../vendor/mc-deps/...', import.meta.url)` 是按文件位置算的，`plugins.mjs` 与 `core.mjs` 同在 `src/` ⇒ 往上三层还是同一个地方。真正兜底的是"按 `$DSH_HOME` 绝对路径找"那条（junction / 符号链接安装时相对路径会落到 `.pnpm` 深路径上）。
- **新规矩第 33 条（也是踩坑档案第 64 条）**：我在新模块头注释里写"按 `$DSH_HOME/profiles/*/vendor/mc-deps` 找"，那个 `*/` **把块注释提前关掉了** ⇒ 后面几行注释变成代码，`node --check` 报 `SyntaxError: Unexpected identifier 'pathfinder'`，行号还指在注释中间。改法：写成 `<profile>` 占位。
- **验证**（按用户要求不跑项目套件）：`node --check` ×2；自写 A/B 冒烟 **30/0** —— 从 `git show HEAD:src/core.mjs` 抠出旧加载器做成独立模块（只补 node:* 与 `format.mjs` 的 import，**不 import core.mjs**，免得为了测加载器把整台机器拉起来），与 `src\plugins.mjs` 逐条比对：`MC_DEPS` 逐字一致、五个依赖都能加载（日志行形状一致、路径可能不同）、`pathfinder` 的 `goals` 从 `default` 上补回来、未知 key 报错一致、缓存命中第二次不打日志、`resetMcDepCache` / `resetPathfinderCache` 行为一致、`spec: 'off'` / 指错目录 / 给 .js 文件三条候选路径行为一致；接线 8 条（含 **`core.MC_DEPS === plugins.MC_DEPS`**、`core.loadMcDep === plugins.loadMcDep`，即 re-export 真的生效）。
- **扫描器第二遍**：搬完报出 1 条漏改 —— `tools\check-logging.mjs:179` 还在拿 `coreSrc` 找 `/logWarn \?\? log/`（那条兜底在 `loadMcDep` 里）。改成读 `src\plugins.mjs`。顺手把 `tools\check-mc-deps.mjs` 里三处"按 core.mjs 的候选路径"的注释改成 `plugins.mjs`。
- **没跑的**：`tools\check-*.mjs` 与 `实机验证\*.mjs` 由你自己跑。

### 插件装配搬出去：加载器和装配本来就是一件事（路线图第 ④ 条第二十九刀）

第二十八刀把"找插件"（`MC_DEPS` / `loadMcDep`）搬进了 `src\plugins.mjs`，这一刀把"挂插件"也搬进去：`setupPathfinder(self, opts)` / `movements(self)` / `setupPlugins(self, opts)`。`core.mjs` 2676 → **2554 行**。

- **为什么放同一个模块**：`setupPlugins` 干的事就是"逐个 `loadMcDep` 然后挂上"，它和加载器共享同一份 `MC_DEPS` 与同一套"缺哪个只是少那项能力"的约定。分成两个模块，改一处要跳两次。
- **`#movements` 是私有方法**：core 里留同名私有薄包装 `#movements () { return movements(this) }`，`setupPlugins` 里对它的调用（`this.#movements()`）在 core 里一行没改 —— 现在 core 里只剩"走到目标"那条路调它。
- **`MC_DEPS` / `loadMcDep` / `loadPathfinder` / 两个 `reset*Cache` 仍然从 core 导出**（第二十八刀的 re-export 没动）：它们是第一版起就有的公开名字，全仓 grep 过目前没有外部调用点，但公开导出是契约，不靠"现在没人用"省这一行。
- **验证**（按用户要求不跑项目套件）：`node --check` ×2；自写 A/B 冒烟 **31/0**（`movements` 6 组配置逐字段对照、`setupPathfinder` 真加载 pathfinder 后逐字段对照、`setupPlugins` 编排层对照 —— `out` / `mcPlugins` / `loadPlugin` 次数 / collectBlock 与 pvp 共享同一份 `Movements`；接线 13 条）；`node tools\scan-moved-assertions.mjs` 第二遍 **0 条**。
- **这一刀的真教训**（规矩 34 + 踩坑档案第 65 条）：假 registry 让 `new Movements(bot)` 一路 `reading …`，两边抛同一个错 ⇒ A/B 六组全绿其实是六组空对空。换成真的 `minecraft-data` registry 才走通。
### 认证/会话层搬出去：全插件唯一碰凭据的地方单独一层（路线图第 ④ 条第三十刀）

`authOnly()` / `#makeSession()` / `#refresh()` / `#authenticate()` 和模块级的 `normalizeBaseUrl()` 搬进
`src\auth-session.mjs`（160 行，`core.mjs` 2554 → 2421 行）。

- **为什么值得单独一层**：这是**全插件唯一接触凭据的地方** —— 用户名、密码、accessToken 只在这里出现，
  而且只流向 mineflayer 与插件层回调。`authOnly()` 的返回值**脱敏**（只有 `ok` / `name` / `uuid` / `hasToken`），
  要持久化新令牌的调用方走 `onSession` 回调。模块头把这条写在第一句，免得以后有人把 session 塞进工具输出。
- **形状**：`authOnly` / `makeSession` 收 `self`（`makeSession` 要记一条"token 刷新失败，改用密码重新登录"的日志）；
  `refresh` / `authenticate` 是**纯函数**（只吃参数、只发 `fetch`）。同一个模块里既有收 `self` 的、也有纯的 ——
  判据还是迁移规矩第 17 条：只用参数就纯函数，要读/写实例状态才收 `self`。
- **两个同名薄包装**（迁移规矩第 15 条）：`authOnly`（`index.js` 的「刷新账户」在用）与 `#makeSession`（`connect()` 在用）。
  薄包装名与 import 撞名 ⇒ import 取别名 `authOnly as authOnlyImpl`（迁移规矩第 30 条，第二次用）。
- **验证**（按用户要求不跑项目套件）：`node --check` ×3；自写 A/B 冒烟 **78/0** ——
  旧实现用 `git show HEAD:src/core.mjs` 拷进 `src/` 当第二个 `McBot`，**两边共用同一个假 `fetch`**，
  比返回值 / 抛错文案 / `needUserAction` / `hint` / 发出去的 URL 与请求体：offline 5 组、
  不支持的登录方式与空端点 3 组、refresh 路径 9 组、authenticate 路径 7 组、请求体逐字一致（`agent` 那个 LittleSkin 400 事故）、
  直接调模块函数 5 条、`onSession` 与脱敏 6 条、接线 15 条。
- **顺手修**：`selfcheck.mjs` 里"代码里留了这条事故的说明"那条断言一直在读 `core.mjs` 找
  `/Yggdrasil Connect/` 与 `/缺 agent 直接回 \*\*400\*\*/` —— 那两句话跟着注释搬进了新模块 ⇒ 改成读
  `src/auth-session.mjs`，并补一条"core 确实从 `auth-session.mjs` 导入"的接线断言（扫描器第二遍逮到的 2 条）。
### 连接层搬出去：手术脚本改了调用点，尾参 `ctx` 得自己补上（路线图第 ④ 条第三十一刀）

`connect()` / `#scheduleReconnect()` / `disconnect()` 三个搬进 `src\connection.mjs`（335 行），`core.mjs` 2421 → 2141 行。

- **这一层收 `self`**：读写的全是实例状态（`self.bot` / `self.cfg` / `self.sub` / `self._connectOpts` / `self._connectionProfile` / `self.reconnecting` / `self.reconnectPending` / `self.connectedAt` / `self.stats` / `self.tasks` …），判据还是迁移规矩第 17 条。三样"模块不该知道"的东西走 `ctx`：`DEFAULTS`（默认值）、`reportError`（私有 `#reportError`）、`auth`（`sessionFlags` / `friendlyAuthError` / `takeAuthJoinError` 三个认证助手）—— core 里打包成 `#connCtx()`。
- **core 的三个薄包装**：`connect(opts)` / `#scheduleReconnect(sub)` / `disconnect(reason, {graceMs})`，**调用点一行没改**。
- **顺手清掉的**：core 不再 `import { offlineUuid, dashUuid } from './accounts.mjs'`（`dashUuid` 只在 `connection.mjs` 里给 session 的 uuid 加连字符）。
- **🔴 这一刀自己的教训**（迁移规矩第 36 条 + `踩坑档案.md` 第 67 条）：手术脚本把调用点 `await this.connect({ ...o, subserver: sub || o.subserver })` 改成 `await connect(self, …)` 时，**只换了前缀、没补第三个参数 `ctx`** —— 而脚本自检里有一条"新调用点必须带 `ctx`"，于是它在 `writeFileSync` **之前**就中止了（`git status` 干净、仓库一点没被动过）。判据：**改调用点的正则要连"尾参"一起改，自检要查新调用点的参数个数**。
- **验证**（按用户要求不跑项目套件）：`node --check` ×2；自写 A/B 冒烟 **43/0** —— 守卫路径 3 组（没 host / 没 auth / `connect('lobby')` 老写法兜底，两边抛同一句）、已连接 + 非 force ⇒ 空操作返回原 bot（且 `_connectionProfile` 逐字段一致、脱敏档里没有 token）、`force` 真连一次 `127.0.0.1:1` 失败后两边错误文案一致、`disconnect` 优雅/强断/没连接三种走法、`scheduleReconnect` 没参数 / 试满上限 / 已在重连中三组、接线 13 条。
- **扫描器第二遍**：一次报出 **6 条漏改**（`tools\check-audit-session.mjs` 5 条、`tools\check-logging.mjs` 1 条还在拿 `CORE` 找连接层实现），改成读 `src\connection.mjs` + 补接线断言后 **0 条**。

- **规矩 37（第三十二刀）**：一层只借"一个实例方法当回调"时，**别把整个 `self` 递进去** —— 薄包装写成 `equipFor(this, b, blk, label, { t: (p, k, l) => this.#t(p, k, l) })`：模块拿 `self` 只读 `self.mcPlugins`，拿 `ctx.t` 走预算闸门。判据：私有方法在模块里够不着 ⇒ 必须由薄包装包成箭头函数递进去；但**别顺手把 `self` 也当"什么都能拿"的袋子**，模块能碰的实例状态越少越稳（第 17·27·28 条讲的是"收 self 还是收 ctx"，这条讲的是"同一个模块里两者可以并存，但回调别用 self 绕"）。

### 换工具搬出去：只借一个回调的时候，别把整个 self 递进去（路线图第 ④ 条第三十二刀）

- **这一刀搬的**：`#equipFor (b, blk, label)` —— 动手前换对的工具。三条路：手上已经能挖且不慢 ⇒ 直接返回 `changed:false`；背包里有明显更快的（`bestToolFor` 算出来 < 现在 × 0.72）⇒ `b.equip(那把)`；手上不能挖 ⇒ 先问 `mineflayer-tool` 的 `b.tool.equipForBlock`，插件不在就自己 `b.equip` 兜底。
- **为什么在 `src\inventory.mjs`**：它就是"读 + 动 + 换手"那一层（第七刀建的，第十九刀收过四个动作）。搬进已存在模块 ⇒ 第 31 条（头注释的"N 件事"跟着改）与第 32 条（兄弟依赖补 import，`dig-speed.mjs` 的 `digMsFor` / `bestToolFor`）都用上了。
- **新规矩第 37 条**：这一层只借一个实例方法（私有的预算闸门 `#t`），薄包装写成 `{ t: (p, k, l) => this.#t(p, k, l) }` 而不是把 `self` 当万能袋子 —— 模块拿 `self` 只读 `mcPlugins`。
- **行为细节（冒烟里逮到的两个我自己写错的期望值）**：① `heldText` 报的是 `stone_pickaxex1` 这种原名 ×数量，不是中文"石镐"；② 徒手时**不一定**走 `equipForBlock` —— 背包里那把明显更快就先 `b.equip` 了，"问 mineflayer-tool"只在"背包里没有更快的"时才走。
- **验证（按约定不跑项目套件）**：`node --check` ×2；自写 A/B 冒烟 **43/0**（旧实现 = `git show HEAD:src/core.mjs` 把私有 `#equipFor` 暴露成公开 `equipForOld`，8 组假 bot 逐条比返回值 + 假 bot 上的调用序列 + `equipForBlock` 次数 + 最后手上那件，另 4 条行为断言 + 7 条接线）；扫描器两遍 **0 条**（第一遍 3 条是 `selfcheck.mjs` 里 `console.log` 的 ✅/❌ 行，不是断言）。
- `src\core.mjs` 2141 → **2114 行**（三十二刀累计 4896 → 2114）；`src\inventory.mjs` 225 → **268 行**。

- **规矩 38（第三十三刀）**：拿旧实现做 A/B 时，把**私有**方法改名成公开（`#t (` → `tOld (`）必须**连调用点一起改**（`this.#t(` → `this.tOld(`）—— 只改签名的话，旧拷贝里剩下的 16 处 `this.#t(` 会让整份文件直接 `SyntaxError: Private field '#t' must be declared in an enclosing class`，冒烟连 import 都过不去（`node --check` 也照报）。

### 运行时管线搬出去：超时闸门 / 错误上报 / 抢占 / 接 abort 本来就是一套（路线图第 ④ 条第三十三刀）

- **这一刀搬的**：`#reportError` / `#t` / `interruptMove` / `#stopPathing` / `setAbortSignal` 五个 —— 它们围着同一件事转："每一次 await 都要过的关口"和"出事了先落到哪儿"。`#t` 是**全 core 调用最多**的一个（16 处），搬走之后一行调用点都没改。
- **形状**（第 17 · 27 · 28 · 37 条）：这一层读写全是实例状态 ⇒ 第一参数收 `self`；两个**私有**方法（`#releaseControls` / `#cancelCollect`）模块里够不着 ⇒ core 加了一个 `#runCtx()` 把这两件包成箭头函数递进去。
- **新规矩第 38 条（这一刀自己踩的坑）**：A/B 的旧拷贝把 `#t` 改名成 `tOld` 时只改了签名，剩下 16 处 `this.#t(` 让整份旧文件 `SyntaxError: Private field '#t' must be declared in an enclosing class` —— 私有成员改名必须连调用点一起改。
- **顺手修 2 条旧断言**：`tools\check-call-budget.mjs` 三条（`_moveGen++` 计数、`setGoal(null)` 的实现体、`Promise.resolve(this.interruptMove('用户中断'))`）改成"薄包装 + 新模块"两段式；`tools\check-logging.mjs:181`（超时文案）改成查 `src\runtime.mjs`。
- **验证（按约定不跑项目套件）**：`node --check` ×2（+ 全部 44 个 `src\*.mjs` 与 `index.js`）；自写 A/B 冒烟 **95/0**（旧实现 = `git show HEAD:src/core.mjs` 把三个私有成员改名成公开，① `reportError` 4 种输入 × 有/无 error 监听者 比 返回值/日志/emit/`lastError`；② `withBudget` 6 种情形 比 返回值/异常/`lastTimeout`/`stats.timeouts` 增量/松控制位时机与键清单；③ `stopPathing` 4 种假 bot 比调用序列；④ `interruptMove` 比移动号增量 + 非控制位调用序列；⑤ `setAbortSignal` 比 abort 后移动号 +1、换 signal 摘旧监听、传 null 清空；⑥ 16 条接线）；静态对照 **15/0**；扫描器两遍 **0 条**。
- `src\core.mjs` 2114 → **2010 行**（三十三刀累计 4896 → 2010）；新建 `src\runtime.mjs` **159 行**。

- **规矩 39（第三十四刀）**：判"实现体搬走了没"要用**实现特有的代码**做判据（三层循环、`const deadline = Date.now() + …` 这种），别拿 JSDoc 里那句中文 —— 薄包装的注释往往**照抄同一句话**，于是"core 里没有实现体"的断言永远红。

### 搭建层搬出去：同一个事实，三个套件各断言了一遍（路线图第 ④ 条第三十四刀）

- **这一刀搬的**：`build()`（50 行，`mc_build` 的正文）→ 新建 `src\build.mjs`（75 行）。它自己不放方块，是"范围 → 一堆坐标 → 逐个 `placeBlock`"的调度；真放方块是 core 的 `placeBlock`（会自己走近/垫脚），按路线图留在最后。
- **形状**（第 27 条）：要回调实例方法 `placeBlock`、要读 `requireBot` / `callLeft` ⇒ 第一参数收 `self`；import 取别名（第 30 条）`import { build as buildImpl } from './build.mjs'`。
- **扫描器第二遍一次报出 3 条**（`tools\check-core-evidence.mjs` 两条 + `tools\check-core-equip.mjs` 一条）—— 同一个事实（"`placed:false` 不再计数"）被三个套件各断言了一遍，而我第一次 grep 只逮到两条（第三条的 `&&` 把两条正则拆在两行上）。三条都改成读 `src\build.mjs` + 补接线断言。
- **新规矩第 39 条（这一刀自己踩的坑）**：我写"core 里没有 build 的实现体"这条断言时用了 `!/批量放置：从 \(x1/`，而薄包装的 JSDoc 开头**就是同一句话** ⇒ 这条永远红。改成用实现特有的代码（`for (let y = ay; y <= by; y++)` 与 `const deadline = Date.now() + this.callLeft()`）当判据。
- **验证（按约定不跑项目套件）**：`node --check`（`src\build.mjs` / `src\core.mjs` / 全部 `src\*.mjs` / `index.js` / 改过的四个套件）；自写 A/B 冒烟 **21/0**（旧实现 = 从第三十四刀之前的 `core.mjs` 抠出 `build` 的 JSDoc + 方法体、原样包进一个 `class Old`（`this.` 一字不改），与 `src\build.mjs` 共用同一套假 `requireBot` / `callLeft` / `placeBlock` 逐条比对：8 组结果逐字 + 6 条行为（真放上去了、`placeBlock` 真被调两次、跳过时一次没调、`placed:false` 如实报"现在那里是 dirt"）+ 7 条接线）；静态对照 **9/0**；扫描器两遍 **0 条**。
- `src\core.mjs` 2010 → **1962 行**（三十四刀累计 4896 → 1962）；新建 `src\build.mjs` **75 行**。

### 移动原语搬出去：A/B 两边共用一份"会变的假件"，比出来的差异全是测试自己的锅（路线图第 ④ 条第三十五刀）

- **这一刀搬的**：`jump()`（31 行）与 `swimUp()`（80 行）→ 新建 `src\movement.mjs`（128 行）。两个都是"按住某个控制位一小会儿"的**原地原语**（爬台阶 / 水里换气）；大件（`walkTo` / `#walkPathfinder` / `flyTo` / `#walkSwim`）按路线图**留到最后**。
- **形状**（第 17 · 28 条）：读写全是实例状态（`requireBot` / `callLeft` / `msLeft` / `abortSignal` / `position` / `_moveGen`）⇒ 第一参数收 `self`；`#beginMove()` 是**私有**方法、模块够不着 ⇒ 薄包装塞进 `ctx.bumpGen`（模块里 `const bumpGen = ctx.bumpGen ?? (() => ++self._moveGen)`，冒烟不必造真闸门）。
- **两个同名薄包装**（第 15 条）：`async jump () { return await jumpImpl(this, { bumpGen: () => this.#beginMove() }) }`、`async swimUp (opts = {}) { return await swimUpImpl(this, opts, { bumpGen: () => this.#beginMove() }) }`；import 取别名（第 30 条，第三次用）。**调用点一行没改**。
- **新规矩第 40 条（这一刀自己踩的坑）**：冒烟第一版 **22/3**，三条失败全是**假件的锅** —— `pair()` 里新旧共用一份假 bot，而 `entity.isInWater` 是**时变**的 ⇒ 先跑的那边耗掉 200ms，后跑的那边一进门就"我本来就没在水里"；另外 §A⑤ 把 `_moveGen++` 推到了包装对象上，而旧实现用的是 `new Old()` 那个实例（推号推到了别人身上）。改成"新旧各一份 + **B 在 A 跑完之后再造** + 推号推到旧实现真正在用的实例"才 **25/0**。
- **静态断言这次要看清扫描器的盲区**：扫描器第二遍只报出 3 条（`tools\check-core-swim.mjs` ⑦ 段），但那一组里还有十来条按 core 文本找 `swimUp` 实现的断言（`rose >= 0.4`、`Number.isFinite(Number(hold))`、`self.abortSignal?.aborted` …）—— 它们**既不在 core、也不逐字在 `movement.mjs`**（那边去了 2 格缩进、`this.` → `self.`）⇒ 扫描器按"在别的模块里找得到"判，**看不见它们**。整段改成读 `src\movement.mjs`（去缩进、`this.` → `self.`、`#beginMove()` → `ctx.bumpGen()`），再补 3 条接线断言。
- **验证（按约定不跑项目套件）**：`node --check` ×2；自写 A/B 冒烟 **25/0**（旧实现 = `git show HEAD:src/core.mjs` 抠出两个方法包进 `class Old`：§A `jump` 5 组 / §B `swimUp` 6 组 / §C 行为 5 条 / §D 接线 9 条）；扫描器第二遍 **0 条**。
- `src\core.mjs` 1962 → **1861 行**（三十五刀累计 4896 → 1861）；新建 `src\movement.mjs` **128 行**。
### 移动最后一块搬出去：按签名数花括号会先撞上参数里的 `{`（路线图第 ④ 条第三十七刀）

- **这一刀搬的**：`#walkPathfinder`（200 行，走路的正文：领移动号 → 装 `Movements` → `goto` → 听 `path_update`/`path_reset`/`diggingCompleted`/`blockUpdate` → 自己复核距离 → 三种 reason 分流 → `finally` 只在自己还是最新一号时停 pathfinder + 松控制位）→ `src\movement.mjs`（366 → **575 行**）。
- `src\core.mjs` 1657 → **1478 行**（三十七刀累计 4896 → 1478）。core 只剩薄包装 `#walkPathfinder (target, opts = {}) { return await walkPathfinderImpl(this, target, opts, this.#pathCtx()) }` 与 `#pathCtx()`（六个私有件：`movements` / `collectBusy` / `cancelCollect` / `beginMove` / `stopPathing` / `releaseControls`）；**调用点一行没改**。
- **为什么这一刀这么排**：路线图第 ④ 条点名"移动和挖掘最后拆"，而 `#walkPathfinder` 是移动里跟"移动编号 / 控制位租约 / 事件监听"缠得最紧的一块 —— 它读 `self._moveGen` 判"我这一号还是不是最新的"，又要在 `finally` 里只在自己时收尾。所以它是移动的最后一块，**之后只剩挖掘那一组**（`dig` / `placeBlock` / `breakBlock`）。
- **🔴 这一刀自己踩的坑**（迁移规矩第 41 条 + `踩坑档案.md` 第 71 条）：第一版手术脚本用 `core.indexOf('{', sigIdx)` 找函数体起始 —— 那一行里**第一个 `{` 是参数的解构**，花括号在参数那个 `}` 就配平，抠出来的段落被截断在参数行；`node --check` 不报（截出来的是半行源码），是脚本自己那条"签名换成功了没"的检查红的。顺带记一笔：那条检查的正则 `/^export async function walkPathfinder \(self, target,/` **忘了 `/m`** ⇒ 在多行文本上永远不匹配，"签名没换成功"这个提示本身先骗了我一次。
- **验证**（按用户 m21715 约定**不跑项目套件**）：`node --check` ×2；自写 A/B 冒烟 `%TEMP%\wc-smoke37.mjs` **17/0**（旧实现从 `%TEMP%\wc-core-before37.mjs` 抠出 JSDoc + 方法体、私有调用改写成 `ctxStub.*`、包进 `class Old`，与 `src\movement.mjs` 共用同一套假 bot/self 逐条比对：① 正常走到；② 插件说到了但我还差很远 + 不是我的 goal ⇒ `goal-reached-but-far`；③ `goto` 抛 `NoPath`；④ 抛 `Timeout`；⑤ 采集任务还在后台跑 ⇒ 先 `cancelCollect`；⑥ 本轮时间用完 ⇒ budget 那一支；⑦ 被另一次移动接管 ⇒ `preempted` 且不碰控制位；⑧ 空路径的 `noPath` ⇒ 报"真没路"不是 preempted；接线 9 条）；静态对照 `%TEMP%\wc-eq-static37.mjs` **27/0**；扫描器第二遍 **0 条**。
- **改过的静态断言**：`tools\check-call-budget.mjs` ⑦ 条（`budgetAsked` 三句、`preempted` 判号、`reasonOut`、`noProgress`、`finally` 只在自己时收尾、空路径/别人的 goal）、`tools\check-core-equip.mjs` 2 条（`roadInfo` / `pillaredWith`）、`tools\check-core-evidence.mjs` 1 条（`noProgress`）、`tools\check-core-swim.mjs` 6 条（`walkSwim` 签名、水里分支、`swam` 标注、`via: 'swim'`、`forward`+`jump`、`swim-shore`/`swim-budget`）⇒ 全部改查 `src\movement.mjs`，并补"core 确实 import 了"的接线断言。
- **没跑的**：`tools\check-*.mjs` 与 `实机验证\*.mjs` 由你自己跑。

### 挖掘层搬出去：先写盘、后验锚点，留下一个孤儿模块（路线图第 ④ 条第三十八刀）

- **这一刀搬的**：`breakBlock`（124 行）→ 新建 `src\mining.mjs`（152 行）。这是"挖掘那一组"的第一块（后面还剩 `placeBlock` 131 行与 `dig` 233 行）。
- `src\core.mjs` 1477 → **1369 行**（三十八刀累计 4896 → 1369）。core 只剩薄包装 `async breakBlock (opts = {}) { return await breakBlockImpl(this, opts, this.#mineCtx()) }` 与 `#mineCtx()`（五个私有回调：`waitGrounded` / `equipFor` / `watchServerBreak` / `awaitServerBreak` / `t`）；**调用点一行没改**（`index.js:2560` 的 `case 'break'`）。
- **六条判据照原样保留**（见模块表那行）：够不着不动手 / 没落地不动手 / 换不上工具直接拒绝 / 时间不够不开始挖 / 服务端三态判决 / 超时不等于没挖掉。这些全是 2026-10-08 那几轮实机反馈换来的（"快挖完的时候会重置"、"挖了十几秒其实早挖掉了"、铁矿"复原"）。
- **🔴 这一刀自己踩的坑**（迁移规矩第 42 条 + `踩坑档案.md` 第 72 条）：第一版脚本只校验了"要删的那段"（签名、JSDoc、花括号配平、`this.` 残留），**没校验"要插的锚点"** —— 它先写了 `src\mining.mjs`，再去 core 插 import，而我猜的那个"单行 import"锚点根本不存在（movement 的 import 是**多行**的）⇒ `exit 1`，仓库里留下一个孤儿模块（新模块在、core 一点没动），重跑还被"文件已存在"挡住。修法两条：**所有锚点先验完再写盘**；import 锚点只取 `} from './xxx.mjs'` 这种尾巴。
- **验证**（按用户 m21715 约定**不跑项目套件**）：`node --check`（`src\core.mjs` / `src\mining.mjs` / 改过的 `tools\check-core-equip.mjs`）；自写 A/B 冒烟 `%TEMP%\wc-smoke38.mjs` **34/0**（旧实现从 `%TEMP%\wc-core-before38.mjs`（HEAD `ab5abac`）抠出方法体包进 `class Old`，两边共用同一套假 bot / 假 ctx 逐条比对：§A 六个"还没动手就返回"的分支（未加载 / 本来就是空气 / 够不着 / 空中 / 换不上工具 / 时间不够）、§B 五条真挖出口（服务端说变空气 ⇒ `confirmed:true` / 复原 ⇒ `restored:true` + log 一句 / 本地没了但没回包 / 超时且方块还在 / dig 抛非超时原样抛出）、§C 行为断言（复原真的 log 了、超时后真的等了服务端包）、§D 接线 6 条）；静态对照 `%TEMP%\wc-eq-static38.mjs` **13/0**；扫描器第二遍 **0 条**。
- **改过的静态断言**：`tools\check-core-equip.mjs` 里那 6 条按 `coreSrc` 找 `breakBlock` 实现细节的（`await this.#equipFor` / `!canHarvestNow` / `硬挖会一直超时` / `const digMs = digMsFor` / `digMs + 900`）⇒ 改成读 `src\mining.mjs`，并补 3 条接线断言（core 从 mining.mjs 导入、薄包装在、core 没有残留实现体）。

### 放置层搬出去：A/B 全绿，但"悬空垫脚"那条分支两边都没走到（路线图第 ④ 条第三十九刀）

- **这一刀搬的**：`#placeRef`（12 行，找依附面）+ `placeBlock`（131 行）→ 新建 `src\place.mjs`（158 行）。`src\core.mjs` 1477 → **1248 行**。这是"挖掘那一组"的第二块（后面只剩 `dig` 233 行 —— 它比这两个加起来还长，按路线图留到最后）。
- **🔴 这一刀自己踩的坑**（迁移规矩第 43 条 + `踩坑档案.md` 第 73 条）：冒烟第一版 §A–§C 全绿（旧新逐条一致），但其中"悬空垫脚"的用例里**机器人脚下那格就是空气** ⇒ 代码连垫脚分支都没进去，两边空对空比了一遍。改法：把世界摆成"脚下实心 + 目标紧挨脚上方"，才真的走到"先垫一块、再放目标"（`placeBlock` 被调两次）。
- **验证**（按用户 m21715 约定**不跑项目套件**）：`node --check`（`src\core.mjs` / `src\place.mjs`）；自写 A/B 冒烟 `%TEMP%\wc-smoke39.mjs` **42/0**（旧实现从 `%TEMP%\wc-core-before39.mjs`（HEAD `7f5ef9f`）抠出 `#placeRef`/`placeBlock` 包成两个导出函数，两边共用同一套假 bot / 假世界 / 假 ctx 逐条比对：§A `placeRef` 3 条、§B 六个"还没动手就抛"的分支、§C 七条真放（成功 / 放完还是空气 / 服务端拒 / 走过去再放 / 悬空垫脚 / 创造取物 / 点名火把）、§D 六条行为断言、§E 七条接线）；扫描器第二遍 **0 条**（这一刀没有漏改的静态断言）。
- **搬走时顺手保留的三件事**：① 薄包装 `#placeCtx()` 把 `#t` 递进去（第 24/37 条）；② `placeBlock` 的错误文案一字不改（"已被 stone 占住"、"目标位置悬空且脚下没有可依附方块"）；③ 回读用 `b.blockAt` 而不是看 `placeBlock` 的返回值（第 ⑥ 条判据）。

### 挖方块搬出去：A/B 全绿，四条出口却全走了同一条路（路线图第 ④ 条第四十刀）

- **这一刀搬的**：`dig`（231 行，`mc_dig` 的正文）→ 并进第三十八刀建的 `src\mining.mjs`（151 → 395 行）。`src\core.mjs` 1248 → **1029 行**。**"移动与挖掘主体"到这一刀就全搬完了**（`walkTo` / `#walkPathfinder` / `#walkSwim` / `flyTo` / `breakBlock` / `placeBlock` / `dig`），core 只剩薄包装与零散小件。
- **这一刀的形状**：`dig` 是"读 `self`（`tasks` / `position` / `cfg` / `walkTo` / `log`）+ 调一堆私有件"，所以**两个都收** —— `self` 走实例，私有件走 `ctx`（`#mineCtx()` 从 5 项补到 11 项）。迁移规矩第 17·27·28·37 条在这里一次用全。
- **🔴 这一刀自己踩的坑**（迁移规矩第 44 条 + `踩坑档案.md` 第 74 条）：冒烟第一版 40 条断言全绿、调用序列也逐条一致，但 §B 四条"真挖出口"**全都走的是"够不着"那条**（目标放在 5.6 格外）—— 四条断言等于各比了一遍同一条错路。改成"目标 2 格内"并给每条出口配一句"**这条路真的走到了**"的断言（看输出里那句特有的话）之后，才是真覆盖；顺便把三组返回值打印出来看了一眼，才确认 §A 那几条也不是空的。
- **验证**（按用户 m21715 约定**不跑项目套件**）：`node --check`（`src\core.mjs` / `src\mining.mjs` / 改过的两个套件）；自写 A/B 冒烟 `%TEMP%\wc-smoke40.mjs` **47/0**（旧实现从 `%TEMP%\wc-core-before40.mjs`（HEAD `c9225de`）按内容定位抠出 `dig`、把 `this.#x(` 改写成 `this.stubX(` 包进 `class Old`，两边共用同一套假 bot / 假任务表 / 假 ctx 逐条比对输出与调用序列：§A 六个"还没动手就返回"12 条、§B 四条真挖出口 12 条、§C 够不着/走过去顺手挖掉/空中 6 条、§D 任务记账 6 条、§E 接线与模块卫生 11 条）；扫描器第二遍从 **4 条**陈年断言改到 **0 条**（`check-core-evidence.mjs` 的 `/没挖成/` 与 `/heldText(b)/`、`check-core-swim.mjs` 的两条流体判据）。
- **顺手做的一件事**：`src\core.mjs` / `src\mining.mjs` 的行尾归一到纯 CRLF（以前是"CRLF + 几十处裸 LF"的混合，按行号定位的脚本会错位；这次就是先按行号找、7 个锚点全对不上，才改成按内容定位）。

### 控制位租约搬出去：状态字段留在实例，读写逻辑搬进模块（路线图第 ④ 条第四十一刀）

- **这一刀搬的**：`holdControl`（反射层按住一个控制位一小会儿，并声明租约）+ `#releaseControls`（收尾松控制位，但跳过没过期的键）→ 并进第三十三刀建的 `src\runtime.mjs`（159 → 201 行）。`src\core.mjs` 1029 → **1007 行**。
- **为什么归 runtime**：这两件事和 `stopPathing` / `interruptMove` 本来就是一套 —— 都是"收尾时别抢别人正按着的控制位"。反射层没有握手，所以由实例这边**声明租约**：`_ctrlLease` 里没过期的键不松（否则"脚边就是岩浆，走一步收尾把后退松了，机器人继续往危险里走"）。
- **形状**（迁移规矩第 45 条）：租约表 `_ctrlLease = new Map()` 是**实例状态**，留在 `core.mjs`；两个方法体收 `self` 搬进模块。`holdControl` 仍是公开方法（`mc_auto` 直接调 `sess.bot.holdControl`），`#releaseControls` 是私有方法 ⇒ 薄包装留在 core。
- **验证**（按用户 m21715 约定**不跑项目套件**）：`node --check`（`src\core.mjs` / `src\runtime.mjs` / `tools\check-call-budget.mjs`）；自写 A/B 冒烟 `%TEMP%\wc-smoke41.mjs` **30/0** —— 旧实现从 `%TEMP%\wc-core-before41.mjs`（HEAD `4c5c4f8`）按方法名统一改名抠出两个方法包进 `class Old`，与 `src\runtime.mjs` 逐条比对"按下/松开序列 + 租约快照 + 返回值"：§A 按住与收尾不松、§B 到期自己松、§C 续租后第一次的定时器不松、§D 收尾只松没租约的键、§E 过期条目被清掉、§F 接线与模块卫生；扫描器第二遍 **0 条**。
- **静态断言跟着改**：`tools\check-call-budget.mjs` 里那条"自保反射的控制位有租约"原来三段都查 `core.mjs` 文本 ⇒ 改成"租约表 + 薄包装查 core、`export function releaseControls (self)` 与 `const until = self._ctrlLease.get(k) ?? 0` 查 `src\runtime.mjs`"。**这一刀没发现产品 bug**，`踩坑档案.md` 计数不动（仍 74 条）。

### 任务门面搬出去：抠旧实现时，它依赖的模块级 import 也要一起带上（路线图第 ④ 条第四十二刀）

`src\core.mjs` 里那八个任务门面（`taskStart` / `taskList` / `taskGet` / `taskResume` / `taskNote` / `taskDone` /
`taskCancel` / `taskForget`）搬进 `src\task-report.mjs`（86 → 161 行），`core.mjs` **1007 → 974 行**。

**这一刀的形状**：八个动作全是"读 `self.tasks`、读 `self.position`、必要时读一下现场背包"的记账 ⇒ 按迁移规矩第 27 条收 `self`；
它们原先调的私有 `#taskHave` 在模块里直接换成同模块的 `taskHave(self.bot, …)`（不需要 `ctx`）。core 只留八个一行薄包装（调用点一行没改）。

**这一刀自己的教训（迁移规矩第 46 条 / 踩坑档案第 75 条）**：A/B 冒烟第一版 **25/7**，七条全红在"旧侧 `taskHave is not defined`" ——
从旧 `core.mjs` 抠出来的方法体里调的是**模块级导入**的 `taskHave`，而我只把方法体搬进了临时 `class Old`，没把那个 import 带过去。
判据：**抠旧实现 = 方法体 + 它引用的模块级标识符**。

**验证**（按用户约定不跑项目套件）：`node --check`（新模块 / core / 全部 `src\*.mjs`）；自写 A/B 冒烟 **32/0**
（§A 开工/列出/看明细 3 组、§B 恢复/记一笔/完成/取消/忘掉 4 组、§C 现场进度真的读了背包、§D 接线 17 条）；
扫描器两遍 **0 条**（全仓没有按文本找这八个名字的断言）。

### 等区块 / 要一个在线 bot 搬出去：同一个坑第二次踩到，说明判据写窄了（路线图第 ④ 条第四十三刀）

`src\core.mjs` 里两个"每次动手前后都要过一遍的小关口"并进第三十三刀建的 `src\runtime.mjs`（201 → 240 行）：
`waitForChunks`（22 行，等区块加载 —— 算进本轮 11 秒、`msLeft()` 用完立刻回 `false`、aborted 抛中断）与
`requireBot`（37 行，要一个一定在线的 bot）。`core.mjs` **974 → 955 行**。

**这一刀的形状**：两个都读实例状态（`self.bot` / `self.online` / `self.msLeft()` / `self.abortSignal` / `self.lastError`）⇒ 按迁移规矩第 27 条收 `self`；
core 留两个一行薄包装（`requireBot` 因为名字跟 import 撞了，照规矩 30 取别名 `requireBotImpl`），调用点一行没改。

**这一刀自己的教训**：A/B 冒烟第一版 **18/3**，三条全红在**旧侧** —— `raceAbort is not defined`、`abortError is not defined`。
这和第四十二刀是**同一个坑**：从旧 `core.mjs` 抠出来的方法体依赖模块级标识符（`sleep` / `raceAbort` / `abortError`），
临时旧模块里没带上。上一刀把判据写成"连它依赖的模块级 import 一起搬"，这一刀说明**判据要写成"所有模块级标识符"**
（导入的函数、常量、类都算），已补进迁移规矩第 46 条。

**验证**（按用户约定不跑项目套件）：`node --check`（`src\core.mjs` / `src\runtime.mjs` / 全部 `src\*.mjs`）；
自写 A/B 冒烟 **21/0**（§A `requireBot` 5 组：在线 / 离线 / 幽灵在线 / 带 lastError / 从没连过；
§B `waitForChunks` 8 组：没 entity / 时间用完 / aborted / 脚下有方块 / 脚那格有方块 / 一直没区块 / 只剩 150ms / 只剩 90ms；
§C 接线 8 条）；扫描器两遍 **0 条**。

### 走路目标在半空 / 眼距算一次就冻住：两个"搭到空气上"的根因（2026-10-13）

用户报「搭路一直搭到空气上」。查下来是两条**都跟 y 从哪来**有关的老毛病：

- `walkPathfinder` 直接拿 AI 给的 `target.y` 建 `goals.GoalNear`，而 `GoalNear` 按三维距离算 ⇒ 目标在半空时它会一路**垫方块往上爬**（返回值里的 `pillared`）。现在先过一遍新导出的 `standableY (b, x, y, z)`：脚下实心、这格与头上一格都能穿过才用这个 y；否则往下找 4 格 / 往上找 2 格；都找不到就原样返回。
- `placeBlock` 的眼睛位置在走路**之前**算一次就冻住了 ⇒ 走完还报"够不着 41.3 格"（那是出发那一刻的距离）；接近点也朝半空的 `pos.y` 走。现在眼距 `eyeNow()` **每次现算**，接近点交给 `approachSpot (b, pos)`（周围 2 格内找一块能站的地面；找不到就如实拒绝，并建议改用 `mc_build`）。

`mc_map` / `mc_scan` 给的"地表高度"在树林里是树冠、在山上是最高的石头 —— 拿它当走路目标之前，插件现在会自己收到底面。细节见 [踩坑档案.md](踩坑档案.md) 第 78 条。

### 拆分收尾体检：新套件 `check-module-load.mjs`（路线图第 ④ 条收尾，2026-10-08）

`src\core.mjs` 从 **4896 行拆到 955 行**（51 个 `src\*.mjs` 模块），移动与挖掘主体也按路线图在最后搬完。
但拆分过程中一直有个盲区：**没有任何套件在"每个模块自己还能不能 import"这件事上把关** ——
`check-standalone-import.mjs` 只 import 包入口，`selfcheck.mjs` 走的是行为路径，
中间某个 `src\*.mjs` 的 import 图断了（漏改一行 import、循环依赖、语法错），
往往要等到某条具体功能路径被走到才炸。为此新增 `tools\check-module-load.mjs`（**30/0**，已进 `check-all` 的 ORDER）：

1. 包入口 `index.js` 能 import（`name` / `apply` / `Config` 都在）；
2. `src\*.mjs` **全部**能 import（51 个模块，跳过 `_` 开头的临时件）；
3. `extensions\*.mjs` 全部能 import，且"该有 `apply` 的有、纯助手模块没有"
   （`mc_util.mjs` / `mc_skin.mjs` / `mc_view-render.mjs` 三个是纯助手，加载器静默跳过是设计如此）；
4. `core.mjs` **仍然只是外壳**：≤1000 行，且没有任何方法超过 26 行代码；
5. 六条路线图的**关键件都还在**：9 个工具仍注册、`mc_observe` 的 `image:false`/`capturedAt`/`uncertainties`、
   `task-runner` 的 `OUTCOMES`/`outcomeOf`、四类记忆、`runtime.mjs` 的等区块/在线 bot/抢占/中断口；
6. **薄包装不许 `return` 一个没绑定的名字**：63 个薄包装逐个查那个名字有没有绑定
   （import 绑定 / 顶层 `const`·`function`·`class` / JS 内置）。

这一条不是"防 bug"而是"防拆分拆散"：以后任何一刀搬完，跑一遍它就知道有没有把 import 图弄断。

**第 6 条是实机逼出来的**：2026-10-08 用户点 `mc_move {mode:"walk"}` 报
`Error: movements is not defined` —— 第二十九刀把 `#movements` 搬进 `src\plugins.mjs` 时，
core 里留下的薄包装 `#movements () { return movements(this) }` **忘了把 `movements` 加进 import**。
`node --check` 只看语法、那一刀的 A/B 冒烟又把 `ctx.movements` 桩掉了，于是一路全绿到真走路才炸。
判据写进踩坑档案第 74 条：**薄包装"委托给谁"，谁就必须在 import 名单里**。

### 装备栏：以前"我身上穿着什么"是空白（2026-10-13）

用户报"它现在看不到自己身上的装备，增加装备栏，让它能通过装备栏装备装备"。查下来是两件事叠在一起：

- **看不见**：`bot.inventory.items()` 只回**背包范围**（`minecraft:inventory` 窗口的 9–44 格 = 主背包 + 快捷栏）。
  头/身/腿/脚（槽 5/6/7/8）和副手（槽 45）**不在里面** ⇒ `mc_inventory` 与 `mc_observe` 的"背包"里根本没有身上穿着什么，
  AI 会以为自己光着，于是把已经穿着的头盔又做一遍。
- **穿不上**：`equip` 只会 `b.equip(item, 'hand')` —— 盔甲也能"拿到手上"，但**永远穿不到身上**。

改动：

- `src\inventory.mjs` 新增 `EQUIP_SLOTS`（5/6/7/8/45 与 `head`/`torso`/`legs`/`feet`/`off-hand` 的对照）、
  `equipmentOf(b)`、`equipmentText(b)`、`equipDestOf(name)`（按名字猜该穿哪格：头盔→头、胸甲→身、护腿→腿、靴子→脚、
  盾/图腾→副手，其余照旧拿到手上）；`inventoryView()` 多一行 `🛡 装备栏：头 … · 身 … · 腿 … · 脚 … · 副手 …`，返回值多一个 `equipment`。
- `src\world-use.mjs` 的 `equip(self, { name, to }, ctx)`：`to` 可显式指定格子（`offhand` 也认成 `off-hand`）；
  **只给 `to` 不给 `name` = 脱下来**（`bot.unequip`）；穿完**读回那一格**复核（`hand` 看 `b.heldItem`，
  盔甲看 `b.inventory.slots[5/6/7/8/45]`），原来穿着的那件被换下来时如实报 `swappedOut`。
- `index.js`：`mc_act` 的 `equip` 加 `to` 参数说明；`mc_inventory` 描述改成"看背包、装备栏和手持物品"。
- `extensions\mc_observe.mjs`：结构化字段（`out.equipment` / `percept.equipment`）与文本（`🛡 装备栏`）都带，
  看图与不看图（`image:false`）两条路都加。
- 记忆规则（11 份 `RULES.md`）：「打怪与保命」补一条"穿上盔甲"，「工具速查」的 `mc_inventory` 改成"背包**和装备栏**"。

回归：自写临时 A/B 冒烟 **54/0**（`equipDestOf` 18 组名字、装备栏五格读法、`inventoryView` 带装备栏、
`equip` 的 14 条路：自动猜格 / 显式 `to` / 只给 `to` 脱甲 / 脱空格子不白调 `unequip` / 换下来的回到背包 /
缺料报错并指路装备栏 / `to` 非法 / 什么都不给 / 剑仍拿到手上 / `offhand` 别名 / 没穿上如实说 / 换手失败如实说 /
老版本没有 `unequip` / 脱失败如实说），加接线断言 9 条。`node --check` 四个文件全过，扫描器第二遍 0 条，token 预算 17974/18000。

### 挖冰被报成"服务端复原"：非空气回包 ≠ 服务端拒绝（2026-10-13）

**现象**：AI 在冰湖上跟玩家说「我这边客户端把湖面看成冰，服务端说是水，方块对不上」—— 它在猜"客户端和服务端的方块不一致"。

**根因**：`src\server-break.mjs` 原来把**任何非空气回包**都当成"复原（服务端拒绝）"。可挖冰时冰没了、水立刻露出来，服务端把那一格正常发成 `water` ⇒ 挖成功的冰被报成「服务端把这块改回了 water（复原）—— 这次破坏服务端没认」。

**后果不只是文案**：那是一片**冰盖下的水** —— `swimUp` 顶到冰出不去，AI 唯一的出路就是砸冰，而砸冰一直被报成"服务端没认"，于是它泡在水里十几分钟，`mc_auto` 的憋气唤醒响了 15 次，血掉到 4/20。

**改法**：`watchServerBreak()` 现在会记下动手前客户端以为的方块名，新增 `classifyRestore(watch)` 三分类 —— **同一个方块**发回来 = 真拒绝；**变成水/岩浆** = 破坏成功（液体涌进来）；**别的方块** = 客户端区块旧了（提示 `mc_connect {force:true}`）。`breakBlock()` 与 `dig()` 都按这三路分别说话。

**回归**：临时冒烟 14/0；`node --check` ×2；52 个 `src\*.mjs` 全部能 import（详见 `踩坑档案.md` 第 81 条）。

### 附魔台：窗口开得出来、三个选项却读不到（2026-10-13）

游戏里的 AI 报原话：「附魔台能打开（窗口类型 enchantment，38 格），但我这边没有"选附魔"的工具」——
`mc_act` 只有 look/place/break/use/useitem/attack/equip/toss。

**根因**：`mc_act {mode:"use"}` 走的是 `bot.activateBlock` —— 窗口确实开了，但**附魔的助手不在窗口上**。
三个选项（`table.enchantments`）、`ready` 事件、`table.enchant(choice)`、`putTargetItem`/`putLapis`/
`takeTargetItem` **全是 `bot.openEnchantmentTable(block)` 挂上去的**（上游 `enchantment_table.js`）。

**第二个坑**：`bot.openBlock(block)` = `activateBlock` + `await once(bot,'windowOpen')` ⇒ **已经有窗口开着时
服务端会忽略这次使用，`openBlock` 直接挂死**（`inventory.js:405`）。所以不能无脑再开一次。

**改法**：`src\world-use.mjs` 新增 `enchantTable(self, args, ctx)`，`mc_act {mode:"enchant"}` 接上：
① 已经有"带助手的"附魔窗口就复用，别的窗口先 `closeWindow` 再 `openEnchantmentTable`；
② 槽 0 空就把手上那件（或 `item` 点名的那件）放进去（**手上那件的槽号要从窗口 0 的 36..44 平移到容器窗口的
`inventoryStart + 27 + 快捷栏序号`**）；③ 槽 1 空就从背包补一块青金石；④ 等三个选项到齐，报
「要 N 级经验 → 附魔名 等级」；给了 `option:0/1/2` 才真附魔，附完把附魔好的那件拿回背包、关窗口
（青金石关窗时服务端自己退回）。不给 `option` 就只看选项，**不动手**。

**回归**：临时冒烟 28/0（找台/坐标不对/没加载/只看选项/点名物品/槽 0 空/选项没到齐/越界 option/
复用窗口/关掉别的窗口/用 `activateBlock` 开的窗口要重开）；`node --check` ×3；mc_* 体积合计 17980/18000
（详见 `踩坑档案.md` 第 82 条）。

### 铁砧 / 锻造台：一个要 `openAnvil`，一个干脆没有助手（2026-10-13）

用户接着问"铁砧 锻造台都可以用吗"。查下来两个都**只能开窗、不能动手**：`src\block-names.mjs` 的
`CONTAINER_RE` 里早就有 `anvil`/`smithing_table`，所以 `mc_act {mode:"use"}` 能把窗口打开、能报
`{opened:"minecraft:anvil", slots:39}` —— 但窗口上什么都没有。

- **铁砧**：`combine`（合并/修复）和 `rename`（改名）是 `bot.openAnvil(block)` 挂上去的
  （上游 `mineflayer\lib\plugins\anvil.js`）—— 跟附魔台同一个坑。上游这两个助手会自己算经验、挑划算的方向、
  发 `MC|ItemName` 改名包、把成品 `putAway(2)` 拿出来，经验不够/合不了会直接抛错（不白扣等级）。
- **锻造台**：mineflayer **一个助手都没有**（`lib\plugins\` 里只有 `anvil.js`、`enchantment_table.js`）
  ⇒ 只能按槽位自己来：**槽 0 = 模板、槽 1 = 底座、槽 2 = 附加，成品在槽 3**（`minecraft:smithing`）。

**改法**：`src\world-use.mjs` 新增 `anvilTable(self, args, ctx)` 与 `smithingTable(self, args, ctx)`，
`mc_act {mode:"anvil"}` / `{mode:"smithing"}` 接上；三个共用助手抽在同一处：
`findWorkBlock`（坐标或 `findBlock` 半径 4 找台，matcher 只按 `.name`）、`openWorkWindow`（**已经开着同样类型、
且带所需助手的窗口就复用，否则先 `closeWindow` 再开** —— 附魔台那刀踩过的坑）、`winSlots`（窗口里"我的背包"
范围 + `findInv` + `heldSlot`：手上那件从 36..44 平移到 `inventoryStart + 27 + 序号`）。

- `{mode:"anvil", action:"combine", item:"iron_pickaxe", name:"iron_pickaxe"}` —— 两把合成一把更耐久的
  （上游不返回成品 ⇒ 从背包里挑"附魔最多、耐久最好"的那件同名物来报）。
- `{mode:"anvil", action:"rename", item:"diamond_sword", name:"屠龙刀"}` —— 改名（名字上限 35 个字，本地先拦）。
- `{mode:"smithing", item:"diamond_chestplate", name:"netherite_ingot"}` —— 模板没给就自己挑：优先
  `netherite_upgrade_smithing_template`，背包里只有一种纹饰模板时用它，**有多种就报错让 AI 点名 `template`**。

**回归**：临时冒烟 43/0（合并成功 / 上游抛错如实报 / 第二件没有 / 槽 0 空、改名成功 / 名字太长 / 抛错但背包里确实改了、
窗口复用 / 先关别的窗口 / 坐标不是铁砧 / 附近没有铁砧、锻造成功（模板→0 底座→1 附加→2、成品 `putAway(3)`、进背包）/
槽 3 一直空如实报失败、模板自己挑 / 多种模板要点名 / 没模板 / 点名了没有 / 没给 name / 坐标不是锻造台 /
手上那件当底座的槽位映射）；`node --check` ×5；mc_* 体积合计 **17973/18000**（加了两行 mode + `action`/`template`
两个参数，在 `mc_observe` 与 `mc_auto` 的描述上各瘦了一点）。详见 `踩坑档案.md` 第 83 条。

### 单次调用 ≤11 秒（宁可少量多次）

用户先要求"一次工具调用别超过 5 秒"，2026-10-08 又要求"把使用工具 5 秒的限制提高到 11 秒" ⇒
现在是 `CALL_MS = 11_000` / `CALL_BUDGET_MS = 10_000`。落点还是三条：**上限、进度、接着做**。

- **上限**：`core.mjs` 导出 `CALL_MS = 11_000`（硬上限）和 `CALL_BUDGET_MS = 10_000`（长动作默认预算，
  留 1 秒余量）；`callBudget(v)` 把任何传入值钳进 `[200, 10_000]`。`index.js` 的 `asTool` 每次 `execute`
  前调 `sess.bot.setCallDeadline(CALL_MS)`，并把每个工具的 `timeoutMs` 钳到 `CALL_MS + 1000`（DSH 层兜底）——
  例外只有 `LONG_TOOLS = ['mc_connect','mc_disconnect','mc_map','mc_kit_image']`（本来就慢）。
  运行期文案里的秒数用 `callSecText()` / `budgetSecText()` 现算，以后改上限不用再挨个改文案。
- **剩余时间**：`setCallDeadline(ms)` / `msLeft()` / `callLeft() = min(11_000, msLeft())`。
  长动作自己排 deadline 时用 `callLeft()`，这样 `mc_sequence` 里"先走 10 秒再搭"不会变成 10+11=21 秒。
  ⚠️ 别写 `this.msLeft() || CALL_BUDGET_MS` 或 `Number(ms) || CALL_MS`：本轮的 0 会被 `||` 当成"没给"
  而**再送 10 秒/11 秒**（真踩过，`check-call-budget.mjs` ⑨ 盯着它）。
- **到点带进度返回**：`walkTo` 报 `moved`/`remaining` + "这一轮的走路时间用完了（单次调用最多 10 秒），
  **不是走不通**：直接再叫一次 mc_move 往同一个目标走"；`runSequence` 给 `stoppedAt`/`remaining`/`hint`；
  `mc_build` 给 `remaining` + "同一个范围重发就行，放对的会跳过"；`mc_dig` 报挖到几个；
  `mc_furnace` 默认装好料就返回。
- **模型的活**：看到"这一轮用完了"就**再叫一次**（同一个参数），不要换目标、不要重连。
- **规则写在文件里，不注入正文**（用户 2026-10-08 要求）：这段"单次调用 ≤11 秒、一次只做一小步、
  到点用同样的参数再叫一次同一个工具"的话，写在 **`RULES.md`（行事准则）的 `## 不用替我省 token`** 里
  —— 每个 MC 会话开场都会收到**一行指针**（路径 + 读法），正文由会话自己去读，用户也能在「MC设置 → 提示词」里自己改
  （见上一节「规则放在文件里，会话自己去读」）。
  `src\agentsmd.mjs` 的 `DEFAULT_AGENTS_MD`（默认版）与记忆根现存的 `RULES.md` 都加了这条。
  ⚠️ 连接提示词（`src\connect-prompt.mjs`）**不再注入**这段规则（原先加过两句英文，已删）；
  版本提示（`src\version-prompt.mjs`）**只能有两条**（用户："别的属实多余了"），也没往那儿加。
  `selfcheck.mjs` 盯着：连接提示词里不许再出现这段规则、`DEFAULT_AGENTS_MD` 里必须有。
- **实机墙钟**（2026-10-06，真服 `127.0.0.1:25565`，复刻工具层的调法；**当时上限还是 5 秒**）：`walkTo` 目标 40 格远 +
  默认预算 → **4010 ms** 就返回（挪了 19.98 格、`reason: partial`）；`setCallDeadline(0)`（这一轮已经用完）
  之后再叫一次 → **196 ms** 秒返回，不会又白送时间。抬到 11 秒之后同一套调法的墙钟由
  `check-call-budget.mjs` ④ 盯着（默认预算 10 秒 → 墙钟 10 秒左右返回）。

### 省 token（上下文里最贵的几处）

用户 2026-10-07 说"优化一下 token 消耗"。先拿**真转写**量了一遍（`session-238258f4`，一局 **156 步**）：

| 项 | 数 |
| --- | --- |
| 计费当量 | ≈ **771,789** token（`cacheReadTokens` 6,877,952 × 0.1 = 89%） |
| 每步上下文 | 第 1 步 19,911 → 第 155 步 72,486（涨了 52,575） |
| 固定前缀 | 42 个工具的 JSON **30,706 字符 ≈ 11.8K token**（`mc_*` 占 22,595） |
| 最肥的结果 | `mc_status` 14 次 / **35,469 字符**（均 2,534）、`mc_entities` 3 次 / 7,887 |

**结论：成本 ≈ 上下文大小 × 步数**，而"上下文"里最贵的是**工具结果**（每次都要重读一遍）。

落点是"**宿主只认 `text`，没有 `text` 就把整个对象 pretty-print 成 JSON**"这条规则（`index.js` 的
`output.render`）——以前好几个工具返回的是对象，于是白花了一倍字符在键名、缩进和 `\n` 转义上：

- **`mc_status` 默认只回一行行文本**（在线/模式/坐标/朝向/血/食/手持/维度/时间 + 玩家 + 未读事件数 +
  看门狗一句 + 最近 3 条聊天截 70 字，自己说的标"我:"）。**2,400 → 约 400 字符/次**。
  要完整明细（连接信息、看门狗全部开关、最近 5 条聊天原文）传 `verbose:true`；前端 UI 走 `sessionView()`，不受影响。
- **`mc_entities`**（**2026-10-08 起已并进 `mc_observe` 的「程序检测到」**）：默认只列 24 个（`limit` 上限 64）；掉落物/鱼/箭这类"其它"按名字**合并成一行**
  （≥3 个才合，只留最近 3 个坐标），怪和玩家仍一只一行；**返回值只给 `{ text }`**（不再把原始实体数组几十行 JSON 塞进结果）。感知块里同样只列 16 个、同样合并，判据是同一份 `entities()`。
- **`mc_events` 一行一条**：`· [22:35:03] 聊天 **Bluezi**：你怎么不动了`（事件对象只有 `{at, kind, text, who?}`）。
- **`mc_map` 给 `text`**：以前没给 ⇒ 整对象 JSON 化（含 `legend` 数组 + `glyphMap` 全文的 `\n` 转义）。
- **自己说的话不再记两条**：`chatSay` 记一条 `self`，服务端回显又记一条 `player`（内容一字不差）。
  `#emitPlayerChat` 现在"2 秒内刚记过自己同一句话"就跳过回显那条。
- **回归护栏**：`tools/check-token-budget.mjs`（33 条）逐个工具量"描述 + 参数说明"的字符数（每个 ≤1,600、
  合计 ≤18,000，超了会红），并静态盯着上面那几条"别再用 pretty-print JSON 灌回来"的判据。
- **故意没动的**：工具描述本身（`mc_observe` 1,210 / `mc_auto` 1,298 字符）。它们是**行为规格**，
  是用户反复调出来的，删字换来的 token 远少于改坏行为的代价。想继续压就从"结果"和"少轮询"下手。
  （`mc_observe` 加 `image` 参数后描述 1,210 + 参数 355 = **1,565**，仍在上限 1,600 内。）

### 日志（本地时间 / 级别 / 去重 / 轮转）

实测主日志 1455 行里 **59.7% 是启动噪声**，而且时间戳是 UTC、没有版本标记、从不轮转。
按新规则拿同一份日志重算：**1473 行 → 624 行（−57.6%）**。

- **本地时间**：`stamp()` 打 `MM-DD HH:MM:SS`（原来 `toISOString()` 是 UTC，比本地早 8 小时、跨天看不出哪天）。
- **机器人短标签**：`McBot.log` 带 `auth.name` 前 12 字（`[dsh-mc-agent 10-06 23:34:07 DeepSeek]`）。
- **级别**：`MC_LOG_LEVEL=quiet|info|debug`（默认 `info`）。启动横幅（5 条 `已找到现成的…`）与每会话重打的
  账户/归档/模式/记忆播种/扩展加载行降级到 `debug`；失败行（`候选不可用…`）仍走 info（`logWarn` 分开）。
- **进程内去重**：`logOnce(key, …)`。🔴 必须挂 `globalThis` —— 每个 MC 连接都会重新 `import()` 一份
  `core.mjs`，模块级变量拦不住"每连接重打一遍"（`现成插件就绪` 原来 80 遍，`createUserMessage` 兜底 22 遍）。
- **轮转**：超过 `MC_LOG_MAX_BYTES`（默认 2 MB）改名成 `dsh-mc-agent.YYYY-MM-DD[-n].log`，只留最近
  `MC_LOG_KEEP`（默认 7）份；`selfcheck.mjs` 另外**截断**自己的 `logs\selfcheck.log`（原来一直追加到 1.2 MB）。
- **文案**：`⚠️ 挖 stone 超时（323ms）` 里的 323ms 其实是**本轮剩余预算**，现在分开写
  "这一轮的时间用完了（还剩 323ms）" / "超时（1500ms）"；`sub` 为空显示 `主服`；主动下线不再打
  「连接结束」+「已下线」两行；启动配置行带 `v0.2.0` 版本号。查问题：`MC_LOG_LEVEL=debug` 重连一次。

### 5 个现成依赖（不再自己写这些能力）

| `MC_DEPS` 键 | 包 | 接管了什么 | 接在哪 |
| --- | --- | --- | --- |
| `pathfinder` | mineflayer-pathfinder@2.4.5 | 寻路 / 防卡住 | `McBot.walkTo()`（见 PATHFINDER.md） |
| `collectBlock` | mineflayer-collectblock@1.6.0 | 走过去挖方块 + 捡掉落物 | `McBot.dig()` 优先交给它；`mc_auto` 的 `pickup` |
| `tool` | mineflayer-tool@1.2.0 | 按方块挑最好的工具 | `dig()` 退回原地挖时 `equipForBlock`；**包内打过补丁** |
| `pvp` | mineflayer-pvp@1.3.2 | 追击 + 近战节奏 | `McBot.attack({who})` |
| `autoEat` | mineflayer-auto-eat@5.0.3 | 饿了自动吃 | `mc_auto` 只按开关 enable/disable，事件进统计 |

`#movements()` 造的那份 `Movements` 同时给 pathfinder / collectBlock / pvp 用 —— 免得"我自己走不乱跳、
插件走就乱跳"。缺哪个只是少那项能力，其它照旧。

## 目录

```
index.js / selfcheck.mjs   宿主侧改动（记忆根、日志、版本号）与自检入口
src\core.mjs               McBot 内核（走路接 pathfinder、单次调用 ≤11 秒、日志基建…）
src\format.mjs             纯函数：lossless（无损 JSON）/ redactPath（家目录脱敏）/ resolveHarnessHome
src\block-names.mjs        纯函数：方块名判据（空气/液体/能穿过去/软顶）+ 地形图字形与配色（glyphOf/colorOf）+ 右键交互判据（CONTAINER_RE/TOGGLE_RE/canPlaceInto）
src\place-items.mjs         挑方块/垫脚料（读 bot 不改状态）：NON_FULL_BLOCK / isFullBlockItem / NO_SCAFFOLD / scaffoldingItemIds / pickPlaceItem
src\inventory.mjs           背包那一层（读 + 动）：heldText / invSnap / invUsed / canHarvestNow / toolKinds / countOf / freeSlot ＋ 第十九刀的动作 inventoryView（一览）/ giveItem / clearInventory / tossItem（后三个收 ctx = { t, makeItem }，要发包） ＋ 第三十二刀：`equipFor`（动手前换对的工具）
src\budget.mjs              单次调用的时间预算（纯常量+纯函数）：TIMEOUTS / CALL_MS / CALL_BUDGET_MS / callBudget / callDeadline / callSecText / budgetSecText
src\world-observer.mjs      只读观察（收 bot 当参数、只读不 await）：entityHealth / inWaterNow / slowDigWhy / dropsNear / dropHint / blockReachOf / stateNameOf
src\map-render.mjs          地图那一层（只读、同步、自带 2.5 秒软上限）：isUnderground / caveCell / heightmapOf / glyphMapText / mapImageOf
src\world-scan.mjs          感知的最后两块（收 bot 当参数、只读不 await）：scanAround（周围方块计数/点名，按距离升序）/ entitiesNear（附近有谁：分类/血量/远程/上下差）
src\status.mjs              连接/状态视图（收 bot + ctx、只读同步）：connectionViewOf（只给 host/port/subserver）/ statusOf（离线 ghost/reconnecting，在线坐标/朝向/生存/氧气/手持/在线时长）
src\dig-guard.mjs           采集/落地守卫（收 bot + ctx，收尾动作能失败就不抛）：collectBusy（后台采集任务还在吗）/ cancelCollect（停任务+松控制位，等不到就清队列）/ waitGrounded（空中挖慢 5 倍）/ withHeld
src\chat.mjs                聊天记录（收 bot + self、有可变实例状态）：wireChatEvents（签名/未签名两条路 + 按渲染形状兜底）/ plainText / playerChatFrom / emitPlayerChat（1.5 秒去重、自己的话不重复记）/ pushChat（按 cfg.chatHistory 截断） / chatSay（公屏说话；`/` 开头拒）
src\camera.mjs              朝向/相机（只吃一个 bot、不碰实例状态）：lookAnglesTo（点 → yaw/pitch）/ aimAt（直接写 entity.yaw/pitch，绕开会挂的 bot.lookAt）/ lookAt（坐标或 who：英文名/玩家名/中文别名，实体表没有就退回 b.players）
src\server-break.mjs        服务端破坏判决（只吃 bot + pos）：watchServerBreak（原始包 → 三态：真挖掉/复原/没证据）/ awaitServerBreak（等服务端的包，可以晚到约 1 秒；等的是服务端不是本地预测）
src\world-use.mjs            使用/交互（收 bot + ctx，要发包所以走 ctx）：useBlock（右键方块/实体：容器看窗口、门看属性翻没翻）/ useItem（对着空气用手上的东西：hold 最多 3 秒、给松手包留 400ms） / interact（look·place·break·toward 分流）/ equip（装备到手上）
src\attack.mjs              攻击（收 bot + ctx）：attack（谁：who 英文名/玩家名/中文别名，不给就打最近的 —— 敌对不限距、动物/玩家 4.5 格、掉落物垫底；打：pvp.attack 只是设目标，自己轮询等它消失，pvp.stop 不 await；回来报 killed/targetHealth/waitedMs + 掉落物提示）
src\sequence.mjs            连串动作的调度（收 self，要回调实例方法）：runSequence（预算/中断/从第几步续跑；不为没执行的步骤记账）/ runStep（op 分发：wait/move/look/toward/place/break/dig/use/useitem/attack/equip/give/toss/say/jump/swim）
src\pickup.mjs              捡掉落物（收 self + ctx）：grabDrops（按背包差报数；捡不到时显式 cancelCollect 收尾，不让采集任务挂着 —— 私有方法够不着，由 core 从 ctx 递进来）
src\task-report.mjs          任务收工报告（三种形状并存）：taskHave（看手里有几个）/ verdictLine（三态判决）/ taskSettle（统一判失败分类 + checkpoint + 进度行；进度本身由 dig 的成功点 add）；第四十二刀又并进任务门面（taskStart / taskList / taskGet / taskResume / taskNote / taskDone / taskCancel / taskForget 八个记账动作）
src\observer.mjs              世界观察器（整层）：invSignature（背包签名）/ observeTick（每秒产出 teleport·pushed·pickup·playerJoin/Leave）/ startObserver·stopObserver（定时器；回调自己兜异常，异常走 ctx.reportError）
src\plugins.mjs                vendor 依赖加载器：MC_DEPS（五个生态插件清单）/ loadMcDep（四路候选、只缓存成功）/ loadPathfinder / resetMcDepCache（core 里留同名 re-export）；第二十九刀起装配（setupPathfinder / movements / setupPlugins）也在这里
  src\connection.mjs             连接与保活层：connect / scheduleReconnect / disconnect（第三十一刀）
src\auth-session.mjs          认证/会话层（全插件唯一碰凭据的地方）：authOnly / makeSession / refresh / authenticate / normalizeBaseUrl
src\runtime.mjs               运行时管线（收 self + ctx）：reportError（唯一错误上报口）/ withBudget（超时闸门：abort signal + 本地 deadline）/ stopPathing（setGoal(null) 才真停）/ interruptMove（推号 + 停采集 + 松控制位）/ setAbortSignal（用户点停止 ⇒ 立刻真停） + holdControl/releaseControls（第四十一刀）；第四十三刀又并进 waitForChunks（等区块，算进本轮 11 秒）+ requireBot（要一个在线 bot，认得出幽灵在线）
src\build.mjs                 搭建那一层（收 self）：build（范围 → 坐标 → 逐个 placeBlock；只算复核过的 placed、跳过已占用、到点带着结果收手）
src\movement.mjs            移动原语（收 self + ctx）：jump（原地蹦一下，领号/只松自己的）/ swimUp（水里上浮换气，判据 inWaterNow） ＋ 第三十六/三十七刀的移动主体（walkSwim / walkTo / flyTo / walkPathfinder）
src\mining.mjs             挖掘那一层（收 self + ctx）：breakBlock（够不着/没落地/换不上工具/时间不够都不动手；服务端说"复原"就不报成功）+ dig（mc_dig 的正文：一条路走过去挖，服务端不认就如实说）
src\place.mjs               放置那一层（收 self + ctx）：placeRef（找依附面）+ placeBlock（够不着先走、悬空先垫脚、放完回读）
src\log.mjs                 日志基建（纯落盘）：stamp / logLevel / logLine / logDebug / logOnce（globalThis 判重）/ 轮转
src\entity-names.mjs        实体名字与分类（纯函数）：敌对/远程/掉落物名单、中文别名、entityNameOf/matchNameOf/pickEntity
src\async-util.mjs         异步叶子：sleep / withTimeout（超时带 mcTimeout）/ raceAbort（停止键真的生效）/ abortError
src\task-runner.mjs        可恢复的任务状态机（长活儿进度落 <记忆根>\tasks.json；只记账、不下发动作）
src\memory.mjs             记忆四分类 + 元数据（world/lessons/tasks/RULES，来源·更新·成功失败次数·适用版本·条件）
src\watchdog.mjs           看门狗（唤醒矩阵 wakeOn.anyChat）
extensions\                我加/改的 7 个扩展（改完重启 DSH 即生效）
  mc_util.mjs                                        共用件（不是扩展：物品/方块名与 id、countOf、放得下吗…）
  mc_observe.mjs / mc_view-render.mjs / mc_skin.mjs     第一人称截图 + 渲染内核 + 皮肤
  mc_auto.mjs                                        自主行动层（待机唤醒、长期目标、自保只叫醒不自己跑不还手、憋气叫醒）
  mc_craft.mjs / mc_furnace.mjs / mc_chest.mjs       合成 / 熔炼 / 存取箱子
tools\check-*.mjs          30 个离线自检套件 + check-all.mjs 入口（清单见上面「跑自检」）
tools\check-all.mjs        一条命令全跑完 + ✓/✗ 汇总表
实机验证\                  真服（127.0.0.1:25565 survival）脚本，跑的时候要服务器开着
  合成\   live-craft.mjs、live-craft-mixed.mjs（混木种不错料）
  熔炼\   live-smelt.mjs（**只测熔炉本体**：凑圆石→合熔炉→装料→等 14 秒→takeOnly 取成品→盯着烧完，约 40 秒）
          live-furnace.mjs + live-furnace.log（从零备料的长链路：徒手挖原木→木镐→挖圆石→自己放熔炉→烧木炭）
  存取\   live-chest.mjs + .log（挖原木→自己做箱子→存/取/全搬；收尾只拆自己放的箱子）
  搭方块\ live-place.mjs + .log（**13/0**：选料不挑按钮/垫脚名单只有整方块/真放一块再挖回来，净变化为零）
  采集收尾\ live-digcancel.mjs + .log（**9/0**：超时后控制位全松 + 采集任务真停）
  走路\   live-walk.mjs（**4/0**：1 格深沟 + 东边 1 格台阶，30 秒挪 1.27 格 → 1.5 秒走出去 6.63 格）
  用物品\ live-useitem.mjs + .log（**6/0**：真扔鸡蛋 ⇒ 6→5、5→4 + 投掷物实体；没可扔物时会喊话等玩家给）
  溺水\   live-swim.mjs + .log（**13/0**：挑 ≥2 格深的水 → 按住 sneak 沉下去 ⇒ `submerged=true`、反射层叫醒、
          `swimUp()` 从 y 59.88 浮到 62.82、`dig water` 被拒、收尾回到下水前的岸边）
  皮肤\   live-skin.mjs / skin-analyze.mjs / skin-look.mjs + 渲染样张
  自主\   live-auto5.mjs + 日志（待机唤醒、跟着玩家、递东西）
  打怪\   live-pve.mjs + live-pve.log（**真服真怪**：叫醒 AI 文案 / 位置 / "挨了打看不到怪"；边跑边写日志）
  攻击\   live-attack.mjs（**17/0**：`who:"cow"`/`"COW"`/`"牛"` 都追过去打到；**真打死一头牛**
          ⇒ `killed:true` 且实体表里真没了（`waitedMs` 6841ms）、`killed` 与实体表一致不谎报、
          找不到时列出半径内实际有谁、`connect({force:true})` 换新 bot 对象；收尾只多捡了牛的掉落物）
  地图\   live-map.mjs + .log（**16/0**：真服上地表自动给地表图、`mode:"cave"` 出洞穴层图、`slab:8` 读得到脚底下、
          128 格内找到 `cave_air`（地下判据有真数据支撑）；**不挖不放**，位移 0.00 格）
  背包\   live-inventory.mjs + .log（**14/0 + 1 跳过**：真配方下空背包 `mc_craft crafting_table` ⇒ 链条
          `crafting_table → oak_planks → oak_log` + "要同一种木头"；"正好 2 块木板"那段因为 128 格内没有原木跳过）
  挖方块\ live-dig.mjs + .log（**23/0 + 1 跳过**：`mc.dig` 10100ms/8711ms 内返回不冲工具超时、`{count}` 已够如实说
          "一个都没做"、`more:true` 真再做、2×2 合成格动手前清空、1300ms 预算 ⇒ **1ms 返回"我没开始挖"**、
          给足预算 5814ms 真挖掉、收尾 1/1 填回。**账号名可以当参数传**：`node live-dig.mjs wcdig_run5`
          —— 位置是存在服务端的，旧账号可能卡在坑里够不着树，换个新名字就回到出生点开阔地）
  复原包\ live-restore.mjs + .log（**11/0**：A 眼距 ≤4.5 必须报"服务端已确认"、B 眼距 4.6–5.0 的报告必须和
          `bot._client.on('packet')` 看到的**服务端判决**逐字一致、C 挖完立刻走 6 格必须真动 + 控制位松开 +
          没有僵尸采集任务。**账号名可以当参数传**：`node live-restore.mjs wcrestore_live4`）
  挖矿速度\ live-digtime.mjs（**8/0**：先在真服上凑一把**石镐**（木镐采不动铜/铁矿，上游那个 37500ms 是"挖不动"、
          补丁故意不修），再挑一块上游 `material` 写错的矿石，比 `bot.digTime` 与 `bot.__wcOrigDigTime`、
          听 `diggingCompleted` 的真实耗时、听 `bot._client.on('packet')` 判服务端认没认、看背包里有没有原矿。实测：石镐挖 `copper_ore` 上游 **4550ms → 修正 1302ms**，真挖完 **1311ms**、服务端 `block_change{type:0}` 在 **+1337ms** 到、1.5 秒后那格是 air（**没有复原**）、`raw_copper 0→9`。
          **账号名可以当参数传**）
  感知\   live-percept.mjs（**26/0**：默认三段式感知（我看到 / 程序检测到 / 不确定）、两套射线互相印证、
          程序侧实体走 `entities()`、`percept:false` 退回旧摘要、`entities:false` 两段都说"没收集实体"、
          PNG 真落盘。**实机抓到两个离线套件放过去的 bug**：裸 `bot.entities` 不是函数、`world.raycast` 必须喂真 Vec3）
  （recon-area.mjs 是侦察脚本：连上就把"周围有谁 + 附近资源 + 游戏内状态"打印一遍）
  视角\   第一人称截图样张
备份\                      回滚用（见下）
README.md / PATHFINDER.md / 踩坑档案.md
```

`备份\` 里：`core.mjs.原版`、`watchdog.mjs.orig`、`selfcheck.mjs.orig`、`dsh-mc-agent-src-config.mjs.orig`、
`dsh-mc-agent-index.js.orig`（打断硬链接前）、`dsh-mc-agent-index.js.before-session-memory`、
`RULES-自定义备份.md`（加「说话方式」前）、`readable-stream-补丁备份\`（7 个原文件）、
`pathfinder-补丁备份\`（两处补丁的成品，可直接还原）。

## 文档索引

| 文档 | 讲什么 |
| --- | --- |
| 本文件 | 装进去、跑自检、配置速查、我改了什么、各功能怎么用 |
| [踩坑档案.md](踩坑档案.md) | 83 个真 bug 的现象 → 根因 → 证据 → 修法 → 回归（"为什么现在这么写"） |
| [PATHFINDER.md](PATHFINDER.md) | 寻路/防卡住专题：为什么用现成的、装在哪、打过的补丁、上游复核、已知缺口 |
| [插件说明.md](插件说明.md) | **上游原版 README**（功能列表、配置键、命令行的完整说明） |
| `%USERPROFILE%\.dsh\profiles\desktop\vendor\mc-deps\README.md` | 那棵独立依赖树装了什么、重装后怎么体检 |
