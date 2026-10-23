#!/usr/bin/env node
/**
 * 蓝图建造自检 —— `src/blueprint.mjs`（`mc_build` 的"按图施工"那一半）
 *
 * 🔴 起因（用户 2026-10-23「1档和2档做一下」）：一档第 ③ 条 = 蓝图建造。抄 mindcraft
 *    `BuildGoal.executeNext`（`备份/mindcraft-参考/src_agent_npc_build_goal.js`），但改成
 *    **字符层 + 图例**（三维 JSON 一个 5×5×4 小屋就上千 token，模型还容易写错括号）。
 *
 * 钉死这几件事：
 *   ① 字符层解析：层序（第 0 层最下）/ 行序（第 0 行是 z=0）/ 同层用 `/` 分行 / 每层也可给字符串数组；
 *   ② 图例没写到的字符 ⇒ 报错并把字符列出来（**不许静默丢格子**，否则蓝图悄悄少一面墙）；
 *   ③ `.`/空格/`-`/`_` 是"空着不管"（既不拆也不放），不是"要拆成空气"；
 *   ④ 旋转：`rotateXZ` 的尺寸用蓝图自身尺寸，旋转 90°/270° 后世界跨度对调（`spanOf`）；
 *   ⑤ `planBlueprint` 只读：已经对的算 `already`，挡路的算 `needBreak`，泛名落实成具体名再查库存；
 *   ⑥ 施工顺序：**先重排拆（自上而下）、再自下而上放**；该拆没拆掉的那格不许硬放；
 *   ⑦ 材料不够 ⇒ 只跳过并报 `shortOf`，不当失败；时间到 ⇒ 报 `remaining`（原样重发就续上）；
 *   ⑧ `dryRun:true` 一格都不动（不调 placeBlock / breakBlock）；
 *   ⑨ 收工把手换回来（`heldRestored`），和 `mc_build` 一致；
 *   ⑩ 接在 `mc_build` 上（不新开工具）：`index.js` 有 `layers`/`legend`/`orientation`/`dryRun` 四个参数，
 *      且 `core.mjs` 没被撑破 ≤1000 行。
 *
 * 用法：node tools/check-mc-blueprint.mjs
 */
