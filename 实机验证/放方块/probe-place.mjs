/**
 * probe-place.mjs —— 复现用户报的「一直尝试放方块」：
 *   `Error: Server refused to place cobblestone at (305, 20, -653): the block is still air`
 *
 * 现场（用户截图）：机器人站在一根**自己搭起来的 1×1 圆石柱子顶上**，
 * 想往前方**悬空**的一格放方块。
 *
 * 假设：走到 `src/place.mjs` 的「悬空 ⇒ 先垫脚」分支（:156-167），
 * 它算的 `below` 是**脚下那块**（柱子顶），于是 `placeBlock(below, {0,1,0})`
 * 的落点 = **机器人自己站着的那一格** ⇒ 服务端必然拒。
 * 而且那一次调用**不在** :170 的 try/catch 里 ⇒ 英文原文直接冒泡给模型。
 *
 * 用法：node probe-place.mjs
 */
import { createRequire } from 'node:module'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PKG = 'C:/Users/BLUE/.dsh/profiles/desktop/node_modules/dsh-mc-agent'
const HOST = '127.0.0.1'
const PORT = 25565
const NAME = 'wcplace_probe'
const OUT = 'C:/Users/BLUE/Desktop/agent/dsh-mc-agent/实机验证/放方块'

const req = createRequire('file:///' + PKG + '/index.js')
const Vec3 = req('vec3').Vec3
const { default: McBot } = await import('file:///' + PKG + '/src/core.mjs')

const LOGFILE = join(OUT, 'probe-place.log')
try { writeFileSync(LOGFILE, '') } catch { /* 忽略 */ }
const log = (...a) => {
  const s = `[${new Date().toISOString().slice(11, 19)}] ` + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
  console.log(s)
  try { appendFileSync(LOGFILE, s + '\n') } catch { /* 忽略 */ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const P = (p) => (p ? `(${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)})` : '(?)')

const state = mkdtempSync(join(tmpdir(), 'wc-place-state-'))
process.env.DSH_MC_AGENT_DIR = state

const mc = new McBot({ instanceId: 'placeprobe', lockDir: join(state, 'lock'), logFile: join(state, 'p.log') })
let pass = 0; let fail = 0
const ok = (c, label, extra = '') => { if (c) { pass++; log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) } }
const section = (t) => log(`\n══════ ${t} ══════`)

await mc.connect({ host: HOST, port: PORT, auth: { mode: 'offline', name: NAME } })
await mc.waitForChunks(20000)
const b = mc.requireBot()
const cmd = (c) => b.chat(c.startsWith('/') ? c : '/' + c)
const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (fn()) return true } catch {} await sleep(120) } return false }

/* 工地：远离出生点 */
const S = { x: 600, y: 98, z: 600 }

section('前置：造景能力')
/* 🔴 顺序必须是「先 tp、再等区块、最后 fill」——`/fill` 的目标区块没加载时它**静默无效**，
 *    然后脚本会自己骗自己说"没权限"（踩坑档案 123）。 */
await cmd(`tp ${NAME} ${S.x + 0.5} ${S.y + 1} ${S.z + 0.5}`)
await mc.waitForChunks(20000)
await until(() => b.blockAt(new Vec3(S.x, S.y - 1, S.z)) != null, 15000)
await sleep(500)
cmd(`fill ${S.x - 2} ${S.y} ${S.z - 2} ${S.x + 2} ${S.y} ${S.z + 2} stone`)
await until(() => b.blockAt(new Vec3(S.x, S.y, S.z))?.name === 'stone', 5000)
await sleep(300)
const probe = b.blockAt(new Vec3(S.x, S.y, S.z))
ok(probe?.name === 'stone', 'bot 有 OP（/fill 真的生效了）', `${P(probe?.position)} = ${probe?.name}`)
if (probe?.name !== 'stone') { log('没权限，后面的断言没意义'); await mc.disconnect(); process.exit(1) }

/* ① 站到一根 3 高的 1×1 圆石柱子顶上（复刻截图里的现场） */
section('① 站在自己搭的柱子顶上，往前方悬空处放')
cmd(`setblock ${S.x} ${S.y + 1} ${S.z} cobblestone`)
cmd(`setblock ${S.x} ${S.y + 2} ${S.z} cobblestone`)
cmd(`setblock ${S.x} ${S.y + 3} ${S.z} cobblestone`)
await sleep(400)
cmd(`give ${NAME} cobblestone 64`)
await sleep(300)
cmd(`tp ${NAME} ${S.x + 0.5} ${S.y + 4} ${S.z + 0.5}`)
await until(() => b.entity.position.y > S.y + 3.5, 8000)
await sleep(700)
const feet = b.entity.position.floored()
log(`  · 我站在 ${P(feet)}（脚下 ${P(feet.offset(0, -1, 0))} = ${b.blockAt(feet.offset(0, -1, 0))?.name}）`)
ok(b.blockAt(feet.offset(0, -1, 0))?.name === 'cobblestone', '脚下是柱子顶', b.blockAt(feet.offset(0, -1, 0))?.name)

/* 目标：与脚同高、正前方一格；周围六面**全是空气** ⇒ 必然进"悬空"分支 */
const target = feet.offset(0, 0, 1)
const around = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
  .map(([dx, dy, dz]) => b.blockAt(target.offset(dx, dy, dz))?.name ?? 'null')
log(`  · 目标 ${P(target)}，六邻：${around.join(' / ')}`)
ok(around.every((n) => n === 'air'), '目标六邻全是空气（没有可依附的面）', around.join('/'))

let err = null; let res = null
try {
  res = await mc.placeBlock({ x: target.x, y: target.y, z: target.z, name: 'cobblestone' })
} catch (e) { err = e }
log(`  · 结果：${res ? JSON.stringify(res) : '抛错 —— ' + err?.message}`)

section('② 断言')
ok(err !== null || res?.placed === false, '目标悬空时**不许**报成功', err ? '抛错' : JSON.stringify(res))
if (err) {
  const m = String(err.message)
  ok(!/^Server refused to place/i.test(m), '英文原文**不该**直接冒泡给模型（该翻译成人话）', m.slice(0, 90))
  /* 关键：报出来的坐标是"我自己站着的那一格" ⇒ 说明垫脚那一步放的是自己身上 */
  const mine = `(${feet.x}, ${feet.y}, ${feet.z})`
  ok(m.includes(mine), `错误里点名的正是"我自己站着的那格" ${mine} —— 这就是垫脚分支放错了`, m.match(/at \([^)]*\)/)?.[0] ?? m.slice(0, 80))
}
ok(b.blockAt(target)?.name !== 'cobblestone', '目标格确实没放上（不是假报）', b.blockAt(target)?.name ?? 'null')

section('收尾：拆景')
cmd(`fill ${S.x - 2} ${S.y - 1} ${S.z - 2} ${S.x + 2} ${S.y + 8} ${S.z + 2} air`)
await sleep(500)
log('  造景已拆')
log(`\n${'─'.repeat(50)}\nprobe-place：pass=${pass} fail=${fail}`)
await mc.disconnect()
process.exit(fail ? 1 : 0)
