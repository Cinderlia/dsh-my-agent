/**
 * 地图那一层（路线图第 ④ 条第十一刀）：俯视地形、洞穴层视图、字符图、RGBA 像素图。
 *
 * 三条约定：
 *   ① **不反向 import `core.mjs`** —— 缺什么就往下依赖 `block-names.mjs`；
 *   ② 只 import `vec3`（不是 mineflayer）：`bot.blockAt()` 必须喂**真 Vec3**，
 *      传普通 `{x,y,z}` 会在 `prismarine-world` 里报 `pos.floored is not a function`；
 *   ③ **只读、不 await、同步**：整块是同步扫描（`heightmapOf` 自带 2.5 秒软上限，
 *      到点就停并标 `truncated`，见 `tools\check-core-map.mjs` 与审计报告 ⑨）。
 *
 * 原来的 `#caveCell` 去掉井号改名 `caveCell`（模块级函数）；
 * `isUnderground` / `heightmap` / `static glyphMap` / `mapImage` 在 `core.mjs` 里
 * **留同名薄包装**（它们是公开面：`index.js`、`tools\check-core-map.mjs`、
 * `实机验证\地图\live-map.mjs` 都在用），所以这一刀不需要 re-export。
 */

import { Vec3 } from 'vec3'
import { isAir, isLiquid, isPassable, SOFT_ROOF, glyphOf, colorOf, CAVE_LABEL, CAVE_GLYPH } from './block-names.mjs'

/**
 * 我是不是"在地下"（头顶 40 格内有实心遮挡，且遮挡不是树叶/竹子/雪层这类"软顶"）。
 *
 * 🔴 用户 2026-10-08 需求：**在地下时 `mc_map` 要切成"以我为中心上下 2 格"的洞穴层视图**
 *    （像地图模组的洞穴模式）。地表图在地下只能看到头顶那层岩石，完全没用。
 * 判据只用客户端自己算得出来的事实（逐格 `blockAt`），不依赖光照/元数据。
 */
export function isUnderground (b) {
  const p = b.entity?.position
  if (!p) return false
  const x = Math.floor(p.x)
  const z = Math.floor(p.z)
  const y0 = Math.floor(p.y)
  for (let y = y0 + 2; y <= y0 + 40; y++) {
    const blk = b.blockAt(new Vec3(x, y, z))
    if (!blk) return false                       // 未加载 → 当露天（保守：地表图不会误导）
    const n = blk.name
    if (isAir(n) || isPassable(n) || SOFT_ROOF.test(String(n))) continue
    return true
  }
  return false
}

/**
 * 洞穴层视图的**一格**：判断这格能不能站、脚下有没有地面。返回 `{ key, name }`（key 见 `CAVE_GLYPH`）。
 *
 * 分两步 —— **先看我身体这两格（cy / cy+1）有没有被占，再看脚下**：
 * · 身体那两格里是方块 ⇒ 站不下（墙）；是矿 ⇒ `cave_ore`；是水/岩浆 ⇒ `cave_water`/`cave_lava`
 * · 身体那两格是空的 ⇒ 再看脚下 `slab` 格之内第一块地面：cy-1 = 正常走、cy-2 = 低一格、更低 = 会掉下去
 * · 脚下 `slab` 格内全是空的 ⇒ 再往下探 4 格（找到地面 = 会掉下去；找不到 = 深不见底/未加载）
 *
 * 🔴 别只看"最高的那块"：2 格高的巷道（天花板在 cy+2、地面在 cy-1）如果先看到天花板就会
 *    被误判成"会掉下去"。天花板高不高**不影响能不能站**，所以只查身体那两格。
 */
