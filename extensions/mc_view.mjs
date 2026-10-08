/**
 * mc_view —— 第一人称视角截图（dsh-mc-agent 扩展）
 *
 * 需求（用户 2026-10-05）：给它装上第一人称获取，让 agent 每次使用前查看第一人称的图片。
 * 改（用户 2026-10-06「看第一视角改成让 ai 自主调用」）：**硬门禁默认关掉** —— 不再拦任何动作，
 * 什么时候看一眼由 AI 自己判断（靠工具说明里的"什么时候值得看"引导）。
 *
 * 装法：本文件放在 `<profile>/node_modules/dsh-mc-agent/extensions/` 下即自动加载
 * （插件 index.js:4089 的扩展点在**异步 IIFE** 里 import 本目录所有 .mjs 并调 apply）。
 *
 * 两部分：
 *   ① 工具 `mc_view`（主体）：从机器人眼睛（眼高 1.62）朝视线方向渲染一张 PNG ——
 *      内联成图片附件（模型直接能看）+ 落盘工作区 + 一段文字摘要（准星命中/脚下/前方/视野构成）。
 *   ② 可选硬门禁 `ctx.tools.guard(...)`（**默认关**）：动作类工具（mc_move/mc_act/mc_dig/mc_build/
 *      mc_give/mc_command/mc_sequence）执行前，若本会话**手上没有够新的第一人称图**就拒绝执行，
 *      并让模型先调 mc_view。想变回强制模式见下面的环境变量 / view.json。
 *
 * 门禁的尺度（若启用）：看一眼之后**最多连着做 N 个动作、且不超过 T 秒**，超了才要求再看一次
 * （最初是"看一次只能做一个动作"，模型一轮里习惯连做 2~4 个动作 ⇒ 后面几个全被拒、刷一屏红字、还浪费回合）。
 *
 * 环境变量（可选）：
 *   DSH_MC_AGENT_VIEW_GATE=on             开硬门禁（**默认 off：AI 自主决定何时看图**）
 *   DSH_MC_AGENT_VIEW_MAX_ACTIONS=4       看一眼后最多连着做几个动作（默认 4，最小 1）
 *   DSH_MC_AGENT_VIEW_MAX_AGE_MS=60000    看一眼后的有效期毫秒（默认 60000；0 = 不按时间失效）
 *   DSH_MC_AGENT_VIEW_GATED=name1,name2   自定义要门禁的工具名（逗号分隔）
 *
 * 也可以不用环境变量：在**工作区**写 `.dsh-mc-agent/view.json`，例如
 *   {"gate":true,"maxActions":6,"maxAgeMs":120000}   打开/放宽硬门禁；{"gate":false} 关（**默认**）
 * 改完**立即生效**（下次判定时读），不用重启 DSH。环境变量管"默认值"，这个文件管"覆盖值"。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { encodePng } from '../src/png.mjs'
import { EXPRESS_DIR, OUT_DIR } from '../src/express.mjs'
import { withTimeout, CALL_MS, CALL_BUDGET_MS } from '../src/core.mjs'
import { VIEW_DEFAULTS, compassOf, isAirName, makePos, renderView } from './mc_view-render.mjs'
import { createSkinStore } from './mc_skin.mjs'
import { clamp } from './mc_util.mjs'

export const name = 'mc_view'

/** 动作类工具：会移动机器人或改变世界的。只读类（mc_status/mc_scan/mc_entities/mc_inventory…）不门禁。 */
const DEFAULT_GATED = [
  'mc_move', 'mc_act', 'mc_dig', 'mc_build', 'mc_give', 'mc_command', 'mc_sequence', 'mc_furnace', 'mc_chest',
]

/** ChatMessage / 字符串 → 纯文本（拿不到就给 null） */
function plainText (v) {
  if (v == null) return null
  if (typeof v === 'string') return v || null
  try {
    const s = String(v)
    return s && s !== '[object Object]' ? s : null
  } catch { return null }
}

