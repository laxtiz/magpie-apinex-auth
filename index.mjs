import { mkdirSync } from "node:fs"

const PROVIDER = "apinex"
const SITE = "https://apinex.bond"
const API = "https://api.apinex.bond"
const BASE = `${API}/v1`
const CLIENT_ID = "apinex-cli"
const VERSION = "0.1.0"
const SRC = "magpie-apinex"

const UA = `APInex-Magpie/${VERSION}`

/** CLI 头：设备码与 token 接口按 src 头区分来源，缺了会被当成未知客户端。 */
const cliHeaders = {
  "user-agent": UA,
  src: SRC,
  "x-apinex-src": SRC,
}

/** 拿不到 /api/public/models 时使用的内置目录，按 APInex 公开模型表整理。 */
const FALLBACK_MODELS = {
  "free/glm-5.3-flash": { name: "GLM-5.3 Flash", cost: { input: 0, output: 0 }, free: true, rate: 3 },
  "free/deepseek-v4.1-flash": { name: "Deepseek V4.1 Flash", cost: { input: 0, output: 0 }, free: true, rate: 3 },
  "free/kimi-k3": { name: "Kimi K3", cost: { input: 0, output: 0 }, free: true, rate: 3 },
  "free/qwen-3.8-max": { name: "Qwen 3.8 MAX", cost: { input: 0, output: 0 }, free: true, rate: 3 },
  "free/gemini-3.8-flash": { name: "Gemini 3.8 Flash", cost: { input: 0, output: 0 }, free: true, rate: 3 },
  "free/claude-sonnet-4.6": { name: "Claude 4.6 Sonnet", cost: { input: 0, output: 0 }, free: true, rate: 3 },
  "free/claude-opus-4.6": { name: "Claude 4.6 Opus", cost: { input: 0, output: 0 }, free: true, rate: 3 },
  "free/minimax-m3": { name: "MiniMax M3", cost: { input: 0, output: 0 }, free: true, rate: 2 },
  "free/mimo-v2.6-pro": { name: "Mimo V2.6 Pro", cost: { input: 0, output: 0 }, free: true, rate: 2 },
  "free/jev-1.13": { name: "Jev 1.13", cost: { input: 0, output: 0 }, free: true, rate: 2, decides: true },
  "claude-sonnet-5.5": { name: "Claude Sonnet 5.5 [paid]", cost: { input: 0.4, output: 0.4 } },
  "claude-opus-5.5": { name: "Claude Opus 5.5 [paid]", cost: { input: 0.5, output: 0.5 } },
  "gpt-6.1-sol": { name: "GPT 6.1 Sol [paid]", cost: { input: 0.3, output: 0.3 } },
  "gpt-6.1-terra": { name: "GPT 6.1 Terra [paid]", cost: { input: 0.17, output: 0.17 } },
  "gemini-3.1-pro": { name: "Gemini 3.1 Pro [paid]", cost: { input: 0.15, output: 0.15 } },
  "gemini-4-argon": { name: "Gemini 4 Argon [paid]", cost: { input: 0.6, output: 0.6 } },
  "grok-4.7": { name: "Grok 4.7 [paid]", cost: { input: 0.3, output: 0.3 } },
  "deepseek-v4-pro": { name: "Deepseek V4 Pro [paid]", cost: { input: 0.07, output: 0.07 } },
  "kimi-k3.1-pro": { name: "Kimi K3.1 Pro [paid]", cost: { input: 0.3, output: 0.4 } },
  "glm-5.3": { name: "GLM 5.3 [paid]", cost: { input: 0.15, output: 0.15 } },
}

function parseContextWindow(raw) {
  if (typeof raw === "number") return raw
  if (typeof raw !== "string") return 128000
  const m = /^([\d.]+)\s*([KM])?/i.exec(raw.trim())
  if (!m) return 128000
  const n = Number(m[1])
  const unit = (m[2] ?? "").toUpperCase()
  return Math.round(unit === "M" ? n * 1_000_000 : unit === "K" ? n * 1000 : n)
}

