/* 自检：分层雷达图 + 地形图 + 展示节奏（用户 2026-10-26 的需求）
 *
 * 跑法：node tools/check-radar.mjs
 * 用假世界跑真函数 —— 不连服务器、不碰 mineflayer。
 */
import { renderRadar, renderTerrain, facingOf, assignChars, ORE_MARKS, RADAR_DEPTH, RADAR_SIDE, RADAR_LAYERS } from '../src/radar.mjs'
import { notePlaced } from '../src/bot-placed.mjs'
import { tick, startFocus, stopFocus, resetPoiMode, FOCUS_MS } from '../src/poi-mode.mjs'

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name}${extra ? ' —— ' + extra : ''}`) }
}

/* ── 假世界 ─────────────────────────────────────────────────────────────── */
function makeBot ({ fill = () => 'air', yaw = 180, pos = { x: 0, y: 70, z: 0 } } = {}) {
  const blocks = new Map()
  const key = (x, y, z) => `${x},${y},${z}`
  const bot = {
    entity: { position: { ...pos }, yaw },
    blockAt (p) {
      const name = blocks.get(key(p.x, p.y, p.z)) ?? fill({ x: p.x, y: p.y, z: p.z })
      if (name === 'unloaded') return null
      return { name, boundingBox: /air$/.test(name) ? 'empty' : 'block' }
    },
    set (x, y, z, name) { blocks.set(key(x, y, z), name) },
  }
  return bot
}

console.log('① 朝向')
ok(facingOf(180) === 'N', 'yaw 180 = 北')
ok(facingOf(0) === 'S', 'yaw 0 = 南')
ok(facingOf(90) === 'W', 'yaw 90 = 西')
ok(facingOf(270) === 'E', 'yaw 270 = 东')
ok(facingOf(350) === 'S', 'yaw 350 归到南（±45° 内）')

console.log('② 字符分配')
const ch = assignChars(['stone', 'sandstone', 'snow_block'], ['P', 'O', '?'],
  new Map([['stone', 50], ['sandstone', 10], ['snow_block', 5]]))
ok(ch.get('stone') === 'S', '数量最多的 stone 先拿到首字母 S', ch.get('stone'))
ok(new Set([...ch.values()]).size === 3, '三个方块三个不同字符', [...ch.values()].join(''))
ok(![...ch.values()].some((c) => ['P', 'O', '?'].includes(c)), '不占用预留字符')

console.log('③ 雷达图：平地草原')
{
  const b = makeBot({
    fill: ({ y }) => (y <= 69 ? 'grass_block' : 'air'),
  })
  const r = renderRadar(b)
  ok(r.ok, '渲染成功')
  ok(r.lines.length === 1 + RADAR_LAYERS + 1, `行数 = 1 标题 + ${RADAR_LAYERS} 层 + 1 字符表`, String(r.lines.length))
  ok(r.airRatio > 0.5, `空气占比 ${(r.airRatio * 100).toFixed(0)}% > 50%`)
  ok(r.text.includes('前=N'), '标题写明了朝向')
  /* 脚下那层（y=69）应当是整排 G；脚层 y=70 只有自己那格是 P */
  const feetLine = r.lines.find((l) => l.startsWith('y=70'))
  const footRows = feetLine.split(' ').slice(1).join(' ').split(' / ')
  ok(footRows.length === RADAR_DEPTH, `每层 ${RADAR_DEPTH} 行`, String(footRows.length))
  ok(footRows[RADAR_DEPTH - 1].split('')[RADAR_SIDE] === 'P', '最后一排中间那格是我（P）', footRows[RADAR_DEPTH - 1])
  ok(footRows[RADAR_DEPTH - 1].split('').filter((c) => c === 'P').length === 1, '整层只有一个 P')
  const groundLine = r.lines.find((l) => l.startsWith('y=69'))
  ok(!groundLine.includes('.'), '脚下一层全是草方块（没有空气）', groundLine)
  ok(r.legend.includes('G=grass_block'), '字符表里有 G=grass_block', r.legend)
}

console.log('④ 折叠：占比 < 10% 的杂项 → O')
{
  const b = makeBot({
    fill: ({ y }) => (y <= 69 ? 'grass_block' : 'air'),
  })
  /* 在一层里塞十种"各一格"的稀有方块（每块占 1/225 ≈ 0.4%） */
  const rare = ['birch_log', 'oak_leaves', 'dirt', 'gravel', 'sand', 'clay', 'moss_block',
    'podzol', 'mud', 'snow_block']
  rare.forEach((n, i) => b.set(-4 + i, 70, -4, n))   /* x = -4..5 里 -4..4 在网格内 */
  b.set(0, 70, -2, 'andesite')                        /* 第 10 种放更靠前的一排 */
  const r = renderRadar(b)
  const used = r.lines.filter((l) => l.startsWith('y=70')).join('')
  const oCount = used.split('').filter((c) => c === 'O').length
  ok(oCount >= 10, `稀有方块被折成 O（${oCount} 个）`)
  ok(!r.legend.includes('birch_log'), '稀有方块不进字符表', r.legend)
}

console.log('⑤ 高价值矿物：特殊标记不被折叠')
{
  const b = makeBot({ fill: ({ y }) => (y <= 69 ? 'stone' : 'air') })
  b.set(2, 70, -3, 'iron_ore')
  b.set(-2, 70, -3, 'diamond_ore')
  b.set(1, 70, -2, 'coal_ore')
  const r = renderRadar(b)
  ok(r.text.includes('#'), '铁/煤矿 → #')
  ok(r.text.includes('$'), '钻石矿 → $')
  ok(r.legend.includes('#=') || r.legend.includes('铁矿'), '字符表解释了 # ', r.legend)
}

console.log('⑥ bot 自己放的方块：不折叠、单给字符')
{
  const b = makeBot({ fill: ({ y }) => (y <= 69 ? 'grass_block' : 'air') })
  /* 一个只占 1 格的怪方块：不记账时会被折成 O */
  b.set(3, 70, -2, 'polished_andesite')
  const plain = renderRadar(b)
  ok(plain.text.includes('O'), '没记账 ⇒ 折成 O')
  notePlaced(b, 3, 70, -2, 'polished_andesite')
  const marked = renderRadar(b)
  ok(marked.legend.includes('polished_andesite'), '记账后独立成字符并进字符表', marked.legend)
  const chOf = marked.legend.split(' ').find((s) => s.endsWith('=polished_andesite'))?.split('=')[0]
  const rowOf = marked.lines.find((l) => l.startsWith('y=70'))
  ok(chOf && rowOf.includes(chOf), `记账后那格是这个字符（${chOf}）`, rowOf)
}

console.log('⑦ 地形图：只算地面，天花板不算地形')
{
  const b = makeBot({ fill: ({ y }) => (y <= 69 ? 'grass_block' : 'air') })
  const t = renderTerrain(b)
  ok(t.ok, '渲染成功')
  const rows = t.lines.slice(1)
  ok(rows.length === RADAR_DEPTH, `${RADAR_DEPTH} 行`, String(rows.length))
  ok(rows.every((r) => r.split(' ').length === RADAR_SIDE * 2 + 1), `每行 ${RADAR_SIDE * 2 + 1} 列`)
  ok(rows.every((r) => r.split(' ').filter((v) => v !== 'P').every((v) => v === '0')), '平地全是 0', rows.join(' | '))
  /* 头顶盖一层天花板：地形图仍然是 0（不能变成 4） */
  const c = makeBot({ fill: ({ y }) => (y <= 69 ? 'grass_block' : (y === 74 ? 'stone' : 'air')) })
  const t2 = renderTerrain(c)
  ok(t2.lines.slice(1).every((r) => r.split(' ').filter((v) => v !== 'P').every((v) => v === '0')),
    '头顶有天花板时地形图仍是 0（没被当成地形）', t2.lines.slice(1).join(' | '))
}

console.log('⑧ 地形图：起伏与落差')
{
  const b = makeBot({ fill: ({ y, x }) => ((x >= 0 ? 71 : 69) >= y ? 'grass_block' : 'air') })
  const t = renderTerrain(b)
  const vals = t.lines.slice(1).join(' ').split(' ').filter((v) => v !== 'P')
  ok(vals.some((v) => v === '2'), '东侧地面高 2 格 → 出现 2（相对脚下那一层）', vals.join(' '))
  ok(vals.every((v) => v === '0' || v === '2'), '没有莫名其妙的数值', vals.join(' '))
}

console.log('⑨ 展示节奏（poi-mode）')
{
  resetPoiMode()
  const id = 'agent-x'
  const seq = []
  for (let i = 0; i < 10; i++) seq.push(tick(id, true))
  ok(seq.every((s) => s.showTerrain), '头顶开阔 ⇒ 地形图每轮都给')
  ok(seq.filter((s) => s.showRadar).length === 2, '开阔时雷达图每 9 轮一次（第 1、10 轮）',
    String(seq.filter((s) => s.showRadar).length))
  ok(seq.every((s) => s.every === 9), '间隔 = 9')

  resetPoiMode()
  const id2 = 'agent-y'
  const seq2 = []
  for (let i = 0; i < 9; i++) seq2.push(tick(id2, false))
  ok(seq2.every((s) => !s.showTerrain), '空气少 ⇒ 不给地形图')
  ok(seq2.filter((s) => s.showRadar).length === 3, '矿洞里雷达图每 4 轮一次（第 1、5、9 轮）',
    String(seq2.filter((s) => s.showRadar).length))

  resetPoiMode()
  const id3 = 'agent-z'
  startFocus(id3, FOCUS_MS)
  const f1 = tick(id3, true)
  ok(f1.focus && f1.showRadar && !f1.showTerrain, '专注模式：雷达图常驻、地形图关')
  stopFocus(id3)
  const f2 = tick(id3, true)
  ok(!f2.focus && f2.showTerrain, '手动退出后恢复自动节奏')

  /* 到期：只提醒一次 */
  resetPoiMode()
  const id4 = 'agent-w'
  startFocus(id4, 1)                        // 1ms ⇒ 很快就到期
  tick(id4, true)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)   // 同步等 5ms 让它真的过期
  const after = []
  for (let i = 0; i < 4; i++) after.push(tick(id4, true).expired)
  ok(after.filter((x) => x).length === 1, '到期只提醒一次', JSON.stringify(after))
  ok(after.indexOf(true) <= 1, '到期后立刻提醒（不会拖好几轮）', JSON.stringify(after))
}

console.log(`\n结果：${pass} 过 / ${fail} 失败`)
if (fail) process.exitCode = 1
