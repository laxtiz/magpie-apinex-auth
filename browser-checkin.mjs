// APInex 每日签到：签到接口要求 Turnstile token，只能在真实浏览器里拿到。
// 因此这里用 CDP 驱动本地 Edge/Chrome：
//   1) 首次运行：打开窗口，用户在窗口里 Google 登录一次，随后自动签到并保存 session cookie；
//   2) 之后每次运行：用全新临时 profile + 注入已保存的 cookie，不依赖上一次的 profile 锁。

import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { spawn } from "node:child_process"
import { resolve } from "node:path"
import { homedir } from "node:os"
import { randomBytes } from "node:crypto"

const SITE = "https://apinex.bond"
const COOKIE_NAME = "apinex_user_session"
const COOKIE_DOMAIN = ".apinex.bond"
const TURNSTILE_JS = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function browserCandidates() {
  const home = homedir()
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || resolve(home, "AppData", "Local")
    const pf = process.env.ProgramFiles || "C:\\Program Files"
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)"
    return [
      resolve(pf, "Google/Chrome/Application/chrome.exe"),
      resolve(pf86, "Google/Chrome/Application/chrome.exe"),
      resolve(local, "Google/Chrome/Application/chrome.exe"),
      resolve(pf86, "Microsoft/Edge/Application/msedge.exe"),
      resolve(pf, "Microsoft/Edge/Application/msedge.exe"),
      resolve(local, "Microsoft/Edge/Application/msedge.exe"),
    ]
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
  ]
}

export function findBrowser(explicit) {
  if (explicit) return explicit
  return browserCandidates().find((p) => existsSync(p))
}

class Cdp {
  #ws
  #id = 0
  #pending = new Map()

  static async attach(wsUrl, timeoutMs = 20000) {
    const c = new Cdp()
    c.#ws = new WebSocket(wsUrl)
    await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`CDP 连接超时 (${wsUrl})`)), timeoutMs)
      c.#ws.onopen = () => { clearTimeout(timer); res() }
      c.#ws.onerror = () => { clearTimeout(timer); rej(new Error(`CDP 连接失败 (${wsUrl})`)) }
    })
    c.#ws.onmessage = (e) => {
      let m
      try { m = JSON.parse(typeof e.data === "string" ? e.data : "") } catch { return }
      const p = m.id && c.#pending.get(m.id)
      if (!p) return
      c.#pending.delete(m.id)
      m.error ? p.rej(new Error(m.error.message || JSON.stringify(m.error))) : p.res(m.result)
    }
    return c
  }

  send(method, params = {}, timeoutMs = 60000) {
    const id = ++this.#id
    return new Promise((res, rej) => {
      this.#pending.set(id, { res, rej })
      this.#ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.#pending.delete(id)) rej(new Error(`CDP ${method} 超时`))
      }, timeoutMs)
    })
  }

  async evaluate(expression, timeoutMs = 60000) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, timeoutMs)
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "脚本执行失败")
    }
    return r.result?.value
  }

  close() {
    try { this.#ws.close() } catch {}
  }
}

/** Chrome/Edge 会派生子进程，直接 kill 根进程在 Windows 上常常留下锁；按 profile 目录定向清理。 */
async function stopBrowser(child, profileDir) {
  try { child?.kill() } catch {}
  if (process.platform !== "win32") return
  const { spawnSync } = await import("node:child_process")
  const escaped = profileDir.replace(/'/g, "''")
  spawnSync("powershell", [
    "-NoProfile",
    "-Command",
    `Get-CimInstance Win32_Process -Filter "Name='chrome.exe' or Name='msedge.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*${escaped}*' } | ` +
      `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
  ], { stdio: "ignore", windowsHide: true })
}

async function launch(exe, profileDir, offscreen) {
  // 浏览器按自己进程的 cwd 解释相对路径，必须给绝对路径。
  const dir = resolve(profileDir)
  mkdirSync(dir, { recursive: true })
  const portFile = resolve(dir, "DevToolsActivePort")
  try { rmSync(portFile, { force: true }) } catch {}

  const args = [
    `--user-data-dir=${dir}`,
    "--remote-debugging-port=0",
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    "--disable-background-networking",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-sync",
    "--no-service-autorun",
    "--disable-component-update",
    "--window-size=1100,860",
    // Cloudflare Turnstile 在真无头模式下不给 token，所以非登录场景改成「有窗口但移出可视区」。
    ...(offscreen ? ["--window-position=-2400,-2400", "--mute-audio"] : ["--start-maximized"]),
    "about:blank",
  ]
  const child = spawn(exe, args, { stdio: "ignore", windowsHide: offscreen, detached: false })
  child.on("error", () => {})

  for (let i = 0; i < 80; i++) {
    await sleep(250)
    if (!existsSync(portFile)) continue
    const lines = readFileSync(portFile, "utf8").trim().split(/\r?\n/)
    if (lines.length < 2 || !lines[0]) continue
    try {
      const browser = await Cdp.attach(`ws://127.0.0.1:${lines[0]}${lines[1]}`, 5000)
      return { child, browser, port: Number(lines[0]) }
    } catch {}
  }
  try { child.kill() } catch {}
  throw new Error(`浏览器没有在 20 秒内就绪：${exe}`)
}

async function openPage(browser, port, url) {
  const { targetId } = await browser.send("Target.createTarget", { url })
  // 页面自己的 debugger URL 只能从 HTTP /json/list 取，浏览器级 Target.getTargets 里没有。
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const info = list.find(
        (t) => (t.id === targetId || t.targetId === targetId) && t.type === "page" && t.webSocketDebuggerUrl,
      )
      if (info) return Cdp.attach(info.webSocketDebuggerUrl, 8000)
    } catch {}
    await sleep(250)
  }
  throw new Error("拿不到页面调试地址")
}

