#!/usr/bin/env node
/**
 * 泛名解析自检 —— `src/generic-names.mjs`
 *
 * 🔴 起因（用户 2026-10-23「1档和2档做一下」）：一档第 5 条 = 通用方块名解析。
 *    抄 mindcraft `src/agent/npc/utils.js`（`getTypeOfGeneric` / `blockSatisfied` / `rotateXZ`）。
 *    为什么值得抄：AI 说"用木板围一圈"时写的是 `planks`，游戏里没有这个方块 —— 不解析就每次都
 *    得让它自己把 11 种木材猜一遍，猜错就报"没有叫 planks 的方块"。
 *
 * 钉死这几件事：
 *   ① 木材种类**按背包挑最多的那种**（含原木/木板/木棍），背包空就看附近原木，全无才 oak；
 *   ② `planks`/`log`/`stairs` 这类泛词都拼成 `<wood>_<part>`，具体名字原样放过；
 *   ③ `bed` / `wool` / `carpet` 按背包里最多的羊毛色落色，一块没有就 white；
 *   ④ `blockSatisfied`：`dirt` 认土系一族；木质泛词**不能**把石头楼梯/石半砖当成木头的；
 *      `bed`/`torch` 用后缀/包含判；
 *   ⑤ `rotateXZ` 四个朝向的坐标换算（0 不转 / 1 顺 90 / 2 180 / 3 逆 90），且 x/z 尺寸不对称时也对；
 *   ⑥ 全是只读函数：不写世界、不发包（假 bot 只有 inventory/registry/findBlocks）。
 *
 * 用法：node tools/check-generic-names.mjs
 */
