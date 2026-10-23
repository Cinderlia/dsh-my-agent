#!/usr/bin/env node
/**
 * 村民交易自检 —— `src/trade.mjs`
 *
 * 🔴 起因（用户 2026-10-23「1档和2档做一下」）：一档第一条 = 村民交易。在此之前插件**一条交易
 *    能力都没有**（附魔书、钻石工具、食物这些中期最划算的东西全得自己挖）。
 *
 * 钉死这几件事：
 *   ① 附近没村民 ⇒ 报 `no-villager` 并指路（`mc_scan {name:"villager"}`），不瞎抛；
 *   ② `who` 认职业名（中文「图书管理员」/英文 librarian）—— 职业在 `villager_data` 元数据里，
 *      按 `registry.entitiesByName.villager.metadataKeys` 查下标，不写死；
 *   ③ 太远先走过去（`self.walkTo`，intent=interact），走不到就报 `too-far` 而不是硬开界面；
 *   ④ 流浪商人 ⇒ `not-a-villager`（`openVillager` 内部 assert 了 entityType，开了就抛）；
 *   ⑤ 界面开了但没交易 ⇒ `no-trades`（无业/宝宝）；
 *   ⑥ `list` 列出序号 / 要什么 / 给什么 / 已换几次 / **材料够换几次**，并**把窗口关掉**；
 *   ⑦ `buy` 的 `count` **必须显式给数**（上游 `count = count || 剩余次数`，传 undefined 会一口气全换掉）；
 *   ⑧ 材料/剩余次数不够 ⇒ 自己收窄到实际能换的次数，并在结果里说明（`note`）；
 *   ⑨ 复核以"它自己报的已换次数"为准（背包差值只当旁证）；一次都没换成就报 `not-confirmed`；
 *   ⑩ 买得起几次按 `realPrice`（含需求涨价）算，不是 `inputItem1.count`；
 *   ⑪ 缺材料 ⇒ `no-materials` 并报清要什么；序号越界 ⇒ `no-such-trade`；
 *   ⑫ 插件面接线：`index.js` 注册了 `mc_trade`，并**直接**调 `src/trade.mjs` 的 `tradeVillager`（`core.mjs` 卡在 ≤1000 行，不再往门面上加薄包装 —— `check-module-load` 的 ④ 盯着这条）。
 *
 * 用法：node tools/check-mc-trade.mjs
 */
