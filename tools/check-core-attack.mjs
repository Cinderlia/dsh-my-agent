#!/usr/bin/env node
/**
 * check-core-attack.mjs —— 「打怪 / 采集挑目标 / 真重连」的回归检查
 *
 * 背景（用户 2026-10-08 转来游戏里 AI 的四条实机反馈）：
 *   ① `mc_act {mode:"attack", who:"zombie"}` 报 `附近找不到 "zombie"`，不给 who 才打得着；
 *   ② `mc_dig` 挑到够不着的目标就把整轮 11 秒吃光（只能自己改用 mc_sequence 连着 break）；
 *   ③ 挖着挖着报"那里本来就是空气"，重连也清不掉 —— 因为**已连着时 mc_connect 是空操作**。
 *   ④ 顺手抓到的：不给 who 时会先打到脚边的掉落物（AI 自己都发现了）。
 *
 * 这个脚本把修好的行为钉死：
 *   A. who 匹配看所有名字字段（username/name/displayName/type/kind）+ 中文别名；
 *      找不到时**列出半径内实际有谁**（别只丢一句"附近找不到"）。
 *   B. 不给 who：敌对 > 玩家 > 动物 > 掉落物；**只追怪**（动物/玩家仍限 4.5 格内，
 *      否则会跑 6 格去揍玩家拴着的马）。
 *   C. dig：目标按距离升序；单个目标最多吃掉"剩余时间的一大半"；寻路 thinkTimeout 临时压低并还原。
 *   D. connect({force:true}) 才真重连（先 quit 旧连接 → 再 createBot）；不带 force 且已连着 = 空操作。
 *
 * 用法：node tools/check-core-attack.mjs
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { EventEmitter } from 'node:events'

// ── 断言小工具（和别的 check-*.mjs 一致）────────────────────────────────────────
let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n${t}`)

// ── 借依赖 ────────────────────────────────────────────────────────────────────
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILE = join(DSH_HOME, 'profiles', 'desktop')
const req = (() => {
  const bases = [
    new URL('../index.js', import.meta.url).href,
    join(PROFILE, 'node_modules', 'dsh-mc-agent', 'index.js'),
    join(PROFILE, 'index.js'),
  ]
  for (const base of bases) {
    try { const r = createRequire(base); r('mineflayer'); return r } catch {}
  }
  return null
})()
if (!req) {
  console.log('✗ 拿不到 mineflayer —— 请从包目录（<profile>/node_modules/dsh-mc-agent）跑。')
  process.exit(2)
}
const Vec3 = req('vec3')
const mineflayer = (await import('mineflayer')).default
const { McBot } = await import(new URL('../src/core.mjs', import.meta.url))

const TMP_DIRS = []
const mkMc = (fake) => {
  const dir = mkdtempSync(join(tmpdir(), 'wc-coreatk-'))
  TMP_DIRS.push(dir)
  const mc = new McBot({ logFile: join(dir, 'check.log') })
  mc.bot = fake.bot
  mc.mcPlugins = fake.plugins ?? {}
  mc.pfReady = true
  mc._pf = {
    goals: { GoalNear: class { constructor(x, y, z, r) { Object.assign(this, { x, y, z, r }) } } },
    Movements: class { constructor() {} },
  }
  mc.cfg.collectBudgetMs = 300
  return mc
}

/** 造一个实体（只要 attack 会读到的字段）—— `pos:{x,y,z}` 或直接 x/y/z 都行 */
const ent = (o) => {
  const { pos, x, y, z, ...rest } = o
  const p = pos ?? { x: x ?? 0, y: y ?? 64, z: z ?? 0 }
  return { position: new Vec3(p.x, p.y, p.z), ...rest }
}

/** 造一个"能被打"的假 bot：pvp 插件记录打了谁 */
const mkFightBot = (entities, { withPvp = true, me = [0, 64, 0] } = {}) => {
  const calls = { attack: [], stop: 0 }
  const bot = {
    entity: { position: new Vec3(me[0], me[1], me[2]) },
    _client: {},
    entities: Object.fromEntries(entities.map((e, i) => [e.id ?? `e${i}`, e])),
    game: { gameMode: 'survival' },
    inventory: { items: () => [] },
    setControlState: () => {},
    on: () => bot,
  }
  bot.entity.id = 'me'
  if (withPvp) {
    bot.pvp = {
      attack: (t) => { calls.attack.push(t); return Promise.resolve() },
      stop: () => { calls.stop++ },
    }
  }
  return { bot, calls, plugins: withPvp ? { pvp: true } : {} }
}

/* ─────────── ① who 匹配：所有名字字段 + 中文别名 ─────────── */
section('① who 匹配 —— 英文名 / 大小写 / displayName / 中文别名 / 玩家的 username')
{
  const mob = (o) => ent({ id: o.id, name: o.name, displayName: o.displayName, type: o.type ?? 'hostile', kind: o.kind ?? 'Hostile mobs', ...o.pos })
  const zombie = mob({ id: 'z1', name: 'zombie', displayName: 'Zombie', pos: { x: 0, y: 64, z: 8 } })
  const skel = mob({ id: 's1', name: 'skeleton', displayName: 'Skeleton', pos: { x: 0, y: 64, z: 10 } })
  const player = ent({ id: 'p1', name: 'player', username: 'Bluezi', displayName: 'Bluezi', type: 'player', kind: 'Other', pos: { x: 2, y: 64, z: 0 } })

  for (const [who, want] of [['zombie', 'z1'], ['ZOMBIE', 'z1'], ['僵尸', 'z1'], ['Zombie', 'z1']]) {
    const f = mkFightBot([zombie, skel, player])
    const mc = mkMc(f)
    const r = await mc.attack({ who, budget: 200 })
    ok(f.calls.attack[0]?.id === want && r.attacked === 'zombie', `who:${JSON.stringify(who)} 打到 ${want}`, `attacked=${r.attacked}`)
  }
  {
    const f = mkFightBot([zombie, skel, player])
    const mc = mkMc(f)
    const r = await mc.attack({ who: 'Bluezi', budget: 200 })
    ok(f.calls.attack[0]?.id === 'p1' && r.attacked === 'Bluezi',
      '玩家按 username 匹配、且如实报玩家名（不是注册表里的 "player"）', `attacked=${r.attacked}`)
  }
  {
    const f = mkFightBot([zombie, skel, player])
    const mc = mkMc(f)
    let err = null
    try { await mc.attack({ who: 'enderman', budget: 200 }) } catch (e) { err = e }
    const msg = String(err?.message ?? '')
    ok(/附近找不到 "enderman"/.test(msg), '找不到时如实说找不到', msg.slice(0, 60))
    ok(/24 格内实际有/.test(msg), '把半径内实际有谁列出来（模型能自己改名重试）', msg.slice(0, 160))
    ok(/zombie/.test(msg) && /Bluezi/.test(msg), '列表里有怪也有玩家（玩家显示 username）', msg.slice(0, 160))
    ok(f.calls.attack.length === 0, '找不到就不动手')
  }
}

/* ─────────── ② 不给 who：怪优先，且只追怪 ─────────── */
section('② 不给 who —— 敌对 > 玩家 > 动物 > 掉落物；只追怪（不追 6 格外的马）')
{
  const item = ent({ id: 'i1', name: 'item', type: 'object', kind: 'Other', pos: { x: 0, y: 64, z: 1 } })
  const cow = ent({ id: 'c1', name: 'cow', type: 'animal', kind: 'Passive mobs', pos: { x: 0, y: 64, z: 2 } })
  const horse = ent({ id: 'h1', name: 'horse', type: 'animal', kind: 'Passive mobs', pos: { x: 0, y: 64, z: 6.8 } })
  const zombie = ent({ id: 'z1', name: 'zombie', type: 'hostile', kind: 'Hostile mobs', pos: { x: 0, y: 64, z: 3 } })
  const farZombie = ent({ id: 'z2', name: 'zombie', type: 'hostile', kind: 'Hostile mobs', pos: { x: 0, y: 64, z: 20 } })
  const player = ent({ id: 'p1', name: 'player', username: 'Bluezi', type: 'player', kind: 'Other', pos: { x: 0, y: 64, z: 12 } })

  {   // 掉落物最近，但旁边有怪 ⇒ 打怪
    const f = mkFightBot([item, zombie, cow])
    const mc = mkMc(f)
    const r = await mc.attack({ budget: 200 })
    ok(f.calls.attack[0]?.id === 'z1', '掉落物在脚边也不先打它（怪优先）', `attacked=${r.attacked}`)
  }
  {   // 只有掉落物 + 动物 ⇒ 打动物
    const f = mkFightBot([item, cow])
    const mc = mkMc(f)
    const r = await mc.attack({ budget: 200 })
    ok(f.calls.attack[0]?.id === 'c1', '没有怪时打动物（不是掉落物）', `attacked=${r.attacked}`)
  }
  {   // 只有 6.8 格外的马 ⇒ 不许跑过去揍它
    const f = mkFightBot([horse])
    const mc = mkMc(f)
    let err = null
    try { await mc.attack({ budget: 200 }) } catch (e) { err = e }
    const msg = String(err?.message ?? '')
    ok(f.calls.attack.length === 0, '不会跑 6 格去揍玩家拴着的马（动物只在 4.5 格内）', msg.slice(0, 80))
    ok(/4\.5 格内没有能打的实体/.test(msg) && /horse 6\.8 格/.test(msg), '如实说没得打、并报最近的是谁', msg.slice(0, 140))
  }
  {   // 20 格外的怪 ⇒ 会追（pvp 自己走过去）
    const f = mkFightBot([farZombie])
    const mc = mkMc(f)
    const r = await mc.attack({ budget: 200 })
    ok(f.calls.attack[0]?.id === 'z2' && r.attacked === 'zombie', '24 格内的怪会追（不再只限 4.5 格）', `distance=${r.distance}`)
  }
  {   // 12 格外的玩家（没怪）⇒ 不追
    const f = mkFightBot([player])
    const mc = mkMc(f)
    let err = null
    try { await mc.attack({ budget: 200 }) } catch (e) { err = e }
    ok(f.calls.attack.length === 0 && /4\.5 格内没有能打的实体/.test(String(err?.message ?? '')),
      '远处的玩家不主动追（要打就点名）', String(err?.message ?? '').slice(0, 90))
  }
  {   // 没有 pvp 插件 ⇒ 退回 4.5 格内挥一下
    const near = ent({ id: 'z9', name: 'zombie', type: 'hostile', kind: 'Hostile mobs', pos: { x: 0, y: 64, z: 3 } })
    const f = mkFightBot([near], { withPvp: false })
    const mc = mkMc(f)
    f.bot.attack = (t) => { f.calls.attack.push(t); return Promise.resolve() }
    const r = await mc.attack({ budget: 200 })
    ok(f.calls.attack[0]?.id === 'z9' && r.via === undefined, '没有 pvp 插件时退回"挥一下"', `attacked=${r.attacked}`)
  }
}

