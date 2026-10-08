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
node tools\check-all.mjs                 # 全部 30 项（29 个套件 + selfcheck），最后给一张 ✓/✗ 表
node tools\check-all.mjs --fast          # 跳过 selfcheck
node tools\check-all.mjs --only mc_auto  # 只跑名字里带这段的
```

套件自己会收拾现场：建过临时目录的（`check-mc-auto`、`check-mc-view-host`）跑完就删，
想留现场加 `--keep`。（2026-10-08 发现 `check-mc-auto` 每跑一次往 `%TEMP%` 留 2 个
`mc-auto-mem-*`/`mc-auto-wsmem-*`，已经堆到 206 个，那次一起清了。）

单跑某一条也行（括号里是期望结果）：

```powershell
node tools\check-mc-craft.mjs            # 184/0（含"窗口事件丢了但东西到手了"不谎报失败、⑧ 合成窗口失步、缺料报链条、⑨ 一次只做一批会自己补上、⑩⑪ 挂了太久不悄悄开第二条链）
node tools\check-mc-furnace.mjs          # 267/267（含"取成品后背包晚 2.5 秒才同步也不谎报失败"、"放熔炉被拒就换点位重试"）
node tools\check-mc-chest.mjs            # 126/126
node tools\check-mc-auto.mjs             # 233/0（含 3.5 自保：被打了只叫醒 AI、不自己跑也不还手；3.6 憋气；3.7 busy 期间照样检测）
node tools\check-call-budget.mjs         # 139/139（单次调用 ≤11 秒 + ⑩ 移动抢占 + ⑩.5 别人的 goal_reached + ⑪ 领号/认中断/预算到点三件套：jump·swim·flyTo 的 abort 与抢占、收尾调 setGoal(null)、waitForChunks 上限、控制位租约、runSequence 的 wait 不谎报）
node tools\check-token-budget.mjs        # 32/0（省 token：描述/参数体积上限 + 结果不许回 pretty-print JSON + 真跑一遍 mc_status 默认视图）
node tools\check-core-place.mjs          # 73/0（选料只认整方块：火把/门/半砖/楼梯都不拿去搭）
node tools\check-core-entities.mjs       # 46/0（附近有谁：分类/排序/血量走现成助手/不看图门禁）
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
node tools\check-mc-view-host.mjs        # 72/0（默认=AI 自主；--gate-on 86/0）
node tools\check-mc-view-render.mjs      # 112/0（含手持物色块：带 xN 后缀也要认得出是什么）
node tools\check-mc-skin.mjs             # 78/0（含"坏响应不落盘、坏缓存删掉重下、失败 30 秒后可重试"）
node tools\check-mc-pathfinder.mjs       # 24/0（"走不动"的回归：贴墙穿模算碰撞、斜切拐角禁掉）
node tools\check-watch-chat.mjs          # 21/21（"我打的字它看不到"的回归：旁观模式靠 anyChat 兜底）
node tools\check-audit-session.mjs       # 44/0（会话/状态层审计 F1–F12：自动重连真的连得上、满 200 条也能等到新事件、幽灵在线不再报 online:true、注入失败会留话）
node tools\check-logging.mjs             # 52/52（本地时间/级别/进程内去重/轮转 + 旧噪声不许回潮）
node tools\check-mc-deps.mjs             # 9/0（**给 vendor 树 npm install 之后必跑**）
node selfcheck.mjs                       # exit 0；**任何 ❌ 就 exit 1**（2026-10-08 起）
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
| `<memoryDir>\RULES.md` | 行事准则（游戏内 AI 自己读；含「说话方式」「打怪与保命」「工具速查」「省算力」等节；**单次调用 ≤11 秒、到点再叫一次同一个工具**这条规则也在这儿）。2026-10-08 重写过一次：**内置默认与记忆里这份是同一份文本**了（以前分叉，点「恢复默认」会丢节） |
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
| `src\watchdog.mjs` | 唤醒矩阵新增 `wakeOn.anyChat`（默认开，任何玩家说话都叫醒）；掉血提醒里补一句"我在水里：可能是憋气"；**注入失败会留话**（打断只在注入成功之后做，失败走 `#injectFailed` 写进 `mc_events`）；被闸门挡下的唤醒真的记进 `stats.suppressed`；`LABEL` 补 `disconnect` |
| `index.js` | 记忆根/按会话分（含打断硬链接）；**规则只投一行指针**（`rulesPointerText()`：`RULES.md` 与 `版本提示.md` 的正文都不再进提示词，会话自己去读）；`/api/mc/agents-md` 支持 `target:"version"` 改版本提示文件；启动行带版本号；噪声降级 + `logOnce` 去重；`mc_entities` 参数与输出补强（**没有另开 `mc_mobs`**）；`mc_act` 加 `useitem`（对着空气用手上的东西：扔眼睛/射箭/喝药水）；**`mc_act` 的 `break`/`place` 与 `mc_move`/`mc_build`/`mc_dig` 描述里写明会自动换工具、结果带 `held`/`used`/`pillaredWith`**；`mc_move` 加 `mode:"swim"`（**给坐标=游过去，不给=只上浮**）；**`mc_map` 在地下自动切洞穴层**（`mode`/`slab`，顺手修掉图例一直打 `[object Object]`）；**省 token**：`mc_status`/`mc_entities`/`mc_events`/`mc_map` 默认只回紧凑文本；**会话/状态层审计（F1–F12）**：事件带单调 `seq`（队列满 200 条也能等到新事件）、`peek` 与消费同方向、`mc_diag` 不再在幽灵在线时报 `online:true`、`mc_ping` 回传生效超时、`mc_lan` 会报 warning、`mc_config` 只读不挂看门狗、`mc_disconnect` 三态、`mc_capabilities` 的路径脱敏成 `$DSH_HOME/...` |
| `src\version-prompt.mjs` | 版本提示从"硬编码字符串"变成**记忆根里的真文件 `版本提示.md`**（读/写/恢复默认/按版本同步；用户能在设置页直接改） |
| `src\agentsmd.mjs`、`src\protected.mjs`、`src\wsconfig.mjs` | 行事准则文件（`RULES.md`，2026-09-16 从 `AGENTS.md` 改名，免得被宿主当指令文件投两遍）；受保护文件名单加了 `版本提示.md`；工作区配置多了 `versionPromptVersion` 标记 |
| `selfcheck.mjs` | 跑之前截断自己的 `logs\selfcheck.log`；**任何 ❌ 就 exit 1**（以前永远 exit 0，❌ 会静默腐烂） |
| `extensions\mc_view.mjs`、`mc_view-render.mjs`、`mc_skin.mjs` | 第一人称截图（门禁默认关，AI 自主决定何时看）、纯函数渲染内核、皮肤下载/解码/UV 采样 |
| `extensions\mc_auto.mjs` | 自主行动层：待机唤醒、长期目标、**被打了只叫醒 AI 定策略（不自己跑也不还手）**、**在水里憋气（头在水下）也叫醒 AI 上浮**、反射层换成现成插件 |
| `extensions\mc_craft.mjs`、`mc_furnace.mjs`、`mc_chest.mjs` | 合成（掐断后自动关窗口把材料收回背包、**动手前把 2×2 合成格里的东西点回背包**、同一个 bot 不并行两条合成链、**缺料时报整条链条 + "要同一种木头"**、`count` 已经够了就如实说"一个都没做"（`more:true` 才是"再做 N 个"））、熔炼（按数量挑正经燃料、装好料就返回）、存取箱子 |
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