import { readFileSync } from 'node:fs'
import {
  tradeVillager, villagersNear, villagerDataOf, labelOf, tradeTextOf, tradeLineOf,
  affordableCountOf, countOf, PROFESSIONS, PROFESSION_CN, TRADE_REACH,
} from '../src/trade.mjs'

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}${extra ? ` —— ${extra}` : ''}`) }
}
const section = (t) => console.log(`\n${t}`)

/** 带 `distanceTo` 的位置（模块里走 `e.position.distanceTo(me)`，跟真 vec3 同一套调用）。 */
const P = (x, y, z) => ({
  x, y, z,
  distanceTo (o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z) },
})

/** 职业元数据（原版 `villager_data`：0~7 位外观类型、8~15 职业、16~23 等级）。 */
const villagerMeta = (b, profession, level = 1) => {
  const keys = b.registry.entitiesByName.villager.metadataKeys
  const idx = keys.indexOf('villager_data')
  const arr = []
  arr[idx] = ((level & 0xff) << 16) | ((PROFESSIONS.indexOf(profession) & 0xff) << 8)
  return arr
}

const item = (type, count, extra = {}) => ({ type, count, name: type, displayName: extra.displayName ?? type, ...extra })

/**
 * 假 bot：
 *  · `openVillager(ent)` 返回一个窗口（`trades` 由调用方给；`null` 模拟"包一直没来"）
 *  · `trade(win, i, n)` 按原版行为涨 `nbTradeUses`、扣材料、加产出（`failTrade` 时抛错）
 *  · `self.walkTo` 记调用；`arrive:false` 时模拟走不到
 */
function fake ({ me = { x: 0, y: 64, z: 0 }, villagers = [], items = [], trades = [], walk = true, arrive = true, openError = null, failTrade = false } = {}) {
  const inv = items.map((it) => ({ ...it }))
  const bot = {
    calls: [],
    inventory: { items: () => inv },
    currentWindow: null,
    entity: { position: P(me.x, me.y, me.z) },
    entities: {},
    registry: { entitiesByName: { villager: { metadataKeys: ['shared_flags', 'health', 'baby', 'villager_data'] } }, enchantments: { 0: { displayName: '保护' } } },
  }
  bot.inventory = Object.assign(bot.inventory, { __isInv: true })
  let nextId = 100
  for (const v of villagers) {
    const id = nextId++
    const e = {
      id, name: v.name ?? 'villager', displayName: v.displayName ?? '村民',
      position: P(v.x ?? 1, v.y ?? 64, v.z ?? 0),
      metadata: v.profession ? villagerMeta(bot, v.profession, v.level ?? 1) : [],
    }
    bot.entities[id] = e
    v.__e = e
  }
  bot.openVillager = async (ent) => {
    bot.calls.push(['openVillager', ent.id])
    if (openError) throw new Error(openError)
    const win = {
      type: 'minecraft:merchant',
      trades: trades.length ? trades : null,
      slots: [],
      count: (type) => inv.filter((it) => it.type === type).reduce((n, it) => n + it.count, 0),
    }
    bot.currentWindow = win
    return win
  }
  bot.trade = async (win, index, count) => {
    bot.calls.push(['trade', index, count])
    if (count == null) throw new Error('测试失败：count 必须是显式数字（上游 undefined = 全换掉）')
    if (failTrade) throw new Error('server said no')
    const tr = win.trades[index]
    for (let i = 0; i < count; i++) {
      tr.nbTradeUses = (tr.nbTradeUses ?? 0) + 1
      const need1 = tr.realPrice ?? tr.inputItem1.count
      const it1 = inv.find((x) => x.type === tr.inputItem1.type)
      if (it1) it1.count -= need1
      if (tr.hasItem2) {
        const it2 = inv.find((x) => x.type === tr.inputItem2.type)
        if (it2) it2.count -= tr.inputItem2.count
      }
      const out = inv.find((x) => x.type === tr.outputItem.type)
      if (out) out.count += tr.outputItem.count
      else inv.push(item(tr.outputItem.type, tr.outputItem.count, { displayName: tr.outputItem.displayName }))
    }
  }
  bot.closeWindow = async (win) => {
    bot.calls.push(['closeWindow'])
    bot.currentWindow = null
    return true
  }
  const self = {
    requireBot: () => bot,
    walkTo: async (target, opts) => {
      bot.calls.push(['walkTo', target, opts?.intent])
      if (arrive) {
        const e = Object.values(bot.entities)[0]
        if (e) { e.position = P(target.x, target.y, target.z); bot.entity.position = e.position }
      }
      return { arrived: arrive, remaining: arrive ? 0 : 12.4 }
    },
  }
  return { bot, self, inv }
}

const emeraldTrade = (uses = 0, max = 12, extra = {}) => ({
  inputItem1: item('emerald', 3, { displayName: '绿宝石' }),
  inputItem2: null,
  hasItem2: false,
  outputItem: item('enchanted_book', 1, { displayName: '附魔书' }),
  nbTradeUses: uses,
  maximumNbTradeUses: max,
  realPrice: 3,
  disabled: false,
  ...extra,
})

/* ─────────────────────────── ① 找不到村民 ─────────────────────────── */
section('① 附近没村民：报 no-villager 并指路')
{
  const { self } = fake({})
  const r = await tradeVillager(self, {})
  ok(r.ok === false && r.reason === 'no-villager', '没人可交易 ⇒ no-villager')
  ok(/mc_scan/.test(r.hint) && /villager/.test(r.hint), 'hint 指路 mc_scan {name:"villager"}', r.hint)
  ok(/流浪商人/.test(r.hint), 'hint 提一句流浪商人的限制')
}

/* ─────────────────────────── ② 认人 + 职业 ─────────────────────────── */
section('② who 认职业名；普通村民排在最近')
{
  const { self } = fake({
    villagers: [
      { x: 2, profession: 'farmer' },
      { x: 8, profession: 'librarian' },
      { x: 12, profession: null },
    ],
  })
  const r1 = await tradeVillager(self, { who: '图书管理员' })
  ok(/图书管理员/.test(r1.villager ?? ''), '「图书管理员」认得出来', r1.villager)
  const r2 = await tradeVillager(self, { who: 'librarian' })
  ok(/图书管理员/.test(r2.villager ?? ''), '英文 librarian 也认')
  ok(PROFESSION_CN.librarian === '图书管理员', '职业中文表对得上')
  ok(TRADE_REACH === 3.5, '交互门槛 3.5 格')

  const b = {
    registry: { entitiesByName: { villager: { metadataKeys: ['shared_flags', 'villager_data'] } } },
  }
  const e = { name: 'villager', displayName: '村民', metadata: [] }
  e.metadata[1] = { type: 'villager', value: { profession: 9, level: 3, type: 0 } }
  const d = villagerDataOf(b, e)
  ok(d?.profession === 'librarian' && d?.level === 3, '`{type,value}` 形状的 villager_data 也解得开', JSON.stringify(d))
  ok(/Lv3/.test(labelOf(b, e)), 'label 带等级')
  ok(!villagerDataOf({ registry: {} }, e), '没有 registry 时返回 null（不抛）')
}

/* ─────────────────────────── ③ 太远先走过去 ─────────────────────────── */
section('③ 太远先走过去；走不到就报 too-far')
{
  const far = { villagers: [{ x: 20 }], items: [item('emerald', 9)], trades: [emeraldTrade()] }
  const a = fake(far)
  const ra = await tradeVillager(a.self, { action: 'list' })
  const walked = a.bot.calls.find((c) => c[0] === 'walkTo')
  ok(Boolean(walked), '先调了 walkTo')
  ok(walked?.[2] === 'interact', '走近用 intent=interact（2.2 格就算到）')
  ok(ra.ok === true && ra.count === 1, '走到了就照常列交易')

  const b2 = fake({ ...far, arrive: false })
  const rb = await tradeVillager(b2.self, { action: 'list' })
  ok(rb.ok === false && rb.reason === 'too-far', '走不到 ⇒ too-far（不硬开界面）')
  ok(!b2.bot.calls.some((c) => c[0] === 'openVillager'), '走不到就不开界面')
}

/* ─────────────────────────── ④ 流浪商人 / 开不起 / 没交易 ─────────────────────────── */
section('④ 流浪商人、界面开不起、没交易，各有各的说法')
{
  const t = fake({ villagers: [{ name: 'wandering_trader', displayName: '流浪商人' }], trades: [emeraldTrade()] })
  const rt = await tradeVillager(t.self, {})
  ok(rt.ok === false && rt.reason === 'not-a-villager', '流浪商人 ⇒ not-a-villager')
  ok(/entityType/.test(rt.hint), '说明白是 openVillager 的 assert 不认它')

  const o = fake({ villagers: [{ x: 1 }], trades: [emeraldTrade()], openError: 'timed out' })
  const ro = await tradeVillager(o.self, {})
  ok(ro.ok === false && ro.reason === 'open-failed', '开不起 ⇒ open-failed')
  ok(/睡着|宝宝|职业/.test(ro.hint), 'hint 列常见原因')

  const n = fake({ villagers: [{ x: 1 }], trades: [] })
  const rn = await tradeVillager(n.self, {})
  ok(rn.ok === false && rn.reason === 'no-trades', '没交易 ⇒ no-trades')
  ok(rn.closed === true, '而且把窗口关掉了')
}

/* ─────────────────────────── ⑤ list ─────────────────────────── */
section('⑤ list：序号 / 价格 / 已换 / 够换几次，并关窗')
{
  const { self, bot } = fake({
    villagers: [{ x: 1 }],
    items: [item('emerald', 7), item('book', 2)],
    trades: [
      emeraldTrade(0, 12),
      {
        inputItem1: item('emerald', 6, { displayName: '绿宝石' }),
        inputItem2: item('book', 1, { displayName: '书' }),
        hasItem2: true,
        outputItem: item('diamond_pickaxe', 1, { displayName: '钻石镐' }),
        nbTradeUses: 2, maximumNbTradeUses: 3, realPrice: 6, disabled: false,
      },
      emeraldTrade(12, 12, { disabled: true }),
    ],
  })
  const r = await tradeVillager(self, { action: 'list' })
  ok(r.ok === true && r.count === 3, '列出 3 条')
  ok(r.trades[0].affordable === 2, '第 1 条：7 个绿宝石 / 3 一次 ⇒ 够换 2 次', String(r.trades[0].affordable))
  ok(r.trades[1].affordable === 1, '第 2 条：还要 1 本书，只剩 1 次上限 ⇒ 1 次', String(r.trades[1].affordable))
  ok(r.trades[2].disabled === true && /售罄/.test(r.text), '售罄的那条标出来')
  ok(/^1\. 3 绿宝石 » 1 附魔书/m.test(r.text), 'text 是人话序号行', JSON.stringify(r.text.split('\n')[0]))
  ok(r.closed === true && bot.currentWindow === null, '列完把窗口关了')
  ok(/action:"buy"/.test(r.hint), 'hint 教怎么买')
}

/* ─────────────────────────── ⑥ buy ─────────────────────────── */
section('⑥ buy：count 显式给、自己收窄、以"已换次数"复核')
{
  const { self, bot, inv } = fake({
    villagers: [{ x: 1 }],
    items: [item('emerald', 7)],
    trades: [emeraldTrade(0, 12)],
  })
  const r = await tradeVillager(self, { action: 'buy', index: 1, count: 5 })
  const call = bot.calls.find((c) => c[0] === 'trade')
  ok(call?.[2] === 2, '只够 2 次 ⇒ 传下去的是 2（不是 5）', String(call?.[2]))
  ok(r.ok === true && r.used === 2, '复核 used=2')
  ok(/只能换 2 次/.test(r.note ?? ''), 'note 说明收窄了', r.note)
  ok(r.gain?.enchanted_book === 2, '背包里多了 2 本附魔书', JSON.stringify(r.gain))
  ok(r.spent?.emerald === 6, '扣了 6 个绿宝石', JSON.stringify(r.spent))
  ok(inv.find((i) => i.type === 'emerald').count === 1, '包里剩 1 个')

  const { self: s2, bot: b2 } = fake({ villagers: [{ x: 1 }], items: [item('emerald', 9)], trades: [emeraldTrade()] })
  await tradeVillager(s2, { action: 'buy', index: 1 })
  const c2 = b2.calls.find((c) => c[0] === 'trade')
  ok(c2?.[2] === 1, '不给 count 默认换 1 次（不是"全换掉"）', String(c2?.[2]))
}

/* ─────────────────────────── ⑦ buy 的各种拒绝 ─────────────────────────── */
section('⑦ buy 越界 / 缺料 / 售罄 / 换不成')
{
  const { self } = fake({ villagers: [{ x: 1 }], items: [item('emerald', 9)], trades: [emeraldTrade()] })
  const r1 = await tradeVillager(self, { action: 'buy', index: 5 })
  ok(r1.ok === false && r1.reason === 'no-such-trade', '序号越界 ⇒ no-such-trade')

  const { self: s2, bot: b2 } = fake({ villagers: [{ x: 1 }], items: [], trades: [emeraldTrade()] })
  const r2 = await tradeVillager(s2, { action: 'buy', index: 1 })
  ok(r2.ok === false && r2.reason === 'no-materials' && /绿宝石/.test(r2.need ?? ''), '没材料 ⇒ no-materials 并报清要什么')
  ok(!b2.calls.some((c) => c[0] === 'trade'), '没材料就不发交易包')

  const { self: s3 } = fake({ villagers: [{ x: 1 }], items: [item('emerald', 9)], trades: [emeraldTrade(4, 4)] })
  const r3 = await tradeVillager(s3, { action: 'buy', index: 1 })
  ok(r3.ok === false && r3.reason === 'disabled', '剩 0 次 ⇒ disabled')

  const { self: s4, bot: b4 } = fake({ villagers: [{ x: 1 }], items: [item('emerald', 9)], trades: [emeraldTrade()], failTrade: true })
  const r4 = await tradeVillager(s4, { action: 'buy', index: 1 })
  ok(r4.ok === false && r4.reason === 'trade-error', '服务端拒绝 ⇒ trade-error')
  ok(r4.used === 0, '一次没换成也如实报 used=0')
  ok(b4.currentWindow === null, '出错也把窗口关了（别把界面挂着挡后面的工具）')

  const { self: s5 } = fake({ villagers: [{ x: 1 }], items: [item('emerald', 9)], trades: [emeraldTrade()] })
  let threw = null
  try { await tradeVillager(s5, { action: 'buy', index: 0 }) } catch (e) { threw = e }
  ok(threw && /从 1 开始/.test(threw.message), 'index=0 被挡（从 1 开始）', threw?.message)
}

/* ─────────────────────────── ⑧ 涨价按 realPrice ─────────────────────────── */
section('⑧ 买得起几次按 realPrice（含需求涨价）算')
{
  const tr = emeraldTrade(0, 12, { realPrice: 5 })
  const { bot } = fake({ items: [item('emerald', 7)] })
  ok(affordableCountOf(bot, tr) === 1, '标价 3 实际 5 ⇒ 7 个只够 1 次（按 count 会算成 2）', String(affordableCountOf(bot, tr)))
  ok(countOf(bot, 'emerald') === 7, 'countOf 数得对')
  ok(affordableCountOf(bot, emeraldTrade(0, 12, { maximumNbTradeUses: 2 })) === 2, '剩余次数上限也会收窄')
  const t2 = tradeTextOf(bot, tr)
  ok(/绿宝石/.test(t2.cost) && /附魔书/.test(t2.give), '成本/产出描述对')
  ok(/^2\. /.test(tradeLineOf(bot, tr, 1)), '行号从 1 开始')
}

/* ─────────────────────────── ⑨ 接线 ─────────────────────────── */
section('⑨ 插件面接线（index.js）')
{
  const idx = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const core = readFileSync(new URL('../src/core.mjs', import.meta.url), 'utf8')
  const coreLines = core.split('\n').length
  ok(/name: 'mc_trade'/.test(idx), 'index.js 注册了 mc_trade')
  ok(/action: args\.action, who: args\.who, index: args\.index, count: args\.count/.test(idx), 'mc_trade 把 action/who/index/count 透传下去')
  ok(/村民交易/.test(idx) && /附魔书/.test(idx), 'description 说清它是干什么的（村民交易/附魔书）')
  ok(/import \{ tradeVillager \} from '\.\/src\/trade\.mjs'/.test(idx), 'index.js 直接引了 src/trade.mjs')
  ok(/return tradeVillager\(sess\.bot, \{/.test(idx), 'mc_trade 的 execute 直接调模块（self = 插件门面）')
  ok(coreLines <= 1000, 'core.mjs 没被这条功能撑破 ≤1000 行（现在 ' + coreLines + '）')
  const t = readFileSync(new URL('../src/trade.mjs', import.meta.url), 'utf8')
  ok(/count = count \|\|/.test(t) && /maximumNbTradeUses - nbTradeUses/.test(t), '源码注释里记着"count 必须显式给"的理由')
  ok(/realPrice/.test(t), '按 realPrice 算价格')
}

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
