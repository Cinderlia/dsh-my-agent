/**
 * live-column-above.mjs —— 竖列图「头顶有什么」的实机验证（真服 + 真方块）
 *
 * 用户 2026-10-18 原话：「map竖井模式加上头上有什么」。
 *
 * 为什么必须实机：离线套件用的是**假世界**（自己摆的石头/土/空气），只能证明"判据按写好的逻辑走"；
 * 它证明不了真服上 `bot.blockAt()` 在**脚上方**读得对、头那一格真的不是自己、未加载真的出现。
 *
 * 🔴 这一趟**不改世界**：不挖、不放、不破坏、不 tp。只读。
 *
 * 验什么：
 *   ① `above.from` 是 **feetY + 2**（跳过自己的脑袋），不是 feetY+1；
 *   ② 默认往上 40 格（`above.to === above.from + 39`），`up` 能改、且夹在 1..96；
 *   ③ 每一格和**独立再读一次** `bot.blockAt()` 对得上（不是自己抄自己）；
 *   ④ `headroom` 的语义：从 head 起连续几格不挡路、碰到实心/未加载就停；`ceiling` 就是它停的那一格；
 *   ⑤ `truncated` = 没碰到实心（⇒ 文案只能说"再往上没扫"，不能说"通天"）；
 *   ⑥ 上下两段**不重叠**：下面 ≤ feetY-1、上面 ≥ feetY+2；
 *   ⑦ `columnText()` 真的把那句话写出来了，且三种情形（封死 / 有几格 / 没碰到）分支对；
 *   ⑧ 头顶的水 / 岩浆和独立扫描一致。
 *
 * 用法：node live-column-above.mjs
 * 产物：同目录 live-column-above.log
 */
import { createRequire } from 'node:module'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PKG = 'C:/Users/BLUE/.dsh/profiles/desktop/node_modules/dsh-mc-agent'
const HOST = '127.0.0.1'
const PORT = 25565
const NAME = 'wc_colup'
const OUT = 'C:/Users/BLUE/Desktop/agent/dsh-mc-agent/实机验证/地图'

const { default: McBot } = await import('file:///' + PKG + '/src/core.mjs')
const { columnOf, columnText, COLUMN_UP_DEFAULT, COLUMN_UP_MAX } =
  await import('file:///' + PKG + '/src/map-render.mjs')
const _vec3 = await import('file:///' + PKG + '/node_modules/vec3/index.js')
const Vec3 = _vec3.Vec3 ?? _vec3.default

const LOGFILE = join(OUT, 'live-column-above.log')
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

const dir = mkdtempSync(join(tmpdir(), 'wc-colup-'))
const mc = new McBot({ instanceId: NAME, logFile: join(dir, 'mc.log') })

/** 独立再读一次（不经 columnOf），用来对账 */
const rawKind = (bot, x, y, z) => {
  const blk = bot.blockAt(new Vec3(x, y, z))
  if (!blk) return { kind: 'unloaded', name: null }
  const n = blk.name
  return { kind: n == null ? 'unloaded' : n, name: n }
}

