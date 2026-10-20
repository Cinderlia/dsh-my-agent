/**
 * mc_scan / scanAround 的竖向窗口（2026-10-19 实机踩的坑）
 *
 * 用户当时在末地全程看着我：**站在 y=72 扫 y=94 的头，连扫三次都是 0**，
 * 于是我判"没建上"重铺了整面墙。真相是 `scanAround` 的竖向窗口
 * **以我脚底为中心 ±height**，站得低就永远扫不到高处的方块。
 *
 * 修法：加一个 `y` 参数**指定竖向中心**，并在返回里带上 `center`（真实窗口中心），
 * 别再让人把"这一层没有"读成"整座山都没有"。
 */
import { Vec3 } from 'vec3'
import { scanAround } from '../src/world-scan.mjs'

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`) }
}
const section = (t) => console.log(`\n── ${t} ──`)

/* 假 bot：只认同一个方块名，地图用 Set 存坐标 */
function makeBot (feetY, blocks) {
  const set = new Set(blocks.map((p) => `${p.x},${p.y},${p.z}`))
  return {
    entity: { position: new Vec3(0, feetY, 0), yaw: 0, pitch: 0 },
    blockAt (pos) {
      if (!set.has(`${pos.x},${pos.y},${pos.z}`)) return { name: 'air', getProperties: () => ({}) }
      return { name: 'blue_concrete', getProperties: () => ({}) }
    },
  }
}

section('① 不给 y：窗口以脚底为中心（老行为不变）')
{
  const b = makeBot(72, [{ x: 0, y: 72, z: 0 }])
  const r = scanAround(b, { radius: 2, height: 4, name: 'blue_concrete' })
  ok(r.total === 1, '脚下那一层扫得到', String(r.total))
  ok(r.center?.y === 72, 'center.y = 脚底 72', JSON.stringify(r.center))
}

section('② 给了 y：站低也能扫高处（实机那个头 y=94）')
{
  const b = makeBot(72, [{ x: 1, y: 94, z: 0 }])
  const near = scanAround(b, { radius: 2, height: 4, name: 'blue_concrete' })
  ok(near.total === 0, '不给 y ⇒ 站 y=72 扫不到 y=94（这就是当初误判的根源）', String(near.total))
  const far = scanAround(b, { radius: 2, height: 4, name: 'blue_concrete', y: 94 })
  ok(far.total === 1, '给 y=94 ⇒ 扫得到', String(far.total))
  ok(far.nearest === '1,94,0', '返回的坐标就是那块', String(far.nearest))
  ok(far.center?.y === 94, 'center 报的是真实窗口中心 94（不是脚底）', JSON.stringify(far.center))
  ok(far.height === 4, 'name 模式也带 height', String(far.height))
}

section('③ 计数模式同样认 y')
{
  const b = makeBot(60, [{ x: 0, y: 100, z: 0 }])
  const r = scanAround(b, { radius: 2, height: 4, y: 100 })
  ok(r.center?.y === 100, 'counts 模式 center.y = 100', JSON.stringify(r.center))
  ok((r.counts ?? []).some((c) => c.name === 'blue_concrete' && c.count === 1), '数到那 1 块', JSON.stringify(r.counts))
}

section('④ y 传垃圾值不炸（当没传）')
{
  const b = makeBot(72, [])
  for (const bad of [null, undefined, '', 'abc', NaN]) {
    const r = scanAround(b, { radius: 1, height: 1, y: bad })
    ok(r.center?.y === 72, `y=${JSON.stringify(bad)} ⇒ 回落脚底 72`, JSON.stringify(r.center))
  }
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
