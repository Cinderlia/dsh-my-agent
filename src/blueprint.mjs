/*
 * 蓝图建造（`mc_build` 的"按图施工"那一半）。
 *
 * 来历：2026-10-23 用户 m01160「1档和2档做一下」，一档第 ③ 条。参考 mindcraft
 * `src/agent/npc/build_goal.js` 的 `BuildGoal.executeNext`（三维方块名矩阵 + 4 向旋转 +
 * `blockSatisfied` 逐格判定 + `missing` 缺料统计），本地参考件在
 * `备份/mindcraft-参考/src_agent_npc_build_goal.js`。
 *
 * 和 mindcraft 的差异（都记在这，别当抄错）：
 *   1. **蓝图写成字符层**，不是三维 JSON：`layers:[".###.", "#...#"]` + `legend:{"#":"planks"}`。
 *      JSON 三维矩阵一个 5×5×4 的小屋就要上千个 token，模型还容易写错括号；字符层像画图，
 *      错了肉眼就能看出来。内置蓝图那四个 json 也没抄（几万格，占包又用不上）。
 *   2. **拆的顺序**：先拆（自上而下，避免上面的方块悬空掉落），再放（自下而上）。
 *      mindcraft 是逐格"拆一格放一格"，遇到两层墙时上面那层没有依托，`placeBlock` 会失败。
 *   3. **缺料要说清缺哪种**，且泛名（`planks`）先按背包里真有的木材种类落实成 `oak_planks`，
 *      再做库存比对 —— 否则永远缺"planks"（游戏里没有这个物品）。
 *   4. 一次调用 ≤11 秒（`self.callLeft()`），到点带着 `remaining` 返回；**原样重发同一个蓝图**
 *      就会跳过已经放对的格子。这条和 `mc_build`/`mc_dig` 一致。
 *
 * 形状：要回调实例方法（`placeBlock` / `breakBlock`）与实例状态（`requireBot` / `callLeft` / `cfg`）
 * ⇒ 第一参数收 `self`（迁移规矩第 27 条）。
 */
import vec3pkg from 'vec3'
import { isAir } from './block-names.mjs'
import { countOf, heldText } from './inventory.mjs'
import { callSecText } from './budget.mjs'
import { dangerNow, healthOf } from './danger.mjs'
import { heldSnapshotOf, restoreHeldOf } from './bridge.mjs'
import { blockSatisfied, concreteNameOf, rotateXZ, normName } from './generic-names.mjs'

const Vec3 = vec3pkg.Vec3 ?? vec3pkg

/** 图里不画东西的字符（空气 / 不用管） */
const BLANK = ['.', ' ', '-', '_']

/**
 * 把"字符层 + 图例"解析成格子表。
 *
 * @param {object} o
 * @param {string[]} o.layers 从**最底层**往上，一层一个字符串数组也行（`layers:[["...","..."]]`）
 * @param {object} [o.legend] 字符 → 方块名（`null` = 这格要空着/不管）。`. ` 默认就是空。
 * @returns {{sx:number, sy:number, sz:number, cells:Array<{x:number,y:number,z:number,name:string|null}>, chars:string[]}}
 */
