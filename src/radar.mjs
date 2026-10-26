/* ============================================================================
 * radar —— **分层雷达图 + 地形图**（用户 2026-10-26 的需求）
 * ----------------------------------------------------------------------------
 * 用户原话（摘要）：
 *   · 「雷达图：分层 ASCII 网格 + 字符映射表」，范围 **5(前后) × 9(左右) × 5(层)**；
 *   · 层 = 脚底下一层 + bot 所在两层 + 头顶两层；
 *   · 左右各 5 格（含自己那格）⇒ 9 列；**背后不用写**（自己站在最后一排）；
 *   · 字符**尽量用首字母**（好记、省算力）；
 *   · 高价值矿物用特殊标记（`#` `*` `$`）吸引注意；
 *   · 某方块在整张表里占比 < 10% ⇒ 折叠成 `O`（Others），除非是高价值矿或 **bot 自己放的**；
 *   · 头顶开阔时再给一张**地形图**（5×9，只算地面不算天花板：头顶有方块时那格仍然是 0）。
 *
 * 为什么单独一个文件：它是**纯渲染**（读 bot.blockAt → 字符串），不碰任务/调度；
 * 用假 bot 就能离线测（见 tools/check-radar.mjs）。
 * ========================================================================== */
import Vec3 from 'vec3'
import { wasPlacedByBot } from './bot-placed.mjs'

/** 雷达层数：脚下 1 层 + 所在 2 层 + 头顶 2 层 */
export const RADAR_LAYERS = 5
/** 左右各几格（不含自己那格） */
export const RADAR_SIDE = 4
/** 前后几排（最后一排 = 自己那排，背后不写） */
export const RADAR_DEPTH = 5
/** 折叠阈值：某种方块占整张表的比例低于它 ⇒ 折成 O */
export const FOLD_RATIO = 0.10

/** 高价值矿物的特殊标记（用户点名要"吸引 LLM 注意"） */
export const ORE_MARKS = new Map([
  ['diamond_ore', '$'], ['deepslate_diamond_ore', '$'],
  ['emerald_ore', '$'], ['deepslate_emerald_ore', '$'],
  ['ancient_debris', '$'],
  ['gold_ore', '*'], ['deepslate_gold_ore', '*'], ['nether_gold_ore', '*'],
  ['redstone_ore', '*'], ['deepslate_redstone_ore', '*'],
  ['lapis_ore', '*'], ['deepslate_lapis_ore', '*'],
  ['copper_ore', '*'], ['deepslate_copper_ore', '*'],
  ['iron_ore', '#'], ['deepslate_iron_ore', '#'],
  ['coal_ore', '#'], ['deepslate_coal_ore', '#'],
])

/** 矿物标记的说明（图例用，别每次现算） */
export const ORE_MARK_LEGEND = '#=铁/煤矿 *=金/红石/青金石/铜矿 $=钻石/绿宝石/远古残骸'

/** 朝向 → 单位向量（本插件 yaw 约定：0=南(+Z) 90=西(-X) 180=北(-Z) 270=东(+X)） */
const UNIT = {
  N: [0, 0, -1],
  S: [0, 0, 1],
  E: [1, 0, 0],
  W: [-1, 0, 0],
}

/**
 * yaw → 四种朝向（东南西北）。
 * @param {number} yaw 度（mineflayer 的 `entity.yaw`）
 * @returns {'N'|'E'|'S'|'W'}
 */
export function facingOf (yaw) {
  const d = ((Number(yaw) || 0) % 360 + 360) % 360
  if (d >= 315 || d < 45) return 'S'
  if (d < 135) return 'W'
  if (d < 225) return 'N'
  return 'E'
}

/** 朝向的右手方向（面朝北时右边是东） */
function rightOf (dir) {
  const [fx, , fz] = UNIT[dir] ?? UNIT.N
  return [-fz, 0, fx]
}

/** 方块名 → 有没有"首字母"可用（去掉命名空间的短名） */
const shortName = (name) => String(name ?? '').split(':').pop()

