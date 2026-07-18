import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isMainModule } from "./is-main-module.mjs";

let fixtureDirectory;

afterEach(async () => {
  if (fixtureDirectory) {
    await rm(fixtureDirectory, { recursive: true });
    fixtureDirectory = undefined;
  }
});

describe("isMainModule", () => {
  it("rejects an import without an argv entry", () => {
    expect(isMainModule({ argvPath: undefined, moduleUrl: import.meta.url })).toBe(false);
  });

  it("recognizes a module launched through a symlink", async () => {
    fixtureDirectory = await mkdtemp(join(tmpdir(), "spooool-main-module-"));
    const modulePath = join(fixtureDirectory, "script.mjs");
    const symlinkPath = join(fixtureDirectory, "script-link.mjs");
    await writeFile(modulePath, "");
    await symlink(modulePath, symlinkPath);

    expect(
      isMainModule({ argvPath: symlinkPath, moduleUrl: pathToFileURL(modulePath).href }),
    ).toBe(true);
  });
});
