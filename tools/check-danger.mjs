#!/usr/bin/env node
/**
 * 危险信号自检 —— `src/danger.mjs`（长循环"挨打就带进度退出"的判据层）
 *
 * 为什么有这一套（用户 2026-10-17「工具排队执行，有个队列工具使用，延迟很大」）：
 *   实机一个晚上 61 次调用、总耗时 334.6 秒，其中 **301.4 秒（90%）在 >=5000ms 的调用里**；
 *   `mc_sequence` 34 次平均 7071ms、最长 11010ms（顶到 CALL_MS 硬上限）。
 *   而**一次调用是原子的** —— 循环里只查 `abortSignal` 和预算，没人查"我正在挨打"。
 *   于是：12 个 break 往下挖竖井 → 骷髅跟下来一路射 → AI 要等 10 秒过完才知道
 *   （日志里 `mc_auto：zombie 贴上来 → 已叫醒 AI 定策略` 比那条调用结束早 5 秒）。
 *
 * 这一套钉死四件事：
 *   ① **判据保守** —— 掉血最硬；怪只认 `DANGER_HOSTILE_R`（3）格内的。
 *      **8 格外有只僵尸不算**：反射层会为它叫醒 AI，但砍断一个正常的挖掘串会让"挖 12 格"
 *      变成 12 次调用，反而更慢（那正是要修的病）。
 *   ② **读不到 ≠ 没有** —— `healthOf()` 读不到回 `null` 不回 0；`hp0 == null`（循环开始时
 *      就读不到血）时**掉血这一条不判**，不能拿 null 比大小。
 *   ③ **掉血优先于有怪** —— "已经打到我身上了"比"有怪在附近"硬。
 *   ④ **真接进了长循环** —— 三个循环（`sequence` / `build` / `mining`）都要 import 它、
 *      每轮调 `dangerNow()`，而且**排在预算检查之前**（还剩 8 秒也不该继续挖）。
 *
 * 用法：node tools/check-danger.mjs
 */
import { readFileSync } from 'node:fs'
import vec3pkg from 'vec3'

