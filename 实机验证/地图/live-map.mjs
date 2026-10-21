/**
 * live-map.mjs —— `mc_map` 三种模式的实机验证（真服 + 真方块）
 *
 * 🔴 2026-10-22 用户要求「把 cave 去掉」：洞穴层视图（`isUnderground` / `caveCell` / `CAVE_GLYPH` /
 *   `mode:"auto"` / `mode:"cave"` / `slab`）整块删除了。这个脚本也跟着重写成"剩下三种模式"的验证：
 *
 *   · `floor`（默认）—— 脚下方块那一层（`floorMapOf()`）；
 *   · `surface` —— 地表图（`heightmapOf()` 每列往下扫第一块非空气）；
 *   · `column` —— 竖列图（`columnOf()` 只看脚下这一格，往下/往上各看几格）。
 *
 * 为什么必须实机：离线套件用**假世界**（自己摆的石头/水/矿），只能证明"判据按写好的逻辑走"，
 * 证明不了真服上 `bot.blockAt()` 读得到方块、区块加载得够、图真画得出来（真 Vec3、真 heightmap）。
 *
 * 🔴 这一趟**不改世界**：不挖、不放、不破坏玩家基地。
 *
 * 用法：node live-map.mjs
 * 产物：同目录 live-map.log、live-map-core.log
 */
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const PKG = 'C:/Users/BLUE/.dsh/profiles/desktop/node_modules/dsh-mc-agent'
const HOST = '127.0.0.1'
const PORT = 25565
const NAME = 'wcmap_live'
const OUT = 'C:/Users/BLUE/Desktop/agent/dsh-mc-agent/实机验证/地图'

const req = createRequire('file:///C:/Users/BLUE/.dsh/profiles/desktop/node_modules/mineflayer/index.js')
const Vec3 = req('vec3')
const { default: McBot } = await import('file:///' + PKG + '/src/core.mjs')
const { floorMapOf, columnOf, columnText, navSummaryOf } = await import('file:///' + PKG + '/src/map-render.mjs')

