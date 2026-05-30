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

  it("uses the documented retry schedule", () => {
    expect([1, 2, 3, 4, 5].map(retryDelayMs)).toEqual([60_000, 300_000, 900_000, 3_600_000, null]);
  });
});

