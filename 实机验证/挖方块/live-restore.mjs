/**
 * live-restore.mjs —— 「挖矿会复原 / 挖完走不了路」的实机验证（2026-10-08，用户 m19917 + m20106）
 *
 * 背景（细节见 踩坑档案.md 第 37 条）：
 *   ① `dig()` 以前把**够不着**的目标交给 `mineflayer-collectblock`（它用 `GoalLookAtBlock`，
 *      "看得见"就算到）⇒ 服务端静默拒收，而 `bot.dig()` 的 resolve 来自**客户端预测** ⇒
 *      报"挖掉了"、方块随后在眼前**复原**、`diggingTask` 永不 resolve ⇒ 采集僵尸
 *      ⇒ 之后几分钟**走不了路**（插件日志里连着 20 条 `⚠️ 上次的采集任务还在后台跑`）。
 *   ② 就算只看服务端的包也不够：服务端**拒绝**破坏时会把该位置的**原方块**用同一个
 *      `block_change` 发回来纠正客户端（`ServerPlayerGameMode` 的 reach 检查失败分支），
 *      旧代码把这条**复原包**当成"服务端认了" ⇒ 照样报「挖掉 …（服务端已确认）」。
 *
 * 这个脚本在真服上验三件事：
 *   A 够得着（眼距 ≤4.5）的方块 → 必须报"（服务端已确认）"，且**不许**出现"复原"（别把好路堵了）
 *   B 眼距 4.6–5.0 的方块（客户端 `canDigBlock` 允许 ≤5.1、服务端 reach 只有 4.5）
 *     → 临时把 `bot.game.gameMode` 改成 `creative` 骗过插件那道 4.5 守卫（**服务端仍然当我是生存**）
 *       ⇒ 服务端必然拒收 ⇒ 必须**不报成功**，而是认出"复原包"、如实说"服务端把这块改回了 X（复原）"
 *       （判定用"方块现在还在不在"：还在 = 服务端拒了 ⇒ 不许报成功；没了 = 服务端认了 ⇒ 报成功才对）
 *   C 紧接着走一小段 → 必须 `arrived: true`（没有僵尸采集任务挡路）
 *
 * 用法：node live-restore.mjs [账号名]
 *   ⚠️ 账号位置会存到服务端：同一个名字再连会回到上次下线的地方；换个新名字回世界出生点。
 * 产物：同目录 live-restore.log + live-restore-core.log
 */
import { createRequire } from 'node:module'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PKG = 'C:/Users/BLUE/.dsh/profiles/desktop/node_modules/dsh-mc-agent'
const HOST = '127.0.0.1'
const PORT = 25565
const NAME = process.argv[2] || 'wcrestore_live'
const OUT = 'C:/Users/BLUE/Desktop/agent/dsh-mc-agent/实机验证/挖方块'
const CALL_MS = 11_000
const PLUGIN_LOG = 'C:/Users/BLUE/.dsh/dsh-mc-agent/logs/dsh-mc-agent.log'

const req = createRequire('file:///C:/Users/BLUE/.dsh/profiles/desktop/node_modules/mineflayer/index.js')
const Vec3 = req('vec3')
const { default: McBot } = await import('file:///' + PKG + '/src/core.mjs')

