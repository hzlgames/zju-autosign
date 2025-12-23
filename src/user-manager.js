import crypto from "crypto";
import { AutoSignCore, defaultRaderInfo } from "./autosign-core.js";
import { sendDingTalkMessage } from "../shared/dingtalk-send.js";
import { Scheduler, _testHelpers as SchedulerHelpers } from "./scheduler.js";
import { UserLogger } from "./logger.js";
import { loginAndGetCookie, testCookieValid } from "./auth-helper.js";

const IS_DEBUG = String(process.env.DEBUG || "").toLowerCase() === "true";

function nowISO() {
  return new Date().toISOString();
}

const VALID_RADER_AT = new Set([
  "ZJGD1",
  "ZJGX1",
  "ZJGB1",
  "YQ4",
  "YQ1",
  "YQ7",
  "ZJ1",
  "HJC1",
  "HJC2",
  "ZJ2",
  "YQSS",
  "ZJG4",
]);

function ensureValidUsername(username, required = false) {
  if (!username && !required) return;
  if (!username || !/^\d{10}$/.test(username)) {
    throw new Error("用户名格式无效，需为 10 位数字学号");
  }
}

function ensureValidRaderAt(raderAt) {
  if (!raderAt) return;
  if (!VALID_RADER_AT.has(raderAt)) {
    throw new Error("raderAt 无效，必须为预设位置之一");
  }
}

/**
 * 认证模式：
 * - PASSWORD: 省心模式，保存加密密码，可自动续期
 * - SECURE: 极致安全模式，密码换 Cookie 后立即销毁密码，仅保存 Cookie
 */
const AUTH_MODE = {
  PASSWORD: "password_persist",
  SECURE: "secure_cookie",  // 新模式：密码换 Cookie
};

const NOTIFY_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

function isNowInUserWindow(entry) {
  const { isNowInWindow } = SchedulerHelpers || {};
  if (!isNowInWindow || !entry?.scheduler) return true;
  return isNowInWindow(entry.scheduler.startTime, entry.scheduler.endTime);
}

export class UserManager {
  constructor({ store, dingTalk, controlNotify }) {
    this.store = store;
    this.dingTalk = dingTalk;
    this.controlNotify = controlNotify;
    this.userMap = new Map(); // id -> { config, core, scheduler, logger }
  }

  async init() {
    const users = await this.store.loadUsers();
    // 补齐缺省字段，确保兼容旧数据
    let needSave = false;
    for (const u of users) {
      if (!u.authMode) {
        u.authMode = AUTH_MODE.PASSWORD;
        needSave = true;
      }
      if (typeof u.authExpired !== "boolean") {
        u.authExpired = false;
        needSave = true;
      }
      if (typeof u.lastAuthFailAt === "undefined") {
        u.lastAuthFailAt = null;
        needSave = true;
      }
      if (typeof u.lastNotifyAt === "undefined") {
        u.lastNotifyAt = null;
        needSave = true;
      }
    }
    for (const u of users) {
      if (!Array.isArray(u.dingTalkBots)) {
        u.dingTalkBots = [];
        needSave = true;
      }
    }
    if (needSave) {
      await this.store.saveUsers(users);
    }
    for (const user of users) {
      await this._ensureUserInstance(user, false);
    }
  }

  listUsers() {
    return Array.from(this.userMap.values()).map(({ config, core, scheduler }) => ({
      ...this._publicUser(config),
      running: core?.running || false,
      schedulerEnabled: scheduler?.enableSchedule || false,
    }));
  }

  _publicBot(bot) {
    // 对当前用户返回解密后的配置，便于前端编辑时自动填充
    const webhook = bot.webhookEnc ? this.store.decryptSecret(bot.webhookEnc) : undefined;
    const secret = bot.secretEnc ? this.store.decryptSecret(bot.secretEnc) : undefined;
    return {
      id: bot.id,
      name: bot.name,
      enabled: bot.enabled !== false,
      hasSecret: !!bot.secretEnc,
      webhook,
      secret,
      createdAt: bot.createdAt,
      updatedAt: bot.updatedAt,
    };
  }

  getUserBotCount(userId) {
    const entry = this.userMap.get(userId);
    if (entry?.config?.dingTalkBots) return entry.config.dingTalkBots.length;
    return 0;
  }