function modelFromApi(m) {
  const paid = !m.id.startsWith("free/")
  // 厂商给 Jev Group 打 `decision` 标签：它们走 TypeSafe 决策协议，不产出文本，
  // 标 `decides` 后 magpie 把它们当路由分类器并对 agent 隐藏。
  const decision = (m.tags ?? []).includes("decision")
  return {
    // 免费模型靠 `free` 徽标区分；付费模型加 [paid] 后缀，避免与同名免费版混淆。
    name: paid ? `${m.name || m.id} [paid]` : m.name || m.id,
    limit: { context: parseContextWindow(m.contextWindow), output: decision ? 1 : 32000 },
    reasoning: /thinking|reasoning|pro|opus|sol|max/i.test(m.id) && paid,
    tool_call: m.supportsTools !== false,
    modalities: { input: m.supportsVision === false ? ["text"] : ["text", "image"] },
    cost: { input: m.dollarsPer1M ?? 0, output: m.outputDollarsPer1M ?? 0 },
    free: !paid,
    // 厂商的 weight 是免费额度的计费倍率（(输入+输出) × weight），magpie 的 rate 正好展示它。
    ...(m.weight ? { rate: m.weight } : {}),
    ...(decision ? { decides: true } : {}),
    api: { id: m.id },
  }
}

async function withTimeout(promise, ms) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("timeout")), ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** 把 APInex 的 access 结构翻成 magpie 的 usage 窗口。 */
function accessWindow(access) {
  if (!access) return []
  if (access.unlimited) {
    return [{ name: "Free tokens", used: 0, display: "unlimited", aside: true }]
  }
  const used = Number(access.used ?? 0)
  const limit = Number(access.limit ?? 0)
  if (!limit) return []
  return [
    {
      name: access.planLabel || "Free tokens",
      used: Math.round((used / limit) * 1000) / 10,
      resetsAt: access.resetsAt ?? undefined,
      display: `${used.toLocaleString("en-US")} / ${limit.toLocaleString("en-US")} tokens`,
      amount: used,
      limit,
      unit: "tokens",
    },
  ]
}

function signInError(message) {
  return Object.assign(new Error(message), { signIn: "expired" })
}

