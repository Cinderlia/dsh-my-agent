/**
 * live-map.mjs —— `mc_map`「在地下自动切洞穴层」的实机验证（真服 + 真方块）
 *
 * 为什么必须实机：离线套件用的是**假世界**（自己摆的石头/水/矿），只能证明"判据按写好的逻辑走"，
 * **证明不了真服上 `bot.blockAt()` 读得到方块、洞穴空气真的存在、图能画出来**（真 Vec3、真区块加载、
 * 真的 `cave_air`）。这一条要是假的，`mc_map` 在地下还是白给。
 *
 * 🔴 这一趟**不改世界**：不挖、不放、不破坏玩家基地。所以不去"真的钻进地下"，改成：
 *   ① 地表：`isUnderground()` 应当是 false，`heightmap()` 自动给地表图；
 *   ② 强制洞穴层：`mode:"cave"` 在真服上能出图（字形/图例/图像都对）；
 *   ③ 以我为中心**上下 8 格**：验证"层视图"真的把脚底下那几格读出来了；
 *   ④ 找脚底下的 **`cave_air`**（只有洞穴生成才会放的空气）—— 证明"地下"在这个世界里读得到；
 *   ⑤ 收尾：断开，世界零改动。
 *
 * 找不到洞穴空气 / 地表判定不符 ⇒ **如实报"这一轮验不成"**，不谎报成功。
 *
 * 用法：node live-map.mjs
 * 产物：同目录 live-map.log、live-map-core.log
 */
import { createRequire } from 'node:module'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PKG = 'C:/Users/BLUE/.dsh/profiles/desktop/node_modules/dsh-mc-agent'
const HOST = '127.0.0.1'
const PORT = 25565
const NAME = 'wcmap_live'
const OUT = 'C:/Users/BLUE/Desktop/agent/dsh-mc-agent/实机验证/地图'

const req = createRequire('file:///C:/Users/BLUE/.dsh/profiles/desktop/node_modules/mineflayer/index.js')
const Vec3 = req('vec3')
const { default: McBot, glyphOf } = await import('file:///' + PKG + '/src/core.mjs')

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
  /* ───────────────── ① 地表判定 ───────────────── */
  section('① 站在地表：应当自动给地表图')
  const under = mc.isUnderground()
  log(`isUnderground() = ${under}（我脚下/头顶那一列的实心遮挡情况）`)
  ok(typeof under === 'boolean', 'isUnderground() 在真服上能算出布尔值（没崩、没卡）')
  if (!under) {
    const hm = mc.heightmap({ radius: 8 })
    ok(hm.mode === 'surface', '露天 ⇒ heightmap() 自动给地表图', `mode=${hm.mode}`)
    ok(hm.names.length === 16 && hm.names[0].length === 16, '地表图尺寸 = 2×半径', `${hm.names.length}×${hm.names[0]?.length}`)
    const glyphs = McBot.glyphMap(hm.names, 2, { x: 8, y: 8 })
    log('地表图（每格 2 字符）：\n' + glyphs)
    ok(glyphs.includes('@'), '地表图里有"我"（@）')
  } else {
    log('  （我现在就在地下/屋里 —— 跳过"露天给地表图"那两条，下面照常验洞穴层）')
    const hm = mc.heightmap({ radius: 8 })
    ok(hm.mode === 'cave', '在地下 ⇒ heightmap() 自动给洞穴层图', `mode=${hm.mode}`)
  }

  /* ───────────────── ② 强制洞穴层 ───────────────── */
  section('② 强制洞穴层（mode:"cave"）：真方块读得到、图能画')
  const cave = mc.heightmap({ radius: 8, mode: 'cave', slab: 2 })
  ok(cave.mode === 'cave', 'mode:"cave" ⇒ 洞穴层图', `mode=${cave.mode}`)
  ok(cave.layer && cave.layer.y === Math.floor(me.y) && cave.layer.slab === 2, 'layer 报出"我这一层"',
    `y=${cave.layer?.y} slab=${cave.layer?.slab}`)
  ok(cave.names.length === 16 && cave.names[0].length === 16, '洞穴层图尺寸 = 2×半径')
  const bad = []
  for (const row of cave.names) for (const n of row) if (!/^cave_/.test(n)) bad.push(n)
  ok(bad.length === 0, '每一格都是 cave_* 合成名（没有混进方块名）', bad.slice(0, 3).join(','))
  const glyphMap = McBot.glyphMap(cave.names, 2, { x: 8, y: 8 })
  log('洞穴层图（每格 2 字符）：\n' + glyphMap)
  const onlyGlyphs = new Set(glyphMap.replace(/[\s@]/g, '').split(''))
  ok([...onlyGlyphs].every((c) => '#·↓v~≈*?'.includes(c)), '图上只有洞穴字形（#·↓v~≈*?）',
    [...onlyGlyphs].join(''))
  ok(cave.legend.length > 0 && cave.legend.every((e) => e.glyph && e.key && typeof e.count === 'number'),
    '图例带 glyph/key/count（文案靠它，不再 [object Object]）',
    cave.legend.slice(0, 4).map((e) => `${e.glyph}${e.name}×${e.count}`).join(' '))
  const img = mc.mapImage({ radius: 8, scale: 2, mode: 'cave' })
  ok(img.width === 32 && img.height === 32 && img.rgba.length === 32 * 32 * 4, 'mapImage 跟着切洞穴层',
    `${img.width}×${img.height}`)

  /* ───────────────── ③ 以我为中心上下 8 格 ───────────────── */
  section('③ 以我为中心"上下 8 格"：脚底下那几格真的读出来了')
  const deep = mc.heightmap({ radius: 6, mode: 'cave', slab: 8 })
  ok(deep.layer.slab === 8, 'slab:8 生效（上下各 8 格）', `slab=${deep.layer?.slab}`)
  const centerCol = deep.names[6].slice(6, 7)[0]
  ok(centerCol !== 'cave_void', '我这一列不是"未加载/深不见底"（真服读得到脚下的方块）', centerCol)
  log(`我这一列 = ${centerCol}（${glyphOf(centerCol)}）｜图例：` +
    deep.legend.slice(0, 6).map((e) => `${e.glyph}${e.name}×${e.count}`).join(' '))

  /* ───────────────── ④ 真服上真的有"洞穴空气"吗 ───────────────── */
  section('④ 找脚底下的 cave_air（只有洞穴生成才会放的空气）')
  const caves = bot.findBlocks({ matching: (blk) => blk?.name === 'cave_air', maxDistance: 128, count: 5 })
  ok(Array.isArray(caves), 'findBlocks 找 cave_air 没报错')
  if (caves && caves.length) {
    const list = caves.map((v) => ({ x: v.x, y: v.y, z: v.z, d: +v.distanceTo(me).toFixed(1) }))
      .sort((a, b) => a.d - b.d)
    log(`找到 ${caves.length} 个 cave_air，最近：${list.map((p) => `(${p.x},${p.y},${p.z}) ${p.d} 格`).join(' ｜ ')}`)
    const near = list[0]
    const above = bot.blockAt(new Vec3(near.x, near.y + 1, near.z))
    ok(true, '这个世界有洞穴（cave_air 读得到）—— "在地下"的判据在真服上有意义',
      `最近 ${near.d} 格，它上面是 ${above?.name ?? '未加载'}`)
  } else {
    log('  ⚠️ 128 格内没找到 cave_air —— 这一条**验不成**（如实报，不谎报成功；不计失败）')
  }

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
  try { await mc.disconnect('实机验证结束') } catch { /* 忽略 */ }
  await sleep(300)
  process.exit(fail ? 1 : 0)
}