async function sessionCookieOf(page) {
  const all = await page.send("Network.getAllCookies")
  const hit = (all?.cookies ?? []).find((c) => c.name === COOKIE_NAME)
  return hit?.value
}

async function currentUser(page) {
  return page
    .evaluate(`fetch('/api/user/me',{credentials:'include'}).then(async r=>r.ok?await r.json():null)`)
    .catch(() => null)
}

/** 页面刚导航时脚本可能还没跑起来，轮询几次再判断，避免把有效 cookie 当成过期。 */
async function settledUser(page, tries = 8) {
  for (let i = 0; i < tries; i++) {
    const who = await currentUser(page)
    if (who?.user) return who
    const ready = await page.evaluate("document.readyState").catch(() => "loading")
    if (i > 0 && ready === "complete") {
      const again = await currentUser(page)
      if (again?.user) return again
      if (i >= 3) return again
    }
    await sleep(1000)
  }
  return currentUser(page)
}

/**
 * Turnstile 脚本偶尔一次加载不上（导航刚完成、网络抖动），多试几轮再判失败。
 * 返回 turnstile 是否可用。
 */
async function waitTurnstile(page, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    const kind = await page
      .evaluate(
        `(async () => {
          if (window.turnstile) return typeof window.turnstile
          const body = document.body
          if (!body) return 'no-body'
          await new Promise((r) => {
            const s = document.createElement('script')
            s.src = ${JSON.stringify(TURNSTILE_JS)}
            s.async = true
            s.onload = r
            s.onerror = r
            document.head.appendChild(s)
            setTimeout(r, 12000)
          })
          return typeof window.turnstile
        })()`,
        30000,
      )
      .catch(() => "eval-error")
    if (kind === "object" || kind === "function") return true
    await sleep(2000)
  }
  return false
}

/** 在一次性的空页面里取 Turnstile token 并调用签到接口。 */
async function submitCheckin(page) {
  return page.evaluate(
    `(async () => {
      const host = document.createElement('div')
      host.id = 'apx-checkin-turnstile'
      document.body.appendChild(host)
      const token = await new Promise((res) => {
        let done = false
        const finish = (v) => { if (!done) { done = true; res(v) } }
        try {
          turnstile.render(host, {
            sitekey: window.__apxSiteKey,
            callback: (t) => finish(t || null),
            'error-callback': () => finish(null),
          })
        } catch { finish(null) }
        setTimeout(() => finish(null), 45000)
      })
      if (!token) return { status: 0, error: 'no-token' }
      const res = await fetch('/api/user/checkin', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ turnstileToken: token }),
      })
      const body = await res.json().catch(() => null)
      return { status: res.status, body }
    })()`,
    120000,
  )
}

function toOutcome(result) {
  const body = result?.body ?? {}
  if (result?.status === 0) return { outcome: "failed", message: "拿不到 Turnstile token，稍后重试" }
  if (result?.status === 200) {
    if (body.alreadyCheckedIn) return { outcome: "done", streak: body.streak_day ?? undefined, message: "今日已签到" }
    const access = body.access
    return {
      outcome: "claimed",
      credit: typeof access?.remaining === "number" ? access.remaining : undefined,
      streak: body.streak_day ?? undefined,
      message: body.awarded_xp ? `签到成功，+${body.awarded_xp} XP` : "签到成功",
    }
  }
  const error = body?.error || `HTTP ${result?.status}`
  if (/check-in|already/i.test(error)) return { outcome: "done", message: error }
  if (/captcha|verification/i.test(error)) return { outcome: "captcha", message: error }
  return { outcome: "failed", message: error }
}

/**
 * 完成一次 APInex 每日签到。
 * @param {object} options
 * @param {string} options.stateDir 保存 session cookie 的目录（magpie 配置目录下）
 * @param {string} [options.sessionCookie] 已知的 apinex_user_session，优先于本地缓存
 * @param {string} [options.browserPath] 指定浏览器可执行文件
 * @param {boolean} [options.headed] 是否显示窗口；首次登录必须显示
 * @param {number} [options.loginWaitMs] 首次等待手工登录的时长
 * @param {(msg: string) => void} [options.onNotice]
 * @returns {Promise<{outcome: string, credit?: number, streak?: number, message?: string}>}
 */
