import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const casSource = await readFile(new URL("../src/node/cas-login.ts", import.meta.url), "utf8");
const mailSource = await readFile(new URL("../src/lib/mail.ts", import.meta.url), "utf8");

function sourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

test("automatic recovery blocks before any SMS send request", () => {
  const completeSms = sourceSection(
    casSource,
    "private async completeSms(",
    "private waitForSmsCode(",
  );
  const autoRecoveryGuard = completeSms.indexOf('attempt.purpose === "AUTO_RECOVERY"');
  const sendSms = completeSms.indexOf("await this.trySendSmsCode(");

  assert.notEqual(autoRecoveryGuard, -1);
  assert.notEqual(sendSms, -1);
  assert.ok(autoRecoveryGuard < sendSms);

  const blockedBranch = completeSms.slice(autoRecoveryGuard, sendSms);
  assert.match(blockedBranch, /await blockCredentialRecovery\(/);
  assert.match(blockedBranch, /MANUAL_RECOVERY_REQUIRED_UNTIL/);
  assert.match(blockedBranch, /CAS_SMS_MANUAL_LOGIN_REQUIRED/);
});

test("only a user-started login clears the automatic recovery block", () => {
  const startAttempt = sourceSection(
    casSource,
    "async startAttempt(",
    "async startRecovery(",
  );

  assert.match(
    startAttempt,
    /purpose !== "AUTO_RECOVERY"\)\s+await clearCredentialRecoveryBlock\(/,
  );
});

test("login security and admin test mail bypass notification opt-out", () => {
  const mandatoryMatch = mailSource.match(
    /const MANDATORY_TEMPLATES = new Set\(\[([^\]]+)\]\);/,
  );
  assert.ok(mandatoryMatch);

  const templates = JSON.parse(`[${mandatoryMatch[1]}]`).sort();
  assert.deepEqual(templates, [
    "REGISTER_CODE",
    "RESET_PASSWORD_CODE",
    "TEST_EMAIL",
  ]);
  assert.match(
    mailSource,
    /if \(MANDATORY_TEMPLATES\.has\(template\)\) return true;/,
  );
  assert.match(mailSource, /email_notifications_enabled === 1/);
});