  async sendToUserBots(userId, msg) {
    if (!msg) return;
    let config = this.userMap.get(userId)?.config;
    if (!config) {
      const users = await this.store.loadUsers();
      config = users.find((u) => u.id === userId);
    }
    if (!config || !Array.isArray(config.dingTalkBots) || config.dingTalkBots.length === 0) return;

    const bots = config.dingTalkBots.filter((b) => b.enabled !== false);
    const tasks = bots.map(async (bot) => {
      try {
        const webhook = this.store.decryptSecret(bot.webhookEnc);
        const secret = bot.secretEnc ? this.store.decryptSecret(bot.secretEnc) : null;
        await sendDingTalkMessage({ webhook, secret, msg });
      } catch (e) {
        console.error(`[DingTalk][${bot.name || bot.id}] send failed:`, e?.message || e);
      }
    });
    await Promise.allSettled(tasks);
  }

  async broadcastToUsers(userIds, msg) {
    if (!msg) return;
    const ids = Array.isArray(userIds) && userIds.length > 0 ? userIds : Array.from(this.userMap.keys());
    for (const id of ids) {
      await this.sendToUserBots(id, msg);
    }
  }

  validateUserToken(userToken) {
    const entry = Array.from(this.userMap.values()).find(
      (v) => v.config.userToken === userToken
    );
    if (!entry) return null;
    return entry.config;
  }

  async _mutateUser(id, mutator) {
    const users = await this.store.loadUsers();
    const idx = users.findIndex((u) => u.id === id);
    if (idx === -1) throw new Error("not found");
    const cloned = users[idx];
    mutator(cloned);
    users[idx] = cloned;
    await this.store.saveUsers(users);
    const entry = this.userMap.get(id);
    if (entry) {
      entry.config = cloned;
    }
    return cloned;
  }

  async upsertUser(data) {
    const users = await this.store.loadUsers();
    let target = users.find((u) => u.id === data.id);
    const now = nowISO();
    if (!target) {
      ensureValidUsername(data.username, true);
      target = {
        id: data.id || crypto.randomUUID(),
        createdAt: now,
        dingTalkBots: [],
      };
      users.push(target);
    }
    ensureValidUsername(data.username);
    if (data.username) {
      target.username = data.username;
    }
    // 认证模式与凭证处理
    target.authMode = data.authMode || target.authMode || AUTH_MODE.PASSWORD;
    if (data.password) {
      target.passwordEnc = this.store.encryptPassword(data.password);
      target.authExpired = false;
    }
    if (data.cookie) {
      target.cookieEnc = this.store.encryptCookie(data.cookie);
      target.authExpired = false;
    }
    if (!target.authMode) target.authMode = AUTH_MODE.PASSWORD;
    if (typeof target.authExpired !== "boolean") target.authExpired = false;
    if (typeof target.lastAuthFailAt === "undefined") target.lastAuthFailAt = null;
    if (typeof target.lastNotifyAt === "undefined") target.lastNotifyAt = null;
    ensureValidRaderAt(data.raderAt ?? target.raderAt);
    target.raderAt = data.raderAt ?? target.raderAt ?? "ZJGD1";
    target.coldDownTime = Number(data.coldDownTime ?? target.coldDownTime ?? 4000);
    target.enableSchedule = data.enableSchedule ?? target.enableSchedule ?? false;
    target.windowStart = data.windowStart ?? target.windowStart ?? "08:00";
    target.windowEnd = data.windowEnd ?? target.windowEnd ?? "22:00";
    target.logEmptyRollcall = data.logEmptyRollcall ?? target.logEmptyRollcall ?? false;
    target.enabled = data.enabled ?? target.enabled ?? true;
    if (!Array.isArray(target.dingTalkBots)) target.dingTalkBots = [];
    target.userToken = target.userToken || this.store.newUserToken();
    target.updatedAt = now;

    await this.store.saveUsers(users);
    await this._ensureUserInstance(target, true);
    await this._notify(`[Control] 用户 ${target.username} 已更新/创建`);
    return this._publicUser(target);
  }

