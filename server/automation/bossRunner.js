import { EventEmitter } from "node:events";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import WebSocket from "ws";
import { defaultConfig } from "../lib/defaults.js";
import { detectSecurityBlocker, normalizeText, readAllLogCandidates, screenJob } from "../lib/rules.js";

const SEARCH_BASE = "https://www.zhipin.com/web/geek/jobs";
const LOGIN_URL = "https://www.zhipin.com/web/user/?ka=header-login";
const LOGIN_CHECK_URL = `${SEARCH_BASE}?query=Java&city=100010000`;
const LOGIN_REQUIRED = "请先在打开的 BOSS 登录页完成登录，再继续运行";
const PROFILE_IN_USE = "浏览器配置目录已被旧自动化窗口占用";
const LOGIN_DEBUG_PORT = Number(process.env.BOSS_CHROME_DEBUG_PORT || 9227);
const LOGIN_DEBUG_URL = `http://127.0.0.1:${LOGIN_DEBUG_PORT}`;
const execFileAsync = promisify(execFile);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function safeFileStamp() {
  return nowIso().replace(/[:.]/g, "-");
}

export class BossRunner extends EventEmitter {
  constructor({ rootDir }) {
    super();
    this.rootDir = rootDir;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.loginMonitor = null;
    this.loginCheckInFlight = false;
    this.loginVerified = false;
    this.abortRequested = false;
    this.activeRun = false;
    this.status = {
      state: "idle",
      message: "Ready",
      loginVerified: false,
      loginCheckedAt: "",
      applied: 0,
      screened: 0,
      skipped: 0,
      blocker: "",
      currentQuery: "",
      currentCity: "",
      logFile: "",
      startedAt: "",
      updatedAt: nowIso(),
    };
  }

  getStatus() {
    return { ...this.status };
  }

  updateStatus(patch) {
    if (Object.prototype.hasOwnProperty.call(patch, "loginVerified")) {
      this.loginVerified = Boolean(patch.loginVerified);
    }
    this.status = { ...this.status, ...patch, updatedAt: nowIso() };
    this.emit("status", this.getStatus());
  }

  emitLog(message, level = "info") {
    const payload = { level, message, at: nowIso() };
    this.emit("log", payload);
  }

  async ensureContext(config = defaultConfig, options = {}) {
    const initialUrl = options.initialUrl || "";
    const forceNavigate = Boolean(options.forceNavigate);
    if (this.context && this.page && !this.page.isClosed()) {
      if (initialUrl && forceNavigate) {
        await this.openLoginPage(this.page);
      }
      return this.page;
    }

    const profileDir = path.resolve(this.rootDir, config.profileDir || "data/browser-profile");
    await fs.mkdir(profileDir, { recursive: true });
    if (await isLoginDebugReady()) {
      const wrapped = new Error("已有 BOSS 登录窗口正在运行，请复用当前窗口，不要重新启动未登录窗口");
      wrapped.code = "BROWSER_PROFILE_IN_USE";
      throw wrapped;
    }

    const launchOptions = {
      headless: Boolean(config.headless),
      viewport: { width: 1440, height: 960 },
      locale: "zh-CN",
      args: ["--disable-blink-features=AutomationControlled"],
    };
    if (config.browserChannel === "chrome") {
      launchOptions.channel = "chrome";
    }

    try {
      this.context = await chromium.launchPersistentContext(profileDir, launchOptions);
    } catch (error) {
      if (isProfileInUseError(error)) {
        const wrapped = new Error(PROFILE_IN_USE);
        wrapped.code = "BROWSER_PROFILE_IN_USE";
        wrapped.cause = error;
        throw wrapped;
      }
      throw error;
    }
    this.page = selectBestPage(this.context.pages()) || (await this.context.newPage());
    this.bindPage(this.page);
    this.context.on("close", () => {
      this.context = null;
      this.page = null;
      this.updateStatus({ loginVerified: false });
    });
    if (initialUrl) {
      await this.openLoginPage(this.page);
    }
    return this.page;
  }

  async connectToLoginChrome() {
    if (!(await isLoginDebugReady())) return null;
    return chromium.connectOverCDP(LOGIN_DEBUG_URL);
  }

  bindPage(page) {
    if (!page || page.isClosed()) return;
    page.setDefaultTimeout(9000);
    page.on("close", () => {
      if (this.page === page) this.page = null;
    });
  }

  async preflight(config = defaultConfig) {
    this.updateStatus({ state: "preflight", message: "正在打开 BOSS 登录页" });
    const result = await this.requireLoggedIn(config);
    if (!result.ok) return result;
    this.updateStatus({ state: "idle", blocker: "", message: "登录已确认，可以开始检查或自动投递" });
    this.emitLog("Preflight passed");
    return result;
  }

  async openLogin(config = defaultConfig, options = {}) {
    this.abortRequested = false;
    this.updateStatus({
      state: "waitingLogin",
      message: "请在打开的 BOSS 登录页完成登录",
      loginVerified: false,
      blocker: "",
      currentCity: "",
      currentQuery: "",
    });
    try {
      const profileDir = path.resolve(this.rootDir, config.profileDir || "data/browser-profile");
      await fs.mkdir(profileDir, { recursive: true });
      const debugReady = await isLoginDebugReady();
      if (!debugReady) {
        this.browser = null;
        this.context = null;
        this.page = null;
        await closeChromeForProfile(profileDir).catch((error) => {
          this.emitLog(`Could not clean old login Chrome: ${error.message}`, "warn");
        });
        await launchLoginChrome(profileDir);
        await waitForLoginDebug();
      }
      const loginTab = await openUrlInLoginChrome(LOGIN_URL);
      if (!loginTab) {
        throw new Error("BOSS 登录标签页没有保持打开，请重新点击打开登录");
      }
      this.updateStatus({
        state: "waitingLogin",
        message: "请在打开的普通 Chrome 登录页完成登录；完成后再点击开始检查或自动投递",
        loginVerified: false,
        blocker: "",
        currentCity: "",
        currentQuery: "",
      });
      this.emitLog("Login page opened; waiting for manual login");
      if (options.startMonitor !== false) {
        this.startLoginMonitor(config);
      }
      return { ok: true, url: LOGIN_URL };
    } catch (error) {
      if (isProfileInUseError(error)) {
        return this.blockOnProfileInUse(error);
      }
      throw error;
    }
  }

  async start(configInput = {}) {
    if (this.activeRun || this.status.state === "running") {
      return this.getStatus();
    }
    const config = this.normalizeConfig(configInput);
    this.abortRequested = false;
    const login = await this.requireLoggedIn(config);
    if (!login.ok) {
      return this.getStatus();
    }
    const runLog = path.join(this.rootDir, "data", "runs", `boss-java-run-${safeFileStamp()}.md`);
    await fs.mkdir(path.dirname(runLog), { recursive: true });
    await fs.writeFile(
      runLog,
      [
        "# BOSS Java Copilot Run",
        "",
        `- Started: ${nowIso()}`,
        `- Mode: ${config.mode}`,
        `- Target: ${config.target}`,
        `- Browser: ${config.browserChannel}`,
        "",
        "## Events",
        "",
      ].join("\n"),
      "utf8",
    );
    this.updateStatus({
      state: "running",
      message: "Run started",
      applied: 0,
      screened: 0,
      skipped: 0,
      blocker: "",
      logFile: path.relative(this.rootDir, runLog),
      startedAt: nowIso(),
    });
    this.activeRun = true;
    this.run(config, runLog)
      .catch((error) => {
        const browserClosed = isBrowserClosedError(error);
        this.updateStatus({
          state: browserClosed ? "blocked" : "error",
          message: browserClosed ? "Automation browser was closed" : error.message,
          blocker: browserClosed ? "automation browser closed; run preflight again" : error.message,
        });
        this.emitLog(error.stack || error.message, "error");
      })
      .finally(() => {
        this.activeRun = false;
        if (this.status.state === "stopping") {
          this.updateStatus({ state: "idle", message: "Stopped", currentCity: "", currentQuery: "" });
        }
      });
    return this.getStatus();
  }

