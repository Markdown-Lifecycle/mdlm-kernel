import { promises as fs } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import { loadProcessPackage } from "./index.js";
import {
  directState,
  directExpectations,
  directDigest,
} from "./direct-proposal.js";
import { readRepositoryData } from "./lifecycle-repository.js";
import {
  packageSummary,
  processSelection,
  repositoryDescriptor,
  selectionRelativePath,
  packagesRelativePath,
  repositorySummary,
} from "./repository-contract.js";
import {
  readSelection,
  selectedRepositoryPackage,
} from "./selected-package.js";
import { withRepositoryLock } from "./repository-lock.js";
import {
  upgradeGit,
  upgradeDescriptor,
  readUpgradeReceipt,
  upgradeReceiptsPath,
} from "./process-upgrade-selection.js";

const operationValid = (operation: string) =>
  /^[a-zA-Z0-9-]{1,80}$/.test(operation);
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
async function kernelIdentity() {
  return JSON.parse(
    await fs.readFile(new URL("../package.json", import.meta.url), "utf8"),
  ).version as string;
}
async function notes(target: string) {
  // Distribution notes sit outside the independently hashed process roots.
  const file = path.join(path.dirname(target), "RELEASE-NOTES.md");
  const source = await fs.readFile(file, "utf8");
  return { path: file, text: source, digest: directDigest(source) };
}
export async function previewProcessUpgrade(
  root: string,
  targetDirectory: string,
) {
  const current = await directState(root);
  const targetPath = path.resolve(root, targetDirectory);
  const loaded = await loadProcessPackage(targetPath);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.diagnostics));
  const target = loaded.package;
  const summary = await packageSummary(target, targetPath);
  if (
    (target.manifest.compatibility as Record<string, unknown>)
      ?.repository_migration !== "compatible"
  )
    throw new Error(
      "Target package must declare repository_migration compatible",
    );
  if (summary.reference === current.package.reference)
    throw new Error("Upgrade requires a different exact package reference");
  if (
    target.manifest.id !== current.pkg.manifest.id ||
    target.manifest.direct_contract !== "mdlm-direct@1" ||
    current.pkg.manifest.direct_contract !== "mdlm-direct@1"
  )
    throw new Error(
      "Upgrade supports the same direct-contract package family only",
    );
  for (const key of [
    "kernel_contract",
    "artifact_format",
    "language",
  ] as const) {
    if (!isDeepStrictEqual(current.pkg.manifest[key], target.manifest[key]))
      throw new Error(`Incompatible upgrade ${key}`);
  }
  // These additive services preserve every existing capability binding.
  const oldCapabilities = current.pkg.manifest.kernel_capabilities as Record<string, unknown>;
  const newCapabilities = target.manifest.kernel_capabilities as Record<string, unknown>;
  if (Object.entries(oldCapabilities).some(([name, binding]) => !isDeepStrictEqual(binding, newCapabilities[name])) || Object.keys(newCapabilities).some(name => !(name in oldCapabilities) && !["review-correction@1", "verification-applicability@1", "interface-retarget@1"].includes(name))) throw new Error("Incompatible upgrade kernel_capabilities");
  if (
    !isDeepStrictEqual(
      repositorySummary(current.pkg),
      repositorySummary(target),
    )
  )
    throw new Error("Incompatible repository contracts");
  // Current-schema compatibility is assessed against every preserved datum; no transformations.
  const data = await readRepositoryData(root, target);
  if (!data.ok)
    throw new Error(
      `Incompatible target data: ${JSON.stringify(data.diagnostics)}`,
    );
  const identity = {
    reference: summary.reference,
    digest: summary.digest,
    language: summary.language,
  };
  const afterState = {
    ...current,
    pkg: target,
    package: identity,
    parsed: data.value,
    snapshot: directDigest(
      JSON.stringify({
        package: identity,
        repository: current.repository,
        data: current.data,
      }),
    ),
  };
  const selectionBytes = await fs.readFile(
    path.join(root, selectionRelativePath),
    "utf8",
  );
  const before = directExpectations(current),
    after = directExpectations(afterState);
  const workKey = (item: { action: string; subject?: string }) =>
    `${item.action}#${item.subject ?? ""}`;
  const previousWork = new Set(before.items.map(workKey));
  return {
    ok: true,
    contract: "mdlm-process-upgrade-preview@1",
    repository: current.repository,
    snapshot: current.snapshot,
    selectionDigest: directDigest(selectionBytes),
    head: await upgradeGit(root, ["rev-parse", "HEAD"]),
    from: current.package,
    target: identity,
    targetPath,
    kernel: { version: await kernelIdentity() },
    notes: await notes(targetPath),
    before,
    after,
    looseEnds: {
      added: after.items.filter((item) => !previousWork.has(workKey(item))),
      remaining: after.items.filter((item) => previousWork.has(workKey(item))),
    },
  };
}
export async function settleProcessUpgrade(root: string, operation: string) {
  if (!operationValid(operation)) throw new Error("Invalid operation identity");
  // Authenticate the visible selection before any negative publication answer.
  const selected = await selectedRepositoryPackage(root);
  if (!selected.ok) throw new Error(JSON.stringify(selected.diagnostics));
  const selection = (await readSelection(root)) as Awaited<
    ReturnType<typeof readSelection>
  > & { upgradeReceipt?: string };
  if (!selection) throw new Error("No initialized process selection");
  await upgradeDescriptor(root, selection);
  let current = selection.upgradeReceipt;
  while (current) {
    const value = await readUpgradeReceipt(root, current);
    if (value.operation === operation)
      return {
        ok: true,
        operation,
        outcome: "published",
        receipt: current,
        value,
      };
    current = value.previousReceipt;
  }
  let files: string[];
  try {
    files = await fs.readdir(path.join(root, upgradeReceiptsPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    files = [];
  }
  let prepared: { receipt: string; value: any } | undefined;
  for (const file of files) {
    if (!/^[a-f0-9]{64}\.json$/.test(file))
      throw new Error("Invalid upgrade receipt filename");
    const digest = `sha256:${file.slice(0, -5)}`;
    const value = await readUpgradeReceipt(root, digest);
    if (value.contract !== "mdlm-process-upgrade@1")
      throw new Error("Invalid prepared upgrade receipt");
    if (value.operation === operation) {
      if (prepared) throw new Error("Ambiguous upgrade operation receipts");
      prepared = { receipt: digest, value };
    }
  }
  return { ok: true, operation, outcome: "not-published", ...prepared };
}
export async function applyProcessUpgrade(
  root: string,
  source: string,
  operation: string,
) {
  if (!operationValid(operation)) throw new Error("Invalid operation identity");
  const {
    command: _command,
    diagnostics: _diagnostics,
    ...proposed
  } = JSON.parse(source);
  if (
    proposed.contract !== "mdlm-process-upgrade-preview@1" ||
    typeof proposed.targetPath !== "string"
  )
    throw new Error("Expected exact upgrade preview");
  const previewDigest = directDigest(json(proposed));
  return withRepositoryLock(
    root,
    "refs/mdlm/transaction-lock",
    async (renew) => {
      const saved = await settleProcessUpgrade(root, operation);
      if (saved.outcome === "published") {
        if (saved.value.previewDigest !== previewDigest)
          throw new Error(
            "Upgrade operation identity reused with different preview",
          );
        return saved;
      }
      if (saved.value && saved.value.previewDigest !== previewDigest)
        throw new Error(
          "Upgrade operation identity reused with different preview",
        );
      const fresh = await previewProcessUpgrade(root, proposed.targetPath);
      if (!isDeepStrictEqual(fresh, proposed))
        throw new Error(
          "Stale upgrade preview or changed target; preview again",
        );
      const packageRoot = path.join(
        root,
        packagesRelativePath,
        proposed.target.reference,
      );
      const staging = path.join(root, ".lifecycle", `.upgrade-${randomUUID()}`);
      const selectionFile = path.join(root, selectionRelativePath);
      let installed = false;
      let packageExists = false;
      let published = false;
      try {
        await fs.cp(proposed.targetPath, staging, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
        const staged = await loadProcessPackage(staging);
        if (
          !staged.ok ||
          !isDeepStrictEqual(await packageSummary(staged.package, staging), {
            id: staged.package.manifest.id,
            version: staged.package.manifest.version,
            ...proposed.target,
          })
        )
          throw new Error("Staged package differs from preview");
        try {
          await fs.access(packageRoot);
          const existing = await loadProcessPackage(packageRoot);
          if (
            !existing.ok ||
            !isDeepStrictEqual(
              await packageSummary(existing.package, packageRoot),
              await packageSummary(staged.package, staging),
            )
          )
            throw new Error("Installed target package differs from preview");
          packageExists = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const oldSelection = JSON.parse(
          await fs.readFile(selectionFile, "utf8"),
        );
        const summary = await packageSummary(staged.package, staging);
        const value = {
          contract: "mdlm-process-upgrade@1",
          operation,
          previewDigest,
          repository: fresh.repository,
          from: fresh.from,
          target: fresh.target,
          kernel: fresh.kernel,
          notes: fresh.notes,
          before: fresh.before,
          after: fresh.after,
          looseEnds: fresh.looseEnds,
          selection: processSelection(summary),
          descriptor: repositoryDescriptor(staged.package, summary),
          previousSelection: oldSelection,
          baselineDescriptor: JSON.parse(
            await fs.readFile(
              path.join(root, ".lifecycle/repository.json"),
              "utf8",
            ),
          ),
          ...(oldSelection.upgradeReceipt
            ? { previousReceipt: oldSelection.upgradeReceipt }
            : {}),
        };
        const receiptBytes = json(value);
        const oid = directDigest(receiptBytes);
        const receiptDirectory = path.join(root, upgradeReceiptsPath);
        await fs.mkdir(receiptDirectory, { recursive: true });
        const receiptFile = path.join(receiptDirectory, `${oid.slice(7)}.json`);
        const preparedReceipt = path.join(staging, ".upgrade-receipt");
        await fs.writeFile(preparedReceipt, receiptBytes, { flag: "wx" });
        try {
          await fs.link(preparedReceipt, receiptFile);
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code !== "EEXIST" ||
            (await fs.readFile(receiptFile, "utf8")) !== receiptBytes
          )
            throw error;
        }
        await fs.unlink(preparedReceipt);
        const temporaryPin = path.join(
          root,
          ".lifecycle",
          `.selection-${randomUUID()}`,
        );
        await fs.writeFile(
          temporaryPin,
          json({ ...value.selection, upgradeReceipt: oid }),
          { flag: "wx" },
        );
        try {
          // Recheck the exact pin and repository after staging, before the publication fence.
          if (
            directDigest(await fs.readFile(selectionFile, "utf8")) !==
              proposed.selectionDigest ||
            (await directState(root)).snapshot !== proposed.snapshot ||
            (await upgradeGit(root, ["rev-parse", "HEAD"])) !== proposed.head
          )
            throw new Error("Repository changed before upgrade publication");
          await renew();
          if (!packageExists) {
            await fs.rename(staging, packageRoot);
            installed = true;
          }
          await fs.rename(temporaryPin, selectionFile);
          published = true;
        } finally {
          await fs.rm(temporaryPin, { force: true });
        }
        return {
          ok: true,
          operation,
          outcome: "published",
          receipt: oid,
          value,
        };
      } finally {
        await fs.rm(staging, { recursive: true, force: true });
        if (installed && !published)
          await fs.rm(packageRoot, { recursive: true, force: true });
      }
    },
  );
}