/* ─────────── ③ dig：目标按距离升序 + 别让一个目标吃光整轮 ─────────── */
section('③ dig —— 按距离升序、单个目标预算封顶、thinkTimeout 压低后还原')
{
  const mkDigBot = (specs, { hangFirst = false, at = { x: 0, y: 64, z: 0 } } = {}) => {
    const calls = { collect: [], think: [] }
    const blocks = new Map()
    for (const s of specs) {
      const p = new Vec3(s.x, s.y, s.z)
      blocks.set(`${s.x},${s.y},${s.z}`, { name: 'oak_log', type: 100, boundingBox: 'block', position: p })
    }
    const bot = {
      entity: { position: new Vec3(at.x, at.y, at.z) },
      _client: {},
      game: { gameMode: 'survival' },
      inventory: { items: () => [] },
      heldItem: null,
      registry: { itemsByName: {} },
      blockAt: (p) => blocks.get(`${p.x},${p.y},${p.z}`) ?? null,
      // 原地挖也要**真改世界**：`dig()` 现在会复核"方块还在不在"，假 bot 不删方块就只会报"没挖成"
      dig: async (blk) => { const q = blk?.position; if (q) blocks.delete(`${q.x},${q.y},${q.z}`) },
      findBlocks: () => specs.map((s) => ({ x: s.x, y: s.y, z: s.z })),
      setControlState: () => {},
      on: () => bot,
      pathfinder: {
        thinkTimeout: 8000,
        goto: async () => {},
        stop: () => {},
        setMovements: () => {},
      },
      collectBlock: {
        targets: { empty: true },
        collect: (list) => {
          const t = list[0]
          calls.collect.push({ at: `${t.position.x},${t.position.y},${t.position.z}`, think: bot.pathfinder.thinkTimeout })
          if (hangFirst && calls.collect.length === 1) return new Promise(() => {})   // 第一个永远挖不成
          blocks.delete(`${t.position.x},${t.position.y},${t.position.z}`)
          return Promise.resolve()
        },
        cancelTask: () => { bot.collectBlock.targets.empty = true; return Promise.resolve() },
      },
    }
    return { bot, calls, blocks, plugins: { collectBlock: true } }
  }

  {
    // findBlocks 故意"远的在前"：修好之后必须先挖近的
    // 🔴 2026-10-08：近的（眼到方块中心 2.78 格）走"够得着就原地挖"，远的（20.5 格）**不再交给
    //    collectBlock**（它会从看得见的地方硬挖 ⇒ 服务端拒收、画面"挖完又复原"），而是如实说够不着。
    const f = mkDigBot([{ x: 0, y: 64, z: 20 }, { x: 0, y: 64, z: 2 }])
    const mc = mkMc(f)
    const out = await mc.dig({ name: 'oak_log', count: 2, maxDistance: 24 })
    ok(/挖掉 oak_log @ \(0, 64, 2\)/.test(out[0] ?? ''), '先挖最近的（不再按 findBlocks 的返回顺序）', out[0])
    ok(out.some((l) => /够不着 oak_log @ \(0, 64, 20\)/.test(l)), '远的够不着就如实说（不再硬挖）',
      out.join(' ｜ ').slice(0, 200))
    ok(f.calls.collect.length === 0, 'dig() 全程不调 collectBlock（"挖完又复原"的根因）',
      f.calls.collect.map((c) => c.at).join(' → '))
  }
  {
    // 两个目标都够不着（站位 (0,64,-10)，眼到中心 12 / 14 格）：一个报完不能吃掉另一个
    const f = mkDigBot([{ x: 0, y: 64, z: 2 }, { x: 0, y: 64, z: 4 }], { hangFirst: true, at: { x: 0, y: 64, z: -10 } })
    const mc = mkMc(f)
    const t0 = Date.now()
    const out = await mc.dig({ name: 'oak_log', count: 2, maxDistance: 24 })
    const ms = Date.now() - t0
    ok(f.calls.collect.length === 0, '够不着也不交给 collectBlock', `collect=${f.calls.collect.length}`)
    ok(ms < 3000, '不会被一个目标拖满整轮（这里用 300ms 预算）', `${ms}ms`)
    ok(out.some((l) => /够不着 oak_log @ \(0, 64, 2\)/.test(l))
      && out.some((l) => /够不着 oak_log @ \(0, 64, 4\)/.test(l)),
      '两个够不着的都报到了（一个不影响下一个）', out.join(' ｜ ').slice(0, 200))
    ok(out.some((l) => /先 `mc_move` 到它旁边/.test(l)), '告诉模型先走过去再挖', out.join(' ｜ ').slice(0, 200))
    ok(f.bot.pathfinder.thinkTimeout === 8000, 'dig 不再改插件的 thinkTimeout（以前会临时压低再还原）',
      String(f.bot.pathfinder.thinkTimeout))
  }
}

/* ─────────── ④ connect({force}) 才真重连 ─────────── */
section('④ connect —— 已连着时不重连；force:true 先断开再真连一次')
{
  const mkFakeBot = (seq, tag) => {
    const b = new EventEmitter()
    b.tag = tag
    b.entity = { position: new Vec3(0, 64, 0), id: tag }
    b._client = {}
    b.game = { gameMode: 'survival' }
    b.health = 20
    b.inventory = { items: () => [] }
    b.quit = () => { seq.push(`quit:${tag}`) }
    b.setControlState = () => {}
    b.chat = () => {}
    b._createdAt = Date.now()
    setTimeout(() => b.emit('spawn'), 5)
    return b
  }
  const mkConnMc = (seq) => {
    const dir = mkdtempSync(join(tmpdir(), 'wc-coreatk-'))
    TMP_DIRS.push(dir)
    const mc = new McBot({ logFile: join(dir, 'check.log') })
    mc.setupPlugins = async () => {}
    mc.startObserver = () => {}
    mc.writeLock = () => {}
    mc.cfg.connectTimeoutMs = 2000
    mc.cfg.lockDir = dir
    return mc
  }
  const AUTH = { mode: 'offline', name: 'wc_check_bot' }

  // ① 已连着（不带 force）：空操作，不许再 createBot / quit
  {
    const seq = []
    const mc = mkConnMc(seq)
    const old = mkFakeBot(seq, 'old')
    old.emit('spawn')
    mc.bot = old
    mc.sub = ''
    mc._lastHost = '127.0.0.1'
    /* 🔴 2026-10-15 审计：空操作判据现在还会比 port / version / 账户（以前只比 host+sub，
     * 于是"同一个 host 换个账户再 mc_connect"会静默什么都不做、还谎报新账户）。
     * 手工摆状态时要把"上次成功连接的参数"一起摆好，否则这段状态不真实。 */
    mc._connectOpts = { host: '127.0.0.1', port: 25565, subserver: '', version: false, auth: AUTH }
    let created = 0
    const origCreate = mineflayer.createBot
    mineflayer.createBot = () => { created++; return mkFakeBot(seq, 'new') }
    try {
      const got = await mc.connect({ host: '127.0.0.1', port: 25565, auth: AUTH })
      ok(got === old && created === 0 && seq.length === 0, '已连着时 connect 是空操作（不重连、不 quit）',
        `created=${created} seq=${seq.join(',')}`)
    } finally { mineflayer.createBot = origCreate }
  }

  // ② force:true：必须先 quit 旧连接，再 createBot 一个新的
  {
    const seq = []
    const mc = mkConnMc(seq)
    const old = mkFakeBot(seq, 'old')
    old.emit('spawn')
    mc.bot = old
    mc.sub = ''
    mc._lastHost = '127.0.0.1'
    let created = 0
    const origCreate = mineflayer.createBot
    mineflayer.createBot = () => { created++; seq.push('createBot'); return mkFakeBot(seq, 'new') }
    try {
      const got = await mc.connect({ host: '127.0.0.1', port: 25565, auth: AUTH, force: true })
      ok(created === 1, 'force:true 真的重新建了连接（不是空操作）', `created=${created}`)
      ok(seq[0] === 'quit:old' && seq.indexOf('createBot') > 0, '顺序对：先断开旧连接、再连新的', seq.join(' → '))
      ok(got !== old && mc.bot === got, '换成新 bot（世界/实体重新收一遍）', `same=${got === old}`)
      ok(mc.autoReconnect === true, '连上之后自动重连恢复开启')
    } finally { mineflayer.createBot = origCreate }
  }
}

