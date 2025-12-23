/**
 * 钉钉消息发送器（支持可选签名）
 * 用于按用户机器人配置发送通知
 */
import crypto from "crypto";

/**
 * 发送钉钉消息
 * @param {Object} options
 * @param {string} options.webhook - 完整 webhook URL
 * @param {string|null} options.secret - 签名秘钥（可选）
 * @param {string} options.msg - 消息内容
 */
export async function sendDingTalkMessage({ webhook, secret, msg }) {
  if (!webhook || !msg) return;

  let url = webhook;
  if (secret) {
    const timestamp = Date.now();
    const stringToSign = `${timestamp}\n${secret}`;
    const sign = crypto
      .createHmac("sha256", secret)
      .update(stringToSign)
      .digest("base64");
    const signEncoded = encodeURIComponent(sign);
    const sep = webhook.includes("?") ? "&" : "?";
    url = `${webhook}${sep}timestamp=${timestamp}&sign=${signEncoded}`;
  }

  const body = {
    msgtype: "text",
    text: { content: msg },
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      console.error(`[DingTalk] Failed: ${response.statusText}`);
    }
    const responseData = await response.json();
    if (responseData.errcode) {
      console.error(`[DingTalk] Failed: ${responseData.errmsg}`);
    }
  } catch (e) {
    console.error("[DingTalk] Error sending message:", e);
  }
}

export default sendDingTalkMessage;










