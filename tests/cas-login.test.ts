import path from "node:path";
import { describe, expect, it } from "vitest";
import { casProfilePath } from "../src/node/cas-login";

describe("CAS browser profile isolation", () => {
  it("assigns a distinct persistent directory to each user", () => {
    const root = path.resolve("data/playwright-profiles");
    const first = casProfilePath(root, "11111111-1111-4111-8111-111111111111");
    const second = casProfilePath(root, "22222222-2222-4222-8222-222222222222");

    expect(first).not.toBe(second);
    expect(path.dirname(first)).toBe(root);
    expect(path.dirname(second)).toBe(root);
  });

  it("rejects values that could escape the profile root", () => {
    expect(() => casProfilePath("data/playwright-profiles", "../../other-user")).toThrow("Invalid user id");
  });
});
