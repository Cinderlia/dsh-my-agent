/**
 * live-inventory.mjs —— 「背包数字不会数两遍」+「缺料报整条链条」的实机验证（真服 + 真配方）
 *
 * 为什么必须实机：合计逻辑离线能验（`tools\check-core-inventory.mjs`），但**模型看到的那段文字**、
 * 以及 `mc_craft` 缺料时链条上到底写了哪些名字，得用真的 `recipes.json` 跑一遍才算数。
 *
 * 主验（不需要任何材料）：空背包调 `mc_craft {name:"crafting_table"}` ⇒ 应该报
 *
 *     ❌ 原料不够，做不了：
 *       · oak_log：需要 1，背包里有 0（没有配方：这个物品不能合成，要去挖/找（或名字写错了））
 *           ↳ 卡在 **oak_planks**：要 4、现在只有 0（差 4）｜链条：crafting_table → oak_planks → oak_log
 *       → 木板：**要同一种木头**（…）
 *
 * 这正是用户 2026-10-07 转来的现场（"我手上4个木板它非说不算，让我去砍原木"）会看到的形状 ——
 * 旧版只报最后一行"oak_log：需要 1，背包里有 0"，模型就以为"工作台要用原木做"。
 *
 * 顺带验（有材料时才做，没有就跳过、不算失败）：砍 1 根原木 → 4 木板 → 用 2 块做木棍
 * ⇒ 手上正好剩 2 块木板，这时 `mc_inventory` 应该说 `背包（同名已合计）：oak_planksx2 …`，
 * **不能**把同一叠印两遍（旧版会印 `held: oak_planksx2` + 列表里再来一条 `oak_planksx2`，
 * 模型于是数成 4 块）。只从世界上拿 1 根原木，不放置任何方块。
 *
 * 用法：node live-inventory.mjs
 * 产物：同目录 live-inventory.log + live-inventory-core.log
 */
import { createRequire } from 'node:module'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PKG = 'C:/Users/BLUE/.dsh/profiles/desktop/node_modules/dsh-mc-agent'
const HOST = '127.0.0.1'
const PORT = 25565
const NAME = 'wcinv_live'
const OUT = 'C:/Users/BLUE/Desktop/agent/dsh-mc-agent/实机验证/背包'

const req = createRequire('file:///C:/Users/BLUE/.dsh/profiles/desktop/node_modules/mineflayer/index.js')
const Vec3 = req('vec3')
const { default: McBot } = await import('file:///' + PKG + '/src/core.mjs')
const craftExt = await import('file:///' + PKG + '/extensions/mc_craft.mjs')