export function parseBlueprint ({ layers, legend = {} } = {}) {
  const raw = Array.isArray(layers) ? layers : String(layers ?? '').split(/\r?\n/)
  /* 允许两种写法：①一层一个字符串（层内用 `/` 分行，如 `"###/###"`）②层内直接给字符串数组 */
  const grids = raw.map((L) => {
    if (Array.isArray(L)) return L.map((r) => String(r))
    const s = String(L ?? '')
    return s.includes('/') ? s.split('/') : [s]
  }).filter((g) => g.length)
  if (!grids.length) throw new Error('蓝图是空的：layers 至少要给一层（最底层），比如 layers:["BBBB","B..B","BBBB"], legend:{"B":"planks"}')

  const sz = grids[0].length
  const sx = Math.max(...grids.flat().map((r) => r.length))
  if (sx < 1 || sz < 1) throw new Error('蓝图尺寸算不出来：每一行至少要有 1 个字符')

  /* 图例归一：`.` `空格` `-` `_` 默认是"空"；其余字符必须在 legend 里，否则直接报错把字符列出来 */
  const map = new Map()
  for (const c of BLANK) map.set(c, null)
  for (const [k, v] of Object.entries(legend ?? {})) map.set(String(k).slice(0, 1), v == null || v === '' ? null : normName(v))

  const unknown = new Set()
  const cells = []
  let filled = 0
  for (let y = 0; y < grids.length; y++) {
    const layer = grids[y]
    for (let z = 0; z < sz; z++) {
      const row = layer[z] ?? ''
      for (let x = 0; x < sx; x++) {
        const c = row[x] ?? null
        if (c == null) continue
        if (!map.has(c)) { unknown.add(c); continue }
        const name = map.get(c)
        if (name == null) continue                   // 空字符：这一格"不管"（不拆也不放）
        cells.push({ x, y, z, name })
        filled++
      }
    }
  }
  if (unknown.size) {
    throw new Error(`图例里没写这几个字符：${[...unknown].map((c) => JSON.stringify(c)).join(' ')} —— 补进 legend，例如 legend:{"${[...unknown][0]}":"planks"}`)
  }
  if (!filled) throw new Error('蓝图里没有一格方块（全是空字符）：检查 legend 的键和图里用的字符是不是一样')
  return { sx, sy: grids.length, sz, cells, chars: [...new Set(cells.map((c) => c.name))] }
}

/**
 * 算这一份蓝图落到世界上要做什么（**不动机器人**，纯读 + 算；`dryRun` 和"缺料预览"都靠它）。
 *
 * @returns {{
 *   steps: Array<{pos:{x:number,y:number,z:number}, want:string, cur:string|null, needBreak:boolean}>,
 *   already: number, needBreak: number,
 *   need: Record<string, number>, missing: Record<string, number>, have: Record<string, number>,
 *   origin: {x:number,y:number,z:number}, size: {x:number,y:number,z:number}
 * }}
 */
export function planBlueprint (b, { bp, origin, orientation = 0 } = {}) {
  const { sx, sy, sz, cells } = bp
  const o = ((Number(orientation) || 0) % 4 + 4) % 4
  const steps = []
  const need = {}
  let already = 0
  let needBreak = 0
  for (const c of cells) {
    /* 旋转：蓝图内坐标 → 世界偏移。`rotateXZ` 的 sizex/sizez 用的是**蓝图自身**尺寸，
     * 旋转 90°/270° 后世界的 x/z 跨度会对调 —— 调用方按 `swapXZ` 判"占多大地"。 */
    const [dx, dz] = rotateXZ(c.x, c.z, o, sx, sz)
    const pos = { x: origin.x + dx, y: origin.y + c.y, z: origin.z + dz }
    const cur = b.blockAt(new Vec3(pos.x, pos.y, pos.z))?.name ?? null
    /* 泛名先落实成具体名（planks → oak_planks）：不落实的话下面 `blockSatisfied` 永远 false、
     * 库存里也永远查不到 —— 这一格会被永久算成"缺料"。 */
    const want = concreteNameOf(b, c.name)
    if (cur && blockSatisfied(c.name, cur)) { already++; continue }
    const occupied = Boolean(cur && !isAir(cur))
    if (occupied) needBreak++
    need[want] = (need[want] ?? 0) + 1
    steps.push({ pos, want, cur, needBreak: occupied })
  }
  const have = {}
  const missing = {}
  for (const [name, n] of Object.entries(need)) {
    const got = countOf(b, name)
    have[name] = got
    if (got < n) missing[name] = n - got
  }
  return { steps, already, needBreak, need, missing, have, origin, size: { x: sx, y: sy, z: sz } }
}

/** "缺什么"打印成一行（没有缺口就给空串） */
export function missingText (missing = {}) {
  const ent = Object.entries(missing)
  if (!ent.length) return ''
  return '缺料：' + ent.map(([n, c]) => `${n}×${c}`).join('、')
}

