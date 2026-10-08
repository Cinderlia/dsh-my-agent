#!/usr/bin/env node
/**
 * live-attack.mjs —— 实机验证「打谁 / 挑目标 / 真重连」（用户 2026-10-08 转来的 4 条）
 *
 * 跑法（服务器开着时，从项目目录）：
 *   node '实机验证\攻击\live-attack.mjs'
 *
 * 验四件事（只对着小生物挥几下，不乱挖不乱放）：
 *   ① `mc.attack({who})` 真的按名字找得到（英文名 / 全大写 / 中文别名都行）；
 *   ② 名字真不存在时，报错里**列出半径内实际有谁**（模型能自己改名重试）；
 *   ③ 不给 who 时**怪/动物优先**（脚边有掉落物也不去打它）；
 *   ④ `connect({force:true})` 是**真重连**（换了一个新的 bot 对象、世界重新收一遍）。
 *
 * 收尾：`mc.disconnect()`。世界不改动（不挖不放；被挥过的小生物会掉一点血）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PKG = new URL('../../', import.meta.url)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const { McBot } = await import(new URL('src/core.mjs', PKG))

const HOST = '127.0.0.1'
const PORT = 25565
const NAME = 'wcattack_live'
const AUTH = { mode: 'offline', name: NAME }
const HOSTILE = /zombie|skeleton|spider|creeper|enderman|witch|drowned|husk|stray|slime|bogged|phantom|pillager|vindicator|blaze|magma_cube|silverfish|guardian|hoglin|piglin/i
const JUNK = /^(item|experience_orb|arrow|egg|snowball|ender_pearl|eye_of_ender|potion|splash_potion)$/i
/** 中文别名（跟 core.mjs 的 NAME_ALIAS 反着来，只挑常见的） */
const CN = {
  zombie: '僵尸', skeleton: '骷髅', creeper: '苦力怕', spider: '蜘蛛', enderman: '末影人',
  witch: '女巫', drowned: '溺尸', slime: '史莱姆', blaze: '烈焰人', cow: '牛', pig: '猪',
  sheep: '羊', chicken: '鸡', rabbit: '兔', horse: '马', wolf: '狼', cat: '猫', villager: '村民',
  squid: '鱿鱼', salmon: '鲑鱼', cod: '鳕鱼', bee: '蜜蜂', dolphin: '海豚', llama: '羊驼',
  panda: '熊猫', fox: '狐狸', parrot: '鹦鹉', bat: '蝙蝠', iron_golem: '铁傀儡',
}

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) }
  else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n${t}`)
const say = (s) => console.log(`  · ${s}`)

const lockDir = mkdtempSync(join(tmpdir(), 'wc-live-atk-'))
const logFile = join(lockDir, 'live-attack.log')
writeFileSync(logFile, '')
const mc = new McBot({ instanceId: 'live-attack', lockDir, logFile })

/** 半径内的实体（带名字/距离/是否敌对） */
const rowsOf = (b, radius = 24) => Object.values(b.entities ?? {})
  .filter((e) => e && e !== b.entity && e.position)
  .map((e) => ({
    e,
    name: String(e.username ?? e.name ?? e.displayName ?? '?'),
    d: Number(e.position.distanceTo(b.entity.position).toFixed(2)),
    hostile: HOSTILE.test(String(e.name ?? '')),
    player: Boolean(e.username) || String(e.type) === 'player',
    junk: JUNK.test(String(e.name ?? '')),
  }))
  .filter((r) => r.d <= radius)
  .sort((a, c) => a.d - c.d)

/** 走向某个坐标，最多试 n 次（每次 11 秒预算里的 4 秒） */
const goNear = async (mc, b, pos, within = 3.2, tries = 6) => {
  for (let i = 0; i < tries; i++) {
    const d = Number(b.entity.position.distanceTo(pos).toFixed(2))
    if (d <= within) return d
    await mc.walkTo({ x: pos.x, y: pos.y, z: pos.z }, { arrive: within, budget: 4000 })
  }
  return Number(b.entity.position.distanceTo(pos).toFixed(2))
}

try {
  section('⓪ 连接')
  await mc.connect({ host: HOST, port: PORT, auth: AUTH })
  let b = mc.requireBot()
  const p = mc.position
  say(`连上了 @ (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})  version=${b.version}  血 ${b.health}`)
  ok(mc.online === true, '在线', `version=${b.version}`)

  /* 🔴 刚连上时区块/实体还没发全（探针里"96 格内 0 个实体"就是这么来的）—— 等一下再扫 */
  try { await mc.waitForChunks() } catch { /* 等不到也继续 */ }
  await sleep(3_000)
  say(`等区块：96 格内实体 ${rowsOf(b, 96).length} 个`)

  const all = rowsOf(b, 96)
  say(`96 格内实体 ${all.length} 个，最近 8 个：`)
  for (const r of all.slice(0, 8)) say(`  ${r.name} ${r.d} 格${r.hostile ? '（敌对）' : ''}${r.junk ? '（掉落物）' : ''}`)

  /* ① who 匹配：英文名 / 全大写 / 中文别名 —— **每次重新挑目标**：
   *   修好之后 attack 是"真打"（自己等目标死），第一下就可能把目标打死；打死后再按那个名字找当然找不到。 */
  section('① mc.attack({who}) 按名字找得到（英文 / 大写 / 中文别名）')
  const pickVictim = (maxR = 96) => rowsOf(b, maxR).find((r) => !r.hostile && !r.player && !r.junk && !JUNK.test(String(r.name)))
  let victim = pickVictim()
  const tryWho = async (who, label) => {
    const v = pickVictim()
    if (!v) { ok(true, `${label}：96 格内没有"打了不心疼"的非敌对实体 —— 验不成（如实说，不算失败）`); return }
    const near = await goNear(mc, b, v.e.position)
    if (near > 22) {
      ok(true, `${label}：${v.name} 走不过去（还差 ${near} 格，超过 24 格追不上）—— 验不成（如实说，不算失败）`)
      return
    }
    const r = await mc.attack({ who, budget: 800 })     // 只验"名字认不认"，预算给短一点，别真打死
    ok(r.attacked === v.name, `${label}：who:"${who}" 打到 ${v.name}（${near} 格，自己追过去）`, JSON.stringify(r))
    victim = v
  }
  if (!victim) {
    ok(true, '96 格内没有"打了不心疼"的非敌对实体 —— 这一条验不成（如实说，不算失败）')
  } else {
    await tryWho(victim.name, '英文名')
    const first = victim
    await tryWho(String(first.name).toUpperCase(), '全大写')
    const cn = CN[first.name]
    if (cn) await tryWho(cn, `中文别名 ${cn}`)
    else say(`（${first.name} 没在脚本的中文别名表里，跳过中文别名那一条）`)
  }

  /* ①.5 真打得着：挑一只动物打死（旧写法会回 attacked，而对方一滴血没掉） */
  section('①.5 真打得着 —— 打死一只（旧写法：报 attacked 却一下没打）')
  {
    const ANIMAL = /^(cow|sheep|pig|chicken|rabbit|squid|salmon|cod|horse|donkey|mule|llama|fox|wolf|cat|parrot|bee)$/i
    const pick = rowsOf(b, 48).filter((r) => ANIMAL.test(String(r.name))).sort((a, c) => a.d - c.d)[0]
    if (!pick) {
      ok(true, '48 格内没有能打的动物 —— 这一条验不成（如实说，不算失败）')
    } else {
      const near = await goNear(mc, b, pick.e.position, 3.0, 8)
      const id = pick.e.id
      const hp0 = (() => { try { return b.util?.entity?.getHealth?.(pick.e) ?? null } catch { return null } })()
      const t0 = Date.now()
      const r = await mc.attack({ who: pick.name, budget: 10_000 })
      const gone = !b.entities?.[id]
      ok(r.via === 'pvp' && r.waitedMs > 0, `pvp 路径真的等了（waitedMs=${r.waitedMs}）`, `墙钟 ${Date.now() - t0}ms`)
      ok(typeof r.killed === 'boolean', '返回值如实报 killed', JSON.stringify(r))
      ok(gone === r.killed, 'killed 与实体表一致（没谎报）', `实体表里${gone ? '没了' : '还在'} / killed=${r.killed}`)
      ok(r.killed === true, `${pick.name}（${near} 格，血 ${hp0 ?? '?'}）被打死了`, JSON.stringify(r))
      if (!r.killed) say(`（没打死：${r.note ?? '没有 note'} —— 追不上不等于没修好，但这一条要记下来）`)
    }
  }

  /* ③ 不给 who：脚边就算掉了东西，也该继续打动物/怪，而不是打掉落物 */
  section('③ 不给 who → 怪/动物优先（不打脚边的掉落物）')
  const now = rowsOf(b, 24)
  const junkNear = now.find((r) => r.junk)
  const back = victim ? now.find((r) => r.e === victim.e || r.name === victim.name) : null
  say(`24 格内：${now.slice(0, 6).map((r) => `${r.name} ${r.d} 格`).join('、') || '（空）'}`)
  if (!back || back.d > 4.5) {
    ok(true, `打完它离我 ${back ? back.d : '?'} 格（超过 4.5）—— 不给 who 这条只对 4.5 格内的生物生效，`
      + '这一条验不成（如实说，不算失败）')
  } else {
    const r4 = await mc.attack({ budget: 800 })
    ok(!JUNK.test(String(r4.attacked ?? '')), 'bare attack 没有去打掉落物/经验球', JSON.stringify(r4))
    ok(r4.attacked === victim.name || HOSTILE.test(String(r4.attacked ?? '')),
      'bare attack 打的是生物（怪优先，其次动物）',
      `attacked=${r4.attacked}${junkNear ? `；脚边有 ${junkNear.name} ${junkNear.d} 格` : '；24 格内没掉落物'}`)
  }

  /* ② 找不到时列出"实际有谁" */
  section('② 名字不存在 → 报错里列出半径内实际有谁')
  let err = null
  try { await mc.attack({ who: 'enderman-绝对没有这个', budget: 300 }) } catch (e) { err = e }
  const msg = String(err?.message ?? '')
  ok(/附近找不到/.test(msg), '如实说找不到', msg.slice(0, 80))
  ok(/24 格内实际有/.test(msg), '把半径内实际有谁列出来了', msg.slice(0, 200))
  const near24 = rowsOf(b, 24)
  ok(near24.length === 0 || new RegExp(near24[0].name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(msg),
    '列表里至少有一个刚才真看到的实体', near24.length ? near24[0].name : '（本来就没有）')

  /* ④ force 真重连 */
  section('④ connect({force:true}) 真重连')
  const oldBot = mc.bot
  const oldAt = oldBot._createdAt
  const r = await mc.connect({ host: HOST, port: PORT, auth: AUTH, force: true })
  const nb = mc.requireBot()
  ok(nb !== oldBot && r !== oldBot, '换成了一个新的 bot 对象（世界/实体重新收）', `same=${nb === oldBot}`)
  ok(nb._createdAt >= oldAt, '新连接的时间戳更新', `${oldAt} → ${nb._createdAt}`)
  ok(mc.online === true, '重连后仍在线')
  const ready = await mc.waitForChunks()
  ok(ready !== false, '重连后区块照旧能加载', String(ready))
  b = nb
  const rows2 = rowsOf(b, 24)
  say(`重连后 24 格内实体 ${rows2.length} 个`)
  ok(Array.isArray(rows2), '重连后实体表可读（没把世界搞坏）', `${rows2.length} 个`)

  section('⑤ 收尾')
  say(`血 ${b.health} / 食物 ${b.food}；背包 ${b.inventory.items().length} 格`)
} catch (e) {
  fail++
  console.log(`\n✗ 脚本异常：${e?.stack ?? e}`)
} finally {
  try { await mc.disconnect('实机验证收尾') } catch {}
  try { rmSync(lockDir, { recursive: true, force: true }) } catch {}
  console.log(`\nlive-attack：pass=${pass} fail=${fail}`)
  setTimeout(() => process.exit(fail ? 1 : 0), 300)
}