  async stop(reason = "stopped by user") {
    this.abortRequested = true;
    this.updateStatus({
      state: this.activeRun ? "stopping" : "idle",
      message: reason,
      currentCity: "",
      currentQuery: "",
    });
    this.emitLog(reason, "warn");
    return this.getStatus();
  }

  async closeBrowser() {
    if (this.browser) {
      await this.browser.close().catch(() => {});
    }
    if (this.context) {
      await this.context.close().catch(() => {});
    }
    this.browser = null;
    this.context = null;
    this.page = null;
    this.stopLoginMonitor();
    this.updateStatus({ state: "idle", message: "Browser closed", loginVerified: false });
  }

  normalizeConfig(configInput) {
    const merged = {
      ...defaultConfig,
      ...configInput,
      cities: Array.isArray(configInput.cities) ? configInput.cities : defaultConfig.cities,
      queries: Array.isArray(configInput.queries) ? configInput.queries : defaultConfig.queries,
    };
    return {
      ...merged,
      target: Math.max(1, Number(merged.target || 30)),
      delayMs: Math.max(1200, Number(merged.delayMs || 1200)),
      maxPagesPerQuery: Math.max(1, Number(merged.maxPagesPerQuery || 2)),
    };
  }

  async run(config, runLog) {
    if (await isLoginDebugReady()) {
      return this.runCdp(config, runLog);
    }

    const page = await this.ensureContext(config);
    const { candidates: historical } = await readAllLogCandidates(this.rootDir).catch(() => ({ candidates: [] }));
    const seen = new Set(historical.map((item) => candidateKey(item)));
    const cities = config.cities.filter((city) => city.enabled !== false);
    const queries = config.queries.filter(Boolean);
    let applied = 0;
    let screened = 0;
    let skipped = 0;

    for (const city of cities) {
      for (const query of queries) {
        if (this.shouldStop(applied, config.target)) break;
        this.updateStatus({ currentCity: city.label, currentQuery: query, message: `Searching ${city.label} / ${query}` });
        await this.appendRun(runLog, `### Query: ${city.label}:${query}`);
        await this.gotoSearch(page, query, city);

        for (let pageIndex = 1; pageIndex <= config.maxPagesPerQuery; pageIndex += 1) {
          if (this.shouldStop(applied, config.target)) break;
          const blocker = await this.detectPageBlocker(page);
          if (blocker) {
            await this.block(runLog, blocker, page);
            return;
          }

          const cards = await this.collectCards(page);
          this.emitLog(`Found ${cards.length} visible cards on page ${pageIndex}`);
          if (!cards.length) break;

          for (const card of cards) {
            if (this.shouldStop(applied, config.target)) break;
            const key = candidateKey(card);
            if (seen.has(key)) {
              skipped += 1;
              this.updateStatus({ skipped, screened });
              continue;
            }
            seen.add(key);
            screened += 1;

            const cardScreen = screenJob({ ...card, query }, config);
            if (!cardScreen.pass) {
              skipped += 1;
              if (config.mode === "review") {
                this.emit("candidate", { ...card, screen: cardScreen, status: "skipped" });
              }
              await this.appendRun(runLog, `- skipped: ${formatCandidate(card)} | ${cardScreen.reason}`);
              this.updateStatus({ screened, skipped });
              continue;
            }

            await this.clickCard(page, card.index);
            await delay(config.delayMs);
            const detail = await this.readDetail(page);
            const detailJob = { ...detail, ...card, query, detailText: detail.text, chatText: detail.chatText };
            const detailScreen = screenJob(detailJob, config);
            const candidate = { ...detail, ...card, screen: detailScreen, detailText: detail.text, chatText: detail.chatText };
            if (config.mode === "review") {
              this.emit("candidate", candidate);
            }

            if (!detailScreen.pass) {
              skipped += 1;
              await this.appendRun(runLog, `- skipped: ${formatCandidate(card)} | ${detailScreen.reason}`);
              this.updateStatus({ screened, skipped });
              continue;
            }

            if (config.mode === "review") {
              await this.appendRun(runLog, `- ready: ${formatCandidate(card)} | ${detailScreen.reason}`);
              this.emitLog(`Check ready: ${card.company} / ${card.title}`);
              this.updateStatus({ screened, skipped, message: "Check result collected" });
              continue;
            }

            const sent = await this.clickChat(page);
            if (sent.blocker) {
              await this.block(runLog, sent.blocker, page);
              return;
            }
            if (!sent.ok) {
              skipped += 1;
              await this.appendRun(runLog, `- skipped: ${formatCandidate(card)} | ${sent.reason || "chat button unavailable"}`);
              this.updateStatus({ screened, skipped });
              continue;
            }
            applied += 1;
            await this.appendRun(runLog, `${applied}. ${formatCandidate(card)} | ${detailScreen.reason} | 点击: ${sent.text || "立即沟通"}`);
            this.emit("applied", { ...candidate, appliedIndex: applied });
            this.updateStatus({ applied, screened, skipped, message: `Applied ${applied} / ${config.target}` });
            await delay(config.delayMs + 450);
          }

          if (this.shouldStop(applied, config.target)) break;
          const moved = await this.nextPage(page);
          if (!moved) break;
          await delay(config.delayMs + 600);
        }
      }
    }

    const state = applied >= config.target ? "done" : this.abortRequested ? "idle" : "done";
    const message = applied >= config.target ? "Target reached" : this.abortRequested ? "Stopped" : "Run finished";
    await this.appendRun(runLog, `\n- Finished: ${nowIso()}`);
    await this.appendRun(runLog, `- Applied: ${applied} / ${config.target}`);
    await this.appendRun(runLog, `- Screened: ${screened}`);
    await this.appendRun(runLog, `- Skipped: ${skipped}`);
    this.updateStatus({ state, applied, screened, skipped, message, currentCity: "", currentQuery: "" });
  }