const LOGFILE = join(OUT, 'live-map.log')
try { writeFileSync(LOGFILE, '') } catch { /* 忽略 */ }
const log = (...a) => {
  const s = `[${new Date().toISOString().slice(11, 19)}] ` + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
  console.log(s)
  try { appendFileSync(LOGFILE, s + '\n') } catch { /* 忽略 */ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const posStr = (p) => (p ? `(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)})` : '(?)')

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => log(`\n${t}`)

/* ───────────────── 连服 ───────────────── */
const mc = new McBot({
  instanceId: 'live-map',
  lockDir: mkdtempSync(join(tmpdir(), 'wc-map-')),
  logFile: join(OUT, 'live-map-core.log'),
})
log(`连 ${HOST}:${PORT}（${NAME}）…`)
await mc.connect({ host: HOST, port: PORT, auth: { mode: 'offline', name: NAME } })
const bot = mc.bot
await sleep(1500)
log(`连上了：${posStr(bot.entity.position)} 维度=${bot.game?.dimension} 模式=${bot.game?.gameMode} 血=${bot.health}`)
log(`附近玩家：${Object.values(bot.players ?? {}).filter((p) => p.username && p.username !== bot.username).map((p) => p.username).join(' / ') || '（没有）'}`)
const me = bot.entity.position.clone()

try {
  /* ───────────────── ① 地表图 ───────────────── */
  section('① 地表图（heightmap → mode:"surface"）：真方块读得到、图能画')
  const hm = mc.heightmap({ radius: 8 })
  ok(hm.mode === 'surface', 'heightmap() 给地表图（cave/auto 没了，只剩 surface）', `mode=${hm.mode}`)
  ok(hm.names.length === 16 && hm.names[0].length === 16, '地表图尺寸 = 2×半径', `${hm.names.length}×${hm.names[0]?.length}`)
  const glyphs = McBot.glyphMap(hm.names, 2, { x: 8, y: 8 })
  log('地表图（每格 2 字符）：\n' + glyphs)
  ok(glyphs.includes('@'), '地表图里有"我"（@）')
  ok(!/cave_/.test(JSON.stringify(hm.names)), '地表图里没有 cave_* 合成名（那些名字已经删了）')

  /* ───────────────── ② 地板层（默认模式） ───────────────── */
  section('② 地板层（默认 mode:"floor"）：脚下方块那一层')
  const fl = floorMapOf(bot, { radius: 8, depth: 4 })
  ok(fl.mode === 'floor', 'floorMapOf() ⇒ mode:"floor"', `mode=${fl.mode}`)
  ok(fl.layer && fl.layer.y === Math.floor(me.y) - 1, 'layer 默认 = 我脚底下那一格',
    `layer.y=${fl.layer?.y} 我脚=${Math.floor(me.y)}`)
  ok(fl.names.length === 16 && fl.names[0].length === 16, '地板层图尺寸 = 2×半径', `${fl.names.length}×${fl.names[0]?.length}`)
  const keys = new Set()
  for (const row of fl.names) for (const n of row) keys.add(n)
  ok([...keys].every((k) => /^floor_/.test(k)),
    '每一格都是 floor_* 合成名（没有混进方块名）', [...keys].slice(0, 4).join(','))
  ok(Array.isArray(fl.legend) && fl.legend.length > 0
    && fl.legend.every((e) => e.key && e.glyph && typeof e.count === 'number'),
  '图例带 key/glyph/count（文案靠它，不再 [object Object]）',
  fl.legend.slice(0, 4).map((e) => `${e.glyph}${e.name}×${e.count}`).join(' '))
  ok(fl.counts && typeof fl.counts.walkable === 'number', 'counts 里数出了"能站"的格数',
    `walkable=${fl.counts?.walkable} drop=${fl.counts?.drop} blocked=${fl.counts?.blocked}`)
  ok(Array.isArray(fl.hazards), '危险格 hazards 是个数组（地面上的岩浆/水/深渊）', `${fl.hazards?.length} 处`)
  const img = mc.mapImage({ radius: 8, scale: 2, mode: 'floor' })
  ok(img.width === 32 && img.height === 32 && img.rgba.length === 32 * 32 * 4, 'mapImage 跟着画地板层',
    `${img.width}×${img.height}`)
  const nav = navSummaryOf(fl, { purpose: 'navigation', target: null })
  ok(typeof nav === 'string' && nav.length > 0, '导航摘要（purpose:"navigation"）出得来', `${nav.length} 字`)

  /* ───────────────── ③ 竖列图 ───────────────── */
  section('③ 竖列图（mode:"column"）：只看脚下这一格')
  const col = columnOf(bot, { yBottom: -24, up: 8 })
  const feetY = Math.floor(me.y)
  ok(col.feetY === feetY, 'feetY = 我脚那一格', `feetY=${col.feetY}`)
  ok(col.from === feetY - 1, '默认从脚底那一格（脚 -1）往下扫', `from=${col.from}`)
  ok(Array.isArray(col.layers) && col.layers.length > 0, '往下扫出一串层', `${col.layers?.length} 格`)
  ok(col.layers.every((l, i) => i === 0 || l.y === col.layers[i - 1].y - 1), '这些层是连续的（一格一格往下）')
  ok(col.here && typeof col.here.kind === 'string', 'here 报出"我现在这一格"是什么（水/岩浆/空气）',
    `y=${col.here?.y} kind=${col.here?.kind} 方块=${col.here?.name ?? '未加载'}`)
  ok(col.above && col.above.layers.length > 0, '头顶也看了（up 参数生效）',
    `上方 ${col.above?.layers?.length} 格：y=${col.above?.from}..${col.above?.to}`)
  ok(col.x === Math.floor(me.x) && col.z === Math.floor(me.z), '没传 x/z 时用我自己那一列',
    `(${col.x}, ${col.z}) vs 我 (${Math.floor(me.x)}, ${Math.floor(me.z)})`)
  const text = columnText(col)
  log('竖列图文本：\n' + text.split('\n').map((l) => '    ' + l).join('\n'))
  ok(/🕳 竖列/.test(text) && /脚底 y=/.test(text), 'columnText() 出人话（AI 读的就是这段）')

  /* ───────────────── ④ 真服上真的能读方块吗 ───────────────── */
  section('④ 真服上 blockAt() 读得到周围方块')
  const under = bot.blockAt(new Vec3(Math.floor(me.x), feetY - 1, Math.floor(me.z)))
  ok(!!under && typeof under.name === 'string', '脚底下那格读到了（不是 null）', under?.name ?? 'null')
  const head = bot.blockAt(new Vec3(Math.floor(me.x), feetY + 1, Math.floor(me.z)))
  ok(!!head && typeof head.name === 'string', '头那一格读到了', head?.name ?? 'null')

  /* ───────────────── ⑤ 收尾 ───────────────── */
  section('⑤ 收尾')
  const me2 = bot.entity.position
  const moved = Math.hypot(me2.x - me.x, me2.y - me.y, me2.z - me.z)
  ok(moved < 1.0, '这一趟没走动、也没改世界（不挖不放）', `位移 ${moved.toFixed(2)} 格`)
} catch (e) {
  log(`\n❌ 出错：${e?.stack ?? e}`)
  fail++
} finally {
  log(`\n结果：pass=${pass} fail=${fail}`)
  try { bot.quit?.() } catch { /* 忽略 */ }
  await sleep(300)
  process.exit(fail ? 1 : 0)
}