  async createViaInvite({ inviteCode, username, password, authMode }) {
    if (!inviteCode || !username || !password) {
      throw new Error("邀请码、用户名、密码不能为空");
    }
    ensureValidUsername(username, true);
    const users = await this.store.loadUsers();
    if (users.find((u) => u.username === username)) {
      throw new Error("用户名已存在");
    }
    
    const finalAuthMode = authMode || AUTH_MODE.PASSWORD;
    const now = nowISO();
    const id = crypto.randomUUID();
    const userToken = this.store.newUserToken();
    
    let passwordEnc = undefined;
    let cookieEnc = undefined;
    
    if (finalAuthMode === AUTH_MODE.SECURE) {
      // 极致安全模式：用密码登录获取 Cookie，然后销毁密码
      console.log(`[UserManager] 极致安全模式：为用户 ${username} 获取 Cookie...`);
      const result = await loginAndGetCookie(username, password);
      if (!result.ok) {
        throw new Error(result.error || "登录失败，无法获取 Cookie");
      }
      cookieEnc = this.store.encryptCookie(result.cookie);
      // 密码不保存！
      console.log(`[UserManager] 极致安全模式：Cookie 已获取并加密保存，密码已销毁`);
    } else {
      // 省心模式：保存加密密码
      passwordEnc = this.store.encryptPassword(password);
    }
    
    const config = {
      id,
      username,
      authMode: finalAuthMode,
      passwordEnc,
      cookieEnc,
      authExpired: false,
      lastAuthFailAt: null,
      lastNotifyAt: null,
      raderAt: "ZJGD1",
      coldDownTime: 4000,
      enableSchedule: false,
      windowStart: "08:00",
      windowEnd: "22:00",
      logEmptyRollcall: false,
      dingTalkBots: [],
      enabled: true,
      createdAt: now,
      updatedAt: now,
      userToken,
    };
    
    // 验证并占用邀请码
    const ok = await this.store.useInvite(inviteCode, id);
    if (!ok) throw new Error("邀请码无效或已被使用");
    users.push(config);
    await this.store.saveUsers(users);
    await this._ensureUserInstance(config, true);
    await this._notify(`[Control] 新用户 ${username} 通过邀请码加入 (${finalAuthMode})`);
    return { user: this._publicUser(config), userToken };
  }

  async deleteUser(id) {
    const users = await this.store.loadUsers();
    const idx = users.findIndex((u) => u.id === id);
    if (idx === -1) return { ok: false, message: "not found" };
    const [removed] = users.splice(idx, 1);
    await this.store.saveUsers(users);
    await this.stopUser(id);
    this.userMap.delete(id);
    await this._notify(`[Control] 用户 ${removed.username} 已删除`);
    return { ok: true };
  }

  /**
   * 处理启动时的调度逻辑（统一逻辑供单独和批量操作使用）
   * - 在窗口内启动：清除覆盖，恢复正常调度（随窗口结束停止）
   * - 在窗口外启动：暂停调度直到下次窗口开始
   */
  async _handleStartSchedule(entry, source = "手动") {
    if (!entry.config.enableSchedule) return;
    
    if (entry.scheduler.isCurrentlyInWindow()) {
      // 在窗口内启动，清除覆盖，恢复正常调度
      entry.scheduler.clearOverride();
      await entry.logger.info(`[${source}启动] 当前处于调度时间窗口内，已恢复正常调度（将随窗口结束自动停止）`);
    } else {
      // 在窗口外启动，暂停调度直到下次窗口开始
      entry.scheduler.pauseUntilNextWindowStart();
      await entry.logger.info(`[${source}启动] 当前不在调度时间窗口内，已暂停自动调度直到下次窗口开始`);
    }
  }

  /**
   * 处理停止时的调度逻辑（统一逻辑供单独和批量操作使用）
   * - 无论窗口内外，都暂停调度直到下次窗口开始
   */
  async _handleStopSchedule(entry, source = "手动") {
    if (!entry.config.enableSchedule) return;
    
    // 无论窗口内外，都暂停调度直到下次窗口开始时恢复
    entry.scheduler.pauseUntilNextWindowStart();
    const inWindow = entry.scheduler.isCurrentlyInWindow();
    if (inWindow) {
      await entry.logger.info(`[${source}停止] 当前处于调度时间窗口内，已暂停自动调度直到下次窗口开始`);
    } else {
      await entry.logger.info(`[${source}停止] 已暂停自动调度直到下次窗口开始`);
    }
  }

  async startUser(id, options = {}) {
    const entry = this.userMap.get(id);
    if (!entry) return { ok: false, message: "not found" };
    
    const { forceOverride = false } = options;
    
    // 检查是否启用调度且当前在窗口外，需要用户确认
    if (entry.config.enableSchedule && !forceOverride) {
      const inWindow = entry.scheduler.isCurrentlyInWindow();
      if (!inWindow) {
        await entry.logger.warn("[手动启动] 当前不在调度时间窗口内，需要用户确认");
        return { 
          ok: false, 
          needConfirm: true,
          message: "当前不在调度时间窗口内。确认启动后，将持续运行直到下次调度开始时间，届时恢复自动调度。" 
        };
      }
    }
    
    // 处理调度逻辑
    await this._handleStartSchedule(entry, "手动");
    
    await entry.core.start();
    await entry.logger?.event("[手动启动] 用户触发任务启动");
    return { ok: true };
  }

