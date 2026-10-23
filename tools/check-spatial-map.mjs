#!/usr/bin/env node
/**
 * 局部空间地图自检 —— `src/spatial-map.mjs`（P0，2026-10-23）
 *
 * 用户的需求：**"构建局部空间地图"** —— 让 AI 在发 `mc_move` 之前就知道
 * 前面是墙、是落差、还是没加载；以及"移动失败后到底是哪里阻挡了我"。
 *
 * 这一套钉死八件事：
 *   ① **跨调用活着**：同一位置连叫两次，第二次**不再读世界**（`scans` 不涨、`hits` 涨）；
 *   ② **世界变了只失效受影响的那一列**（外加紧邻两侧）；区块装卸才全清；
 *   ③ **换了 feetY 但切片覆盖得到就不重扫**（列按绝对 y 存，不是按脚下相对存）；
 *   ④ **8 向边怎么过**：走 / 跳一格 / 要爬 / 往下走 / 会掉 / 没落脚点 / 墙 / **未加载**；
 *   ⑤ **未加载绝不当空气**：它是独立状态，既不算"能站"也不算"墙"；
 *   ⑥ **"我能自己走到哪"**：只在"不用挖、不用垫、不会摔"的边上扩散；
 *   ⑦ **给模型的字 ≤ 6 行、≤ 400 字符**（多一行都是每步都付的 token）；
 *   ⑧ **接线**：`mc_observe` 真的把 `spatial` 交出去，`percept:false` / `image:false` 时不炸。
 *
 * 用法：node tools/check-spatial-map.mjs
 */
import { readFileSync } from 'node:fs'
import vec3pkg from 'vec3'