export const APInexPlugin = async ({ client, directory, magpie } = {}) => {
  // directory 是 magpie 的配置目录；签到 cookie 与浏览器 profile 都存在它的 apinex 子目录里。
  const stateDir = directory ? `${directory}/apinex` : "./apinex-state"
  try {
    mkdirSync(stateDir, { recursive: true })
  } catch {}

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: "APInex",
        npm: "@ai-sdk/openai-compatible",
        api: BASE,
        // 让 per-model 的 decides 生效：没有它，所有模型都会被当聊天模型。
        decide: true,
        models: FALLBACK_MODELS,
      }
    },

    provider: {
      id: PROVIDER,
      async models(provider) {
        const list = { ...provider.models }
        try {
          const r = await withTimeout(
            fetch(`${API}/api/public/models`, { headers: { "user-agent": UA, accept: "application/json" } }),
            8000,
          )
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          const data = await r.json()
          if (!Array.isArray(data?.models) || data.models.length === 0) throw new Error("empty")
          const onlyFree = magpie?.option?.(PROVIDER, "only_free_models") === true
          for (const m of data.models) {
            if (m.health && m.health !== "live") continue
            if (onlyFree && !m.id.startsWith("free/")) continue
            list[m.id] = modelFromApi(m)
          }
          // list 是在内置兜底目录上合并出来的，付费兜底项也要一并清掉。
          if (onlyFree) {
            for (const id of Object.keys(list)) {
              if (!id.startsWith("free/")) delete list[id]
            }
          }
          return list
        } catch {
          // 厂商目录拿不到时保留原列表，magpie 会照旧沿用上一份。
          return list
        }
      },
    },

    auth: {
      provider: PROVIDER,
      refreshLead: 5 * 60 * 1000,
      maxConcurrency: 4,

      options: [
        {
          key: "only_free_models",
          label: "Only show free models",
          description:
            "关闭（默认）：列出全部模型。开启：只保留 free/* 模型——它们走每日免费额度，$0 钱包不会被扣。",
          default: false,
        },
      ],

      methods: [
        {
          type: "oauth",
          label: "Sign in with APInex (browser)",
          async authorize() {
            const started = await postJson(`${API}/api/cli/oauth/device`, { client_id: CLIENT_ID })
            if (!started?.device_code) {
              return { type: "failed", error: "APInex 未返回设备码" }
            }
            return {
              url: started.verification_uri_complete || started.verification_uri || `${SITE}/cli/device`,
              instructions: `在页面确认后回到这里；终端码 ${started.user_code}`,
              method: "auto",
              async callback() {
                const deadline = Date.now() + Number(started.expires_in ?? 900) * 1000
                let waitSec = Number(started.interval ?? 5)
                while (Date.now() < deadline) {
                  await sleep(waitSec * 1000)
                  try {
                    const t = await postJson(`${API}/api/cli/oauth/token`, {
                      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                      client_id: CLIENT_ID,
                      device_code: started.device_code,
                    })
                    return {
                      type: "success",
                      access: t.access_token,
                      refresh: t.refresh_token,
                      expires: Date.now() + Number(t.expires_in ?? 3600) * 1000,
                      // 用邮箱命名账号比内部 user id 更好认；uid 仍是厂商稳定 id，用于识别同一账号。
                      accountId: t.account?.user?.email,
                      email: t.account?.user?.email,
                      uid: t.account?.user?.id,
                    }
                  } catch (e) {
                    if (e.code === "authorization_pending") continue
                    if (e.code === "slow_down") { waitSec += 5; continue }
                    return { type: "failed", error: e.message || "设备码登录失败" }
                  }
                }
                return { type: "failed", error: "设备码已过期，请重新登录" }
              },
            }
          },
        },
        {
          type: "api",
          label: "APInex API key",
          placeholder: "sk-apx…",
          async authorize(inputs) {
            const key = String(inputs?.key ?? "").trim()
            if (!key) return { type: "failed", error: "请输入 API key" }
            const r = await fetch(`${BASE}/models`, {
              headers: { authorization: `Bearer ${key}`, "user-agent": UA },
            }).catch(() => null)
            if (!r) return { type: "failed", error: "无法连接 APInex" }
            if (r.status === 401 || r.status === 403) return { type: "failed", error: "API key 被拒绝" }
            if (!r.ok) return { type: "failed", error: `APInex 返回 ${r.status}` }
            return { type: "success", key }
          },
        },
      ],

      async refresh(auth) {
        if (!auth?.refresh) return {}
        try {
          const t = await postJson(`${API}/api/cli/oauth/token`, {
            grant_type: "refresh_token",
            client_id: CLIENT_ID,
            refresh_token: auth.refresh,
          })
          return {
            access: t.access_token,
            refresh: t.refresh_token ?? auth.refresh,
            expires: Date.now() + Number(t.expires_in ?? 3600) * 1000,
          }
        } catch (e) {
          if (e.code === "invalid_grant" || e.code === "unauthorized_client") {
            throw signInError("APInex 拒绝了登录，请重新登录")
          }
          throw e
        }
      },

      async loader(getAuth) {
        const auth = await getAuth()
        if (!auth || (auth.type !== "oauth" && auth.type !== "api")) return {}

        const token = auth.type === "api" ? auth.key : auth.access

        return {
          baseURL: BASE,
          async fetch(input, init) {
            const headers = new Headers(init?.headers)
            headers.set("authorization", `Bearer ${token}`)
            headers.set("x-apinex-client", `magpie/${VERSION}`)
            // magpie 把决策请求发到 {baseURL}/systemone；APInex 用同样的
            // TypeSafe 格式（state + questions）服务在 /v1/decisions 上。
            const url = typeof input === "string" ? input : input.url
            const target = url.endsWith("/systemone") ? url.replace(/\/systemone$/, "/decisions") : url
            const res = await fetch(target, { ...init, headers })
            if (res.status !== 401) return res
            // 厂商用 401 表示登录失效；加这个头 magpie 才会把账号标成需要重新登录。
            const marked = new Headers(res.headers)
            marked.set("X-Magpie-Sign-In", "expired")
            return new Response(res.body, { status: res.status, statusText: res.statusText, headers: marked })
          },
        }
      },

      async usage(getAuth) {
        const auth = await getAuth()
        if (auth?.type === "api") return apiKeyUsage(auth)
        if (auth?.type !== "oauth") return { user: auth?.email }
        const r = await fetch(`${API}/api/cli/account`, {
          headers: { ...cliHeaders, authorization: `Bearer ${auth.access}`, accept: "application/json" },
        }).catch(() => null)
        if (!r) return { user: auth.email, error: "无法连接 APInex" }
        if (r.status === 401) {
          return { user: auth.email, error: "登录已失效，请重新登录", signIn: "expired" }
        }
        if (!r.ok) return { user: auth.email, error: `APInex 返回 ${r.status}` }
        const data = await r.json().catch(() => null)
        const account = data?.account
        if (!account) return { user: auth.email, error: "APInex 未返回账号信息" }
        const access = account.access
        const windows = accessWindow(access)
        return {
          plan: access?.planLabel || access?.mode || "Free",
          user: account.user?.email ?? auth.email,
          balance: typeof account.balanceUsd === "number" ? `$${account.balanceUsd.toFixed(2)}` : undefined,
          error: access?.allowed === false && access?.checkedInToday === false ? "今日签到后才能用免费模型" : "",
          windows,
        }
      },

      async checkin() {
        const { browserCheckin } = await import("./browser-checkin.mjs")
        return browserCheckin({
          stateDir,
          browserPath: process.env.APINEX_BROWSER,
          headed: process.env.APINEX_CHECKIN_HEADED === "1",
          onNotice: (msg) => {
            try { client?.app?.log?.({ body: { service: "apinex", level: "info", message: msg } }) } catch {}
          },
        })
      },
    },

    "chat.headers": async (input, output) => {
      if (input.model?.providerID === PROVIDER && input.sessionID) {
        output.headers["x-apinex-session"] = input.sessionID
      }
    },
  }
}

