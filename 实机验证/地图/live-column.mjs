/**
 * live-column.mjs —— `mc_map { mode:"column" }`（竖列图）的实机验证（真服 + 真方块）
 *
 * 用户 2026-10-15 原话：「需要加一个竖向的，单格就行，让ai知道下面有没有空的方块。」
 *
 * 为什么必须实机：离线套件用的是**假世界**（自己摆的石头/土/空气），只能证明"判据按写好的逻辑走"；
 * 它**证明不了**真服上 `bot.blockAt()` 读得到方块、脚底那一格真是实心的、往下真的会读到未加载。
 *
 * 🔴 这一趟**不改世界**：不挖、不放、不破坏。只读。
 *
 * 验什么：
 *   ① 不给 x/z ⇒ 看的是**机器人自己那一格**（不是 (0,0)）；
 *   ② `from` 是**脚底那一格**（`feetY - 1`）—— 不是脚站的那格、更不是 y=0；
 *   ③ 真服上第一段是实心（站在地上时脚下总有支撑）；
 *   ④ 往下挖得够深时，**未加载 ≠ 空腔**（`?` 不能被算成"会掉下去"）；
 *   ⑤ 指定别的 x/z 也能读（同一片地面结果应当一致）；
 *   ⑥ `columnText()` 出的那几行人话里，真的回答了"几格实心、然后几格空"。
 *
 * 用法：node live-column.mjs
 * 产物：同目录 live-column.log
 */
import { createRequire } from 'node:module'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PKG = 'C:/Users/BLUE/.dsh/profiles/desktop/node_modules/dsh-mc-agent'
const HOST = '127.0.0.1'
const PORT = 25565
const NAME = 'wc_column'
const OUT = 'C:/Users/BLUE/Desktop/agent/dsh-mc-agent/实机验证/地图'

const { default: McBot } = await import('file:///' + PKG + '/src/core.mjs')
const { columnOf, columnText } = await import('file:///' + PKG + '/src/map-render.mjs')

const LOGFILE = join(OUT, 'live-column.log')
try { writeFileSync(LOGFILE, '') } catch { /* 忽略 */ }
const log = (...a) => {
  const s = `[${new Date().toISOString().slice(11, 19)}] ` + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
  console.log(s)
  try { appendFileSync(LOGFILE, s + '\n') } catch { /* 忽略 */ }
}

let pass = 0, fail = 0
const ok = (cond, what, extra = '') => {
  if (cond) { pass++; log('  ✓ ' + what + (extra ? `  ${extra}` : '')) } else { fail++; log('  ✗ ' + what + (extra ? `  ${extra}` : '')) }
}

const dir = mkdtempSync(join(tmpdir(), 'wc-column-'))
const mc = new McBot({ instanceId: NAME, logFile: join(dir, 'mc.log') })

try {
  log(`连 ${HOST}:${PORT} …`)
  await mc.connect({ host: HOST, port: PORT, auth: { mode: 'offline', name: NAME } })
  await mc.waitForChunks(20_000)
  const bot = mc.requireBot()
  const p = bot.entity.position
  const bx = Math.floor(p.x); const bz = Math.floor(p.z); const by = Math.floor(p.y)
  log(`落点 (${bx}, ${by}, ${bz})｜版本 ${bot.version}｜模式 ${bot.game?.gameMode ?? '?'}`)

  log('\n① 不给 x/z ⇒ 看机器人自己那一格')
  const col = columnOf(bot, {})
  log(JSON.stringify({ x: col.x, z: col.z, feetY: col.feetY, from: col.from, to: col.to, solidRun: col.solidRun, firstGap: col.firstGap, unloaded: col.unloaded }))
  ok(col.x === bx && col.z === bz, '看的是自己那一格（不是 (0,0)）', `(${col.x},${col.z}) vs (${bx},${bz})`)
  ok(col.feetY === by, 'feetY = 脚站的那一层', `${col.feetY} vs ${by}`)
  ok(col.from === by - 1, '🔴 from = 脚底那一格（feetY-1），不是 y=0', `from=${col.from}`)
  ok(col.layers.length === col.from - col.to + 1, '扫到的层数 = 范围长度', `${col.layers.length}`)
  ok(col.layers.every((l) => typeof l.glyph === 'string' && l.glyph.length === 1), '每层都有单字符字形')
  ok(col.layers[0]?.y === col.from && col.layers.at(-1)?.y === col.to, '层是从上往下排的（y 递减）')

  log('\n② 真服上脚底那格到底读到了什么')
  log(`  脚底 y=${col.from} → ${JSON.stringify(col.layers[0]?.name)}（kind=${col.layers[0]?.kind}）`)
  ok(['solid', 'unloaded'].includes(col.layers[0]?.kind), '脚底那格是实心或未加载（站在地上时不该是"空"）',
    `kind=${col.layers[0]?.kind}`)

  log('\n③ 未加载 ≠ 空腔')
  ok(col.layers.filter((l) => l.kind === 'unloaded').every((l) => l.name === null), 'unloaded 的层名字就是 null（没瞎猜方块名）')
  ok(col.gaps.every((g) => g.kind !== 'unloaded'), '🔴 gaps 里不许有 unloaded（"不知道" ≠ "会掉下去"）')

  log('\n④ 往下挖 64 格')
  const deep = columnOf(bot, { yBottom: -64 })
  log(JSON.stringify({ from: deep.from, to: deep.to, solidRun: deep.solidRun, gaps: deep.gaps.length, unloaded: deep.unloaded }))
  ok(deep.to === deep.from - 63, 'yBottom=-64 ⇒ 往下 64 格', `${deep.from}..${deep.to}`)
  ok(deep.layers.length === 64, '层数 64', `${deep.layers.length}`)

  log('\n⑤ 指定别的 x/z')
  const other = columnOf(bot, { x: bx + 2, z: bz, yBottom: -24 })
  ok(other.x === bx + 2 && other.z === bz, '给了 x/z 就用给的', `(${other.x},${other.z})`)
  const zero = columnOf(bot, { x: 0, z: 0, yBottom: -24 })
  ok(zero.x === 0 && zero.z === 0, '🔴 传 x=0 是"真的看 0"，不是"没传"', `(${zero.x},${zero.z})`)

  log('\n⑥ columnText() 出的人话')
  const text = columnText(col)
  for (const line of text.split('\n')) log('  | ' + line)
  ok(/🕳 竖列 \(\d+, -?\d+\)/.test(text), '抬头带坐标')
  ok(new RegExp(`脚底 y=${by}`).test(text), '抬头写清脚底高度')
  ok(/实心|空腔|未加载/.test(text), '有方块分段')
  ok(/可以放心往下挖|就会掉下去|托不住你|先停下再看一次|没加载/.test(text),
    '🔴 摘要真的回答了"下面有没有空的"')
} catch (e) {
  fail++
  log('✗ 这一轮没验成：' + (e?.message ?? e))
} finally {
  try { await mc.disconnect() } catch { /* 忽略 */ }
  log(`\n结果：${pass} ✅ / ${fail} ❌`)
  log('世界零改动（只读）。')
  process.exit(fail ? 1 : 0)
}
