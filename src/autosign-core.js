import { COURSES, ZJUAM } from "login-zju";
import { v4 as uuidv4 } from "uuid";
import Decimal from "decimal.js";
import "dotenv/config";

class AuthExpiredError extends Error {}

// 简易基于 Cookie 的课程客户端
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * 基于 Cookie 的课程客户端
 * 用于极致安全模式：Cookie 在服务器端通过密码登录获取，密码随后销毁
 */
class CookieCourses {
  constructor(cookie) {
    this.cookie = cookie;
  }

  async fetch(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    headers.Cookie = headers.Cookie || this.cookie;
    headers["User-Agent"] = headers["User-Agent"] || DEFAULT_UA;
    
    const resp = await fetch(url, { ...options, headers, redirect: "manual" });
    
    // 检测登录失效
    if (resp.status === 401 || resp.status === 403) {
      throw new AuthExpiredError(`认证失败: ${resp.status}`);
    }
    
    const location = resp.headers.get("location") || "";
    if (resp.status >= 300 && resp.status < 400) {
      if (location.includes("identity.zju.edu.cn") || location.includes("login")) {
        throw new AuthExpiredError("Cookie 已失效，需要重新授权");
      }
    }
    
    return resp;
  }
}

// 默认雷达坐标
const DEFAULT_RADER_INFO = {
  ZJGD1: [120.089136, 30.302331], // 东一教学楼
  ZJGX1: [120.085042, 30.30173], // 西教学楼
  ZJGB1: [120.077135, 30.305142], // 段永平教学楼
  YQ4: [120.122176, 30.261555], // 玉泉教四
  YQ1: [120.123853, 30.262544], // 玉泉教一
  YQ7: [120.120344, 30.263907], // 玉泉教七
  ZJ1: [120.126008, 30.192908], // 之江校区1
  HJC1: [120.195939, 30.272068], // 华家池校区1
  HJC2: [120.198193, 30.270419], // 华家池校区2
  ZJ2: [120.124267, 30.19139], // 之江校区2
  YQSS: [120.124001, 30.265735], // 宿舍点
  ZJG4: [120.073427, 30.299757], // 紫金港大西区
};

Decimal.set({ precision: 100 });

function decimalHaversineDist(lon, lat, lon_i, lat_i, R) {
  const DEG = Decimal.acos(-1).div(180);

  const λ = new Decimal(lon).mul(DEG);
  const φ = new Decimal(lat).mul(DEG);
  const λi = new Decimal(lon_i).mul(DEG);
  const φi = new Decimal(lat_i).mul(DEG);

  const dφ = φ.minus(φi);
  const dλ = λ.minus(λi);

  const sin_dφ_2 = dφ.div(2).sin().pow(2);
  const sin_dλ_2 = dλ.div(2).sin().pow(2);

  const h = sin_dφ_2.plus(φ.cos().mul(φi.cos()).mul(sin_dλ_2));
  const deltaSigma = Decimal.asin(h.sqrt()).mul(2);

  return R.mul(deltaSigma);
}

function residualsDecimal(lon, lat, pts, R) {
  const res = [];
  for (const p of pts) {
    const dist = decimalHaversineDist(lon, lat, p.lon, p.lat, R);
    res.push(new Decimal(p.d).minus(dist));
  }
  return res;
}

function jacobianDecimal(lon, lat, pts, R) {
  const eps = new Decimal("1e-12");
  const base = residualsDecimal(lon, lat, pts, R);

  const resLon = residualsDecimal(new Decimal(lon).plus(eps), lat, pts, R);
  const resLat = residualsDecimal(lon, new Decimal(lat).plus(eps), pts, R);

  const J = [];
  for (let i = 0; i < pts.length; i++) {
    const dLon = resLon[i].minus(base[i]).div(eps).neg();
    const dLat = resLat[i].minus(base[i]).div(eps).neg();
    J.push([dLon, dLat]);
  }
  return J;
}