import { readFileSync } from 'node:fs'
import {
  parseBlueprint, planBlueprint, buildBlueprint, missingText, spanOf,
} from '../src/blueprint.mjs'

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}${extra ? ` —— ${extra}` : ''}`) }
}
const section = (t) => console.log(`\n${t}`)

/* ─────────────────── 假世界 ─────────────────── */
function mkWorld ({ blocks = {}, items = [] } = {}) {
  const world = { ...blocks }
  const b = {
    grid: world,
    entity: { position: { x: 0, y: 64, z: 0, distanceTo (o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z) } } },
    inventory: { items: () => items.map(([name, count]) => ({ name, count })) },
    registry: { blocksByName: { oak_log: { id: 1 }, birch_log: { id: 2 } } },
    blockAt (p) { return { name: world[`${p.x},${p.y},${p.z}`] ?? 'air' } },
    heldItem: items.length ? { name: items[0][0], count: items[0][1] } : null,
    quickBarSlot: 0,
  }
  b.setBlock = (x, y, z, name) => { world[`${x},${y},${z}`] = name }
  return b
}

/** 假门面：记下每次调用，按剧本回结果 */
function mkSelf (b, { failBreak = [], failPlace = [], budgetMs = 11_000, stopOnDanger = false } = {}) {
  const calls = []
  return {
    cfg: { stopOnDanger },
    calls,
    callLeft: () => budgetMs,
    requireBot: () => b,
    async breakBlock ({ x, y, z }) {
      calls.push({ op: 'break', at: `${x},${y},${z}` })
      if (failBreak.includes(`${x},${y},${z}`)) return { broken: false, why: '太硬' }
      b.setBlock(x, y, z, 'air')
      return { broken: true }
    },
    async placeBlock ({ x, y, z, name }) {
      calls.push({ op: 'place', at: `${x},${y},${z}`, name })
      if (failPlace.includes(`${x},${y},${z}`)) return { placed: false, why: '放不进去', now: 'air' }
      const cur = b.grid[`${x},${y},${z}`] ?? 'air'
      if (cur !== 'air') return { placed: false, why: `已被 ${cur} 占住`, now: cur }
      b.setBlock(x, y, z, name)
      return { placed: name, now: name }
    },
  }
}

/* ─────────────────── ① 解析 ─────────────────── */
section('① parseBlueprint：字符层 → 格子表')
{
  const bp = parseBlueprint({ layers: ['BBB/BBB/BBB', 'B.B/B.B/B.B'], legend: { B: 'planks' } })
  ok(bp.sx === 3 && bp.sz === 3 && bp.sy === 2, '尺寸 3×2×3（sx=3 sz=3 层数=2）', JSON.stringify({ sx: bp.sx, sy: bp.sy, sz: bp.sz }))
  ok(bp.cells.length === 9 + 6, '格子数 = 9 + 6（第二层每行中间是空的，2×3 行）', `实际 ${bp.cells.length}`)
  ok(bp.chars.join(',') === 'planks', 'chars 汇总用到的方块（泛名原样，留到落地时再定木材）')
  ok(bp.cells.filter((c) => c.y === 0).length === 9, '第 0 层是最底下（y=0）')
  ok(bp.cells.some((c) => c.x === 0 && c.z === 0 && c.y === 1), '行 = z、字符 = x（(0,0) 在左上角）')

  const arr = parseBlueprint({ layers: [['BB', 'BB']], legend: { B: 'stone' } })
  ok(arr.sx === 2 && arr.sy === 1 && arr.cells.length === 4, '层内用字符串数组也行')

  let err = null
  try { parseBlueprint({ layers: ['BXB'], legend: { B: 'stone' } }) } catch (e) { err = e.message }
  ok(err && /图例里没写这几个字符/.test(err) && /"X"/.test(err), '图例缺字符 ⇒ 报错并指出是哪个字符', String(err))

  err = null
  try { parseBlueprint({ layers: [] }) } catch (e) { err = e.message }
  ok(err && /蓝图是空的/.test(err), '空蓝图 ⇒ 明确报错')

  err = null
  try { parseBlueprint({ layers: ['...'], legend: {} }) } catch (e) { err = e.message }
  ok(err && /没有一格方块/.test(err), '全是空字符 ⇒ 报错（别当成"成功什么都没做"）')

  const blank = parseBlueprint({ layers: ['B.B', ' - '], legend: { B: 'stone' } })
  ok(blank.cells.length === 2, '. 空格 - _ 都是"空着不管"（不拆也不放）', `实际 ${blank.cells.length}`)
}

/* ─────────────────── ② 旋转与跨度 ─────────────────── */
section('② 旋转 / 跨度')
{
  const bp = parseBlueprint({ layers: ['BB/BB/BB'], legend: { B: 'stone' } })   // sx=2, sz=3
  const s0 = spanOf(bp, 0)
  const s1 = spanOf(bp, 1)
  ok(s0.x === 2 && s0.z === 3, '0°：跨度 = 蓝图尺寸')
  ok(s1.x === 3 && s1.z === 2, '90°：跨度对调', JSON.stringify(s1))
  ok(spanOf(bp, 4).x === s0.x, '朝向归一（4 == 0）')
}

/* ─────────────────── ③ planBlueprint ─────────────────── */
section('③ planBlueprint：只读地算要动什么')
{
  /* 一层 2×2 的木板，地上已经有一格 oak_planks、一格 dirt（要拆）、两格空气 */
  const bp = parseBlueprint({ layers: ['BB/BB'], legend: { B: 'planks' } })
  const b = mkWorld({
    blocks: { '0,64,0': 'oak_planks', '1,64,0': 'dirt' },
    items: [['oak_planks', 5]],
  })
  const plan = planBlueprint(b, { bp, origin: { x: 0, y: 64, z: 0 }, orientation: 0 })
  ok(plan.already === 1, '已经对的那格算 already（planks 认 oak_planks）', String(plan.already))
  ok(plan.steps.length === 3, '还要动 3 格', String(plan.steps.length))
  ok(plan.needBreak === 1, '挡路的 dirt 算 needBreak', String(plan.needBreak))
  ok(plan.need.oak_planks === 3, '泛名 planks 落实成 oak_planks（背包里那种）再计料', JSON.stringify(plan.need))
  ok(Object.keys(plan.missing).length === 0, '背包 5 块够 3 块 ⇒ 不缺料', JSON.stringify(plan.missing))

  const bPoor = mkWorld({ blocks: {}, items: [['oak_planks', 1]] })
  const plan2 = planBlueprint(bPoor, { bp, origin: { x: 0, y: 64, z: 0 }, orientation: 0 })
  ok(plan2.missing.oak_planks === 3, '缺多少报多少（要 4 格、只有 1 块 ⇒ 缺 3）', JSON.stringify(plan2.missing))
  ok(/缺料：oak_planks×3/.test(missingText(plan2.missing)), 'missingText 说人话', missingText(plan2.missing))
  ok(missingText({}) === '', '不缺料时 missingText 是空串（别在结果里塞"缺料："）')

  /* 旋转生效：origin 的 z 方向要跟着转 */
  const bp2 = parseBlueprint({ layers: ['././B'], legend: { B: 'stone' } })  // sx=1, sz=3，(0,2) 那格
  const p90 = planBlueprint(mkWorld({ items: [] }), { bp: bp2, origin: { x: 10, y: 64, z: 10 }, orientation: 1 })
  ok(p90.steps.length === 1 && p90.steps[0].pos.x === 12 && p90.steps[0].pos.z === 10,
    '90° 后那一格转到 +x 方向（rotateXZ 真的用上了）', JSON.stringify(p90.steps[0]?.pos))
}

/* ─────────────────── ④ dryRun ─────────────────── */
section('④ dryRun：一格都不动')
{
  const bp = parseBlueprint({ layers: ['BB/BB'], legend: { B: 'stone' } })
  const b = mkWorld({ items: [['stone', 10]] })
  const self = mkSelf(b)
  const r = await buildBlueprint(self, { layers: ['BB/BB'], legend: { B: 'stone' }, x: 0, y: 64, z: 0, dryRun: true })
  ok(self.calls.length === 0, 'dryRun 没调任何 placeBlock/breakBlock', JSON.stringify(self.calls))
  ok(r.dryRun === true && r.todo === 4 && r.already === 0, '结果说清"要动 4 格、已经对 0 格"', JSON.stringify({ todo: r.todo, already: r.already }))
  ok(/蓝图 2×1×2/.test(r.text) && /要用的材料：stone×4/.test(r.text), '文本带尺寸与用料')
  ok(bp.cells.length === 4, '（对照）蓝图本身是 4 格')
}

/* ─────────────────── ⑤ 实跑 ─────────────────── */
section('⑤ 实跑：先拆后放、自下而上')
{
  /* 两层：底层 2×1 stone，上面 2×1 planks；地面上 (0,64,0) 是 dirt 挡路 */
  const b = mkWorld({ blocks: { '0,64,0': 'dirt' }, items: [['stone', 4], ['oak_planks', 4]] })
  const self = mkSelf(b)
  const r = await buildBlueprint(self, {
    layers: ['SS', 'PP'], legend: { S: 'stone', P: 'planks' }, x: 0, y: 64, z: 0,
  })
  const ops = self.calls.map((c) => `${c.op}:${c.at}`)
  ok(ops[0] === 'break:0,64,0', '第一步是拆挡路的 dirt', ops[0])
  const placeOps = self.calls.filter((c) => c.op === 'place').map((c) => c.at)
  ok(placeOps.join(' ') === '0,64,0 1,64,0 0,65,0 1,65,0', '放方块是自下而上、层内按 x 走', placeOps.join(' '))
  ok(r.placed === 4 && r.broke === 1, '报了放 4 格、拆 1 格', JSON.stringify({ placed: r.placed, broke: r.broke }))
  ok(r.remaining === 0, '都做完了 ⇒ remaining 0', String(r.remaining))
  ok(b.grid['0,65,0'] === 'oak_planks' && b.grid['1,64,0'] === 'stone', '世界里真的改了')
  ok(typeof r.text === 'string' && /🏗/.test(r.text), '有 text（不是纯对象）')
  ok(r.heldRestored === 'stone', '收工把手换回原来那件', JSON.stringify({ held: r.held, restored: r.heldRestored }))
}

/* ─────────────────── ⑥ 材料不够 / 拆不掉 / 放不上 ─────────────────── */
section('⑥ 材料不够 ⇒ shortOf（不当失败）')
{
  const b = mkWorld({ items: [['stone', 1]] })
  const self = mkSelf(b)
  const r = await buildBlueprint(self, { layers: ['SSS'], legend: { S: 'stone' }, x: 0, y: 64, z: 0 })
  ok(r.placed === 1, '只有 1 块就让 1 块（不是整批失败）', String(r.placed))
  ok(r.shortOf && r.shortOf.stone === 2, '说清 stone 还差 2 块', JSON.stringify(r.shortOf))
  ok(/材料不够没放：stone×2/.test(r.text), '文本里也写着')
}

section('⑦ 该拆没拆掉的那格不许硬放')
{
  const b = mkWorld({ blocks: { '0,64,0': 'bedrock' }, items: [['stone', 4]] })
  const self = mkSelf(b, { failBreak: ['0,64,0'] })
  const r = await buildBlueprint(self, { layers: ['SS'], legend: { S: 'stone' }, x: 0, y: 64, z: 0 })
  const placed = self.calls.filter((c) => c.op === 'place').map((c) => c.at)
  ok(!placed.includes('0,64,0'), '那格没放（硬放只会一直报"被占住"）', placed.join(' '))
  ok(r.placed === 1 && Array.isArray(r.failed) && /挡路的没拆掉/.test(r.failed.join(' ')), '如实记在 failed 里', JSON.stringify(r.failed))
}

/* ─────────────────── ⑧ 预算 ─────────────────── */
section('⑧ 时间到 ⇒ remaining 原样重发就续上')
{
  const b = mkWorld({ items: [['stone', 10]] })
  const self = mkSelf(b, { budgetMs: 100 })
  const r = await buildBlueprint(self, { layers: ['SSSSSSSSSS'], legend: { S: 'stone' }, x: 0, y: 64, z: 0 })
  ok(r.placed < 10 && r.remaining > 0, '预算不够时带着 remaining 收手', JSON.stringify({ placed: r.placed, remaining: r.remaining }))
  /* 第二轮：已放对的会跳过 */
  const r2 = await buildBlueprint(self, { layers: ['SSSSSSSSSS'], legend: { S: 'stone' }, x: 0, y: 64, z: 0 })
  ok(r2.already === r.placed, '第二轮把上一轮放对的算 already（跳过不重放）', JSON.stringify({ already: r2.already, before: r.placed }))
}

/* ─────────────────── ⑨ 上限 ─────────────────── */
section('⑨ 单次上限')
{
  const b = mkWorld({ items: [['stone', 900]] })
  const self = mkSelf(b)
  let err = null
  try { await buildBlueprint(self, { layers: ['S'.repeat(600)], legend: { S: 'stone' } }) } catch (e) { err = e.message }
  ok(err && /超过单次上限/.test(err), '超上限 ⇒ 明确报错（不会静默截断蓝图）', String(err))
  ok(self.calls.length === 0, '报错时一格都没动')
}

/* ─────────────────── ⑩ 接线 ─────────────────── */
section('⑩ 接线：mc_build 的蓝图参数 + core 行数')
{
  const idx = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const core = readFileSync(new URL('../src/core.mjs', import.meta.url), 'utf8')
  ok(/import \{ buildBlueprint \} from '\.\/src\/blueprint\.mjs'/.test(idx), 'index.js 直接引了 src/blueprint.mjs')
  ok(/if \(args\.layers != null\) \{/.test(idx), 'mc_build 的 execute 里按 layers 分流')
  ok(/layers: \{\s*\n?\s*type: 'array', items: \{ type: 'string' \}/.test(idx), 'mc_build 暴露了 layers 参数')
  ok(/legend: \{ type: 'object'/.test(idx) && /orientation: \{ type: 'number'/.test(idx) && /dryRun: \{ type: 'boolean'/.test(idx),
    'legend / orientation / dryRun 三个参数都在')
  ok(!/x1: \{ type: 'number', required: true \}/.test(idx), 'x1..z2 不再是 required（蓝图模式不用给）')
  ok(/mc_build 要给范围/.test(idx), '既没范围也没蓝图时给一句人话（别让 numOf 抛 undefined）')
  ok(core.split('\n').length <= 1000, 'core.mjs 没被撑破 ≤1000 行（现在 ' + core.split('\n').length + '）')
  ok(!/name: 'mc_blueprint'/.test(idx), '没有新开一个工具（蓝图是 mc_build 的一种输入形状，省一份固定前缀）')
}

/* 🔴 2026-10-24 用户实机（问题清单第 1、3 条）：层数模式没有锚点 ⇒ 人一被垫高就原地重盖；
 *    拆不动读 `r?.why` 而 breakBlock 回的是 `note` ⇒ 永远只有"拆不动"三个字。 */
{
  const idxSrc = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const bpSrc = readFileSync(new URL('../src/blueprint.mjs', import.meta.url), 'utf8')
  ok(/x: \{ type: 'number', description: '蓝图原点 x/.test(idxSrc), 'mc_build 把蓝图原点 x 暴露出来了')
  ok(/y: \{ type: 'number', description: '蓝图原点 y/.test(idxSrc), 'mc_build 把蓝图原点 y 暴露出来了')
  ok(/z: \{ type: 'number', description: '蓝图原点 z/.test(idxSrc), 'mc_build 把蓝图原点 z 暴露出来了')
  ok(/一定要给原点 x\/y\/z/.test(idxSrc), '描述里点名"层数模式一定要给原点"（人会走开、被垫高）')
  ok(/r\?\.note \?\? r\?\.why/.test(bpSrc), '拆不动时读 breakBlock 的 note（不是不存在的 why）')
  ok(/split\('\\n'\)\[0\]\.slice\(0, 80\)/.test(bpSrc), '拆不动的原因只留一行（不把整段堆进失败列表）')
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