  async stopUser(id, options = {}) {
    const entry = this.userMap.get(id);
    if (!entry) return { ok: false, message: "not found" };
    
    const { forceOverride = false } = options;
    
    // 检查是否启用调度且当前在窗口内，需要用户确认
    if (entry.config.enableSchedule && !forceOverride) {
      const inWindow = entry.scheduler.isCurrentlyInWindow();
      if (inWindow) {
        await entry.logger.warn("[手动停止] 当前处于调度时间窗口内，需要用户确认");
        return { 
          ok: false, 
          needConfirm: true,
          message: "当前处于调度时间窗口内。确认停止后，将暂停自动调度直到下次窗口开始时恢复。" 
        };
      }
    }
    
    // 处理调度逻辑
    await this._handleStopSchedule(entry, "手动");
    
    await entry.core.stop();
    await entry.logger?.event("[手动停止] 用户触发任务停止");
    return { ok: true };
  }

  async updateWindow(id, { startTime, endTime, enableSchedule, notifyDingTalk = true }) {
    const entry = this.userMap.get(id);
    if (!entry) return { ok: false, message: "not found" };
    
    // 更新调度配置
    const changeInfo = await entry.scheduler.updateWindow({ startTime, endTime, enableSchedule });
    
    // 持久化配置
    if (startTime) entry.config.windowStart = startTime;
    if (endTime) entry.config.windowEnd = endTime;
    if (typeof enableSchedule === "boolean") entry.config.enableSchedule = enableSchedule;
    await this._persistConfig(entry.config);
    
    // 构建通知消息
    const messages = [];
    
    if (changeInfo.wasEnabled !== changeInfo.nowEnabled) {
      if (changeInfo.nowEnabled) {
        messages.push(`调度功能已开启 (${entry.config.windowStart} - ${entry.config.windowEnd})`);
      } else {
        messages.push("调度功能已关闭，将由您手动控制启停");
      }
    } else if (changeInfo.timeChanged && changeInfo.nowEnabled) {
      messages.push(`调度时间已更新为 ${entry.config.windowStart} - ${entry.config.windowEnd}`);
    }
    
    // 应用调度逻辑
    const applyResult = await entry.scheduler.applyScheduleNow();
    
    if (changeInfo.nowEnabled) {
      if (applyResult.action === "started") {
        messages.push("当前处于调度窗口内，已自动启动");
        await entry.logger.info("[调度配置] 调度已开启，当前在窗口内，已自动启动");
      } else if (applyResult.action === "stopped") {
        messages.push("当前不在调度窗口内，已自动停止，将在下次窗口开始时自动启动");
        await entry.logger.info("[调度配置] 调度已开启，当前不在窗口内，已自动停止");
      } else if (changeInfo.wasEnabled !== changeInfo.nowEnabled || changeInfo.timeChanged) {
        // 调度刚开启或时间变更，但状态无需改变
        if (changeInfo.inWindow) {
          messages.push("当前处于调度窗口内，任务将随窗口结束自动停止");
        } else {
          messages.push("当前不在调度窗口内，将在下次窗口开始时自动启动");
        }
        await entry.logger.info(`[调度配置] 配置已更新，覆盖状态已清除`);
      }
    } else if (!changeInfo.nowEnabled && changeInfo.wasEnabled) {
      // 调度刚关闭
      await entry.logger.info("[调度配置] 调度已关闭，当前状态保持不变，请手动控制启停");
    }
    
    // 发送钉钉通知
    if (notifyDingTalk && messages.length > 0) {
      const fullMessage = `[调度配置变更]\n${messages.join("\n")}`;
      await this.sendToUserBots(id, fullMessage);
    }
    
    return { ok: true, scheduler: entry.scheduler.getStatus(), messages };
  }

  status(id) {
    const entry = this.userMap.get(id);
    if (!entry) return { ok: false, message: "not found" };
    return {
      ok: true,
      user: this._publicUser(entry.config),
      core: entry.core.getStatus(),
      scheduler: entry.scheduler.getStatus(),
    };
  }