/** 蓝图尺寸在世界里的横竖跨度（旋转 90°/270° 时对调） */
export const spanOf = (bp, orientation = 0) => {
  const o = ((Number(orientation) || 0) % 4 + 4) % 4
  return o % 2 === 0 ? { x: bp.sx, z: bp.sz } : { x: bp.sz, z: bp.sx }
}

/**
 * 按图施工。`origin` = 蓝图原点（第 0 层第 0 行第 0 列那一格的世界坐标）。
 *
 * 只给 `layers` 时默认原地起（脚下那格当原点）；`dryRun:true` 只算不干（缺料预览）。
 */
export async function buildBlueprint (self, opts = {}, ctx = {}) {
  const b = self.requireBot()
  const keep = heldSnapshotOf(b)
  let out = null
  try {
    out = await run(self, b, opts)
    return out
  } finally {
    if (keep && out) {
      const r = await restoreHeldOf(b, keep).catch(() => ({ restored: false, why: null }))
      const nowName = b?.heldItem?.name ?? null
      out.held = nowName ? (nowName + 'x' + (b?.heldItem?.count ?? 1)) : '空手'
      if (nowName === (keep.name ?? null)) out.heldRestored = keep.name ?? '空手'
      else out.heldRestoreWhy = r?.why ?? `想换回 ${keep.name ?? '空手'} 没成功（现在是 ${nowName ?? '空手'}）`
    }
  }
}