  async runCdp(config, runLog) {
    let page = await createCdpAutomationPage();
    const { candidates: historical } = await readAllLogCandidates(this.rootDir).catch(() => ({ candidates: [] }));
    const seen = new Set(historical.map((item) => candidateKey(item)));
    const cities = config.cities.filter((city) => city.enabled !== false);
    const queries = config.queries.filter(Boolean);
    let applied = 0;
    let screened = 0;
    let skipped = 0;

    try {
      for (const city of cities) {
        for (const query of queries) {
          if (this.shouldStop(applied, config.target)) break;
          this.updateStatus({ currentCity: city.label, currentQuery: query, message: `Searching ${city.label} / ${query}` });
          await this.appendRun(runLog, `### Query: ${city.label}:${query}`);
          page = await cdpGotoSearch(page, query, city);

          for (let pageIndex = 1; pageIndex <= config.maxPagesPerQuery; pageIndex += 1) {
            if (this.shouldStop(applied, config.target)) break;
            const blocker = await cdpDetectPageBlocker(page);
            if (blocker) {
              await this.block(runLog, blocker);
              return;
            }

            const cards = await cdpCollectCards(page);
            this.emitLog(`Found ${cards.length} visible cards on page ${pageIndex}`);
            if (!cards.length) {
              const body = normalizeText(await cdpBodyText(page));
              const noCardBlocker = detectSecurityBlocker(body);
              if (noCardBlocker) {
                await this.block(runLog, noCardBlocker);
                return;
              }
              await this.appendRun(runLog, `- no visible cards: ${body.slice(0, 180) || "empty page"}`);
              break;
            }

            for (const card of cards) {
              if (this.shouldStop(applied, config.target)) break;
              const key = candidateKey(card);
              if (seen.has(key)) {
                skipped += 1;
                this.updateStatus({ skipped, screened });
                continue;
              }
              seen.add(key);
              screened += 1;

              const cardScreen = screenJob({ ...card, query }, config);
              if (!cardScreen.pass) {
                skipped += 1;
                if (config.mode === "review") {
                  this.emit("candidate", { ...card, screen: cardScreen, status: "skipped" });
                }
                await this.appendRun(runLog, `- skipped: ${formatCandidate(card)} | ${cardScreen.reason}`);
                this.updateStatus({ screened, skipped });
                continue;
              }

              await cdpClickCard(page, card.domIndex);
              await delay(config.delayMs);
              const detail = await cdpReadDetail(page);
              const detailJob = { ...detail, ...card, query, detailText: detail.text, chatText: detail.chatText };
              const detailScreen = screenJob(detailJob, config);
              const candidate = { ...detail, ...card, screen: detailScreen, detailText: detail.text, chatText: detail.chatText };
              if (config.mode === "review") {
                this.emit("candidate", candidate);
              }

              if (!detailScreen.pass) {
                skipped += 1;
                await this.appendRun(runLog, `- skipped: ${formatCandidate(card)} | ${detailScreen.reason}`);
                this.updateStatus({ screened, skipped });
                continue;
              }

              if (config.mode === "review") {
                await this.appendRun(runLog, `- ready: ${formatCandidate(card)} | ${detailScreen.reason}`);
                this.emitLog(`Check ready: ${card.company} / ${card.title}`);
                this.updateStatus({ screened, skipped, message: "Check result collected" });
                continue;
              }

              const sent = await cdpClickChat(page);
              if (sent.blocker) {
                await this.block(runLog, sent.blocker);
                return;
              }
              if (!sent.ok) {
                skipped += 1;
                await this.appendRun(runLog, `- skipped: ${formatCandidate(card)} | ${sent.reason || "chat button unavailable"}`);
                this.updateStatus({ screened, skipped });
                continue;
              }
              applied += 1;
              await this.appendRun(runLog, `${applied}. ${formatCandidate(card)} | ${detailScreen.reason} | 点击: ${sent.text || "立即沟通"}`);
              this.emit("applied", { ...candidate, appliedIndex: applied });
              this.updateStatus({ applied, screened, skipped, message: `Applied ${applied} / ${config.target}` });
              await delay(config.delayMs + 450);
            }

            if (this.shouldStop(applied, config.target)) break;
            const moved = await cdpNextPage(page);
            if (!moved) break;
            await delay(config.delayMs + 600);
          }
        }
      }

      const state = applied >= config.target ? "done" : this.abortRequested ? "idle" : "done";
      const message = applied >= config.target ? "Target reached" : this.abortRequested ? "Stopped" : "Run finished";
      await this.appendRun(runLog, `\n- Finished: ${nowIso()}`);
      await this.appendRun(runLog, `- Applied: ${applied} / ${config.target}`);
      await this.appendRun(runLog, `- Screened: ${screened}`);
      await this.appendRun(runLog, `- Skipped: ${skipped}`);
      this.updateStatus({ state, applied, screened, skipped, message, currentCity: "", currentQuery: "" });
    } finally {
      page.close();
    }
  }

  shouldStop(applied, target) {
    return this.abortRequested || applied >= target;
  }