/** 取名字里的第一个字母，转大写（`grass_block` → `G`） */
function firstLetter (name) {
  const m = /[a-z]/i.exec(name)
  return m ? m[0].toUpperCase() : null
}

/**
 * 给一组方块名分配**单字符**代号。
 * 规则：首字母优先；撞了就用名字里后面的字母（`S` 被 stone 占了，sandstone 就找下一个没被占的字母）；
 * 都被占就用小写字形（`s`），再不行用数字。**永远一个字符**——否则网格对不齐。
 * @param {Iterable<string>} names
 * @returns {Map<string,string>} name → char
 */
export function assignChars (names, reserved = [], weights = null) {
  const out = new Map()
  const taken = new Set(reserved)
  /* 排序：**出现次数多的先挑字母**（`stone` 比 `sandstone` 更该拿到 S）；同权重再按名字排，
   * 保证同样的输入每次得到同样的字符（可复现，便于读日志）。 */
  const order = [...new Set(names)].sort((a, c) => {
    const wa = weights?.get?.(a) ?? 0
    const wc = weights?.get?.(c) ?? 0
    if (wa !== wc) return wc - wa
    return a < c ? -1 : a > c ? 1 : 0
  })
  for (const name of order) {
    const letter = firstLetter(name)
    const cands = []
    if (letter) cands.push(letter)
    for (const ch of String(name).toLowerCase()) {
      const u = ch.toUpperCase()
      if (/[A-Z]/.test(u) && !cands.includes(u)) cands.push(u)
    }
    if (letter) cands.push(letter.toLowerCase())
    for (let i = 2; i <= 9; i++) cands.push(String(i))
    const pick = cands.find((c) => !taken.has(c))
    /* 极端情况（26 个字母全被占）：复用 '*'，宁可撞也不崩 */
    out.set(name, pick ?? '*')
    if (pick) taken.add(pick)
  }
  return out
}

/**
 * 读一层「以自己为网格中心」的方块网格。
 * 索引：`i` = 纵深（0 = 最前，RADAR_DEPTH-1 = 自己那排），`j` = 左右（0 = 最左，RADAR_SIDE = 自己）。
 * @returns {Array<{i,j,x,y,z,name,kind:'air'|'solid'|'liquid'|'unloaded'}>}
 */
export function readLayer (b, { x, y, z, dir }) {
  const [fx, , fz] = UNIT[dir] ?? UNIT.N
  const [rx, , rz] = rightOf(dir)
  const out = []
  for (let i = 0; i < RADAR_DEPTH; i++) {
    const depth = RADAR_DEPTH - 1 - i
    for (let j = 0; j < RADAR_SIDE * 2 + 1; j++) {
      const lat = j - RADAR_SIDE
      const px = x + fx * depth + rx * lat
      const pz = z + fz * depth + rz * lat
      let blk = null
      try { blk = b.blockAt(new Vec3(px, y, pz)) } catch { blk = null }
      const name = blk ? shortName(blk.name) : null
      let kind
      if (!blk) kind = 'unloaded'
      else if (!name || /(^|_)air$/.test(name)) kind = 'air'
      else if (/^(water|flowing_water|lava|flowing_lava|bubble_column)$/.test(name)) kind = 'liquid'
      else if (blk.boundingBox === 'block') kind = 'solid'
      /* 火把 / 花 / 草 这类"占了格子但不是整方块"：当空气处理（不影响走位判断，也省字符） */
      else kind = 'air'
      out.push({ i, j, x: px, y, z: pz, name, kind })
    }
  }
  return out
}

/** 液体也画出来（水/岩浆各一个字符），但不算 solid */
const LIQUID_CHAR = { water: 'W', flowing_water: 'W', lava: 'L', flowing_lava: 'L', bubble_column: 'B' }

/**
 * 渲染雷达（RADAR_LAYERS 层，从头顶到脚下）。
 *
 * @param {object} b mineflayer bot（只要 `blockAt` 和 `entity.position/yaw`）
 * @param {object} [opts]
 * @param {{x:number,y:number,z:number}|null} [opts.feet] 自己脚所在格（默认从 `b.entity` 推）
 * @param {'N'|'E'|'S'|'W'} [opts.dir] 朝向（默认从 yaw 推）
 * @param {string} [opts.focus] 焦点（只写进标题，不影响渲染）
 * @returns {{ok:boolean, why?:string, text?:string, airRatio?:number, lines?:string[], legend?:string}}
 */
