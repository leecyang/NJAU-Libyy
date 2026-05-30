import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/lib/crypto";

describe("password hashing", () => {
  it("uses the PBKDF2 iteration limit supported by hosted Cloudflare Workers", async () => {
    const stored = await hashPassword("longpassword1", "pepper");

    expect(stored).toMatch(/^pbkdf2-sha256\$100000\$/);
    await expect(verifyPassword("longpassword1", stored, "pepper")).resolves.toBe(true);
    await expect(verifyPassword("wrongpassword1", stored, "pepper")).resolves.toBe(false);
  });

  it("rejects stored hashes that exceed the hosted Workers PBKDF2 limit", async () => {
    const stored = await hashPassword("longpassword1", "pepper");
    const unsupported = stored.replace("$100000$", "$160000$");

    await expect(verifyPassword("longpassword1", unsupported, "pepper")).resolves.toBe(false);
  });
});