async function run (self, b, { layers, legend = {}, x = null, y = null, z = null, orientation = 0, dryRun = false, maxCells = 512 } = {}) {
  const bp = parseBlueprint({ layers, legend })
  if (bp.cells.length > maxCells) {
    throw new Error(`蓝图有 ${bp.cells.length} 格，超过单次上限 ${maxCells}（把 maxCells 调大，或者分几块搭）`)
  }
  const feet = b.entity?.position ?? { x: 0, y: 64, z: 0 }
  const origin = {
    x: Math.floor(x ?? feet.x),
    y: Math.floor(y ?? feet.y),
    z: Math.floor(z ?? feet.z),
  }
  const plan = planBlueprint(b, { bp, origin, orientation })
  const span = spanOf(bp, orientation)
  const sizeText = `${span.x}×${bp.sy}×${span.z}`

  if (dryRun) {
    return {
      mode: 'blueprint', dryRun: true, size: sizeText, origin,
      already: plan.already, todo: plan.steps.length, needBreak: plan.needBreak,
      need: plan.need, have: plan.have, missing: plan.missing,
      text: [
        `🧾 蓝图 ${sizeText}（原点 ${origin.x},${origin.y},${origin.z}，朝向 ${orientation}）：`,
        `已经对了 ${plan.already} 格，还要动 ${plan.steps.length} 格（其中要先拆掉 ${plan.needBreak} 格）`,
        Object.keys(plan.need).length ? '要用的材料：' + Object.entries(plan.need).map(([n, c]) => `${n}×${c}`).join('、') : '',
        missingText(plan.missing) || '材料够。',
      ].filter(Boolean).join('\n'),
    }
  }

  const callLeftMs = typeof self.callLeft === 'function' ? self.callLeft() : 11_000
  const deadline = Date.now() + callLeftMs
  const noBudget = callLeftMs < 300

  /* 先拆后放：自上而下拆（上面的先走，别留悬空），再自下而上放（下面的先有依托） */
  const breaks = plan.steps.filter((s) => s.needBreak).sort((a, c) => c.pos.y - a.pos.y)
  /* 拆完就是放：所有还没对的格子按自下而上放（下面有了依托才放得上去） */
  const places = [...plan.steps].sort((a, c) => a.pos.y - c.pos.y)
  const placed = []
  const broke = []
  const failed = []
  const skippedNoMaterial = []
  let danger = null
  /* 默认只提醒不打断（和 mc_build 一致）：搭到一半挨一下打就白搭一轮更糟；
   * 想恢复旧行为把 config.stopOnDanger 设 true。 */
  const stopOnDanger = self.cfg?.stopOnDanger === true
  const hp0 = healthOf(b)
  const checkDanger = () => {
    const d = dangerNow(b, { hp0 })
    if (!d) return false
    if (stopOnDanger) { danger = d; return true }
    return false
  }

  const at = (p) => `${p.x},${p.y},${p.z}`
  for (const s of breaks) {
    if (checkDanger()) break
    if (deadline - Date.now() < 400) break
    try {
      const r = await self.breakBlock({ x: s.pos.x, y: s.pos.y, z: s.pos.z })
      if (r?.broken === false) failed.push(`${at(s.pos)}:拆不动${r?.why ? '（' + r.why + '）' : ''}`)
      else broke.push(at(s.pos))
    } catch (e) { failed.push(`${at(s.pos)}:${String(e?.message ?? e).split('\n')[0]}`) }
  }
  /* 库存余量自己扣：`countOf` 读的是开始那一刻的背包，不扣的话最后几格会白白让
   * placeBlock 一个个失败（每次都要走近 + 挥一下），报出来还像「放不上去」。 */
  const left = { ...plan.have }
  const brokeKeys = new Set(broke)
  for (const s of places) {
    if (checkDanger()) break
    if (deadline - Date.now() < 400) break
    /* 该拆但没拆掉 ⇒ 这格现在放不进去，别硬放（placeBlock 会一直报"被占住"） */
    if (s.needBreak && !brokeKeys.has(at(s.pos))) { failed.push(`${at(s.pos)}:挡路的没拆掉，没放`); continue }
    if ((left[s.want] ?? 0) <= 0) { skippedNoMaterial.push(s.want); continue }
    try {
      const r = await self.placeBlock({ x: s.pos.x, y: s.pos.y, z: s.pos.z, name: s.want })
      if (r?.placed) { placed.push(at(s.pos)); left[s.want] = (left[s.want] ?? 0) - 1 }
      else failed.push(`${at(s.pos)}:${r?.why ?? '没放上去'}${r?.now && r.now !== s.want ? `（那格现在是 ${r.now}）` : ''}`)
    } catch (e) { failed.push(`${at(s.pos)}:${String(e?.message ?? e).split('\n')[0]}`) }
  }

  const acted = placed.length + broke.length
  const remaining = Math.max(0, plan.steps.length - acted)
  const noMat = {}
  for (const n of skippedNoMaterial) noMat[n] = (noMat[n] ?? 0) + 1
  const lines = [
    `🏗 蓝图 ${sizeText}（原点 ${origin.x},${origin.y},${origin.z}，朝向 ${orientation}）：`
      + (acted ? `放了 ${placed.length} 格、拆了 ${broke.length} 格` : '这一轮没动任何一格'),
    plan.already ? `原本就对：${plan.already} 格` : '',
    remaining ? `还剩 ${remaining} 格没弄 —— 时间到了就**原样重发同一个蓝图**，已经对的会跳过（一轮共 ${callSecText()}）` : '',
    Object.keys(noMat).length ? '材料不够没放：' + Object.entries(noMat).map(([n, c]) => `${n}×${c}`).join('、') : '',
    missingText(plan.missing),
    failed.length ? `放不上去的：${failed.slice(0, 6).join('；')}${failed.length > 6 ? ` …等 ${failed.length} 处` : ''}` : '',
    noBudget ? '⚠️ 本轮时间不够（一点都没干）：换个干净的调用再来。' : '',
    danger ? `⚠️ ${danger}` : '',
  ].filter(Boolean)
  return {
    mode: 'blueprint', size: sizeText, origin, orientation,
    placed: placed.length, broke: broke.length, already: plan.already,
    remaining, needBreak: plan.needBreak, need: plan.need, missing: plan.missing,
    ...(failed.length ? { failed: failed.slice(0, 20), failedCount: failed.length } : {}),
    ...(Object.keys(noMat).length ? { shortOf: noMat } : {}),
    ...(danger ? { danger } : {}),
    held: heldText(b),
    text: lines.join('\n'),
  }
}