  async statusByToken(userToken) {
    const config = this.validateUserToken(userToken);
    if (!config) return { ok: false, message: "not found" };
    const entry = this.userMap.get(config.id);
    const result = this.status(entry.config.id);
    // 为用户自己返回解密后的密码（仅当存在）
    if (result.ok && entry.config.passwordEnc) {
      try {
        result.user.password = this.store.decryptPassword(entry.config.passwordEnc);
      } catch (e) {
        result.user.password = "(解密失败)";
      }
    }
    return result;
  }

  async updateByToken(userToken, data) {
    const config = this.validateUserToken(userToken);
    if (!config) throw new Error("not found");
    const users = await this.store.loadUsers();
    const target = users.find((u) => u.id === config.id);
    if (!target) throw new Error("not found");
    const now = nowISO();
    if (!Array.isArray(target.dingTalkBots)) target.dingTalkBots = [];
    if (data.username) {
      ensureValidUsername(data.username);
      target.username = data.username;
    }
    
    // 认证模式切换与凭证更新
    const newAuthMode = data.authMode || target.authMode || AUTH_MODE.PASSWORD;
    
    if (data.authMode && data.authMode !== AUTH_MODE.PASSWORD && data.authMode !== AUTH_MODE.SECURE) {
      throw new Error("authMode 无效，仅支持 password_persist 或 secure_cookie");
    }
    
    // 处理密码更新
    if (data.password) {
      if (newAuthMode === AUTH_MODE.SECURE) {
        // 极致安全模式：用密码获取 Cookie，然后销毁密码
        console.log(`[UserManager] 极致安全模式：为用户 ${target.username} 更新 Cookie...`);
        const result = await loginAndGetCookie(target.username, data.password);
        if (!result.ok) {
          throw new Error(result.error || "登录失败，无法获取 Cookie");
        }
        target.cookieEnc = this.store.encryptCookie(result.cookie);
        target.passwordEnc = undefined; // 确保不保存密码
        target.authExpired = false;
        console.log(`[UserManager] 极致安全模式：Cookie 已更新，密码已销毁`);
      } else {
        // 省心模式：保存加密密码
        target.passwordEnc = this.store.encryptPassword(data.password);
        target.authExpired = false;
      }
    }
    
    // 模式切换处理
    if (data.authMode && data.authMode !== target.authMode) {
      target.authMode = data.authMode;
      if (data.authMode === AUTH_MODE.SECURE) {
        // 切换到极致安全模式，必须提供密码来获取 Cookie
        if (!data.password) {
          throw new Error("切换到极致安全模式需要输入密码以获取 Cookie");
        }
        target.passwordEnc = undefined; // 删除已存储的密码
      } else if (data.authMode === AUTH_MODE.PASSWORD) {
        // 切换到省心模式，必须提供密码
        if (!data.password && !target.passwordEnc) {
          throw new Error("切换到省心模式需要输入密码");
        }
      }
    }
    
    if (!target.authMode) target.authMode = AUTH_MODE.PASSWORD;
    if (typeof target.authExpired !== "boolean") target.authExpired = false;
    if (typeof target.lastAuthFailAt === "undefined") target.lastAuthFailAt = null;
    if (typeof target.lastNotifyAt === "undefined") target.lastNotifyAt = null;
    if (data.raderAt) {
      ensureValidRaderAt(data.raderAt);
      target.raderAt = data.raderAt;
    }
    if (data.coldDownTime) target.coldDownTime = Number(data.coldDownTime);
    if (typeof data.enableSchedule === "boolean") target.enableSchedule = data.enableSchedule;
    if (data.windowStart) target.windowStart = data.windowStart;
    if (data.windowEnd) target.windowEnd = data.windowEnd;
    if (typeof data.logEmptyRollcall === "boolean") target.logEmptyRollcall = data.logEmptyRollcall;
    if (typeof data.enabled === "boolean") target.enabled = data.enabled;
    target.updatedAt = now;
    await this.store.saveUsers(users);
    await this._ensureUserInstance(target, true);
    return this._publicUser(target);
  }

  async listBotsByToken(userToken) {
    const config = this.validateUserToken(userToken);
    if (!config) throw new Error("not found");
    const entry = this.userMap.get(config.id);
    const bots = entry?.config?.dingTalkBots || [];
    return bots.map((b) => this._publicBot(b));
  }

