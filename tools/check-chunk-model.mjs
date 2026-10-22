#!/usr/bin/env node
/**
 * check-chunk-model.mjs —— 「客户端看到的方块」这套模型到底靠不靠得住（回归检查）
 *
 * 起因（2026-10-23，User said: 「看一下客户端的代码，我感觉现在有问题」，随后确认指的是
 *   **游戏侧方块缓存：mc_observe / mc_map 看到的方块和真实不一样**）。
 *
 * 我一开始怀疑：prismarine-chunk 的 ChunkColumn.setBlockStateId 只在 section 已存在时写入
 *   （ChunkColumn.js: section ? section.set(...) : 什么都不做），而 mineflayer 的兜底守卫
 *   只兜「整列缺失」（newBlock === null），兜不住「section 缺失」⇒ 方块更新会被静默丢弃。
 * **实测推翻了这个怀疑**：1.18+ 的构造器就把全部 section 预先分配好了。所以这一套是好的，
 *   值钱的只有两条反面事实：
 *     ① section 永远不会缺 ⇒ 不存在「更新被丢弃」这条路；
 *     ② **y 越界读出来是 air(0)，不是 null** ⇒ 分不清「空气」和「根本没有这一层」。
 *
 * 这个套件把上面两条钉住，顺便钉住我们为此加的两个出口：
 *   · src/world-observer.mjs 的 worldBoundsOf / blockKnownAt；
 *   · src/world-scan.mjs 的 outOfWorld 计数、src/map-render.mjs 的 cell.outOfWorld。
 *
 * 跑：node tools/check-chunk-model.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const VENDOR_CANDS = [
  join(ROOT, '..', '..', '..', 'vendor', 'mc-deps', 'node_modules'),
  join(process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh'), 'profiles', 'desktop', 'vendor', 'mc-deps', 'node_modules'),
]
const VENDOR = VENDOR_CANDS.find((p) => existsSync(join(p, 'prismarine-chunk'))) || VENDOR_CANDS[0]
const require = createRequire(import.meta.url)

let pass = 0
let fail = 0
function ok (cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg) } else { fail++; console.log('  ✗ ' + msg) }
}

console.log('\n① prismarine-chunk 的 section 模型（实证，不是猜的）')
let col = null
try {
  const Chunk = require(join(VENDOR, 'prismarine-chunk'))
  const C = Chunk('1.21.4')
  col = new C({ minY: -64, worldHeight: 384 })
} catch (e) {
  console.log('  ! 拿不到 vendor 的 prismarine-chunk（' + e.message + '），跳过 ①')
}
if (col) {
  const S = col.sections
  ok(col.numSections === S.length, 'sections 数组长度 === numSections（' + S.length + '）')
  ok(S.filter((s) => s == null).length === 0, '🔴 构造完就没有缺失的 section —— 「section 缺失」这条路不存在')
  ok(col.getBlockStateId({ x: 0, y: 79, z: 0 }) === 0, '新列读出来是 0（空气）')
  col.setBlockStateId({ x: 0, y: 79, z: 0 }, 1)
  ok(col.getBlockStateId({ x: 0, y: 79, z: 0 }) === 1, '列内 y=79 写入生效（方块更新会被应用）')
  col.setBlockStateId({ x: 0, y: 300, z: 0 }, 1)
  ok(col.getBlockStateId({ x: 0, y: 300, z: 0 }) === 1, '列内 y=300 写入也生效（不会静默丢弃）')
  ok(col.getBlockStateId({ x: 0, y: 1000, z: 0 }) === 0, '🔴 y=1000（越界）读出来是 0 —— 和「空气」分不开')
  col.setBlockStateId({ x: 0, y: 1000, z: 0 }, 1)
  ok(col.getBlockStateId({ x: 0, y: 1000, z: 0 }) === 0, '越界写入是空操作（不是抛错，所以也发现不了）')
}

console.log('\n② worldBoundsOf / blockKnownAt（我们自己的出口）')
const wo = await import(pathToFileURL(join(ROOT, 'src', 'world-observer.mjs')).href)
ok(typeof wo.worldBoundsOf === 'function', 'world-observer 导出 worldBoundsOf')
ok(typeof wo.blockKnownAt === 'function', 'world-observer 导出 blockKnownAt')
const realBot = { game: { minY: -64, height: 384 } }
const bd = wo.worldBoundsOf(realBot)
ok(bd.minY === -64 && bd.maxY === 319, 'bot.game 在时报 -64..319（实测值：' + bd.minY + '..' + bd.maxY + '）')
const defBd = wo.worldBoundsOf({})
ok(defBd.minY === -64 && defBd.maxY === 319, 'bot.game 缺失时退回 1.18+ 默认 -64..319')

const botWith = (fn) => ({ game: { minY: -64, height: 384 }, blockAt: fn })
ok(wo.blockKnownAt(botWith(() => ({ name: 'stone' })), { x: 0, y: 79, z: 0 }).why === 'ok',
  '列在 + 有方块 ⇒ why=ok')
ok(wo.blockKnownAt(botWith(() => null), { x: 0, y: 79, z: 0 }).why === 'no-column',
  '列没下发（blockAt 给 null）⇒ why=no-column')
ok(wo.blockKnownAt(botWith(() => ({ name: 'stone' })), { x: 0, y: 999, z: 0 }).why === 'out-of-world',
  '🔴 y 越界 ⇒ why=out-of-world（不再混成空气）')
ok(wo.blockKnownAt(botWith(() => ({ name: 'stone' })), { x: 0, y: -999, z: 0 }).why === 'out-of-world',
  'y 在下界之下同样 why=out-of-world')
ok(wo.blockKnownAt(botWith(() => ({ name: 'stone' })), null).why === 'no-column', '没给坐标 ⇒ no-column')
ok(wo.blockKnownAt(botWith(() => { throw new Error('boom') }), { x: 0, y: 79, z: 0 }).why === 'no-column',
  'blockAt 抛错也不炸（当读不到处理）')

console.log('\n③ 工具层接线（扫出来的结果里要能看见“越界”）')
const scanSrc = readFileSync(join(ROOT, 'src', 'world-scan.mjs'), 'utf8')
ok(/let outOfWorld = 0/.test(scanSrc), 'world-scan 有 outOfWorld 计数')
ok(/if \(pos\.y < bounds\.minY \|\| pos\.y > bounds\.maxY\) outOfWorld\+\+/.test(scanSrc),
  'world-scan 按上下界把越界和未加载分开数')
ok(/total: found\.length, unloaded, outOfWorld,/.test(scanSrc), '点名分支返回 outOfWorld')
ok(/radius: R, height: H, unloaded, outOfWorld,/.test(scanSrc), '占比分支返回 outOfWorld')
const mapSrc = readFileSync(join(ROOT, 'src', 'map-render.mjs'), 'utf8')
ok(/cell\.outOfWorld = true/.test(mapSrc), 'map-render 的格子会标 outOfWorld')
const coreSrc = readFileSync(join(ROOT, 'src', 'core.mjs'), 'utf8')
ok(!/bot\.blockAt\(\)\` 是客户端预测/.test(coreSrc),
  '🔴 core.mjs 里那句「客户端预测」已经改掉（mineflayer 不预测，只会落后）')
ok(/不做客户端预测/.test(coreSrc), 'core.mjs 现在写的是「不做客户端预测」')

console.log('\n────────────────────────────────────────────────────────────')
console.log('check-chunk-model：pass=' + pass + ' fail=' + fail)
process.exit(fail ? 1 : 0)
