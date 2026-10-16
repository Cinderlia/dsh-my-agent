#!/usr/bin/env node
/**
 * check-core-map.mjs —— `mc_map`「在地下自动切洞穴层视图」的回归检查
 *
 * 背景（用户 2026-10-08 原话：「map工具ai说只能看地表的，添加在地下变成看以自身为中心上下2格
 *   洞穴。就像地图模组那样」）：
 *   旧版 `heightmap()` 只做**地表图**：每列从 `cy+yTop` 往下扫，取第一块非空气 ⇒ 在地底下
 *   整个图都是头顶那层岩石（或者干脆一片"未加载"），完全没用。
 *
 * 现在：
 *   · `isUnderground()` —— 头顶 40 格内有实心遮挡（树叶/竹子/雪层这类"软顶"不算）就当地下；
 *   · `heightmap({ mode })` —— `auto`（默认，自动切）/ `surface`（强制地表）/ `cave`（强制洞穴层）；
 *   · 洞穴层：以我为中心，`slab` 格上下（默认 2 = 上下各 2 格，共 5 层）逐列判断
 *     「能不能站、脚下有没有地面」，画成 `# · ↓ v ~ ≈ * ?`（另起一套字形，不是方块名）；
 *   · `mapImage({ mode, slab })` 跟着切，洞穴层图有自己的配色（能走=亮、墙=暗）。
 *
 * 🔴 2026-10-08 路线图第 ④ 条第十一刀：这一层的实现已搬到 `src/map-render.mjs`
 *   （`isUnderground(b)` / `caveCell(b, …)` / `heightmapOf(b, …)` / `glyphMapText(…)` / `mapImageOf(b, …)`），
 *   `core.mjs` 只留四个同名薄包装（公开面不变）⇒ 下面⑤那些"按源码文本找代码"的断言
 *   必须去**新模块**里找（踩坑档案第 46 条那个坑，第十一次）。
 *
 * 用法：node tools/check-core-map.mjs
 *   ⚠️ **必须从包目录跑**（`<profile>/node_modules/dsh-mc-agent`）：`src/core.mjs` 顶部
 *      `import ... from 'mineflayer'`，源码树里没有 node_modules，会 ERR_MODULE_NOT_FOUND。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'

// ── 断言小工具（和别的 check-*.mjs 一致）────────────────────────────────────────
let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n${t}`)

// ── 借依赖：源码树里没有 node_modules，从包目录借 vec3 ────────────────────────────
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILE = join(DSH_HOME, 'profiles', 'desktop')
const req = (() => {
  const bases = [
    new URL('../index.js', import.meta.url).href,
    join(PROFILE, 'node_modules', 'dsh-mc-agent', 'index.js'),
    join(PROFILE, 'index.js'),
  ]
  for (const base of bases) {
    try { const r = createRequire(base); r('mineflayer'); return r } catch {}
  }
  return null
})()
if (!req) {
  console.log('✗ 拿不到 mineflayer —— 请从包目录（<profile>/node_modules/dsh-mc-agent）跑，')
  console.log('  或确认已安装 mineflayer。')
  process.exit(2)
}
const Vec3 = req('vec3')
const { McBot, glyphOf } = await import(new URL('../src/core.mjs', import.meta.url))
/* 2026-10-15：`mc_map` 默认改成"脚下方块那一层" —— 新函数直接从 map-render.mjs 取
 *（工具层就是这么 import 的，没经过 core.mjs 的薄包装）。 */
const { floorMapOf, floorCell, floorKeyOf, gridToWorld, worldToGrid, hazardCellsOf, navSummaryOf } =
  await import(new URL('../src/map-render.mjs', import.meta.url))

const TMP_DIRS = []
const mkMc = (bot) => {
  const dir = mkdtempSync(join(tmpdir(), 'wc-map-'))
  TMP_DIRS.push(dir)
  const mc = new McBot({ logFile: join(dir, 'check.log') })
  mc.bot = bot
  mc.mcPlugins = {}
  mc.pfReady = false
  return mc
}

