import { connect } from "cloudflare:sockets";
import type { AppEnv } from "../config";
import { base64Utf8, createMimeMessage, dotStuff } from "./mail-content";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const RESPONSE_LIMIT = 8192;
const TIMEOUT_MS = 12_000;

function timeout<T>(promise: Promise<T>, milliseconds = TIMEOUT_MS): Promise<T> {
  let handle: ReturnType<typeof setTimeout>;
  const rejected = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(new Error("SMTP timeout")), milliseconds);
  });
  return Promise.race([promise, rejected]).finally(() => clearTimeout(handle));
}

class SmtpConnection {
  private buffer = "";
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;

  constructor(private readonly socket: Socket) {
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }

  async response(expectedCode: number): Promise<void> {
    const code = String(expectedCode);
    while (true) {
      const lines = this.buffer.split("\r\n");
      for (let index = 0; index < lines.length - 1; index += 1) {
        const line = lines[index] ?? "";
        if (/^\d{3} /.test(line)) {
          this.buffer = lines.slice(index + 1).join("\r\n");
          if (!line.startsWith(`${code} `)) throw new Error(`SMTP rejected command (${line.slice(0, 3)})`);
          return;
        }
      }
      if (this.buffer.length > RESPONSE_LIMIT) throw new Error("SMTP response too large");
      const chunk = await timeout(this.reader.read());
      if (chunk.done) throw new Error("SMTP connection closed");
      this.buffer += decoder.decode(chunk.value, { stream: true });
    }
  }

  async command(command: string, expectedCode: number): Promise<void> {
    await timeout(this.writer.write(encoder.encode(`${command}\r\n`)));
    await this.response(expectedCode);
  }

  async data(message: string): Promise<void> {
    await timeout(this.writer.write(encoder.encode(`${dotStuff(message)}.\r\n`)));
    await this.response(250);
  }

  close(): void {
    this.writer.releaseLock();
    this.reader.releaseLock();
    this.socket.close();
  }
}

export async function sendSmtpMail(
  env: AppEnv,
  input: { recipientEmail: string; subject: string; html: string },
): Promise<void> {
  if (!env.SMTP_PASSWORD) throw new Error("SMTP password missing");
  if (String(env.SMTP_SECURE).toLowerCase() !== "true") throw new Error("Only direct TLS SMTP is supported");
  const port = Number(env.SMTP_PORT);
  if (!Number.isInteger(port) || port <= 0 || port === 25) throw new Error("Invalid SMTP port");

  const socket = connect({ hostname: env.SMTP_HOST, port }, { secureTransport: "on", allowHalfOpen: false });
  const smtp = new SmtpConnection(socket);
  try {
    await timeout(socket.opened);
    await smtp.response(220);
    await smtp.command("EHLO libyy.way2api.fun", 250);
    await smtp.command("AUTH LOGIN", 334);
    await smtp.command(base64Utf8(env.SMTP_USERNAME), 334);
    await smtp.command(base64Utf8(env.SMTP_PASSWORD), 235);
    await smtp.command(`MAIL FROM:<${env.SMTP_FROM_ADDRESS}>`, 250);
    await smtp.command(`RCPT TO:<${input.recipientEmail}>`, 250);
    await smtp.command("DATA", 354);
    await smtp.data(createMimeMessage({
      fromAddress: env.SMTP_FROM_ADDRESS,
      fromName: env.SMTP_FROM_NAME,
      toAddress: input.recipientEmail,
      subject: input.subject,
      html: input.html,
    }));
    await smtp.command("QUIT", 221);
  } finally {
    smtp.close();
  }
}