export function caveCell (b, x, cy, z, slab) {
  const bottom = cy - slab
  // ① 身体（cy / cy+1）被占了吗
  let block = null
  for (let y = cy + 1; y >= cy; y--) {
    const blk = b.blockAt(new Vec3(x, y, z))
    if (!blk) return { key: 'cave_void', name: null }
    if (isPassable(blk.name)) continue
    block = { y, name: blk.name }
    break
  }
  if (block) {
    if (isLiquid(block.name)) return { key: /lava/.test(block.name) ? 'cave_lava' : 'cave_water', name: block.name }
    if (/_ore$/.test(block.name)) return { key: 'cave_ore', name: block.name }
    return { key: 'cave_wall', name: block.name }
  }
  // ② 脚下 slab 格之内找地面
  for (let y = cy - 1; y >= bottom; y--) {
    const blk = b.blockAt(new Vec3(x, y, z))
    if (!blk) return { key: 'cave_void', name: null }
    if (isPassable(blk.name)) continue
    if (isLiquid(blk.name)) return { key: /lava/.test(blk.name) ? 'cave_lava' : 'cave_water', name: blk.name }
    if (y === cy - 1) return { key: 'cave_open', name: blk.name }
    if (y === cy - 2) return { key: 'cave_step', name: blk.name }
    return { key: 'cave_drop', name: blk.name }
  }
  // ③ slab 内脚下全是空的：再往下探 4 格（找不到就是"深不见底/大洞穴"）
  for (let y = bottom - 1; y >= bottom - 4; y--) {
    const blk = b.blockAt(new Vec3(x, y, z))
    if (!blk) return { key: 'cave_void', name: null }
    if (isPassable(blk.name)) continue
    if (isLiquid(blk.name)) return { key: /lava/.test(blk.name) ? 'cave_lava' : 'cave_water', name: blk.name }
    return { key: 'cave_drop', name: blk.name }
  }
  return { key: 'cave_void', name: null }
}

/**
 * 俯视地形：返回 { names（二维字符数组）, legend, center, unloaded, mode, layer? }
 *
 * `mode`：`'auto'`（默认）| `'surface'`（强制地表）| `'cave'`（强制洞穴层）。
 * `'auto'` 时由 `isUnderground()` 决定 —— **在地下自动给洞穴层视图**（用户 2026-10-08 需求）。
 * 洞穴层视图里 `names` 是 `cave_*` 合成名（`glyphOf` 把它们画成 `#·↓v~≈*?`），
 * 用 `slab` 控制上下看几格（默认 2 = 上下各 2 格，共 5 层）。
 */
export function heightmapOf (b, { radius = 32, yTop = 10, yBottom = -24, mode = 'auto', slab = 2 } = {}) {
  const R = Math.min(Math.max(radius, 4), 96)
  const cx = Math.floor(b.entity.position.x)
  const cz = Math.floor(b.entity.position.z)
  const cy = Math.floor(b.entity.position.y)
  const names = []
  const legend = new Map()
  let unloaded = 0
  /* 🔴 2026-10-08 第五份审计报告 ⑨：`heightmap`/`mapImage` 全是**同步**代码、内部没有任何
   *    `msLeft()` 检查 ⇒ radius=96 + surface 约 3.7 万格 × 最多 34 次 `blockAt`（百万级调用）
   *    会**阻塞事件循环**数秒（物理/看门狗/其它工具全停），11 秒约定形同虚设。
   *    现在给自己一个 2.5 秒的软上限：到点就停，剩下的行填 null（几何不变，标记 `truncated`）。 */
  const t0 = Date.now()
  const budgetMs = 2_500
  let truncated = false

  const cave = mode === 'cave' || (mode !== 'surface' && isUnderground(b))
  if (cave) {
    const S = Math.min(Math.max(Number(slab) || 2, 1), 8)
    for (let dz = -R; dz < R; dz++) {
      if (Date.now() - t0 > budgetMs) { truncated = true; break }
      const row = []
      for (let dx = -R; dx < R; dx++) {
        const cell = caveCell(b, cx + dx, cy, cz + dz, S)
        if (cell.key === 'cave_void') unloaded++
        legend.set(cell.key, (legend.get(cell.key) ?? 0) + 1)
        row.push(cell.key)
      }
      names.push(row)
    }
    while (names.length < R * 2) names.push(new Array(R * 2).fill('cave_void'))
    return {
      center: { x: cx, y: cy, z: cz }, radius: R, unloaded, names, truncated,
      colors: names.map((row) => row.map(colorOf)),
      mode: 'cave', layer: { y: cy, slab: S },
      ...(truncated ? { note: `范围太大，只扫了前 ${names.filter((r) => r.some((c) => c !== 'cave_void')).length} 行（剩下的行是空的）—— 想看全就调小 radius` } : {}),
      legend: [...legend.entries()].sort((a, b2) => b2[1] - a[1])
        .map(([name, count]) => ({ name: CAVE_LABEL[name] ?? name, key: name, glyph: CAVE_GLYPH[name] ?? '?', count })),
    }
  }

  for (let dz = -R; dz < R; dz++) {
    if (Date.now() - t0 > budgetMs) { truncated = true; break }
    const row = []
    for (let dx = -R; dx < R; dx++) {
      let nm = null
      for (let y = cy + yTop; y >= cy + yBottom; y--) {
        const blk = b.blockAt(new Vec3(cx + dx, y, cz + dz))
        if (!blk) { nm = null; break }
        if (!isAir(blk.name)) { nm = blk.name; break }
      }
      if (nm === null) unloaded++
      legend.set(nm ?? 'unloaded', (legend.get(nm ?? 'unloaded') ?? 0) + 1)
      row.push(nm)
    }
    names.push(row)
  }
  while (names.length < R * 2) names.push(new Array(R * 2).fill(null))
  return {
    center: { x: cx, y: cy, z: cz }, radius: R, unloaded, names, mode: 'surface', truncated,
    colors: names.map((row) => row.map(colorOf)),
    ...(truncated ? { note: '范围太大，只扫了一部分（剩下的行是空的）—— 想看全就调小 radius' } : {}),
    legend: [...legend.entries()].sort((a, b2) => b2[1] - a[1]).map(([name, count]) => ({ name, count })),
  }
}

