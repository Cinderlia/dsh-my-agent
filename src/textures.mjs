/**
 * 官方方块贴图（从本机 Minecraft 客户端 jar 里取，运行时不联网、不随包分发）
 *
 * 为什么要它：`mc_observe` 的渲染器原本只用 `block-names.mjs` 里一张手写调色板 ——
 * 石头是一块灰、草方块是一块绿，形状对但"看着不像 Minecraft"。真正的方块贴图在
 * 客户端 jar 的 `assets/minecraft/textures/block/*.png` 里，本机装了客户端就有。
 *
 * 做法（一次建库、之后秒开）：
 *   1. 扫 `%APPDATA%\.minecraft\versions\*\*.jar`，挑一个里面有方块贴图的（可用
 *      `DSH_MC_CLIENT_JAR` 指定；也可以 `DSH_MC_TEXTURES=off` 整个关掉）；
 *   2. 只解出 `assets/minecraft/textures/block/*.png`（约 1400 张，每张几百字节）；
 *   3. 用 sharp 解成 16×16 RGBA，拼成一整块 `atlas.bin` + `atlas.json`（名字 → 序号、
 *      以及"是不是灰度图"标记 —— 灰度图（草/树叶/草叶）要按方块本身的颜色上色，
 *      否则会画成灰白）；
 *   4. 渲染时按 (方块名, 面) 查序号、按 UV 取像素；查不到就**照旧用调色板**。
 *
 * 设计约束：
 *   - **不给渲染器加异步**：像素循环是同步的，所以贴图必须在渲染前就整块读进内存；
 *   - **失败必须无声**：没有客户端、没装 sharp、jar 坏了 —— 一律返回 null，渲染器退回调色板，
 *     不让"没贴图"变成"看不了"。
 *   - 不依赖任何新 npm 包：ZIP 自己解（只用 `node:zlib` 的 inflateRaw），解码复用已有的 sharp。
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 贴图边长（原版 16×16；个别高清材质会被缩到 16）。 */
export const TILE = 16
const TILE_BYTES = TILE * TILE * 4
const BLOCK_PREFIX = 'assets/minecraft/textures/block/'

/* ────────────────────────── ZIP（只读、只解需要的那几个条目） ────────────────────────── */

function readEocd (fd, size) {
  const tail = Math.min(size, 0x10000)
  if (tail < 22) return null
  const buf = Buffer.alloc(tail)
  readSync(fd, buf, 0, tail, size - tail)
  for (let i = tail - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) !== 0x06054b50) continue
    return { cdSize: buf.readUInt32LE(i + 12), cdOffset: buf.readUInt32LE(i + 16) }
  }
  return null
}

function listZip (fd, size) {
  const e = readEocd(fd, size)
  if (e === null || e.cdSize === 0) return []
  const cd = Buffer.alloc(e.cdSize)
  readSync(fd, cd, 0, e.cdSize, e.cdOffset)
  const out = []
  let o = 0
  while (o + 46 <= cd.length && cd.readUInt32LE(o) === 0x02014b50) {
    const method = cd.readUInt16LE(o + 10)
    const csize = cd.readUInt32LE(o + 20)
    const nlen = cd.readUInt16LE(o + 28)
    const elen = cd.readUInt16LE(o + 30)
    const clen = cd.readUInt16LE(o + 32)
    const lho = cd.readUInt32LE(o + 42)
    out.push({ name: cd.toString('utf8', o + 46, o + 46 + nlen), method, csize, lho })
    o += 46 + nlen + elen + clen
  }
  return out
}

function readZipEntry (fd, ent) {
  const lh = Buffer.alloc(30)
  readSync(fd, lh, 0, 30, ent.lho)
  const nlen = lh.readUInt16LE(26)
  const elen = lh.readUInt16LE(28)
  const data = Buffer.alloc(ent.csize)
  readSync(fd, data, 0, ent.csize, ent.lho + 30 + nlen + elen)
  return ent.method === 0 ? data : inflateRawSync(data)
}