export function renderRadar (b, opts = {}) {
  const ent = b?.entity
  if (!ent?.position) return { ok: false, why: '还没进服（先 mc_connect）' }
  const feet = opts.feet ?? { x: Math.floor(ent.position.x), y: Math.floor(ent.position.y), z: Math.floor(ent.position.z) }
  const dir = opts.dir ?? facingOf(ent.yaw)

  /* 五层：脚下 1、所在 2、头顶 2 ⇒ y-1, y, y+1, y+2, y+3 */
  const ys = []
  for (let k = RADAR_LAYERS - 2; k >= -1; k--) ys.push(feet.y + k)

  const layers = ys.map((y) => readLayer(b, { x: feet.x, y, z: feet.z, dir }))
  const cells = layers.flat()
  const total = cells.filter((c) => c.kind !== 'unloaded').length || 1

  /* ① 统计占比（按方块名） */
  const count = new Map()
  for (const c of cells) {
    if (c.kind !== 'solid') continue
    count.set(c.name, (count.get(c.name) ?? 0) + 1)
  }

  /* ② 决定哪些"独立展示"：占比 ≥10% / 高价值矿 / bot 自己放的 */
  const shown = new Set()
  for (const [name, n] of count) {
    const valuable = ORE_MARKS.has(name)
    const mine = cells.some((c) => c.kind === 'solid' && c.name === name && wasPlacedByBot(b, c.x, c.y, c.z))
    if (valuable || mine || n / total >= FOLD_RATIO) shown.add(name)
  }
  /* ③ 分配字符（矿物用特殊标记，不参与首字母分配）。
   *    预留字符：P 玩家 / O 其他 / ? 未加载 / . 空气 / 液体 W L B —— 方块名不许占它们，
   *    否则「planks 拿到 P」这种事会让图分不清哪格是人。 */
  const RESERVED = ['P', 'O', '?', '.', 'W', 'L', 'B', '#', '*', '$']
  const chars = assignChars([...shown].filter((n) => !ORE_MARKS.has(n)), RESERVED, count)
  const charOf = (name) => ORE_MARKS.get(name) ?? chars.get(name) ?? 'O'

  /* ④ 逐层出图 */
  const lines = []
  const usedNames = []
  for (let li = 0; li < layers.length; li++) {
    const y = ys[li]
    const rows = []
    for (let i = 0; i < RADAR_DEPTH; i++) {
      let row = ''
      for (let j = 0; j < RADAR_SIDE * 2 + 1; j++) {
        const c = layers[li].find((q) => q.i === i && q.j === j)
        if (!c) { row += '?'; continue }
        if (y === feet.y && i === RADAR_DEPTH - 1 && j === RADAR_SIDE) { row += 'P'; continue }  // 自己
        if (c.kind === 'unloaded') row += '?'
        else if (c.kind === 'air') row += '.'
        else if (c.kind === 'liquid') row += LIQUID_CHAR[c.name] ?? 'W'
        else {
          const ch = shown.has(c.name) ? charOf(c.name) : 'O'
          if (ch !== 'O' && !usedNames.includes(c.name)) usedNames.push(c.name)
          row += ch
        }
      }
      rows.push(row)
    }
    lines.push(`y=${y} ${rows.join(' / ')}`)
  }

  /* ⑤ 图例：只列真用到的（省字符）；O 固定解释一次 */
  const legendParts = []
  for (const name of usedNames.sort()) {
    const ch = ORE_MARKS.get(name) ?? chars.get(name)
    if (ch) legendParts.push(`${ch}=${name}`)
  }
  if (lines.some((l) => l.includes('O'))) legendParts.push(`O=其他(<${Math.round(FOLD_RATIO * 100)}%)`)
  if (cells.some((c) => c.kind === 'liquid')) legendParts.push('W=水 L=岩浆')
  if (ORE_MARKS.size && usedNames.some((n) => ORE_MARKS.has(n))) legendParts.push(ORE_MARK_LEGEND)

  const airish = cells.filter((c) => c.kind === 'air').length
  const airRatio = airish / total
  const head = `🧱 雷达（前=${dir}，最后一行是你 P；${RADAR_LAYERS} 层从头顶到脚下）空气 ${Math.round(airRatio * 100)}%`
  return {
    ok: true,
    dir,
    feet,
    airRatio,
    legend: legendParts.join(' '),
    lines: [head, ...lines, `字符: ${legendParts.join(' ')}`],
    text: [head, ...lines, `字符: ${legendParts.join(' ')}`].join('\n'),
  }
}

