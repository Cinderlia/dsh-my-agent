/**
 * live-dig.mjs —— 「挖方块快到完成就重置 / 挖方块假超时 / 材料像被吞了」的实机验证
 *
 * 用户 2026-10-08 转来 AI 的原话：
 *   「合成这工具老抽风。刚才想拿原木做木板，卡了两次，材料像是被吞了。
 *     挖方块也老报"超时"，其实方块早挖掉了。我慢慢磨吧」
 *
 * 三条根因（离线套件已验，这里验**真服上的行为**）：
 *   ① 到点松手 ⇒ 破坏进度清零：`breakBlock` 现在**时间不够就不开始挖**，
 *      如实回 `broken:false` + note"我没开始挖"，而不是挖到八成被掐断。
 *   ② `mc_dig` 会冲出 DSH 层的工具超时（旧日志：`Error: tool call timed out after 6000ms`，
 *      而方块其实已经挖掉了）⇒ 现在 deadline 留 900ms 收尾，`#cancelCollect` 也计入预算。
 *   ③ `mc_craft {count:N}` 在"背包已经够了"时回 `✅ 合成完成（0 步）`，读起来像做过了
 *      ⇒ 现在如实回"一个都没做"；要"再做 N 个"用 `more:true`。
 *      另外**每次动手前把 2×2 合成格里的东西点回背包**（以前掐断后材料留在格子里，
 *      `bot.inventory` 看不见 ⇒ 报"缺料"，下次合成拿错位的格子号去点 ⇒ 服务端"格子里剩什么就做什么"）。
 *
 * 用法：node live-dig.mjs [账号名]
 *   ⚠️ 账号的**位置会存到服务端**：同一个名字再连，会回到上次下线的地方。`wcdig_live` 有一次正好
 *   停在 4 格深的坑里（四周上不去、身上没垫脚方块 ⇒ `collectBlock` 够不着上面的树），整段备料就废了。
 *   换个新名字就回到世界出生点（开阔地），所以默认名带 `_live`，要重跑就传一个新名字。
 *
 * 产物：同目录 live-dig.log + live-dig-core.log
 */
import { createRequire } from 'node:module'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PKG = 'C:/Users/BLUE/.dsh/profiles/desktop/node_modules/dsh-mc-agent'
const HOST = '127.0.0.1'
const PORT = 25565
const NAME = process.argv[2] || 'wcdig_live'
const OUT = 'C:/Users/BLUE/Desktop/agent/dsh-mc-agent/实机验证/挖方块'
const CALL_MS = 11_000

const req = createRequire('file:///C:/Users/BLUE/.dsh/profiles/desktop/node_modules/mineflayer/index.js')
const Vec3 = req('vec3')
const { default: McBot } = await import('file:///' + PKG + '/src/core.mjs')
const craftExt = await import('file:///' + PKG + '/extensions/mc_craft.mjs')