function gaussNewtonDecimal(pts, lon0, lat0, R) {
  let lon = new Decimal(lon0);
  let lat = new Decimal(lat0);

  for (let iter = 0; iter < 30; iter++) {
    const r = residualsDecimal(lon, lat, pts, R);
    const J = jacobianDecimal(lon, lat, pts, R);

    let JTJ = [
      [new Decimal(0), new Decimal(0)],
      [new Decimal(0), new Decimal(0)],
    ];
    let JTr = [new Decimal(0), new Decimal(0)];

    for (let i = 0; i < pts.length; i++) {
      const j = J[i];
      const ri = r[i];

      JTJ[0][0] = JTJ[0][0].plus(j[0].mul(j[0]));
      JTJ[0][1] = JTJ[0][1].plus(j[0].mul(j[1]));
      JTJ[1][0] = JTJ[1][0].plus(j[1].mul(j[0]));
      JTJ[1][1] = JTJ[1][1].plus(j[1].mul(j[1]));

      JTr[0] = JTr[0].plus(j[0].mul(ri));
      JTr[1] = JTr[1].plus(j[1].mul(ri));
    }

    const det = JTJ[0][0].mul(JTJ[1][1]).minus(JTJ[0][1].mul(JTJ[1][0]));

    const inv = [
      [JTJ[1][1].div(det), JTJ[0][1].neg().div(det)],
      [JTJ[1][0].neg().div(det), JTJ[0][0].div(det)],
    ];

    const dLon = inv[0][0].mul(JTr[0]).plus(inv[0][1].mul(JTr[1]));
    const dLat = inv[1][0].mul(JTr[0]).plus(inv[1][1].mul(JTr[1]));

    lon = lon.plus(dLon);
    lat = lat.plus(dLat);

    if (dLon.abs().lt("1e-14") && dLat.abs().lt("1e-14")) break;
  }

  return { lon, lat };
}

function rmsDecimal(lon, lat, pts, R) {
  let sum = new Decimal(0);
  for (const p of pts) {
    const dModel = decimalHaversineDist(lon, lat, p.lon, p.lat, R);
    const diff = new Decimal(p.d).minus(dModel);
    sum = sum.plus(diff.mul(diff));
  }
  return sum.div(pts.length).sqrt();
}