/** ZIP 里的方块贴图条目名（`oak_log.png` 这种，不含路径与后缀）。 */
export function blockTextureNames (jarPath) {
  const fd = openSync(jarPath, 'r')
  try {
    const size = statSync(jarPath).size
    const out = []
    for (const e of listZip(fd, size)) {
      if (!e.name.startsWith(BLOCK_PREFIX) || !e.name.endsWith('.png')) continue
      const short = e.name.slice(BLOCK_PREFIX.length, -4)
      if (short !== '' && !short.includes('/')) out.push(short)
    }
    return out
  } finally {
    closeSync(fd)
  }
}

/* ────────────────────────── 找客户端 jar ────────────────────────── */

export function minecraftDir () {
  if (process.env.DSH_MC_MINECRAFT_DIR) return process.env.DSH_MC_MINECRAFT_DIR
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  return join(appData, '.minecraft')
}

/**
 * 候选客户端 jar，最新的排前面。
 * 只做"有没有"的粗筛（文件名像不像），真正的判据是里面有没有方块贴图。
 */
export function findClientJars ({ dir = minecraftDir() } = {}) {
  const vdir = join(dir, 'versions')
  if (!existsSync(vdir)) return []
  const out = []
  for (const v of readdirSync(vdir)) {
    const sub = join(vdir, v)
    let st
    try { st = statSync(sub) } catch { continue }
    if (!st.isDirectory()) continue
    for (const f of readdirSync(sub)) {
      if (!f.endsWith('.jar')) continue
      const p = join(sub, f)
      try { out.push({ path: p, tag: f.replace(/\.jar$/, ''), mtime: statSync(p).mtimeMs, size: statSync(p).size }) } catch { /* 忽略 */ }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

/* ────────────────────────── 建库 ────────────────────────── */

/**
 * 原版**会在游戏里被染色**的贴图（草、草叶）—— 它们的 png 是灰白的，直接画会发灰。
 * 别的贴图（石头、砂砾、矿石…）本来就是本来的颜色，**一律不许染**：
 * 早先用"饱和度低就算灰度"来猜，结果把 stone/cobblestone/玻璃/矿石全判成灰度，
 * 全被调色板染了一遍，反而失真。所以改成按名字白名单。
 */
const TINTED_NAME = /^(grass_block_top|grass_block_side_overlay|short_grass|tall_grass|fern|large_fern|potted_fern|vine|crimson_roots|warped_roots|nether_sprouts)$/

async function decodeTile (sharp, png) {
  const img = sharp(png, { failOn: 'none' }).ensureAlpha()
  const meta = await img.metadata()
  const w = meta.width ?? TILE
  const h = meta.height ?? TILE
  let pipe = sharp(png, { failOn: 'none' }).ensureAlpha()
  // 动画贴图是 16×(16·N) 的竖条：只取第一帧
  if (h > w) pipe = pipe.extract({ left: 0, top: 0, width: w, height: Math.min(h, w) })
  if (w !== TILE || Math.min(h, w) !== TILE) pipe = pipe.resize(TILE, TILE, { kernel: 'nearest' })
  const { data } = await pipe.raw().toBuffer({ resolveWithObject: true })
  if (data.length < TILE_BYTES) return null
  return data.subarray(0, TILE_BYTES)
}

/**
 * 方块贴图目录之外，还想收的几类贴图（贴到方块面上能认出来）。
 * `short` 是存进库里的前缀，避免和 block 目录重名。
 */
const EXTRA_TEXTURES = [
  { prefix: 'assets/minecraft/textures/entity/chest/', short: 'entity:chest/', re: /^[a-z_]+$/ },
  { prefix: 'assets/minecraft/textures/entity/shulker/', short: 'entity:shulker/', re: /^shulker(_[a-z_]+)?$/ },
  { prefix: 'assets/minecraft/textures/item/', short: 'item:', re: /^[a-z_]+_bed$/ },
]

/** jar 条目列表 → `{ e, short, block }`（block=false 表示来自 EXTRA_TEXTURES）。 */
function collectEntries (all) {
  const out = []
  for (const e of all) {
    if (!e.name.endsWith('.png')) continue
    if (e.name.startsWith(BLOCK_PREFIX)) {
      out.push({ e, short: e.name.slice(BLOCK_PREFIX.length, -4), block: true })
      continue
    }
    for (const x of EXTRA_TEXTURES) {
      if (!e.name.startsWith(x.prefix)) continue
      const short = e.name.slice(x.prefix.length, -4)
      if (short.includes('/') || !x.re.test(short) || /_(left|right)$/.test(short)) break
      out.push({ e, short: x.short + short, block: false })
      break
    }
  }
  return out
}

/**
 * 从客户端 jar 建贴图库。返回 `{ tag, names, gray, data }` 或 `null`（任何失败都算"没有"）。
 */
export async function buildAtlas (jarPath, { log = () => {} } = {}) {
  let sharp
  try { ({ default: sharp } = await import('sharp')) } catch { return null }
  if (!jarPath || !existsSync(jarPath)) return null
  const fd = openSync(jarPath, 'r')
  let entries
  try {
    entries = collectEntries(listZip(fd, statSync(jarPath).size))
    const names = []
    const chunks = []
    const gray = []
    for (const { e, short, block } of entries) {
      if (block && (short === '' || short.includes('/'))) continue
      let tile
      try { tile = await decodeTile(sharp, readZipEntry(fd, e)) } catch { tile = null }
      if (tile === null) continue
      names.push(short)
      gray.push(TINTED_NAME.test(short) ? 1 : 0)
      chunks.push(tile)
    }
    if (names.length === 0) return null
    log(`贴图库：从 ${jarPath} 解出 ${names.length} 张方块贴图`)
    return { tag: jarPath, names, gray, data: Buffer.concat(chunks, names.length * TILE_BYTES) }
  } finally {
    closeSync(fd)
  }
}

/* ────────────────────────── 落盘缓存 ────────────────────────── */

export function defaultCacheDir () {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'dsh-mc-agent', 'textures')
}

/** 贴图库内容格式版本：改了 buildAtlas / textureCandidates 就 +1，旧缓存自动作废。 */
export const ATLAS_VERSION = 2

export function saveAtlas (dir, atlas) {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'atlas.bin'), atlas.data)
    writeFileSync(join(dir, 'atlas.json'), JSON.stringify({ v: ATLAS_VERSION, tag: atlas.tag, tile: TILE, names: atlas.names, gray: atlas.gray }))
    return true
  } catch { return false }
}