const LOGFILE = join(OUT, 'live-dig.log')
try { writeFileSync(LOGFILE, '') } catch { /* 忽略 */ }
const log = (...a) => {
  const s = `[${new Date().toISOString().slice(11, 19)}] ` + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
  console.log(s)
  try { appendFileSync(LOGFILE, s + '\n') } catch { /* 忽略 */ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const posStr = (p) => `(${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)})`
const countOf = (bot, n) => bot.inventory.items().filter((i) => i.name === n).reduce((a, i) => a + i.count, 0)
const slotOf = (bot, n) => {
  const slots = bot.inventory.slots ?? []
  for (let i = 9; i < slots.length; i++) if (slots[i]?.name === n) return i
  return -1
}
const nameAt = (bot, x, y, z) => {
  try { return bot.blockAt(new Vec3(x, y, z))?.name ?? null } catch { return null }
}
const gridNames = (bot) => {
  const slots = bot.inventory.slots ?? []
  return [1, 2, 3, 4].map((i) => slots[i]).filter(Boolean).map((it) => `${it.name}x${it.count}`)
}

let pass = 0, fail = 0, skipped = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const skip = (why) => { skipped++; log(`  ⏭ ${why}（跳过，不算失败）`) }
const section = (t) => log(`\n${t}`)

/* ───────────────── 假宿主：只挂 mc_craft ───────────────── */
const registered = new Map()
const sessions = new Map()
await craftExt.apply({
  ctx: {
    tools: { register: (d) => registered.set(d.name, d), guard: () => {}, get: () => undefined },
    on: () => () => {},
    get: () => undefined,
    logger: { info: () => {}, warn: (m) => log('[craft warn]', String(m)) },
  },
  config: {},
  registry: { peek: (id) => sessions.get(String(id)), listSessions: () => [...sessions.values()] },
  asTool: (s) => s,
  getSession: (exec) => sessions.get(String(exec?.agent?.id)),
  memory: {}, memoryFor: () => ({}), workspaceOf: () => null,
  logLine: (l) => log('[craft]', String(l)),
  ensureWatchdog: () => {},
  Watchdog: class {},
})
const craftTool = registered.get('mc_craft')
const EXEC = { agent: { id: 'live' } }
const craft = async (args) => {
  mc.setCallDeadline(CALL_MS)
  const t0 = Date.now()
  const r = await craftTool.execute(args, EXEC)
  return { text: String(r?.text ?? JSON.stringify(r)), ms: Date.now() - t0 }
}

/* ───────────────── 连服 ───────────────── */
const mc = new McBot({
  instanceId: 'live-dig',
  lockDir: mkdtempSync(join(tmpdir(), 'wc-dig-')),
  logFile: join(OUT, 'live-dig-core.log'),
})
// 🔴 扩展里的 `mc` 是 `sess.bot` —— 会话对象要包一层 `{ bot: mc }`
sessions.set('live', { agentId: 'live', bot: mc })

log(`连 ${HOST}:${PORT}（${NAME}）…`)
await mc.connect({ host: HOST, port: PORT, auth: { mode: 'offline', name: NAME } })
const bot = mc.bot
const dug = []              // 我挖掉的格子（收尾对账用）
const remember = (x, y, z, was) => dug.push({ x, y, z, was })
log(`连上了：${posStr(bot.entity.position)} 版本=${bot.version} 模式=${bot.game?.gameMode} 血=${bot.health} 食物=${bot.food}`)
// 🔴 刚连上时区块还没发全，`findBlocks` 会报"附近什么都没有"（第一次跑就栽在这：128 格内 0 根原木）
try { await mc.waitForChunks() } catch { /* 忽略 */ }
await sleep(3000)
log(`背包：${bot.inventory.items().map((i) => `${i.name}x${i.count}`).join(' ') || '（空）'}`)

/** 分几次走过去（每次 4 秒，走不到就再叫一次） */
const goNear = async (x, y, z, within = 3.2, tries = 8) => {
  for (let i = 0; i < tries; i++) {
    const me = bot.entity.position
    if (Math.hypot(me.x - x, me.y - y, me.z - z) <= within) return true
    mc.setCallDeadline(CALL_MS)
    try { await mc.walkTo({ x, y, z }, { arrive: Math.max(1, within - 0.5), budget: 4000 }) } catch { /* 下一轮再试 */ }
  }
  const me = bot.entity.position
  return Math.hypot(me.x - x, me.y - y, me.z - z) <= within + 1
}

/** 挑一棵"好够着"的树：先按 3D 距离排，优先**和我在同一层**（|dy| ≤ 3）的那几棵。
 *  （第一版直接拿最近的那棵，结果它在 4 格高的坡上，collectBlock 够不着 ⇒ 白跑一趟） */
const pickLog = (maxDistance = 128) => {
  const me = bot.entity.position
  const all = bot.findBlocks({ matching: (b) => /_log$/.test(b?.name ?? ''), maxDistance, count: 200 })
    .map((p) => ({ p, d: me.distanceTo(p), dy: Math.abs(p.y - me.y) }))
    .sort((a, b) => a.d - b.d)
  return all.find((x) => x.dy <= 3) ?? all[0] ?? null
}

/* ───────────────── ⓪ 采 3 根原木（备料：木镐 + 工作台）───────────────── */
section('⓪ 采 3 根原木：`mc.dig` 必须**在工具超时前**返回（旧 bug：tool call timed out after 6000ms）')
{
  const tried = new Set()
  let got = 0
  for (let round = 1; round <= 4; round++) {
    got = countOf(bot, 'oak_log') + countOf(bot, 'birch_log') + countOf(bot, 'jungle_log') + countOf(bot, 'spruce_log')
    if (got >= 3) break
    const cand = pickLog(128)
    if (!cand) { skip('128 格内没有原木（这片被清过）—— 备料做不了，后面的合成段也跳过'); break }
    const key = `${cand.p.x},${cand.p.y},${cand.p.z}`
    if (tried.has(key)) {
      // 换一棵：把最近的几个里没试过的挑出来
      const me = bot.entity.position
      const next = bot.findBlocks({ matching: (b) => /_log$/.test(b?.name ?? ''), maxDistance: 128, count: 200 })
        .map((p) => ({ p, d: me.distanceTo(p), dy: Math.abs(p.y - me.y) }))
        .sort((a, b) => a.d - b.d)
        .find((x) => !tried.has(`${x.p.x},${x.p.y},${x.p.z}`) && x.dy <= 3)
      if (!next) { log(`  试过的树都够不着，先停（已有 ${got} 根原木）`); break }
      cand.p = next.p
    }
    tried.add(`${cand.p.x},${cand.p.y},${cand.p.z}`)
    log(`第 ${round} 轮：挑中 ${nameAt(bot, cand.p.x, cand.p.y, cand.p.z)} @ ${posStr(cand.p)} ${cand.d.toFixed(1)} 格（|dy|=${cand.dy}）`)
    await goNear(cand.p.x, cand.p.y, cand.p.z, 3.5, 10)
    log(`  走到 ${posStr(bot.entity.position)}，离目标 ${bot.entity.position.distanceTo(cand.p).toFixed(1)} 格`)
    mc.setCallDeadline(CALL_MS)
    const t0 = Date.now()
    let r = null
    try { r = await mc.dig({ name: nameAt(bot, cand.p.x, cand.p.y, cand.p.z) ?? 'oak_log', count: 3, maxDistance: 32 }) } catch (e) { log(`  挖出错：${e?.message}`) }
    const ms = Date.now() - t0
    const now = countOf(bot, 'oak_log') + countOf(bot, 'birch_log') + countOf(bot, 'jungle_log') + countOf(bot, 'spruce_log')
    log(`  dig 返回（${ms}ms）：${JSON.stringify(r)?.slice(0, 300)} ｜ 原木 ${got} → ${now}`)
    ok(ms < CALL_MS + 1_500, `第 ${round} 轮：**在工具超时（${CALL_MS + 1_000}ms）前返回**`, `${ms}ms`)
  }
  got = countOf(bot, 'oak_log') + countOf(bot, 'birch_log') + countOf(bot, 'jungle_log') + countOf(bot, 'spruce_log')
  ok(got > 0 || skipped > 0, '至少挖到一根原木（备料够不够看下一段）', `原木 ${got}`)
}

/* ───────────────── ① 备料：木板 → 木棍 → 工作台 → 木镐（后面两条要有木板、④ 要有镐）───────────────── */
let WOOD = null
section('① 备料：原木 → 木板 → 木棍 → 工作台 → 木镐（后面 ②③ 要有木板、④ 要有镐）')
{
  const logs = countOf(bot, 'oak_log') + countOf(bot, 'birch_log') + countOf(bot, 'jungle_log') + countOf(bot, 'spruce_log')
  if (logs < 1) {
    skip('没有原木 —— 做不出木板和镐，后面几段都跳过')
  } else {
    WOOD = countOf(bot, 'oak_log') > 0 ? 'oak_planks' : (countOf(bot, 'birch_log') > 0 ? 'birch_planks' : (countOf(bot, 'jungle_log') > 0 ? 'jungle_planks' : 'spruce_planks'))
    for (const [name, count] of [[WOOD, 4], ['stick', 4], ['crafting_table', 1], ['wooden_pickaxe', 1]]) {
      const r = await craft({ name, count })
      log(`  craft ${name} ×${count}（${r.ms}ms）：${r.text.replace(/\n/g, ' | ').slice(0, 200)}`)
    }
    const pick = bot.inventory.items().find((i) => /pickaxe$/.test(i.name))
    if (!pick) {
      skip('木镐没做出来（材料不够）—— 挖石头段跳过')
    } else {
      mc.setCallDeadline(CALL_MS)
      await mc.equip({ name: pick.name })
      ok(bot.heldItem?.name === pick.name, '把木镐拿到手上了', String(bot.heldItem?.name))
    }
  }
}

/* ───────────────── ② 合成：count 语义（"已经够了"必须如实说没做）───────────────── */
section('② `mc_craft {count:N}` 在"已经够了"时必须如实说"一个都没做"（旧版回 ✅ 合成完成，模型以为做过了）')
{
  const planksBefore = WOOD ? countOf(bot, WOOD) : 0
  if (!WOOD || planksBefore <= 0) {
    skip('背包里一块木板都没有 —— 这条要"已经够了"才成立')
  } else {
    const r = await craft({ name: WOOD, count: 1 })
    const planksAfter = countOf(bot, WOOD)
    log(`返回（${r.ms}ms）：${r.text.replace(/\n/g, ' | ')}`)
    ok(/一个都没做/.test(r.text), '如实说"一个都没做"（不是 ✅ 合成完成）', r.text.replace(/\n/g, ' | ').slice(0, 160))
    ok(!/✅ 合成完成/.test(r.text), '**不**再说"✅ 合成完成"')
    ok(/more:true/.test(r.text), '教它"要再做就加 more:true"')
    ok(planksAfter === planksBefore, '背包数量没变（真的没做）', `${planksBefore} → ${planksAfter}`)
    // 顺手验 more:true 真能"再做"
    const logs2 = countOf(bot, 'oak_log') + countOf(bot, 'birch_log') + countOf(bot, 'jungle_log') + countOf(bot, 'spruce_log')
    if (logs2 > 0) {
      const r2 = await craft({ name: WOOD, count: 1, more: true })
      const after2 = countOf(bot, WOOD)
      log(`more:true 返回（${r2.ms}ms）：${r2.text.replace(/\n/g, ' | ')}`)
      ok(after2 > planksBefore, '`more:true` 真的又做了 1 块（在现有基础上加）', `${planksBefore} → ${after2}`)
    } else {
      skip('没有原木了 —— 没验 more:true 真做')
    }
  }
}

/* ───────────────── ③ 2×2 合成格：动手前把格子里的东西点回背包 ───────────────── */
section('③ 2×2 合成格里的东西：动手前点回背包（旧版留在格子里 ⇒ 报"缺料" + 服务端拿错位的格子号去点）')
{
  const pname = WOOD && countOf(bot, WOOD) > 0 ? WOOD : null
  if (!pname) {
    skip('背包里没有木板 —— 没法往合成格里塞')
  } else {
    const slot = slotOf(bot, pname)
    await bot.moveSlotItem(slot, 1)      // 往 2×2 合成格的第 1 格塞一块
    await sleep(400)
    const inGrid = gridNames(bot)
    log(`合成格现在：${inGrid.join('、') || '（空）'}`)
    ok(inGrid.some((s) => s.startsWith(pname)), '塞进去了（合成格里有东西）', inGrid.join('、'))
    const r = await craft({ name: 'stick', count: 2 })
    log(`返回（${r.ms}ms）：${r.text.replace(/\n/g, ' | ')}`)
    ok(/合成格里还剩/.test(r.text) || gridNames(bot).length === 0, '动手前把合成格里的东西点回背包了', gridNames(bot).join('、') || '（格子里已经空了）')
    ok(gridNames(bot).length === 0, '合成格现在是空的', gridNames(bot).join('、') || '（空）')
  }
}

/* ───────────────── ④ 挖石头：时间不够就不开始挖；时间够就真挖掉 ───────────────── */
section('④ `mc_act {mode:"break"}`：这一轮只剩 1.3 秒 ⇒ **一个挖矿包都不发**（别挖到八成松手、进度清零）')
{
  const hasPick = /pickaxe$/.test(bot.heldItem?.name ?? '')
  const stones = bot.findBlocks({ matching: (b) => b?.name === 'stone', maxDistance: 24, count: 30 })
  if (!hasPick) {
    skip('手上没有镐 —— 挖石头会被直接拒绝（那是另一条路），这条验的是"有镐但时间不够"')
  } else if (!stones.length) {
    skip('24 格内没有石头')
  } else {
    const st = stones.map((p) => ({ p, d: bot.entity.position.distanceTo(p) })).sort((a, b) => a.d - b.d)[0]
    log(`最近的石头 @ ${posStr(st.p)} ${st.d.toFixed(1)} 格`)
    await goNear(st.p.x, st.p.y, st.p.z, 3.5)
    const was = nameAt(bot, st.p.x, st.p.y, st.p.z)

    // ④a 只剩 1.3 秒 ⇒ 不该开始挖
    mc.setCallDeadline(1_300)
    const t0 = Date.now()
    let r = null
    try { r = await mc.breakBlock({ x: st.p.x, y: st.p.y, z: st.p.z }) } catch (e) { r = { error: e?.message } }
    const ms = Date.now() - t0
    log(`breakBlock（${ms}ms，预算 1300ms）：${JSON.stringify(r)}`)
    ok(ms < 1_000, '立刻返回（没开始挖就不用等）', `${ms}ms`)
    ok(r?.broken === false, '如实回 broken:false', JSON.stringify(r)?.slice(0, 200))
    ok(/没开始挖/.test(r?.note ?? ''), 'note 说清"我没开始挖"', String(r?.note).slice(0, 90))
    ok(/进度会清零/.test(r?.note ?? ''), 'note 说清"挖一半到点松手，破坏进度会清零"', String(r?.note).slice(0, 150))
    ok(Number.isFinite(r?.digMs), '带上 digMs（这块按手上的镐要几毫秒）', String(r?.digMs))
    ok(nameAt(bot, st.p.x, st.p.y, st.p.z) === was, '世界没变（真的没开始挖）', `${was} → ${nameAt(bot, st.p.x, st.p.y, st.p.z)}`)

    // ④b 给足预算 ⇒ 真挖掉，而且必须报 broken=stone
    mc.setCallDeadline(CALL_MS)
    const t1 = Date.now()
    let r2 = null
    try { r2 = await mc.breakBlock({ x: st.p.x, y: st.p.y, z: st.p.z }) } catch (e) { r2 = { error: e?.message } }
    const ms2 = Date.now() - t1
    log(`breakBlock（${ms2}ms，预算 ${CALL_MS}ms）：${JSON.stringify(r2)}`)
    ok(ms2 < CALL_MS + 500, '在预算内返回', `${ms2}ms`)
    ok(r2?.broken === was, '真挖掉了，如实报 broken=方块名', String(r2?.broken))
    ok(nameAt(bot, st.p.x, st.p.y, st.p.z) === 'air', '方块真的没了', String(nameAt(bot, st.p.x, st.p.y, st.p.z)))
    ok(Number(r2?.digMs) < 3_000, '木镐挖石头只要 1 秒出头（不是 37.5 秒的徒手）', String(r2?.digMs))
    if (r2?.broken === was) remember(st.p.x, st.p.y, st.p.z, was)
  }
}

/* ───────────────── ⑤ 挖远目标：够不着也要在工具超时前返回 ───────────────── */
section('⑤ 挖一个 20+ 格外的目标：够不着也得**在工具超时前**返回（旧版会 tool call timed out）')
{
  const far = (() => {
    const me = bot.entity.position
    return bot.findBlocks({ matching: (b) => /_log$/.test(b?.name ?? ''), maxDistance: 48, count: 40 })
      .map((p) => ({ p, d: me.distanceTo(p), dy: Math.abs(p.y - me.y) }))
      .filter((x) => x.d > 18 && x.dy <= 3)
      .sort((a, b) => a.d - b.d)[0]
  })()
  if (!far) {
    skip('48 格内没有 18 格外还够不着的原木')
  } else {
    log(`目标：${nameAt(bot, far.p.x, far.p.y, far.p.z)} @ ${posStr(far.p)} ${far.d.toFixed(1)} 格（**不走过去**）`)
    mc.setCallDeadline(CALL_MS)
    const t0 = Date.now()
    let r = null
    try { r = await mc.dig({ name: nameAt(bot, far.p.x, far.p.y, far.p.z) ?? 'oak_log', count: 1, maxDistance: 48 }) } catch (e) { r = { error: e?.message } }
    const ms = Date.now() - t0
    const txt = typeof r === 'string' ? r : JSON.stringify(r)
    log(`dig 返回（${ms}ms）：${String(txt).slice(0, 400)}`)
    ok(ms < CALL_MS + 1_500, `**在工具超时（${CALL_MS + 1_000}ms）前返回**（旧版这里会 tool call timed out）`, `${ms}ms`)
    ok(/够不着|走不过去|先 mc_move|没挖|这一轮/.test(String(txt)), '如实说明"够不着/没挖到"并给出下一步', String(txt).slice(0, 160))
  }
}

/* ───────────────── ⑥ 收尾：把挖出来的坑填回去 ───────────────── */
section('⑥ 收尾：填回挖掉的格子 + 对账')
{
  mc.setCallDeadline(CALL_MS)
  for (const d of dug) {
    const cur = nameAt(bot, d.x, d.y, d.z)
    if (cur !== 'air') continue
    const fill = countOf(bot, 'cobblestone') > 0 ? 'cobblestone' : (countOf(bot, 'dirt') > 0 ? 'dirt' : null)
    if (!fill) { log(`  （没有填坑的方块，${d.x},${d.y},${d.z} 先留着）`); continue }
    await goNear(d.x, d.y, d.z, 3.5, 3)
    mc.setCallDeadline(CALL_MS)
    try {
      const r = await mc.placeBlock({ x: d.x, y: d.y, z: d.z, name: fill })
      log(`  填 ${d.x},${d.y},${d.z} ← ${fill}：${JSON.stringify(r)?.slice(0, 160)}`)
    } catch (e) { log(`  填 ${d.x},${d.y},${d.z} 失败：${e?.message}`) }
  }
  const left = dug.filter((d) => nameAt(bot, d.x, d.y, d.z) === 'air')
  log(`我挖过 ${dug.length} 格，收尾后还是 air 的：${left.length}${left.length ? '（' + left.map((d) => `${d.x},${d.y},${d.z}`).join(' / ') + '）' : ''}`)
  ok(left.length === 0 || !dug.length, '挖掉的格子都填回去了', `${dug.length - left.length}/${dug.length}`)
  log(`背包：${bot.inventory.items().map((i) => `${i.name}x${i.count}`).join(' ') || '（空）'}`)
  log(`血=${bot.health} 食物=${bot.food} 位置=${posStr(bot.entity.position)}`)
}

log(`\n────────────────────────────────────────────`)
log(`live-dig：pass=${pass} fail=${fail}${skipped ? ` 跳过 ${skipped}` : ''}`)
try { await mc.disconnect('实机验证结束') } catch { /* 忽略 */ }
process.exit(fail ? 1 : 0)
