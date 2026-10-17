/**
 * 探针：实机读怪物血量到底读不读得到。
 *
 * 背景：`live-combat.mjs` ① 组里 bot 用拳头把僵尸打死了（约 5 秒、20 血、4 点/秒），
 * 但 `sawDamage` 是 false ⇒ 报 `combat:"unknown"` + "没读到过它掉血"。
 * `entityHealth()` 有两条路（`util.entity.getHealth` 和 `e.health`），得看清是哪条断了。
 */
import { createRequire } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PKG = 'C:/Users/BLUE/.dsh/profiles/desktop/node_modules/dsh-mc-agent'
const { default: McBot } = await import('file:///' + PKG + '/src/core.mjs')
const { entityHealth } = await import('file:///' + PKG + '/src/world-observer.mjs')

const NAME = 'wcprobe_health'
const SITE = { x: 760, y: 100, z: 760 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(...a)

const mc = new McBot({ instanceId: 'probe-health', lockDir: mkdtempSync(join(tmpdir(), 'wc-probe-')), logFile: join(tmpdir(), 'wc-probe-core.log') })
await mc.connect({ host: '127.0.0.1', port: 25565, auth: { mode: 'offline', name: NAME } })
await mc.waitForChunks(20000)
const bot = mc.requireBot()
const cmd = (s) => bot.chat('/' + s)
const until = async (cond, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(100) } return cond() }

log(`连上了：${bot.entity.position} 血=${bot.health}`)
cmd(`fill ${SITE.x - 4} ${SITE.y - 1} ${SITE.z - 4} ${SITE.x + 4} ${SITE.y - 1} ${SITE.z + 4} stone`)
cmd(`fill ${SITE.x - 4} ${SITE.y} ${SITE.z - 4} ${SITE.x + 4} ${SITE.y + 3} ${SITE.z + 4} air`)
cmd(`tp ${NAME} ${SITE.x + 0.5} ${SITE.y} ${SITE.z + 0.5}`)
await mc.waitForChunks(8000)
await sleep(600)
cmd(`kill @e[type=zombie]`)
await sleep(300)
cmd(`summon minecraft:zombie ${SITE.x + 3} ${SITE.y} ${SITE.z}`)
await until(() => Object.values(bot.entities ?? {}).some((e) => e?.name === 'zombie'), 4000)
await sleep(400)

const z = Object.values(bot.entities ?? {}).find((e) => e?.name === 'zombie')
if (!z) { log('❌ 僵尸没生成'); process.exit(1) }

log(`\n──── 实体对象 ────`)
log(`name=${z.name} type=${z.type} kind=${z.kind} id=${z.id}`)
log(`e.health = ${JSON.stringify(z.health)}  (typeof ${typeof z.health})`)
log(`metadata 是数组吗 = ${Array.isArray(z.metadata)} 长度=${z.metadata?.length ?? 'n/a'}`)
log(`metadata = ${JSON.stringify(z.metadata)}`)

log(`\n──── entityHealth() 两条路分别是什么 ────`)
let viaUtil = 'THREW'
try {
  const raw = bot.util?.entity?.getHealth?.(z)
  viaUtil = `${JSON.stringify(raw)} (typeof ${typeof raw})`
} catch (e) { viaUtil = `THREW ${e?.message}` }
log(`bot.util.entity.getHealth(z) = ${viaUtil}`)
log(`entityHealth(bot, z)         = ${JSON.stringify(entityHealth(bot, z))}`)

log(`\n──── 真打一下，看读得到掉血吗 ────`)
const hp0 = entityHealth(bot, z)
log(`打之前 entityHealth = ${JSON.stringify(hp0)}`)
bot.pvp?.attack?.(z)
const seen = []
for (let i = 0; i < 60; i++) {
  await sleep(150)
  if (!bot.entities?.[z.id]) { seen.push(`${i}: 实体没了`); break }
  const h = entityHealth(bot, z)
  seen.push(`${i}: ${JSON.stringify(h)}`)
  if (seen.length > 6 && h == null && i > 20) break
}
log(`采样：${seen.join(' ｜ ')}`)
try { Promise.resolve(bot.pvp?.stop?.()).catch(() => {}) } catch {}
cmd(`kill @e[type=zombie]`)
cmd(`fill ${SITE.x - 4} ${SITE.y} ${SITE.z - 4} ${SITE.x + 4} ${SITE.y + 3} ${SITE.z + 4} air`)
await sleep(300)
await mc.disconnect?.()
process.exit(0)