  async addBotByToken(userToken, payload = {}) {
    const config = this.validateUserToken(userToken);
    if (!config) throw new Error("not found");
    const { webhook, secret, name, enabled = true } = payload;
    if (!webhook || typeof webhook !== "string") throw new Error("webhook required");
    const now = nowISO();
    const bot = {
      id: crypto.randomUUID(),
      name: name?.trim() || "DingTalk Bot",
      webhookEnc: this.store.encryptSecret(webhook.trim()),
      secretEnc: secret ? this.store.encryptSecret(secret.trim()) : null,
      enabled: enabled !== false,
      createdAt: now,
      updatedAt: now,
    };
    await this._mutateUser(config.id, (u) => {
      if (!Array.isArray(u.dingTalkBots)) u.dingTalkBots = [];
      u.dingTalkBots.push(bot);
    });
    return this._publicBot(bot);
  }

  async updateBotByToken(userToken, botId, payload = {}) {
    const config = this.validateUserToken(userToken);
    if (!config) throw new Error("not found");
    const now = nowISO();
    let updated;
    await this._mutateUser(config.id, (u) => {
      if (!Array.isArray(u.dingTalkBots)) u.dingTalkBots = [];
      const bot = u.dingTalkBots.find((b) => b.id === botId);
      if (!bot) throw new Error("bot not found");
      if (payload.name) bot.name = payload.name.trim();
      if (typeof payload.enabled === "boolean") bot.enabled = payload.enabled;
      if (payload.webhook) bot.webhookEnc = this.store.encryptSecret(payload.webhook.trim());
      if (payload.secret === "") {
        bot.secretEnc = null;
      } else if (typeof payload.secret === "string") {
        bot.secretEnc = this.store.encryptSecret(payload.secret.trim());
      }
      bot.updatedAt = now;
      updated = bot;
    });
    return this._publicBot(updated);
  }

  async deleteBotByToken(userToken, botId) {
    const config = this.validateUserToken(userToken);
    if (!config) throw new Error("not found");
    let ok = false;
    await this._mutateUser(config.id, (u) => {
      if (!Array.isArray(u.dingTalkBots)) u.dingTalkBots = [];
      const before = u.dingTalkBots.length;
      u.dingTalkBots = u.dingTalkBots.filter((b) => b.id !== botId);
      ok = u.dingTalkBots.length !== before;
    });
    if (!ok) throw new Error("bot not found");
    return { ok: true };
  }

  async testBotByToken(userToken, botId, message) {
    const config = this.validateUserToken(userToken);
    if (!config) throw new Error("not found");
    const entry = this.userMap.get(config.id);
    const bot = entry?.config?.dingTalkBots?.find((b) => b.id === botId);
    if (!bot) throw new Error("bot not found");
    const webhook = this.store.decryptSecret(bot.webhookEnc);
    const secret = bot.secretEnc ? this.store.decryptSecret(bot.secretEnc) : null;
    await sendDingTalkMessage({ webhook, secret, msg: message || "[Test] DingTalk 通知正常" });
    return { ok: true };
  }

  async startByToken(userToken, options = {}) {
    const config = this.validateUserToken(userToken);
    if (!config) return { ok: false, message: "not found" };
    return this.startUser(config.id, options);
  }

  async stopByToken(userToken, options = {}) {
    const config = this.validateUserToken(userToken);
    if (!config) return { ok: false, message: "not found" };
    return this.stopUser(config.id, options);
  }

  async updateWindowByToken(userToken, { startTime, endTime, enableSchedule }) {
    const config = this.validateUserToken(userToken);
    if (!config) return { ok: false, message: "not found" };
    return this.updateWindow(config.id, { startTime, endTime, enableSchedule });
  }

  _publicUser(config) {
    return {
      id: config.id,
      username: config.username,
      raderAt: config.raderAt,
      coldDownTime: config.coldDownTime,
      enableSchedule: config.enableSchedule,
      windowStart: config.windowStart,
      windowEnd: config.windowEnd,
      logEmptyRollcall: config.logEmptyRollcall,
      enabled: config.enabled,
      authMode: config.authMode || AUTH_MODE.PASSWORD,
      authExpired: !!config.authExpired,
      hasPassword: !!config.passwordEnc,
      hasCookie: !!config.cookieEnc,
      dingTalkBotCount: Array.isArray(config.dingTalkBots) ? config.dingTalkBots.length : 0,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
      userToken: config.userToken,
    };
  }