/* ─────────── ⑥ pvp.attack() 立刻 resolve ⇒ 必须自己等，别报"attacked"却一下没打 ─────────── */
section('⑥ 真打得到 —— 等目标死 / 等预算用完（旧写法 await 完就 stop ⇒ 一下都没打）')
{
  /** 装一个"像真 pvp 一样立刻 resolve"的假 pvp：可选过一会儿把目标删掉（= 打死）、可选 stop() 挂住 */
  const arm = (f, { wasInRange = true, killAfter = null, stopHangs = false, onAttack = null, noDamage = false } = {}) => {
    f.bot.pvp = {
      wasInRange,
      attack: (t) => {
        f.calls.attack.push(t)
        /* 🔴 2026-10-15 审计：`killed` 现在要求"消失前**读到过**它掉血" —— 以前只看实体没了，
         *    于是怪走出服务端追踪距离 / 区块卸载也会被报成"我打死了它"（还会顺带报掉落物）。
         *    所以这里要模拟真实过程：先掉一次血（轮询每 120ms 采一次，必须留够时间被采到），
         *    再让实体消失（= 真被打死）。 */
        if (killAfter != null) {
          const dropAt = Math.max(0, killAfter - 200)
          if (!noDamage) setTimeout(() => { if (f.bot.entities[t.id]) f.bot.entities[t.id].health = 8 }, dropAt)
          setTimeout(() => { delete f.bot.entities[t.id] }, killAfter)
        }
        if (onAttack) onAttack(t)
        return Promise.resolve()          // 真 PVP.js:60-76 就是这样：设完 goal 立刻 resolve
      },
      stop: () => { f.calls.stop++; return stopHangs ? new Promise(() => {}) : Promise.resolve() },
    }
    return f
  }
  /* `health` 是 2026-10-15 加的：`killed` 现在要求"消失前**读到过**掉血"，
   * 所以假实体必须有血量，否则 `entityHealth()` 回 null、永远判不出打死。 */
  const zombie = () => ent({ id: 'z1', name: 'zombie', type: 'hostile', kind: 'Hostile mobs', pos: { x: 0, y: 64, z: 2 }, health: 20 })

  {   // 打死 ⇒ killed:true、没有 note、不等满预算
    const f = arm(mkFightBot([zombie()], { withPvp: false }), { killAfter: 300 })
    const mc = mkMc(f); mc.mcPlugins = { pvp: true }
    const t0 = Date.now()
    const r = await mc.attack({ who: 'zombie', budget: 4_000 })
    const ms = Date.now() - t0
    ok(r.killed === true && r.via === 'pvp', '目标从 entities 里没了 ⇒ killed:true', JSON.stringify(r))
    ok(!r.note, '打死了就不该再说"还没打死"', JSON.stringify(r))
    ok(ms < 2_500, '目标一没就立刻返回（不等满预算）', `${ms}ms`)
    ok(f.calls.stop >= 1, '结束时确实停了 pvp（不然会一直追着打）')
    ok(r.waitedMs >= 60, 'waitedMs 是真实等待时间', `waitedMs=${r.waitedMs}`)
    ok(!r.pickup, '附近没有掉落物就不该多嘴', JSON.stringify(r.pickup))
  }
  {   /* 🔴 2026-10-15 审计：实体**没掉血就消失**（怪走出服务端实体追踪距离 / 区块卸载）
       * 不能说成"我打死了它" —— 旧代码是 `killed: gone`，于是这种情况会谎报 killed:true，
       * 还会顺手报一份根本不存在的掉落物提示。这里必须如实说"说不清"。 */
    const f = arm(mkFightBot([zombie()], { withPvp: false }), { killAfter: 300, noDamage: true })
    const mc = mkMc(f); mc.mcPlugins = { pvp: true }
    const r = await mc.attack({ who: 'zombie', budget: 4_000 })
    ok(r.killed === false && r.gone === true, '没读到掉血就消失 ⇒ killed:false、gone:true（别当成打死了）', JSON.stringify(r))
    ok(/没读到过它掉血/.test(String(r.note)), '如实说"说不清是我打死的还是它走远/区块卸载了"', String(r.note))
    ok(!r.pickup, '没打死就不该报"地上有掉落物去捡"', JSON.stringify(r.pickup))
  }
  {   /* 打死 + 东西掉在附近 ⇒ 必须点一句"走过去捡"。
       * 用户 2026-10-08 原话："挖完方块或者打完动物以后老是忘记走过去拾取" ——
       * 捡东西是决策，插件替不了，但结果里得让它知道这活还没完。 */
    const drop = ent({ id: 'd1', name: 'item', displayName: 'Item', type: 'other', pos: { x: 0.5, y: 64, z: 2.5 } })
    const cow = ent({ id: 'c1', name: 'cow', displayName: 'Cow', type: 'mob', pos: { x: 1, y: 64, z: 2 } })
    const f = arm(mkFightBot([zombie(), drop, cow], { withPvp: false }), { killAfter: 300 })
    const mc = mkMc(f); mc.mcPlugins = { pvp: true }
    const r = await mc.attack({ who: 'zombie', budget: 4_000 })
    ok(r.killed === true && !r.note, '打死仍然 killed:true，note 里不写"还没打死"', JSON.stringify(r))
    ok(/地上还有 1 个掉落物没捡/.test(String(r.pickup)),
      '东西掉在附近 ⇒ 点一句"地上还有 N 个没捡"（牛不算掉落物）', String(r.pickup))
    ok(/mc_move/.test(String(r.pickup)) && /几分钟就消失/.test(String(r.pickup)),
      '提示要写清"走过去站上去"和"东西会消失"', String(r.pickup))
  }
  {   // 没打死 + 进了攻击距离 ⇒ 如实报"还没打死，再叫一次"
    const f = arm(mkFightBot([zombie()], { withPvp: false }), { wasInRange: true })
    const mc = mkMc(f); mc.mcPlugins = { pvp: true }
    const r = await mc.attack({ who: 'zombie', budget: 400 })
    ok(r.killed === false && r.via === 'pvp', '还在 ⇒ killed:false', JSON.stringify(r))
    ok(/还没打死/.test(String(r.note)) && /再叫一次 mc_act\{attack\}/.test(String(r.note)),
      '在攻击距离内 ⇒ 报"打了 N 秒还没打死，再叫一次接着打"', String(r.note))
    ok(r.waitedMs >= 350, '确实等到了预算用完', `waitedMs=${r.waitedMs}`)
  }
  {   // 没打死 + 一直没进攻击距离 ⇒ 报"追不上"，别让它以为在挨打
    const f = arm(mkFightBot([zombie()], { withPvp: false }), { wasInRange: false })
    const mc = mkMc(f); mc.mcPlugins = { pvp: true }
    const r = await mc.attack({ who: 'zombie', budget: 400 })
    ok(/还没进到攻击距离/.test(String(r.note)) && /mc_move/.test(String(r.note)),
      '一直没进距离 ⇒ 报"追不上"（走不过去 / 被挡住 / 目标太快）', String(r.note))
  }
  {   // stop() 挂住也不能拖住这一轮（旧写法 await stop 最多等 5 秒）
    const f = arm(mkFightBot([zombie()], { withPvp: false }), { stopHangs: true })
    const mc = mkMc(f); mc.mcPlugins = { pvp: true }
    const t0 = Date.now()
    const r = await mc.attack({ who: 'zombie', budget: 400 })
    const ms = Date.now() - t0
    ok(Boolean(r.attacked) && ms < 1_600, 'pvp.stop() 挂住也照样按时返回（绝不 await stop）', `${ms}ms`)
  }
  {   // 打掉多少血要如实报；读不到就不报
    const f = arm(mkFightBot([zombie()], { withPvp: false }), { onAttack: () => { hp = 4 } })
    let hp = 10
    f.bot.util = { entity: { getHealth: () => hp } }
    const mc = mkMc(f); mc.mcPlugins = { pvp: true }
    const r = await mc.attack({ who: 'zombie', budget: 400 })
    ok(r.targetHealth === '10 → 4', '血量有变就如实报 targetHealth', String(r.targetHealth))
  }
  {
    const f = arm(mkFightBot([zombie()], { withPvp: false }), {})
    const mc = mkMc(f); mc.mcPlugins = { pvp: true }
    const r = await mc.attack({ who: 'zombie', budget: 400 })
    ok(!('targetHealth' in r), '读不到血量就不报（不许编）', JSON.stringify(r))
  }
  {   // 没有 pvp 插件：按预算多挥几下（上游原版是单挥，这里不能只挥一次就回"打了"）
    const f = mkFightBot([zombie()], { withPvp: false })
    f.bot.attack = (t) => { f.calls.attack.push(t); return Promise.resolve() }
    const mc = mkMc(f)
    const r = await mc.attack({ who: 'zombie', budget: 1_300 })
    ok(r.swings >= 2 && r.via === undefined, '没有 pvp 时按预算多挥几下', `swings=${r.swings}`)
  }
}

