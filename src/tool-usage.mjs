/**
 * 工具接口约定：`{name: {用法, 效果, 注意}}`
 * ============================================================================
 * 🔴 2026-10-26 用户定的规矩：「每个工具增加一个 describe 属性，介绍工具的用法，而不是让 agent 去翻文档。」
 *    所以**接口就写在工具自己的 description 里** —— 模型每轮都能看到，不用去 kb/ 翻。
 *    `asTool` / `asPrimitive` 在构造时统一追加下面这三段（见 index.js），
 *    没登记的工具原样返回（不会报错，只是少这几段）。
 *
 * 写的时候守两条：
 *   ① **用法**给一句能直接抄的调用（参数怎么写、哪些必填）；
 *   ② **效果**说清"会发生什么、返回什么、什么时候会失败"——比"干什么"有用得多。
 * 别在这里重复工具名已经说过的废话。
 * ============================================================================
 */

export const TOOL_USAGE = {
  /* ── 看 ── */
  mc_status: {
    用法: '`{}` 不传参数',
    效果: '回一行文本：在线/坐标/朝向/血量/饥饿/手持/模式/看门狗状态 + 最近 3 条聊天。要全明细传 `{verbose:true}`（很长）',
  },
  mc_self: {
    用法: '`{}`',
    效果: '一行摘要：坐标、血、饥饿、手持、脚下方块、背包堆数 —— 最省 token 的"我现在怎么样"',
  },
  mc_inventory: {
    用法: '`{}`',
    效果: '完整清单：背包每一叠 + 装备栏 + 副手 + 手持（比 mc_self 细，也贵）',
  },
  mc_observe: {
    用法: '`{}` 出图；`{percept:false,out:"路径.png"}` 只存图不分析',
    效果: '给一张第一人称重建图 + 一段"看到了什么"的结论 + 程序射线检测（准星压在哪个方块、几格）。方块数据是本地镜像，会晚一拍，别当唯一依据',
  },
  mc_map: {
    用法: '`{}` 脚下方块那层；`{mode:"sides"}` 看剖面孔；`{mode:"column",target:"x,y,z"}` 看一根柱子',
    效果: '字符地形图：能看出实心/坑/岩浆/未加载、以及高度差。**建房子先用它量地面高度**',
  },
  mc_scan_surroundings: {
    用法: '`{focus:"build"|"danger"|"ore", r:32}`',
    效果: '分类的兴趣点雷达（分层、带方向与距离），不是全量方块表；默认取"当前在干什么"相关的类别',
  },
  mc_events: {
    用法: '`{}` 取走并清空',
    效果: '看门狗记下来的事件（聊天/受伤/上线/死亡/重连/断线），一条一行',
  },

  /* ── 动 ── */
  mc_navi: {
    用法: '`{x,y,z}` 或 `{player:"名字", follow:true}`',
    效果: '**入队后立刻返回**（job id + 计划），后台自己走过去，走完/失败主动报告；单次 16 格内，路被堵会自己挖/垫',
  },
  mc_move: {
    用法: '`{x,y,z}`；`{mode:"fly"}` 创造直飞；`mode:"swim"|"boat"`',
    效果: '**同步阻塞**，最多约 11 秒返回（到了/没到/被挪走）；目标太远直接报"太远"，长距离请用 mc_navi 分段',
  },
  mc_dig: {
    用法: '`{name:"stone"}` 挖最近的；`{x,y,z}` 挖指定格；`count` 连挖几个',
    效果: '自动换对工具、超过 4.2 格自己走过去、掉的东西**不负责收**（要收用 mc_collect）',
  },
  mc_place: {
    用法: '`{x,y,z,name}` 放一块；`{mode:"wall"|"volume"}` + 范围批量',
    效果: '悬空会先垫脚；返回放了几块、被什么挡住',
  },
  mc_build: {
    用法: '`{x1,y1,z1,x2,y2,z2,name}` 实心盒；或 `{blueprint:"layers", origin, layers:[...], legend:{P:"oak_planks"}}`',
    效果: '自己走近+垫脚逐格放，**每轮最多 10 秒**；没盖完把同一份蓝图原样再发一次就接着盖（会跳过已有的）',
  },

  /* ── 手 ── */
  mc_collect: {
    用法: '`{name:"iron_ore", count:8}` —— name 可以是方块名，也可以是掉它的物品名',
    效果: '入队即返回；自己找→走过去→挖→确认捡到（没捡到会走过去捡、捡不到再挖下一处），背包真多了才算成功，附近目标挖光才报失败',
    注意: '合成品/工具别用它，用 mc_craft',
  },
  mc_craft: {
    用法: '`{name:"iron_pickaxe", count:1}` —— 只说要什么，不用先查背包',
    效果: '本地算合成链：缺料自动插 collect、缺工作台自动找/放（做完回收）、缺熔炉自动补；材料凑不齐会明确报失败',
  },
  mc_smelt: {
    用法: '`{name:"iron_ingot", count:3}`（按**产物**点单）',
    效果: '自己找/放熔炉、精确放燃料与原料、等烧完再收；燃料/矿石不够会报',
  },
  mc_interact: {
    用法: '`{action:"plant", x,y,z}`；action 可为 hoe/plant/breed/shear/milk/board/open/toggle',
    效果: '找目标→走过去→换对该用的东西→右键；目标找不到会直说',
  },
  mc_act: {
    用法: '`{mode:"farm"|"sleep"|"useitem"|"equip"}`',
    效果: '成系列的动作：farm 只收熟的不补种前先收、sleep 只在夜里生效、equip 换装备',
  },
  mc_chest: {
    用法: '先 `{action:"open"}` 看内容，再 `{action:"take"|"put", items:[{name,count}]}`',
    效果: '一趟只办一件事；箱子满/东西不够会报',
  },
  mc_trade: {
    用法: '`{action:"list"}` 看村民卖什么，再 `{action:"buy", index:0}`',
    效果: '按序号交易；钱不够或货没了会报',
  },
  mc_station: {
    用法: '`{kind:"enchant"|"anvil"|"smithing", ...}`',
    效果: '走到对应方块、开界面、按你说的点；等级/材料不够会报',
  },
  mc_shoot: {
    用法: '`{who:"zombie"}` 或 `{x,y,z}`',
    效果: '自动换弓、算弹道、拉满再放；射完报身边还有谁',
  },
  mc_attack: {
    用法: '`{who:"zombie"}`，24 格内会追',
    效果: '自动换武器、跳劈、威胁评估；打完报结果与血量',
  },
  mc_fish: {
    用法: '`{count:1}`',
    效果: '抛竿→盯浮标→咬钩收竿；没咬钩会重抛',
  },
  mc_toss: {
    用法: '`{name, count, dir}`',
    效果: '朝指定方向丢，立即执行',
  },
  mc_toss_to: {
    用法: '`{name, count, player:"名字"}`',
    效果: '先跟到人身边、等他停下再丢；人不在线会报',
  },
  mc_say: {
    用法: '`{message:"…"}`',
    效果: '公屏说话，所有在线玩家可见（会被 echo 回自己的事件里）',
  },

  /* ── 自主 / 生存 ── */
  mc_sequence: {
    用法: '`{steps:[{tool:"mc_place", args:{…}}, …]}`',
    效果: '按顺序执行一串世界交互，某步失败就停并报是哪步',
  },
  mc_give: {
    用法: '`{name:"diamond", count:1}`（创造模式）',
    效果: '协议级塞进背包，不走 /give，非 OP 也能用',
  },
  mc_prep: {
    用法: '`{for:"nether"|"end"}`',
    效果: '数真状态（装备/附魔/食物/黑曜石/末影之眼…）并列出缺什么',
  },

  /* ── 队列与身体 ── */
  mc_stop: {
    用法: '`{}`；`{offline:true}` 停完直接下线',
    效果: '中断正在跑的动作 + 清空后台任务队列，之后可以重新下令',
  },
  mc_interrupt: {
    用法: '不给 action 只冻结看一眼；`{action:"retry"|"skip"|"cancel"|"resume"}`',
    效果: '冻结队列并停掉队首，随后只能看到感知类工具；**冷却 60 秒**，通常不需要用（队列会自己跑完并报告）',
  },
  mc_task: {
    用法: '`{action:"list"}`；`{action:"note", text:"…"}`',
    效果: '长活进度台账，存记忆根 tasks.json，掉线重连还在',
  },

  /* ── 手动方向盘（折叠在原语里） ── */
  mc_control: {
    用法: '`{on:true}` 展开、`{on:false}` 收起',
    效果: '打开后才把 mc_input/mc_apply/mc_look/mc_swing 放进工具面（只在精确微调时用）',
  },
  mc_input: {
    用法: '`{forward:true}` / `{jump:true, forward:true, ms:300}`',
    效果: '按住/松开移动键；悬崖边会先算摔落伤害并拦（`force:true` 才硬走）',
  },
  mc_apply: {
    用法: '`{yaw, pitch, input:{forward:true}}`',
    效果: '朝向 + 控制位一次提交，立即生效',
  },
  mc_look: {
    用法: '`{yaw, pitch}`',
    效果: '转视角（不改位置）',
  },
  mc_look_at: {
    用法: '`{x,y,z}`',
    效果: '看向某个坐标',
  },

  /* ── 环境 / 账户 / 诊断 ── */
  mc_connect: {
    用法: '`{host:"示例.com", port:25565}`；版本不填就自动探测',
    效果: '连上后等区块加载完才返回；登录失败会明说"需要用户处理"（密码只有用户能填）',
  },
  mc_disconnect: {
    用法: '`{}`',
    效果: '优雅退出游戏，看门狗自动关闭并提醒',
  },
  mc_accounts: {
    用法: '`{action:"list"}`；`{action:"use", innerID:"acc-…"}`',
    效果: '看有哪些账户/切账户/刷新登录态；**永远拿不到密码或 token**',
  },
  mc_watch: {
    用法: '`{}` 看状态；`{wakeOn:{chat:true}, mentionPatterns:[…]}` 配置',
    效果: '唯一的事件通知通道，进服自动挂载、退服自动卸载',
  },
  mc_config: {
    用法: '`{}` 看；`{set:{…}}` 改',
    效果: '本会话的 MC 配置（唤醒条件、心跳间隔、近距半径…）',
  },
  mc_command: {
    用法: '`{command:"time set day"}`',
    效果: '以玩家身份发服务器指令（走白名单）；会挪人的指令（tp 等）发完会打断在飞的移动',
  },
  mc_probe: {
    用法: '`{what:"diag"|"inventory"|"scan"|"prep"|"caps"|"sessions"|"ping"|"lan"|"jobs"|"debug"|"poi", args:{…}}`',
    效果: '偶尔查一次的杂项都从这里进；**看任务队列/后台任务用 `{what:"jobs"}`**',
  },
  mc_diag: {
    用法: '`{only:"state"|"perf"|"crafting"|"prompt"…}`',
    效果: '内部状态/性能/提示词注入；不带 only 输出很大',
  },
  mc_capabilities: {
    用法: '`{}`',
    效果: '支持的 MC 版本、mineflayer 版本、各种上限',
  },
  mc_ping: {
    用法: '`{address:"主机:端口"}`',
    效果: '只做 STATUS ping：通不通、版本、协议号、MOTD、人数（不连接）',
  },
  mc_sessions: {
    用法: '`{}`',
    效果: '列出本机所有活跃 MC 会话（诊断谁连着）',
  },
  mc_blocks: {
    用法: '`{name:"oak_log", radius:16}`；不给 name 就给占比',
    效果: '扫周围方块并给坐标；半径越大越慢',
  },
  mc_entities: {
    用法: '`{radius:16}`',
    效果: '周围实体列表（种类、距离、血量若可读）',
  },
  mc_scan: {
    用法: '`{radius:16, height:4}` 看占比；`{name:"oak_log", radius:16}` 找它在哪',
    效果: '扫周围方块：竖窗以脚底为中心 ±height，看高处传 `y` 指定中心；半径越大越慢',
  },
  mc_block: {
    用法: '`{x,y,z}` 绝对坐标，或 `{dx,dy,dz}` 相对脚底格；`{name:"stone"}` 只判"是不是这种"',
    效果: '读本地镜像的这一格，立即返回；读不到 = 那格没加载（不是空气）',
  },
  mc_swing: {
    用法: '`{}`',
    效果: '只发一次挥手臂动画，不判定命中；要真打怪用 mc_attack',
  },
  mc_lan: {
    用法: '`{seconds:5}`',
    效果: '只听局域网公告（224.0.2.60:4445），拿到地址+端口+MOTD；只读、不连接',
  },
  mc_admin_config: {
    用法: '`{action:"get"|"set"|"unset"|"reset"|"list", path:"mcMode.allowOtherTools", value:true}`',
    效果: '读写全局配置（指令白名单、MC 模式工具暴露、记忆目录…）；MC 模式会话里调不动，要在普通/MC+ 模式改',
  },
  mc_kit_memory: {
    用法: '`{action:"read", path:"RULES.md"}`；`{action:"record", kind, key, text}`',
    效果: '长期记忆（跨会话），存 .dsh-mc-agent/；`index` 看总览',
  },
  mc_kit_image: {
    用法: '`{action:"render", svgPath:"x.svg", out:".dsh-mc-agent/.express/a.png"}`',
    效果: 'SVG→PNG / 拼网格 / 存盘；要给用户看就写到 .express/',
  },
  mc_kit_express: {
    用法: '`{path:".express/x.png"}`',
    效果: '把发布区文件换成链接；分享开关关着时只回绝对路径',
  },
}

/**
 * 把上面那段接口说明贴到 description 后面。没登记的工具原样返回。
 * 顺序固定：原文 → 用法 → 效果 → 注意，模型读起来像一张小卡片。
 */
export function withUsage (spec) {
  const u = spec?.name ? TOOL_USAGE[spec.name] : null
  if (!u || !spec.description) return spec
  const lines = [spec.description, '', `**用法**：${u.用法}`, `**效果**：${u.效果}`]
  if (u.注意) lines.push(`**注意**：${u.注意}`)
  return { ...spec, description: lines.join('\n') }
}
