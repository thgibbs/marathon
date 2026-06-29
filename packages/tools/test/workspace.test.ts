import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace";

describe("Workspace", () => {
  it("creates an ephemeral dir, reads/writes (incl. nested), lists, and disposes", async () => {
    const ws = await Workspace.create();
    expect(existsSync(ws.dir)).toBe(true);

    await ws.writeFile("note.txt", "hello");
    await ws.writeFile("docs/spec.md", "# spec");
    expect(await ws.readFile("note.txt")).toBe("hello");
    expect(await ws.readFile("docs/spec.md")).toBe("# spec");
    expect((await ws.list()).sort()).toEqual(["docs", "note.txt"]);

    await ws.dispose();
    expect(existsSync(ws.dir)).toBe(false);
  });

  it("dispose is idempotent", async () => {
    const ws = await Workspace.create();
    await ws.dispose();
    await expect(ws.dispose()).resolves.toBeUndefined();
  });
});