export function loadAtlas (dir) {
  try {
    const meta = JSON.parse(readFileSync(join(dir, 'atlas.json'), 'utf8'))
    if (meta?.v !== ATLAS_VERSION || meta?.tile !== TILE || !Array.isArray(meta.names) || meta.names.length === 0) return null
    const data = readFileSync(join(dir, 'atlas.bin'))
    if (data.length < meta.names.length * TILE_BYTES) return null
    return { tag: meta.tag ?? 'cache', names: meta.names, gray: meta.gray ?? meta.names.map(() => 0), data }
  } catch { return null }
}

/* ────────────────────────── 方块名 → 贴图名 ────────────────────────── */

const WOODS = new Set(['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'bamboo', 'crimson', 'warped', 'pale_oak'])
/** 建筑构件：`stone_slab` → `stone`、`oak_stairs` → `oak`（再经 WOODS 变成 `oak_planks`）。 */
const SHAPE_SUFFIX = /_(slab|stairs|wall|fence_gate|fence|door|trapdoor|button|pressure_plate|carpet|pane|bars|sign|hanging_sign)$/
/** 少数方块的贴图名跟方块名不在一条线上，单独列。 */
/** 方块名跟贴图名对不上、又不是简单前后缀的，列在这里（优先于通用规则）。 */
const VARIANTS = {
  wheat: 'wheat_stage7',
  carrots: 'carrots_stage3',
  potatoes: 'potatoes_stage3',
  beetroots: 'beetroots_stage3',
  nether_wart: 'nether_wart_stage2',
  cocoa: 'cocoa_stage2',
  torchflower_crop: 'torchflower_crop_stage1',
  pitcher_crop: 'pitcher_crop_top_stage3',
  fire: 'fire_0',
  soul_fire: 'soul_fire_0',
  redstone_wire: 'redstone_dust_dot',
  tripwire: 'tripwire',
  suspicious_sand: 'suspicious_sand_0',
  suspicious_gravel: 'suspicious_gravel_0',
  dispenser: 'dispenser_front',
  dropper: 'dropper_front',
  observer: 'observer_front',
  piston: 'piston_top',
  sticky_piston: 'piston_top_sticky',
  piston_head: 'piston_top',
  chest: 'entity:chest/normal',
  trapped_chest: 'entity:chest/trapped',
  ender_chest: 'entity:chest/ender',
  copper_chest: 'entity:chest/copper',
  shulker_box: 'entity:shulker/shulker',
  magma_block: 'magma',
  water_cauldron: 'cauldron',
  lava_cauldron: 'cauldron',
  powder_snow_cauldron: 'cauldron',
  bamboo_sapling: 'bamboo_stalk',
  pitcher_plant: 'pitcher_crop_top',
  dried_kelp_block: 'dried_kelp_side',
  moss_carpet: 'moss_block',
  bamboo_sapling: 'bamboo',
  copper_wall_torch: 'copper_torch',
  copper_torch: 'copper_torch',
  pitcher_plant: 'pitcher_crop_top_stage3',
  petrified_oak_slab: 'oak_planks',
  quartz_stairs: 'quartz_block_side',
  quartz_slab: 'quartz_block_side',
  smooth_quartz: 'quartz_block_bottom',
  smooth_sandstone: 'sandstone_top',
  smooth_red_sandstone: 'red_sandstone_top',
  light_weighted_pressure_plate: 'gold_block',
  heavy_weighted_pressure_plate: 'iron_block',
  flower_pot: 'flower_pot',
}

const SPECIAL = {
  wall_torch: { top: 'torch', side: 'torch', bottom: 'torch' },
  soul_wall_torch: { top: 'soul_torch', side: 'soul_torch', bottom: 'soul_torch' },
  redstone_wall_torch: { top: 'redstone_torch', side: 'redstone_torch', bottom: 'redstone_torch' },
  grass_block: { top: 'grass_block_top', side: 'grass_block_side', bottom: 'dirt' },
  mycelium: { top: 'mycelium_top', side: 'mycelium_side', bottom: 'dirt' },
  podzol: { top: 'podzol_top', side: 'podzol_side', bottom: 'dirt' },
  farmland: { top: 'farmland', side: 'dirt', bottom: 'dirt' },
  dirt_path: { top: 'dirt_path_top', side: 'dirt_path_side', bottom: 'dirt' },
  snow_block: { top: 'snow', side: 'snow', bottom: 'snow' },
  cake: { top: 'cake_top', side: 'cake_side', bottom: 'cake_bottom' },
  cauldron: { top: 'cauldron_top', side: 'cauldron_side', bottom: 'cauldron_bottom' },
  water: { top: 'water_still', side: 'water_still', bottom: 'water_still' },
  lava: { top: 'lava_still', side: 'lava_still', bottom: 'lava_still' },
}

/** 液体单独处理：静止水/流动水是两张贴图，靠方块属性（level / falling）分。 */
const FLUID_TEXTURES = {
  water: { still: 'water_still', flow: 'water_flow', overlay: 'water_overlay' },
  lava: { still: 'lava_still', flow: 'lava_flow' },
}

/** 液体的 `level`/`falling` 属性 → 该画流动贴图吗。 */
export function isFlowingFluid (props) {
  if (!props) return false
  const lvl = Number(props.level ?? 0)
  if (Number.isFinite(lvl) && lvl > 0) return true
  const f = props.falling
  return f === true || f === 'true'
}

/** 剥装饰性前缀：返回从"只剥打蜡"到"全剥"的中间名（不含原名）。 */
function peelNames (b) {
  const out = []
  const a = b.replace(/^waxed_/, '')
  if (a !== b) out.push(a)
  const base = out.length > 0 ? out[0] : b
  const c = base.replace(/^(?:weathered_|exposed_|oxidized_)+/, '')
  if (c !== base) out.push(c)
  const last = out.length > 0 ? out[out.length - 1] : b
  const d = last.replace(/^infested_/, '')
  if (d !== last) out.push(d)
  return out
}

function stripMinecraft (name) {
  return String(name).replace(/^minecraft:/, '')
}

/** 这个方块可能对应哪些贴图名（按优先级）。 */
export function textureCandidates (blockName, axis, step, props = null) {
  const b = stripMinecraft(blockName)
  const face = axis === 1 ? (step > 0 ? 'top' : 'bottom') : 'side'
  const out = []
  const push = (n) => { if (n && !out.includes(n)) out.push(n) }
  const fl = FLUID_TEXTURES[b]
  if (fl) {
    if (isFlowingFluid(props)) push(fl.flow)
    push(fl.still)
    return out
  }
  const sp = SPECIAL[b]
  if (sp && sp[face]) push(sp[face])
  if (sp && sp.top && face !== 'bottom') push(sp.top)
  // 名字变体：oak_wood→oak_log、red_bed→item:red_bed、<色>_shulker_box→entity:shulker/…
  // 剥掉纯装饰性前缀后重试（waxed_copper_block→copper_block、infested_stone→stone）
  // 纯装饰前缀（打蜡 / 风化 / 虫蚀 / 盆栽）一层一层剥，剥一次试一次（别叠加剥成 copper）
  for (const v of peelNames(b)) { push(v); push(`${v}_top`); push(`${v}_side`); push(`${v}s`) }
  if (/_copper_chest$/.test(b)) push('entity:chest/copper')
  if (b.startsWith('potted_')) push('flower_pot')
  if (VARIANTS[b]) push(VARIANTS[b])
  if (/_wood$/.test(b)) push(`${b.slice(0, -5)}_log`)
  if (/_hyphae$/.test(b)) push(`${b.slice(0, -7)}_stem`)
  if (/_wall_hanging_sign$/.test(b)) push(`${b.slice(0, -18)}_hanging_sign`)
  else if (/_wall_sign$/.test(b)) push(`${b.slice(0, -10)}_sign`)
  if (/_wall_fan$/.test(b)) push(`${b.replace(/_wall_fan$/, '')}_fan`)
  if (/_cauldron$/.test(b)) push(face === 'top' ? 'cauldron_top' : face === 'bottom' ? 'cauldron_bottom' : 'cauldron_side')
  if (/(?:^|_)candle_cake$/.test(b)) { push(face === 'top' ? 'cake_top' : 'cake_side') }
  if (/_bed$/.test(b)) push(`item:${b}`)
  if (/_shulker_box$/.test(b)) {
    const color = b.slice(0, -12)
    push(color === '' ? 'entity:shulker/shulker' : `entity:shulker/shulker_${color}`)
  }
  push(b)
  if (face === 'top') push(`${b}_top`)
  if (face === 'bottom') push(`${b}_bottom`)
  if (face === 'side') push(`${b}_side`)
  if (face === 'side') push(`${b}_front`)
  const m = SHAPE_SUFFIX.exec(b)
  if (m) {
    const raw = b.slice(0, -m[0].length)
    const base = peelNames(raw)[0] ?? raw
    if (VARIANTS[base]) push(VARIANTS[base])
    if (face === 'top' && SPECIAL[base]?.top) push(SPECIAL[base].top)
    if (face === 'side' && SPECIAL[base]?.side) push(SPECIAL[base].side)
    push(base)
    push(`${base}s`)
    push(`${base}_block`)
    push(`${base}_planks`)
    push(`${base}_wool`)
    if (face === 'top') { push(`${base}_top`); push(`${base}s_top`) }
    if (face === 'side') { push(`${base}_side`); push(`${base}s_side`) }
    if (face === 'bottom') push(`${base}_bottom`)
  }
  if (WOODS.has(b)) push(`${b}_planks`)
  return out
}

/* ────────────────────────── 运行时查询 ────────────────────────── */

/**
 * 只读的贴图库视图。像素循环里每帧调用成千上万次，所以查表结果全部缓存。
 */
export class TextureAtlas {
  constructor (atlas) {
    this.tag = atlas.tag ?? 'atlas'
    this.names = atlas.names
    this.gray = atlas.gray ?? []
    this.data = atlas.data
    this.index = new Map()
    this.names.forEach((n, i) => { if (!this.index.has(n)) this.index.set(n, i) })
    this.cache = new Map()
    this.hits = 0
    this.misses = 0
    this.missing = new Set()
  }

  get size () { return this.names.length }

  /** 方块名 + 面 → 贴图序号（-1 = 没有）。 */
  resolve (blockName, axis, step, props = null) {
    const flowing = FLUID_TEXTURES[stripMinecraft(blockName)] ? isFlowingFluid(props) : null
    const key = `${blockName}|${axis}|${step}|${flowing === null ? '' : flowing ? 'f' : 's'}`
    const cached = this.cache.get(key)
    if (cached !== undefined) return cached
    let found = -1
    for (const cand of textureCandidates(blockName, axis, step, props)) {
      const i = this.index.get(cand)
      if (i !== undefined) { found = i; break }
    }
    if (found < 0) found = this.prefixLookup(stripMinecraft(blockName))
    if (found < 0 && !this.missing.has(stripMinecraft(blockName))) this.missing.add(stripMinecraft(blockName))
    if (this.cache.size > 16384) this.cache.clear()
    this.cache.set(key, found)
    return found
  }

  /**
   * 兜底：找不到精确名时，退而求其次用「以方块名开头」的贴图（`fire` → `fire_0`、
   * `dispenser` → `dispenser_front`）。取字典序最大的那个（`_stage7` 通常排最后）。
   */
  prefixLookup (base) {
    if (base.length < 3) return -1
    let best = -1
    let bestName = null
    for (let i = 0; i < this.names.length; i++) {
      const n = this.names[i]
      if (n.length <= base.length + 1 || !n.startsWith(base) || n.charCodeAt(base.length) !== 95) continue
      if (bestName === null || n > bestName) { bestName = n; best = i }
    }
    return best
  }

  /**
   * 取一个像素。`uv` 是方块面内的 0..1 坐标；`tint` 是调色板颜色（灰度贴图按它上色）。
   * 返回 `[r,g,b]`，或 `null`（这个方块没贴图）。
   */
  sample (blockName, axis, step, u, v, tint, props = null) {
    const i = this.resolve(blockName, axis, step, props)
    if (i < 0) { this.misses++; return null }
    this.hits++
    // 侧面/底面：面内 v 是「往上走」，而贴图第 0 行在最上面 ⇒ 要翻过来
    const vv = axis === 1 ? v : 1 - v
    let px = (u * TILE) | 0
    let py = (vv * TILE) | 0
    if (px < 0) px = 0; else if (px > TILE - 1) px = TILE - 1
    if (py < 0) py = 0; else if (py > TILE - 1) py = TILE - 1
    const o = i * TILE_BYTES + (py * TILE + px) * 4
    let r = this.data[o]
    let g = this.data[o + 1]
    let b = this.data[o + 2]
    // 透明像素（玻璃/花草的空隙）：画不出来就看穿，退回调色板颜色，别画成一坨白
    if (this.data[o + 3] < 60) return Array.isArray(tint) ? [tint[0], tint[1], tint[2]] : [150, 150, 150]
    // 水的贴图是灰度纹理（游戏里靠群系水色上色），所以液体一律按 tint 上色
    const fluid = Boolean(FLUID_TEXTURES[stripMinecraft(blockName)])
    if ((this.gray[i] === 1 || fluid) && Array.isArray(tint)) {
      r = (r * tint[0]) / 255
      g = (g * tint[1]) / 255
      b = (b * tint[2]) / 255
    }
    return [r, g, b]
  }

  stats () {
    return { tiles: this.size, hits: this.hits, misses: this.misses, missing: [...this.missing].slice(0, 8) }
  }
}

/**
 * 一套流程走完：缓存有就读缓存 → 否则找 jar 建库 → 存缓存。
 * 返回 `TextureAtlas` 或 `null`（null = 用调色板，不报错）。
 */
export async function ensureAtlas ({ cacheDir = defaultCacheDir(), dir = minecraftDir(), jar = process.env.DSH_MC_CLIENT_JAR, log = () => {}, rebuild = false } = {}) {
  if (process.env.DSH_MC_TEXTURES === 'off') return null
  if (!rebuild) {
    const cached = loadAtlas(cacheDir)
    if (cached !== null) return new TextureAtlas(cached)
  }
  const jars = jar ? [{ path: jar, tag: jar }] : findClientJars({ dir })
  for (const j of jars.slice(0, 6)) {
    try {
      if (blockTextureNames(j.path).length < 64) continue
    } catch { continue }
    try {
      const atlas = await buildAtlas(j.path, { log })
      if (atlas === null) continue
      saveAtlas(cacheDir, atlas)
      return new TextureAtlas(atlas)
    } catch { continue }
  }
  return null
}