  async gotoSearch(page, query, city) {
    const url = `${SEARCH_BASE}?query=${encodeURIComponent(query)}&city=${encodeURIComponent(city.code || city.key || city.label)}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
    await page.mouse.wheel(0, 300).catch(() => {});
    await page
      .waitForSelector(".job-card-wrap, .job-list-box li, li[class*='job-card'], [class*='job-card'], .op-btn-chat", { timeout: 15000 })
      .catch(() => {});
  }

  async detectPageBlocker(page) {
    const body = normalizeText(await page.locator("body").innerText({ timeout: 5000 }).catch(() => ""));
    return detectSecurityBlocker(body);
  }

  async getExistingPageForLoginCheck(config = defaultConfig) {
    if (this.context && this.page && !this.page.isClosed()) {
      return this.page;
    }
    return null;
  }

  async checkLogin(config = defaultConfig, options = {}) {
    const allowNavigation = Boolean(options.allowNavigation);
    const reopenLoginOnBlank = Boolean(options.reopenLoginOnBlank);
    const announce = options.announce !== false;
    let page;
    try {
      const debugSignals = await inspectLoginDebugPage({ navigate: allowNavigation }).catch((error) => {
        this.emitLog(`Chrome debug login check failed: ${error.message}`, "warn");
        return null;
      });
      if (debugSignals) {
        return this.finishLoginCheckFromSignals(debugSignals, config, { announce });
      }

      page = await this.getExistingPageForLoginCheck(config);
      if (!page) {
        if (reopenLoginOnBlank) {
          await this.openLogin(config, { startMonitor: false });
          if (!this.loginMonitor) this.startLoginMonitor(config);
        }
        if (announce) {
          this.updateStatus({
            state: "waitingLogin",
            blocker: LOGIN_REQUIRED,
            message: "请先在打开的 BOSS 登录页完成登录",
            loginVerified: false,
            currentCity: "",
            currentQuery: "",
          });
        }
        return { ok: false, blocker: LOGIN_REQUIRED, url: LOGIN_URL };
      }
    } catch (error) {
      if (isProfileInUseError(error)) {
        return this.blockOnProfileInUse(error);
      }
      throw error;
    }

    const currentPage = await this.inspectCurrentLoginState(page);
    if (!currentPage.ok) {
      const blocker = currentPage.blocker || LOGIN_REQUIRED;
      if (reopenLoginOnBlank && (currentPage.blankPage || !isBossPage(page.url()))) {
        await this.openLogin(config, { startMonitor: false }).catch((error) => {
          this.emitLog(`Could not reopen login page: ${error.message}`, "warn");
        });
      }
      if (announce) {
        this.updateStatus({
          state: "waitingLogin",
          blocker,
          message: "请先在打开的 BOSS 登录页完成登录",
          loginVerified: false,
          currentCity: "",
          currentQuery: "",
        });
      }
      if (!this.loginMonitor) this.startLoginMonitor(config);
      this.emitLog(`Login gate blocked: ${blocker}`, "warn");
      return { ok: false, blocker, url: page.url() };
    }

    const inspected = allowNavigation ? await this.inspectLoginState(page) : currentPage;
    if (inspected.ok) {
      this.stopLoginMonitor();
      this.updateStatus({
        state: "idle",
        blocker: "",
        message: "登录已确认，可以开始检查或自动投递",
        loginVerified: true,
        loginCheckedAt: nowIso(),
        currentCity: "",
        currentQuery: "",
      });
      this.emitLog("Login gate passed");
      return { ok: true, url: page.url() };
    }

    const blocker = inspected.blocker || LOGIN_REQUIRED;
    if (announce) {
      this.updateStatus({
        state: "waitingLogin",
        blocker,
        message: "请先在打开的 BOSS 登录页完成登录",
        loginVerified: false,
        currentCity: "",
        currentQuery: "",
      });
    }
    if (!this.loginMonitor) this.startLoginMonitor(config);
    this.emitLog(`Login gate blocked: ${blocker}`, "warn");
    return { ok: false, blocker, url: page.url() };
  }

  finishLoginCheckFromSignals(signals, config, { announce = true } = {}) {
    const inspected = analyzeLoginSignals(signals);
    if (inspected.ok) {
      this.stopLoginMonitor();
      this.updateStatus({
        state: "idle",
        blocker: "",
        message: "登录已确认，可以开始检查或自动投递",
        loginVerified: true,
        loginCheckedAt: nowIso(),
        currentCity: "",
        currentQuery: "",
      });
      this.emitLog("Login gate passed");
      return { ok: true, url: signals.url };
    }

    const blocker = inspected.blocker || LOGIN_REQUIRED;
    if (announce) {
      this.updateStatus({
        state: "waitingLogin",
        blocker,
        message: "请先在打开的 BOSS 登录页完成登录",
        loginVerified: false,
        currentCity: "",
        currentQuery: "",
      });
    }
    if (!this.loginMonitor) this.startLoginMonitor(config);
    this.emitLog(`Login gate blocked: ${blocker}`, "warn");
    return { ok: false, blocker, url: signals.url || LOGIN_URL };
  }

  async requireLoggedIn(config) {
    return this.checkLogin(config, { allowNavigation: false, reopenLoginOnBlank: false, announce: true });
  }

  startLoginMonitor(config = defaultConfig) {
    this.stopLoginMonitor();
    const startedAt = Date.now();
    this.loginMonitor = setInterval(async () => {
      if (this.loginCheckInFlight) return;
      if (this.status.state !== "waitingLogin") {
        this.stopLoginMonitor();
        return;
      }
      if (Date.now() - startedAt > 10 * 60 * 1000) {
        this.stopLoginMonitor();
        return;
      }
      this.loginCheckInFlight = true;
      try {
        await this.checkLogin(config, { allowNavigation: false, reopenLoginOnBlank: false, announce: false });
      } catch (error) {
        this.emitLog(`Login monitor check failed: ${error.message}`, "warn");
      } finally {
        this.loginCheckInFlight = false;
      }
    }, 10000);
    this.loginMonitor.unref?.();
  }

  stopLoginMonitor() {
    if (this.loginMonitor) {
      clearInterval(this.loginMonitor);
      this.loginMonitor = null;
    }
  }

  blockOnProfileInUse(error) {
    this.context = null;
    this.page = null;
    this.updateStatus({
      state: "blocked",
      blocker: PROFILE_IN_USE,
      message: "已尝试把 BOSS 登录页打开到旧自动化窗口；如果仍是空白，请关闭旧窗口后再点打开登录",
      currentCity: "",
      currentQuery: "",
    });
    this.emitLog(`${PROFILE_IN_USE}: ${error.cause?.message || error.message}`, "warn");
    return { ok: false, blocker: PROFILE_IN_USE, url: LOGIN_URL };
  }

  async inspectCurrentLoginState(page) {
    if (!page || page.isClosed()) {
      return { ok: false, blocker: "automation browser closed; run preflight again" };
    }

    await page.waitForLoadState("domcontentloaded", { timeout: 12000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
    await page.bringToFront().catch(() => {});
    const signals = await readLoginSignals(page);
    const bodyHead = normalizeText(signals.bodyHead);
    const blocker = detectSecurityBlocker(bodyHead);
    const loginText = /登录 \/ 注册|扫码登录|微信登录|手机号登录|密码登录|验证码登录|BOSS直聘 APP|请使用.*扫码/.test(bodyHead);
    const loginControlsVisible = signals.loginControlCount > 0;
    const blankPage = isBlankUrl(page.url()) || (!bodyHead && signals.cardCount === 0 && signals.chatButtonCount === 0);
    const looksLoggedOut = blankPage || Boolean(blocker) || page.url().includes("/web/user") || loginControlsVisible || (loginText && signals.cardCount === 0);

    if (looksLoggedOut) {
      return { ok: false, blocker: blocker || LOGIN_REQUIRED, signals, blankPage };
    }
    return { ok: true, signals, blankPage };
  }

  async inspectLoginState(page) {
    if (!page || page.isClosed()) {
      return { ok: false, blocker: "automation browser closed; run preflight again" };
    }

    await page.goto(LOGIN_CHECK_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
    await page.bringToFront().catch(() => {});

    const signals = await readLoginSignals(page);

    const bodyHead = normalizeText(signals.bodyHead);
    const blocker = detectSecurityBlocker(bodyHead);
    const loginText = /登录 \/ 注册|扫码登录|微信登录|手机号登录|密码登录|验证码登录|BOSS直聘 APP|请使用.*扫码/.test(bodyHead);
    const loginControlsVisible = signals.loginControlCount > 0;
    const looksLoggedOut = Boolean(blocker) || page.url().includes("/web/user") || loginControlsVisible || (loginText && signals.cardCount === 0);

    if (looksLoggedOut) {
      return { ok: false, blocker: blocker || LOGIN_REQUIRED, signals };
    }
    if (signals.cardCount > 0 || signals.chatButtonCount > 0) {
      return { ok: true, signals };
    }
    return { ok: false, blocker: LOGIN_REQUIRED, signals };
  }

  async openLoginPage(page) {
    if (!page || page.isClosed()) return false;
    await page.bringToFront().catch(() => {});
    let lastError = "";
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 }).catch((error) => {
      lastError = error.message;
      this.emitLog(`Login page navigation did not finish: ${error.message}`, "warn");
    });
    await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
    if (isBossPage(page.url())) {
      await page.bringToFront().catch(() => {});
      return true;
    }

    const shortcut = process.platform === "darwin" ? "Meta+L" : "Control+L";
    await page.bringToFront().catch(() => {});
    await page.keyboard.press(shortcut).catch((error) => {
      lastError = error.message;
    });
    await page.keyboard.type(LOGIN_URL, { delay: 1 }).catch((error) => {
      lastError = error.message;
    });
    await page.keyboard.press("Enter").catch((error) => {
      lastError = error.message;
    });
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
    await page.bringToFront().catch(() => {});
    if (isBossPage(page.url())) return true;

    this.emitLog(`Login page still not open; current URL: ${page.url()}${lastError ? `; last error: ${lastError}` : ""}`, "warn");
    return false;
  }

  async collectCards(page) {
    if (!page || page.isClosed()) {
      throw new Error("automation browser closed; run preflight again");
    }
    try {
      return await page
        .locator(".job-card-wrap, .job-list-box li, li[class*='job-card'], [class*='job-card']")
        .evaluateAll((nodes) =>
          nodes
            .filter((el) => {
              const rect = el.getBoundingClientRect();
              const text = el.innerText || "";
              return rect.width > 0 && rect.height > 0 && text.length > 20 && /java|后端|开发|K|薪/i.test(text);
            })
            .map((el, index) => {
              const lines = (el.innerText || "")
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean);
              const rect = el.getBoundingClientRect();
              return {
                index,
                title: lines[0] || "",
                salary: lines[1] || "",
                meta: lines.slice(2, 4).join(" "),
                company: lines[4] || "",
                location: lines.slice(5).join(" "),
                visible: rect.width > 0 && rect.height > 0,
              };
            }),
        )
        .then((cards) =>
          cards
            .filter((card) => card.visible)
            .map((card) => ({
              ...card,
              title: normalizeText(card.title),
              salary: normalizeText(card.salary),
              meta: normalizeText(card.meta),
              company: normalizeText(card.company),
              location: normalizeText(card.location),
            })),
        );
    } catch (error) {
      if (isBrowserClosedError(error)) {
        throw new Error("automation browser closed; run preflight again");
      }
      throw error;
    }
  }

  async clickCard(page, index) {
    const card = page.locator(".job-card-wrap").nth(index);
    await card.scrollIntoViewIfNeeded().catch(() => {});
    const title = card.locator("a.job-name").first();
    if (await title.count()) {
      await title.click({ timeout: 6000 });
    } else {
      await card.click({ timeout: 6000 });
    }
  }

  async readDetail(page) {
    return page.evaluate(() => {
      const box = document.querySelector(".job-detail-container") || document.querySelector(".job-detail-box");
      const text = box ? box.innerText || "" : document.body.innerText || "";
      const lines = text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const chat = box ? box.querySelector(".op-btn-chat") : document.querySelector(".op-btn-chat");
      return {
        title: lines[0] || "",
        salary: lines[1] || "",
        location: lines[2] || "",
        text: text.slice(0, 6000),
        chatText: chat ? chat.innerText || "" : "",
      };
    }).then((detail) => ({
      ...detail,
      title: normalizeText(detail.title),
      salary: normalizeText(detail.salary),
      location: normalizeText(detail.location),
      text: normalizeText(detail.text),
      chatText: normalizeText(detail.chatText),
    }));
  }

  async clickChat(page) {
    const blockerBefore = await this.detectPageBlocker(page);
    if (blockerBefore) return { ok: false, blocker: blockerBefore };
    const button = page.locator(".job-detail-container .op-btn-chat, .job-detail-box .op-btn-chat, .op-btn-chat").first();
    if (!(await button.count())) return { ok: false, reason: "no chat button" };
    const text = normalizeText(await button.innerText().catch(() => ""));
    if (/继续沟通|已沟通|已投递|已开聊/.test(text)) return { ok: false, reason: text };
    await button.scrollIntoViewIfNeeded().catch(() => {});
    await button.click({ timeout: 7000 });
    await delay(1200);
    const blockerAfter = await this.detectPageBlocker(page);
    if (blockerAfter) return { ok: false, blocker: blockerAfter };
    const afterText = normalizeText(await page.locator("body").innerText({ timeout: 5000 }).catch(() => ""));
    if (/今日沟通已达上限|沟通次数已用完|打招呼次数已达上限/.test(afterText)) {
      return { ok: false, blocker: "daily communication limit" };
    }
    return { ok: true, text: text || "立即沟通" };
  }

  async nextPage(page) {
    const next = page.locator(".options-pages a, .page a, .pagination a").filter({ hasText: /下一页|>/ }).last();
    if (!(await next.count())) return false;
    const disabled = await next.evaluate((node) => {
      const className = node.className || "";
      return /disabled|unable/.test(String(className)) || node.getAttribute("aria-disabled") === "true";
    }).catch(() => true);
    if (disabled) return false;
    await next.click({ timeout: 6000 });
    await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
    return true;
  }

  async block(runLog, blocker, page = null) {
    if (isLoginBlocker(blocker) && page && !page.isClosed()) {
      await this.openLoginPage(page);
    }
    await this.appendRun(runLog, `- Blocked: ${blocker}`);
    this.updateStatus({ state: "blocked", blocker, message: "Manual action required" });
    this.emitLog(`Blocked: ${blocker}`, "warn");
  }

  async appendRun(runLog, line) {
    await fs.appendFile(runLog, `${line}\n`, "utf8");
    this.emit("runLine", { line, at: nowIso() });
  }
}

function candidateKey(candidate) {
  return [candidate.company, candidate.title, candidate.salary, candidate.location].map((part) => normalizeText(part)).join("|");
}

function formatCandidate(candidate) {
  return [candidate.company, candidate.title, candidate.salary, candidate.location].map((part) => normalizeText(part || "-")).join(" | ");
}

function selectBestPage(pages = []) {
  const openPages = pages.filter((page) => page && !page.isClosed());
  return (
    openPages.find((page) => isBossPage(page.url()) && !page.url().includes("/web/user")) ||
    openPages.find((page) => isBossPage(page.url())) ||
    openPages.find((page) => !isBlankUrl(page.url())) ||
    openPages[0] ||
    null
  );
}

function isBrowserClosedError(error) {
  return /Target page, context or browser has been closed|Browser has been closed|Target closed|Page closed|automation browser closed/i.test(
    String(error?.message || error || ""),
  );
}

function isProfileInUseError(error) {
  return /BROWSER_PROFILE_IN_USE|正在现有的浏览器会话中打开|ProcessSingleton|SingletonLock|user data directory is already in use|profile.*in use/i.test(
    String(error?.code || "") + "\n" + String(error?.message || error || "") + "\n" + String(error?.cause?.message || ""),
  );
}

function isLoginBlocker(blocker) {
  return /login|captcha|security|登录|扫码|验证码|安全验证/i.test(String(blocker || ""));
}

function isBossPage(url) {
  return /^https?:\/\/([^/]+\.)?zhipin\.com\//i.test(String(url || ""));
}

function isJobSearchPage(url) {
  return isBossPage(url) && String(url || "").includes("/web/geek/jobs");
}

function isSameSearchUrl(left, right) {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return a.pathname === b.pathname && a.searchParams.get("query") === b.searchParams.get("query") && a.searchParams.get("city") === b.searchParams.get("city");
  } catch {
    return left === right;
  }
}

function isBlankUrl(url) {
  return /^(about:blank|chrome:\/\/newtab\/?|)$/i.test(String(url || ""));
}

async function readLoginSignals(page) {
  return page
    .evaluate(() => {
      const visibleText = (document.body.innerText || "").replace(/\s+/g, " ").trim();
      const bodyHead = visibleText.slice(0, 3000);
      const cardCount = document.querySelectorAll(".job-card-wrap").length;
      const chatButtonCount = document.querySelectorAll(".op-btn-chat").length;
      const loginControlCount = [...document.querySelectorAll("a, button, .btn, .nav-item, .login-btn, .header-login")]
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          const text = (el.innerText || "").replace(/\s+/g, " ").trim();
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            !/分享|招聘|职位|注册工程师|注册会计|药品注册/.test(text) &&
            /登录|验证码|手机号登录|扫码登录|微信登录|登录 \/ 注册/.test(text)
          );
        })
        .length;
      return { bodyHead, cardCount, chatButtonCount, loginControlCount };
    })
    .catch(() => ({ bodyHead: "", cardCount: 0, chatButtonCount: 0, loginControlCount: 0 }));
}

async function inspectLoginDebugPage({ navigate = false } = {}) {
  if (!(await isLoginDebugReady())) return null;
  const target = await findBestDebugPageTarget();
  if (!target?.webSocketDebuggerUrl) return null;
  const client = await createCdpClient(target.webSocketDebuggerUrl);
  try {
    await client.send("Runtime.enable").catch(() => {});
    await client.send("Page.enable").catch(() => {});
    if (navigate) {
      await client.send("Page.navigate", { url: LOGIN_CHECK_URL }).catch(() => {});
      await delay(3500);
    }
    const result = await client.send("Runtime.evaluate", {
      expression: `(() => {
        const visibleText = (document.body?.innerText || "").replace(/\\s+/g, " ").trim();
        const bodyHead = visibleText.slice(0, 4000);
        const controls = [...document.querySelectorAll("a, button, .btn, .nav-item, .login-btn, .header-login, [class*=login]")]
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            const text = (el.innerText || "").replace(/\\s+/g, " ").trim();
            return rect.width > 0 && rect.height > 0 && !/分享|招聘|职位|注册工程师|注册会计|药品注册/.test(text) && /登录|验证码|手机号登录|扫码登录|微信登录|登录 \\/ 注册/.test(text);
          });
        return {
          url: location.href,
          title: document.title,
          bodyHead,
          cardCount: document.querySelectorAll(".job-card-wrap").length,
          chatButtonCount: document.querySelectorAll(".op-btn-chat").length,
          loginControlCount: controls.length
        };
      })()`,
      returnByValue: true,
    });
    return result?.result?.value || null;
  } finally {
    client.close();
  }
}

async function createCdpAutomationPage() {
  const target = await findBestDebugPageTarget();
  if (!target?.webSocketDebuggerUrl) {
    throw new Error("没有找到可复用的 BOSS 浏览器页，请先点击打开登录并完成登录");
  }
  return connectCdpTarget(target);
}

async function connectCdpTarget(target) {
  const client = await createCdpClient(target.webSocketDebuggerUrl);
  await client.send("Runtime.enable").catch(() => {});
  await client.send("Page.enable").catch(() => {});
  return {
    targetId: target.id,
    send: client.send,
    close: client.close,
  };
}

async function listDebugPageTargets() {
  const response = await fetch(`${LOGIN_DEBUG_URL}/json/list`, { signal: AbortSignal.timeout(1500) });
  if (!response.ok) return [];
  const targets = await response.json();
  return targets.filter((target) => target.type === "page");
}

async function waitForDebugTarget(predicate, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const target = (await listDebugPageTargets().catch(() => [])).find(predicate);
    if (target?.webSocketDebuggerUrl) return target;
    await delay(300);
  }
  return null;
}

async function openDebugUrl(url) {
  const encoded = encodeURIComponent(url);
  const response = await fetch(`${LOGIN_DEBUG_URL}/json/new?${encoded}`, {
    method: "PUT",
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`无法打开 BOSS 搜索页: ${response.status}`);
  const opened = await response.json().catch(() => null);
  const target =
    (await waitForDebugTarget((candidate) => candidate.id === opened?.id || candidate.url === url || isJobSearchPage(candidate.url), 10000)) ||
    opened;
  if (!target?.webSocketDebuggerUrl) throw new Error("BOSS 搜索页没有保持打开");
  await fetch(`${LOGIN_DEBUG_URL}/json/activate/${target.id}`, { signal: AbortSignal.timeout(1500) }).catch(() => {});
  await activateChromeApp().catch(() => {});
  return connectCdpTarget(target);
}

async function cdpEvaluate(page, fn, ...args) {
  const expression = `(${fn.toString()})(...${JSON.stringify(args)})`;
  const result = await page.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return result?.result?.value;
}

async function waitForSearchDom(page) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const ready = await cdpEvaluate(page, () => {
      const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
      return {
        state: document.readyState,
        textLength: text.length,
        text: text.slice(0, 160),
        cardCount: document.querySelectorAll(".job-card-wrap, .job-list-box li, li[class*='job-card'], [class*='job-card']").length,
      };
    }).catch(() => ({ state: "", textLength: 0, text: "", cardCount: 0 }));
    const loadingOnly = ready.textLength < 40 && /loading|加载中|请稍候/i.test(String(ready.text || ""));
    if (ready.cardCount > 0) return ready;
    if (!loadingOnly && ready.textLength > 120 && /职位|暂无|没有找到|登录|安全验证|验证码/.test(String(ready.text || ""))) return ready;
    await delay(500);
  }
  return { state: "", textLength: 0, text: "", cardCount: 0 };
}

async function cdpGotoSearch(page, query, city) {
  const url = `${SEARCH_BASE}?query=${encodeURIComponent(query)}&city=${encodeURIComponent(city.code || city.key || city.label)}`;
  const currentUrl = await cdpEvaluate(page, () => location.href).catch(() => "");
  let activePage = page;

  if (!isJobSearchPage(currentUrl)) {
    activePage = await openDebugUrl(url);
    page.close();
  } else if (isSameSearchUrl(currentUrl, url)) {
    await waitForSearchDom(activePage);
  } else {
    await activePage.send("Page.navigate", { url }).catch(() => {});
    await delay(5000);
    const currentTarget = await waitForDebugTarget((target) => target.id === activePage.targetId, 5000);
    if (!currentTarget?.webSocketDebuggerUrl) {
      const fallbackTarget = await waitForDebugTarget((target) => isJobSearchPage(target.url), 3000);
      activePage.close();
      activePage = fallbackTarget?.webSocketDebuggerUrl ? await connectCdpTarget(fallbackTarget) : await openDebugUrl(url);
    }
  }

  await waitForSearchDom(activePage);
  await cdpEvaluate(activePage, () => {
    window.scrollBy(0, 320);
    return true;
  }).catch(() => {});
  await delay(1200);
  return activePage;
}

async function cdpBodyText(page) {
  return (
    (await cdpEvaluate(page, () => {
      return (document.body?.innerText || "").replace(/\s+/g, " ").trim();
    }).catch(() => "")) || ""
  );
}

async function cdpDetectPageBlocker(page) {
  return detectSecurityBlocker(await cdpBodyText(page));
}

async function cdpCollectCards(page) {
  const cards =
    (await cdpEvaluate(page, () => {
      const primary = [...document.querySelectorAll(".job-card-wrap")];
      const fallback = [...document.querySelectorAll(".job-list-box li, li[class*='job-card'], [class*='job-card']")].filter(
        (el) => !el.closest(".job-card-wrap"),
      );
      const nodes = primary.length ? primary : fallback;
      const seen = new Set();
      return nodes
        .filter((el) => {
          if (seen.has(el)) return false;
          seen.add(el);
          const rect = el.getBoundingClientRect();
          const text = el.innerText || "";
          return rect.width > 0 && rect.height > 0 && text.length > 20 && /java|后端|开发|K|薪/i.test(text);
        })
        .slice(0, 80)
        .map((el, index) => {
          const domIndex = `codex-job-${Date.now()}-${index}`;
          el.setAttribute("data-codex-job-index", domIndex);
          const lines = (el.innerText || "")
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
          const titleNode = el.querySelector(".job-name, [class*='job-name'], [class*='job-title'], a");
          const title = (titleNode?.innerText || lines[0] || "").trim();
          const salary = (el.querySelector(".salary, [class*='salary']")?.innerText || lines[1] || "").trim();
          return {
            index,
            domIndex,
            title,
            salary,
            meta: lines.slice(2, 5).join(" "),
            company: lines[4] || lines[5] || "",
            location: lines.slice(5, 9).join(" "),
            visible: true,
          };
        });
    }).catch(() => [])) || [];

  return cards.map((card) => ({
    ...card,
    title: normalizeText(card.title),
    salary: normalizeText(card.salary),
    meta: normalizeText(card.meta),
    company: normalizeText(card.company),
    location: normalizeText(card.location),
  }));
}

async function cdpClickCard(page, domIndex) {
  await cdpEvaluate(page, (targetIndex) => {
    const card = document.querySelector(`[data-codex-job-index="${targetIndex}"]`);
    if (!card) return false;
    card.scrollIntoView({ block: "center", inline: "nearest" });
    const clickable = card.querySelector("a.job-name, [class*='job-name'], a") || card;
    clickable.click();
    return true;
  }, domIndex);
  await delay(1000);
}

async function cdpReadDetail(page) {
  const detail =
    (await cdpEvaluate(page, () => {
      const box = document.querySelector(".job-detail-container") || document.querySelector(".job-detail-box") || document.body;
      const text = box ? box.innerText || "" : document.body.innerText || "";
      const lines = text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const chat =
        box.querySelector?.(".op-btn-chat") ||
        [...document.querySelectorAll("button, a, .btn, [class*='chat']")].find((el) => /立即沟通|继续沟通|已沟通|已投递|开聊/.test(el.innerText || ""));
      return {
        title: lines[0] || "",
        salary: lines[1] || "",
        location: lines[2] || "",
        text: text.slice(0, 6000),
        chatText: chat ? chat.innerText || "" : "",
      };
    }).catch(() => ({ title: "", salary: "", location: "", text: "", chatText: "" }))) || {};

  return {
    ...detail,
    title: normalizeText(detail.title),
    salary: normalizeText(detail.salary),
    location: normalizeText(detail.location),
    text: normalizeText(detail.text),
    chatText: normalizeText(detail.chatText),
  };
}

async function cdpClickChat(page) {
  const blockerBefore = await cdpDetectPageBlocker(page);
  if (blockerBefore) return { ok: false, blocker: blockerBefore };
  let result = { ok: false, reason: "no chat button" };
  for (let attempt = 0; attempt < 12; attempt += 1) {
    result =
      (await cdpEvaluate(page, () => {
        const candidates = [
          ...document.querySelectorAll(".job-detail-container .op-btn-chat, .job-detail-box .op-btn-chat, .op-btn-chat, button, a, .btn, [class*='chat']"),
        ].filter((el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && /立即沟通|继续沟通|已沟通|已投递|开聊/.test(el.innerText || "");
        });
        const button = candidates[0];
        if (!button) return { ok: false, reason: "no chat button" };
        const text = (button.innerText || "").trim();
        if (/继续沟通|已沟通|已投递|已开聊/.test(text)) return { ok: false, reason: text };
        button.scrollIntoView({ block: "center", inline: "nearest" });
        button.click();
        return { ok: true, text };
      }).catch((error) => ({ ok: false, reason: error.message }))) || { ok: false, reason: "no chat button" };
    if (result.ok || result.reason !== "no chat button") break;
    await delay(500);
  }

  if (!result.ok) return result;
  await delay(1400);
  const blockerAfter = await cdpDetectPageBlocker(page);
  if (blockerAfter) return { ok: false, blocker: blockerAfter };
  const afterText = normalizeText(await cdpBodyText(page));
  if (/今日沟通已达上限|沟通次数已用完|打招呼次数已达上限/.test(afterText)) {
    return { ok: false, blocker: "daily communication limit" };
  }
  const afterButton =
    (await cdpEvaluate(page, () => {
      const button = [...document.querySelectorAll(".job-detail-container .op-btn-chat, .job-detail-box .op-btn-chat, .op-btn-chat, button, a, .btn, [class*='chat']")]
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && /立即沟通|继续沟通|已沟通|已投递|已开聊|开聊/.test(el.innerText || "");
        })
        .at(0);
      return (button?.innerText || "").trim();
    }).catch(() => "")) || "";
  return { ok: true, text: result.text || afterButton || "立即沟通", afterText: normalizeText(afterButton) };
}

async function cdpNextPage(page) {
  const moved = await cdpEvaluate(page, () => {
    const candidates = [...document.querySelectorAll(".options-pages a, .page a, .pagination a, a, button")].filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && /下一页|>/.test(el.innerText || el.textContent || "");
    });
    const next = candidates[candidates.length - 1];
    if (!next) return false;
    const className = next.className || "";
    if (/disabled|unable/.test(String(className)) || next.getAttribute("aria-disabled") === "true") return false;
    next.click();
    return true;
  }).catch(() => false);
  if (moved) await delay(2500);
  return Boolean(moved);
}

function analyzeLoginSignals(signals = {}) {
  const bodyHead = normalizeText(signals.bodyHead || "");
  const blocker = detectSecurityBlocker(bodyHead);
  const url = String(signals.url || "");
  const title = normalizeText(signals.title || "");
  const loginText = /登录 \/ 注册|扫码登录|微信登录|手机号登录|密码登录|验证码登录|BOSS直聘 APP|请使用.*扫码/.test(bodyHead);
  const loginControlsVisible = Number(signals.loginControlCount || 0) > 0;
  const blankPage = isBlankUrl(url) && !title && !bodyHead;
  const jobSurfaceVisible = Number(signals.cardCount || 0) > 0 || Number(signals.chatButtonCount || 0) > 0;
  const loggedInSurface =
    isBossPage(url) &&
    !url.includes("/web/user") &&
    !loginControlsVisible &&
    !loginText &&
    bodyHead.length > 30 &&
    /职位|搜索|推荐|沟通|消息|简历|我的|BOSS直聘/.test(bodyHead);

  if (blankPage) return { ok: false, blocker: LOGIN_REQUIRED, blankPage };
  if (blocker) return { ok: false, blocker, blankPage };
  if (url.includes("/web/user") || loginControlsVisible || loginText) {
    return { ok: false, blocker: LOGIN_REQUIRED, blankPage };
  }
  if (jobSurfaceVisible || loggedInSurface) {
    return { ok: true, blankPage };
  }
  return { ok: false, blocker: LOGIN_REQUIRED, blankPage };
}

async function findBestDebugPageTarget() {
  const response = await fetch(`${LOGIN_DEBUG_URL}/json/list`, { signal: AbortSignal.timeout(1500) });
  if (!response.ok) return null;
  const targets = await response.json();
  const pages = targets.filter((target) => target.type === "page");
  return (
    pages.find((target) => isJobSearchPage(target.url)) ||
    pages.find((target) => isBossPage(target.url) && !target.url.includes("/web/user")) ||
    pages.find((target) => isBossPage(target.url) || /BOSS直聘/.test(String(target.title || ""))) ||
    pages.find((target) => !isBlankUrl(target.url)) ||
    pages[0] ||
    null
  );
}

function createCdpClient(webSocketUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const pending = new Map();
    let id = 0;
    const rejectAll = (error) => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      pending.clear();
    };

    socket.once("open", () => {
      resolve({
        send(method, params = {}, timeoutMs = 6000) {
          id += 1;
          const messageId = id;
          return new Promise((messageResolve, messageReject) => {
            const timer = setTimeout(() => {
              pending.delete(messageId);
              messageReject(new Error(`CDP ${method} timed out`));
            }, timeoutMs);
            pending.set(messageId, { resolve: messageResolve, reject: messageReject, timer });
            socket.send(JSON.stringify({ id: messageId, method, params }), (error) => {
              if (!error) return;
              clearTimeout(timer);
              pending.delete(messageId);
              messageReject(error);
            });
          });
        },
        close() {
          socket.close();
        },
      });
    });

    socket.on("message", (data) => {
      let payload;
      try {
        payload = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!payload.id || !pending.has(payload.id)) return;
      const entry = pending.get(payload.id);
      pending.delete(payload.id);
      clearTimeout(entry.timer);
      if (payload.error) {
        entry.reject(new Error(payload.error.message || JSON.stringify(payload.error)));
      } else {
        entry.resolve(payload.result || {});
      }
    });

    socket.once("error", (error) => {
      reject(error);
      rejectAll(error);
    });
    socket.once("close", () => {
      rejectAll(new Error("CDP socket closed"));
    });
  });
}

async function launchLoginChrome(profileDir) {
  const args = [
    `--remote-debugging-port=${LOGIN_DEBUG_PORT}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    LOGIN_URL,
  ];
  if (process.platform === "darwin") {
    await spawnDetached("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", args);
    return;
  }
  if (process.platform === "win32") {
    await spawnDetached("cmd", ["/c", "start", "", "chrome", ...args]);
    return;
  }
  await spawnDetached("google-chrome", args).catch(() => spawnDetached("chromium", args));
}

