import { connect } from "cloudflare:sockets";
import type { AppEnv } from "../config";
import { base64Utf8, createMimeMessage, dotStuff } from "./mail-content";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const RESPONSE_LIMIT = 8192;
const TIMEOUT_MS = 12_000;

type SmtpStage =
  | "CONFIG"
  | "CONNECT"
  | "GREETING"
  | "EHLO"
  | "AUTH"
  | "AUTH_USERNAME"
  | "AUTH_PASSWORD"
  | "MAIL_FROM"
  | "RCPT_TO"
  | "DATA"
  | "MESSAGE"
  | "QUIT";

export class SmtpDeliveryError extends Error {
  constructor(
    readonly diagnosticCode: string,
    options?: ErrorOptions,
  ) {
    super(diagnosticCode, options);
    this.name = "SmtpDeliveryError";
  }
}

function diagnosticSuffix(error: unknown): string {
  if (!(error instanceof Error)) return "FAILED";
  if (error.message === "SMTP timeout") return "TIMEOUT";
  if (error.message === "SMTP response too large") return "RESPONSE_TOO_LARGE";
  if (error.message === "SMTP connection closed") return "CONNECTION_CLOSED";
  const rejected = error.message.match(/^SMTP rejected command \((\d{3})\)$/);
  return rejected ? `REJECTED_${rejected[1]}` : "FAILED";
}

async function smtpStep<T>(stage: SmtpStage, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SmtpDeliveryError) throw error;
    throw new SmtpDeliveryError(`SMTP_${stage}_${diagnosticSuffix(error)}`, { cause: error });
  }
}

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
  if (!env.SMTP_PASSWORD) throw new SmtpDeliveryError("SMTP_CONFIG_PASSWORD_MISSING");
  if (String(env.SMTP_SECURE).toLowerCase() !== "true") throw new SmtpDeliveryError("SMTP_CONFIG_DIRECT_TLS_REQUIRED");
  const port = Number(env.SMTP_PORT);
  if (!Number.isInteger(port) || port <= 0 || port === 25) throw new SmtpDeliveryError("SMTP_CONFIG_INVALID_PORT");

  const socket = connect({ hostname: env.SMTP_HOST, port }, { secureTransport: "on", allowHalfOpen: false });
  const smtp = new SmtpConnection(socket);
  try {
    await smtpStep("CONNECT", () => timeout(socket.opened));
    await smtpStep("GREETING", () => smtp.response(220));
    await smtpStep("EHLO", () => smtp.command("EHLO libyy.way2api.fun", 250));
    await smtpStep("AUTH", () => smtp.command("AUTH LOGIN", 334));
    await smtpStep("AUTH_USERNAME", () => smtp.command(base64Utf8(env.SMTP_USERNAME), 334));
    await smtpStep("AUTH_PASSWORD", () => smtp.command(base64Utf8(env.SMTP_PASSWORD), 235));
    await smtpStep("MAIL_FROM", () => smtp.command(`MAIL FROM:<${env.SMTP_FROM_ADDRESS}>`, 250));
    await smtpStep("RCPT_TO", () => smtp.command(`RCPT TO:<${input.recipientEmail}>`, 250));
    await smtpStep("DATA", () => smtp.command("DATA", 354));
    await smtpStep("MESSAGE", () => smtp.data(createMimeMessage({
      fromAddress: env.SMTP_FROM_ADDRESS,
      fromName: env.SMTP_FROM_NAME,
      toAddress: input.recipientEmail,
      subject: input.subject,
      html: input.html,
    })));
    await smtpStep("QUIT", () => smtp.command("QUIT", 221));
  } finally {
    smtp.close();
  }
}