`mc_view` 的门禁**机制保留、默认不生效**：门禁总是注册、每次判定时现算，所以
`view.json` 写 `{"gate":true}` 就能当场变回强制模式（不用重启）。强制模式下的尺度是
"看一眼可做 N 个动作 / T 秒"（默认 4 个 / 60 秒）。叫醒文案里 `mc_view` 写成"需要就看一眼"，不强制。

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

### 看得见附近有谁（`mc_entities`：怪/玩家/生物在哪、多少血）

以前 AI 想知道"骷髅在哪"只能靠 `mc_view` 看截图，或者用 `mc_scan` 扫方块 —— 实体没有正经出口。
上游**本来就有** `mc_entities`（`bot.entities(radius)`），但只给"名字 / 类型 / 坐标 / 距离"；
这次**就地把它补强，没有另开平行工具**（两个重叠的工具只会让模型挑花眼）。
**不用自己算**：mineflayer 内核本来就把周围实体放在 `bot.entities`（服务端 spawn / teleport /
relative-move 包喂进去的），每条都带 `.name`/`.position`/`.kind`/`.metadata`；这里只是"读出来 +
分类 + 排序 + 截断"的薄封装。

- 工具：`mc_entities {radius, kind, limit}` —— `kind` 取 `all`/`hostile`/`player`/`mob`，`radius` 默认 24
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
  还会把**上次看到它在哪**报上去，并让它用 `mc_entities {"kind":"hostile","radius":48}` 自己定位。
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
   是注册表里的 `'player'`（分不清谁是谁），怪的中文名根本不在字段里，`mc_entities` 显示的名字和
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
  （动物/玩家仍限 4.5 格内 —— 不然会跑 6 格去揍玩家拴着的马）；`mc_entities` 里玩家显示 `username`
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