export async function browserCheckin(options = {}) {
  const {
    stateDir = ".",
    sessionCookie,
    browserPath,
    headed = false,
    loginWaitMs = 180000,
    onNotice,
  } = options

  const debug = process.env.APINEX_DEBUG
    ? (...a) => console.error("[apinex-checkin]", ...a)
    : () => {}

  const exe = findBrowser(browserPath)
  if (!exe) {
    return { outcome: "failed", message: "未找到 Chrome/Edge，可用 plugin options 的 browserPath 指定" }
  }

  const root = resolve(stateDir)
  const cookieFile = resolve(root, "session.json")
  let saved
  if (existsSync(cookieFile)) {
    try { saved = JSON.parse(readFileSync(cookieFile, "utf8")) } catch {}
  }
  const cookie = sessionCookie || saved?.cookie

  // 没有 cookie 时只能用持久 profile 打开窗口登录；有 cookie 时用一次性 profile，避开 profile 锁。
  const profileDir = cookie
    ? resolve(root, `run-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`)
    : resolve(root, "login-profile")
  const ephemeral = Boolean(cookie)
  // 首次没有 cookie 时，即使调用方要求静默，也必须开窗口让用户登录一次。
  const showWindow = headed || !cookie

  const persist = (value) => {
    if (!value) return
    try {
      mkdirSync(root, { recursive: true })
      writeFileSync(
        cookieFile,
        JSON.stringify({ cookie: value, savedAt: new Date().toISOString() }, null, 2),
        { mode: 0o600 },
      )
    } catch (e) {
      debug("保存 cookie 失败:", e.message)
    }
  }

  let child
  let browser
  let page
  try {
    debug("启动浏览器", exe, showWindow ? "window" : "offscreen", profileDir)
    const l = await launch(exe, profileDir, !showWindow)
    child = l.child
    browser = l.browser
    page = await openPage(browser, l.port, "about:blank")
    await page.send("Page.enable")
    await page.send("Network.enable")

    if (cookie) {
      await page.send("Network.setCookie", {
        name: COOKIE_NAME,
        value: cookie,
        domain: COOKIE_DOMAIN,
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
        expires: Math.floor(Date.now() / 1000) + 180 * 24 * 3600,
      })
    }

    await page.send("Page.navigate", { url: `${SITE}/overview` })
    await sleep(2500)

    let who = await settledUser(page)
    debug("初次身份:", who?.user?.email ?? "未登录")

    if (!who?.user && cookie) {
      // 缓存的 cookie 已失效：清掉，改走手工登录
      try { rmSync(cookieFile, { force: true }) } catch {}
      return {
        outcome: "failed",
        message: "保存的登录已失效，请重新登录 APInex（下次签到会打开登录窗口）",
      }
    }

    if (!who?.user) {
      onNotice?.("请在刚打开的窗口里用 Google 登录 APInex，登录后签到会自动继续（最多等 3 分钟）")
      const deadline = Date.now() + loginWaitMs
      while (Date.now() < deadline) {
        await sleep(3000)
        who = await currentUser(page)
        if (who?.user) break
      }
      if (!who?.user) return { outcome: "failed", message: "等待浏览器登录超时" }
      debug("登录完成:", who.user.email)
    }

    const challenge = await page.evaluate(
      `fetch('/api/user/auth/challenge',{credentials:'include'}).then(r=>r.json()).catch(()=>({}))`,
    )
    debug("challenge:", JSON.stringify(challenge))
    if (!challenge?.enabled || !challenge?.siteKey) {
      return { outcome: "failed", message: "签到接口当前未启用验证码，站点接口可能已变更" }
    }

    const ready = await waitTurnstile(page)
    debug("turnstile ready:", ready)
    if (!ready) return { outcome: "failed", message: "Turnstile 脚本没有加载成功" }

    const siteKey = challenge.siteKey
    await page.evaluate(`window.__apxSiteKey = ${JSON.stringify(siteKey)}`)
    const result = await submitCheckin(page)
    debug("checkin:", JSON.stringify(result).slice(0, 300))

    // 无论签到结果如何，把当前会话 cookie 存下来给下次用
    persist(await sessionCookieOf(page).catch(() => undefined))

    return toOutcome(result)
  } catch (e) {
    return { outcome: "failed", message: e instanceof Error ? e.message : String(e) }
  } finally {
    try { page?.close() } catch {}
    // 只关闭页面的 WS 不会停浏览器；这里整棵树一起收掉，避免下次启动被残留进程锁住。
    await stopBrowser(child, profileDir)
    if (ephemeral) {
      await sleep(600)
      try { rmSync(profileDir, { recursive: true, force: true }) } catch {}
    }
  }
}