import { readFileSync } from 'node:fs'
import {
  WOOD_TYPES, GENERIC_WOOD_PARTS, WOOL_COLORS,
  isGenericWood, normName, woodTypeOf, concreteNameOf, blockSatisfied, rotateXZ,
} from '../src/generic-names.mjs'

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}${extra ? ` —— ${extra}` : ''}`) }
}
const section = (t) => console.log(`\n${t}`)

/** 假 bot：只要 inventory.items() / registry / findBlocks 三样 */
function mkBot ({ items = [], logs = [] } = {}) {
  const byName = { log: { id: 1 } }
  for (const n of ['oak_log', 'birch_log', 'spruce_log']) byName[n] = { id: Object.keys(byName).length + 1 }
  const pos = logs.map((n, i) => ({ x: i, y: 64, z: 0 }))
  return {
    inventory: { items: () => items.map(([name, count]) => ({ name, count })) },
    registry: { blocksByName: byName },
    findBlocks ({ matching }) {
      const ids = Array.isArray(matching) ? matching : []
      const out = []
      for (const n of logs) if (ids.includes(byName[n]?.id)) out.push(pos[logs.indexOf(n)])
      return out
    },
    blockAt (p) { const i = pos.findIndex((q) => q.x === p.x && q.z === p.z); return { name: logs[i] ?? 'oak_log' } },
  }
}

/* ─────────────────────────── ① 常量与归一 ─────────────────────────── */
section('① 常量 / 归一 / isGenericWood')
{
  ok(WOOD_TYPES.includes('oak') && WOOD_TYPES.includes('cherry') && WOOD_TYPES.includes('warped'), '11 种木材名都在（含 cherry/warped）')
  ok(WOOD_TYPES.length >= 11, `木材种类够全（${WOOD_TYPES.length} 种）`)
  ok(GENERIC_WOOD_PARTS.includes('planks') && GENERIC_WOOD_PARTS.includes('stairs') && GENERIC_WOOD_PARTS.includes('fence_gate'), '泛词部件含 planks/stairs/fence_gate')
  ok(WOOL_COLORS.length === 16, '羊毛 16 色')
  ok(normName('  MineCraft:Oak Planks ') === 'oak_planks', '归一：去前缀/空白转下划线/小写')
  ok(isGenericWood('planks') && isGenericWood('LOG') && !isGenericWood('cobblestone'), 'isGenericWood 只认泛词')
}

/* ─────────────────────────── ② 木材种类怎么挑 ─────────────────────────── */
section('② woodTypeOf：背包 → 附近 → oak')
{
  const b1 = mkBot({ items: [['birch_log', 3], ['oak_planks', 12]] })
  const w1 = woodTypeOf(b1)
  ok(w1.wood === 'oak' && w1.from === 'inventory' && w1.count === 12, '按背包里最多的那种（oak_planks×12 压过 birch_log×3）', JSON.stringify(w1))

  const b2 = mkBot({ items: [] , logs: ['birch_log'] })
  const w2 = woodTypeOf(b2)
  ok(w2.wood === 'birch' && w2.from === 'nearby', '背包空 ⇒ 看附近原木', JSON.stringify(w2))
  ok(typeof w2.note === 'string' && /附近那种/.test(w2.note), '附近推出来的会说清理由（别让模型以为背包里有）')

  const b3 = mkBot({ items: [], logs: [] })
  const w3 = woodTypeOf(b3)
  ok(w3.wood === 'oak' && w3.from === 'default', '全无 ⇒ oak 兜底')

  const b4 = mkBot({ items: [['crimson_stem', 5]], logs: [] })
  ok(woodTypeOf(b4).wood === 'crimson', '非 _log 的菌柄（crimson_stem）名字里带 crimson 也算')

  const b5 = { inventory: { items: () => { throw new Error('没 inventory') } } }
  const w5 = woodTypeOf(b5)
  ok(w5.wood === 'oak' && w5.from === 'default', '假世界 / 没 inventory 也不炸，落 oak')
}

/* ─────────────────────────── ③ 泛名 → 具体名 ─────────────────────────── */
section('③ concreteNameOf')
{
  const b = mkBot({ items: [['spruce_log', 8]] })
  ok(concreteNameOf(b, 'planks') === 'spruce_planks', 'planks → spruce_planks（按背包那种木材）')
  ok(concreteNameOf(b, 'log') === 'spruce_log', 'log → spruce_log')
  ok(concreteNameOf(b, 'wood') === 'spruce_wood', 'wood 是六面树皮，不替它换成 log')
  ok(concreteNameOf(b, 'stairs') === 'spruce_stairs', 'stairs → spruce_stairs')
  ok(concreteNameOf(b, 'MineCraft:Planks') === 'spruce_planks', '带前缀/大写也认')
  ok(concreteNameOf(b, 'cobblestone') === 'cobblestone', '具体名原样放过')
  ok(concreteNameOf(b, '') === '', '空名返回空（不编一个）')

  const bb = mkBot({ items: [['red_wool', 2], ['white_wool', 5]] })
  ok(concreteNameOf(bb, 'wool') === 'white_wool', 'wool 挑背包里最多的羊毛色')
  ok(concreteNameOf(bb, 'bed') === 'white_bed', 'bed 同理（红羊毛 2 块不够）')
  ok(concreteNameOf(bb, 'carpet') === 'white_carpet', 'carpet 同理')
  const empty = mkBot({ items: [] })
  ok(concreteNameOf(empty, 'bed') === 'white_bed', '一块羊毛都没有 ⇒ white 兜底')
  const redOnly = mkBot({ items: [['red_wool', 3]] })
  ok(concreteNameOf(redOnly, 'bed') === 'red_bed', '只有红羊毛 ⇒ red_bed')
}

/* ─────────────────────────── ④ blockSatisfied ─────────────────────────── */
section('④ blockSatisfied：这格算不算已经对了')
{
  ok(blockSatisfied('oak_planks', 'oak_planks'), '全等')
  ok(blockSatisfied('dirt', 'grass_block') && blockSatisfied('dirt', 'coarse_dirt') && blockSatisfied('dirt', 'dirt'), 'dirt 认土系一族（草方块也算）')
  ok(!blockSatisfied('dirt', 'farmland'), 'farmland 不算 dirt（它要 moisture 才叫 farmland，别混）')

  ok(blockSatisfied('planks', 'oak_planks') && blockSatisfied('planks', 'birch_planks'), 'planks 认任意木材的木板')
  ok(!blockSatisfied('planks', 'stone'), 'planks 不认石头')
  ok(blockSatisfied('log', 'oak_log') && blockSatisfied('log', 'stripped_oak_log'), 'log 认原木和去皮原木')
  ok(blockSatisfied('stairs', 'oak_stairs') && blockSatisfied('stairs', 'bamboo_mosaic_stairs'), '木质 stairs 认（含 bamboo_mosaic）')
  ok(!blockSatisfied('stairs', 'cobblestone_stairs'), '★ 石头楼梯不算木板楼梯')
  ok(!blockSatisfied('slab', 'stone_slab') && !blockSatisfied('fence', 'nether_brick_fence'), '石头半砖/下界砖栅栏也不算')
  ok(blockSatisfied('trapdoor', 'spruce_trapdoor'), 'trapdoor 认木质')
  ok(blockSatisfied('bed', 'red_bed') && !blockSatisfied('bed', 'bedrock'), 'bed 用 _bed 后缀（bedrock 不算）')
  ok(blockSatisfied('torch', 'wall_torch') && blockSatisfied('torch', 'soul_torch'), 'torch 认墙上的/灵魂火把')
  ok(!blockSatisfied('torch', 'stone'), 'torch 不认石头')
  ok(!blockSatisfied('', 'oak_planks') && !blockSatisfied('oak_planks', ''), '空名一律 false（别当成"已经对"）')
}

/* ─────────────────────────── ⑤ rotateXZ ─────────────────────────── */
section('⑤ rotateXZ：四个朝向')
{
  /* 3×2 的蓝图（x 0..2，z 0..1），用不对称尺寸才能发现 x/z 弄反 */
  const R = (x, z, o) => rotateXZ(x, z, o, 3, 2)
  ok(JSON.stringify(R(0, 0, 0)) === '[0,0]' && JSON.stringify(R(2, 1, 0)) === '[2,1]', '0 度：原样')
  ok(JSON.stringify(R(0, 0, 1)) === '[0,2]', '顺 90：(0,0) → (0,2)（用 sizex）', JSON.stringify(R(0, 0, 1)))
  ok(JSON.stringify(R(2, 0, 1)) === '[0,0]', '顺 90：(2,0) → (0,0)')
  ok(JSON.stringify(R(0, 0, 2)) === '[2,1]' && JSON.stringify(R(2, 1, 2)) === '[0,0]', '180 度：对角')
  ok(JSON.stringify(R(0, 0, 3)) === '[1,0]', '逆 90：(0,0) → (1,0)（用 sizez）', JSON.stringify(R(0, 0, 3)))
  ok(JSON.stringify(rotateXZ(1, 1, 4, 3, 2)) === JSON.stringify(rotateXZ(1, 1, 0, 3, 2)), '朝向 4° 归一成 0')
  ok(JSON.stringify(rotateXZ(1, 1, -1, 3, 2)) === JSON.stringify(rotateXZ(1, 1, 3, 3, 2)), '负朝向归一成 3')
  /* 转四圈回原位（任何一格） */
  let p = [1, 0]
  for (let i = 0; i < 4; i++) p = rotateXZ(p[0], p[1], 1, 3, 2)
  ok(p[0] === 1 && p[1] === 0, '连转四次回原位（说明四个朝向是闭环）')
}

/* ─────────────────────────── ⑥ 只读性 ─────────────────────────── */
section('⑥ 只读：没有副作用')
{
  const src = readFileSync(new URL('../src/generic-names.mjs', import.meta.url), 'utf8')
  ok(!/bot\.(setControlState|look|chat|dig|placeBlock|activateBlock)/.test(src), '不操作 bot（只读 inventory/registry/findBlocks）')
  ok(!/writeFile|appendFile|createWriteStream/.test(src), '不写文件')
  ok(/from '\.\/inventory\.mjs'/.test(src), '复用 inventory.mjs 的 countOf，不另造一套计数')
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
