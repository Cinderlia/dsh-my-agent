# 玩家操作 ↔ 工具映射

> 玩家在键盘鼠标上做的每件事，对应到本插件是哪个工具。**先在这里找，找不到再拆成原语。**

## 通用规则

| 玩家怎么做 | agent 怎么做 | 说明 |
|---|---|---|
| 走路/跑/跳 | `mc_move {x,y,z}` 或 `mc_navi {x,y,z}` | navi 是异步队列版（入队立刻返回，走完报告）；move 是同步的（最多 11 秒） |
| 走远路（>16 格） | `mc_navi` 分几段 / `mc_task` 记进度 | navi 单次上限 16 格 |
| 飞/游泳/开船 | `mc_move {mode:"fly"/"swim"/"boat"}` | 船的方向跟朝向走，不归 pathfinder 管 |
| 看/环顾 | `mc_look_at {x,y,z}` / `mc_observe` | observe 是截图 + 程序检测 |
| 挖一个方块 | `mc_dig {x,y,z}` | 自动换对工具；>4.2 格自动走过去 |
| 挖一片/一条线 | `mc_dig {mode:"column"/"line", …}` | 批处理，一次 10 秒 |
| 放一个方块 | `mc_place {x,y,z}` 或 `mc_interact` | 悬空会先垫脚 |
| 搭桥/搭墙/按图盖房 | `mc_build` / `mc_place {mode:"wall"/"volume"}` | 自动选料（三废石优先） |
| 合成 | `mc_craft {name, count}` | **只说要什么**；缺料/缺工作台它自己补 |
| 熔炼 | `mc_craft {name:"iron_ingot"}` 或 `mc_smelt` | 会找/放熔炉、精确放槽、等烧完 |
| 存/取箱子 | `mc_chest {action:"open"}` → `{action:"take"/"put", items:[…]}` | 两步：先看内容，再决定拿/存 |
| 丢东西 | `mc_toss {name, count, dir}` | 朝方向丢，立即执行 |
| 丢给玩家 | `mc_toss_to {name, count, player}` | 跟随到人身边、等他停下再丢 |
| 跟随玩家 | `mc_navi {player, follow:true}` | GoalFollow，跟到停下 |
| 打怪 | `mc_attack {who}` | 自动换武器、威胁评估、跳劈 |
| 射箭 | `mc_shoot {who}` 或 `{x,y,z}` | 自动算弹道 |
| 钓鱼 | `mc_fish` | 抛竿→盯浮标→咬钩收杆 |
| 锄地/播种 | `mc_interact {action:"hoe"/"plant"}` | 自动换锄头/种子 |
| 收菜 | `mc_act {mode:"farm"}` / `mc_collect` | 只收熟的、收完补种 |
| 繁殖动物 | `mc_interact {action:"breed", who:"cow"}` | 自动选食物、对两只各喂一次 |
| 剪羊毛/挤奶 | `mc_interact {action:"shear"/"milk"}` | 自动换剪刀/桶 |
| 上船/矿车/马 | `mc_interact {action:"board"}` | 走近 → 右键 → 确认坐上了 |
| 开关门/按钮 | `mc_interact {action:"open"/"toggle"}` | 门/栅栏门/按钮/拉杆/箱子 |
| 睡觉 | `mc_act {mode:"sleep"}` | 夜里才行（12541–23458） |
| 村民交易 | `mc_trade {action:"list"}` → `{action:"buy", index}` | 先看卖什么，再按序号换 |
| 附魔/铁砧/锻造 | `mc_station {kind:"enchant"/"anvil"/"smithing"}` | 走到方块、打开 UI、操作 |
| 吃东西 | 自动（被动层） | 饥饿 ≤17 自动吃；也可 `mc_act {mode:"useitem"}` |
| 和玩家说话 | `mc_say {message}` | 公屏 |
| 看地形 | `mc_map` / `mc_scan_surroundings` | 雷达是分类兴趣点；map 是字符地形图 |
| 看背包/状态 | `mc_self` | 坐标/血/饥饿/氧气/手持/背包/脚下 |
| 看事件/聊天 | `mc_events` / `mc_probe {what:"jobs"}` | 队列快照也在 probe 里 |

## 原语（手动方向盘，默认折叠）

`mc_control {on:true}` 才出现：

| 原语 | 干什么 |
|---|---|
| `mc_input` | 按/松移动键（forward/back/jump…） |
| `mc_apply` | 朝向 + 控制位一次提交 |
| `mc_look` / `mc_look_at` | 转视角 / 看向 |

**只在精确微调时用**（站到某个点、转个角度、跳一下）。长活交给队列工具。

## 常见坑（工具会替你做，但你要知道）

| 坑 | 工具怎么处理 |
|---|---|
| 没工具挖了不掉 | `collect`/`dig` 会检查 harvestTools，没有就插 craft 补（石质以下） |
| 背包满捡不起来 | 空格 ≤2 会预警；先 `mc_chest` 存点东西 |
| 悬崖/岩浆边 | `mc_input`/`mc_apply` 前进前会算摔落伤害并拦（`force:true` 才硬走） |
| 苦力怕贴脸 | killa 自动接管远离，不用你发指令 |
| 熔炉放料放错槽 | `smelt` 精确放输入槽 0 / 燃料槽 1 |
| 挖矿掉落没吸到 | collect 挖完等吸附，捡不到才插一次导航 |

## 长任务怎么拆

| 玩家目标 | agent 任务链 |
|---|---|
| 做一把铁镐 | `mc_craft {name:"iron_pickaxe"}`（一条命令，内部自己挖矿/熔炼/找工作台） |
| 造木屋 | `mc_build {layers, legend}` 或 先 `mc_collect` 材料再 `mc_place` |
| 开一片田 | 循环 `mc_interact {action:"hoe"}` → `{action:"plant"}` |
| 攒一箱圆石 | `mc_collect {name:"cobblestone", count:64}` 反复调用 |
| 夜间安全 | `mc_act {mode:"sleep"}` 或挖洞封口 |