const LOGFILE = join(OUT, 'live-inventory.log')
try { writeFileSync(LOGFILE, '') } catch { /* 忽略 */ }
const log = (...a) => {
  const s = `[${new Date().toISOString().slice(11, 19)}] ` + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
  console.log(s)
  try { appendFileSync(LOGFILE, s + '\n') } catch { /* 忽略 */ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const posStr = (p) => `(${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)})`
const countOf = (bot, n) => bot.inventory.items().filter((i) => i.name === n).reduce((a, i) => a + i.count, 0)

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
  mc.setCallDeadline(10_000)
  const r = await craftTool.execute(args, EXEC)
  return String(r?.text ?? JSON.stringify(r))
}

/* ───────────────── 连服 ───────────────── */
const mc = new McBot({
  instanceId: 'live-inventory',
  lockDir: mkdtempSync(join(tmpdir(), 'wc-inv-')),
  logFile: join(OUT, 'live-inventory-core.log'),
})
// 🔴 扩展里的 `mc` 是 `sess.bot` —— 会话对象要包一层 `{ bot: mc }`（直接塞 McBot 会
//    报 `mc.requireBot is not a function`：那层 `mc` 其实被当成裸 mineflayer bot 用了）
sessions.set('live', { agentId: 'live', bot: mc })

log(`连 ${HOST}:${PORT}（${NAME}）…`)
await mc.connect({ host: HOST, port: PORT, auth: { mode: 'offline', name: NAME } })
const bot = mc.bot
log(`连上了：${posStr(bot.entity.position)} 维度=${bot.game?.dimension} 模式=${bot.game?.gameMode} 血=${bot.health}`)
log(`附近玩家：${Object.values(bot.players ?? {}).filter((p) => p.username && p.username !== bot.username).map((p) => p.username).join(' / ') || '（没有）'}`)

/* ───────────────── ⓪ 背包文字（空背包也要读得懂）───────────────── */
section('⓪ mc.inventory() 的文字（空背包）')
{
  const inv = mc.inventory()
  log(`text：${String(inv.text).replace(/\n/g, ' | ')}`)
  ok(typeof inv.text === 'string' && inv.text.length > 0, '回 text（宿主直接渲染它）')
  ok(Array.isArray(inv.items), 'items 仍是数组（扩展按它打"背包：…"）')
  ok(inv.text.includes('手上：') && inv.text.includes('背包'), '两行都在（手上 / 背包）')
  ok(inv.text.includes('别再加一遍') || inv.text.includes('背包：空'), '空手时有话说（要么提醒别加一遍、要么直说空）')
  ok(/共 \d+ 格 \/ \d+ 样/.test(String(inv.text)), '给了"几格 / 几样"的总数', (String(inv.text).match(/共 [^\n]*/) ?? [''])[0])
}

/* ───────────────── ① 空背包缺料：链条 + "同一种木头"（主验）───────────────── */
section('① 空背包 mc_craft crafting_table：报链条，别只说"缺原木"')
{
  const text = await craft({ name: 'crafting_table' })
  log(`返回：${text.replace(/\n/g, ' | ')}`)
  ok(/原料不够|做不了/.test(text), '如实报"做不了"')
  ok(text.includes('卡在'), '点名"卡在"哪一步', text.replace(/\n/g, ' | '))
  ok(text.includes('oak_planks'), '点名的就是木板（不是原木）')
  ok(/要 4、现在只有 0/.test(text), '写清"要 4、现在只有 0"', text.replace(/\n/g, ' | '))
  ok(/链条：crafting_table → oak_planks → oak_log/.test(text), '摆出完整链条 crafting_table → oak_planks → oak_log', text.replace(/\n/g, ' | '))
  ok(text.includes('同一种木头'), '提醒"要同一种木头"（用户踩的就是这个：混着木种凑不齐）')
  ok(/mc_dig \{[^}]*oak_log/.test(text), '给出可执行的下一步（砍 1 根原木）', text.replace(/\n/g, ' | '))
}

/* ───────────────── ② 换一条配方链（stick）也要报链条 ───────────────── */
section('② 空背包 mc_craft stick：链条要从 stick 起头')
{
  const text = await craft({ name: 'stick' })
  log(`返回：${text.replace(/\n/g, ' | ')}`)
  ok(/链条：stick → oak_planks → oak_log/.test(text), '链条：stick → oak_planks → oak_log', text.replace(/\n/g, ' | '))
  ok(/要 2、现在只有 0/.test(text), '木板那一步按"要 2"算', text.replace(/\n/g, ' | '))
}

/* ───────────────── ③ 有材料才做：正好 2 块木板 ⇒ 同一叠不许印两遍 ───────────────── */
section('③ 顺带验：砍 1 根原木 → 4 木板 → 用 2 块做木棍 ⇒ 手上剩 2 块木板')
{
  let wood = null
  let planks = null
  const LOGRE = /_log$/
  for (let round = 1; round <= 2 && !wood; round++) {
    const found = bot.findBlocks({ matching: (b) => LOGRE.test(b?.name ?? ''), maxDistance: 128, count: 60 })
    log(`第 ${round} 轮：128 格内找到 ${found.length} 根原木`)
    if (!found.length) break
    const near = found.slice().sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
    const pick = near.slice(0, 6).sort((a, b) => b.y - a.y)[0]
    const nm = bot.blockAt(new Vec3(pick.x, pick.y, pick.z))?.name ?? null
    const d = pick.distanceTo(bot.entity.position)
    log(`挑中：${nm} @ ${posStr(pick)}（${d.toFixed(1)} 格）`)
    if (!nm) continue
    if (d > 8) {
      log('  先走过去（预算 10 秒，可能要走两趟）…')
      try { log(`  walkTo：${JSON.stringify(await mc.walkTo({ x: pick.x, y: pick.y, z: pick.z }, { arrive: 4, budget: 10_000 })).slice(0, 160)}`) } catch (e) { log(`  walkTo 失败：${e?.message}`) }
    }
    mc.setCallDeadline(10_000)
    log(`  dig 返回：${JSON.stringify(await mc.dig({ pos: { x: pick.x, y: pick.y, z: pick.z }, maxDistance: 8 })).slice(0, 200)}`)
    await sleep(500)
    if (countOf(bot, nm) > 0) { wood = nm; planks = nm.replace(/_log$/, '') + '_planks' }
    else log('  这一根没挖到，再来一轮')
  }

  if (!wood) {
    skip('128 格内没找到原木（这片地被清过了），"正好 2 块木板"那段验不成 —— 链条那段已经在 ① ② 验过')
  } else {
    ok(true, `拿到 ${wood}（${countOf(bot, wood)} 根）`)
    const t1 = await craft({ name: planks })
    log(`mc_craft ${planks}：${t1.replace(/\n/g, ' | ').slice(0, 200)}`)
    await sleep(300)
    ok(countOf(bot, planks) === 4, `拿到 4 块 ${planks}`, `实际 ${countOf(bot, planks)}`)

    const t2 = await craft({ name: 'stick' })
    log(`mc_craft stick：${t2.replace(/\n/g, ' | ').slice(0, 200)}`)
    await sleep(300)
    ok(countOf(bot, planks) === 2, '用掉 2 块木板 ⇒ 手上正好剩 2 块（复现用户现场）', `实际 ${countOf(bot, planks)}`)

    const inv = mc.inventory()
    const text = String(inv.text)
    log(`text：${text.replace(/\n/g, ' | ')}`)
    const entries = inv.items.filter((i) => i.name === planks)
    ok(entries.length === 1 && entries[0].count === 2, `items 里 ${planks} 只有一条、数量 2`, JSON.stringify(entries))
    const bagLine = (text.split('\n').find((l) => l.startsWith('背包')) ?? '')
    ok(bagLine.split(planks + 'x').length - 1 === 1, `"背包"那行里 ${planks} 只出现一次（旧版印两遍 ⇒ 模型数成 4）`, bagLine)
    ok(!text.includes(`${planks}x4`), `不会出现 ${planks}x4`, text.replace(/\n/g, ' | '))
    ok(text.includes('别再加一遍'), '明说"手上那叠已经算在合计里，别再加一遍"')

    const t3 = await craft({ name: 'crafting_table' })
    log(`mc_craft crafting_table（只有 2 块）：${t3.replace(/\n/g, ' | ')}`)
    ok(/要 4、现在只有 2/.test(t3), '写清"要 4、现在只有 2"', t3.replace(/\n/g, ' | '))
    ok(new RegExp(`链条：crafting_table → ${planks} → ${wood}`).test(t3), `链条指向 ${wood}`, t3.replace(/\n/g, ' | '))
    ok(t3.includes('同一种木头'), '提醒"要同一种木头"')
  }
}

/* ───────────────── ④ 收尾 ───────────────── */
section('④ 收尾')
{
  const inv = mc.inventory()
  log(`最终背包：${JSON.stringify(inv.items)}`)
  log(`世界改动：最多挖掉 1 根原木（挑的树顶那根），没有放置任何方块`)
  log(`剩下的东西留在 ${NAME} 这个测试账号身上（不影响玩家和 AI 的背包）`)
  try { await mc.disconnect('实机验证结束') } catch { /* 忽略 */ }
}
log(`\n结果：pass=${pass} fail=${fail}（跳过 ${skipped}）`)
process.exit(fail === 0 ? 0 : 1)
