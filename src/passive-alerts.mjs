/* ============================================================================
 * passive-alerts —— 溺水 / 受伤 / 饥饿 三类预警 + auto_eat（用户 2026-10-25）
 * ----------------------------------------------------------------------------
 * 溺水：氧气 300 点，水下每 tick -1（20 tick/秒）⇒ 剩余秒数 = oxygen / 20。
 *       剩 < 5 秒开始每秒警告，报"还有几秒淹死"。
 * 受伤：记住最近 10 秒的血量变化；持续掉血时估算"多久会死"。
 * 饥饿：food <= 6「不健康」；food == 0「走不动路了」；food == 0 且血在掉「开始掉血要饿死了」。
 * auto_eat：food <= 17 时按 熟肉 > 面包 > 生肉 > 腐肉 吃一个，血量回满就停。
 * ========================================================================== */

/** 食物优先级（熟的先） */
const FOOD_TIERS = [
  { key: 'cooked', re: /^(cooked_|_cooked$|baked_potato|bread|cake|pumpkin_pie|golden_apple|golden_carrot|mushroom_stew|rabbit_stew|beetroot_soup|suspicious_stew|honey_bottle)/ },
  { key: 'raw', re: /(beef|porkchop|chicken|mutton|rabbit|fish|salmon|cod|tropical_fish|potato|carrot|beetroot|apple|melon_slice|sweet_berries|glow_berries)/ },
  { key: 'rotten', re: /^(rotten_flesh|spider_eye|poisonous_potato|pufferfish)/ },
]

function foodTier (name) {
  const n = String(name ?? '').toLowerCase()
  for (let i = 0; i < FOOD_TIERS.length; i++) if (FOOD_TIERS[i].re.test(n)) return i
  return -1
}

/** 背包里的食物（按优先级排序） */
export function foodCandidates (b) {
  const out = []
  try {
    for (const it of b.inventory.items()) {
      const tier = foodTier(it.name)
      if (tier < 0) continue
      out.push({ item: it, name: it.name, count: it.count, tier })
    }
  } catch { return [] }
  out.sort((a, c) => a.tier - c.tier)
  return out
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 启动三类预警 + auto_eat（返回 stop 函数）。每 1 秒检查一次。
 * @param {object} self { bot }
 * @param {object} ctx  { report(text), log(text), ctl?:{pauseEat} }
 */
export function startPassiveAlerts (self, ctx = {}) {
  const { report = () => {}, log = () => {} } = ctx
  let stopped = false
  let lastDrownWarn = 0
  let lastHurtWarn = 0
  let lastFoodWarn = 0
  const hpHistory = []          // [{ t, hp }]
  let lastEatAt = 0
  let eating = false

  const tick = async () => {
    if (stopped) return
    const b = self?.bot
    if (!b?.entity) return
    try {
      /* ── 溺水 ── */
      const ox = Number(b.oxygenLevel ?? 300)
      if (ox < 300) {
        const secLeft = Math.max(0, Math.round(ox / 20))
        if (secLeft <= 5 && Date.now() - lastDrownWarn > 1000) {
          lastDrownWarn = Date.now()
          report(secLeft <= 1
            ? `🫧 **马上溺水**（氧气 ${ox}）—— 立刻上浮！`
            : `🫧 溺水警告：还有约 ${secLeft} 秒就撑不住了（氧气 ${ox}），快上浮`)
        }
      }

      /* ── 受伤（持续掉血） ── */
      const hp = Number(b.health)
      hpHistory.push({ t: Date.now(), hp })
      while (hpHistory.length && Date.now() - hpHistory[0].t > 10_000) hpHistory.shift()
      if (hpHistory.length >= 3) {
        const first = hpHistory[0]
        const lost = first.hp - hp
        if (lost >= 1 && Date.now() - lastHurtWarn > 3000) {
          lastHurtWarn = Date.now()
          const rate = lost / ((Date.now() - first.t) / 1000)      // 点/秒
          const secToDie = rate > 0 ? Math.round(hp / rate) : null
          report(`🩸 持续掉血：10 秒内掉了 ${lost.toFixed(1)} 点`
            + (secToDie != null ? `，按这个速度约 **${secToDie} 秒**会死` : '')
            + '（快跑/找掩体/吃东西）')
        }
      }
      /* 血量很低也要报一次 */
      if (hp > 0 && hp <= 4 && Date.now() - lastHurtWarn > 5000) {
        lastHurtWarn = Date.now()
        report(`💔 血量只剩 ${hp.toFixed(1)} 点（${(hp / 2).toFixed(1)} 颗心），很危险`)
      }

      /* ── 饥饿 + auto_eat ── */
      const food = Number(b.food ?? 20)
      const foods = foodCandidates(b)
      const now = Date.now()
      if (food <= 6 && now - lastFoodWarn > 4000) {
        lastFoodWarn = now
        if (food === 0) {
          report(hpHistory.length >= 2 && hpHistory[hpHistory.length - 1].hp < hpHistory[0].hp
            ? '🍖 **开始掉血要饿死了**（饥饿度 0）—— 快找吃的'
            : '🍖 **走不动路了**（饥饿度 0）—— 快找吃的')
        } else {
          report(`🍖 饥饿度 ${food}（不健康）—— 该吃点东西了`)
        }
      }
      /* auto_eat：food <= 17 且没在吃、有食物 → 吃优先级最高的 */
      if (food <= 17 && foods.length && !eating && now - lastEatAt > 2500 && ctx.eatAllowed?.() !== false) {
        eating = true
        lastEatAt = now
        const pick = foods[0]
        try {
          if (b.heldItem?.type !== pick.item.type) await b.equip(pick.item, 'hand')
          await b.consume()
          log(`auto_eat：吃了 ${pick.name}（饥饿 ${food}）`)
        } catch (e) {
          log('auto_eat 失败：' + (e?.message ?? e))
        } finally {
          setTimeout(() => { eating = false }, 1200)
        }
      }
    } catch (e) {
      log('passive-alerts 出错：' + (e?.message ?? e))
    }
  }

  const timer = setInterval(tick, 1000)
  return { stop () { stopped = true; clearInterval(timer) } }
}