try {
  log(`连 ${HOST}:${PORT} …`)
  await mc.connect({ host: HOST, port: PORT, auth: { mode: 'offline', name: NAME } })
  await mc.waitForChunks(20_000)
  const bot = mc.requireBot()
  const p = bot.entity.position
  const bx = Math.floor(p.x); const bz = Math.floor(p.z); const by = Math.floor(p.y)
  log(`落点 (${bx}, ${by}, ${bz})｜版本 ${bot.version}｜模式 ${bot.game?.gameMode ?? '?'}`)

  const col = columnOf(bot, {})
  const ab = col.above
  log('\n① 头顶从哪一格起算')
  log(JSON.stringify({ feetY: col.feetY, from: col.from, aboveFrom: ab?.from, aboveTo: ab?.to, head: ab?.head, headroom: ab?.headroom, ceiling: ab?.ceiling, truncated: ab?.truncated }))
  ok(!!ab, '返回值里有 above')
  ok(ab.from === col.feetY + 2, '🔴 头顶第一格 = 脚 + 2（跳过自己的脑袋）', `from=${ab.from} feetY=${col.feetY}`)
  ok(ab.to === ab.from + COLUMN_UP_DEFAULT - 1, `默认往上 ${COLUMN_UP_DEFAULT} 格`, `${ab.from}..${ab.to}`)
  ok(COLUMN_UP_DEFAULT === 40 && COLUMN_UP_MAX === 96, '默认 40 / 上限 96')
  ok(ab.layers.length === COLUMN_UP_DEFAULT, '层数 = 40', `${ab.layers.length}`)
  ok(ab.layers[0]?.y === ab.from && ab.layers.at(-1)?.y === ab.to, '层是从上往下排的（y 递减）')
  ok(ab.head?.y === ab.from, 'head 就是头顶第一格')

  log('\n② 每一格和独立再读对账')
  let mismatch = 0
  for (const l of ab.layers) {
    const raw = rawKind(bot, col.x, l.y, col.z)
    if (l.kind === 'unloaded') { if (raw.kind !== 'unloaded') mismatch++ }
    else if (raw.name !== l.name) mismatch++
  }
  ok(mismatch === 0, 'above.layers 每格都和 bot.blockAt() 一致', `不一致 ${mismatch} 格`)
  ok(ab.layers.filter((l) => l.kind === 'unloaded').every((l) => l.name === null), 'unloaded 的层名字就是 null（没瞎猜）')

  log('\n③ headroom 语义')
  const firstBlocker = ab.layers.findIndex((l) => l.kind === 'solid' || l.kind === 'unloaded')
  const expectHead = firstBlocker < 0 ? ab.layers.length : firstBlocker
  ok(ab.headroom === expectHead, 'headroom = 从头顶起连续"不挡路"几格', `${ab.headroom} vs ${expectHead}`)
  if (ab.ceiling) {
    ok(ab.ceiling.y === ab.from + ab.headroom, 'ceiling 就在 headroom 停下的那一格', `y=${ab.ceiling.y}`)
    ok(rawKind(bot, col.x, ab.ceiling.y, col.z).name === ab.ceiling.name, 'ceiling 的名字和独立读的一致')
  } else {
    ok(ab.truncated === true, '没碰到实心 ⇒ truncated（不替世界下结论）')
  }
  ok(ab.truncated === !ab.ceiling, 'truncated 与 ceiling 互斥')
  log(`  头顶：${ab.headroom === 0 ? '第一格就挡住' : `空 ${ab.headroom} 格`}${ab.ceiling ? `，y=${ab.ceiling.y} 是 ${ab.ceiling.name}` : '，40 格内没碰到实心'}`)

  log('\n④ 上下两段不重叠')
  ok(col.layers.every((l) => l.y <= col.feetY - 1), '下面那段全在脚底以下')
  ok(ab.layers.every((l) => l.y >= col.feetY + 2), '上面那段全在头顶以上（不含自己脑袋）')
  ok(!ab.layers.some((l) => col.layers.some((d) => d.y === l.y)), '两段 y 不重叠')

  log('\n⑤ up 参数')
  const u5 = columnOf(bot, { up: 5 })
  ok(u5.above.layers.length === 5 && u5.above.to === u5.above.from + 4, 'up=5 ⇒ 5 格', `${u5.above.from}..${u5.above.to}`)
  const u0 = columnOf(bot, { up: 0 })
  ok(u0.above.layers.length === 1, 'up=0 ⇒ 至少 1 格')
  const u999 = columnOf(bot, { up: 999 })
  ok(u999.above.layers.length === COLUMN_UP_MAX, 'up=999 ⇒ 夹到 96 格', `${u999.above.layers.length}`)

  log('\n⑥ 头顶的水 / 岩浆')
  for (const [kind, arr] of [['water', ab.hazards?.water ?? []], ['lava', ab.hazards?.lava ?? []]]) {
    let bad = 0
    for (const h of arr) {
      for (let y = h.y; y <= h.to; y++) {
        const n = rawKind(bot, col.x, y, col.z).name ?? ''
        if (!(n === kind || n.endsWith('_' + kind) || n.endsWith('_' + kind + '_') || n.includes(kind))) bad++
      }
    }
    ok(bad === 0, `above.hazards.${kind} 里的每一格独立读也是${kind === 'water' ? '水' : '岩浆'}`, bad ? `对不上 ${bad} 格` : '')
  }

  log('\n⑦ columnText() 出的人话')
  const text = columnText(col)
  for (const line of text.split('\n')) log('  | ' + line)
  ok(/🕳 竖列 \(/.test(text), '抬头还在')
  ok(new RegExp(`头顶看 y=${ab.from}\\.\\.${ab.to}`).test(text), '抬头写清头顶扫到哪')
  ok(/头顶/.test(text), '🔴 有"头顶"这一句')
  const branches = [
    [/跳不起来/, '封死'],
    [/头顶连续 \d+ 格没有实心/, '有几格'],
    [/没碰到实心|再往上没扫/, '没碰到'],
  ]
  const hit = branches.filter(([re]) => re.test(text)).map(([, n]) => n)
  ok(hit.length >= 1, '三档文案至少命中一档', hit.join('/'))
  if (ab.headroom === 0 && ab.head?.kind === 'unloaded') ok(/没加载/.test(text), '第一格没加载 ⇒ 说"不知道"')
  else if (ab.headroom === 0) ok(/跳不起来/.test(text), '第一格就挡住 ⇒ 明说"跳不起来"')
  else if (!ab.ceiling) ok(/再往上没扫/.test(text), '没碰到实心 ⇒ 说"再往上没扫"')

  log('\n⑧ 换一处再看（同一片地面）')
  const other = columnOf(bot, { x: bx + 3, z: bz + 3 })
  ok(other.above?.from === other.feetY + 2, '别的 x/z 也按脚 + 2 起算')
  log(JSON.stringify({ x: other.x, z: other.z, feetY: other.feetY, headroom: other.above?.headroom, ceiling: other.above?.ceiling }))
  log('\n⑨ 找一处**真的头顶被挡**的竖直列（不改世界，只读别的 x/z）')
  const sealed = []   // 头顶第一格就实心 ⇒ 跳不起来
  const partial = []  // 空几格然后封顶
  for (let dx = -16; dx <= 16; dx++) {
    for (let dz = -16; dz <= 16; dz++) {
      const x = bx + dx; const z = bz + dz
      let blocked = -1
      for (let k = 0; k < 12; k++) {
        const r = rawKind(bot, x, by + 2 + k, z)
        if (r.kind === 'unloaded') { blocked = -2; break }
        if (r.name && !/^(air|cave_air|void_air|water|.*_water)$/.test(r.name) && r.name !== 'short_grass' && r.name !== 'tall_grass' && !r.name.endsWith('_grass') && !r.name.endsWith('_fern') && r.name !== 'dead_bush') {
          blocked = k; break
        }
      }
      if (blocked === 0 && sealed.length < 4) sealed.push({ x, z, name: rawKind(bot, x, by + 2, z).name })
      else if (blocked > 0 && blocked <= 6 && partial.length < 4) partial.push({ x, z, gap: blocked })
      if (sealed.length >= 3 && partial.length >= 3) break
    }
  }
  log(`  找到：头顶顶死 ${sealed.length} 处 / 空几格再封顶 ${partial.length} 处`)

  if (sealed.length) {
    const s = sealed[0]
    const c = columnOf(bot, { x: s.x, z: s.z })
    const t = columnText(c)
    log(`  封死那列 (${s.x}, ${s.z})：headroom=${c.above.headroom} ceiling=${JSON.stringify(c.above.ceiling)}`)
    ok(c.above.headroom === 0, '头顶第一格就挡住 ⇒ headroom = 0', `${c.above.headroom}`)
    ok(c.above.ceiling && c.above.ceiling.y === c.feetY + 2, 'ceiling 就是脚 + 2', JSON.stringify(c.above.ceiling))
    ok(/跳不起来/.test(t), '🔴 文案明说"跳不起来"')
    ok(/别在原地试垫脚/.test(t), '🔴 并且点出"别在原地试垫脚"（这正是以前会去试的事）')
    ok(!/能跳、也能垫脚往上/.test(t), '不许同时说"能跳"')
  } else {
    log('  （附近 33×33 里没有"头顶第一格就实心"的列，跳过这一档）')
  }

  if (partial.length) {
    const s = partial[0]
    const c = columnOf(bot, { x: s.x, z: s.z })
    const t = columnText(c)
    log(`  半空那列 (${s.x}, ${s.z})：headroom=${c.above.headroom} ceiling=${JSON.stringify(c.above.ceiling)}`)
    ok(c.above.headroom > 0 && c.above.ceiling, '有空隙也有天花板', `headroom=${c.above.headroom}`)
    ok(new RegExp(`头顶连续 ${c.above.headroom} 格没有实心`).test(t), '🔴 文案写清"头顶连续几格没有实心"', `${c.above.headroom}`)
    ok(/能跳；但上面封住了/.test(t), '🔴 说明"能跳，但上面封住了"')
  } else {
    log('  （附近没有"空几格再封顶"的列，跳过这一档）')
  }

} catch (e) {
  fail++
  log('✗ 这一轮没验成：' + (e?.message ?? e))
} finally {
  try { await mc.disconnect() } catch { /* 忽略 */ }
  log(`\n结果：${pass} ✅ / ${fail} ❌`)
  log('世界零改动（只读）。')
  process.exit(fail ? 1 : 0)
}
