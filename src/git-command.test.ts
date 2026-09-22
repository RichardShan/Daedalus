import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);

describe("path-scoped git commit", () => {
  it("commits selected tracked and untracked files without consuming unrelated staged changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "daedalus-git-test-"));
    try {
      await exec("git", ["init", "-q"], { cwd: root });
      await exec("git", ["config", "user.name", "Daedalus Test"], { cwd: root });
      await exec("git", ["config", "user.email", "daedalus@example.invalid"], { cwd: root });
      await mkdir(path.join(root, "src"), { recursive: true });
      await writeFile(path.join(root, "src", "selected.txt"), "before\n", "utf8");
      await writeFile(path.join(root, "src", "unrelated.txt"), "before\n", "utf8");
      await exec("git", ["add", "--", "src/selected.txt", "src/unrelated.txt"], { cwd: root });
      await exec("git", ["commit", "-q", "-m", "initial"], { cwd: root });

      await writeFile(path.join(root, "src", "selected.txt"), "selected change\n", "utf8");
      await writeFile(path.join(root, "src", "unrelated.txt"), "unrelated staged change\n", "utf8");
      await writeFile(path.join(root, "src", "new.txt"), "new selected file\n", "utf8");
      await exec("git", ["add", "--", "src/unrelated.txt"], { cwd: root });
      await exec("git", ["add", "-N", "--", "src/new.txt"], { cwd: root });
      await exec("git", ["commit", "-q", "-m", "selected only", "--only", "--", "src/selected.txt", "src/new.txt"], { cwd: root });

      const { stdout: committed } = await exec("git", ["show", "--pretty=", "--name-only", "HEAD"], { cwd: root });
      expect(committed.trim().split("\n").sort()).toEqual(["src/new.txt", "src/selected.txt"]);
      const { stdout: staged } = await exec("git", ["diff", "--cached", "--name-only"], { cwd: root });
      expect(staged.trim()).toBe("src/unrelated.txt");
      expect(await readFile(path.join(root, "src", "new.txt"), "utf8")).toBe("new selected file\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
