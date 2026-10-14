import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";
import { expect, test } from "vitest";
import { installedProcessPackageRoot } from "../src/installed-process-package.js";
import { initializeRepositoryFromProcessPackage } from "../src/repository-initialization.js";

test("compatible direct upgrades preserve accepted authority, expose required work and settle exact operations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mdlm-upgrade-"));
  const repository = path.join(root, "product"),
    original = path.join(root, "original"),
    promptTarget = path.join(root, "prompt-target"),
    obligationTarget = path.join(root, "obligation-target");
  let commandRepository = repository;
  const cli = (status: number, ...args: string[]) => {
    const result = spawnSync(
      process.execPath,
      [path.join(process.cwd(), "dist/mdlm.js"), ...args, "--json"],
      { cwd: commandRepository, encoding: "utf8", timeout: 30_000 },
    );
    expect(result.status, result.stdout + result.stderr).toBe(status);
    return JSON.parse(result.stdout);
  };
  const edit = async (
    folder: string,
    file: string,
    change: (value: any) => void,
  ) => {
    const value = parse(await fs.readFile(path.join(folder, file), "utf8"));
    change(value);
    await fs.writeFile(path.join(folder, file), stringify(value));
  };
  const publish = async (operation: string) => {
    const file = path.join(root, `${operation}.json`);
    cli(
      0,
      "proposal",
      "draft",
      "record-interface",
      "--operation",
      operation,
      "--output",
      file,
    );
    const proposal = JSON.parse(await fs.readFile(file, "utf8"));
    proposal.candidates[0].payload = {
      ...proposal.candidates[0].payload,
      title: operation,
      boundary: "external",
      endpoints: [
        { name: "Product", owner: "Owner", responsibility: "Offer result" },
        { name: "User", owner: "Owner", responsibility: "Receive result" },
      ],
      interaction: "One result",
      failure_behavior: "Explain failure",
      compatibility: "Exact declared interface",
      assumptions: "Local invocation",
    };
    await fs.writeFile(file, JSON.stringify(proposal));
    return cli(0, "proposal", "submit", file, "--authority", "product-owner");
  };
  const preview = async (target: string, file: string) => {
    const value = cli(0, "upgrade", "preview", target);
    const { command: _command, diagnostics: _diagnostics, ...body } = value;
    await fs.writeFile(file, JSON.stringify(value));
    return body;
  };
  try {
    // A small authority-bearing process fixture isolates upgrades from Docker verification.
    await fs.cp(installedProcessPackageRoot("iterative"), original, {
      recursive: true,
    });
    await edit(original, "actions/record-interface.yaml", (a) => {
      a.authority = { kind: "stakeholder", name: "product-owner" };
      a.optional = false;
      a.when = 'none("current-interfaces@1", {})';
    });
    await edit(original, "manifest.yaml", (m) => {
      delete m.kernel_capabilities["review-correction@1"];
      m.terminal = {
        when: 'exists("current-interfaces@1", {})',
        outcome: "profile-boundary-reached",
        reason: "Owner accepted the bounded interface",
      };
    });
    await fs.writeFile(
      path.join(root, "RELEASE-NOTES.md"),
      "Compatible release notes.\n",
    );
    expect(
      (await initializeRepositoryFromProcessPackage(repository, original)).ok,
    ).toBe(true);
    const accepted = await publish("accepted-interface");
    const oldDatum = cli(0, "show", accepted.revisions[0]);
    const originalPin = await fs.readFile(
      path.join(repository, ".lifecycle/process-selection.json"),
      "utf8",
    );
    expect(cli(0, "expectations").outcome).toBe("profile-boundary-reached");
    await fs.cp(original, promptTarget, { recursive: true });
    await edit(promptTarget, "manifest.yaml", (m) => {
      m.kernel_capabilities["review-correction@1"] = {type: "RQS", review_type: "REV"};
      m.kernel_capabilities["verification-applicability@1"] = {type: "RES"};
      m.version = "2.5.24";
      m.compatibility.repository_migration = "compatible";
    });
    await edit(promptTarget, "types/RES.yaml", (t) => {
      t.payload_schema.properties.historical_observation = {type: "object"};
      if (!t.kernel_managed_payload_paths.includes("historical_observation")) t.kernel_managed_payload_paths.push("historical_observation");
    });
    const previewFile = path.join(root, "preview.json");
    const prompt = await preview(promptTarget, previewFile);
    expect(prompt.notes.text).toContain("Compatible release notes");
    expect(prompt.after.outcome).toBe(prompt.before.outcome);
    expect(
      await fs.readFile(
        path.join(repository, ".lifecycle/process-selection.json"),
        "utf8",
      ),
    ).toBe(originalPin);
    expect(
      cli(0, "upgrade", "apply", previewFile, "prompt-upgrade").outcome,
    ).toBe("published");
    expect(cli(0, "upgrade", "settlement", "prompt-upgrade").outcome).toBe(
      "published",
    );
    // Model interruption after preparation/ref registration but before atomic pin publication.
    const publishedPin = await fs.readFile(
      path.join(repository, ".lifecycle/process-selection.json"),
      "utf8",
    );
    await fs.writeFile(
      path.join(repository, ".lifecycle/process-selection.json"),
      originalPin,
    );
    expect(cli(0, "upgrade", "settlement", "prompt-upgrade").outcome).toBe(
      "not-published",
    );
    expect(
      cli(0, "upgrade", "apply", previewFile, "prompt-upgrade").outcome,
    ).toBe("published");
    expect(
      await fs.readFile(
        path.join(repository, ".lifecycle/process-selection.json"),
        "utf8",
      ),
    ).toBe(publishedPin);
    expect(
      cli(0, "upgrade", "apply", previewFile, "prompt-upgrade").outcome,
    ).toBe("published");
    expect(
      cli(0, "proposal", "settlement", "accepted-interface").proposalDigest,
    ).toBe(accepted.proposalDigest);
    expect(cli(0, "show", accepted.revisions[0]).lifecycleDatum).toEqual(
      oldDatum.lifecycleDatum,
    );
    expect(cli(0, "process", "show").package.reference).toBe(
      "mdlm-iterative@2.5.24",
    );
    expect(cli(0, "doctor").ok).toBe(true);
    await fs.cp(promptTarget, obligationTarget, { recursive: true });
    await edit(obligationTarget, "manifest.yaml", (m) => {
      m.version = "2.5.25";
      m.terminal.when = 'count("current-interfaces@1", {}) >= 2';
    });
    await edit(obligationTarget, "actions/record-interface.yaml", (a) => {
      a.when = 'count("current-interfaces@1", {}) < 2';
    });
    const obligation = await preview(obligationTarget, previewFile);
    expect(
      obligation.looseEnds.added.some((i: any) =>
        i.action.startsWith("record-interface@"),
      ),
    ).toBe(true);
    expect(obligation.after.outcome).toBe("work-available");
    expect(
      obligation.after.items.some((i: any) =>
        i.action.startsWith("record-interface@"),
      ),
    ).toBe(true);
    expect(
      cli(1, "upgrade", "apply", previewFile, "prompt-upgrade").diagnostics[0]
        .message,
    ).toContain("reused");
    cli(0, "upgrade", "apply", previewFile, "required-upgrade");
    await publish("additional-interface");
    expect(cli(0, "expectations").outcome).toBe("profile-boundary-reached");
    expect(cli(0, "upgrade", "settlement", "prompt-upgrade").outcome).toBe(
      "published",
    );
    expect(cli(0, "upgrade", "settlement", "required-upgrade").outcome).toBe(
      "published",
    );
    expect(cli(0, "show", accepted.revisions[0]).lifecycleDatum).toEqual(
      oldDatum.lifecycleDatum,
    );
    const upgradeRef = `refs/mdlm/upgrades/${createHash("sha256").update("required-upgrade").digest("hex")}`;
    execFileSync("git", ["-C", repository, "update-ref", "-d", upgradeRef]);
    expect(cli(0, "upgrade", "settlement", "required-upgrade").outcome).toBe(
      "published",
    );
    execFileSync("git", ["-C", repository, "add", "--all"]);
    execFileSync("git", [
      "-C",
      repository,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--no-verify",
      "-qm",
      "Preserve upgraded product",
    ]);
    const clone = path.join(root, "clone");
    execFileSync("git", ["clone", "--no-local", "--quiet", repository, clone]);
    commandRepository = clone;
    expect(cli(0, "doctor").ok).toBe(true);
    expect(cli(0, "expectations").outcome).toBe("profile-boundary-reached");
    expect(cli(0, "upgrade", "settlement", "prompt-upgrade").outcome).toBe(
      "published",
    );
    expect(cli(0, "upgrade", "settlement", "required-upgrade").outcome).toBe(
      "published",
    );
    expect(cli(0, "show", accepted.revisions[0]).lifecycleDatum).toEqual(
      oldDatum.lifecycleDatum,
    );
    const clonedPin = JSON.parse(
      await fs.readFile(
        path.join(clone, ".lifecycle/process-selection.json"),
        "utf8",
      ),
    );
    const clonedReceiptPath = path.join(
      clone,
      ".lifecycle/upgrades",
      `${clonedPin.upgradeReceipt.slice(7)}.json`,
    );
    const clonedReceiptBytes = await fs.readFile(clonedReceiptPath);
    await fs.unlink(clonedReceiptPath);
    expect(cli(1, "upgrade", "settlement", "unrelated-operation").ok).toBe(
      false,
    );
    await fs.writeFile(clonedReceiptPath, clonedReceiptBytes);
    commandRepository = repository;
    const pin = await fs.readFile(
      path.join(repository, ".lifecycle/process-selection.json"),
      "utf8",
    );
    await edit(promptTarget, "manifest.yaml", (m) => {
      m.kernel_capabilities["independent-verification@1"].requirement_type = "ICD";
    });
    expect(JSON.stringify(cli(1, "upgrade", "preview", promptTarget))).toContain(
      "Incompatible upgrade kernel_capabilities",
    );
    expect(await fs.readFile(path.join(repository, ".lifecycle/process-selection.json"), "utf8")).toBe(pin);
    await edit(promptTarget, "manifest.yaml", (m) => {
      m.kernel_capabilities["independent-verification@1"].requirement_type = "REQ";
    });
    expect(cli(1, "upgrade", "apply", previewFile, "stale").ok).toBe(false);
    expect(
      await fs.readFile(
        path.join(repository, ".lifecycle/process-selection.json"),
        "utf8",
      ),
    ).toBe(pin);
    await edit(promptTarget, "manifest.yaml", (m) => {
      m.version = "2.5.26";
      m.language.expressions = "unsupported@1";
    });
    expect(cli(1, "upgrade", "preview", promptTarget).ok).toBe(false);
    expect(
      await fs.readFile(
        path.join(repository, ".lifecycle/process-selection.json"),
        "utf8",
      ),
    ).toBe(pin);
    const selectedPackage = JSON.parse(pin).package.path;
    const targetManifest = path.join(
      repository,
      selectedPackage,
      "manifest.yaml",
    );
    const targetBytes = await fs.readFile(targetManifest);
    await fs.appendFile(targetManifest, "\n# altered target\n");
    expect(cli(1, "doctor").ok).toBe(false);
    await fs.writeFile(targetManifest, targetBytes);
    const oldManifest = path.join(
      repository,
      JSON.parse(originalPin).package.path,
      "manifest.yaml",
    );
    const oldBytes = await fs.readFile(oldManifest);
    await fs.appendFile(oldManifest, "\n# altered authoring package\n");
    expect(cli(1, "doctor").ok).toBe(false);
    await fs.writeFile(oldManifest, oldBytes);
    const baselineFile = path.join(repository, ".lifecycle/repository.json");
    const baselineBytes = await fs.readFile(baselineFile);
    await fs.writeFile(baselineFile, "{}");
    expect(cli(1, "doctor").ok).toBe(false);
    await fs.writeFile(baselineFile, baselineBytes);
    const selected = JSON.parse(pin);
    selected.package.digest = "sha256:" + "0".repeat(64);
    await fs.writeFile(
      path.join(repository, ".lifecycle/process-selection.json"),
      JSON.stringify(selected),
    );
    expect(cli(1, "doctor").ok).toBe(false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}, 120_000);
