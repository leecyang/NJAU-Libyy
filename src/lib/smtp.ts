import tls from "node:tls";
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

function once<T>(socket: tls.TLSSocket, event: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off(event, onEvent);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onEvent = (value: T) => {
      cleanup();
      resolve(value);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("SMTP connection closed"));
    };
    socket.once(event, onEvent);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

class SmtpConnection {
  private buffer = "";
  private waiters: Array<() => void> = [];

  constructor(private readonly socket: tls.TLSSocket) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer += decoder.decode(chunk);
      const waiters = this.waiters.splice(0);
      for (const waiter of waiters) waiter();
    });
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
      await timeout(new Promise<void>((resolve) => this.waiters.push(resolve)));
    }
  }

  async command(command: string, expectedCode: number): Promise<void> {
    await timeout(new Promise<void>((resolve, reject) => {
      this.socket.write(`${command}\r\n`, (error) => error ? reject(error) : resolve());
    }));
    await this.response(expectedCode);
  }

  async data(message: string): Promise<void> {
    await timeout(new Promise<void>((resolve, reject) => {
      this.socket.write(encoder.encode(`${dotStuff(message)}.\r\n`), (error) => error ? reject(error) : resolve());
    }));
    await this.response(250);
  }

  close(): void {
    this.socket.end();
  }
}

export async function sendSmtpMail(
  env: AppEnv,
  input: { recipientEmail: string; subject: string; html: string },
): Promise<void> {
  const smtpPassword = env.SMTP_PASSWORD;
  if (!smtpPassword) throw new SmtpDeliveryError("SMTP_CONFIG_PASSWORD_MISSING");
  if (String(env.SMTP_SECURE).toLowerCase() !== "true") throw new SmtpDeliveryError("SMTP_CONFIG_DIRECT_TLS_REQUIRED");
  const port = Number(env.SMTP_PORT);
  if (!Number.isInteger(port) || port <= 0 || port === 25) throw new SmtpDeliveryError("SMTP_CONFIG_INVALID_PORT");

  const socket = tls.connect({ host: env.SMTP_HOST, port, servername: env.SMTP_HOST });
  const smtp = new SmtpConnection(socket);
  try {
    await smtpStep("CONNECT", () => timeout(once(socket, "secureConnect")));
    await smtpStep("GREETING", () => smtp.response(220));
    await smtpStep("EHLO", () => smtp.command("EHLO libyy.local", 250));
    await smtpStep("AUTH", () => smtp.command("AUTH LOGIN", 334));
    await smtpStep("AUTH_USERNAME", () => smtp.command(base64Utf8(env.SMTP_USERNAME), 334));
    await smtpStep("AUTH_PASSWORD", () => smtp.command(base64Utf8(smtpPassword), 235));
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