async function isLoginDebugReady() {
  try {
    const response = await fetch(`${LOGIN_DEBUG_URL}/json/version`, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForLoginDebug(timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await isLoginDebugReady()) return true;
    await delay(250);
  }
  throw new Error("普通 Chrome 登录窗口启动超时");
}

async function openUrlInLoginChrome(url) {
  const existing = (await findLoginChromeTab(url).catch(() => null)) || (await waitForLoginTab(url, 3000).catch(() => null));
  if (existing?.id) {
    await closeDistractingLoginTabs(existing.id, url).catch(() => {});
    await fetch(`${LOGIN_DEBUG_URL}/json/activate/${existing.id}`, { signal: AbortSignal.timeout(1500) }).catch(() => {});
    await activateChromeApp().catch(() => {});
    return waitForLoginTab(url, 4000);
  }

  const encoded = encodeURIComponent(url);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(`${LOGIN_DEBUG_URL}/json/new?${encoded}`, {
        method: "PUT",
        signal: AbortSignal.timeout(2500),
      });
      if (response.ok) {
        const opened = await waitForLoginTab(url, 5000);
        if (opened?.id) {
          await closeDistractingLoginTabs(opened.id, url).catch(() => {});
          await fetch(`${LOGIN_DEBUG_URL}/json/activate/${opened.id}`, { signal: AbortSignal.timeout(1500) }).catch(() => {});
          await activateChromeApp().catch(() => {});
          return opened;
        }
      }
    } catch {
      // Retry below; Chrome may report the target before it appears in /json/list.
    }
    await delay(500);
  }
  const reusable = await findReusableBlankTab().catch(() => null);
  if (reusable?.webSocketDebuggerUrl) {
    const client = await createCdpClient(reusable.webSocketDebuggerUrl);
    try {
      await client.send("Page.enable").catch(() => {});
      await client.send("Page.navigate", { url }).catch(() => {});
      const opened = await waitForLoginTab(url, 6000);
      if (opened?.id) {
        await fetch(`${LOGIN_DEBUG_URL}/json/activate/${opened.id}`, { signal: AbortSignal.timeout(1500) }).catch(() => {});
        await activateChromeApp().catch(() => {});
        return opened;
      }
    } finally {
      client.close();
    }
  }
  return null;
}

