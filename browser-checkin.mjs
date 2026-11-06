// APInex 每日签到。签到接口要求 Cloudflare Turnstile token，只能在真实浏览器里拿到，
// 所以这里用 CDP 驱动本地浏览器：
//   1) 优先复用用户自己开着的默认浏览器（Edge/Chrome），它已有 APInex 登录态：
//      Edge 需在 edge://inspect/#remote-debugging 打开开关并重启一次。
//   2) 连不上时用独立的持久 profile：首次开窗口登录一次，之后 profile 里的 cookie 直接复用。
//      profile 是持久的，不能删；只清运行时锁文件。

import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { spawn } from "node:child_process"
import { resolve } from "node:path"
import { homedir } from "node:os"

const SITE = "https://apinex.bond"
const COOKIE_NAME = "apinex_user_session"
const COOKIE_DOMAIN = ".apinex.bond"
const TURNSTILE_JS = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Windows 上读系统默认浏览器的 ProgId，用来优先用用户自己的浏览器。 */
async function windowsDefaultBrowser() {
  if (process.platform !== "win32") return undefined
  const { spawnSync } = await import("node:child_process")
  const r = spawnSync("reg", [
    "query",
    "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice",
    "/v",
    "ProgId",
  ], { encoding: "utf8", windowsHide: true })
  const m = /ProgId\s+REG_SZ\s+(\S+)/.exec(r.stdout ?? "")
  if (!m) return undefined
  const id = m[1].toLowerCase()
  if (id.includes("edge")) return "edge"
  if (id.includes("chrome")) return "chrome"
  if (id.includes("brave")) return "brave"
  if (id.includes("firefox")) return "firefox"
  return undefined
}

async function browserCandidates() {
  const home = homedir()
  const paths = {}
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || resolve(home, "AppData", "Local")
    const pf = process.env.ProgramFiles || "C:\Program Files"
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\Program Files (x86)"
    paths.edge = [
      resolve(pf86, "Microsoft/Edge/Application/msedge.exe"),
      resolve(pf, "Microsoft/Edge/Application/msedge.exe"),
      resolve(local, "Microsoft/Edge/Application/msedge.exe"),
    ]
    paths.chrome = [
      resolve(pf, "Google/Chrome/Application/chrome.exe"),
      resolve(pf86, "Google/Chrome/Application/chrome.exe"),
      resolve(local, "Google/Chrome/Application/chrome.exe"),
    ]
    paths.brave = [
      resolve(pf, "BraveSoftware/Brave-Browser/Application/brave.exe"),
      resolve(local, "BraveSoftware/Brave-Browser/Application/brave.exe"),
    ]
  } else if (process.platform === "darwin") {
    paths.edge = ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
    paths.chrome = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    paths.brave = ["/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"]
    paths.firefox = ["/Applications/Firefox.app/Contents/MacOS/firefox"]
  } else {
    paths.edge = ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"]
    paths.chrome = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"]
    paths.brave = ["/usr/bin/brave-browser"]
    paths.firefox = ["/usr/bin/firefox"]
  }

  // 默认浏览器排最前；其余作为后备，但绝不悄悄换成别的浏览器。
  const order = []
  const preferred = await windowsDefaultBrowser()
  if (preferred) order.push(preferred)
  for (const id of ["edge", "chrome", "brave", "firefox"]) {
    if (!order.includes(id)) order.push(id)
  }
  return order.flatMap((id) => paths[id] ?? [])
}

export async function findBrowser(explicit) {
  if (explicit) return existsSync(explicit) ? explicit : undefined
  return (await browserCandidates()).find((p) => existsSync(p))
}

class Cdp {
  #ws
  #id = 0
  counter = 0
  pending = new Map()
  #sessionId
  #shared

  /** 传 sessionId 时复用浏览器级 WS，按扁平会话把命令路由到某个页面。 */
  constructor(ws, sessionId, shared) {
    this.#ws = ws
    this.#sessionId = sessionId
    // 父子会话共用同一条 WS，消息 id 也必须共用，否则两边 id 撞车会丢回包。
    this.#shared = shared
  }

