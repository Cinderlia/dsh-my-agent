// 实机侦察：连上服务器把「周围有谁 + 附近资源 + 游戏内状态」全打印一遍
// 用途：决定 PvE / 采集类测试怎么布置（怪在哪、有没有树、是不是夜里）
// 跑法：node 实机验证\打怪\recon-area.mjs      （服务器要开着）
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const PKG = 'C:/Users/BLUE/.dsh/profiles/desktop/node_modules/dsh-mc-agent'
const req = createRequire('file:///' + PKG + '/package.json')
const Vec3 = req('vec3')
const { McBot } = await import('file:///' + PKG + '/src/core.mjs')

const lockDir = mkdtempSync(join(tmpdir(), 'pve-recon2-'))
const mc = new McBot({ instanceId: 'pve-recon2', lockDir, logFile: join(lockDir, 'r.log') })
const bot = await mc.connect({ host: '127.0.0.1', port: 25565, auth: { mode: 'offline', name: 'wcpve_recon2' } })
const me = bot.entity.position
console.log('已连接:', me, '｜血量', bot.health, '食物', bot.food)

const HOSTILE = /zombie|skeleton|stray|bogged|creeper|spider|witch|enderman|slime|pillager|vindicator|ravager|phantom|drowned|husk|blaze|ghast|piglin|hoglin|guardian|shulker|silverfish|magma|wither|breeze/i
console.log('\n=== 全部实体（不限距离）===')
const ents = Object.values(bot.entities ?? {}).filter((e) => e && e !== bot.entity && e.name)
for (const e of ents.map((e) => ({ e, d: e.position.distanceTo(me) })).sort((a, b) => a.d - b.d)) {
  console.log(`   ${HOSTILE.test(e.e.name) ? '⚠️' : '  '} ${e.e.name.padEnd(24)} ${e.d.toFixed(1).padStart(7)} 格  (${e.e.position.x.toFixed(0)},${e.e.position.y.toFixed(0)},${e.e.position.z.toFixed(0)})`)
}

console.log('\n=== 附近资源（64 格内，只统计）===')
const want = { log: /_log$|_stem$/, stone: /^(stone|cobblestone|deepslate|dirt|grass_block|sand)$/, coal: /_ore$/, water: /^water$/ }
for (const [k, re] of Object.entries(want)) {
  const found = bot.findBlocks({ matching: (b) => b && re.test(b.name), maxDistance: 64, count: 64 })
  const names = {}
  for (const p of found) { const n = bot.blockAt(p)?.name ?? '?'; names[n] = (names[n] ?? 0) + 1 }
  console.log(`   ${k}: ${found.length} 个 ${found.length ? '— ' + Object.entries(names).map(([n, c]) => `${n}x${c}`).join(' ') : ''}`)
  if (found.length) {
    const near = found.map((p) => ({ p, d: p.distanceTo(me) })).sort((a, b) => a.d - b.d)[0]
    console.log(`        最近的 ${bot.blockAt(near.p)?.name} 在 (${near.p.x},${near.p.y},${near.p.z}) ${near.d.toFixed(1)} 格`)
  }
}
console.log('\n脚下:', bot.blockAt(new Vec3(Math.floor(me.x), Math.floor(me.y) - 1, Math.floor(me.z)))?.name,
  '｜头顶:', bot.blockAt(new Vec3(Math.floor(me.x), Math.floor(me.y) + 2, Math.floor(me.z)))?.name,
  '｜生物群系:', bot.blockAt(me)?.biome?.name ?? '?')
console.log('游戏内时间:', bot.time?.timeOfDay, '｜difficulty:', bot.game?.difficulty ?? '(无字段)')
console.log('插件能力:', mc.pfReady ? 'pathfinder 就绪' : 'pathfinder 没装上', '｜插件:', Object.keys(mc.mcPlugins ?? {}).join(', ') || '（无）')

console.log('\n=== mc_entities 工具（分类 / 血量 / 远程标记）===')
console.log('   内核 bot.entities 条数:', Object.keys(bot.entities ?? {}).length,
  '｜util 助手:', typeof bot.util?.entity?.getHealth === 'function'
    ? '在（血量走 @nxg-org/mineflayer-util-plugin）' : '不在（退回 e.health / 点到点距离）')
for (const kind of ['hostile', 'player']) {
  const r = mc.entities(48, { kind })
  if (r?.error) { console.log(`   ${kind}: ${r.error}`); continue }
  console.log(`   ${kind}: ${r.radius} 格内 敌对 ${r.counts.hostile} / 玩家 ${r.counts.player} / 其它 ${r.counts.other}`)
  for (const e of r.list.slice(0, 6)) {
    console.log(`     ${e.kind === 'hostile' ? '⚠️' : '  '} ${e.name.padEnd(22)} ${String(e.distance).padStart(7)} 格  `
      + `(${e.position.x},${e.position.y},${e.position.z})  上下 ${e.dy > 0 ? '+' : ''}${e.dy}  `
      + `血 ${e.health ?? '读不到'}${e.ranged ? '  远程' : ''}`)
  }
}

await mc.disconnect('侦察完毕')
process.exit(0)
