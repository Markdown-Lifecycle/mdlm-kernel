# Upgrade an existing direct product

Run the chosen kernel executable inside the existing product. Installing or
choosing another kernel does not change the selected Process Package. Obtain an
exact compatible process release and its distribution `RELEASE-NOTES.md` locally;
upgrade commands perform no network lookup.

```bash
mdlm upgrade preview /absolute/path/to/distribution/iterative --json > /tmp/upgrade-preview.json
mdlm upgrade apply /tmp/upgrade-preview.json my-upgrade-001 --json
mdlm upgrade settlement my-upgrade-001 --json
mdlm process show --json
mdlm expectations --json
```

Preview includes the executing kernel version, exact old and target packages,
release notes, and required and optional work before and after the upgrade.
The target must declare `compatibility.repository_migration: compatible`.
This release supports the same package family and direct contract with unchanged
kernel contracts and existing capability bindings, and preserved data valid under both authoring
and target schemas. Legacy assignment products and transforming migrations are
unsupported. The supported additive `review-correction@1` and `verification-applicability@1` services may be introduced by a compatible upgrade; older kernels reject unsupported capabilities. A stale preview or changed artifact requires a fresh preview.

Apply atomically replaces `.lifecycle/process-selection.json`, which remains the
visible current pin. It retains old packages and lifecycle data. Its `upgradeReceipt`
binds a content-digested receipt in `.lifecycle/upgrades/` containing the exact descriptor, previous selection,
notes and operation; settlement recovers the result after response loss. Commit the receipts with the product so ordinary Git clones retain selection and settlement history.
`.lifecycle/repository.json` remains the original repository compatibility contract.
The kernel checks that contract and the receipt chain rather than rewriting
historical review or acceptance evidence. Current expectations follow the selected
process; a new required action can reopen work without erasing historic acceptance.

Unchanged independent verification activities retain their exact revisions and
adequacy judgments through a compatible upgrade. The kernel authenticates each
activity's original package and requirements-only authoring context, then checks
the current exact requirements, decomposition and interfaces. New or revised
activities must use the current package's authoring context. Current guidance
and independent review may still require a method change.

New execution and result publication bind the selected target package. For pending
product review, run the retained activities freshly and record their results on
the same implementation; new results supersede the old observations while
preserving their bytes and times. Old-package results cannot satisfy a new-package
review or historical applicability. Historical reuse starts with an original
observation under the target package and retains its selection-only lineage rule.
Completed acceptance history requires no execution solely for package selection.

Kernel and Process Packages release independently. `npm ci` installs the exact private package commit pinned in the lockfile and requires authenticated access to the private Git repository. Bare initialization uses tiny; named alternatives keep their existing behavior. To initialize with separately installed data, run `node dist/mdlm.js init ../my-product --package /absolute/path/to/package-root`. Existing products retain their selected local package. See [release notes](../RELEASE-NOTES.md) for update impact.

Before replacing a kernel, inspect its installed binary with `mdlm --version` and `mdlm release-notes`. These read the installed artifact and need no product repository.