async function findLoginChromeTab(url) {
  const response = await fetch(`${LOGIN_DEBUG_URL}/json/list`, { signal: AbortSignal.timeout(1500) });
  if (!response.ok) return null;
  const tabs = await response.json();
  return (
    tabs.find((tab) => tab.type === "page" && tab.url === url) ||
    tabs.find((tab) => tab.type === "page" && isBossPage(tab.url) && /登录|用户|user|BOSS直聘/i.test(String(tab.title || tab.url || ""))) ||
    tabs.find((tab) => tab.type === "page" && isBossPage(tab.url)) ||
    null
  );
}

async function waitForLoginTab(url, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tab = await findLoginChromeTab(url).catch(() => null);
    if (tab?.id) return tab;
    await delay(250);
  }
  return null;
}

async function closeDistractingLoginTabs(keepId, url) {
  const response = await fetch(`${LOGIN_DEBUG_URL}/json/list`, { signal: AbortSignal.timeout(1500) });
  if (!response.ok) return;
  const tabs = await response.json();
  const duplicates = tabs.filter(
    (tab) => tab.type === "page" && tab.id !== keepId && (tab.url === url || isBlankUrl(tab.url)),
  );
  for (const tab of duplicates) {
    await fetch(`${LOGIN_DEBUG_URL}/json/close/${tab.id}`, { signal: AbortSignal.timeout(1000) }).catch(() => {});
  }
}