/* ─────────── ⑤ 静态接线（防以后改回去）─────────── */
section('⑤ 静态接线')
{
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const core = readFileSync(new URL('../src/core.mjs', import.meta.url), 'utf8')
  const coreNo = strip(core)
  const idx = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const idxNo = strip(idx)
  const has = (s, t, label) => ok(s.includes(t), label, t)

  has(coreNo, "from './entity-names.mjs'", 'core：实体名字与分类从 entity-names.mjs 导入（路线图第 ④ 条第四刀）')
  // 🔴 2026-10-08 第四刀：这四个定义已搬到 src/entity-names.mjs ⇒ 断言要跟着搬
  //    （搬家才会暴露的坑：断言按"这个文件里有没有这段文字"来判，代码一换文件就红，红的样子和"功能坏了"一样）
  const namesNo = strip(readFileSync(new URL('../src/entity-names.mjs', import.meta.url), 'utf8'))
  has(namesNo, 'const JUNK_RE =', 'entity-names：掉落物名单 JUNK_RE')
  has(namesNo, 'const NAME_ALIAS =', 'entity-names：中文别名表 NAME_ALIAS')
  has(namesNo, 'const entityNameOf = (e) => String(e?.username ?? e?.name', 'entity-names：玩家优先 username')
  has(namesNo, 'const nameFieldsOf = (e) =>', 'entity-names：所有名字字段一起匹配')
  /* 🔴 2026-10-08 第二十一刀：整个 `attack()` 搬进 `src/attack.mjs` ⇒ 下面这些"按文本找实现"的
   *    断言全部改成读新模块，并补一条"core 的薄包装 + 确实 import 了"的接线断言。 */
  const atkNo = strip(readFileSync(new URL('../src/attack.mjs', import.meta.url), 'utf8'))
  /* 🔴 2026-10-15 审计：`dig()` / `connect()` 早就搬到 `src/mining.mjs`、`src/dig-guard.mjs`、
   *    `src/connection.mjs` 了，但下面这些断言还在 `core.mjs` 里找原文 ⇒ 一直红着。
   *    修法同第十刀：断言指向真正实现它的文件。 */
  const minNo = strip(readFileSync(new URL('../src/mining.mjs', import.meta.url), 'utf8'))
  const dgNo = strip(readFileSync(new URL('../src/dig-guard.mjs', import.meta.url), 'utf8'))
  const connNo = strip(readFileSync(new URL('../src/connection.mjs', import.meta.url), 'utf8'))
  const auNo = strip(readFileSync(new URL('../src/async-util.mjs', import.meta.url), 'utf8'))
  has(atkNo, '24 格内实际有：', 'attack.mjs：找不到时列出半径内实际有谁')
  has(atkNo, 'const inReach = needle ? all : all.filter((x) => rankOf(x) === 0 || (x.d <= 4.5 && rankOf(x) === 3))',
    'attack.mjs：不给 who 时只追敌对（动物限 4.5 格，中立怪必须点名）')
  /* 🔴 2026-10-16（用户 m11195 采纳的 ①）：`mc_act{mode:"attack"}` 打完目标后**顺带报附近还有谁** ——
   *    以前只报"打死了 / 打了多少血"，AI 得再单独调一次 `mc_entities` 才知道旁边还站着两只。
   *    数据本来就在手（`all` 已列了 24 格内全部实体），零额外遍历；没怪时返回 `{}`（常态零结果 token）。 */
  has(atkNo, 'const foesNear = (exclude) =>', 'attack.mjs：附近还有谁的辅助函数')
  has(atkNo, 'const NEARBY_R = 16', 'attack.mjs：附近半径是具名常量（不是散落的魔法数）')
  has(atkNo, 'nearbyNote: `⚠️ 附近还有 ${foes.length} 只怪：`', 'attack.mjs：附近有怪时给一行人话（不只是 JSON）')
  /* 🔴 2026-10-17（战斗策略层）：`attack()` 从"两条 return 路径"变成了"唯一一个对外出口" ——
   *    pvp 与非 pvp 的执行搬进了 `engagePvp()` / `engageSwing()` 两个**内部**函数，
   *    它们返回的是内部结果（带 `_sawDamage` 这类下划线字段），由策略循环统一组装。
   *    所以判据从"至少两处"改成"**有且只有一处，而且在最后一个 return 里**" ——
   *    这比原来更强：任何一条新的早返回都会当场露馅（那意味着有条路绕过了 foesNear 和 outcome）。 */
  const foesNearHits = [...atkNo.matchAll(/\.\.\.foesNear\(/g)].length
  ok(foesNearHits === 1, '🔴 foesNear 只挂在唯一那个对外出口上（不再有两条 return 路径）', String(foesNearHits))
  {
    const lastRet = atkNo.lastIndexOf('return {')
    ok(lastRet > 0 && atkNo.slice(lastRet).includes('...foesNear(target)'),
      '🔴 最后一个 return（唯一的对外出口）带上 foesNear —— 没有别的路绕过它', `idx=${lastRet}`)
  }
  has(minNo, 'Math.max(2500, Math.floor(left * 0.6))', 'mining：dig 单个目标预算封顶')
  /* 🔴 2026-10-08：`dig()` 不再把方块交给 collectBlock（"挖完又复原 + 之后几分钟走不了路"的根因），
   *    那条路上的"临时压低 thinkTimeout 再还原"也就跟着删了。这里改成钉死"不碰插件配置"。 */
  ok(!/pf\.thinkTimeout = Math\.max\(/.test(coreNo), 'core：dig 不再改插件的 thinkTimeout（那条路已删）')
  /* 🔴 2026-10-08 第十刀：`#reachOf` / `#entityHealth` 搬进 `src/world-observer.mjs`
   *    （改名 `blockReachOf` / `entityHealth`）⇒ 判据要跟着指向新文件，并确认 core 真的导入了。 */
  const woNo = strip(readFileSync(new URL('../src/world-observer.mjs', import.meta.url), 'utf8'))
  has(minNo, 'if (blockReachOf(b, fresh) > reachMax) {', 'mining：够不着先自己走过去（不再交给 collectBlock）')
  has(coreNo, "from './world-observer.mjs'", 'core：观察层从 world-observer.mjs 导入（第十刀）')
  has(dgNo, 'b.collectBlock?.targets?.clear?.()', 'dig-guard：采集任务卡死时清空僵尸队列兜底')
  has(minNo, 'const pinned = pos ? targets[0] : null', 'mining：dig 目标按距离升序（显式 pos 仍第一）')
  has(connNo, 'if (force && self.bot) {', 'connection：connect 的 force 分支')
  has(connNo, 'if (!force && sameAsLive) return self.bot',
    'connection：不带 force 且已连着 = 空操作（还要比 port/version/账户）')
  has(connNo, 'await sleep(600)', 'connection：force 重连前等一下（服务端放掉旧会话）')
  /* 🔴 2026-10-15：挖方块报"复原"的文案以前主动教模型 `mc_connect {force:true}` 刷区块 ——
   *    那是**真的退出游戏再进服**，服务器会向全服广播"你离开了游戏"，玩家会看到它消失几秒
   *    （实机取证：10-13 / 10-14 / 10-15 共 15 次强制重连，玩家两次在公屏问"怎么退游戏了"）。
   *    现在改成先怀疑"是不是我自己垫脚/搭高放上去的方块"，并明确劝退 force 重连。
   *    这里钉"不再推荐"这件事，而不是钉某一句原文。 */
  ok(!/重连刷新区块/.test(minNo), 'mining：不再教模型"用 mc_connect {force:true} 重连刷新区块"')
  has(auNo, '垫脚', 'async-util：DESYNC_HINT 让模型先怀疑"那格是不是我自己垫脚/搭高放上去的"')
  has(minNo, 'DESYNC_HINT', 'mining：失步文案统一走 DESYNC_HINT（劝退 force 重连）')
  has(idxNo, 'if (args.force)     opts.force     = true', 'index：mc_connect 把 force 传下去')
  has(idxNo, 'force:     { type:', 'index：mc_connect 暴露 force 参数')
  has(idxNo, '中英文都认', 'index：mc_act 描述写明 attack 认中英文名')
  has(atkNo, 'await b.pvp.attack(target)', 'attack.mjs：pvp 还是用 attack(target) 设目标（会自己追过去）')
  has(atkNo, 'if (!b.entities?.[target.id] || target.isValid === false) break',
    'attack.mjs：自己等目标消失（pvp.attack 立刻 resolve，不能 await 完就 stop）')
  has(atkNo, 'Promise.resolve(b.pvp.stop()).catch(() => {})',
    'attack.mjs：pvp.stop() 不 await（它最多等 5 秒 path_stop，会把预算吃光）')
  has(woNo, 'export function entityHealth (b, e)', 'world-observer：血量助手 entityHealth（第十刀搬过去的）')
  has(atkNo, 'const hpBefore = entityHealth(b, target)', 'attack.mjs：动手前先记目标血量')
  /* 🔴 2026-10-17 实机：`entityHealth()` 在真服上**永远回 null** ⇒ "打死必须有掉血证据"永远不成立
   *    （拳头打死僵尸，报的却是 combat:"unknown" + "没读到过它掉血"，掉落提示也从不出现）。
   *    根因：`@nxg-org/mineflayer-util-plugin` 的 `getHealth()` 算
   *    `metadata[9] + Number(metadata[13]) ?? 0`，第 13 格是 undefined ⇒ `Number(undefined)` 是 NaN
   *    ⇒ `NaN ?? 0` **还是 NaN**（`??` 只兜 null/undefined）⇒ 整条返回值是 NaN。
   *    下面这些形状全是实机探针（`实机验证/战斗/probe-health.mjs`）打出来的真数据。 */
  {
    const { entityHealth } = await import(new URL('../src/world-observer.mjs', import.meta.url))
    const B19 = { version: '1.21.9' }
    ok(entityHealth(B19, { metadata: [null, null, null, null, null, null, null, null, null, 20] }) === 20,
      '🔴 血量：1.21.9 真形状（第 9 格 = 20）读得出来', String(entityHealth(B19, { metadata: [null, null, null, null, null, null, null, null, null, 20] })))
    ok(entityHealth({ version: '1.21.9', util: { entity: { getHealth: () => NaN } } }, { metadata: [null, null, null, null, null, null, null, null, null, 14.5] }) === 14.5,
      '🔴 血量：现成助手回 NaN 也不影响（就是它把实机搞瞎的）')
    ok(entityHealth({ version: '1.16.5' }, { metadata: [null, null, null, null, null, null, null, 18] }) === 18,
      '血量：1.16 及以前走第 7 格')
    ok(entityHealth(B19, { metadata: [null, null, null, null, null, null, null, null, null, 12, null, null, null, 4] }) === 16,
      '血量：吸收血量要加上去（第 13 格），且**单独判有限性**（别再犯 `??` 那个错）')
    ok(entityHealth(B19, { metadata: [null, null, null, null, null, null, null, null, null, 0] }) === null,
      '血量：0（已经死了）⇒ null，不许回 0 冒充"活着但没血"')
    ok(entityHealth(B19, {}) === null && entityHealth(B19, null) === null,
      '血量：读不到 / 没实体 ⇒ null（读不到不要编）')
    ok(entityHealth(B19, { health: 7 }) === 7, '血量：兜底还认老版本实体上的 e.health')
  }
  has(atkNo, 'b.pvp?.wasInRange', 'attack.mjs：用 wasInRange 区分"没打死"和"没追上"')
  /* 🔴 2026-10-15 审计：`killed: gone` 把"怪走出服务端实体追踪距离 / 区块卸载"当成"我打死了它"
   *    （还会顺带报一份不存在的掉落物提示）。现在只有**消失前读到过掉血**才算打死。 */
  has(atkNo, 'const killed = gone && sawDamage', 'attack.mjs：只有消失前读到过掉血才算打死（旧写法是 killed: gone）')
  has(atkNo, 'const gone = !b.entities?.[target.id]', 'attack.mjs：单独如实报 gone（不见了 ≠ 我打死的）')
  has(atkNo, '还没进到攻击距离', 'attack.mjs：追不上时的文案')
  ok(!/await b\.pvp\.stop\(\)/.test(atkNo), 'attack.mjs：不许 await b.pvp.stop()')
  ok(!/withTimeout\(b\.pvp\.attack/.test(atkNo) && !/raceAbort\(\s*withTimeout\(b\.pvp\.attack/.test(atkNo),
    'attack.mjs：不再把 pvp.attack 当同步动作 await（旧写法的病根）')
  ok(!/附近找不到 "?\$\{who\}?"?\)/.test(atkNo), 'attack.mjs：不再只有干巴巴一句"附近找不到"')
  /* 🔴 2026-10-17：盾牌判定漏了副手（45 格）与盔甲槽（5..8 格）—— `inventory.items()` 只回 9..44。 */
  has(atkNo, "import { durabilityOf, EQUIP_SLOTS } from './inventory.mjs'", 'attack.mjs：槽位表复用 inventory.mjs 的 EQUIP_SLOTS（不手写槽号）')
  has(atkNo, 'equipped.some((n) => isShield(n))', 'attack.mjs：hasShield 把**身上穿/副手拿**的也算进去')
  has(atkNo, 'const slots = b.inventory?.slots', 'attack.mjs：从 inventory.slots 按绝对槽号读装备栏')
  ok(!/hasShield: items\.some\(\(n\) => isShield\(n\)\) \|\| isShield\(held\),/.test(atkNo),
    'attack.mjs：旧写法（只看背包 + 手上）已消失')
  /* 接线：第二十一刀把整个 attack() 搬走 ⇒ core 里只剩薄包装，且必须真的 import 了 */
  has(coreNo, "import { attack } from './attack.mjs'", 'core：确实 import 了 attack')
  ok(/async attack \(opts = \{\}\) \{[\s\S]{0,420}return await attack\(this\.requireBot\(\), opts, \{/.test(coreNo),
    'core：attack 是薄包装（把 bot + t/callLeft/abortSignal/hasPvp 传进去）')
  ok(!/b\.pvp\.attack\(/.test(coreNo) && !/inReach = needle/.test(coreNo),
    'core：没有残留的选目标 / pvp.attack 实现')
}

/* ─────────── ⑦ 战斗策略层（纯函数，不碰 bot） ───────────
 * 用户 2026-10-17 的战斗方案要求"对纯策略使用模拟测试，对真实寻路与命中使用实机验证"。
 * 这一节就是"纯策略"那半 —— 全是纯函数，不需要真 bot、不需要真服务器。 */
section('⑦ 战斗策略层 —— 威胁排序 / 换武器 / 状态机 / 结局（纯函数，不碰 bot）')
{
  const S = await import(new URL('../src/combat-strategy.mjs', import.meta.url))
  const {
    threatOf, rankTargets, weaponScoreOf, weaponChoiceOf, isShield, hurtRateOf,
    assessCombat, chooseStrategy, combatOutcomeOf, retreatPointOf, approachPointOf,
  } = S

  /* 威胁分：不是"是不是敌对"一个判据 */
  ok(threatOf({ hostile: true, distance: 3 }) > threatOf({ hostile: true, distance: 18 }),
    '威胁分：同是敌对，近的比远的急', `${threatOf({ hostile: true, distance: 3 })} vs ${threatOf({ hostile: true, distance: 18 })}`)
  ok(threatOf({ hostile: true, distance: 8, attackingMe: true }) > threatOf({ hostile: true, distance: 8 }),
    '威胁分：正在打我的排前面', `${threatOf({ hostile: true, distance: 8, attackingMe: true })} vs ${threatOf({ hostile: true, distance: 8 })}`)
  ok(threatOf({ hostile: true, distance: 8, ranged: true }) > threatOf({ hostile: true, distance: 8 }),
    '威胁分：远程比近战急（它够得着我，我未必够得着它）')
  ok(threatOf({ hostile: true, distance: 8, canReach: false }) < threatOf({ hostile: true, distance: 8 }),
    '威胁分：够不着的先别管（降权）')
  ok(threatOf({ hostile: true, distance: 8, dangerousTerrain: true }) < threatOf({ hostile: true, distance: 8 }),
    '威胁分：打它要把自己送进岩浆/悬崖 ⇒ 降权')

  /* 目标排序：敌对 > 玩家 > 动物 —— 这条**必须**保住（不能因为新增威胁评分就去自动打无关玩家） */
  {
    const animal = { name: 'cow', hostile: false, player: false, distance: 1 }
    const player = { name: 'Bluezi', hostile: false, player: true, distance: 6 }
    const mob = { name: 'zombie', hostile: true, distance: 12 }
    const r = rankTargets([animal, player, mob])
    ok(r[0] === mob, '排序：敌对优先于玩家和动物（哪怕它最远）', r.map((x) => x.name).join(','))
    ok(r[1] === player && r[2] === animal, '排序：玩家优先于动物（别因为近就去揍牛）', r.map((x) => x.name).join(','))
  }
  {
    const far = { name: 'zombie', hostile: true, distance: 14 }
    const near = { name: 'skeleton', hostile: true, distance: 5, attackingMe: true }
    ok(rankTargets([far, near])[0] === near, '排序：同为敌对时按威胁分（正在打我的近怪优先）')
  }

  /* 武器分级与选择 */
  ok(weaponScoreOf('diamond_sword') > weaponScoreOf('iron_sword') && weaponScoreOf('iron_sword') > weaponScoreOf('wooden_sword'),
    '武器分级：钻石剑 > 铁剑 > 木剑', `${weaponScoreOf('diamond_sword')}/${weaponScoreOf('iron_sword')}/${weaponScoreOf('wooden_sword')}`)
  ok(weaponScoreOf('iron_axe') > weaponScoreOf('iron_pickaxe') && weaponScoreOf('iron_pickaxe') > 0,
    '武器分级：斧 > 镐 > 空手')
  ok(weaponScoreOf(null) === 0 && weaponScoreOf('cobblestone') === 0, '武器分级：空手和建材都是 0')
  ok(weaponScoreOf('modded_sword') > 0, '武器分级：认不出材质但认得出是剑 ⇒ 给中间分（不当空手）')
  ok(weaponChoiceOf({ held: null, items: ['diamond_sword'] })?.name === 'diamond_sword',
    '换武器：空手 + 背包有剑 ⇒ 建议换上')
  ok(weaponChoiceOf({ held: 'diamond_sword', items: ['wooden_sword'] }) === null,
    '换武器：手里的已经更好 ⇒ 不换（别把好剑换成木剑）')
  ok(weaponChoiceOf({ held: null, items: ['diamond_sword'], inDanger: true }) === null,
    '🔴 换武器：危险中不换（换装那几百毫秒里手是无防备的）')
  ok(isShield('shield') && isShield('white_shield') && !isShield('iron_sword'),
    '盾牌判定：shield / 各种材质的盾都认，剑不是盾')

  /* 武器耐久：用户方案"武器耐久很低 ⇒ 在安全条件下更换备用武器；无备用武器时评估是否继续战斗" */
  {
    const worn = weaponChoiceOf({ held: 'diamond_sword', items: ['stone_sword'], heldPct: 0.05 })
    ok(worn?.name === 'stone_sword',
      '🔴 耐久换武器：钻石剑只剩 5% ⇒ 换上评分**更低**的石剑（能用的烂剑胜过要断的好剑）', JSON.stringify(worn))
    const healthy = weaponChoiceOf({ held: 'diamond_sword', items: ['stone_sword'], heldPct: 0.6 })
    ok(healthy === null, '耐久够就别降级（60% 的钻石剑不该换成石剑）', JSON.stringify(healthy))
    const noSpare = weaponChoiceOf({ held: 'diamond_sword', items: [], heldPct: 0.05 })
    ok(noSpare?.name === null && /没有备用/.test(String(noSpare?.warn)),
      '🔴 快坏了又没备用 ⇒ 不换，但**必须说出来**（"评估是否继续战斗"是 AI 的活）', JSON.stringify(noSpare))
    const allWorn = weaponChoiceOf({ held: 'diamond_sword', items: ['stone_sword'], heldPct: 0.05, pctOf: () => 0.1 })
    ok(allWorn?.name === null && /没有备用/.test(String(allWorn?.warn)),
      '备用的也快坏了 ⇒ 不算备用（换上一把快断的没意义）', JSON.stringify(allWorn))
    const danger = weaponChoiceOf({ held: 'diamond_sword', items: ['stone_sword'], heldPct: 0.05, inDanger: true })
    ok(danger?.name === null && /不安全/.test(String(danger?.warn)),
      '🔴 危险中不换装，但也要说清"现在不安全，先不换"', JSON.stringify(danger))
    const snap = assessCombat({ health: 20, now: 1000, target: { name: 'zombie', distance: 3, hostile: true }, held: 'diamond_sword', items: [], heldPct: 0.05 })
    ok(snap.weaponWarn != null && snap.notes.some((n) => /没有备用/.test(n)),
      '🔴 战况快照里带 weaponWarn（不然 AI 只看到"在打"，不知道武器要断了）', JSON.stringify({ w: snap.weaponWarn, n: snap.notes }))
  }

  /* 掉血速度 */
  {
    const now = 100_000
    ok(hurtRateOf([{ at: now - 4_000, health: 20 }, { at: now, health: 12 }], now) === 2,
      '掉血速度：4 秒掉 8 血 ⇒ 2 点/秒', String(hurtRateOf([{ at: now - 4_000, health: 20 }, { at: now, health: 12 }], now)))
    ok(hurtRateOf([{ at: now - 30_000, health: 20 }, { at: now, health: 12 }], now) === 0,
      '掉血速度：窗口外的老样本不算（不然一分钟前挨的那下会一直吓唬人）')
    ok(hurtRateOf([{ at: now, health: 12 }], now) === 0, '掉血速度：只有一个样本 ⇒ 0（算不出斜率就不编）')
    ok(hurtRateOf([{ at: now - 2_000, health: 12 }, { at: now, health: 20 }], now) === 0,
      '掉血速度：回血不算掉血')
  }

  /* 战况快照 */
  {
    const low = assessCombat({ health: 4, now: 1000 })
    ok(low.mustRetreat === true, '战况：血 4 ⇒ mustRetreat（必须撤）')
    const mid = assessCombat({ health: 10, now: 1000 })
    ok(mid.mustRetreat === false && mid.shouldStopAdvancing === true, '战况：血 10 ⇒ 停止冒进但还能打')
    const okHp = assessCombat({ health: 20, now: 1000 })
    ok(okHp.mustRetreat === false && okHp.shouldStopAdvancing === false, '战况：血 20 ⇒ 正常打')
  }
  {
    /* 🔴 第一版没加"够得着"门槛，结果 10 格外一只骷髅就让"打僵尸"变成"见骷髅就跑" */
    const lone = assessCombat({
      health: 20, now: 1000,
      foes: [{ name: 'skeleton', ranged: true, distance: 10, hostile: true }],
    })
    ok(lone.rangedThreat === false, '🔴 战况：10 格外**孤零零一只**骷髅不算威胁（别见骷髅就跑）')
    const pair = assessCombat({
      health: 20, now: 1000,
      foes: [{ name: 'skeleton', ranged: true, distance: 8, hostile: true },
        { name: 'skeleton', ranged: true, distance: 9, hostile: true }],
    })
    ok(pair.rangedThreat === true, '战况：两个远程 ⇒ 算威胁')
    const shooting = assessCombat({
      health: 20, now: 1000,
      foes: [{ name: 'skeleton', ranged: true, distance: 8, hostile: true, attackingMe: true }],
    })
    ok(shooting.rangedThreat === true, '战况：一个远程但正在打我 ⇒ 算威胁')
  }
  {
    const c = assessCombat({ health: 20, now: 1000, foes: [{ name: 'zombie', distance: 3, hostile: true }, { name: 'zombie', distance: 4, hostile: true }, { name: 'zombie', distance: 5, hostile: true }] })
    ok(c.surrounded === true && c.crowd === 3, '战况：三只 ⇒ surrounded', `crowd=${c.crowd}`)
  }

  /* 状态机 */
  const base = { health: 20, now: 1000, target: { name: 'zombie', distance: 3, hostile: true }, sawDamage: true, targetGone: false, targetReachable: true, hasPvp: true }
  {
    const st = chooseStrategy(assessCombat({ ...base, targetGone: true, sawDamage: true }))
    ok(st.action === 'complete' && st.reason === 'gone-after-damage',
      '🔴 状态机：目标消失 + 读到过掉血 ⇒ 收工，但**只说"不见了"、不说"打死了"**（打死由 killed 一处判）', JSON.stringify(st))
    const st2 = chooseStrategy(assessCombat({ ...base, targetGone: true, sawDamage: false }))
    ok(st2.action === 'complete' && st2.reason === 'gone-no-damage', '🔴 状态机：目标消失但没读到掉血 ⇒ 收工/说不清（不许误报击杀）', JSON.stringify(st2))
    /* 🔴 实机 2026-10-17：结果里同时出现 `reason:"killed"` 和 `killed:false`、`gone:false`
     *    —— 策略层拿 `sawDamage` 当"打死了"，而 `killed` 是 `gone && sawDamage`。同一个问题两处判据。
     *    这里的**不变量**：`reason` 永远不许出现 `killed`（那是 `killed`/`combat` 两个字段的活）。 */
    const all = [st, st2]
    ok(all.every((x) => x.reason !== 'killed'), '🔴 不变量：策略层的 reason 永远不许说 "killed"（打死只由 killed 一处判）',
      JSON.stringify(all.map((x) => x.reason)))
  }
  {
    const st = chooseStrategy(assessCombat({ ...base, health: 4 }))
    ok(st.action === 'retreat' && st.reason === 'low-health', '状态机：血 4 ⇒ retreat（排在进攻前面）', JSON.stringify(st))
    const st2 = chooseStrategy(assessCombat({ ...base, hurt: [{ at: 0, health: 20 }, { at: 1000, health: 14 }] }))
    ok(st2.action === 'retreat' && st2.reason === 'low-health', '状态机：每秒掉 6 点 ⇒ retreat（比"血量低"更早发现正在挨打）', JSON.stringify(st2))
  }
  {
    /* 🔴 实机逮到的 bug：一个空手 bot 挨一只简单僵尸大约 2 点/秒。
     *    阈值设成 1.5 时，`mc_act{attack}` 对**每一只落单的僵尸**都掉头就跑
     *    （实机第一轮 `actions: ["retreat"]`，一下都没打）——"掉血"不是撤退理由，
     *    "掉得快到来不及脱身"才是。 */
    const lone = assessCombat({ ...base, hurt: [{ at: 0, health: 20 }, { at: 1000, health: 18 }] })
    ok(lone.hurtDps === 2, '掉血速度算得对（20→18，1 秒 ⇒ 2/秒）', String(lone.hurtDps))
    const st = chooseStrategy(lone)
    ok(st.action === 'engage', '🔴 落单僵尸啃我 2/秒 ⇒ 照打（不许每只僵尸都掉头就跑）', JSON.stringify(st))
    const acute = assessCombat({ ...base, hurt: [{ at: 0, health: 20 }, { at: 1000, health: 16 }] })
    ok(chooseStrategy(acute).action === 'retreat', '🔴 4/秒 ⇒ retreat（20 血撑不过 5 秒，来不及脱身）', JSON.stringify(chooseStrategy(acute)))
    ok(S.HURT_RETREAT_DPS >= 3, '🔴 急症阈值不许被调回 1.5（那会让 attack 对落单怪也逃跑）', String(S.HURT_RETREAT_DPS))
  }
  /* 🔴 2026-10-17（用户实机，游戏里那个 AI 的原话：「骷髅打我我永远打不到它，只能挨」）：
   *    目标是**远程**时策略层原来一律走 `defend`（往反方向退 8 格再收工）。可远程怪的
   *    优势只在拉开距离时成立 —— 退的结果是一边挨箭一边把距离拉大，下一轮还得走回来。
   *    正确解法是**冲上去近战**，但保命（血快没了）依然优先。 */
  {
    const rangedTarget = { name: 'skeleton', distance: 10, hostile: true, ranged: true }
    const st = chooseStrategy(assessCombat({ ...base, target: rangedTarget }))
    ok(st.action === 'engage' && st.reason === 'close-in',
      '🔴 状态机：目标是远程（骷髅 10 格）⇒ 冲上去打，不许掉头就跑', JSON.stringify(st))
    const low = chooseStrategy(assessCombat({ ...base, health: 4, target: rangedTarget }))
    ok(low.action === 'retreat' && low.reason === 'low-health',
      '🔴 状态机：血 4 时目标是远程也要先撤（保命排在进攻前面）', JSON.stringify(low))
    const worn = chooseStrategy(assessCombat({ ...base, health: 10, target: rangedTarget }))
    ok(worn.action === 'engage', '状态机：血 10 + 目标是远程 ⇒ 仍然冲上去', JSON.stringify(worn))
    /* 反向：远程**不是**目标（它在旁边射我）时，仍然按"远程威胁"处理 */
    const side = chooseStrategy(assessCombat({
      ...base,
      foes: [{ name: 'skeleton', distance: 8, hostile: true, ranged: true, attackingMe: true }],
    }))
    ok(side.action === 'defend', '战况：旁边有远程正在射我（不是目标）⇒ 仍然先拉开距离', JSON.stringify(side))
  }
  /* 🔴 2026-10-17：被围只数**贴到 8 格内**的怪 —— `foes` 是 24 格内的全部敌对，
   *    原来 `crowd = foes.length` ⇒ 20 格外的三只怪也让战斗层一直判"被围、退"。 */
  {
    const far3 = assessCombat({
      health: 20, now: 1000, foes: [
        { name: 'zombie', distance: 20, hostile: true },
        { name: 'zombie', distance: 22, hostile: true },
        { name: 'zombie', distance: 24, hostile: true },
      ],
    })
    ok(far3.crowd === 0 && far3.crowdAll === 3 && far3.surrounded === false,
      '🔴 战况：20 格外的三只怪不算被围（crowd 只数 8 格内，crowdAll 才是总数）',
      `crowd=${far3.crowd} crowdAll=${far3.crowdAll}`)
    const near3 = assessCombat({
      health: 20, now: 1000, foes: [
        { name: 'zombie', distance: 3, hostile: true },
        { name: 'zombie', distance: 5, hostile: true },
        { name: 'zombie', distance: 7, hostile: true },
      ],
    })
    ok(near3.surrounded === true && near3.crowd === 3, '战况：8 格内三只 ⇒ 才算被围', `crowd=${near3.crowd}`)
    ok(S.CROWD_RANGE > 0 && S.CROWD_RANGE <= 12, 'CROWD_RANGE 是具名常量且在合理区间', String(S.CROWD_RANGE))
  }
  /* 🔴 2026-10-17：退了还退 —— 退够 `RETREAT_TRIES` 次还是甩不掉就改成边打边找机会 */
  {
    const surrounded = assessCombat({
      ...base,
      foes: [
        { name: 'zombie', distance: 3, hostile: true },
        { name: 'zombie', distance: 4, hostile: true },
        { name: 'zombie', distance: 5, hostile: true },
      ],
    })
    const first = chooseStrategy(surrounded, { retreats: 0 })
    ok(first.action === 'defend', '状态机：被围第一次 ⇒ defend（边挡边退 / 没盾就拉开距离）', JSON.stringify(first))
    const capped = chooseStrategy(surrounded, { retreats: S.RETREAT_TRIES })
    ok(capped.action === 'engage' && capped.reason === 'retreat-exhausted',
      '🔴 状态机：退够次数还是被围 ⇒ 不再退，改成边打边找机会（否则会一路退到没地方退）',
      JSON.stringify(capped))
    /* 🔴 2026-10-17（用户："自动战斗的优先级不应该比 AI 高"，口径选"一律不停"）：
     *    `attack.mjs` 里**不许**再有"自己撤退"的执行路径 —— 策略层的撤/退一律降级成建议。 */
    const atkSrc = readFileSync(new URL('../src/attack.mjs', import.meta.url), 'utf8')
    ok(!/retreatPointOf/.test(atkSrc) && !/战斗撤退/.test(atkSrc),
      '🔴 attack.mjs：没有任何"自己往反方向撤"的执行路径（策略层没有否决权）')
    ok(/const advisory = wanted\.action === 'retreat' \|\| wanted\.action === 'defend'/.test(atkSrc)
      && /if \(advisory\) advice\.push\(/.test(atkSrc),
      '🔴 attack.mjs：策略层的撤退/拉开距离被降级成 advice（不再执行）')
    const stratSrc = readFileSync(new URL('../src/combat-strategy.mjs', import.meta.url), 'utf8')
    ok(/if \(retreats >= RETREAT_TRIES\)/.test(stratSrc),
      '🔴 策略层：退次数上限真的被用在分支里')
  }
  {
    const st = chooseStrategy(assessCombat({
      ...base,
      foes: [{ name: 'zombie', distance: 3, hostile: true }, { name: 'zombie', distance: 4, hostile: true }, { name: 'zombie', distance: 5, hostile: true }],
    }))
    ok(st.action === 'defend' && st.reason === 'surrounded', '状态机：被围 ⇒ defend', JSON.stringify(st))
    /* 用户方案："没有盾牌或无法防御 ⇒ 不进入依赖盾牌的策略"，且要说清退化成什么 */
    ok(st.shield === false && /没有盾牌/.test(String(st.why)), '🔴 没盾时 defend 明说是"拉开距离"（不是假装举盾）', JSON.stringify(st.why))
    const withShield = chooseStrategy(assessCombat({
      ...base,
      hasShield: true,
      foes: [{ name: 'zombie', distance: 3, hostile: true }, { name: 'zombie', distance: 4, hostile: true }, { name: 'zombie', distance: 5, hostile: true }],
    }))
    ok(withShield.shield === true && /有盾/.test(String(withShield.why)), '有盾时如实说"边挡边退"', JSON.stringify(withShield.why))
  }
  {
    const st = chooseStrategy(assessCombat({ ...base, held: null, items: ['diamond_sword'] }))
    ok(st.action === 'equip' && st.name === 'diamond_sword', '状态机：有更好的武器 ⇒ equip', JSON.stringify(st))
    const st2 = chooseStrategy(assessCombat({ ...base, held: null, items: ['diamond_sword'] }), { equips: 1, lastEquipAt: 1000 })
    ok(st2.action !== 'equip', '状态机：刚换过（冷却里）⇒ 不再换（别一秒钟换十次）', JSON.stringify(st2))
  }
  {
    const st = chooseStrategy(assessCombat({ ...base, targetReachable: false }), { lastInRange: false, repositions: 0 })
    ok(st.action === 'reposition', '状态机：够不着且还没试过 ⇒ reposition（真的换个位置）', JSON.stringify(st))
    const st2 = chooseStrategy(assessCombat({ ...base, targetReachable: false }), { lastInRange: false, repositions: 2 })
    ok(st2.action === 'stop' && st2.reason === 'unreachable', '🔴 状态机：试满次数还够不着 ⇒ stop/unreachable（不无限试）', JSON.stringify(st2))
  }
  {
    const st = chooseStrategy(assessCombat(base))
    ok(st.action === 'engage' && st.state === 'engage', '状态机：其余情况 ⇒ 进攻', JSON.stringify(st))
  }

  /* 结局（机器可读，判据全是证据） */
  ok(combatOutcomeOf({ killed: true, retreated: true }) === 'killed', '结局：打死优先于其它')
  ok(combatOutcomeOf({ aborted: true, sawDamage: true }) === 'aborted', '结局：被打断优先于"打到了"')
  ok(combatOutcomeOf({ retreated: true }) === 'retreated', '结局：主动撤退')
  ok(combatOutcomeOf({ unreachable: true }) === 'unreachable', '结局：够不着')
  ok(combatOutcomeOf({ sawDamage: true }) === 'damaged', '结局：打到了但没打死')
  ok(combatOutcomeOf({ timedOut: true }) === 'timeout', '结局：这一轮时间到了')
  ok(combatOutcomeOf({ gone: true }) === 'unknown', '结局：目标不见了但没证据 ⇒ unknown（不许猜）')
  ok(combatOutcomeOf({}) === 'unknown', '结局：什么证据都没有 ⇒ unknown')
  ok(S.COMBAT_OUTCOMES.includes(combatOutcomeOf({ killed: true })) && S.COMBAT_OUTCOMES.length === 7,
    '结局：只在这七个词里取值（用户方案里点名的那七个）', S.COMBAT_OUTCOMES.join(','))

  /* 几何：撤退点 / 找位点 */
  {
    const pt = retreatPointOf({ x: 0, y: 64, z: 0 }, { x: 0, z: 5 }, 10)
    ok(pt && pt.z < 0 && Math.abs(pt.z + 10) < 0.01, '撤退点：往**背离**目标的方向走（目标在 +z ⇒ 我往 -z）', JSON.stringify(pt))
    const same = retreatPointOf({ x: 0, y: 64, z: 0 }, { x: 0, z: 0 }, 10)
    ok(same && Number.isFinite(same.x), '🔴 撤退点：和目标重合也要给个点（回 null 会让"撤退"变成原地不动）', JSON.stringify(same))
    ok(retreatPointOf({ x: NaN, y: 64, z: 0 }, { x: 0, z: 5 }) === null, '撤退点：坐标读不到 ⇒ null（不许编）')
    const ap = approachPointOf({ x: 0, y: 64, z: 0 }, { x: 0, y: 64, z: 10 }, 3)
    ok(ap && Math.abs(ap.z - 3) < 0.01, '找位点：朝目标走 step 格', JSON.stringify(ap))
    ok(approachPointOf({ x: 0, y: 64, z: 0 }, { x: 0, y: 64, z: 0 }, 3) === null, '找位点：重合 ⇒ null')
  }
}

/* ─────────── ⑧ 策略层真的接进了 attack()（端到端，真调 attack） ───────────
 * 用户方案的验收表：低血量撤退 / 多敌人 / 换武器 / 停止命令 / 不误报击杀。
 * 这里用**真的 `attack()`**（不是纯函数），但移动与装备走**假的 ctx 能力回调** ——
 * 这样既能验证"它真的去调了 moveTo/equipTo"，又不需要真寻路（真寻路留给实机）。 */
section('⑧ 战斗策略层接线 —— attack() 真的会撤 / 会换 / 会停（端到端，假能力回调）')
{
  const { attack } = await import(new URL('../src/attack.mjs', import.meta.url))
  const mkCtx = (o = {}) => {
    const calls = { move: [], equip: [] }
    const ctx = {
      t: (p) => p,
      callLeft: () => 60_000,
      abortSignal: o.abort ?? null,
      hasPvp: true,
      ...(o.noMove ? {} : { moveTo: async (pos, opts) => { calls.move.push({ pos, opts }) } }),
      ...(o.noEquip ? {} : { equipTo: async (n) => { calls.equip.push(n) } }),
    }
    return { ctx, calls }
  }
  const zombieAt = (id, z) => ent({ id, name: 'zombie', type: 'hostile', kind: 'Hostile mobs', pos: { x: 0, y: 64, z } })

  {   /* 血 4 + AI 明确叫打 ⇒ 不停手，只把"该撤"当建议带出去 */
    const f = mkFightBot([zombieAt('z1', 2)])
    f.bot.health = 4
    const { ctx, calls } = mkCtx()
    const r = await attack(f.bot, { who: 'zombie', budget: 400 }, ctx)
    ok(r.combat !== 'retreated' && r.retreated !== true, '🔴 血 4 也不许自己撤（AI 叫的打就是命令）', JSON.stringify({ combat: r.combat }))
    ok(calls.move.length === 0, '🔴 血 4 也不再往反方向走（要撤是 AI 自己叫 mc_move）', String(calls.move.length))
    ok(r.strategy === 'engage' && r.reason === 'hold-line', '🔴 结果里写明"这一轮我没改道"', JSON.stringify({ s: r.strategy, r: r.reason }))
    ok(Array.isArray(r.advice) && r.advice.some((a) => a.action === 'retreat' && a.reason === 'low-health'),
      '🔴 建议里带"该撤了"（reason=low-health），决定权交回 AI', JSON.stringify(r.advice))
    ok(/撤|血/.test(String(r.adviceText ?? '')), '建议还有一句给人看的话（AI 不用去猜 advice 结构）', String(r.adviceText ?? '').slice(0, 60))
  }
  {   /* 没给移动能力 ⇒ 本来就不撤，"撤不了"这句话也不该出现 */
    const f = mkFightBot([zombieAt('z1', 2)])
    f.bot.health = 4
    const { ctx } = mkCtx({ noMove: true })
    const r = await attack(f.bot, { who: 'zombie', budget: 400 }, ctx)
    ok(r.retreated !== true && !/没给我移动能力/.test(String(r.strategyError)), '没给移动能力也不会"假装撤"（本来就不撤了）', String(r.strategyError))
    ok(Array.isArray(r.advice) && r.advice.length > 0, '没移动能力 ⇒ 建议照样带出去', JSON.stringify(r.advice))
  }
  {   /* 被围 ⇒ 只给建议，手不停 */
    const f = mkFightBot([zombieAt('z1', 3), zombieAt('z2', 4), zombieAt('z3', 5)])
    const { ctx, calls } = mkCtx()
    const r = await attack(f.bot, { who: 'zombie', budget: 400 }, ctx)
    ok(r.strategy === 'engage' && calls.move.length === 0, '🔴 三只怪围着也不自己拉开（只建议）', JSON.stringify({ s: r.strategy, moves: calls.move.length }))
    ok(r.combat !== 'retreated', '被围不再产生 retreated 结局')
    ok(r.advice?.some((a) => a.action === 'defend' && a.reason === 'surrounded'), '建议里说"被围了，建议拉开距离"', JSON.stringify(r.advice))
  }
  {   /* 换武器：空手 + 背包有剑 */
    const f = mkFightBot([zombieAt('z1', 2)])
    f.bot.inventory = { items: () => [{ name: 'diamond_sword' }] }
    const { ctx, calls } = mkCtx()
    const r = await attack(f.bot, { who: 'zombie', budget: 400 }, ctx)
    ok(calls.equip.length === 1 && calls.equip[0] === 'diamond_sword', '🔴 空手 + 背包有剑 ⇒ 换一次（且只换一次）', JSON.stringify(calls.equip))
    ok(r.actions.includes('equip'), 'actions 里能看到换过武器', JSON.stringify(r.actions))
  }
  {   /* 停止命令：abortSignal 一置位就收手 */
    const f = mkFightBot([zombieAt('z1', 2)])
    const { ctx } = mkCtx({ abort: { aborted: true } })
    const r = await attack(f.bot, { who: 'zombie', budget: 400 }, ctx)
    ok(r.combat === 'aborted', '🔴 停止命令 ⇒ aborted（不被内部循环重新启动）', String(r.combat))
    ok(f.calls.attack.length === 0, '被中止时一下都没打')
  }
  {   /* 目标消失但没伤害证据 ⇒ 不许误报 */
    const f = mkFightBot([])
    const { ctx } = mkCtx()
    let err = null
    try { await attack(f.bot, { who: 'zombie', budget: 300 }, ctx) } catch (e) { err = e }
    ok(/附近找不到/.test(String(err?.message)), '目标本来就不在 ⇒ 如实报找不到（不是"打死了"）', String(err?.message ?? '').slice(0, 50))
    /* 🔴 2026-10-17 用户实机：苦力怕贴到 3 格却报"找不到"，只列出 `item 2.5 格`，AI 分不清
     *    "名字写错"还是"客户端根本没跟踪到那只怪"，于是换着法子瞎试了十几个调用。
     *    现在必须把"客户端共跟踪几个实体 + 我自己在哪"一并说出来。 */
    const m = String(err?.message ?? '')
    ok(/客户端现在共跟踪 \d+ 个实体/.test(m), '🔴 找不到时说出"客户端共跟踪几个实体"', m.slice(0, 80))
    ok(/我自己在 \(/.test(m), '🔴 同时说出我自己的坐标（用来判断是不是客户端没跟上）', m.slice(0, 80))
    ok(/没跟上服务端/.test(m), '实体数少得离谱时直说"客户端没跟上服务端"，别让它反复换名字试')
  }
  {   /* 🔴 2026-10-17 用户实机：副手一直挂着 shield 103/336，它却报「没有盾牌，只能拉开距离」。
   *    根因是 `hasShield` 只查 `bot.inventory.items()`（背包 9..44 格），副手是 45 格 ⇒ 看不见。 */
    const slots = []
    slots[45] = { name: 'shield', count: 1 }          // 副手
    const f = mkFightBot([zombieAt('z1', 3), zombieAt('z2', 4), zombieAt('z3', 5)])
    f.bot.inventory = { items: () => [], slots }
    const { ctx } = mkCtx()
    const r = await attack(f.bot, { who: 'zombie', budget: 400 }, ctx)
    ok(r.shield === true, '🔴 盾挂在**副手**（45 格）⇒ 认得出有盾（以前只查背包 9..44 格）', JSON.stringify({ shield: r.shield, s: r.strategy }))
    ok(/有盾/.test(String(r.adviceText ?? '')), '建议里也说清「有盾，边挡边退」', String(r.adviceText ?? '').slice(0, 40))
  }
  {   /* 没盾就别硬说有（反向） */
    const f = mkFightBot([zombieAt('z1', 3), zombieAt('z2', 4), zombieAt('z3', 5)])
    f.bot.inventory = { items: () => [], slots: [] }
    const { ctx } = mkCtx()
    const r = await attack(f.bot, { who: 'zombie', budget: 400 }, ctx)
    ok(r.shield === false, '🔴 背包和副手都没有盾 ⇒ 如实说没有盾', String(r.shield))
  }
  {   /* 背包里的盾照样认（旧行为不许被弄丢） */
    const f = mkFightBot([zombieAt('z1', 3), zombieAt('z2', 4), zombieAt('z3', 5)])
    f.bot.inventory = { items: () => [{ name: 'shield' }], slots: [] }
    const { ctx } = mkCtx()
    const r = await attack(f.bot, { who: 'zombie', budget: 400 }, ctx)
    ok(r.shield === true, '盾在背包里也认（旧行为没丢）', String(r.shield))
  }
  {   /* 附近还有怪 ⇒ 顺带报一句（既有能力，别被重构弄丢） */
    const f = mkFightBot([zombieAt('z1', 2), zombieAt('z2', 9)])
    f.bot.health = 20
    const { ctx } = mkCtx()
    const r = await attack(f.bot, { who: 'zombie', budget: 300 }, ctx)
    ok(Array.isArray(r.nearby) && r.nearby.some((x) => x.name === 'zombie'), '附近还有谁照样报（重构没弄丢）', JSON.stringify(r.nearby))
  }
  {   /* 正常单挑：不该撤、不该换，就是打 */
    const f = mkFightBot([zombieAt('z1', 2)])
    f.bot.health = 20
    const { ctx, calls } = mkCtx()
    const r = await attack(f.bot, { who: 'zombie', budget: 300 }, ctx)
    ok(f.calls.attack.length >= 1 && r.strategy === 'engage', '正常单挑 ⇒ 进攻（策略层不该碍事）', JSON.stringify({ s: r.strategy, atk: f.calls.attack.length }))
    ok(calls.move.length === 0, '正常单挑时不该乱走位', String(calls.move.length))
    ok(typeof r.combat === 'string' && r.combat.length > 0, '每次战斗都带机器可读的 combat（战斗结局）', String(r.combat))
  }
  {   /* 🔴 战斗结局**不许占用** `outcome`（跨工具的统一结局）—— 两个字段都要在，且各说各的 */
    const { outcomeOf } = await import(new URL('../src/task-runner.mjs', import.meta.url))
    const map = {
      killed: 'confirmed', damaged: 'confirmed', retreated: 'confirmed',
      unreachable: 'failed', aborted: 'unknown', timeout: 'unknown', unknown: 'unknown',
    }
    for (const [c, want] of Object.entries(map)) {
      ok(outcomeOf({ combat: c, killed: false }) === want,
        `outcomeOf 把 combat:"${c}" 翻成 "${want}"`, String(outcomeOf({ combat: c, killed: false })))
    }
    /* 撤退时 note 里常带"走不过去/够不着" —— 那不能被文本正则判成失败 */
    ok(outcomeOf({ combat: 'retreated', note: '想撤，但够不着安全点' }) === 'confirmed',
      '🔴 撤退带"够不着"字样的 note，也仍然是"做到了"（文本正则不许抢先）')
    /* 没给 combat 时，统一结局照旧按证据判（战斗层不许污染别的工具） */
    ok(outcomeOf({ arrived: true }) === 'confirmed', '别的工具不带 combat 时判据完全不受影响')
  }
  {   /* 静态接线：core.mjs 必须把能力回调传下去（不然策略层永远是瘸的） */
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const coreNo = strip(readFileSync(new URL('../src/core.mjs', import.meta.url), 'utf8'))
    const atkNo = strip(readFileSync(new URL('../src/attack.mjs', import.meta.url), 'utf8'))
    const has = (s, t, label) => ok(s.includes(t), label, t)
    has(coreNo, 'moveTo: async (pos, o = {}) => await this.walkTo(pos, o)',
      '🔴 core：attack 的 ctx 里传了 moveTo（走位/撤退复用现成 walkTo）')
    has(coreNo, 'equipTo: async (name) => await this.equip({ name })',
      '🔴 core：attack 的 ctx 里传了 equipTo（换武器复用现成 equip）')
    ok(!/setControlState/.test(atkNo), '🔴 attack.mjs 里一处 setControlState 都没有（没有第二套移动控制）')
    ok(!/tasks\./.test(atkNo), '🔴 attack.mjs 里没有 tasks.* 调用（没有第二个任务状态机）')
    ok(!/self\.(dig|placeBlock|useItem)\(/.test(atkNo), 'attack.mjs 不自己调别的动作能力（只走 ctx 回调）')
    has(atkNo, "from './combat-strategy.mjs'", 'attack.mjs 真的 import 了策略层')
    has(atkNo, 'if (Date.now() - t00 >= budget - 100)', '🔴 attack.mjs：循环有总预算闸门（不然一轮轮各吃满预算）')
    has(atkNo, 'const phaseMs = () => callBudget(Math.min(budgetLeft(), COMBAT_PHASE_MS), 4_000)',
      '🔴 attack.mjs：一个战斗阶段比总预算短（否则"重新观察"永远不发生）')
    has(atkNo, 'foes: foes.map((f) => ({ ...f, isTarget: f.id === target.id }))',
      '🔴 attack.mjs：把当前目标按**身份**标出来（按名字标会把同类怪一起剔光，"被围"就数不出来）')
    has(atkNo, 'heldPct: pctOfItem(heldItem),', '🔴 attack.mjs：把手里武器的剩余耐久喂给策略层')
    has(atkNo, 'pctOf: (n) => (bagPct.has(n) ? bagPct.get(n) : null),', '🔴 attack.mjs：背包里同名武器取**最好的一把**')
    has(atkNo, 'durabilityOf', 'attack.mjs 复用现成的 durabilityOf（不自己算耐久）')
    has(atkNo, '...(lastSnap?.weaponWarn ? { weaponWarn: lastSnap.weaponWarn } : {}),',
      '🔴 attack.mjs：武器快坏了要把话带出去（不然 AI 只看到"在打"）')
    /* 用户方案："没有盾牌或无法防御 ⇒ 不进入依赖盾牌的策略"。
     * 我们**根本不举盾** —— 那就要钉死"不许凭空调用防御 API"。 */
    ok(!/activateItem|useItem\(|raiseShield|blockWithShield/.test(atkNo),
      '🔴 attack.mjs 里没有任何"举盾/使用物品"的调用（没有盾牌就不进依赖盾牌的策略）')
  }
}

// ── 收尾 ──────────────────────────────────────────────────────────────────────
for (const d of TMP_DIRS) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
console.log(`\ncheck-core-attack：pass=${pass} fail=${fail}`)
process.exit(fail ? 1 : 0)