  async _ensureUserInstance(config, restart) {
    const existing = this.userMap.get(config.id);
    if (existing && !restart) return existing;
    if (existing && restart) {
      // 必须先停止旧的 scheduler 和 core，等待 runLoop 完全退出
      existing.scheduler.stop();
      await existing.core.stop();
    }
    const notifyUserAndAdmin = async (msg) => {
      if (!msg) return;
      const tasks = [this.sendToUserBots(config.id, msg)];
      if (this.controlNotify) {
        tasks.push(this.controlNotify(msg));
      }
      await Promise.allSettled(tasks);
    };

    const logger =
      existing?.logger ||
      new UserLogger({
        userId: config.id,
        username: config.username,
        dingTalk: notifyUserAndAdmin,
      });
    
    // 根据认证模式决定使用什么凭证
    const authMode = config.authMode || AUTH_MODE.PASSWORD;
    let passwordPlain = undefined;
    let cookiePlain = undefined;
    
    if (authMode === AUTH_MODE.SECURE) {
      // 极致安全模式：只使用 Cookie
      cookiePlain = config.cookieEnc ? this.store.decryptCookie(config.cookieEnc) : undefined;
      if (!cookiePlain) {
        await logger?.warn(`[Auto Sign-in] 极致安全模式但无有效 Cookie，请重新授权`);
        config.authExpired = true;
        await this._persistConfig(config);
        return;
      }
    } else {
      // 省心模式：使用密码
      passwordPlain = config.passwordEnc ? this.store.decryptPassword(config.passwordEnc) : undefined;
      if (!passwordPlain) {
        await logger?.warn(`[Auto Sign-in] 省心模式但无有效密码，请重新配置`);
        config.authExpired = true;
        await this._persistConfig(config);
        return;
      }
    }

    let core;
    try {
      core = new AutoSignCore({
        username: config.username,
        password: passwordPlain,
        cookie: cookiePlain,
        authMode: authMode,
        dingTalk: notifyUserAndAdmin,
        logger,
        raderAt: config.raderAt,
        coldDownTime: config.coldDownTime,
        raderInfo: defaultRaderInfo,
        userId: config.id,
        logEmptyRollcall: !!config.logEmptyRollcall,
        debug: IS_DEBUG,
        onAuthExpired: async (reason) => {
          await this._handleAuthExpired(config.id, reason);
        },
        onAuthRecovered: async () => {
          await this._handleAuthRecovered(config.id);
        },
      });
    } catch (e) {
      await logger?.error(`[Auto Sign-in] 无法初始化用户 ${config.username} 的核心任务: ${e.message}`);
      config.authExpired = true;
      await this._persistConfig(config);
      return;
    }
    const scheduler = new Scheduler(core, {
      startTime: config.windowStart,
      endTime: config.windowEnd,
      enableSchedule: config.enableSchedule,
    });
    scheduler.start();
    if (!config.enableSchedule && config.enabled) {
      await core.start();
    }
    this.userMap.set(config.id, { config, core, scheduler, logger });
    return this.userMap.get(config.id);
  }

  async _notify(msg) {
    if (this.controlNotify) {
      try {
        await this.controlNotify(msg);
      } catch (e) {
        console.error("[Control notify] failed:", e);
      }
    }
  }

  async _handleAuthExpired(id, reason = "") {
    const entry = this.userMap.get(id);
    if (!entry) return;
    const nowIso = nowISO();
    entry.config.authExpired = true;
    entry.config.lastAuthFailAt = nowIso;

    // 控制提醒频率
    const last = entry.config.lastNotifyAt ? new Date(entry.config.lastNotifyAt).getTime() : 0;
    const now = Date.now();
    const shouldNotify = !last || now - last > NOTIFY_INTERVAL_MS;

    if (shouldNotify) {
      entry.config.lastNotifyAt = nowIso;
      const msg =
        `[Auto Sign-in] 用户 ${entry.config.username} 登录授权已失效，请在网页重新授权。` +
        (reason ? ` 原因: ${reason}` : "");
      try {
        await entry.logger.warn(msg);
      } catch (e) {
        console.error("notify auth expired failed:", e);
      }
    }

    await this._persistConfig(entry.config);
  }

  async _handleAuthRecovered(id) {
    const entry = this.userMap.get(id);
    if (!entry) return;
    entry.config.authExpired = false;
    entry.config.lastAuthFailAt = null;
    // 不强制清空 lastNotifyAt，保留记录
    await this._persistConfig(entry.config);
  }

