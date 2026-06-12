import { describe, expect, it } from "vitest";
import { createMimeMessage, dotStuff, encodeMimeHeader, renderTemplate, retryDelayMs } from "../src/lib/mail-content";

describe("mail content", () => {
  it("encodes UTF-8 subjects", () => {
    expect(encodeMimeHeader("注册验证码")).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
  });

  it("dot-stuffs SMTP data", () => {
    expect(dotStuff(".first\r\n.second\r\nnormal")).toBe("..first\r\n..second\r\nnormal");
  });

  it("builds a bounded MIME message without raw UTF-8 subject text", () => {
    const mime = createMimeMessage({
      fromAddress: "noreply@example.com",
      fromName: "NJAU Libyy",
      toAddress: "student@example.com",
      subject: "注册验证码",
      html: "<p>hello</p>",
      messageId: "fixed",
      date: new Date("2026-05-30T00:00:00Z"),
    });
    expect(mime).toContain("Content-Transfer-Encoding: base64");
    expect(mime).toContain("Message-ID: <fixed@libyy.way2api.fun>");
    expect(mime).not.toContain("注册验证码");
  });

  it("escapes template payloads", () => {
    expect(renderTemplate("REGISTER_CODE", { code: "<script>", expiresInSeconds: 600 }).html).not.toContain("<script>");
  });

  it("renders automation and team notifications with escaped business context", () => {
    const automationTemplates = [
      "AUTO_RESERVATION_SUCCESS",
      "AUTO_RESERVATION_FAILED",
      "AUTO_SIGN_SUCCESS",
      "AUTO_SIGN_FAILED",
      "AUTO_SIGNOUT_SUCCESS",
      "AUTO_SIGNOUT_FAILED",
    ];
    for (const template of automationTemplates) {
      const rendered = renderTemplate(template, {
        roomName: "<7E08>",
        date: "2026-06-12",
        startTime: "09:00",
        endTime: "10:00",
        participants: ["<学生>"],
        reason: "<失败>",
      });
      expect(rendered.html).toContain("2026-06-12");
      expect(rendered.html).not.toContain("<7E08>");
      expect(rendered.html).not.toContain("<学生>");
      expect(rendered.html).not.toContain("<失败>");
    }

    const teamTemplates = ["TEAM_INVITATION_ACCEPTED", "TEAM_INVITATION_REJECTED", "TEAM_MEMBER_LEFT", "TEAM_MEMBER_REMOVED", "TEAM_DISBANDED"];
    for (const template of teamTemplates) {
      const rendered = renderTemplate(template, { teamName: "<小队>", memberName: "<成员>", operatorName: "<队长>" });
      expect(rendered.html).not.toContain("<小队>");
      expect(rendered.html).not.toContain("<成员>");
      expect(rendered.html).not.toContain("<队长>");
    }
  });

  it("uses the documented retry schedule", () => {
    expect([1, 2, 3, 4, 5].map(retryDelayMs)).toEqual([60_000, 300_000, 900_000, 3_600_000, null]);
  });
});