/**
 * 假世界：`cells` 里显式给 `x,y,z` → 方块名（`null` = 未加载），其它一律 `fill`。
 * 只实现 `blockAt(Vec3)` —— 而且**喂普通对象就抛**（真 mineflayer 就是 `pos.floored is not a function`，
 * 这条纪律害过我们：`eyeOf()` 给普通对象 ⇒ `blockNameAt` 恒 null）。
 */
const mkWorld = ({ fill = 'air', cells = {} } = {}) => {
  const map = new Map()
  for (const [k, v] of Object.entries(cells)) map.set(k, v)
  const K = (x, y, z) => `${x},${y},${z}`
  const world = {
    set (x, y, z, n) { map.set(K(x, y, z), n); return world },
    get (x, y, z) { return map.has(K(x, y, z)) ? map.get(K(x, y, z)) : fill },
    blockAt (v) {
      if (!v || typeof v.x !== 'number' || typeof v.floored !== 'function') {
        throw new TypeError('pos.floored is not a function')
      }
      const n = world.get(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z))
      return n == null ? null : { name: n, position: new Vec3(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)) }
    },
  }
  return world
}
const mkBot = ({ pos = [0, 64, 0], world = mkWorld() } = {}) => ({
  entity: { position: new Vec3(pos[0], pos[1], pos[2]), isInWater: false, yaw: 0, pitch: 0 },
  blockAt (v) { return world.blockAt(v) },
})

