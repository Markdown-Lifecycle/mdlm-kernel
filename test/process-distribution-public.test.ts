import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { installedProcessPackageRoot } from "../src/installed-process-package.js";
import { processPackageDigest } from "../src/process-package-digest.js";

test("independent process data initializes named and external packages with exact identities", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mdlm-process-distribution-"));
  const executable = path.join(process.cwd(), "dist/mdlm.js");
  const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [executable, ...args, "--json"], {cwd: root, encoding: "utf8"}));
  try {
    const version = cli("--version").version;
    const declaredVersion = JSON.parse(await fs.readFile(path.join(process.cwd(), "package.json"), "utf8")).version;
    expect(version).toBe(declaredVersion);
    expect(cli("release-notes").notes.split("\n")).toContain(`# ${version}`);
    for (const [name, reference] of [["tiny", "mdlm-tiny@1.0.1"], ["exploratory", "mdlm-exploratory@1.0.0"], ["iterative", "mdlm-iterative@2.5.44"]] as const) {
      const destination = path.join(root, name);
      const initialized = cli("init", destination, ...(name === "tiny" ? [] : ["--process", name]));
      expect(initialized.package.reference).toBe(reference);
      expect(initialized.package.digest).toBe(await processPackageDigest(installedProcessPackageRoot(name)));
      expect(await processPackageDigest(path.join(destination, ".lifecycle/packages", reference))).toBe(initialized.package.digest);
    }
    const external = path.join(root, "external");
    const fixture = path.join(root, "separate-package");
    await fs.cp(installedProcessPackageRoot("iterative"), fixture, {recursive: true});
    expect(cli("init", external, "--package", fixture).package.reference).toBe("mdlm-iterative@2.5.44");
    const conflict = path.join(root, "conflict");
    expect(spawnSync(process.execPath, [executable, "init", conflict, "--package", fixture, "--process", "iterative", "--json"], {cwd: root}).status).toBe(1);
    await expect(fs.stat(conflict)).rejects.toMatchObject({code: "ENOENT"});
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
});
