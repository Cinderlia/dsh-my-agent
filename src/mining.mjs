/* ============================================================================
 * 挖掘 —— 两件事：按坐标破坏一块方块（`mc_act {mode:"break"}`）、挖方块（`mc_dig`）
 *
 * 路线图第 ④ 条第三十八刀从 `src\core.mjs` 搬出来。这一层只做"把一块方块挖掉"，
 * 所有判断都靠已经搬出去的邻居：
 *   · `blockReachOf`（world-observer）：**眼睛→方块中心** ≤ 4.5（生存）/ 5.0（创造）才动手
 *   · `ctx.waitGrounded`（dig-guard）：空中挖慢 5 倍，先等落地
 *   · `ctx.equipFor`（inventory）：动手前换到对的工具；换不上直接拒绝，不硬挖
 *   · `digMsFor`（dig-speed）：这块按手上的东西要几秒；**时间不够就别开始挖**
 *     （到点松手 = 破坏进度清零，白玩一次调用）
 *   · `ctx.watchServerBreak` / `ctx.awaitServerBreak`（server-break）：服务端的判决才是判决 ——
 *     "改成空气"＝挖掉、"改成非空气"＝复原（服务端没认）、其余＝没有证据
 *   · `dropHint`（world-observer）：真挖掉了就点一句"东西还在地上"
 *
 * 参数：`self` = McBot（只读 `callLeft()` / `log()` / `requireBot()`），
 *       `ctx` = 五个私有回调（见 core 的 `#mineCtx()`）。
 * 判据：模块不 import `core.mjs`、不 import 游戏库（只认 `b.blockAt` / `b.dig` / `b.game`）。
 * ========================================================================== */

import vec3pkg from 'vec3'
const Vec3 = vec3pkg.Vec3 ?? vec3pkg

import { sleep } from './async-util.mjs'
import { isAir, isLiquid } from './block-names.mjs'
import { heldText, canHarvestNow, toolKinds } from './inventory.mjs'
import { digMsFor } from './dig-speed.mjs'
import { blockReachOf, slowDigWhy, stateNameOf, dropHint } from './world-observer.mjs'
import { callBudget, callSecText } from './budget.mjs'