/** 字符地形图（无视觉也能读） */
export function glyphMapText (names, step = 2, selfIndex = null) {
  const out = []
  for (let y = 0; y < names.length; y += step) {
    let line = ''
    for (let x = 0; x < names[y].length; x += step) {
      line += (selfIndex && y === selfIndex.y && x === selfIndex.x) ? '@' : glyphOf(names[y][x])
    }
    out.push(line)
  }
  return out.join('\n')
}

/**
 * 俯视地形 → RGBA 像素图（需求 7：视觉模型看图像比看字符强）。
 *
 * 字符图仍是默认（当前模型无视觉）；本方法给"有视觉的模型 / 要发给用户看"用。
 * 每格放大 scale 倍（最近邻），并在自己所在格画一个白框方便定位。
 *
 * @returns {{width:number,height:number,rgba:Uint8Array,center:object,radius:number,unloaded:number,legend:Array}}
 */
export function mapImageOf (b, { radius = 32, scale = 4, yTop = 10, yBottom = -24, markSelf = true, mode = 'auto', slab = 2 } = {}) {
  const hm = heightmapOf(b, { radius, yTop, yBottom, mode, slab })
  const h = hm.names.length
  const w = h > 0 ? hm.names[0].length : 0
  if (!w || !h) throw new Error('地形数据为空（区块可能还没加载）')

  const s = Math.min(Math.max(Number(scale) || 4, 1), 16)
  const W = w * s
  const H = h * s
  const rgba = new Uint8Array(W * H * 4)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = colorOf(hm.names[y][x])
      for (let dy = 0; dy < s; dy++) {
        const rowBase = (y * s + dy) * W
        for (let dx = 0; dx < s; dx++) {
          const o = (rowBase + x * s + dx) * 4
          rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255
        }
      }
    }
  }

  // 自己：中心格画白色外框（内芯保留原色，便于看清脚下是什么）
  if (markSelf) {
    const cx = Math.floor(w / 2) * s
    const cy = Math.floor(h / 2) * s
    const put = (px, py, c) => {
      if (px < 0 || py < 0 || px >= W || py >= H) return
      const o = (py * W + px) * 4
      rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = 255
    }
    const white = [255, 255, 255]
    for (let d = 0; d < s; d++) {
      put(cx + d, cy, white)
      put(cx + d, cy + s - 1, white)
      put(cx, cy + d, white)
      put(cx + s - 1, cy + d, white)
    }
  }

  return {
    width: W, height: H, rgba,
    center: hm.center, radius: hm.radius, unloaded: hm.unloaded,
    legend: hm.legend.slice(0, 15),
    scale: s,
  }
}