try {
  // ═══════════════════════════════════════════════════════════════════════════
  section('① 是不是"在地下"（isUnderground：头顶 40 格内有没有实心遮挡）')

  {
    // 露天：头顶全空
    const mc = mkMc(mkBot({ pos: [0, 64, 0], world: mkWorld({ fill: 'air' }) }))
    ok(mc.isUnderground() === false, '头顶全空 ⇒ 不是地下（给地表图）')
  }
  {
    // 洞穴：头顶 2 格就有石头
    const w = mkWorld({ fill: 'air' })
    w.set(0, 66, 0, 'stone')
    const mc = mkMc(mkBot({ pos: [0, 64, 0], world: w }))
    ok(mc.isUnderground() === true, '头顶 2 格是石头 ⇒ 在地下（给洞穴层图）')
  }
  {
    // 站在树下：树叶不算"顶"
    const w = mkWorld({ fill: 'air' })
    w.set(0, 68, 0, 'oak_leaves')
    const mc = mkMc(mkBot({ pos: [0, 64, 0], world: w }))
    ok(mc.isUnderground() === false, '头顶只有树叶/原木 ⇒ 不算地下（站在树下仍看地表图）')
  }
  {
    // 地下 30 格高的洞顶也能认出来
    const w = mkWorld({ fill: 'air' })
    w.set(0, 94, 0, 'deepslate')
    const mc = mkMc(mkBot({ pos: [0, 64, 0], world: w }))
    ok(mc.isUnderground() === true, '头顶 30 格才是洞顶也认得出')
  }
  {
    // 未加载 ⇒ 保守当露天（否则地表图会变成一片"未加载"）
    const w = mkWorld({ fill: 'air' })
    w.set(0, 66, 0, null)
    const mc = mkMc(mkBot({ pos: [0, 64, 0], world: w }))
    ok(mc.isUnderground() === false, '头顶那格未加载 ⇒ 当露天（保守）')
  }
  {
    // 屋里的木头顶也算（不然只能看到屋顶）
    const w = mkWorld({ fill: 'air' })
    w.set(0, 68, 0, 'oak_planks')
    const mc = mkMc(mkBot({ pos: [0, 64, 0], world: w }))
    ok(mc.isUnderground() === true, '头顶是木板屋顶（屋里）⇒ 当地下（看室内平面图）')
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section('② 洞穴层一格：能不能站 / 脚下有没有地面')

  const CAVE = 'air'
  const w = mkWorld({ fill: CAVE })
  const Y = 64
  const RAD = 12
  // 我脚边这一片（dx=-4..3）铺一层石头当地面；dx≥4 的列留空，好测"会掉下去 / 深不见底"
  for (let x = -4; x < 4; x++) for (let z = -4; z < 4; z++) w.set(x, Y - 1, z, 'stone')
  w.set(0, Y + 6, 0, 'stone')        // 我这一列头顶 6 格有洞顶（auto 模式要靠它认出"在地下"）
  w.set(1, Y, 0, 'stone')            // dx=1：身体那一格被堵 ⇒ 墙
  w.set(2, Y + 1, 0, 'stone')        // dx=2：头那一格被堵（只有 1 格高）⇒ 墙
  w.set(3, Y - 1, 0, CAVE)           // dx=3：脚下低 1 格…
  w.set(3, Y - 2, 0, 'stone')        //        …地面在 cy-2 ⇒ ↓（低一格）
  w.set(4, Y - 1, 0, CAVE)           // dx=4：地面在 cy-3 ⇒ v（会掉下去）
  w.set(4, Y - 2, 0, CAVE)
  w.set(4, Y - 3, 0, 'stone')
  // dx=5 故意什么都不放（slab 内 + 再往下 4 格全空）⇒ ?（深不见底/未加载）
  w.set(6, Y - 1, 0, 'water')        // dx=6：脚下是水 ⇒ ~
  w.set(7, Y, 0, 'lava')             // dx=7：身体那格是岩浆 ⇒ ≈
  w.set(8, Y, 0, 'iron_ore')         // dx=8：身体那格是矿石 ⇒ *
  w.set(9, Y + 2, 0, 'stone')        // dx=9：天花板在 +2（2 格高巷道）⇒ 照样能站
  w.set(9, Y - 1, 0, 'stone')
  const mc = mkMc(mkBot({ pos: [0, Y, 0], world: w }))
  const hm = mc.heightmap({ radius: RAD, mode: 'cave', slab: 2 })
  const R = hm.radius
  const row = hm.names[R]                  // dz = 0 那一行
  const at = (dx) => row[R + dx]
  ok(hm.mode === 'cave', 'mode:"cave" 强制洞穴层视图')
  ok(hm.layer && hm.layer.y === Y && hm.layer.slab === 2, 'layer 报出"我这一层 y"与上下格数', `y=${hm.layer?.y} slab=${hm.layer?.slab}`)
  ok(at(0) === 'cave_open', '脚下就是地面 ⇒ cave_open（能站）', at(0))
  ok(at(1) === 'cave_wall', '脚那一格被堵 ⇒ cave_wall（墙）', at(1))
  ok(at(2) === 'cave_wall', '头顶被堵（只有 1 格高）⇒ cave_wall（站不下）', at(2))
  ok(at(3) === 'cave_step', '脚下低 1 格 ⇒ cave_step（↓）', at(3))
  ok(at(4) === 'cave_drop', '脚下 2 格才是地 ⇒ cave_drop（v，会掉下去）', at(4))
  /* 🔴 2026-10-15 审计（报告 G 第 4 条）：以前"探不到底"（slab 内脚下全空 + 再下探 4 格
   *    都没有地面 = 大洞穴/深井）和"区块没加载"都算 cave_void，于是 `unloaded` 计数虚高、
   *    `mc_observe` 会提示"未加载像素偏多"。现在分开：探不到底 = cave_deep（V）。 */
  ok(at(5) === 'cave_deep', '脚下 4 格内没地 ⇒ cave_deep（V，探不到底 —— 不是"未加载"）', at(5))
  ok(at(6) === 'cave_water', '脚下是水 ⇒ cave_water（~）', at(6))
  ok(at(7) === 'cave_lava', '那一格是岩浆 ⇒ cave_lava（≈）', at(7))
  ok(at(8) === 'cave_ore', '墙里是铁矿 ⇒ cave_ore（*）', at(8))
  ok(at(9) === 'cave_open', '只有天花板在 +2（2 格高）⇒ 照样能站', at(9))

  ok(glyphOf('cave_wall') === '#' && glyphOf('cave_open') === '·' && glyphOf('cave_step') === '↓'
    && glyphOf('cave_drop') === 'v' && glyphOf('cave_water') === '~' && glyphOf('cave_lava') === '≈'
    && glyphOf('cave_ore') === '*' && glyphOf('cave_void') === '?'
    && glyphOf('cave_deep') === 'V', '9 个洞穴字形齐全（# · ↓ v V ~ ≈ * ?）')
  ok(glyphOf('stone') === ':' && glyphOf('grass_block') === '"', '地表图的字形没被改坏（stone=: / grass_block="）')

  {
    const g = McBot.glyphMap(hm.names, 1, { x: R, y: R })
    const lines = g.split('\n')
    ok(lines.length === 2 * R && lines[R].length === 2 * R, '字符图尺寸 = 2×半径', `${lines.length}×${lines[R]?.length}`)
    ok(lines[R].slice(R - 1, R + 10) === '·@##↓vV~≈*·', '中心那一行画出来就是 ·@##↓vV~≈*·（@ 是我）', lines[R].slice(R - 1, R + 10))
    ok(lines[R][R] === '@', '中心格是 @（我自己）')
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section('③ 图例 / 配色 / 图像')

  ok(hm.legend.every((e) => e.glyph && e.key && typeof e.count === 'number'), '洞穴层图例带 glyph/key/count（给文案用）')
  ok(hm.legend.some((e) => e.name === '墙' && e.glyph === '#' && e.count >= 2), '图例有中文名（墙 #）', JSON.stringify(hm.legend.slice(0, 3)))
  ok(hm.colors.length === hm.names.length && hm.colors[0].length === hm.names[0].length, 'colors 与 names 同尺寸')
  {
    const light = hm.colors[R][R]                  // 能站
    const dark = hm.colors[R][R + 1]               // 墙
    ok(light[0] + light[1] + light[2] > dark[0] + dark[1] + dark[2], '能走的地方比墙亮（像地图模组那样一眼看出通道）',
      `能站 ${light} / 墙 ${dark}`)
  }
  {
    const img = mc.mapImage({ radius: 4, scale: 2, mode: 'cave' })
    ok(img.width === 16 && img.height === 16 && img.rgba.length === 16 * 16 * 4, 'mapImage 跟着切洞穴层（尺寸/像素数对）',
      `${img.width}×${img.height}`)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section('④ 地表 / 洞穴两种模式：自动切 + 手动强制')

  {
    // 同一个"地下"世界：auto 给洞穴层、surface 给地表
    const mc2 = mkMc(mkBot({ pos: [0, Y, 0], world: w }))
    const auto = mc2.heightmap({ radius: 4 })
    const surf = mc2.heightmap({ radius: 4, mode: 'surface' })
    ok(auto.mode === 'cave', 'mode 缺省（auto）+ 在地下 ⇒ 洞穴层图')
    ok(surf.mode === 'surface' && !String(surf.names[4][4]).startsWith('cave_'), 'mode:"surface" 强制地表图（不被自动判据改掉）',
      String(surf.names[4][4]))
    ok(surf.legend.every((e) => e.name && !e.glyph), '地表图例仍是 {name,count}（旧形状，前端/文案都靠它）')
  }
  {
    // 露天世界：auto 给地表
    const wOpen = mkWorld({ fill: 'air' })
    wOpen.set(0, Y - 1, 0, 'grass_block')
    const mc3 = mkMc(mkBot({ pos: [0, Y, 0], world: wOpen }))
    ok(mc3.heightmap({ radius: 4 }).mode === 'surface', '露天 + auto ⇒ 地表图（不误切）')
    ok(mc3.heightmap({ radius: 4, mode: 'cave' }).mode === 'cave', '露天也能 mode:"cave" 强制看洞穴层')
  }
  {
    // slab 钳制
    const mc4 = mkMc(mkBot({ pos: [0, Y, 0], world: w }))
    ok(mc4.heightmap({ radius: 4, mode: 'cave', slab: 99 }).layer.slab === 8, 'slab 上限 8')
    ok(mc4.heightmap({ radius: 4, mode: 'cave', slab: 0 }).layer.slab === 2, 'slab 给 0 ⇒ 回默认 2')
    ok(mc4.heightmap({ radius: 4, mode: 'cave', slab: 1 }).layer.slab === 1, 'slab 给 1 ⇒ 上下各 1 格')
    // slab 变大以后，脚下 3 格的地面就落进 slab 里了（判据跟着 slab 走）
    ok(mc4.heightmap({ radius: RAD, mode: 'cave', slab: 3 }).names[12][12 + 4] === 'cave_drop',
      'slab=3 时脚下 3 格的地仍算 cave_drop（判据按 slab 走）')
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section('⑥ 地板层视图（2026-10-15 用户需求：默认看"脚下方块那一层"）')

  {
    /* 房间：地板在 y=63（机器人 y=64 ⇒ 默认层 = 63）
     *   (0,63,0) 石头地面、身体空间空      ⇒ 能站
     *   (1,63,0) 地板石头 + 头顶 (1,64,0) 被堵 ⇒ 墙（**实心 ≠ 能站**）
     *   (2,63,0) 这一层是空气、下面也空     ⇒ 会掉下去
     *   (3,63,0) 水                        ⇒ 液体
     *   (4,63,0) 读不到（区块没加载）       ⇒ 未加载，**不能当成能走** */
    const w = mkWorld({ fill: 'air' })
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) w.set(x, 63, z, 'stone')
    w.set(1, 64, 0, 'stone')            // 身体被堵
    w.set(2, 63, 0, 'air')              // 这一层空
    w.set(3, 63, 0, 'water')
    w.set(4, 63, 0, null)               // 未加载
    const b = mkBot({ pos: [0, 64, 0], world: w })
    const m = floorMapOf(b, { radius: 6 })
    const at = (dx, dz) => m.names[m.radius + dz][m.radius + dx]
    const cellAt = (dx, dz) => m.cells[m.radius + dz][m.radius + dx]

    ok(m.mode === 'floor' && m.layer.y === 63, '默认层 = 脚底下那一层（feetY - 1）', `layer.y=${m.layer.y}`)
    ok(at(0, 0) === 'floor_walk', '实心地面 + 身体空间空 ⇒ floor_walk（能站）')
    ok(at(1, 0) === 'floor_wall', '地板实心但身体被堵 ⇒ floor_wall（**实心 ≠ 能站**）')
    ok(at(2, 0) === 'floor_drop', '这一层是空气、下面也没地板 ⇒ floor_drop（会掉下去）')
    ok(at(3, 0) === 'floor_water', '水 ⇒ floor_water')
    ok(at(4, 0) === 'floor_void', '读不到 ⇒ floor_void，**不能当成空气/能走**')
    ok(cellAt(4, 0).loaded === false && cellAt(0, 0).loaded === true, '每格带 loaded（未加载明确是 false）')
    ok(cellAt(0, 0).supported === true && cellAt(2, 0).supported === false, '每格带 supported（脚下有没有可靠支撑）')
    ok(cellAt(3, 0).hazard === 'water' && cellAt(0, 0).hazard === null, '每格带 hazard（水/岩浆）')
    ok(cellAt(4, 0).kind === 'unknown' && cellAt(4, 0).surfaceY === null, '未知状态必须**保留**（别猜一个高度出来）')
    ok(m.counts.walkable > 0 && m.counts.unknown >= 1, 'counts 分类计数', JSON.stringify(m.counts))
    ok(typeof m.originX === 'number' && m.cellSize === 1, '带 originX/originZ/cellSize')
  }
  {
    // layer 可以自己指定；不指定就是 feetY-1
    const w = mkWorld({ fill: 'air' })
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) w.set(x, 50, z, 'stone')
    const b = mkBot({ pos: [0, 64, 0], world: w })
    ok(floorMapOf(b, { radius: 4, layer: 50 }).layer.y === 50, 'layer 参数能指定看哪一层')
    ok(floorMapOf(b, { radius: 4 }).layer.y === 63, '不给 layer ⇒ 脚底下那一层')
    const c = floorCell(b, 0, 50, 0, { depth: 4 })
    ok(c.surfaceY === 50 && c.kind === 'walkable', 'floorCell 单格也能用（surfaceY = 地板那一层）')
    ok(floorKeyOf(c) === 'floor_walk', 'floorKeyOf 映射到字形键')
    ok(floorKeyOf({ kind: 'unknown' }) === 'floor_void' && floorKeyOf(null) === 'floor_void',
      'floorKeyOf 把未知/空都算成 floor_void')
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section('⑦ 坐标换算（用户"第三刀"：字符图第几行第几列 ⇒ 真实世界坐标）')

  {
    const w = mkWorld({ fill: 'air' })
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) w.set(x, 63, z, 'stone')
    const b = mkBot({ pos: [10, 64, -7], world: w })
    const m = floorMapOf(b, { radius: 8 })
    const mid = gridToWorld(m.radius, m.radius, m)
    ok(mid.x === 10 && mid.z === -7, '中心格（行=列=radius）就是机器人实际位置', `got (${mid.x}, ${mid.z})`)
    const tl = gridToWorld(0, 0, m)
    ok(tl.x === 2 && tl.z === -15, '左上角 = (cx-R, cz-R)', JSON.stringify(tl))
    ok(gridToWorld(m.radius, m.radius + 1, m).x === 11, '列 +1 ⇒ x +1（东）')
    ok(gridToWorld(m.radius + 1, m.radius, m).z === -6, '行 +1 ⇒ z +1（南）')
    const g = worldToGrid(11, -6, m)
    ok(g.row === m.radius + 1 && g.col === m.radius + 1, 'worldToGrid 是 gridToWorld 的逆')
    // 抽稀步长变了，坐标也要跟着变 —— 所以一律走 gridToWorld，别自己乘
    const m2 = { ...m, cellSize: 2 }
    ok(gridToWorld(0, 1, m2).x === m2.originX + 2, 'cellSize=2（glyphStep=2）时列 +1 ⇒ x +2')
    const g2 = worldToGrid(m2.originX + 4, m2.originZ + 6, m2)
    ok(g2.col === 2 && g2.row === 3, 'worldToGrid 认 cellSize')
    ok(m.bounds.minX === m.originX && m.bounds.maxX === m.originX + m.radius * 2 - 1,
      'bounds 与 origin/cellSize 自洽')
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section('⑧ 危险格 / 未加载（hazardCellsOf）')

  {
    const w = mkWorld({ fill: 'air' })
    for (let x = -8; x <= 8; x++) {
      for (let z = -8; z <= 8; z++) { w.set(x, 63, z, 'stone'); w.set(x, 64, z, 'air'); w.set(x, 65, z, 'air') }
    }
    w.set(2, 63, 0, 'lava')
    w.set(-2, 63, 1, 'water')
    w.set(0, 63, 3, null)              // 未加载
    const b = mkBot({ pos: [0, 64, 0], world: w })
    const m = floorMapOf(b, { radius: 6 })
    ok(m.hazards.length === 3, 'hazards 里同时有岩浆/水/未加载（没有多余的深坑）', `n=${m.hazards.length}`)
    ok(m.hazards[0].kind === 'lava', '岩浆排第一（最危险）', JSON.stringify(m.hazards[0]))
    ok(m.hazards.every((h) => typeof h.x === 'number' && typeof h.z === 'number' && typeof h.d === 'number'),
      'hazards 每项都带真实坐标和距离')
    const lava = m.hazards.find((h) => h.kind === 'lava')
    ok(lava.x === 2 && lava.z === 0, 'hazards 里的坐标是**真实世界坐标**（不是行列号）', JSON.stringify(lava))
    ok(m.hazards.some((h) => h.kind === 'unloaded' && h.x === 0 && h.z === 3), '未加载也算危险格')
    ok(hazardCellsOf(m, { limit: 1 }).length === 1, 'limit 生效')
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section('⑨ 导航摘要（purpose=navigation / hazards）')

  {
    const w = mkWorld({ fill: 'air' })
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) w.set(x, 63, z, 'stone')
    w.set(3, 63, 3, 'lava')
    const b = mkBot({ pos: [0, 64, 0], world: w })
    const m = floorMapOf(b, { radius: 6 })
    ok(navSummaryOf(m, { purpose: 'overview' }).lines.length === 0, 'overview 不加摘要（维持现状、省 token）')
    const nav = navSummaryOf(m, { purpose: 'navigation', target: '10,63,4' })
    const txt = nav.lines.join('\n')
    ok(/10, ?63, ?4/.test(txt), 'navigation 摘要里带目标坐标')
    ok(/直线距离/.test(txt) && /方位/.test(txt), 'navigation 摘要里带距离和方位')
    ok(/mc_move|pathfinder/.test(txt), 'navigation 摘要里说清"路通不通要真走一次"（职责边界）')
    ok(/mc_scan/.test(txt), 'navigation 摘要里说清"动手前再 mc_scan 复核"')
    ok(nav.nearbyTargets.length === 1 && nav.nearbyTargets[0].x === 10, 'nearbyTargets 也带出来')
    ok(navSummaryOf(m, { purpose: 'navigation' }).lines.join('\n').includes('没给 target'),
      '不给 target 时如实说"想算方位就把坐标传进来"')
    const hz = navSummaryOf(m, { purpose: 'hazards' }).lines.join('\n')
    ok(/岩浆/.test(hz) && /3, 3/.test(hz), 'hazards 摘要点名岩浆并给坐标')
    const clean = mkWorld({ fill: 'stone' })
    ok(navSummaryOf(floorMapOf(mkBot({ pos: [0, 64, 0], world: clean }), { radius: 4 }), { purpose: 'hazards' })
      .lines.join('\n').includes('没有'), '没有危险时明确说"没有"（别让模型自己猜）')
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section('⑤ 静态接线（core.mjs / index.js）')

  const core = readFileSync(new URL('../src/core.mjs', import.meta.url), 'utf8')
  const names = readFileSync(new URL('../src/block-names.mjs', import.meta.url), 'utf8')
  const mapSrc = readFileSync(new URL('../src/map-render.mjs', import.meta.url), 'utf8')
  const idx = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  const checks = [
    [names, /export const PASSABLE = /, 'block-names：有"能穿过去的小东西"名单（花草火把不算墙）'],
    [names, /export const SOFT_ROOF = /, 'block-names：有"软顶"名单（树叶/竹子/雪层不算地下）'],
    [names, /export const CAVE_GLYPH = \{/, 'block-names：洞穴字形表'],
    [core, /from '\.\/block-names\.mjs'/, 'core：这些纯方块名判据改成从 block-names.mjs 导入（路线图第 ④ 条第二刀）'],
    [core, /from '\.\/map-render\.mjs'/, 'core：地图那一层改成从 map-render.mjs 导入（路线图第 ④ 条第十一刀）'],
    [core, /isUnderground \(\) \{ return isUnderground\(this\.requireBot\(\)\) \}/, 'core：isUnderground() 留成薄包装（公开面不变）'],
    [core, /heightmap \(opts = \{\}\) \{ return heightmapOf\(this\.requireBot\(\), opts\) \}/, 'core：heightmap() 留成薄包装'],
    [core, /static glyphMap \(names, step = 2, selfIndex = null\) \{ return glyphMapText\(names, step, selfIndex\) \}/, 'core：static glyphMap() 留成薄包装'],
    [core, /mapImage \(opts = \{\}\) \{ return mapImageOf\(this\.requireBot\(\), opts\) \}/, 'core：mapImage() 留成薄包装'],
    [mapSrc, /export function isUnderground \(b\) \{/, 'map-render：isUnderground(b)'],
    [mapSrc, /export function caveCell \(b, x, cy, z, slab\) \{/, 'map-render：caveCell()（原来叫 #caveCell，第十一刀搬过去的）'],
    [mapSrc, /const cave = mode === 'cave' \|\| \(mode !== 'surface' && isUnderground\(b\)\)/, 'map-render：auto 模式按 isUnderground(b) 自动切'],
    [mapSrc, /export function mapImageOf \(b, \{ radius = 32, scale = 4, yTop = 10, yBottom = -24, markSelf = true, mode = 'auto', slab = 2, layer = null, depth = 4 \} = \{\}\)/, 'map-render：mapImageOf 也接 mode/slab（2026-10-15 起还接 floor 的 layer/depth）'],
    [strip(idx), /mode: \{ type: 'string'/, 'index：mc_map 有 mode 参数'],
    [strip(idx), /slab: \{ type: 'number'/, 'index：mc_map 有 slab 参数'],
    [strip(idx), /heightmap\(\{ radius: args\.radius, yTop: args\.yTop, yBottom: args\.yBottom, mode, slab \}\)/, 'index：把 mode/slab 传进 heightmap'],
    [strip(idx), /scale: args\.scale, mode, slab,/, 'index：把 mode/slab 传进 mapImage'],
    [strip(idx), /🕳️ 洞穴层图 中心/, 'index：文案区分"洞穴层图"'],
    [strip(idx), /const legendText = hm\.legend\.slice\(0, 15\)/, 'index：图例渲染抽成 legendText'],
    [strip(idx), /e\?\.glyph \? `\$\{e\.glyph\}\$\{e\.name\}×\$\{e\.count\}`/, 'index：图例渲染认 glyph（洞穴层）'],
    [strip(idx), /洞穴层俯视图/, 'index：图像文案区分洞穴层'],
    /* ── 2026-10-15：地板层视图（用户需求）── */
    [names, /export const FLOOR_GLYPH = \{/, 'block-names：地板层字形表'],
    [names, /export const isSolidBlock = /, 'block-names：isSolidBlock（实心判据，与 isPassable 互补但不等价）'],
    [mapSrc, /export function floorMapOf \(b, \{ radius = 32, layer = null, depth = 4 \} = \{\}\)/, 'map-render：floorMapOf()（脚下方块那一层）'],
    [mapSrc, /export function gridToWorld \(row, col, map\)/, 'map-render：gridToWorld（行列 ⇒ 真实坐标）'],
    [mapSrc, /export function navSummaryOf \(map, \{ purpose = 'overview', target = null \} = \{\}\)/, 'map-render：navSummaryOf（purpose 摘要）'],
    [strip(idx), /purpose: \{ type: 'string'/, 'index：mc_map 有 purpose 参数'],
    [strip(idx), /floorMapOf\(sess\.bot\.requireBot\(\), \{ radius: args\.radius, layer: args\.layer, depth: args\.depth \}\)/, 'index：floor 模式走 floorMapOf'],
    [strip(idx), /navSummaryOf\(hm, \{ purpose, target: args\.target \}\)/, 'index：purpose 摘要接 navSummaryOf'],
    [strip(idx), /🪨 地板层图/, 'index：文案区分"地板层图"'],
  ]
  for (const [src, re, label] of checks) ok(re.test(src), label)
  ok(!/this\.#caveCell/.test(core) && !/#caveCell \(b, x, cy, z, slab\) \{/.test(core),
    'core：没有残留的 #caveCell（第十一刀搬走了 —— 别只搬不接）')
  ok(!/export \{[^}]*\} from '\.\/map-render\.mjs'/.test(core),
    'core：没有多写 re-export（公开面靠四个同名薄包装）')
  ok(!/hm\.legend\.slice\(0, 15\)\.join\(' '\)/.test(strip(idx)),
    '顺手修掉的老 bug：图例不再是 [object Object]（以前 legend 是对象却直接 join）')
  ok(/想强制看地表就 mode:"surface"/.test(idx), '文案告诉 AI 可以 mode:"surface" 强制看地表')
  ok(/modeArg === 'auto' \|\| modeArg === 'surface' \|\| modeArg === 'cave' \? modeArg : 'floor'/.test(strip(idx)),
    'index：mc_map 默认 floor，但 auto/surface/cave 老模式一个没丢（老参数兼容）')
} finally {
  for (const d of TMP_DIRS) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
}

console.log(`\n────────────────────────────────────────────────────────────`)
console.log(`check-core-map：pass=${pass} fail=${fail}`)
process.exit(fail ? 1 : 0)