/**
 * 渲染地形图：5×9 的相对高度（相对"自己脚下面那一层"），**只算地面不算天花板**。
 *
 * 语义（用户点名）：`0` = 和脚下一样高；`2` = 高两格；`-3` = 低三格；
 * `?` = 这一列没找到落脚点（悬空 / 没加载）；`P` = 自己那一格。
 * 判定"地面"：从脚下往上找最近的一个"上面有两格空气的实心方块"——
 * 所以**头顶那块天花板永远不会被当成地形**。
 *
 * @returns {{ok:boolean, why?:string, text?:string, lines?:string[], cells?:Array}}
 */
export function renderTerrain (b, opts = {}) {
  const ent = b?.entity
  if (!ent?.position) return { ok: false, why: '还没进服（先 mc_connect）' }
  const feet = opts.feet ?? { x: Math.floor(ent.position.x), y: Math.floor(ent.position.y), z: Math.floor(ent.position.z) }
  const dir = opts.dir ?? facingOf(ent.yaw)
  const base = feet.y - 1            // 脚下那格：0 = 与它同高
  const [fx, , fz] = UNIT[dir] ?? UNIT.N
  const [rx, , rz] = rightOf(dir)

  const solidAt = (x, y, z) => {
    try {
      const blk = b.blockAt(new Vec3(x, y, z))
      if (!blk) return null                  // 没加载
      if (/air$/.test(String(blk.name)) || blk.boundingBox !== 'block') return false
      return true                            // 只认"整个方块"——流体/火把不算地面
    } catch { return null }
  }

  /** 找这一列的地面高度（绝对 y）：`{ y }` / `{ unloaded:true }` / `{ blocked:true }` */
  const groundOf = (x, z) => {
    /* 从自己脚下往上 2 格开始往下扫 10 格：地面必须在"头顶有两格空气"的前提下 */
    for (let y = feet.y + 2; y >= feet.y - 10; y--) {
      const s = solidAt(x, y, z)
      if (s === null) return { unloaded: true }
      if (!s) continue
      const a1 = solidAt(x, y + 1, z)
      const a2 = solidAt(x, y + 2, z)
      if (a1 === null || a2 === null) return { unloaded: true }
      if (!a1 && !a2) return { y }
      /* 上方被堵（天花板 / 半格）→ 继续往下找，不把天花板当地面 */
    }
    /* 整列都没找到"能站的地面"：这一列是墙/天花板压顶（不是没加载，用户要能分清） */
    return { blocked: true }
  }

  const lines = []
  for (let i = 0; i < RADAR_DEPTH; i++) {
    const depth = RADAR_DEPTH - 1 - i
    const row = []
    for (let j = 0; j < RADAR_SIDE * 2 + 1; j++) {
      const lat = j - RADAR_SIDE
      const x = feet.x + fx * depth + rx * lat
      const z = feet.z + fz * depth + rz * lat
      if (i === RADAR_DEPTH - 1 && j === RADAR_SIDE) { row.push('P'); continue }
      const g = groundOf(x, z)
      row.push(g.y != null ? String(g.y - base) : (g.unloaded ? '?' : '^'))
    }
    lines.push(row.join(' '))
  }
  const head = `🗺 地形（前=${dir}，相对你脚下那一层；0=同高，P=你，^=这一列被墙/天花板堵住，?=没加载）`
  return { ok: true, dir, lines: [head, ...lines], text: [head, ...lines].join('\n') }
}