export async function breakBlock (self, { x, y, z } = {}, ctx = {}) {
  const b = self.requireBot()
  const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))
  const blk = b.blockAt(pos)
  if (!blk) throw new Error(`${pos.x},${pos.y},${pos.z} 未加载`)
  if (isAir(blk.name)) {
    return {
      broken: null, at: { x: pos.x, y: pos.y, z: pos.z },
      note: '那里本来就是空气（**我这边**读到的）—— 要么已经挖掉了，要么客户端的区块缓存旧了：'
        + '`mc_connect {force:true}` 真重连一次（普通的 mc_connect 在已连着时是空操作、不会重连），'
        + '或走远 32 格再回来（区块会重发）；也可以 `mc_scan` 看看附近实际有什么。',
    }
  }
  const name = blk.name
  /* 🔴 2026-10-08 第五份审计报告 ② + 实机定论：`breakBlock` 以前**完全没有"够不着"检查**（dig 有）。
   *    上游 `digging.js` 的 `canDigBlock` 要求**眼睛到方块中心** ≤ 5.1，服务端生存 reach 是 4.5；
   *    对够不着的方块动手 = 服务端静默忽略 + 报告 ① 的客户端预测 ⇒ **静默假成功**。
   *    ⚠️ 判据必须是 `#reachOf`（眼→中心）：用"脚→坐标"算的话，正下方 4 格的方块会被判"够得着"。 */
  const dist = blockReachOf(b, blk)
  const reachMax = b.game?.gameMode === 'creative' ? 5.0 : 4.5
  if (dist > reachMax) {
    return {
      broken: false, at: { x: pos.x, y: pos.y, z: pos.z }, now: name,
      held: heldText(b), reach: Math.round(dist * 100) / 100,
      note: `够不着（我在 ${Math.round(dist * 100) / 100} 格外，${b.game?.gameMode === 'creative' ? '创造 5' : '生存 4.5'} 格以内才挖得动）`
        + ' —— **我没开始挖**（服务端会静默忽略，然后报个假的"挖掉了"）。先 `mc_move` 走到它旁边再挖。',
    }
  }
  // ①′ 空中挖慢 5 倍（`bot.digTime` 的 `notOnGround`）⇒ 先等落地再动手，别把预算喂给一次注定超时的挖掘
  if (!await ctx.waitGrounded(b, Math.min(1_500, Math.max(0, self.callLeft() - 800)))) {
    return {
      broken: false, at: { x: pos.x, y: pos.y, z: pos.z }, now: name,
      held: heldText(b),
      note: '我还在空中（没落地）—— 空中挖方块慢 5 倍（徒手原木 3 秒变 15 秒），'
        + '**我没开始挖**。先站稳（`mc_move {mode:"jump"}` 换个落脚点，或等一下）再叫一次。',
    }
  }
  // ① 先换到对的工具（背包里有的话）—— "手上攥着泥土刨石头"是"一直超时"的头号原因
  const t = await ctx.equipFor(b, blk, `换工具挖 ${name}`)
  // ② 换不上就**别硬挖**：徒手挖石头要 7.5 秒，比一轮预算还长，只会白花时间 + 报个假原因
  if (!canHarvestNow(b, blk)) {
    throw new Error(`手上是 ${t.held}，挖 ${name} ${toolKinds(b, blk)} —— 背包里也没有能挖它的东西。`
      + '先 mc_craft 一把（木镐 = 3 木板 + 2 木棍），或先 mc_act{mode:"equip",name:"…"} 换一个。硬挖会一直超时。')
  }
  const digMs = digMsFor(b, blk, b?.heldItem?.type ?? null)
  /* 🔴 时间不够就**别开始挖**（2026-10-08 实机反馈：玩家转来 AI 的话"快挖完的时候会重置"）。
   *    到点松手 = 破坏进度清零、白费一次调用；模型连着叫三次就是"挖到八成又从头来"。
   *    宁可如实说"我没开始挖"，让它专门再叫一次。 */
  const leftMs = self.callLeft()
  if (digMs != null && leftMs < digMs + 900) {
    return {
      broken: false,
      at: { x: pos.x, y: pos.y, z: pos.z },
      now: name,
      held: heldText(b),
      digMs,
      budgetMs: Math.round(leftMs),
      ...(t.changed ? { tool: `${t.heldBefore} → ${t.held}` } : {}),
      note: `这一轮只剩 ${Math.round(leftMs)}ms，这块按手上的东西要 ${(digMs / 1000).toFixed(1)} 秒${slowDigWhy(b)} —— **我没开始挖**`
        + '（挖到一半到点松手，破坏进度会清零，白费一次调用）。再叫一次 `mc_act {mode:"break"}` 专门挖它就行。',
    }
  }
  /* 动手之前就挂上"服务端认没认"的监听（报告 ①）。 */
  const watch = ctx.watchServerBreak(b, pos)
  let timedOut = false
  try {
    await ctx.t(b.dig(blk, true), 'digBlock', `破坏 ${name}`)
  } catch (e) { if (e?.mcTimeout) timedOut = true; else { watch.stop(); throw e } }
  /* 🔴 超时**不代表没挖掉**：`withTimeout` 只是让我们不等了，mineflayer 那边的挖矿循环还在发包，
   *    方块往往过一会儿就真没了（2026-10-08 实机：连着两次 `mc_act{break}` 都回"那里本来就是空气"）。
   *    所以超时时多等一会儿再复查，别急着报"没挖掉"。
   *    ⚠️ 等的是**服务端的包**（`#awaitServerBreak`），不是干睡 —— 客户端那个 air 是预测，不算数。 */
  await ctx.awaitServerBreak(b, watch, { maxMs: timedOut ? 900 : 1_200 })
  // 同样要验证：挖失败（服务端拒绝/失步）不能报"broken: name"
  const now = b.blockAt(pos)?.name ?? null
  const localGone = now !== name
  /* 没挂上监听（假 bot）时**别下结论**：报 `null` 而不是 false（"没收到回包"是结论，不能凭空说）。 */
  const confirmed = watch.watching ? watch.hit() : null
  /* 🔴 服务端把方块**改回来**了（＝这次破坏服务端没认，客户端随即"复原"）。见 `#watchServerBreak` 注释。 */
  const restored = watch.watching ? watch.restored() : null
  watch.stop()
  const held = heldText(b)
  if (restored != null) {
    await sleep(150)                      // 等客户端把服务端这个包应用上，好报出"复原成什么"
    /* 服务端包里的状态 id 是**权威**的（本地 `blockAt` 可能还没应用上这个包，会读成 air）⇒ 优先用它。 */
    const back = stateNameOf(b, restored) ?? b.blockAt(pos)?.name ?? '别的方块'
    self.log(`⚠️ 服务端把 ${name} 复原了（${pos.x},${pos.y},${pos.z}）—— 这次破坏没被认`)
    return {
      broken: false, restored: true, at: { x: pos.x, y: pos.y, z: pos.z }, now: back,
      held, reach: Math.round(blockReachOf(b, blk) * 100) / 100,
      ...(t.changed ? { tool: `${t.heldBefore} → ${t.held}` } : {}),
      ...(digMs != null ? { digMs } : {}),
      note: `服务端把这块**改回了 ${back}**（复原）—— 这次破坏服务端没认（多半是我离得远，或客户端区块旧了）。`
        + '先 `mc_move` 走到它旁边（3 格以内）再叫一次；连着两三次都这样就用 `mc_connect {force:true}` 重连刷新区块。',
    }
  }
  /* 真挖掉了 ⇒ 掉落物就在脚边。用户 2026-10-08 原话："挖完方块…老是忘记走过去拾取"。
   * 只**点一句**（`mc_act{break}` 这条路从来不自己捡），让模型知道这活还没完。 */
  const pickup = localGone ? dropHint(b) : null
  return {
    broken: localGone ? name : false,
    confirmed,
    at: { x: pos.x, y: pos.y, z: pos.z },
    now,
    held,
    ...(t.changed ? { tool: `${t.heldBefore} → ${t.held}` } : {}),
    ...(digMs != null ? { digMs } : {}),
    ...(pickup ? { pickup } : {}),
    ...(localGone && confirmed === false ? {
      note: '本地世界已经清掉了，但**没收到服务端的破坏回包** —— 服务端很可能拒了这次破坏'
        + '（领地保护 / 权限 / 反作弊 / 太远），客户端这边却把方块写成空气了。'
        + '用 `mc_scan` 或 `mc_observe` 再确认一下，**别在空气上盖房、别走进你以为挖穿的墙**；'
        + '真没挖掉就 `mc_connect {force:true}` 重连刷新区块。',
    } : {}),
    ...(localGone ? {} : {
      note: timedOut
        ? `挖了 ${callSecText()}还没挖掉（手上是 ${held}${digMs != null ? `，这块按手上的东西要 ${(digMs / 1000).toFixed(1)} 秒` : ''}）`
          + '—— 换个对的工具，或换个更近的点位；别当成"服务端拒绝"。'
        : `方块还在（${now}）—— 服务端可能拒了这次破坏，别当成挖掉了`,
    }),
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * 挖方块（`mc_dig` 的正文）—— 路线图第 ④ 条第四十刀从 `src\core.mjs` 搬出来。
 *
 * 一条路，没有兜底：**自己走过去 → 换对的工具 → `bot.dig()` → 等服务端的破坏回包 → 捡掉落物**。
 * 为什么把 collectBlock 那条路整个删掉、为什么够不着就如实说，见函数体里那两段长注释
 * （2026-10-08 实机：交给 collectBlock 会出现"挖完又复原 + 之后几分钟走不了路"）。
 *
 * 参数：`self` = McBot（读 `tasks` / `position` / `cfg`，调 `requireBot` / `callLeft` / `walkTo` /
 *       `interruptMove` / `log`），`ctx` = 十个私有回调（见 core 的 `#mineCtx()`）。
 * 判据：模块不 import `core.mjs`、不 import 游戏库（只认 `b.blockAt` / `b.dig` / `b.findBlocks` / `b.game`）。
 * ──────────────────────────────────────────────────────────────────────────── */

export async function dig (self, { name = null, pos = null, maxDistance = 6, count = 1 } = {}, ctx = {}) {
  const b = self.requireBot()
  const out = []
  const held0 = heldText(b)
  const n = Math.min(Math.max(count, 1), 16)
  /* 水/岩浆是**流体**，挖不掉（`mc_dig water` 只会白花一次调用，日志里留一条
   * "破坏 water 这一轮的时间用完了"）。淹死时的正确动作是**上浮换气**，不是挖水。 */
  const fluid = name ?? (pos ? b.blockAt(new Vec3(pos.x, pos.y, pos.z))?.name : null)
  if (fluid && isLiquid(fluid)) {
    throw new Error(`${fluid} 是流体，挖不掉 —— 想从水里出来：mc_move {"mode":"swim"} 按住 jump 上浮换气，`
      + '露出水面后再 mc_move 往岸上走（不知道岸在哪就先 mc_scan 找最近的干燥方块）。')
  }
  // 先把要挖的方块列出来（collectBlock 要一份目标清单，它自己会走过去 + 捡掉落物）
  /* 📋 任务记账（用户 2026-10-08 路线图第 ②③ 条）：**一次要挖 4 个以上 = 一件"活儿"**。
   * 开工时落一条任务到 `<记忆根>/tasks.json`，以后每次 mc_dig 都接到同一个任务上：
   *   - 模型不用自己记"我挖到第几个了"（进度在磁盘上，掉线重连也在）；
   *   - 收工时把失败**分类**（够不着 / 服务端不认 / 没工具 / 时间用完了），
   *     同一个原因连着 3 次就把任务标成"卡住"，别让它原地死磕（用户要的"循环检测"）。
   * 只要 1 个（或只给 pos）就不建任务：那种调用不需要记账，建了只是噪声。 */
  const task = (name && n >= 4) ? self.tasks.auto({ kind: 'dig', item: name, total: n, params: { maxDistance } }) : null
  if (task) self.tasks.checkpoint(task.taskId, { position: self.position, have: ctx.taskHave(name) })
  const targets = []
  for (let i = 0; i < n; i++) {
    if (pos && i === 0) {
      const one = b.blockAt(new Vec3(pos.x, pos.y, pos.z))
      if (!one) throw new Error(`(${pos.x},${pos.y},${pos.z}) 未加载`)
      targets.push(one)
      continue
    }
    const want = name ?? (pos ? b.blockAt(new Vec3(pos.x, pos.y, pos.z))?.name : null)
    if (!want) throw new Error('需要 name 或 pos')
    const found = typeof b.findBlocks === 'function'
      // ⚠️ mineflayer 4.39 的 findBlocks 返回的是**坐标**（{x,y,z}），不是方块对象
      //    （blocks.js:212 里 findBlock 才是 blockAt(blocks[0])）——所以要自己转回方块
      ? b.findBlocks({ matching: (blk) => blk?.name === want, maxDistance, count: n - targets.length })
        .map((p) => b.blockAt(new Vec3(p.x, p.y, p.z)))
        .filter((blk) => blk && blk.name === want)
      : [b.findBlock({ matching: (blk) => blk?.name === want, maxDistance })].filter(Boolean)
    if (!found.length) { out.push(`附近找不到 ${want}`); break }
    for (const f of found) if (!targets.includes(f)) targets.push(f)
    if (targets.length >= n) break
  }
  if (!targets.length) {
    // 一个目标都没找到：这是**真的**做不成（`no-target`），记一笔 —— 连着三次就说明该换地方了
    if (task) self.tasks.fail(task.taskId, { action: 'dig', reason: out[out.length - 1] ?? `附近找不到 ${name}` })
    return out
  }

  /* 🔴 按距离从近到远排（显式给的那个 pos 仍排第一）：
   * 2026-10-08 用户转来的实机反馈 —— "mc_dig 挑到够不着的目标就超时"。
   * findBlocks 的返回顺序不保证是最近的，第一个够不着就能把整轮 11 秒吃光。
   */
  const distOf = (blk) => { try { return b.entity.position.distanceTo(blk.position) } catch { return Infinity } }
  if (targets.length > 1) {
    const pinned = pos ? targets[0] : null
    const rest = targets.filter((t) => t !== pinned).sort((a, c) => distOf(a) - distOf(c))
    targets.length = 0
    targets.push(...(pinned ? [pinned, ...rest] : rest))
  }

  /* 🔴 手上（背包里）没有能挖它的工具就别动手：
   * ① 硬挖石头/矿石不掉东西，白耗十几秒，还容易被误当成"挖到了"；
   * ② mineflayer-collectblock 挖之前会拿 `{requireHarvest:true, getFromChest:true}` 去问
   *    mineflayer-tool 要工具，而那个插件在 chestLocations 为空时**无限递归** →
   *    JS 堆十几秒涨到几 GB 直接 OOM，而且全在微任务里跑，连 withTimeout 都不会触发。
   *    （vendor 树里已经给 mineflayer-tool 打了补丁，这里再挡一道，别白跑。）
   */
  if (b.game?.gameMode !== 'creative') {
    const inv = b.inventory.items()
    const canHarvest = (blk) => !blk?.harvestTools || inv.some((it) => blk.harvestTools[it.type])
    if (!targets.some(canHarvest)) {
      const blk = targets[0]
      const why = `背包里没有能挖 ${blk.name} 的工具（${toolKinds(b, blk)}）—— 先 mc_craft 一把（木镐 = 3 木板 + 2 木棍），再叫我挖`
      if (task) self.tasks.fail(task.taskId, { action: 'dig', reason: why })
      return [why]
    }
  }

  // ① 有 mineflayer-collectblock 就交给它：走过去 → 挖 → 捡掉落物（换工具它内部用 mineflayer-tool）
  // 🔴 **一次只喂一个目标**：collectBlock 内部是个 for 循环，任何一个目标寻路失败都会把整批带崩
  //    （2026-10-06 实机：挖 4 根原木只拿到 1 根，其余全因 "Took to long to decide path to goal!" 丢掉）。
  //    逐个喂 + 逐个 catch：坏目标跳过，好目标照挖。
  /* 🔴 用 `self.callLeft()` 而不是 `callDeadline()`：本轮已经用掉的时间要算进去
   *    （`mc_sequence` 里"走一段再挖"时，挖只剩 1 秒，不能又给整整 11 秒）。
   * 🔴 再**留 900ms 收尾**（2026-10-08 实机反馈：`mc_dig` 报 `Error: tool call timed out after 6000ms`，
   *    方块其实早挖掉了）。收尾包括：`#cancelCollect` 等 `collectBlock_finished`、
   *    兜底原地挖、拼返回文本、DSH 层序列化 —— 这些以前都排在预算之外，
   *    两个目标就是 2×1.5 秒，整轮直接冲出工具超时，模型只拿到一个没有信息的硬错误。 */
  const deadline = Date.now() + Math.max(0, self.callLeft() - 900)
  const leftOf = () => deadline - Date.now()
  /* 🔴 2026-10-08 实机（用户「挖矿还是会」）：**`dig()` 不再把方块交给 mineflayer-collectblock**。
   *    collectBlock 走过去用的是 `goals.GoalLookAtBlock`（vendor CollectBlock.js:30）—— 只要**看得见**
   *    就算"到了"，站 6 格开外也算到，然后 `bot.dig()` 从够不着的地方挖：
   *    服务端按"眼睛→方块中心 ≤4.5"拒收，而 mineflayer 的 `finishDigging()`（digging.js:158）
   *    已经把**客户端**那格写成 air ⇒ 画面上就是"挖完又复原"；
   *    更糟的是服务端不回 air 方块更新 ⇒ `diggingTask` 永远不 resolve ⇒ 采集任务永远挂着
   *    （`collectBlock_finished` 不 emit）⇒ 之后几分钟走不了路（实机日志 02:38–02:43 连打 20 次
   *    "上次的采集任务还在后台跑"，机器人整整 5 分钟没挪窝）。
   *    现在统一成一条路：**自己走到方块旁边**（`walkTo` 的 pathfinder 带 canDig，能挖穿挡路的），
   *    再按"眼睛→方块中心"复核，够得着才 `bot.dig()`，而且**认服务端的破坏回包**；
   *    掉落物由 `#grabDrops` 捡（原来靠 collectBlock 顺手捡）。 */
  {
    /* 🔴 2026-10-08 审计④：`interruptMove()` 以前是**死代码**（定义了没人调），而文档说 mc_dig 靠它抢占。
     *    走路/采集会按着 forward、占着 pathfinder ⇒ 先把还在跑的移动真停掉，再领号。 */
    await self.interruptMove()
    ctx.beginMove()
    let okCount = 0
    let seen = 0
    const reachMax = b.game?.gameMode === 'creative' ? 5.0 : 4.5
    for (const target of targets) {
      seen++
      // 🔴 单次调用 ≤11 秒：到点就带着已经挖到的结果返回，剩下的下次再叫
      const left = leftOf()
      if (left < 900) {
        out.push(`—— 这一轮的 ${callSecText()}用完了（挖到 ${okCount}/${targets.length}），`
          + `还有 ${targets.length - seen + 1} 个没挖：再叫一次 mc_dig 接着挖`)
        break
      }
      // 🔴 别让**一个**够不着的目标吃掉整轮：单个目标最多给"剩余时间的一大半"，
      //    剩下的时间留给后面的目标 + 兜底原地挖（2026-10-08 实机反馈）。
      const budget = Math.max(300, Math.min(
        callBudget(self.cfg.collectBudgetMs), left, Math.max(2500, Math.floor(left * 0.6))))
      const p = target.position.clone()
      const nm = target.name
      /* 够不着 → **先自己走过去**（以前这一步交给 collectBlock，而它只要"看得见"就算到）。
       * 🔴 判据必须是 `#reachOf`（**眼睛 → 方块中心**，服务端也是这么判的），不是脚到方块坐标：
       *    用脚算的话，正下方 4 格的石头会被判"够得着"，原地挖一发服务端根本不认。
       * 🔴 走到方块**自己那一格**（x+0.5 / y / z+0.5）再复核：走过去这一路 pathfinder 可能顺手
       *    把它挖穿（`canDig`），所以到地方必须重新读一次方块。 */
      let fresh = b.blockAt(p)
      if (!fresh || fresh.name !== nm) continue
      if (blockReachOf(b, fresh) > reachMax) {
        const w = await self.walkTo({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 }, { arrive: 2.2, budget })
        fresh = b.blockAt(p)
        if (!fresh || fresh.name !== nm) {
          okCount++
          if (task) self.tasks.progress(task.taskId, { add: 1 })
          out.push(`走过去的时候顺手挖掉了 ${nm} @ ${p} → 现在 ${b.blockAt(p)?.name ?? '?'}`)
          const got = await ctx.grabDrops(b)
          if (got > 0) out.push(`　（顺手捡回 ${got} 个掉落物）`)
          else {
            const hint = dropHint(b)
            if (hint) out.push(`　（${hint}）`)
          }
          continue
        }
        if (blockReachOf(b, fresh) > reachMax) {
          const away = blockReachOf(b, fresh)
          out.push(`够不着 ${nm} @ ${p}（眼睛到方块中心 ${away.toFixed(1)} 格，`
            + `${w?.arrived ? '走过去也只到这么远' : '走过去也没走到'}）—— `
            + '先 `mc_move` 到它旁边（或换个近一点的目标）再叫我挖：站远了挖服务端不认，方块会"复原"')
          continue
        }
      }
      {
        const watch = ctx.watchServerBreak(b, p)
        try {
          // 空中挖慢 5 倍 ⇒ 先等落地（否则预算全喂给一次注定超时的挖掘）
          if (!await ctx.waitGrounded(b, Math.min(1_500, Math.max(0, leftOf() - 800)))) {
            out.push(`—— 我还在空中（没落地）就挖不了 ${nm}：空中挖方块慢 5 倍，先落稳（或 \`mc_move {mode:"jump"}\` 换个落脚点）再叫一次 mc_dig`)
            break
          }
          await ctx.equipFor(b, fresh, `换工具挖 ${nm}`)
          const oneMs = digMsFor(b, fresh, b?.heldItem?.type ?? null)
          if (oneMs != null && leftOf() < oneMs + 500) {
            out.push(`—— 剩下的时间不够挖 ${nm}（这块要 ${(oneMs / 1000).toFixed(1)} 秒${slowDigWhy(b)}），没开始挖：再叫一次 mc_dig 接着挖`)
            break
          }
          await ctx.t(b.dig(fresh, true), 'dig', `挖 ${nm}`)
          /* 等**服务端**的判决（客户端那个 air 是预测，不算数；服务端的包可能晚到约 1 秒） */
          await ctx.awaitServerBreak(b, watch)
          const now = b.blockAt(p)?.name ?? '?'
          const confirmed = watch.watching ? watch.hit() : null
          /* 🔴 服务端把方块**改回来**了（复原）：这次破坏服务端没认。见 `#watchServerBreak` 注释。 */
          const restored = watch.watching ? watch.restored() : null
          if (restored != null) {
            await sleep(150)
            const back = stateNameOf(b, restored) ?? b.blockAt(p)?.name ?? '别的方块'
            self.log(`⚠️ 服务端把 ${nm} 复原了（${p}）—— 这次破坏没被认`)
            out.push(`没挖掉 ${nm} @ ${p}：服务端把这块**改回了 ${back}**（复原）`
              + ' —— 多半是我离得远，或客户端区块旧了。先 `mc_move` 走到它旁边（3 格以内）再叫一次 mc_dig；'
              + '连着两三次都这样就用 `mc_connect {force:true}` 重连刷新区块')
          } else if (now !== nm) {
            okCount++
            if (task) self.tasks.progress(task.taskId, { add: 1 })
            /* 🔴 审计①：`bot.dig()` 的 resolve 来自**客户端预测**（digging.js:143-159 自己
             *    `_updateBlockState(pos, 0)` 又自己接住）⇒ 服务端拒了也照样"成功"。
             *    只有服务端发的破坏包才算真挖掉。 */
            if (!watch.watching) out.push(`挖掉 ${nm} @ ${p}（原地，不用走过去）→ 现在 ${now}`)
            else if (confirmed) out.push(`挖掉 ${nm} @ ${p}（原地，不用走过去）→ 现在 ${now}（服务端已确认）`)
            else out.push(`本地读到 ${nm} @ ${p} 已经变成 ${now}，但**没收到服务端的破坏回包**`
              + ' —— 服务端很可能拒了这次破坏（够不着 / 领地保护 / 权限 / 反作弊）：别当成挖掉了，'
              + '先 `mc_scan` 复核，真没挖掉就 `mc_connect {force:true}` 重连刷新区块')
            /* 🔴 原地挖绕过了 collectBlock（它平时挖完还会把掉落物捡回来）⇒ 得自己去捡，
             *    否则"挖到 3 根原木、背包里只有 1 根"（2026-10-08 实机）。 */
            const got = await ctx.grabDrops(b)
            if (got > 0) out.push(`　（顺手捡回 ${got} 个掉落物）`)
            else {
              /* 一个都没捡到（够不着 / 卡住 / 背包满）⇒ 点一句"东西还在地上"。
               * why：用户 2026-10-08 原话"挖完方块或者打完动物以后老是忘记走过去拾取" ——
               * 捡东西是**决策**，插件替不了，但结果里必须让它知道这活还没完。 */
              const hint = dropHint(b)
              if (hint) out.push(`　（${hint}）`)
            }
          } else out.push(`没挖成 ${nm} @ ${p}（原地挖完了，但那里**还是 ${now}**）`
            + ' —— 服务端没认这次破坏（失步 / 领地保护 / 工具不对）：先 `mc_scan` 复核，再 `mc_connect {force:true}` 重连清一下客户端缓存')
        } catch (e) {
          /* 🔴 被新指令抢占（`interruptMove` / abort）：**这不是失败**，进度留着 —— 用户
           * 2026-10-08 路线图原话"玩家发出新命令可取消或抢占旧任务"。 */
          if (e?.mcAborted) {
            if (task) self.tasks.pause(task.taskId, '被新的指令打断')
            throw e
          }
          out.push(`挖 ${nm} @ ${p} 失败：${String(e?.message ?? e).slice(0, 120)}`)
        } finally {
          watch.stop()
        }
        continue
      }
    }
    /* 以前这里还有一条"够不着就交给 collectBlock"的路 + 一个"② 退回：原地挖"的兜底循环 ——
     * 2026-10-08 全部删掉：那条路正是"挖完又复原 + 之后几分钟走不了路"的来源（见本函数开头的注释）。
     * 够不着就如实说，让模型自己 `mc_move` 过去再挖。 */
    ctx.taskSettle(task, out, okCount, targets.length)
    ctx.verdictLine(out, okCount, targets.length)
    return ctx.withHeld(out, b, held0)
  }

  ctx.verdictLine(out, okCount, targets.length)
  return ctx.withHeld(out, b, held0)
}