const LOGFILE = join(OUT, 'live-restore.log')
try { writeFileSync(LOGFILE, '') } catch { /* 忽略 */ }
const log = (...a) => {
  const s = `[${new Date().toISOString().slice(11, 19)}] ` + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
  console.log(s)
  try { appendFileSync(LOGFILE, s + '\n') } catch { /* 忽略 */ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0, skipped = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const skip = (why) => { skipped++; log(`  ⏭ ${why}（跳过，不算失败）`) }
const section = (t) => log(`\n${t}`)
const posStr = (p) => `(${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)})`

/* 只挑**自然地形**的方块，绝不碰玩家放的东西（出生点就是玩家的基地）。 */
const NATURAL = new Set([
  'short_grass', 'tall_grass', 'leaf_litter', 'dandelion', 'poppy', 'azure_bluet', 'cornflower',
  'oxeye_daisy', 'fern', 'large_fern', 'dead_bush', 'bush', 'sugar_cane', 'sweet_berry_bush',
  'dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mud', 'moss_block',
  'stone', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate', 'gravel', 'sand', 'clay', 'snow_block',
  'oak_leaves', 'birch_leaves', 'jungle_leaves', 'spruce_leaves', 'dark_oak_leaves', 'acacia_leaves',
])
/* 一挖就没（不破坏地形，也没有掉落物）的植被 */
const SOFT = new Set(['short_grass', 'tall_grass', 'leaf_litter', 'dandelion', 'poppy', 'azure_bluet',
  'cornflower', 'oxeye_daisy', 'fern', 'large_fern', 'dead_bush', 'bush'])

const mc = new McBot({
  instanceId: 'live-restore',
  lockDir: mkdtempSync(join(tmpdir(), 'wc-restore-')),
  logFile: join(OUT, 'live-restore-core.log'),
})

log(`连 ${HOST}:${PORT}（${NAME}）…`)
await mc.connect({ host: HOST, port: PORT, auth: { mode: 'offline', name: NAME } })
const bot = mc.bot
try { await mc.waitForChunks() } catch { /* 忽略 */ }
await sleep(3000)
log(`连上了：${posStr(bot.entity.position)} 版本=${bot.version} 模式=${bot.game?.gameMode} 血=${bot.health}`)
log(`背包：${bot.inventory.items().map((i) => `${i.name}x${i.count}`).join(' ') || '（空）'}`)

/** 眼睛 → 方块中心（和 `#reachOf` 同一条判据：服务端就是这么算的） */
const eyeOf = () => bot.entity.position.offset(0, 1.62, 0)
const reachOf = (blk) => eyeOf().distanceTo(blk.position.offset(0.5, 0.5, 0.5))
const canSee = (blk) => { try { return typeof bot.canSeeBlock !== 'function' || bot.canSeeBlock(blk) } catch { return true } }

/** 在 8 格内挑一块自然方块，眼距落在 [min,max]，优先植被（不破坏地形） */
const pick = ({ min = 1.5, max = 4.3, softFirst = true } = {}) => {
  const all = bot.findBlocks({ matching: (x) => NATURAL.has(x?.name ?? ''), maxDistance: 8, count: 400 })
    .map((p) => bot.blockAt(new Vec3(p.x, p.y, p.z)))
    .filter((blk) => blk && blk.name && NATURAL.has(blk.name) && blk.diggable !== false && canSee(blk))
    .map((blk) => ({ blk, r: reachOf(blk), soft: SOFT.has(blk.name) }))
    .filter((x) => x.r >= min && x.r <= max)
    .sort((a, b) => (softFirst ? Number(b.soft) - Number(a.soft) : 0) || a.r - b.r)
  return all[0] ?? null
}

const pluginLogLen = () => { try { return readFileSync(PLUGIN_LOG, 'utf8').length } catch { return 0 } }
const zombiesSince = (from) => {
  try { return (readFileSync(PLUGIN_LOG, 'utf8').slice(from).match(/上次的采集任务还在后台跑/g) ?? []).length } catch { return 0 }
}

const digAt = async (blk) => {
  const p = blk.position
  mc.setCallDeadline(CALL_MS)
  const t0 = Date.now()
  const out = await mc.dig({ pos: { x: p.x, y: p.y, z: p.z } })
  return { text: out.join(' ｜ '), ms: Date.now() - t0, t0 }
}
const nameAt = (p) => { try { return bot.blockAt(p)?.name ?? '?' } catch { return '?' } }

/** 直接听**原始包**（和 `#watchServerBreak` 同一条通道），记录服务端对某个坐标说了什么。
 *  🔴 判"服务端认没认"只能靠这个 —— `bot.blockAt()` 是**客户端预测世界**（`digging.js:158` 自己写的
 *     air），服务端拒收时它照样读成 air（这就是审计①，也是 B 段第一版跑错的原因）。 */
const watchPackets = (pos) => {
  const events = []
  const onPacket = (data, meta) => {
    const nm = meta?.name
    if (nm !== 'block_change' && nm !== 'block_update') return
    const loc = data?.location ?? data?.position
    if (!loc || loc.x !== pos.x || loc.y !== pos.y || loc.z !== pos.z) return
    events.push({ at: Date.now(), name: nm, type: data.type })
  }
  try { bot._client.on('packet', onPacket) } catch { /* 忽略 */ }
  return {
    events,
    stop: () => { try { bot._client.removeListener('packet', onPacket) } catch { /* 忽略 */ } },
    /** 服务端的判决：air = 认了（新方块是空气）/ other = 拒了（把方块改回来）/ none = 什么都没说 */
    verdict: () => (events.some((e) => Number(e.type) === 0) ? 'air'
      : events.length ? 'other' : 'none'),
  }
}

/* ─────────── A 够得着：必须报"服务端已确认"，且不许说"复原" ─────────── */
section('A 够得着（眼距 ≤4.5）的方块 → 报"（服务端已确认）"，不许说"复原"')
let aPick = pick({ min: 1.5, max: 4.3, softFirst: true })
if (!aPick) aPick = pick({ min: 1.5, max: 4.3, softFirst: false })
if (!aPick) {
  skip('8 格内没有眼距 1.5–4.3 的自然方块')
} else {
  const nm = aPick.blk.name
  log(`挑中 ${nm} @ ${posStr(aPick.blk.position)}（眼距 ${aPick.r.toFixed(2)}）`)
  const zBefore = pluginLogLen()
  const r = await digAt(aPick.blk)
  const after = nameAt(aPick.blk.position)
  log(`  → ${r.text}（${r.ms}ms）｜现在那里是 ${after}`)
  ok(/服务端已确认/.test(r.text), '报"（服务端已确认）"', r.text.slice(0, 60))
  ok(!/复原/.test(r.text), '没有误报"复原"')
  ok(after !== nm, '方块真的没了（服务端认了）', `现在 ${after}`)
  ok(zombiesSince(zBefore) === 0, '这一轮没留下僵尸采集任务')
}

/* ─────────── B 够不着（服务端会拒）：必须认出"复原包"，不许报成功 ─────────── */
section('B 眼距 4.6–5.0（客户端允许、服务端 4.5 拒收）→ 报告必须和服务端的包一致')
let bPick = pick({ min: 4.6, max: 5.0, softFirst: false })
if (!bPick) {
  skip('8 格内没有眼距 4.6–5.0 的自然方块（站的位置太开阔）')
} else {
  const nm = bPick.blk.name
  log(`挑中 ${nm} @ ${posStr(bPick.blk.position)}（眼距 ${bPick.r.toFixed(2)}）`)
  const gm0 = bot.game.gameMode
  /* 骗过插件那道 4.5 守卫（它按 `bot.game.gameMode` 判创造/生存）；**服务端**仍然当我是生存。 */
  bot.game.gameMode = 'creative'
  const w = watchPackets(bPick.blk.position)
  const zBefore = pluginLogLen()
  let r
  try { r = await digAt(bPick.blk) } finally { bot.game.gameMode = gm0 }
  const v = w.verdict()
  log(`  → ${r.text}（${r.ms}ms）`)
  log(`  服务端对这个坐标说了什么：${JSON.stringify(w.events)} ⇒ 判决=${v}`
    + (w.events[0] ? `（服务端首个包在 ${w.events[0].at - r.t0}ms 到；客户端 dig 自己 ${r.ms}ms 就"完事"了）` : ''))
  log(`  （顺带看：客户端现在读到 ${nameAt(bPick.blk.position)} —— 这一格**不算数**，它是客户端预测）`)
  if (v === 'air') {
    ok(/服务端已确认/.test(r.text), '服务端发了 air ⇒ 报"（服务端已确认）"是对的', r.text.slice(0, 60))
  } else if (v === 'other') {
    ok(!/服务端已确认/.test(r.text), '服务端把方块改回来了 ⇒ 不许报"服务端已确认"', r.text.slice(0, 60))
    ok(!/^挖掉 /.test(r.text), '不许报"挖掉"')
    ok(/复原/.test(r.text) && /改回了/.test(r.text), '认出"复原包"、如实说"服务端把这块改回了 X"', r.text.slice(0, 80))
  } else {
    ok(!/服务端已确认/.test(r.text), '服务端什么都没说 ⇒ 不许报"服务端已确认"', r.text.slice(0, 70))
    ok(!/^挖掉 /.test(r.text), '不许报"挖掉"')
    ok(/没收到服务端的破坏回包/.test(r.text), '如实说"没收到服务端的破坏回包"', r.text.slice(0, 80))
  }
  ok(r.ms < 8_000, '没有干等（及时收手）', `${r.ms}ms`)
  ok(zombiesSince(zBefore) === 0, '这一轮没留下僵尸采集任务')

  /* B′ 再盯 3 秒：客户端那个"假的 air"什么时候被纠正回来（用户看到的"复原"就是这么来的） */
  const w2 = watchPackets(bPick.blk.position)
  await sleep(3000)
  w2.stop()
  log(`  3 秒内服务端又说了：${JSON.stringify(w2.events)}；客户端现在读到 ${nameAt(bPick.blk.position)}`)
}

/* ─────────── C 紧接着走路：没有僵尸任务挡路 ─────────── */
section('C 挖完立刻走一小段 → 必须真的动（修之前这里会"物理冻住"）')
{
  const me = bot.entity.position
  const target = { x: Math.floor(me.x) + 6, y: Math.floor(me.y), z: Math.floor(me.z) }
  mc.setCallDeadline(CALL_MS)
  const t0 = Date.now()
  let w = null
  try { w = await mc.walkTo(target, { arrive: 1.5, budget: 6_000 }) } catch (e) { log('walkTo 抛错：' + String(e?.message ?? e)) }
  const moved = bot.entity.position.distanceTo(me)
  log(`  → ${JSON.stringify(w)}（${Date.now() - t0}ms，实际挪了 ${moved.toFixed(2)} 格）`)
  ok(moved > 2, '真的走动了（不是 0.01 格）', `挪了 ${moved.toFixed(2)} 格`)
  ok(Boolean(w?.arrived) || moved > 4, '走到了 / 至少挪得动', `arrived=${w?.arrived} moved=${moved.toFixed(2)}`)
  const fwd = Boolean(bot.controlState?.forward)
  ok(!fwd, '控制位已松开（没按着 forward 不动）', `forward=${fwd}`)
  const busy = bot.collectBlock?.targets?.empty === false
  ok(!busy, '没有残留的采集任务', `targets.empty=${bot.collectBlock?.targets?.empty}`)
}

log(`\n结果：pass=${pass} fail=${fail}${skipped ? ` skip=${skipped}` : ''}`)
try { await mc.disconnect('实机验证结束') } catch { /* 忽略 */ }
try { rmSync(mc.cfg.lockDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
process.exit(fail === 0 ? 0 : 1)