const Vec3 = vec3pkg.Vec3 ?? vec3pkg
const {
  DANGER_HOSTILE_R, DANGER_HP_LOST,
  healthOf, nearestHostile, dangerNow, dangerText,
  breathNear, breathText, BREATH_NEAR_R, BREATH_RE,
  fireballNear, fireballText, FIREBALL_NEAR_R, FIREBALL_RE, predictImpact,
} = await import(new URL('../src/danger.mjs', import.meta.url))

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}${extra ? `  → ${extra}` : ''}`) }
}
const section = (t) => console.log(`\n── ${t} ──`)
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** 假 bot：只要 `entity.position` / `entities` / `health` 三样（`danger.mjs` 只认这三样） */
const fakeBot = ({ at = [0, 64, 0], health = 20, mobs = [] } = {}) => ({
  health,
  entity: { position: new Vec3(at[0], at[1], at[2]) },
  entities: Object.fromEntries(mobs.map((m, i) => [i + 1, {
    name: m.name,
    kind: m.kind,
    type: m.type ?? 'mob',
    position: new Vec3(m.at[0], m.at[1], m.at[2]),
    ...(m.velocity ? { velocity: new Vec3(m.velocity[0], m.velocity[1], m.velocity[2]) } : {}),
  }])),
})

section('① healthOf：读不到回 null，不回 0')
ok(healthOf({ health: 17 }) === 17, '数字照读', String(healthOf({ health: 17 })))
ok(healthOf({ health: 0 }) === 0, '0 是合法值（真死了）—— 不能和"读不到"混为一谈')
ok(healthOf({}) === null, '没有 health ⇒ null', String(healthOf({})))
ok(healthOf({ health: 'abc' }) === null, '不是数字 ⇒ null')
ok(healthOf(null) === null, 'bot 都没有 ⇒ null')
ok(healthOf({ health: NaN }) === null, 'NaN ⇒ null')

section('② nearestHostile：只认近处的敌对怪')
{
  const b = fakeBot({ mobs: [
    { name: 'cow', at: [1, 64, 0] },              // 近，但不是敌对
    { name: 'zombie', at: [2, 64, 0] },           // 敌对，2 格
    { name: 'skeleton', at: [1.5, 64, 0] },       // 敌对，更近
    { name: 'creeper', at: [30, 64, 0] },         // 敌对，太远
  ] })
  const n = nearestHostile(b, DANGER_HOSTILE_R)
  ok(n?.name === 'skeleton', '最近的敌对怪是 skeleton（不是更近的 cow）', String(n?.name))
  ok(n?.distance === 1.5, '距离算得对', String(n?.distance))
  ok(n?.position?.x === 1 && n?.position?.y === 64 && n?.position?.z === 0, '带上整数坐标（给 AI 看的）', JSON.stringify(n?.position))
}
{
  const b = fakeBot({ mobs: [{ name: 'zombie', at: [5, 64, 0] }] })
  ok(nearestHostile(b, 3) === null, '5 格外、半径 3 ⇒ null（不砍断正常干活）')
  ok(nearestHostile(b, 8)?.name === 'zombie', '半径给 8 就看得见')
}
{
  const b = fakeBot({ mobs: [{ name: 'something', kind: 'Hostile mobs', at: [1, 64, 0] }] })
  ok(nearestHostile(b, 3)?.name === 'something', '名字认不出但 kind 是 Hostile mobs ⇒ 也算（与 mc_auto 同判据）')
}
{
  const b = fakeBot({ mobs: [{ name: 'player_steve', type: 'player', at: [1, 64, 0] }] })
  ok(nearestHostile(b, 3) === null, '玩家不算敌对（不自动把玩家当威胁）')
}
{
  const b = fakeBot({ mobs: [{ name: 'zombie', at: [1, 64, 0] }] })
  b.entity = null
  ok(nearestHostile(b, 3) === null, '读不到自己坐标 ⇒ null（不编）')
  ok(nearestHostile(null, 3) === null, '没有 bot ⇒ null')
}

section('②′ 中立怪：不主动打我 = 不是威胁（2026-10-18 审计）')
{
  /* 末影人 / 猪灵 / 狼 / 铁傀儡 在 `HOSTILE_RE` 里，但**默认中立**。
   * 以前它们一走到 3 格内就 `nearestHostile` 非 null ⇒ 长循环被砍断、任务被暂停，
   * 而 `mc_act{attack}` 又不打它们（`hostilityOf` 口径相反）。现在只认 `hostile`。 */
  const calm = fakeBot({ mobs: [{ name: 'enderman', at: [1, 64, 0] }] })
  calm.entities[1].target = null
  ok(nearestHostile(calm, 3) === null, '末影人站着不动 ⇒ 不算威胁')
  /* 🔴 2026-10-20 审计：原来这里断言「末影人 target === 我 ⇒ 算威胁」，可
   *    **prismarine-entity 根本没有 `target` 字段** —— 假 bot 里有，真机上永远 undefined，
   *    这条断言等于在保护一段死代码。真"它在打我"的判据是**掉血**（见 ③ 的 hurt），
   *    所以现在断言的是"就算给它塞个 target，也不靠它判"（中立怪不按 proximity 算威胁）。 */
  const angry = fakeBot({ mobs: [{ name: 'enderman', at: [1, 64, 0] }] })
  angry.entities[1].target = angry.entity
  ok(nearestHostile(angry, 3) === null,
    '🔴 中立怪只看 `target` 是死代码（真机没这个字段）⇒ 它贴脸也不算威胁，交给掉血判据')
  const zombie = fakeBot({ mobs: [{ name: 'zombie', at: [1, 64, 0] }] })
  zombie.entities[1].target = null
  ok(nearestHostile(zombie, 3)?.name === 'zombie', '僵尸天然敌对 ⇒ 不管它盯不盯我都算')
}

section('③ dangerNow：掉血最硬，其次才是怪贴脸')
{
  const b = fakeBot({ health: 17, mobs: [{ name: 'zombie', at: [1, 64, 0] }] })
  const d = dangerNow(b, { hp0: 20 })
  ok(d?.kind === 'hurt', '掉了 3 点血 ⇒ kind=hurt（哪怕旁边也有怪）', JSON.stringify(d))
  ok(d?.hp0 === 20 && d?.health === 17 && d?.lost === 3, '把 20 → 17 如实带上', JSON.stringify(d))
}
ok(dangerNow(fakeBot({ health: 20 }), { hp0: 20 }) === null, '一点没掉、也没怪 ⇒ null')
ok(dangerNow(fakeBot({ health: 20 }), { hp0: 20.5 }) === null, '掉 0.5 点 < DANGER_HP_LOST(1) ⇒ 不算挨打')
ok(DANGER_HP_LOST === 1, 'DANGER_HP_LOST 就是 1（被僵尸碰一下）', String(DANGER_HP_LOST))
ok(DANGER_HOSTILE_R === 3, 'DANGER_HOSTILE_R 就是 3（僵尸再走一步就够到）', String(DANGER_HOSTILE_R))
{
  const b = fakeBot({ health: 20, mobs: [{ name: 'zombie', at: [2, 64, 0] }] })
  const d = dangerNow(b, { hp0: 20 })
  ok(d?.kind === 'hostile', '没掉血但有怪贴脸 ⇒ kind=hostile', JSON.stringify(d))
  ok(d?.name === 'zombie' && d?.distance === 2, '怪的名字和距离都在', JSON.stringify(d))
}
{
  /* 🔴 这一条是"不能拿 null 比大小"的正面用例：循环开始时就读不到血 ⇒ 掉血这条**不判** */
  const b = fakeBot({ health: 3 })
  ok(dangerNow(b, { hp0: null }) === null, 'hp0 读不到 ⇒ 不掉血这条不判（3 点血也不许凭 null 判挨打）')
  const b2 = fakeBot({ health: null, mobs: [{ name: 'zombie', at: [2, 64, 0] }] })
  ok(dangerNow(b2, { hp0: 20 })?.kind === 'hostile', '现在读不到血、但有怪 ⇒ 只报怪，不报掉血')
}
{
  const b = fakeBot({ health: 20, mobs: [{ name: 'zombie', at: [2, 64, 0] }] })
  ok(dangerNow(b, { hp0: 20, radius: 1 }) === null, '半径能调（1 格内没怪 ⇒ null）')
}

section('④ dangerText：给人看的一句话')
ok(dangerText(null) === null, 'null 进 null 出')
{
  const t = dangerText({ kind: 'hurt', hp0: 20, health: 17 })
  ok(/20/.test(t) && /17/.test(t), '挨打那句带上血量变化', t)
}
{
  const t = dangerText({ kind: 'hostile', name: 'zombie', distance: 2, position: { x: 1, y: 64, z: 0 } })
  ok(/zombie/.test(t) && /2/.test(t), '怪那句带上名字和距离', t)
  ok(/1, 64, 0/.test(t), '还带上坐标（AI 要知道它在哪）', t)
}

section('⑤ 接线：三个长循环都真接上了，而且排在预算检查之前')
for (const [file, label] of [
  ['../src/sequence.mjs', 'sequence'],
  ['../src/build.mjs', 'build'],
  ['../src/mining.mjs', 'mining'],
]) {
  const src = read(file)
  ok(/from '\.\/danger\.mjs'/.test(src), `${label}：import 了 danger.mjs`)
  ok(/dangerNow\(/.test(src), `${label}：真调了 dangerNow()`)
  ok(/healthOf\(/.test(src), `${label}：循环开始时记了血量（healthOf）`)
}
{
  const src = read('../src/sequence.mjs')
  ok(/interrupted: 'danger'/.test(src), 'sequence：结果里有 interrupted:\'danger\'（能直接判，不用啃自然语言）')
  ok(/const hp0 = healthOf\(self\.bot\)/.test(src), 'sequence：hp0 在循环**外面**记一次')
  /* 🔴 顺序断言：危险检查必须在预算检查**之前** —— 否则"预算还有 8 秒"会先 break，怪就白来了 */
  const iDanger = src.search(/dangerNow\(self\.bot, \{ hp0 \}\)/)
  const iBudget = src.indexOf('if (Date.now() - t0 > bd)')
  ok(iDanger > 0 && iBudget > 0 && iDanger < iBudget, 'sequence：危险检查排在预算检查之前', `danger@${iDanger} budget@${iBudget}`)
  ok(/steps 从第 \$\{next \+ 1\} 步往后发/.test(src), 'sequence：hint 告诉 AI 从哪一步接着发（不白挖前面那几步）')
}
{
  const src = read('../src/build.mjs')
  ok(/interrupted: 'danger'/.test(src), 'build：结果里有 interrupted:\'danger\'')
  const iDanger = src.search(/dangerNow\(b, \{ hp0 \}\)/)
  const iDead = src.indexOf('if (deadline - Date.now() < 300) break')
  ok(iDanger > 0 && iDead > 0 && iDanger < iDead, 'build：危险检查排在预算检查之前')
}
{
  const src = read('../src/mining.mjs')
  const iDanger = src.search(/dangerNow\(b, \{ hp0 \}\)/)
  const iLeft = src.indexOf('const left = leftOf()')
  ok(iDanger > 0 && iLeft > 0 && iDanger < iLeft, 'mining：危险检查排在预算检查之前')
  ok(/先别挖了/.test(src), 'mining：收工时如实说"先别挖了"')
}

section('⑥ 龙息云：踩进去每 0.5 秒掉 4 点血（用户 2026-10-19「检测到龙息应该提醒」）')
{
  /* 为什么单独一条：`area_effect_cloud` **不是敌对实体**（`nearestHostile` 看不见它），
   * 不进去也不掉血 —— 以前的整套报险逻辑对它零反应，末地那趟就是站在云里被熏死的。 */
  ok(BREATH_RE.test('area_effect_cloud') && !BREATH_RE.test('enderman'), 'BREATH_RE 只认 area_effect_cloud')
  ok(BREATH_NEAR_R === 6, '提醒半径 6 格（云半径 3 + 一步退路）', String(BREATH_NEAR_R))

  const cloud = fakeBot({ at: [0, 64, 0], mobs: [{ name: 'area_effect_cloud', at: [4, 64, 0] }] })
  const c = breathNear(cloud)
  ok(c && c.distance === 4, '4 格外的云 ⇒ 报 distance 4', JSON.stringify(c?.distance))
  ok(c?.escape?.dx === -1 && c?.escape?.dz === 0, 'escape 是背离云心的水平单位向量（云在东边 ⇒ 往西跑）', JSON.stringify(c?.escape))
  ok(/龙息云在 4 格/.test(breathText(c) ?? ''), 'breathText 一句话说清"几格、往哪跑"', String(breathText(c)))
  ok(c?.escape?.blocks >= 8 && c?.escape?.blocks > c.distance, '跑的距离 ≥ 8 且跑出云外', String(c?.escape?.blocks))
  ok(c?.escape?.x === -c.escape.blocks, '落点坐标 = 我 + 方向 × 格数', JSON.stringify([c?.escape?.x, c?.escape?.z]))

  const far = fakeBot({ at: [0, 64, 0], mobs: [{ name: 'area_effect_cloud', at: [7, 64, 0] }] })
  ok(breathNear(far) === null, '7 格（> 6）不报 —— 别为远处的云神经质地叫醒')
  ok(breathNear({ entity: { position: new Vec3(0, 64, 0) } }) === null, '没有 entities ⇒ null，不炸')
  ok(breathNear({ entity: { position: new Vec3(0, 64, 0) }, entities: { 1: { name: 'area_effect_cloud' } } }) === null,
    '云没有 position ⇒ 跳过，不炸')

  const onMe = fakeBot({ at: [0, 64, 0], mobs: [{ name: 'area_effect_cloud', at: [0, 64, 0] }] })
  const om = breathNear(onMe)
  ok(om && Math.hypot(om.escape.dx, om.escape.dz) > 0.99, '云心就在脚下：escape 仍是有效的单位向量（不会 0/0）', JSON.stringify(om?.escape))

  /* 掉血 vs 龙息 vs 有怪：龙息要排在"有怪贴脸"前面（已经在掉血了，怪还没打到） */
  const both = fakeBot({ at: [0, 64, 0], mobs: [
    { name: 'area_effect_cloud', at: [3, 64, 0] },
    { name: 'zombie', at: [1, 64, 0] },
  ] })
  const d = dangerNow(both)
  ok(d?.kind === 'breath', '龙息 + 僵尸贴脸 ⇒ 先报龙息', JSON.stringify(d?.kind))
  ok(/龙息/.test(dangerText(d) ?? ''), 'dangerText 说"龙息"', String(dangerText(d)))
  ok(/跑 \d+ 格/.test(dangerText(d) ?? ''), 'dangerText 带上"往哪跑几格"', String(dangerText(d)))
}

section('⑦ 龙息火球（还在飞的那颗）：比云早几秒报警（用户 2026-10-19「只能落地的才能检测到吗」）')
{
  /* 为什么要有它：飞到半路的是 `dragon_fireball`（projectile），**落地/碰撞后才生成**
   * `area_effect_cloud`。只盯云 = 只在"已经晚了"的那一刻报警。 */
  ok(FIREBALL_RE.test('dragon_fireball') && !FIREBALL_RE.test('area_effect_cloud'), 'FIREBALL_RE 只认 dragon_fireball')
  ok(FIREBALL_NEAR_R === 32, '火球提醒半径 32 格（用户 2026-10-19 指定，要留出决策时间）', String(FIREBALL_NEAR_R))

  const toward = fakeBot({ at: [0, 64, 0], mobs: [{ name: 'dragon_fireball', at: [8, 64, 0], velocity: [-1, 0, 0] }] })
  const f = fireballNear(toward)
  ok(f && f.distance === 8, '8 格外的火球 ⇒ distance 8', JSON.stringify(f?.distance))
  ok(f?.inbound === true, '速度朝我 ⇒ inbound true（能分辨"朝我飞"和"路过"）', JSON.stringify(f?.inbound))
  ok(f?.escape?.dx === -1 && Math.hypot(f.escape.dx, f.escape.dz) > 0.99, '侧移方向是背离火球的单位向量', JSON.stringify(f?.escape))
  ok(/龙息火球在 8 格/.test(fireballText(f) ?? ''), 'fireballText 一句话说清', String(fireballText(f)))

  const away = fakeBot({ at: [0, 64, 0], mobs: [{ name: 'dragon_fireball', at: [8, 64, 0], velocity: [1, 0, 0] }] })
  ok(fireballNear(away)?.inbound === false, '速度背离我 ⇒ inbound false', JSON.stringify(fireballNear(away)?.inbound))
  const noVel = fakeBot({ at: [0, 64, 0], mobs: [{ name: 'dragon_fireball', at: [8, 64, 0] }] })
  ok(fireballNear(noVel)?.inbound === null, '读不到速度 ⇒ inbound null（不瞎猜）', JSON.stringify(fireballNear(noVel)?.inbound))

  ok(fireballNear(fakeBot({ at: [0, 64, 0], mobs: [{ name: 'dragon_fireball', at: [32, 64, 0] }] }))?.distance === 32,
    '32 格边界仍在提醒范围内（用户要的半径）')
  ok(fireballNear(fakeBot({ at: [0, 64, 0], mobs: [{ name: 'dragon_fireball', at: [33, 64, 0] }] })) === null,
    '33 格（> 32）不报')
  /* 火球和云同时在场：火球更早 ⇒ 先报火球；云和僵尸同时：先报云 */
  const bothHaz = fakeBot({ at: [0, 64, 0], mobs: [
    { name: 'area_effect_cloud', at: [3, 64, 0] },
    { name: 'dragon_fireball', at: [9, 64, 2] },
    { name: 'zombie', at: [1, 64, 0] },
  ] })
  ok(dangerNow(bothHaz)?.kind === 'fireball', '火球 + 云 + 僵尸 ⇒ 先报火球', JSON.stringify(dangerNow(bothHaz)?.kind))
  ok(/火球/.test(dangerText(dangerNow(bothHaz)) ?? ''), 'dangerText 说"火球"', String(dangerText(dangerNow(bothHaz))))
}

section('⑧ 火球落点预测（用户 2026-10-19「这里可以改成落点吗」）')
{
  /* 报"它现在在哪"没用 —— 云长在落点上，AI 只需要知道"落点离我几格、要不要挪"。 */
  const Vec = Vec3
  /** 造一个"只有某几格是实心"的世界：keys 形如 'x,y,z' */
  const solidAt = (keys) => (p) => {
    const k = `${p.x},${p.y},${p.z}`
    return keys.has(k)
      ? { name: 'end_stone', position: new Vec(p.x, p.y, p.z), boundingBox: 'block' }
      : { name: 'air', position: new Vec(p.x, p.y, p.z), boundingBox: 'empty' }
  }
  const pos = new Vec(0, 65, 0)
  const vel = new Vec(1, 0, 0)   // 朝 +x 直飞

  const imp = predictImpact({ blockAt: solidAt(new Set(['12,65,0'])), entity: { position: new Vec(0, 64, 0) } }, pos, vel)
  ok(imp && imp.x === 12 && imp.z === 0, '撞到 x=12 的墙 ⇒ 落点 (12, ·, 0)', JSON.stringify(imp))
  ok(imp?.y === 66, '落点报**墙上方那一层**（云长在落点上面）', String(imp?.y))
  ok(imp?.blocks > 11 && imp?.blocks <= 12, '落点距离 ≈ 12（沿速度方向推进的格数）', String(imp?.blocks))
  ok(imp?.distanceToMe === 12 && imp?.hitsMe === false, '离我 12 格 ⇒ hitsMe false', JSON.stringify([imp?.distanceToMe, imp?.hitsMe]))

  const close = predictImpact({ blockAt: solidAt(new Set(['2,65,0'])), entity: { position: new Vec(0, 64, 0) } }, pos, vel)
  ok(close?.hitsMe === true, '落点离我 2 格（< 云半径 3.5）⇒ hitsMe true', JSON.stringify([close?.distanceToMe, close?.hitsMe]))

  ok(predictImpact({}, pos, vel) === null, '没有 blockAt ⇒ null（不瞎猜落点）')
  ok(predictImpact({ blockAt: () => null, entity: { position: new Vec(0, 64, 0) } }, pos, new Vec(0, 0, 0)) === null, '速度 0 ⇒ null')
  ok(predictImpact({ blockAt: () => null, entity: { position: new Vec(0, 64, 0) } }, pos, vel) === null,
    '一路没有实心方块（读不到区块）⇒ null，不会假装算出了落点')

  /* 接进 fireballNear：文案里报落点而不是"它现在在哪" */
  const bot = {
    entity: { position: new Vec(0, 64, 0) },
    blockAt: solidAt(new Set(['20,70,0'])),
    entities: { 1: { name: 'dragon_fireball', position: new Vec(8, 70, 0), velocity: new Vec(1, 0, 0) } },
  }
  const f = fireballNear(bot)
  ok(f?.impact?.x === 20, 'fireballNear 带上 impact（落点 x=20）', JSON.stringify(f?.impact))
  const txt = fireballText(f) ?? ''
  ok(/落点 \(20, 0\)/.test(txt), 'fireballText 报落点坐标', txt)
  ok(/离我 20 格/.test(txt), 'fireballText 报"落点离我几格"', txt)

  /* 一路没撞到方块（末地大片空/未加载）：退化成"离我最近的掠过点"，标 approx */
  const open = {
    entity: { position: new Vec(0, 64, 0) },
    blockAt: () => null,
    entities: { 1: { name: 'dragon_fireball', position: new Vec(30, 64, 0), velocity: new Vec(-1, 0, 0) } },
  }
  const g = fireballNear(open)
  ok(g?.impact?.approx === true, '撞不到方块时给"掠过点"（approx:true）', JSON.stringify(g?.impact))
  ok(g?.impact?.distanceToMe === 0 && g?.impact?.hitsMe === true, '正对我飞 ⇒ 掠过点就在我身上（hitsMe true）',
    JSON.stringify([g?.impact?.distanceToMe, g?.impact?.hitsMe]))
  ok(/掠过点约/.test(fireballText(g) ?? ''), '文案写"掠过点约"而不是假装是落点', String(fireballText(g)))
}

console.log(`\n${'─'.repeat(50)}\ncheck-danger：pass=${pass} fail=${fail}`)
process.exit(fail ? 1 : 0)