  async _persistConfig(config) {
    const users = await this.store.loadUsers();
    const idx = users.findIndex((u) => u.id === config.id);
    if (idx === -1) return;
    users[idx] = { ...users[idx], ...config };
    await this.store.saveUsers(users);
  }

  async logs(id) {
    const entry = this.userMap.get(id);
    if (!entry) return { ok: false, message: "not found" };
    const logs = await entry.logger.getRecent();
    return { ok: true, logs };
  }

  async logsByToken(userToken) {
    const config = this.validateUserToken(userToken);
    if (!config) return { ok: false, message: "not found" };
    return this.logs(config.id);
  }

  async clearLogs(id) {
    const entry = this.userMap.get(id);
    if (!entry) return { ok: false, message: "not found" };
    await entry.logger.clear();
    return { ok: true };
  }

  async clearLogsByToken(userToken) {
    const config = this.validateUserToken(userToken);
    if (!config) return { ok: false, message: "not found" };
    return this.clearLogs(config.id);
  }

  /**
   * 批量启动用户
   * @param {string[]} ids - 用户 ID 数组
   * @param {object} options - 选项
   * @returns {Promise<{ok: boolean, results: Array}>}
   */
  async batchStartUsers(ids, options = {}) {
    const { notifyDingTalk = true } = options;
    const results = [];
    
    for (const id of ids) {
      const entry = this.userMap.get(id);
      if (!entry) {
        results.push({ id, ok: false, message: "not found" });
        continue;
      }
      
      try {
        // 使用统一的调度处理逻辑
        await this._handleStartSchedule(entry, "批量");
        
        await entry.core.start();
        await entry.logger?.event("[批量启动] 管理员触发任务启动");
        
        // 发送钉钉提醒
        if (notifyDingTalk) {
          await this.sendToUserBots(id, `[通知] 您的签到任务已被管理员批量启动`);
        }
        
        results.push({ id, ok: true, username: entry.config.username });
      } catch (e) {
        results.push({ id, ok: false, message: e.message, username: entry.config?.username });
      }
    }
    
    return { ok: true, results };
  }

  /**
   * 批量停止用户
   * @param {string[]} ids - 用户 ID 数组
   * @param {object} options - 选项
   * @returns {Promise<{ok: boolean, results: Array}>}
   */
  async batchStopUsers(ids, options = {}) {
    const { notifyDingTalk = true } = options;
    const results = [];
    
    for (const id of ids) {
      const entry = this.userMap.get(id);
      if (!entry) {
        results.push({ id, ok: false, message: "not found" });
        continue;
      }
      
      try {
        // 使用统一的调度处理逻辑
        await this._handleStopSchedule(entry, "批量");
        
        await entry.core.stop();
        await entry.logger?.event("[批量停止] 管理员触发任务停止");
        
        // 发送钉钉提醒
        if (notifyDingTalk) {
          await this.sendToUserBots(id, `[通知] 您的签到任务已被管理员批量停止，下次调度开始时将恢复自动调度`);
        }
        
        results.push({ id, ok: true, username: entry.config.username });
      } catch (e) {
        results.push({ id, ok: false, message: e.message, username: entry.config?.username });
      }
    }
    
    return { ok: true, results };
  }

  /**
   * 批量重启用户（先停止再启动）
   * @param {string[]} ids - 用户 ID 数组
   * @param {object} options - 选项
   * @returns {Promise<{ok: boolean, results: Array}>}
   */
  async batchRestartUsers(ids, options = {}) {
    const { notifyDingTalk = true } = options;
    const results = [];
    
    for (const id of ids) {
      const entry = this.userMap.get(id);
      if (!entry) {
        results.push({ id, ok: false, message: "not found" });
        continue;
      }
      
      try {
        // 先停止
        await entry.core.stop();
        
        // 等待短暂时间确保完全停止
        await new Promise(r => setTimeout(r, 1000));
        
        // 使用统一的调度处理逻辑（重启视为启动）
        await this._handleStartSchedule(entry, "批量重启");
        
        // 重新启动
        await entry.core.start();
        await entry.logger?.event("[批量重启] 管理员触发任务重启");
        
        // 发送钉钉提醒
        if (notifyDingTalk) {
          await this.sendToUserBots(id, `[通知] 您的签到任务已被管理员批量重启`);
        }
        
        results.push({ id, ok: true, username: entry.config.username });
      } catch (e) {
        results.push({ id, ok: false, message: e.message, username: entry.config?.username });
      }
    }
    
    return { ok: true, results };
  }
}