- **动手前换对工具**：`breakBlock()` 先调 `#equipFor()` —— 手上这叠能挖就直接挖（`#canHarvestNow()`），
  否则交 `mineflayer-tool` 的 `equipForBlock(blk, {requireHarvest:false})` 从背包里换一把；换工具发生在 `dig` **之前**。
- **换不上就直接拒绝**：`手上是 dirtx18，挖 stone 需要镐 —— 背包里也没有能挖它的东西。先 mc_craft 一把
  （木镐 = 3 木板 + 2 木棍）… 硬挖会一直超时。`（`#toolKinds()` 把 `pickaxe` 翻成人话"镐"）——
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
4. `equip` 读回 `#heldText(b)` 并比对 `b.heldItem.name`；`dig` 兜底分支复核过才写"挖掉"；
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
`check-mc-view-render` **109/0 → 112/0**、`check-mc-view-host` **67/0 → 72/0**、
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
  熔炉老是忘了带。一开始挖的木头不够多，老是上去砍木头"）：**挖完/打完先捡东西**（`mc_entities` 看 `item`
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
  到点用同样的参数再叫一次同一个工具"的话，写在 **`RULES.md`（行事准则）的 `## 省算力`** 里
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
- **`mc_entities`**：默认只列 24 个（`limit` 上限 64）；掉落物/鱼/箭这类"其它"按名字**合并成一行**
  （≥3 个才合，只留最近 3 个坐标），怪和玩家仍一只一行；**返回值只给 `{ text }`**（不再把原始实体数组几十行 JSON 塞进结果）。
- **`mc_events` 一行一条**：`· [22:35:03] 聊天 **Bluezi**：你怎么不动了`（事件对象只有 `{at, kind, text, who?}`）。
- **`mc_map` 给 `text`**：以前没给 ⇒ 整对象 JSON 化（含 `legend` 数组 + `glyphMap` 全文的 `\n` 转义）。
- **自己说的话不再记两条**：`chatSay` 记一条 `self`，服务端回显又记一条 `player`（内容一字不差）。
  `#emitPlayerChat` 现在"2 秒内刚记过自己同一句话"就跳过回显那条。
- **回归护栏**：`tools/check-token-budget.mjs`（32 条）逐个工具量"描述 + 参数说明"的字符数（每个 ≤1,600、
  合计 ≤18,000，超了会红），并静态盯着上面那几条"别再用 pretty-print JSON 灌回来"的判据。
- **故意没动的**：工具描述本身（`mc_view` 1,286 / `mc_auto` 1,298 字符）。它们是**行为规格**，
  是用户反复调出来的，删字换来的 token 远少于改坏行为的代价。想继续压就从"结果"和"少轮询"下手。

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
src\watchdog.mjs           看门狗（唤醒矩阵 wakeOn.anyChat）
extensions\                我加/改的 7 个扩展（改完重启 DSH 即生效）
  mc_util.mjs                                        共用件（不是扩展：物品/方块名与 id、countOf、放得下吗…）
  mc_view.mjs / mc_view-render.mjs / mc_skin.mjs     第一人称截图 + 渲染内核 + 皮肤
  mc_auto.mjs                                        自主行动层（待机唤醒、长期目标、自保只叫醒不自己跑不还手、憋气叫醒）
  mc_craft.mjs / mc_furnace.mjs / mc_chest.mjs       合成 / 熔炼 / 存取箱子
tools\check-*.mjs          29 个离线自检套件 + check-all.mjs 入口（清单见上面「跑自检」）
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
| [踩坑档案.md](踩坑档案.md) | 40 个真 bug 的现象 → 根因 → 证据 → 修法 → 回归（"为什么现在这么写"） |
| [PATHFINDER.md](PATHFINDER.md) | 寻路/防卡住专题：为什么用现成的、装在哪、打过的补丁、上游复核、已知缺口 |
| [插件说明.md](插件说明.md) | **上游原版 README**（功能列表、配置键、命令行的完整说明） |
| `%USERPROFILE%\.dsh\profiles\desktop\vendor\mc-deps\README.md` | 那棵独立依赖树装了什么、重装后怎么体检 |
