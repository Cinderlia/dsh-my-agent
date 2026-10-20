/* 服务器指令目录 —— 给「MC设置 → 指令白名单」画那一排开关用。
 *
 * 🔴 **这里只有"名字 + 说明"**：放不放行一律由 `src/config.mjs` 的 `commandAllowed()` 说了算。
 *    在这份文件里再抄一遍匹配逻辑就等于有了两个真相 —— 2026-10-15 那份"危险方块名单
 *    抄了两遍、抄漏了灵魂火"的教训（踩坑档案第 103 条）就是这么来的。
 *    所以 `index.js` 的 `configView()` 逐条调 `pluginConfig.commandInList(name)` 算出 `on`
 *    再下发；客户端只管画，不判。
 *
 * `danger: true` = 会**不可逆地**影响世界、服务器或别人（`op` / `ban` / `stop` …）。
 * 列出来是为了"看得见、能一眼扫到"，**不是**为了默认放行 —— 默认白名单很短，
 * 见 `src/config.mjs` 的 `DEFAULT_CONFIG.commandWhitelist`。
 *
 * 名单按 Java 版 1.21 的 `/help` 整理（不含需要数据包/模组才有的）。少写了不要紧：
 * 设置页会把白名单里"不在目录里"的条目**单独列出来**，不会静默丢掉。
 */
export const COMMAND_GROUPS = [
  {
    group: '移动 / 传送',
    items: [
      { name: 'tp', desc: '把谁传送到坐标或某个玩家身边' },
      { name: 'teleport', desc: '同 tp（完整名）' },
      { name: 'spreadplayers', desc: '把一群玩家随机分散到一片区域' },
      { name: 'spectate', desc: '用旁观视角跟着某个实体看' },
    ],
  },
  {
    group: '物品 / 经验',
    items: [
      { name: 'give', desc: '给玩家物品' },
      { name: 'clear', desc: '清空玩家背包（不写物品就是全清）' },
      { name: 'enchant', desc: '给手上的物品附魔' },
      { name: 'xp', desc: '给玩家经验' },
      { name: 'experience', desc: '同 xp（完整名）' },
      { name: 'loot', desc: '按战利品表把东西给玩家或塞进容器' },
      { name: 'recipe', desc: '给 / 收回配方' },
    ],
  },
  {
    group: '方块 / 世界',
    items: [
      { name: 'setblock', desc: '在某一格放一个方块' },
      { name: 'fill', desc: '用方块填一片区域' },
      { name: 'clone', desc: '把一片区域复制到另一处' },
      { name: 'fillbiome', desc: '改一片区域的生物群系' },
      { name: 'summon', desc: '生成一个实体（生物 / 掉落物 / 盔甲架…）' },
      { name: 'kill', desc: '杀死实体（不写目标就是自己）', danger: true },
      { name: 'weather', desc: '改天气（晴 / 雨 / 雷）' },
      { name: 'time', desc: '改或查时间（白天 / 夜晚 / 具体刻度）' },
      { name: 'difficulty', desc: '改游戏难度', danger: true },
      { name: 'gamerule', desc: '改游戏规则（死亡掉落、昼夜循环…）', danger: true },
      { name: 'forceload', desc: '强制加载 / 卸载区块', danger: true },
      { name: 'place', desc: '放置结构或地物（村庄、矿脉、树…）' },
      { name: 'locate', desc: '找最近的结构 / 生物群系' },
      { name: 'seed', desc: '看世界种子' },
      { name: 'setworldspawn', desc: '设置世界出生点' },
      { name: 'worldborder', desc: '改世界边界', danger: true },
    ],
  },
  {
    group: '玩家状态',
    items: [
      { name: 'gamemode', desc: '改游戏模式（生存 / 创造 / 冒险 / 旁观）' },
      { name: 'effect', desc: '加 / 去掉状态效果' },
      { name: 'spawnpoint', desc: '设置某个玩家的重生点' },
      { name: 'damage', desc: '对实体造成伤害' },
      { name: 'attribute', desc: '改实体属性（血量上限、攻击力…）' },
      { name: 'tag', desc: '给实体加 / 删标签' },
      { name: 'ride', desc: '骑上 / 离开载具' },
      { name: 'advancement', desc: '给 / 撤回进度（成就）' },
      { name: 'trigger', desc: '触发计分板触发器' },
    ],
  },
  {
    group: '说话 / 显示',
    items: [
      { name: 'say', desc: '全服广播一句话（显示成 [Server]）' },
      { name: 'tell', desc: '私聊某个玩家' },
      { name: 'msg', desc: '同 tell（完整名）' },
      { name: 'w', desc: '同 tell（最短名）' },
      { name: 'me', desc: '以第三人称说一句（* 谁 做了什么）' },
      { name: 'tellraw', desc: '给玩家显示一段 JSON 文本' },
      { name: 'title', desc: '显示标题 / 副标题 / 动作栏' },
      { name: 'playsound', desc: '播放一个音效' },
      { name: 'stopsound', desc: '停止音效' },
      { name: 'particle', desc: '生成粒子效果' },
      { name: 'bossbar', desc: '管理屏幕顶上的 Boss 血条' },
      { name: 'scoreboard', desc: '管理计分板（分数、显示位）' },
      { name: 'team', desc: '管理队伍（颜色、前缀、友伤）' },
      { name: 'display', desc: '改实体的名字 / 名牌（1.19.4+）' },
    ],
  },
  {
    group: '玩家管理 / 服务器',
    items: [
      { name: 'list', desc: '列出在线玩家' },
      { name: 'kick', desc: '把玩家踢出服务器', danger: true },
      { name: 'ban', desc: '封禁玩家', danger: true },
      { name: 'ban-ip', desc: '封禁 IP', danger: true },
      { name: 'banlist', desc: '查看封禁名单' },
      { name: 'pardon', desc: '解封玩家', danger: true },
      { name: 'pardon-ip', desc: '解封 IP', danger: true },
      { name: 'op', desc: '给玩家管理员权限', danger: true },
      { name: 'deop', desc: '取消管理员权限', danger: true },
      { name: 'whitelist', desc: '管理服务器的进服白名单', danger: true },
      { name: 'save-all', desc: '立刻把世界存盘' },
      { name: 'save-off', desc: '关掉自动保存', danger: true },
      { name: 'save-on', desc: '打开自动保存' },
      { name: 'reload', desc: '重载数据包 / 战利品表', danger: true },
      { name: 'stop', desc: '关掉服务器', danger: true },
      { name: 'transfer', desc: '把玩家转到别的服务器', danger: true },
      { name: 'publish', desc: '把单人世界开放到局域网' },
    ],
  },
  {
    group: '调试 / 脚本',
    items: [
      { name: 'help', desc: '看指令帮助' },
      { name: 'execute', desc: '以别的身份 / 满足条件时执行一条指令' },
      { name: 'function', desc: '跑一个函数（数据包里的指令集）' },
      { name: 'schedule', desc: '定时跑一条指令或函数' },
      { name: 'return', desc: '设置函数的返回值' },
      { name: 'data', desc: '读写方块 / 实体 / 存储的 NBT' },
      { name: 'random', desc: '随机数（reset / value）' },
      { name: 'tick', desc: '控制游戏刻的流速' },
      { name: 'debug', desc: '开始 / 停止调试记录' },
      { name: 'jfr', desc: '开始 / 停止 JFR 性能记录' },
    ],
  },
]