  session(sessionId) {
    return new Cdp(this.#ws, sessionId, this.#shared ?? this)
  }

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
      const p = m.id && c.pending.get(m.id)
      if (!p) return
      c.pending.delete(m.id)
      m.error ? p.rej(new Error(m.error.message || JSON.stringify(m.error))) : p.res(m.result)
    }
    return c
  }

  send(method, params = {}, timeoutMs = 60000) {
    const owner = this.#shared ?? this
    const id = ++owner.counter
    return new Promise((res, rej) => {
      owner.pending.set(id, { res, rej })
      const msg = { id, method, params }
      if (this.#sessionId) msg.sessionId = this.#sessionId
      this.#ws.send(JSON.stringify(msg))
      setTimeout(() => {
        if (owner.pending.delete(id)) rej(new Error(`CDP ${method} 超时`))
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
    if (this.#sessionId) {
      // 子会话只 detach，不关浏览器级 WS。
      this.#ws.send(JSON.stringify({
        id: ++this.#id,
        method: "Target.detachFromTarget",
        params: { sessionId: this.#sessionId },
      }))
      return
    }
    try { this.#ws.close() } catch {}
  }
}


/** 持久 profile 复用时，上一次的锁文件会让浏览器拒绝启动；启动前和结束后都清一遍。 */
async function clearProfileLocks(profileDir) {
  for (const name of ["DevToolsActivePort", "lockfile", "SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try { rmSync(resolve(profileDir, name), { force: true }) } catch {}
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

async function launch(exe, profileDir, offscreen, startUrl = `${SITE}/overview`) {
  // 浏览器按自己进程的 cwd 解释相对路径，必须给绝对路径。
  const dir = resolve(profileDir)
  mkdirSync(dir, { recursive: true })
  await clearProfileLocks(dir)
  const portFile = resolve(dir, "DevToolsActivePort")

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
    // 直接把目标页作为启动页：用户一眼能看到登录界面，不必等 CDP 建好 target 再导航。
    startUrl,
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


/** 用户自己浏览器（Edge/Chrome）可能已开启远程调试；优先复用它已有的登录态。 */
function userBrowserPortFiles() {
  const local = process.env.LOCALAPPDATA || resolve(homedir(), "AppData", "Local")
  if (process.platform === "win32") {
    return ["Microsoft/Edge", "Google/Chrome", "BraveSoftware/Brave-Browser"]
      .flatMap((b) => [
        resolve(local, b, "User Data/DevToolsActivePort"),
        resolve(local, b, "User Data/Default/DevToolsActivePort"),
      ])
  }
  if (process.platform === "darwin") {
    return ["Microsoft Edge", "Google Chrome", "BraveSoftware/Brave-Browser"]
      .flatMap((b) => [
        resolve(homedir(), "Library/Application Support", b, "DevToolsActivePort"),
      ])
  }
  return ["microsoft-edge", "google-chrome", "chromium", "BraveSoftware/Brave-Browser"]
    .flatMap((b) => [resolve(homedir(), ".config", b, "DevToolsActivePort")])
}

/** 连上用户已开启调试的浏览器；没有就返回 undefined，不抛错。 */
async function attachUserBrowser() {
  for (const file of userBrowserPortFiles()) {
    if (!existsSync(file)) continue
    let lines
    try {
      lines = readFileSync(file, "utf8").trim().split(/\r?\n/)

    } catch { continue }
    if (lines.length < 2 || !lines[0]) continue
    const wsUrl = `ws://127.0.0.1:${lines[0]}${lines[1]}`
    try {
      const browser = await Cdp.attach(wsUrl, 6000)
      return { browser, port: Number(lines[0]), portFile: file }
    } catch {}
  }
  return undefined
}

/**
 * 在浏览器里开一个页面并拿到它的会话。
 * 只走 WS 扁平会话：Edge 的 HTTP /json/list 需要 Host: localhost 才回应，
 * 而 WS 用 127.0.0.1 直连即可，少依赖一个环节。
 */
async function openPage(browser, url) {
  const { targetId } = await browser.send("Target.createTarget", { url: url || "about:blank" })
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true })
  const page = browser.session(sessionId)
  page.__targetId = targetId
  return page
}

/** 用完关掉自己开的标签，不留痕迹。 */
async function closePage(browser, page) {
  const targetId = page?.__targetId
  try { page?.close() } catch {}
  if (targetId) {
    try { await browser.send("Target.closeTarget", { targetId }) } catch {}
  }
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

  const exe = await findBrowser(browserPath)
  if (!exe) {
    return { outcome: "failed", message: "未找到可用的浏览器，可用 plugin options 的 browserPath 指定" }
  }

  const root = resolve(stateDir)
  const cookieFile = resolve(root, "session.json")
  let saved
  if (existsSync(cookieFile)) {
    try { saved = JSON.parse(readFileSync(cookieFile, "utf8")) } catch {}
  }
  const cookie = sessionCookie || saved?.cookie

  // 持久 profile：首次开窗口手动登录一次，之后 profile 里的 cookie 直接复用，不再要求登录。
  const profileDir = resolve(root, "browser-profile")
  // 没登录过的账号必须先看到窗口；已登录过的可以移到屏幕外静默跑。
  const needLogin = !cookie
  const showWindow = headed || needLogin

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
  let usingUserBrowser = false
  try {
    // 先试用户自己开着的浏览器：它已经有 APInex 登录态，不需要再登录一次。
    if (!options.freshProfile) {
      const attached = await attachUserBrowser()
      if (attached) {
        debug("复用用户浏览器，端口", attached.port)
        browser = attached.browser
        browser.__port = attached.port
        usingUserBrowser = true
      }
    }

    if (!browser) {
      debug("启动独立浏览器", exe, showWindow ? "window" : "offscreen", profileDir)
      const l = await launch(exe, profileDir, !showWindow, needLogin ? `${SITE}/login` : `${SITE}/overview`)
      child = l.child
      browser = l.browser
    }
    // 复用用户浏览器时开一个临时标签，用完关掉；独立浏览器则直接用它自己的窗口。
    page = await openPage(browser, `${SITE}/overview`)
    await page.send("Page.enable")
    await page.send("Network.enable")

    // 只有我们自己起的独立 profile 才需要注入 cookie；复用用户浏览器时用他自己的登录态。
    if (cookie && !usingUserBrowser) {
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
    if (page && browser) await closePage(browser, page)
    // 只关闭页面的 WS 不会停浏览器；用户自己的浏览器绝不能杀，只收掉我们自己起的。
    if (!usingUserBrowser) await stopBrowser(child, profileDir)
    // profile 要留着下次复用登录态，只清掉会让下次启动失败的锁文件。
    await clearProfileLocks(profileDir)
  }
}