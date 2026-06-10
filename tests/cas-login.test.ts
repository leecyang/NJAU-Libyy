import path from "node:path";
import { describe, expect, it } from "vitest";
import { casProfilePath, isAbortedNavigation } from "../src/node/cas-login";

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

describe("CAS navigation handling", () => {
  it("treats redirect-driven aborted navigations as recoverable", () => {
    expect(isAbortedNavigation(new Error("page.goto: net::ERR_ABORTED at https://libyy.njau.edu.cn/student/studentIndex"))).toBe(true);
    expect(isAbortedNavigation(new Error("Navigation interrupted by another one"))).toBe(true);
  });

  it("does not hide ordinary navigation failures", () => {
    expect(isAbortedNavigation(new Error("page.goto: net::ERR_NAME_NOT_RESOLVED"))).toBe(false);
    expect(isAbortedNavigation(new Error("page.goto: Timeout 60000ms exceeded"))).toBe(false);
  });
});