async function findReusableBlankTab() {
  const response = await fetch(`${LOGIN_DEBUG_URL}/json/list`, { signal: AbortSignal.timeout(1500) });
  if (!response.ok) return null;
  const tabs = await response.json();
  return tabs.find((tab) => tab.type === "page" && isBlankUrl(tab.url)) || null;
}

async function closeChromeForProfile(profileDir) {
  if (process.platform === "win32") {
    const escaped = profileDir.replace(/'/g, "''");
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${escaped}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
    ]).catch(() => {});
    return;
  }

  const psArgs = process.platform === "darwin" ? ["-axo", "pid=,command="] : ["-eo", "pid=,command="];
  const { stdout } = await execFileAsync("ps", psArgs);
  const ownChromePids = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => isChromeProcessLine(line))
    .filter((line) => line.includes(profileDir))
    .map((line) => Number(line.match(/^\d+/)?.[0]))
    .filter(Boolean)
    .filter((pid) => pid !== process.pid);
  for (const pid of ownChromePids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already exited.
    }
  }
  if (ownChromePids.length) await delay(800);
  for (const pid of ownChromePids) {
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGKILL");
    } catch {
      // Already exited.
    }
  }
}

function isChromeProcessLine(line) {
  if (process.platform === "darwin") {
    return /^\d+\s+\/Applications\/Google Chrome\.app\//.test(line);
  }
  return /^\d+\s+.*\b(chrome|chromium|google-chrome)\b/i.test(line);
}

async function activateChromeApp() {
  if (process.platform !== "darwin") return;
  await execFileAsync("osascript", ["-e", 'tell application "Google Chrome" to activate']);
}

function spawnDetached(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    let settled = false;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.unref();
    setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve();
    }, 250);
  });
}