const Vec3 = vec3pkg.Vec3 ?? vec3pkg
const {
  SPATIAL_R, SPATIAL_UP, SPATIAL_DOWN, SPATIAL_NAV_R, SPATIAL_DIRS, SPATIAL_EDGE_TEXT,
  spatialMapOf, spatialText, spatialCacheStats, spatialReset,
  columnFactsOf, edgeBetween, isWalkableEdge, rayAlong,
} = await import(new URL('../src/spatial-map.mjs', import.meta.url))

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}${extra ? `  → ${extra}` : ''}`) }
}
const section = (t) => console.log(`\n── ${t} ──`)
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

/* ── 假世界：显式方块表；表里没有但在"已加载区"内 ⇒ air；区外 ⇒ null（未加载） ── */
const REGION = { x0: -40, x1: 40, y0: 0, y1: 160, z0: -40, z1: 40 }
let worldReads = 0
function mkWorld (region = REGION) {
  const map = new Map()
  const key = (x, y, z) => `${x},${y},${z}`
  const inRegion = (x, y, z) => x >= region.x0 && x <= region.x1 && y >= region.y0 && y <= region.y1 && z >= region.z0 && z <= region.z1
  const w = {
    map,
    region,
    set (x, y, z, name) { map.set(key(x, y, z), name); return w },
    del (x, y, z) { map.delete(key(x, y, z)); return w },
    plate (x0, z0, x1, z1, y, name = 'stone') {
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
        for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) w.set(x, y, z, name)
      }
      return w
    },
    pillar (x, z, y0, y1, name = 'stone') {
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) w.set(x, y, z, name)
      return w
    },
    hole (x, z, yTop, yBottom, name = 'air') {
      for (let y = yBottom; y <= yTop; y++) w.set(x, y, z, name)
      return w
    },
    blockAt (p) {
      worldReads++
      if (!inRegion(p.x, p.y, p.z)) return null
      const n = map.get(key(p.x, p.y, p.z)) ?? 'air'
      return { name: n, position: new Vec3(p.x, p.y, p.z) }
    },
  }
  return w
}
/** 带事件总线的假 bot（`spatial-map` 靠 `on('blockUpdate'/'chunkDidUnload')` 失效） */
function mkBot (world, pos = { x: 0, y: 64, z: 0 }) {
  const handlers = new Map()
  return {
    entity: { position: new Vec3(pos.x + 0.5, pos.y, pos.z + 0.5), onGround: true },
    blockAt: (p) => world.blockAt(p),
    on (ev, fn) { handlers.set(ev, [...(handlers.get(ev) ?? []), fn]) },
    emit (ev, ...a) { for (const fn of handlers.get(ev) ?? []) fn(...a) },
    handlers,
  }
}
/** 平地：脚站 y=64，地板面 y=63，下面再垫 8 层 */
const flat = (feet = { x: 0, y: 64, z: 0 }, region) => {
  const w = mkWorld(region)
  for (let y = 55; y <= 63; y++) w.plate(-20, -20, 20, 20, y)
  return { w, b: mkBot(w, feet) }
}

/* ═══════════════ ① 跨调用活着：第二次不读世界 ═══════════════ */
section('① 跨调用：同一位置再叫一次，缓存命中就不该再读世界')
{
  const { b } = flat()
  worldReads = 0
  const m1 = spatialMapOf(b)
  const reads1 = worldReads
  const s1 = spatialCacheStats(b)
  worldReads = 0
  const m2 = spatialMapOf(b)
  const reads2 = worldReads
  const s2 = spatialCacheStats(b)
  ok(m1.ok && m2.ok, '两次都出得来地图')
  ok(reads1 > 300, `第一次真的读世界了（${reads1} 次 blockAt）`)
  ok(reads2 === 0, `第二次一次都没读（${reads2} 次）`, `reads2=${reads2}`)
  ok(s2.hits > s1.hits && s2.scans === s1.scans, '账上：hits 涨、scans 不涨', JSON.stringify(s2))
  ok(m2.columns.size === m1.columns.size && m2.columns.size === (SPATIAL_R * 2 + 1) ** 2, `窗口是 ${SPATIAL_R * 2 + 1}×${SPATIAL_R * 2 + 1} = ${(SPATIAL_R * 2 + 1) ** 2} 列`)
}

/* ═══════════════ ② 世界变了：只失效受影响那一列（±1） ═══════════════ */
section('② 方块更新：只失效那一列和紧邻两列，别全清')
{
  const { b } = flat()
  spatialMapOf(b)
  const before = spatialCacheStats(b)
  b.emit('blockUpdate', { position: { x: 3, y: 63, z: -2 } })
  const after = spatialCacheStats(b)
  ok(after.version === before.version + 1, '世界版本号 +1', `${before.version} → ${after.version}`)
  ok(after.columns === before.columns - 9, `只掉了受影响的那 3×3 列（${before.columns} → ${after.columns}）`, `实际 ${after.columns}`)
  b.emit('chunkDidUnload')
  ok(spatialCacheStats(b).columns === 0, '区块卸载 ⇒ 全清（那一带的列全不可信）')
  ok(typeof spatialReset === 'function', 'spatialReset 存在（传送/换维度用）')
}

/* ═══════════════ ③ 换 feetY：切片覆盖得到就不重扫 ═══════════════ */
section('③ 站高了两格（同一根柱子还在采样窗口里）⇒ 不该重扫整圈')
{
  const { b } = flat()
  spatialMapOf(b)
  const s1 = spatialCacheStats(b)
  b.entity.position = new Vec3(0.5, 66, 0.5)
  spatialMapOf(b)
  const s2 = spatialCacheStats(b)
  ok(s2.scans === s1.scans, `没有重扫（scans 保持 ${s1.scans}）`, JSON.stringify(s2))
  ok(s2.hits > s1.hits, 'hits 涨了')
  // 再跳高很多：超出切片覆盖 ⇒ 必须重扫（up=8 + pad=2 ⇒ 覆盖到 feetY+10）
  b.entity.position = new Vec3(0.5, 90, 0.5)
  const m = spatialMapOf(b)
  ok(spatialCacheStats(b).scans > s2.scans, '超出覆盖范围 ⇒ 重扫（这是对的）')
  ok(m.center.y === 90, '中心跟着人走（窗口按相对位置查询，不是整体搬地图）')
}

/* ═══════════════ ④ 8 向边怎么过 ═══════════════ */
section('④ 相邻两格之间：走 / 跳一格 / 要爬 / 往下走 / 会掉 / 没落脚点 / 墙 / 未加载')
{
  const A = { standY: 64, kind: 'stand', wall: false, gap: false, unloaded: false }
  ok(edgeBetween(A, { ...A, standY: 64 }) === 'walk', '同层 ⇒ walk')
  ok(edgeBetween(A, { ...A, standY: 63 }) === 'walk', '低一格 ⇒ 也是 walk（走下去）')
  ok(edgeBetween(A, { ...A, standY: 65 }) === 'jump', '高一格 ⇒ jump')
  ok(edgeBetween(A, { ...A, standY: 66 }) === 'climb' && edgeBetween(A, { ...A, standY: 67 }) === 'climb', '高 2–3 格 ⇒ climb')
  ok(edgeBetween(A, { ...A, standY: 62 }) === 'drop', '低两格以上 ⇒ drop（会摔）')
  ok(edgeBetween(A, { ...A, kind: 'wall', standY: null, wall: true }) === 'blocked', '墙 ⇒ blocked')
  ok(edgeBetween(A, { ...A, kind: 'gap', standY: null, gap: true }) === 'void', '没落脚点 ⇒ void')
  ok(edgeBetween(A, { ...A, kind: 'liquid', standY: null, liquid: 'water' }) === 'void', '水/岩浆上方没有落脚点 ⇒ void')
  ok(edgeBetween(A, { ...A, unloaded: true, standY: null }) === 'unknown', '**未加载 ⇒ unknown（不是墙、也不是能走）**')
  ok(edgeBetween(A, { ...A, kind: 'hazard', hazard: 'lava' }) === 'blocked', '危险格 ⇒ 直接 blocked（别跳过去）')
  ok(isWalkableEdge('walk') && isWalkableEdge('jump') && isWalkableEdge('climb'), 'walk/jump/climb 自己能走')
  ok(!isWalkableEdge('drop') && !isWalkableEdge('unknown') && !isWalkableEdge('void'), '会掉/未加载/没落脚点 ⇒ 自己走不了')
  ok(Object.keys(SPATIAL_EDGE_TEXT).length >= 9, '每种边都有中文说法（给模型看的）')
}

/* ═══════════════ ⑤ 未加载绝不当空气 ═══════════════ */
section('⑤ 未加载：既不算能站，也不算墙')
{
  const region = { x0: 0, x1: 3, y0: 0, y1: 160, z0: 0, z1: 3 }
  const w = mkWorld(region)
  w.plate(0, 0, 3, 3, 63)
  const b = mkBot(w, { x: 2, y: 64, z: 2 })
  const m = spatialMapOf(b)
  const out = m.columns.get('8,8')
  ok(out && out.unloaded === true && out.kind === 'unloaded', '窗口外的列标 unloaded', JSON.stringify(out))
  ok(m.counts.unloaded > 0, `统计里数出未加载（${m.counts.unloaded} 列）`)
  ok(m.loaded > 0 && m.loaded < m.columns.size, `已加载 ${m.loaded} 列 < 窗口 ${m.columns.size} 列`)
  const inLoaded = m.columns.get('2,2')
  ok(inLoaded && inLoaded.kind === 'stand' && inLoaded.standY === 64, '加载范围内正常判出能站 y=64', JSON.stringify(inLoaded))
  const nav = m.nav.nodes.find((n) => n.dx === 1 && n.dz === 0)
  ok(nav && nav.edges.E === 'unknown', '往未加载方向的边说 unknown', JSON.stringify(nav?.edges))
}

/* ═══════════════ ⑥ 我能自己走到哪（BFS 只走便宜边） ═══════════════ */
section('⑥ 走廊 vs 断头：能自己走到几个格')
{
  // 平地：17×17 里能到自己周围的全部可站格（通行层半径 8）
  const { b: bFlat } = flat()
  const mFlat = spatialMapOf(bFlat)
  ok(mFlat.nav.reachable > 30, `平地能走到 ${mFlat.nav.reachable} 格（不止身边一圈）`)

  // 一堵墙把东边全挡住：能到的格数明显变少
  const { w, b } = flat()
  w.pillar(1, 0, 55, 70) // 东侧 1 格处立一根顶到 70 的柱子
  for (let z = -SPATIAL_NAV_R; z <= SPATIAL_NAV_R; z++) w.pillar(1, z, 55, 70)
  const mWall = spatialMapOf(b)
  ok(mWall.nav.reachable < mFlat.nav.reachable * 0.6, `一堵墙把可达格从 ${mFlat.nav.reachable} 砍到 ${mWall.nav.reachable}（东侧全断）`)
  const east = rayAlong(mWall, SPATIAL_DIRS.find((d) => d.name === 'E'))
  ok(east.steps === 0 && east.end === 'blocked', '往东一步都走不了（前面是墙）', JSON.stringify(east))
}

/* ═══════════════ ⑦ 语义行：行数与字数（token 预算） ═══════════════ */
section('⑦ 给模型的字：≤ 6 行、≤ 400 字符')
{
  const { b } = flat()
  const m = spatialMapOf(b)
  const lines = spatialText(m)
  const chars = lines.join('').length
  ok(lines.length >= 2 && lines.length <= 6, `行数 ${lines.length}（2–6）`)
  ok(chars <= 400, `字数 ${chars} ≤ 400`)
  const head = new RegExp('^🗺 局部 ' + (SPATIAL_R * 2 + 1) + '×' + (SPATIAL_R * 2 + 1) + '（半径 ' + SPATIAL_R + '）')
  ok(head.test(lines[0]), '第一行说清窗口大小', lines[0])
  ok(/可站 \d+/.test(lines[0]) && /未加载 \d+/.test(lines[0]), '第一行带统计（可站/未加载）')
  ok(lines.some((l) => /可站 y=64/.test(l)), '说自己脚下那格能不能站', lines[1])
  ok(lines.some((l) => /^🧭 /.test(l)), '有方位行（N/E/S/W 各一句）')
  ok(lines.some((l) => /不用挖不用垫/.test(l)), '说明"能自己走到哪"是按什么算的')
  // 没地图就给空数组（别吐半截）
  ok(Array.isArray(spatialText({ ok: false })) && spatialText({ ok: false }).length === 0, '没地图 ⇒ 空数组')
}

/* ═══════════════ ⑧ rayAlong：沿一个方向能走几步、为什么停 ═══════════════ */
section('⑧ 一条通道：走几步、在哪停')
{
  const { w, b } = flat({ x: -6, y: 64, z: 0 })
  w.pillar(-6, -1, 55, 70) // 北边一格就是墙；东边一路平坦
  const m = spatialMapOf(b)
  const east = rayAlong(m, SPATIAL_DIRS.find((d) => d.name === 'E'))
  ok(east.steps >= 1, `往东能走 ${east.steps} 格`)
  ok(east.end === 'blocked' || east.end === 'limit', `停下原因说清了（${east.end}）`)
  const north = rayAlong(m, SPATIAL_DIRS.find((d) => d.name === 'N'))
  ok(north.steps === 0 && north.end === 'blocked', '往北一格就是墙', JSON.stringify(north))
}

/* ═══════════════ ⑨ 边界情况：不炸 ═══════════════ */
section('⑨ 边界：没 bot / 没坐标 / 离谱半径')
{
  const noWorld = spatialMapOf({})
  ok(noWorld.ok === false && /没有可读的世界/.test(noWorld.note), '没有 blockAt ⇒ 说清"没连上"，不抛')
  const noPos = spatialMapOf({ blockAt: () => null })
  ok(noPos.ok === false && /读不到自己的坐标/.test(noPos.note), '没有坐标 ⇒ 说清，不抛')
  const { b } = flat()
  const big = spatialMapOf(b, { radius: 999 })
  ok(big.r === 16, `离谱半径被夹到 16（${big.r}）`)
  const tiny = spatialMapOf(b, { radius: 0, up: 0, down: 0 })
  ok(tiny.r >= 1 && tiny.up >= 1 && tiny.down >= 0, '下限也夹住（不会出 0 半径的空图）')
  ok(spatialCacheStats(null).columns === 0, '没 bot 时查账也不炸')
  // 区块全不加载
  const w = mkWorld({ x0: 100, x1: 101, y0: 0, y1: 10, z0: 100, z1: 101 })
  const b2 = mkBot(w, { x: -20, y: 64, z: -20 })
  const m2 = spatialMapOf(b2)
  ok(m2.ok === false && /还没加载/.test(m2.note), '整片没加载 ⇒ 直接说"都还没加载"')
  ok(m2.counts.unloaded === m2.columns.size, '全部计入 unloaded')
  ok(columnFactsOf(null, 64).kind === 'unloaded', 'columnFactsOf(null) ⇒ unloaded（不炸）')
}

/* ═══════════════ ⑩ 接线：mc_observe 真的把它交出去 ═══════════════ */
section('⑩ 接线：mc_observe 的 spatial')
{
  const src = read('../extensions/mc_observe.mjs')
  ok(/from '\.\.\/src\/spatial-map\.mjs'/.test(src), 'observe 从 src/spatial-map.mjs 导入')
  ok(/spatialMapOf\s*\(/.test(src), '调了 spatialMapOf')
  ok(/spatialText\s*\(/.test(src), '调了 spatialText')
  ok(src.includes('...(spatial ? { spatial } : {})'), '结果里有 spatial 字段')
  ok(/percept/.test(src) && /spatial/.test(src), 'percept 路径也带 spatial')
}

console.log(`\ncheck-spatial-map：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