/** CLI 设备码接口要求 src 头；这里统一收口并保留 OAuth 的错误码。 */
async function postJson(url, body) {
  const res = await withTimeout(
    fetch(url, {
      method: "POST",
      headers: { ...cliHeaders, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ ...body, src: SRC }),
    }),
    15000,
  )
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error_description || data.error || `HTTP ${res.status}`)
    err.code = data.error
    throw err
  }
  return data
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * API key 登录没有 /api/cli/account 的 OAuth 态，改读公开的余额与订阅接口：
 * /v1/balance 是 USD 钱包（balance_usd 已扣除在途预扣），/v1/subscription 是
 * 免费额度（resets_at_utc 是每日重置，expires_at_utc 是欢迎金/订阅到期）。
 * 免费额度只作用于 free/* 模型，付费模型走钱包，所以窗口用 model: "free/" 限定。
 */
async function apiKeyUsage(auth) {
  const headers = { authorization: `Bearer ${auth.key}`, accept: "application/json" }
  const get = async (path) => {
    try {
      const r = await withTimeout(fetch(`${BASE}${path}`, { headers }), 15000)
      if (r.status === 401 || r.status === 403) throw signInError("API key 被拒绝，请重新登录")
      if (!r.ok) return { error: `APInex 返回 ${r.status}` }
      return { body: await r.json() }
    } catch (e) {
      if (e.signIn) throw e
      return { error: `无法连接 APInex: ${e}` }
    }
  }
  const [bal, sub] = await Promise.all([get("/balance"), get("/subscription")])
  const windows = []
  if (sub.body) {
    const s = sub.body
    const daily = Boolean(s.resets_at_utc)
    const unlimited = Boolean(s.unlimited)
    const fmt = (n) => (n ?? 0).toLocaleString("en-US")
    const window = {
      name: s.plan_label || (daily ? "Daily free allowance" : "Free tokens"),
      unit: "tokens",
      model: "free/",
      resetsAt: s.resets_at_utc || s.expires_at_utc || undefined,
      span: daily
        ? 86400
        : s.expires_at_utc
          ? Math.max(60, Math.round((Date.parse(s.expires_at_utc) - Date.now()) / 1000))
          : undefined,
      display: unlimited
        ? "unlimited"
        : `${fmt(s.tokens_used)} / ${fmt(s.token_limit)} tokens${s.allowed === false ? " · exhausted" : ""}`,
    }
    // amount + limit，不传百分比：magpie 会按它们推算用量。
    if (!unlimited && s.token_limit > 0 && s.tokens_used != null) {
      window.amount = s.tokens_used
      window.limit = s.token_limit
    }
    windows.push(window)
  }
  const errors = [bal.error, sub.error].filter(Boolean)
  if (errors.length && !windows.length) return { error: errors.join("; "), windows: [] }
  return {
    plan: sub.body?.plan_label || sub.body?.plan || "Free",
    until: sub.body?.expires_at_utc || undefined,
    renew: "off", // APInex 的套餐和充值都不自动续费
    balance: typeof bal.body?.balance_usd === "number" ? `$${bal.body.balance_usd.toFixed(2)}` : undefined,
    windows,
  }
}

export default APInexPlugin