function solveSphereLeastSquaresDecimal(rawPoints) {
  const lon0 =
    rawPoints.reduce((sum, p) => sum + p.lon, 0) / rawPoints.length;
  const lat0 =
    rawPoints.reduce((sum, p) => sum + p.lat, 0) / rawPoints.length;

  const R = new Decimal("6372999.26");

  const res = gaussNewtonDecimal(rawPoints, lon0, lat0, R);
  const rms = rmsDecimal(res.lon, res.lat, rawPoints, R);

  return {
    lon: Number(res.lon),
    lat: Number(res.lat),
    rms: Number(rms),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class AutoSignCore {
  constructor({
    userId,
    username,
    password,
    cookie,
    authMode = "password_persist",
    dingTalk,
    logger,
    raderAt = "ZJGD1",
    coldDownTime = 4000,
    raderInfo = DEFAULT_RADER_INFO,
    logEmptyRollcall = false,
    debug = false,
    onAuthExpired,
    onAuthRecovered,
  }) {
    this.userId = userId;
    this.username = username;
    this.password = password;
    this.cookie = cookie;
    this.authMode = authMode;
    this.dingTalk = dingTalk;
    this.logger = logger;
    this.debug = !!debug;
    this.config = {
      raderAt,
      coldDownTime,
      raderInfo,
      logEmptyRollcall: !!logEmptyRollcall,
    };
    this._buildCoursesClient();
    this.running = false;
    this._starting = false; // 防止重复启动
    this.reqNum = 0;
    this.weAreBruteforcing = [];
    this.currentBatchingRCs = [];
    this.loopPromise = null;
    this.authExpired = false;
    this.onAuthExpired = onAuthExpired;
    this.onAuthRecovered = onAuthRecovered;
  }

  _buildCoursesClient() {
    if (this.authMode === "secure_cookie") {
      // 极致安全模式：使用服务器端获取的 Cookie
      if (!this.cookie) {
        throw new Error("极致安全模式需要有效的 Cookie，请重新授权");
      }
      this.courses = new CookieCourses(this.cookie);
    } else {
      // 省心模式：使用密码登录（login-zju 库）
      if (!this.username || !this.password) {
        throw new Error("省心模式需要用户名和密码");
      }
      this.courses = new COURSES(new ZJUAM(this.username, this.password));
    }
  }

  async start() {
    // 防止重复启动：检查是否已在运行或正在启动中
    if (this.running || this._starting) return;
    this._starting = true;
    
    try {
      // 确保 courses 实例已创建（不显式调用 login，让 fetch 自动管理）
      const ok = await this._ensureAuthenticated(true);
      if (!ok) {
        await this.logWarn("[Auto Sign-in] 登录状态不可用，已暂停，请重新授权。");
        return;
      }
      this.running = true;
      await this.logInfo(`[Auto Sign-in][${this.username}] 任务已启动，首次请求时将自动登录。`);
      this.loopPromise = this.runLoop();
    } finally {
      this._starting = false;
    }
  }

  async stop() {
    // 防止重复停止
    if (!this.running && !this.loopPromise) return;
    this.running = false;
    // 等待当前循环自然结束
    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = null;
    }
  }

  getStatus() {
    return {
      running: this.running,
      raderAt: this.config.raderAt,
      coldDownTime: this.config.coldDownTime,
    };
  }

  async sendBoth(msg) {
    // 兼容旧调用，作为 info 级别
    return this.logInfo(msg);
  }

  async logInfo(msg) {
    if (this.logger) return this.logger.info(msg);
    console.log(msg);
  }

  async logSuccess(msg) {
    if (this.logger) return this.logger.success(msg);
    console.log(msg);
    if (this.dingTalk) {
      try {
        await this.dingTalk(msg);
      } catch (e) {
        console.error("[Auto Sign-in] DingTalk failed:", e);
      }
    }
  }

  async logWarn(msg) {
    if (this.logger) return this.logger.warn(msg);
    console.warn(msg);
    if (this.dingTalk) {
      try {
        await this.dingTalk(msg);
      } catch (e) {
        console.error("[Auto Sign-in] DingTalk failed:", e);
      }
    }
  }

  async logError(msg) {
    if (this.logger) return this.logger.error(msg);
    console.error(msg);
    if (this.dingTalk) {
      try {
        await this.dingTalk(msg);
      } catch (e) {
        console.error("[Auto Sign-in] DingTalk failed:", e);
      }
    }
  }

  async runLoop() {
    while (this.running) {
      const reqId = ++this.reqNum;
      const shouldLogToPanel = this.debug || this.config.logEmptyRollcall;
      try {
        const rollcalls = await this.fetchRollcalls();
        if (!rollcalls || rollcalls.length === 0) {
          // 始终输出到控制台（pm2 logs），方便后台监控
          console.log(`[Auto Sign-in][${this.username}](Req #${reqId}) No rollcalls found.`);
          // 仅当配置开启时才写入用户日志（显示在面板）
          if (shouldLogToPanel) {
            await this.logInfo(`[Auto Sign-in](Req #${reqId}) No rollcalls found.`);
          }
        } else {
          await this.logInfo(
            `[Auto Sign-in](Req #${reqId}) Found ${rollcalls.length} rollcalls.`
          );
          rollcalls.forEach((rollcall) => this.handleRollcall(rollcall));
        }
      } catch (e) {
        if (e instanceof AuthExpiredError) {
          await this._handleAuthExpired(e.message);
          // 尝试恢复；失败则退出循环等待外部干预
          const recovered = await this._tryRecoverAuth();
          if (!recovered) {
            await this.logWarn("[Auto Sign-in] 登录状态失效且恢复失败，已暂停运行。");
            this.running = false;
            break;
          }
          continue;
        }
        // 静默失败，不记录到日志也不推送钉钉（避免刷屏）
        console.log(`[Auto Sign-in](Req #${reqId}) Failed to fetch rollcalls: ${e}`);
      }
      // 如果已收到停止指令，立刻退出，不再等待冷却时间
      if (!this.running) break;
      await sleep(this.config.coldDownTime);
    }
  }

  async fetchRollcalls() {
    const resp = await this.courses.fetch("https://courses.zju.edu.cn/api/radar/rollcalls");
    // 登录失效处理：重定向到登录页或 401/403
    if (resp.status === 401 || resp.status === 403) {
      throw new AuthExpiredError(`status=${resp.status}`);
    }
    const location = resp.headers.get("location") || "";
    if (resp.status >= 300 && resp.status < 400) {
      if (location.includes("identity.zju.edu.cn") || location.includes("login")) {
        // 详细日志帮助调试
        console.log(`[Auto Sign-in] 认证失效详情: status=${resp.status}, location=${location.slice(0, 100)}`);
        throw new AuthExpiredError(`redirect to SSO (${resp.status})`);
      }
    }
    const respText = await resp.text();
    try {
      const parsed = JSON.parse(respText);
      return parsed.rollcalls || [];
    } catch (e) {
      await this.sendBoth(
        "[-][Auto Sign-in] Something went wrong: " + respText + "\nError: " + e.toString()
      );
      return [];
    }
  }

  handleRollcall(rollcall) {
    const rollcallId = rollcall.rollcall_id;
    if (
      rollcall.status === "on_call_fine" ||
      rollcall.status === "on_call" ||
      rollcall.status_name === "on_call_fine" ||
      rollcall.status_name === "on_call"
    ) {
      this.logInfo("[Auto Sign-in] Note that #" + rollcallId + " is on call.");
      return;
    }
    this.logInfo("[Auto Sign-in] Now answering rollcall #" + rollcallId);
    // 注意：不在这里发送 logSuccess，因为签到尚未完成
    // 真正的成功消息会在 answerRaderRollcall / batchNumberRollCall 中签到成功后发送
    this.logInfo(`[Rollcall] 检测到签到: 课程 ${rollcall.course_title || ''} - ${rollcall.title || ''}`.trim());

    if (rollcall.is_radar) {
      this.logInfo(
        `[Auto Sign-in] Answering new radar rollcall #${rollcallId}: ${rollcall.title} @ ${rollcall.course_title} by ${rollcall.created_by_name} (${rollcall.department_name})`
      );
      this.answerRaderRollcall(this.config.raderInfo[this.config.raderAt], rollcallId);
    }
    if (rollcall.is_number) {
      if (this.weAreBruteforcing.includes(rollcallId)) {
        this.logInfo("[Auto Sign-in] We are already bruteforcing rollcall #" + rollcallId);
        return;
      }
      this.weAreBruteforcing.push(rollcallId);
      this.logInfo(
        `[Auto Sign-in] Bruteforcing new number rollcall #${rollcallId}: ${rollcall.title} @ ${rollcall.course_title} by ${rollcall.created_by_name} (${rollcall.department_name})`
      );
      this.batchNumberRollCall(rollcallId);
    }
  }

  async answerRaderRollcall(raderXY, rid) {
    const _req = async (x, y) => {
      return await this.courses
        .fetch(
          `https://courses.zju.edu.cn/api/rollcall/${rid}/answer?api_version=1.1.2`,
          {
            body: JSON.stringify({
              deviceId: uuidv4(),
              latitude: y,
              longitude: x,
              speed: null,
              accuracy: 68,
              altitude: null,
              altitudeAccuracy: null,
              heading: null,
            }),
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
            },
          }
        )
        .then(async (v) => {
          // 检测登录失效
          if (v.status === 401 || v.status === 403) throw new AuthExpiredError();
          try {
            return await v.json();
          } catch (e) {
            console.log("[-][Auto Sign-in] Oh no..", e);
            return {};
          }
        });
    };

    const rader_outcome = [];

    // Step 1: Try configured location first
    const RaderXY = raderXY;
    if (RaderXY) {
      const outcome = await _req(RaderXY[0], RaderXY[1]);
      if (outcome.status_name === "on_call_fine") {
        await this.logSuccess(
          `[Auto Sign-in] Trying configured Rader location: ${this.config.raderAt} with outcome: ${JSON.stringify(
            outcome
          )}`
        );
        return true;
      } else {
        await this.logWarn(
          `[Auto Sign-in] Failed to get outcome from configured Rader location: ${this.config.raderAt} outcome: ${JSON.stringify(
            outcome
          )}`
        );
      }
      rader_outcome.push([RaderXY, outcome]);
    }

    // Step 2: Try all locations
    for (const [key, value] of Object.entries(this.config.raderInfo)) {
      await this.logInfo("[Auto Sign-in] Trying Rader location: " + key);
      const outcome = await _req(value[0], value[1]);
      if (outcome.status_name === "on_call_fine") {
        await this.logSuccess(
          "[Auto Sign-in] Congradulations! You are on the call at Rader location: " + key
        );
        return true;
      }
      rader_outcome.push([value, outcome]);
    }

    const extractDistance = (outcome) => {
      const candidates = [
        outcome?.distance,
        outcome?.data?.distance,
        outcome?.result?.distance,
      ];
      for (const c of candidates) {
        const n = Number(c);
        if (Number.isFinite(n) && n > 0) return n;
      }
      return null;
    };

    const rawPoints = [];
    for (const [coord, outcome] of rader_outcome) {
      const d = extractDistance(outcome);
      if (!d) continue;
      rawPoints.push({ lon: coord[0], lat: coord[1], d });
    }

    if (rawPoints.length >= 3) {
      const estimation = solveSphereLeastSquaresDecimal(rawPoints);
      await this.logInfo(
        `[Auto Sign-in] Sphere fit estimated location: (${estimation.lon}, ${estimation.lat}) RMS=${estimation.rms} from ${rawPoints.length} samples.`
      );
      const sphereOutcome = await _req(estimation.lon, estimation.lat);
      if (sphereOutcome?.status_name === "on_call_fine") {
        await this.logSuccess(
          `[Auto Sign-in] Sphere fit succeeded with outcome: ${JSON.stringify(
            sphereOutcome
          )}`
        );
        return true;
      }
      await this.logWarn(
        `[Auto Sign-in] Sphere fit attempt failed, outcome: ${JSON.stringify(sphereOutcome)}`
      );
    } else {
      await this.logWarn("[Auto Sign-in] Sphere fit skipped: not enough valid distance samples.");
    }

    if (RaderXY) {
      const fallback = await _req(RaderXY[0], RaderXY[1]);
      if (fallback?.status_name === "on_call_fine") {
        await this.logSuccess("[Auto Sign-in] Congradulations! You are on the call.");
        return true;
      }
      await this.logWarn(
        `[Auto Sign-in] Final fallback with configured Rader location failed: ${JSON.stringify(
          fallback
        )}`
      );
    }

    return false;
  }

  async answerNumberRollcall(numberCode, rid, fetchOptions = {}) {
    const { signal } = fetchOptions;
    return await this.courses
      .fetch(
        `https://courses.zju.edu.cn/api/rollcall/${rid}/answer_number_rollcall`,
        {
          body: JSON.stringify({
            deviceId: uuidv4(),
            numberCode,
          }),
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          signal,
        }
      )
      .then(async (vd) => {
        if (vd.status === 401 || vd.status === 403) {
          throw new AuthExpiredError();
        }
        if (vd.status !== 200 || vd.error_code?.includes("wrong")) {
          return false;
        }
        return true;
      });
  }

  async batchNumberRollCall(rid) {
    if (this.currentBatchingRCs.includes(rid)) return;
    this.currentBatchingRCs.push(rid);

    const state = new Map();
    state.set("found", false);

    const batchSize = 200;
    const perRequestTimeout = 5000; // 毫秒级超时，避免慢请求拖慢批次
    let foundCode = null;

    const buildAbortPair = () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), perRequestTimeout);
      return { controller, timer };
    };

    try {
      for (let start = 0; start <= 9999; start += batchSize) {
        if (state.get("found")) break;

        const end = Math.min(start + batchSize - 1, 9999);
        const tasks = [];
        const controllers = [];

        for (let ckn = start; ckn <= end; ckn++) {
          const code = ckn.toString().padStart(4, "0");
          const { controller, timer } = buildAbortPair();
          controllers.push({ controller, timer });

          tasks.push(
            this.answerNumberRollcall(code, rid, { signal: controller.signal })
              .then((success) => {
                clearTimeout(timer);
                if (state.get("found")) return;
                if (success) {
                  foundCode = code;
                  state.set("found", true);
                  // 找到后立即中止同批剩余请求，减少无效等待
                  controllers.forEach(({ controller: c, timer: t }) => {
                    if (!c.signal.aborted) c.abort();
                    clearTimeout(t);
                  });
                }
              })
              .catch((err) => {
                clearTimeout(timer);
                // 被中止或超时视为非成功，静默忽略
                if (err?.name === "AbortError") return;
              })
          );
        }

        await Promise.race([
          Promise.allSettled(tasks),
          new Promise((resolve) => {
            const timer = setInterval(() => {
              if (state.get("found")) {
                clearInterval(timer);
                resolve();
              }
            }, 20);
          }),
        ]);

        if (state.get("found")) break;
      }

      if (foundCode) {
        await this.logSuccess(
          `[Auto Sign-in] Number Rollcall ${rid} succeeded: found code ${foundCode}.`
        );
      } else {
        await this.logError(
          `[Auto Sign-in] Number Rollcall ${rid} failed to find valid code.`
        );
      }
    } finally {
      const idx = this.currentBatchingRCs.indexOf(rid);
      if (idx !== -1) this.currentBatchingRCs.splice(idx, 1);
    }
  }

  async _ensureAuthenticated(force = false) {
    if (!force && this.authExpired === false) return true;
    if (this.authMode === "secure_cookie") {
      if (!this.cookie) {
        this.authExpired = true;
        return false;
      }
      this.authExpired = false;
      return true;
    }
    // 密码模式：只需确保 courses 实例存在
    // 不要显式调用 login()，让 fetch() 自己管理登录流程
    // 参考 autosign.js 的做法
    try {
      this._buildCoursesClient();
      this.authExpired = false;
      return true;
    } catch (e) {
      this.authExpired = true;
      return false;
    }
  }

  async _tryRecoverAuth() {
    if (this.authMode === "secure_cookie") {
      // 极致安全模式：Cookie 失效后无法自动恢复，需要用户重新授权
      await this.logWarn("[Auto Sign-in] 极致安全模式：Cookie 已失效，请在面板重新输入密码授权");
      return false;
    }
    // 省心模式：可以尝试重新登录
    return this._ensureAuthenticated(true);
  }

  async _handleAuthExpired(reason = "") {
    this.authExpired = true;
    if (this.onAuthExpired) {
      try {
        await this.onAuthExpired(reason);
      } catch (e) {
        console.error("onAuthExpired failed:", e);
      }
    }
  }
}

export const defaultRaderInfo = DEFAULT_RADER_INFO;

