#!/usr/bin/env node
/**
 * check-block-rollback.mjs —— "服务端静默拒绝时，别在本地留个幽灵空位"
 *
 * 背景（2026-10-23 用户转来的报告原话）：
 *   「同一个目标点会反复报到点了但其实没到；还有刚挖掉的方块读成空气，得换目标或绕一下才行。」
 *
 * 第二条的真身：`mineflayer/lib/plugins/digging.js` 的 `finishDigging()` 到点就
 *   `bot._updateBlockState(pos, 0)` —— **根本不等服务端**。服务端要是静默拒了（不发复原包），
 *   本地就永久是空气：寻路以为那儿通了、地图画成空气、`mc_scan` 也当它没了，
 *   等真走过去才发现是实心墙（于是"得换目标或绕一下"）。
 * 所以现在"本地清了但没收到服务端回包"这条路上，会把本地那一格改回挖之前的样子。
 *
 * 第一条的口径：起步就在到达圈里时寻路一步不挪，照样回 arrived:true —— 现在会带
 *   `alreadyThere:true` + 一句"一步没挪、要精确站上去用 intent:\"stand\""。
 *
 * 用法：node tools/check-block-rollback.mjs（**必须从包目录跑**）
 */
import { readFileSync } from 'node:fs'
import { restoreLocalBlock } from '../src/server-break.mjs'

let pass = 0, fail = 0
const ok = (c, label, extra) => { if (c) { pass++; console.log('  ✅ ' + label) } else { fail++; console.log('  ❌ ' + label + (extra ? '  → ' + extra : '')) } }

console.log('\n── restoreLocalBlock：把本地那一格改回去 ──')
{
  const calls = []
  const b = { _updateBlockState: (pos, st) => calls.push([pos, st]) }
  const r = restoreLocalBlock(b, { x: 1, y: 64, z: 2 }, 42)
  ok(r === true, '优先走 bot._updateBlockState', String(r))
  ok(calls.length === 1 && calls[0][1] === 42, '写回的就是挖之前那个 stateId', JSON.stringify(calls))
  ok(calls[0][0].x === 1 && calls[0][0].y === 64 && calls[0][0].z === 2, '坐标原样透传', JSON.stringify(calls[0][0]))
}
{
  const calls = []
  const b = { world: { setBlockStateId: (pos, st) => calls.push([pos, st]) } }
  const r = restoreLocalBlock(b, { x: 0, y: 5, z: 0 }, 7)
  ok(r === true && calls.length === 1 && calls[0][1] === 7, '没有 _updateBlockState 时退回 world.setBlockStateId', JSON.stringify(calls))
}
{
  ok(restoreLocalBlock({}, { x: 0, y: 0, z: 0 }, 1) === false, 'bot 上两个入口都没有 ⇒ 返回 false（别抛）')
  ok(restoreLocalBlock({ world: {} }, { x: 0, y: 0, z: 0 }, 1) === false, 'world 上没有 setBlockStateId ⇒ false')
  ok(restoreLocalBlock(null, { x: 0, y: 0, z: 0 }, 1) === false, 'b 是 null ⇒ false')
  ok(restoreLocalBlock({ _updateBlockState: () => {} }, { x: 0, y: 0, z: 0 }, NaN) === false, 'stateId 不是数字 ⇒ false（不乱写）')
  ok(restoreLocalBlock({ _updateBlockState: () => {} }, null, 3) === false, 'pos 是 null ⇒ false')
}
{
  const boom = { _updateBlockState: () => { throw new Error('column not loaded') } }
  let threw = false
  try { restoreLocalBlock(boom, { x: 0, y: 0, z: 0 }, 9) } catch { threw = true }
  ok(!threw, '写不回去时也不抛（区块没下发很常见）')
}

console.log('\n── 接线：两条挖掘路径都真的调了它 ──')
{
  const mining = readFileSync('src/mining.mjs', 'utf8')
  ok(mining.includes("import { classifyRestore, restoreLocalBlock } from './server-break.mjs'"), 'mining.mjs 有 import')
  const n = (mining.match(/restoreLocalBlock\(b, /g) || []).length
  ok(n >= 2, 'breakBlock 与原地挖两条路都调了（>=2）', 'n=' + n)
  ok(mining.includes('localRestored: true'), 'breakBlock 的返回里带 localRestored（模型看得见“我改回去了”）')
  ok(mining.includes('rolledBack ? false : (localGone ? name : false)'), '回滚了就不再报 broken: name（别自相矛盾）')
  ok(mining.includes('改回原样，免得寻路把它当成空洞'), '两条路的文案都说明了为什么要回滚')
}

console.log('\n── 假到达：起步就在圈里要说明白 ──')
{
  const mv = readFileSync('src/movement.mjs', 'utf8')
  ok(mv.includes('const alreadyThere = moved3dTotal < 0.6'), '算出了 alreadyThere')
  ok(mv.includes('alreadyThere: true'), '成功返回里带 alreadyThere')
  ok(mv.includes('intent:"stand"'), 'hint 里给出了精确到格的办法')
  ok(mv.includes('这一趟一步没挪'), 'hint 明确说了“一步没挪”')
}

console.log(`\ncheck-block-rollback：pass=${pass} fail=${fail}`)
if (fail) process.exitCode = 1