/** 读一个方块（未加载 → null）；用于脚下/头上/正前方这种"精确点查"。
 *  注意：真实世界是 prismarine-world，`getBlock` 会调 `pos.floored()`，
 *  传纯 `{x,y,z}` 会抛异常 —— 那样这里会被 catch 成 null，把一切都误报成"未加载"。 */
const queryPos = makePos()
function blockAt (world, x, y, z) {
  try {
    queryPos.x = Math.floor(x)
    queryPos.y = Math.floor(y)
    queryPos.z = Math.floor(z)
    const b = world.getBlock(queryPos)
    return b ? b.name : null
  } catch { return null }
}

/** 把 "区块未加载" 和 "空气" 区分开写给人看 */
const showBlock = (n) => (n === null ? '未加载' : n)

export async function apply (api) {
  const { ctx, asTool, getSession, registry, logLine, workspaceOf, memoryFor } = api

  // 默认关：什么时候看一眼由 AI 自己判断（用户 2026-10-06「看第一视角改成让 ai 自主调用」）。
  // 只有显式写了 on/1/true/yes 才开硬门禁。
  const gateEnabled = /^(on|1|true|yes)$/i.test(String(process.env.DSH_MC_AGENT_VIEW_GATE ?? ''))
  // 看一眼之后：最多连着做 maxActions 个动作，且不超过 maxAgeMs 毫秒（0 = 不按时间失效）
  const numEnv = (key, dflt, min) => {
    const raw = process.env[key]
    if (raw == null || raw === '') return dflt
    const n = Number(raw)
    return Number.isFinite(n) ? Math.max(min, Math.floor(n)) : dflt
  }
  const maxActions = numEnv('DSH_MC_AGENT_VIEW_MAX_ACTIONS', 4, 1)
  const maxAgeMs = numEnv('DSH_MC_AGENT_VIEW_MAX_AGE_MS', 60_000, 0)
  const spanText = maxAgeMs > 0 ? ` / ${Math.round(maxAgeMs / 1000)} 秒` : ''
  const gated = new Set(
    (process.env.DSH_MC_AGENT_VIEW_GATED
      ? String(process.env.DSH_MC_AGENT_VIEW_GATED).split(',')
      : DEFAULT_GATED
    ).map((s) => s.trim()).filter(Boolean),
  )

  /** agentId → { at, used }：这张图是什么时候看的、已经用掉了几个动作 */
  const viewed = new Map()

  /** agentId → 工作区路径：guard 的 exec 万一拿不到 session（workspaceOf 返回 null），
   *  就用"上次看到过的那个工作区"去找调参文件。 */
  const wsOf = new Map()
  const wsFor = (agent) => {
    const id = String(agent?.id ?? '')
    const ws = workspaceOf(agent)
    if (ws) { wsOf.set(id, ws); return ws }
    return wsOf.get(id) ?? null
  }

  /** 工作区路径 → 记忆根绝对路径（宿主认 `config.memoryDir`，扩展必须跟着走）。
   *  拿不到（老宿主 / 自检）返回 null，调用方退回 `<工作区>/.dsh-mc-agent`。 */
  const memRootOf = (ws) => { try { return ws ? (memoryFor?.(ws)?.root ?? null) : null } catch { return null } }
  /** agent → 记忆根（拿不到就退回 `<工作区>/.dsh-mc-agent`） */
  const memRootFor = (agent) => {
    const ws = wsFor(agent)
    if (!ws) return null
    return memRootOf(ws) ?? resolve(ws, '.dsh-mc-agent')
  }

  /** 可选调参文件 `<记忆根>/view.json`（默认 `<工作区>/.dsh-mc-agent/view.json`）：
   *  {"gate":true,"maxActions":6,"maxAgeMs":120000} —— 有就覆盖环境变量/默认值（放宽、收紧、gate:false 关掉都行），
   *  这样 Master 或 AI 自己写个文件就能改尺度，**不用重启 DSH、也不用环境变量**。 */
  const gateFileCfg = (agent) => {
    try {
      const root = memRootFor(agent)
      if (!root) return null
      const p = resolve(root, 'view.json')
      if (!existsSync(p)) return null
      const j = JSON.parse(readFileSync(p, 'utf8'))
      return j && typeof j === 'object' && !Array.isArray(j) ? j : null
    } catch { return null }
  }

  /** 玩家皮肤仓库：拿真实皮肤贴图（缓存落 `<记忆根>/skins/`），拿不到就退回默认配色 */
  const mojangLookup = String(process.env.DSH_MC_AGENT_SKIN_MOJANG ?? '').toLowerCase() === 'on'
  const skinStore = createSkinStore({
    workspaceOf,
    memRootOf,
    logLine,
    // 🔴 这是**每个 HTTP 请求各自**的超时，不是整个皮肤阶段的总预算：`skinFor` → mojang 最多 2 次串行
    //    fetch，再皮肤 + 披风各 1 次（`http://` 还要先试一次 https）⇒ 单个玩家最坏 4~6 个 timeout。
    //    总预算由下面调用处那个 `withTimeout(…, callLeft() - 800)` 兜（2026-10-08 审计）。
    timeoutMs: clamp(Number(process.env.DSH_MC_AGENT_SKIN_TIMEOUT_MS) || 3_000, 500, 4_000),
    mojangLookup,
  })

  /* ─────────────────────── ① 工具 mc_view ─────────────────────── */

  ctx.tools.register(asTool({
    name: 'mc_view',
    description: '👁 **第一人称视角**：从我的眼睛（眼高 1.62）朝我正看着的方向渲染一张截图，'
      + '直接内联成图片给你看，并附一段文字摘要（准星命中什么方块、脚下是什么、'
      + '视野里各方块占比、**视野里有哪些玩家/怪物/掉落物、分别多远、在画面左边还是右边**、有没有区块没加载）。\n'
      + '图里能看出：草皮/木板/原木/树叶/矿石/砖缝/水波等方块纹理、体素阴影、太阳月亮云和昼夜、'
      + '**玩家（人形，带脸）· 怪物（敌对红/被动黄）· 掉落物**（都有黑描边）、右下角我手里拿着的东西。'
      + '玩家会按朝向转身，**有正版皮肤就贴真实皮肤**（含细臂/披风；离线号没皮肤就用默认 Steve 配色），'
      + '文字摘要里会写谁是什么颜色，对着图就能认人。\n'
      + (gateEnabled
        ? '🔴 **硬规则：动手之前必须先看一眼**。动作类工具（mc_move / mc_act / mc_dig / '
          + 'mc_build / mc_give / mc_command / mc_sequence）在**手上没有够新的第一人称图**时会被**直接拒绝执行**，'
          + `拒绝信息就是让你先调 mc_view。看一眼之后最多连着做 ${maxActions} 个动作${spanText}，`
          + '超了再看一次 —— 所以一轮里连着做几个动作没问题，别把它当"每调一次工具就得看一次"。\n'
          + '嫌紧/嫌烦可以改（**立即生效，不用重启**）：在工作区写 `.dsh-mc-agent/view.json`，'
          + '如 {"maxActions":8,"maxAgeMs":180000} 放宽，或 {"gate":false} 直接关掉门禁。\n'
        : '👁 **什么时候看，你自己定**（没有硬性门禁，不会被拦）：只读查询（mc_status / mc_inventory / '
          + 'mc_scan / mc_entities…）不用看；**要动手之前先看一眼**最划算 —— 挖/放/拆/建、要走过去、找路找东西、'
          + '想确认玩家或怪物在哪、看不清周围、刚被卡住。一张图够你连着做一段动作；'
          + '但环境变了（走远了、挖穿了、天黑了、挨打或被卡住）就再看一眼。宁可多看一眼，也别闭着眼睛乱挖乱放。\n')
      + (gateEnabled
        ? ''
        : '（想变回强制模式：写 `.dsh-mc-agent/view.json` 的 {"gate":true}，立即生效。）\n')
      + '图里的约定：白色十字=准星（中心那格就是我正对的方块）；暗紫色块=区块没加载（不是方块）；'
      + '越远越淡（雾，雾色跟着天色走）。参数可调 width/height（默认 192×108）、fov（默认 70°）、distance（默认 48）。\n'
      + `🔴 要让 **Master** 看到这张图：给 \`out:"\\.dsh-mc-agent/${EXPRESS_DIR}/<子目录>/view.png"\` 写进发布区，`
      + '再用 `mc_kit_express` 取那一行；默认落 `.dsh-mc-agent/' + OUT_DIR + '/`（不对外）。',
    parameters: {
      width: { type: 'number', description: '画面宽度像素（默认 192，32–480；越大越慢越费 token）' },
      height: { type: 'number', description: '画面高度像素（默认按 16:9 自动算，即 192×108，18–480）' },
      fov: { type: 'number', description: '垂直视野角度（默认 70，20–140；越小越"望远"）' },
      distance: { type: 'number', description: '看得多远，单位方块（默认 48，4–128；越大越慢）' },
      crosshair: { type: 'boolean', description: '是否画准星（默认 true）' },
      entities: { type: 'boolean', description: '是否画出玩家/怪物/掉落物（默认 true）' },
      out: { type: 'string', description: `落盘路径（工作区相对；默认 .dsh-mc-agent/${OUT_DIR}/mc-view-<时间>.png 不对外）` },
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (args, value) => {
        const blocks = [{ type: 'text', text: String(value?.text ?? JSON.stringify(value, null, 2)) }]
        // 图像以附件形式内联；纯文本模型由宿主自动降级成文本占位
        if (value?.image?.attachment) blocks.push({ type: 'image', attachment: value.image.attachment })
        return blocks
      },
    },
    timeoutMs: CALL_MS + 1_000,
    async execute (args, exec) {
      const sess = getSession(exec)
      const bot = sess.bot.requireBot() // 不在线会抛出带原因的错（幽灵在线也认得出）
      // 🔴 等区块也算进"这一轮 11 秒"（waitForChunks 自己也会看剩余时间）
      await withTimeout(sess.bot.waitForChunks(), CALL_MS, '等待区块加载')

      const e = bot.entity
      const width = clamp(Math.round(Number(args.width) || VIEW_DEFAULTS.width), 32, 480)
      const height = clamp(Math.round(Number(args.height) || Math.round((width * 9) / 16)), 18, 480)
      const fov = clamp(Number(args.fov) || VIEW_DEFAULTS.fov, 20, 140)
      const distance = clamp(Number(args.distance) || VIEW_DEFAULTS.distance, 4, 128)
      const crosshair = args.crosshair !== false
      const eyeHeight = Number(e.eyeHeight) || VIEW_DEFAULTS.eyeHeight
      const yaw = Number(e.yaw) || 0
      const pitch = Number(e.pitch) || 0
      const origin = [e.position.x, e.position.y + eyeHeight, e.position.z]
      const s = sess.bot.status()

      // 视野附近的实体（position 是脚底；跳过自己）
      const drawEntities = args.entities !== false
      const near = []
      let nearSkipped = 0
      if (drawEntities) {
        const selfId = e.id
        const raw = bot.entities ?? {}
        /* 🔴 2026-10-08 审计：判据要和渲染侧一致 —— 渲染是按"眼睛到实体盒中心的三维距离"
         *    (`mc_view-render.mjs` `dc > distance + 4`)，这里原来只看水平距离 ⇒ 正上/正下方
         *    几十格的实体算进"附近 N 个"却被渲染丢掉（文案与实际不符）。 */
        const reach = distance + 4
        for (const key of Object.keys(raw)) {
          const ent = raw[key]
          if (!ent || !ent.position) continue
          if (selfId != null && ent.id === selfId) continue
          const ex = ent.position.x
          const ey = ent.position.y
          const ez = ent.position.z
          const cy = ey + (Number(ent.height) || 1.8) / 2
          if (Math.hypot(ex - origin[0], cy - origin[1], ez - origin[2]) > reach) continue
          near.push({
            id: ent.id, x: ex, y: ey, z: ez,
            width: ent.width, height: ent.height,
            name: ent.name, username: ent.username, displayName: plainText(ent.displayName),
            kind: ent.kind, type: ent.type,
            yaw: ent.yaw,
            dist: Math.hypot(ex - e.position.x, ey - origin[1], ez - e.position.z),
            // 真皮肤：服务端在 player_info 里给了 textures 才有
            skinData: ent.username ? (bot.players?.[ent.username]?.skinData ?? null) : null,
          })
        }
        near.sort((a, b) => a.dist - b.dist)
        // 渲染侧只画最近的 96 个（`mc_view-render.mjs` 的 `list.slice(0, 96)`）——
        // 这里也砍到 96，免得文字说"附近 120 个"而图上只有 96 个。
        if (near.length > 96) { nearSkipped = near.length - 96; near.length = 96 }
      }

      // 拉最近的几个玩家的真皮肤（有磁盘+内存缓存，正常情况下 0 延迟）
      const skins = {}
      if (drawEntities && near.length) {
        const budget = clamp(Number(process.env.DSH_MC_AGENT_SKIN_MAX) || 4, 1, 12)
        const cands = near
          .filter((n) => n.username && (n.skinData?.url || mojangLookup))
          .slice(0, budget)
        if (cands.length) {
          const wsRoot = wsFor(exec?.agent)
          // 🔴 2026-10-08 审计：皮肤阶段**必须共享**这一轮 11 秒预算 —— 以前没有任何总预算，
          //    `waitForChunks` 用光时间之后这里照样再跑 10~20 秒，AI 拿到的是"超时错误"而不是画面。
          //    到点就退回默认配色（少几个真皮肤，总比拿不到图强）。
          const skinBudget = Math.max(300, Math.min(CALL_BUDGET_MS, (sess.bot.callLeft?.() ?? CALL_BUDGET_MS) - 800))
          const grab = Promise.all(cands.map(async (n) => {
            try { return [n.username, await skinStore.skinFor(n.username, n.skinData, wsRoot)] } catch { return [n.username, null] }
          }))
          let got = []
          try { got = await withTimeout(grab, skinBudget, '抓玩家皮肤') } catch { got = [] }
          for (const [uname, sk] of got) if (sk) skins[uname] = sk
        }
      }

      const t0 = Date.now()
      const frame = renderView({
        world: bot.world, origin, yaw, pitch, width, height, fov, distance, crosshair,
        entities: near, time: s.time, dimension: s.dimension, held: s.held, skins,
      })
      const renderMs = Date.now() - t0
      const png = encodePng(width, height, frame.rgba)
      const total = frame.stats.pixels || 1
      const pct = (n) => Math.round((n / total) * 100)
      const cross = frame.center
      const fx = Math.floor(origin[0])
      const fy = Math.floor(e.position.y)
      const fz = Math.floor(origin[2])
      // 水平朝向的整数步（拿"正前方一格"用）
      const sx = -Math.sin(yaw)
      const sz = -Math.cos(yaw)
      const stepX = Math.abs(sx) > Math.abs(sz) ? Math.sign(sx) : 0
      const stepZ = stepX === 0 ? Math.sign(sz) : 0

      const out = {
        position: s.position ?? { x: fx, y: fy, z: fz },
        facing: compassOf(yaw),
        yawDeg: Math.round((yaw * 180) / Math.PI * 10) / 10,
        pitchDeg: Math.round((pitch * 180) / Math.PI * 10) / 10,
        dimension: s.dimension ?? null,
        timeOfDay: s.time ?? null,
        health: s.health ?? null,
        food: s.food ?? null,
        gamemode: s.gamemode ?? null,
        held: s.held ?? null,
        crosshair: cross === null
          ? { block: null, note: '准星方向到 ' + distance + ' 格都没有方块（天空）' }
          : cross.unknown
            ? { block: null, note: '准星方向撞到未加载区块' }
            : { block: cross.name, distance: Math.round(cross.dist * 10) / 10, face: ['东西面', '顶/底面', '南北面'][cross.axis] ?? null },
        surroundings: {
          underFeet: showBlock(blockAt(bot.world, fx, fy - 1, fz)),
          feetBlock: showBlock(blockAt(bot.world, fx, fy, fz)),
          headBlock: showBlock(blockAt(bot.world, fx, fy + 1, fz)),
          ahead: showBlock(blockAt(bot.world, fx + stepX, fy, fz + stepZ)),
          /* 🔴 只看 `e.isInWater` 会漏：泡在水柱里它读出来是 undefined（实机 (-31,59,261) 脚/头
           *    两格都是 water 却报"没在水里"）⇒ 再看脚/头那两格的方块名。 */
          inWater: Boolean(e.isInWater) || /water|lava/.test(String(blockAt(bot.world, fx, fy, fz)?.name ?? '')) || /water|lava/.test(String(blockAt(bot.world, fx, fy + 1, fz)?.name ?? '')),
        },
        entities: frame.stats.entities,
        crosshairEntity: frame.stats.crosshairEntity,
        image: {
          width, height, bytes: png.length,
          renderMs,
          hitPct: pct(frame.stats.hit),
          skyPct: pct(frame.stats.sky),
          unloadedPct: pct(frame.stats.unknown),
          topBlocks: frame.stats.top.map((t) => `${t.name} ${pct(t.pixels)}%`),
        },
      }

      // ① 内联给模型 / 前端看
      const att = ctx.get('attachments')
      if (att && typeof att.saveImage === 'function') {
        try {
          out.image.attachment = await att.saveImage({
            data: new Uint8Array(png), mediaType: 'image/png', name: 'mc-view.png',
          })
        } catch (err) { out.image.attachmentError = err.message }
      } else {
        out.image.attachmentError = '宿主没有 attachments 服务'
      }

      // ② 落盘（默认 `<记忆根>/.out/`，不对外；给 out 就写指定路径）
      try {
        const wsRoot = wsFor(exec?.agent)
        if (!wsRoot) {
          out.image.fileError = '拿不到工作区路径（agent.session.header.cwd 为空）'
        } else {
          const rel = args.out ? String(args.out) : `.dsh-mc-agent/${OUT_DIR}/mc-view-${Date.now()}.png`
          // `.dsh-mc-agent/...` 是"记忆根相对"的老写法：记忆根可能已经被 Master 挪出工作区
          // （`config.memoryDir`），所以剥掉前缀挂到记忆根上；其余相对路径仍按工作区解析，
          // 绝对路径原样用。这样默认出图会跟着记忆根走，express 发布区（`<记忆根>/.express/`）才对得上。
          const memPrefix = /^\.dsh-mc-agent[\\/]/i
          const abs = /^([A-Za-z]:[\\/]|[\\/])/.test(rel)
          const file = abs
            ? rel
            : memPrefix.test(rel)
              ? resolve(memRootFor(exec?.agent) ?? wsRoot, rel.replace(memPrefix, ''))
              : resolve(wsRoot, rel)
          mkdirSync(dirname(file), { recursive: true })
          writeFileSync(file, png)
          out.image.file = rel
          out.image.hint = `要让用户看到这张图：写到发布区（out:".dsh-mc-agent/${EXPRESS_DIR}/<子目录>/view.png"），`
            + '再用 mc_kit_express 取那一行。默认输出（.out/）不对外。'
        }
      } catch (err) { out.image.fileError = err.message }

      // ③ 摘要文本（模型先读这段，再决定要不要看图里细节）
      const lines = [
        `👁 第一人称 ${width}×${height} · 位置 (${out.position.x}, ${out.position.y}, ${out.position.z})`
          + ` · 朝向 ${out.facing} yaw=${out.yawDeg}° pitch=${out.pitchDeg}°`
          + (out.dimension ? ` · 维度 ${out.dimension}` : '')
          + (out.timeOfDay != null ? ` · 时间 ${out.timeOfDay}` : ''),
        `🎯 准星：${cross === null ? '天空（' + distance + ' 格内没方块）' : cross.unknown ? '未加载区块' : `${cross.name} · ${Math.round(cross.dist * 10) / 10} 格`}`
          + (out.crosshairEntity ? ` · **准星正对着 ${out.crosshairEntity.name}（${out.crosshairEntity.distance} 格）**` : '')
          + ` · 脚下 ${out.surroundings.underFeet} · 脚内 ${out.surroundings.feetBlock} · 头上一格 ${out.surroundings.headBlock}`
          + ` · 正前方一格 ${out.surroundings.ahead}`,
        `🧱 画面：命中 ${out.image.hitPct}% · 天空 ${out.image.skyPct}% · 未加载 ${out.image.unloadedPct}%`
          + (out.image.topBlocks.length ? ` · 视野里：${out.image.topBlocks.slice(0, 5).join(' · ')}` : ''),
      ]
      const visEnts = frame.stats.entities.filter((x) => x.pixels > 0)
      const dirOf = (x) => (x == null ? '画面外' : x < 34 ? '左侧' : x > 66 ? '右侧' : '中间')
      const lookOf = (x) => (x.skin
        ? `真实皮肤${x.skin.slim ? '（细臂）' : ''}${x.skin.cape ? '+披风' : ''}`
        : `图里是 ${x.color}`)
      lines.push(visEnts.length
        ? '👥 视野里 ' + visEnts.length + ' 个实体：' + visEnts.map((x) =>
          `${x.name}（${x.label}${x.hostile ? '·敌对' : ''}·${lookOf(x)}）${x.distance} 格 ${dirOf(x.screen.xPct)}`
          + (x.underCrosshair ? '·准星正对' : '')).join(' · ')
        : (near.length
            ? `👥 视野里看不到实体（附近 ${near.length} 个被方块挡住或在画面外${nearSkipped ? `，另有 ${nearSkipped} 个更远的没画` : ''}）`
            : '👥 视野里没有实体（附近没人、没怪、没掉落物）'))
      if (out.health != null) {
        lines.push(`❤ 血量 ${out.health} · 饱食 ${out.food} · 模式 ${out.gamemode ?? '?'} · 手持 ${out.held ?? '空手'}`
          + (out.surroundings.inWater ? ' · 泡在水里' : ''))
      }
      if (out.image.unloadedPct > 25) {
        lines.push('⚠️ 未加载像素偏多：区块可能还没加载完，可以稍等再 mc_view 一次。')
      }
      if (out.image.file) lines.push(`💾 已落盘 ${out.image.file}（渲染 ${renderMs}ms）`)
      if (out.image.attachmentError) lines.push(`⚠️ 内联图片失败：${out.image.attachmentError}`)
      out.text = lines.join('\n')

      // ④ 记下"本会话刚看过图"，放行接下来的动作（最多 maxActions 个 / maxAgeMs 毫秒）
      const agentId = exec?.agent?.id
      if (agentId) viewed.set(String(agentId), { at: Date.now(), used: 0 })
      return out
    },
  }))

  /* ───────── ② 可选硬门禁：动手前必须先看图（**默认关**，AI 自主决定何时看） ───────── */

  try {
    /** 判定"这张图还能不能用"：够新 + 额度没用完 */
    const judge = (rec, ma, mg) => {
      if (rec && rec.used < ma && (mg <= 0 || Date.now() - rec.at <= mg)) return { ok: true }
      const stale = rec && mg > 0 ? Date.now() - rec.at : 0
      return {
        ok: false,
        why: !rec
          ? '本会话还没看过第一人称图'
          : (rec.used >= ma
              ? `上一张图已经连着做了 ${rec.used} 个动作`
              : `上一张图已经过了 ${Math.round(stale / 1000)} 秒`),
      }
    }
    const denyText = (tool, ma, mg, why) =>
      `🔴 动手前先看一眼：调用 mc_view 看第一人称视角截图，然后立刻执行 ${tool}。`
      + `（规则：看一眼最多连着做 ${ma} 个动作${mg > 0 ? ` / ${Math.round(mg / 1000)} 秒` : ''}，之后要再看一次 —— ${why}。）`

    // 门禁**总是注册**，生效与否每次判定时现算 —— 这样 view.json 里的 {"gate":true}
    // 能当场把强制模式打开，不用重启 DSH（只按默认值决定注不注册的话就做不到）。
    ctx.tools.guard((exec) => {
      const tool = String(exec?.name ?? '')
      if (!gated.has(tool)) return undefined
      const agent = exec?.agent
      if (!agent) return undefined
      // peek 而不是 getOrCreate：没会话/没连上就不拦，交给工具自己报「不在线」
      const sess = registry.peek(String(agent.id))
      if (!sess?.bot?.online) return undefined

      let on = gateEnabled
      let ma = maxActions
      let mg = maxAgeMs
      // 可选的调参文件：每次判定都读（文件很小、判定的都是动作类工具，代价可忽略），
      // 这样 Master / AI 写个文件就能开关和改尺度 —— 改完立即生效。
      const cfg = gateFileCfg(agent)
      if (cfg) {
        if (cfg.gate === true || cfg.gate === 'on') on = true
        else if (cfg.gate === false || cfg.gate === 'off') on = false
        const na = Number(cfg.maxActions)
        const ng = Number(cfg.maxAgeMs)
        if (Number.isFinite(na)) ma = Math.max(1, Math.floor(na))
        if (Number.isFinite(ng)) mg = Math.max(0, Math.floor(ng))
      }
      if (!on) return undefined // 默认：不拦，AI 自己决定何时看图

      const rec = viewed.get(String(agent.id))
      const v = judge(rec, ma, mg)
      if (v.ok) return undefined
      logLine(`mc_view 门禁：拒绝 ${tool}（${v.why}）`)
      return denyText(tool, ma, mg, v.why)
    })
    // 动作执行完就把这张图"用掉"一格：用满 maxActions 个（或超时）就得重新看
    // （门禁关着时这些计数没人看，留着不碍事）
    ctx.on('tools/post-execute', async (exec, result, next) => {
      if (gated.has(String(exec?.name ?? ''))) {
        const rec = viewed.get(String(exec?.agent?.id ?? ''))
        // 没真正执行成功的（被指令白名单挡了、服务端拒绝等）不算用掉一格
        const failed = result?.isError === true || result?.message?.isError === true
          || result?.error != null || result?.ok === false
        if (rec && !failed) rec.used += 1
      }
      return next()
    })
    logLine(gateEnabled
      ? `mc_view 已加载：工具 mc_view + 动作前看图门禁（${[...gated].join('/')}；看一眼可做 ${maxActions} 个动作${spanText}）`
      : 'mc_view 已加载：工具 mc_view（默认模式 —— AI 自主决定何时看图，动作前看图门禁未启用；想强制就把 .dsh-mc-agent/view.json 写成 {"gate":true}）')
  } catch (err) {
    logLine(`mc_view 门禁注册失败（工具仍可用）：${err?.message ?? err}`)
  }
}
