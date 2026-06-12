const encoder = new TextEncoder();

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64Utf8(value: string): string {
  return base64(encoder.encode(value));
}

export function encodeMimeHeader(value: string): string {
  return `=?UTF-8?B?${base64Utf8(value)}?=`;
}

export function dotStuff(value: string): string {
  return value.replace(/(^|\r\n)\./g, "$1..");
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export function createMimeMessage(input: {
  fromAddress: string;
  fromName: string;
  toAddress: string;
  subject: string;
  html: string;
  messageId?: string;
  date?: Date;
}): string {
  const messageId = input.messageId ?? crypto.randomUUID();
  const date = input.date ?? new Date();
  const headers = [
    `From: ${encodeMimeHeader(safeHeader(input.fromName))} <${safeHeader(input.fromAddress)}>`,
    `To: <${safeHeader(input.toAddress)}>`,
    `Subject: ${encodeMimeHeader(safeHeader(input.subject))}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${safeHeader(messageId)}@libyy.way2api.fun>`,
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  return `${headers.join("\r\n")}\r\n\r\n${base64Utf8(input.html)}\r\n`;
}

export type MailTemplate = {
  subject: string;
  html: string;
};

function layout(title: string, content: string): string {
  return `<!doctype html>
<html lang="zh-CN">
  <body style="margin:0;padding:28px;background:#f7faf7;color:#17342b;font-family:Arial,'Microsoft YaHei',sans-serif">
    <div style="max-width:560px;margin:auto;padding:28px;border:1px solid #dbe8e1;border-radius:18px;background:#fff">
      <p style="margin:0 0 8px;color:#216b51;font-size:12px;font-weight:bold;letter-spacing:2px">NJAU LIBYY</p>
      <h1 style="margin:0 0 18px;font-size:24px">${escapeHtml(title)}</h1>
      ${content}
      <p style="margin:24px 0 0;color:#6c7f78;font-size:12px">这是一封系统邮件。请勿向任何人提供官方凭证或本站密码。</p>
    </div>
  </body>
</html>`;
}

function participantList(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return "";
  const items = value.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  return `<p>参与成员：</p><ul>${items}</ul>`;
}

function automationDetails(payload: Record<string, unknown>): string {
  return `<p>房间：${escapeHtml(payload.roomName)}</p><p>时间：${escapeHtml(payload.date)} ${escapeHtml(payload.startTime)}-${escapeHtml(payload.endTime)}</p>${participantList(payload.participants)}`;
}

export function renderTemplate(template: string, payload: Record<string, unknown>): MailTemplate {
  switch (template) {
    case "REGISTER_CODE":
      return {
        subject: "NJAU Libyy 注册验证码",
        html: layout("注册验证码", `<p>你的验证码是：</p><p style="font-size:30px;font-weight:bold;letter-spacing:8px">${escapeHtml(payload.code)}</p><p>验证码将在 ${escapeHtml(payload.expiresInSeconds)} 秒后失效。</p>`),
      };
    case "RESET_PASSWORD_CODE":
      return {
        subject: "NJAU Libyy 密码重置验证码",
        html: layout("重置密码", `<p>你的验证码是：</p><p style="font-size:30px;font-weight:bold;letter-spacing:8px">${escapeHtml(payload.code)}</p><p>验证码将在 ${escapeHtml(payload.expiresInSeconds)} 秒后失效。</p>`),
      };
    case "RESERVATION_INVITATION":
      return {
        subject: "NJAU Libyy 联约邀请",
        html: layout("新的联约邀请", `<p><strong>${escapeHtml(payload.inviterName)}</strong> 邀请你参与研讨室预约。</p><p>请登录 NJAU Libyy，在“我的邀请”中接受或拒绝。</p>`),
      };
    case "TEAM_INVITATION":
      return {
        subject: "NJAU Libyy 小队邀请",
        html: layout("新的小队邀请", `<p><strong>${escapeHtml(payload.inviterName)}</strong> 邀请你加入小队 <strong>${escapeHtml(payload.teamName)}</strong>。</p><p>请打开以下链接查看邀请，再明确选择接受或拒绝：</p><p><a href="${escapeHtml(payload.confirmationUrl)}" style="color:#216b51;font-weight:bold">查看小队邀请</a></p>`),
      };
    case "OFFICIAL_REAUTH_REQUIRED":
      return {
        subject: "NJAU Libyy 统一认证需要确认",
        html: layout("需要完成统一认证", "<p>系统正在自动恢复图书馆登录，但统一认证要求短信验证或更新密码。请登录 NJAU Libyy 完成验证。</p>"),
      };
    case "AUTO_RESERVATION_SUCCESS":
      return {
        subject: "NJAU Libyy 自动预约成功",
        html: layout("自动预约成功", `<p>自动预约已经完成。</p>${automationDetails(payload)}`),
      };
    case "AUTO_RESERVATION_FAILED":
      return {
        subject: "NJAU Libyy 自动预约失败",
        html: layout("自动预约失败", `<p>自动预约未能完成。</p>${automationDetails(payload)}<p>原因：${escapeHtml(payload.reason)}</p>`),
      };
    case "AUTO_SIGN_SUCCESS":
      return {
        subject: "NJAU Libyy 自动签到成功",
        html: layout("自动签到成功", `<p>全部站内成员已完成自动签到。</p>${automationDetails(payload)}`),
      };
    case "AUTO_SIGN_FAILED":
      return {
        subject: "NJAU Libyy 自动签到失败",
        html: layout("自动签到失败", `<p>预约结束前未能完成全部成员的自动签到。</p>${automationDetails(payload)}<p>原因：${escapeHtml(payload.reason)}</p>`),
      };
    case "AUTO_SIGNOUT_SUCCESS":
      return {
        subject: "NJAU Libyy 自动签退成功",
        html: layout("自动签退成功", `<p>系统已完成自动签退。</p>${automationDetails(payload)}`),
      };
    case "AUTO_SIGNOUT_FAILED":
      return {
        subject: "NJAU Libyy 自动签退失败",
        html: layout("自动签退失败", `<p>预约结束前未能完成自动签退。</p>${automationDetails(payload)}<p>原因：${escapeHtml(payload.reason)}</p>`),
      };
    case "TEAM_INVITATION_ACCEPTED":
      return {
        subject: "NJAU Libyy 小队邀请已接受",
        html: layout("成员已加入小队", `<p><strong>${escapeHtml(payload.memberName)}</strong> 已接受邀请并加入小队 <strong>${escapeHtml(payload.teamName)}</strong>。</p>`),
      };
    case "TEAM_INVITATION_REJECTED":
      return {
        subject: "NJAU Libyy 小队邀请已拒绝",
        html: layout("小队邀请已拒绝", `<p><strong>${escapeHtml(payload.memberName)}</strong> 已拒绝加入小队 <strong>${escapeHtml(payload.teamName)}</strong>。</p>`),
      };
    case "TEAM_MEMBER_LEFT":
      return {
        subject: "NJAU Libyy 小队成员已退出",
        html: layout("小队成员已退出", `<p><strong>${escapeHtml(payload.memberName)}</strong> 已退出小队 <strong>${escapeHtml(payload.teamName)}</strong>。</p>`),
      };
    case "TEAM_MEMBER_REMOVED":
      return {
        subject: "NJAU Libyy 你已被移出小队",
        html: layout("你已被移出小队", `<p><strong>${escapeHtml(payload.operatorName)}</strong> 已将你移出小队 <strong>${escapeHtml(payload.teamName)}</strong>。</p>`),
      };
    case "TEAM_DISBANDED":
      return {
        subject: "NJAU Libyy 小队已解散",
        html: layout("小队已解散", `<p><strong>${escapeHtml(payload.operatorName)}</strong> 已解散小队 <strong>${escapeHtml(payload.teamName)}</strong>。</p>`),
      };
    case "TEST_EMAIL":
      return {
        subject: "NJAU Libyy 邮件测试",
        html: layout("邮件配置可用", "<p>这封邮件由管理员测试入口生成。SMTP outbox 已经正常工作。</p>"),
      };
    default:
      throw new Error("Unsupported mail template");
  }
}

export function retryDelayMs(attemptCount: number): number | null {
  const minutes = [1, 5, 15, 60][attemptCount - 1];
  return minutes === undefined ? null : minutes * 60_000;
}
