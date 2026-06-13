import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

function sourceFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name) ? [absolute] : [];
  });
}

function relative(file: string): string {
  return path.relative(process.cwd(), file).replaceAll("\\", "/");
}

function callsGlobalFetch(file: string): boolean {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "fetch") {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("official network boundary", () => {
  it("keeps every backend fetch and official base URL behind the approved adapters", () => {
    const files = sourceFiles(path.resolve("src"));
    const rawFetchUsers = files
      .filter(callsGlobalFetch)
      .map(relative);
    const officialBaseUsers = files
      .filter((file) => fs.readFileSync(file, "utf8").includes("LIBYY_API_BASE_URL"))
      .map(relative)
      .sort();

    expect(rawFetchUsers).toEqual(["src/lib/official.ts"]);
    expect(officialBaseUsers).toEqual([
      "src/config.ts",
      "src/lib/official.ts",
      "src/node/cas-login.ts",
      "src/node/env.ts",
    ]);
  });

  it("does not allow REST or Playwright to fall back to direct execution", () => {
    const officialSource = fs.readFileSync(path.resolve("src/lib/official.ts"), "utf8");
    const casSource = fs.readFileSync(path.resolve("src/node/cas-login.ts"), "utf8");
    const playwrightNavigationUsers = sourceFiles(path.resolve("src"))
      .filter((file) => /\.goto\s*\(/.test(fs.readFileSync(file, "utf8")))
      .map(relative);

    expect(officialSource).toContain('throw new HttpError(503, "OFFICIAL_GATEWAY_UNAVAILABLE"');
    expect(officialSource).not.toContain("if (!env.OFFICIAL_GATEWAY) return execute()");
    expect(casSource).toContain('throw new CasAutomationError("OFFICIAL_GATEWAY_UNAVAILABLE"');
    expect(casSource).not.toContain("return this.runAttempt(attemptId);");
    expect(playwrightNavigationUsers).toEqual(["src/node/cas-login.ts"]);
  });
});