/** 目录里所有精确名（小写）—— 设置页用它把"自定义条目"挑出来。 */
export function catalogNames () {
  const out = []
  for (const g of COMMAND_GROUPS) for (const it of g.items) out.push(it.name)
  return out
}

/**
 * 这些指令会**把机器人挪走**（或者可能挪走）。
 *
 * 🔴 为什么要单独列：`mc_command` 只是"把指令发给服务端"，发包那一瞬是微秒级的 ——
 *    用调度器占住 `movement` 一点意义都没有（真正改变位置的是**服务端之后做的事**）。
 *    真正的问题是：正在跑的 `mc_move` 不知道自己已经被挪走了，会继续朝旧目标走，
 *    于是报"走不到"或者走到一个完全无关的地方。
 *    ⇒ 发完这类指令就**主动打断在飞的移动**（推移动代次 + 松控制位），让它老实说"被挪走了"。
 *
 * `execute` 也在里面：`/execute ... run tp` 一样会挪人。
 */
export const COMMANDS_THAT_MOVE_ME = new Set([
  'tp', 'teleport', 'spreadplayers', 'execute',
])

/** 一次 `mc_command` 最多代发几条（再多就像刷屏，原版服务端有指令频率限制） */
export const MAX_COMMANDS_PER_CALL = 32

/**
 * 把 `mc_command` 的入参拆成**一条一条**的指令（多行 = 多条）。
 *
 * 🔴 为什么必须拆：聊天包里的换行符会被服务端当场判成非法字符，
 *    回 `multiplayer.disconnect.illegal_characters` **把人踢下线**。
 *    2026-10-19 实机：把 10 条 `/fill` 拼成一个多行字符串发出去，人直接掉线，
 *    整个建造任务作废。所以多行不是"写错了"，而是**必须支持**的用法 —— 在这里拆开，
 *    由工具层逐条发（间隔 120ms）。
 *
 * 只做"拆 + 校验格式"，**不管白名单**（白名单是配置的事，调用方逐条判）：
 *   · 空行丢掉（`\r\n` 也认）；
 *   · 每条必须以 `/` 开头；
 *   · 超过 `max` 条直接拒（不静默截断 —— 静默截断会让人以为全发完了）。
 *
 * @param {string} raw
 * @param {{max?: number}} [opts]
 * @returns {string[]} 拆好、去过首尾空白的指令（至少 1 条，否则抛）
 */
export function splitCommands (raw, { max = MAX_COMMANDS_PER_CALL } = {}) {
  const lines = String(raw ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (!lines.length) throw new Error('没给指令（要给以 / 开头的完整指令）')
  if (lines.length > max) {
    throw new Error(`一次最多 ${max} 条（给了 ${lines.length} 条）—— 分几次发，别一口气刷屏`)
  }
  for (const [i, line] of lines.entries()) {
    if (!line.startsWith('/')) throw new Error(`第 ${i + 1} 条不是以 / 开头：${line.slice(0, 40)}`)
    /* 单条里**不许**再夹换行以外的控制字符（制表符、`\u0000`…）——同样会被判非法字符 */
    if (/[\u0000-\u001f\u007f]/.test(line)) {
      throw new Error(`第 ${i + 1} 条里有控制字符（制表符之类）—— 服务端会判成 illegal_characters 把我踢了`)
    }
  }
  return lines
}

/** 一条指令的名字（剥掉前导 `/`，取第一个词，小写）—— 白名单判定用 */
export function commandNameOf (line) {
  return String(line ?? '').trim().replace(/^\//, '').split(/\s+/)[0].toLowerCase()
}
