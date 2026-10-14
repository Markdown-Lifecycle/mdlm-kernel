# 0.1.1

Process Packages declaring `staged-requirements@1` can draft stakeholder requirements first, then add one decomposition group per transaction. Requirement sets may be published and reviewed before every stakeholder root is decomposed, and each set records the kernel-managed `trace_complete`. The named elaboration action may only add one group under an existing requirement, containing every added software requirement and optionally existing shared children, with every earlier requirement and group revision unchanged, so the next review assesses only that group. Implementation publication still requires a complete graph. Packages without the capability keep the existing completeness checks at set publication. Compatible upgrade does not add this capability.

The default dependency is now Process Package distribution 2.5.40, whose iterative package uses staged requirements and requires this kernel. Fresh `mdlm init --process iterative` products start with stakeholder requirements, then add one reviewed decomposition group at a time. Existing products keep their selected package.

Compatible direct upgrades can opt into `verification-applicability@1` while
preserving existing capability bindings and repository contracts. Unchanged
authenticated VFY retain their exact authoring package and method revision when
all current semantic context matches. New/revised method publication remains
current-package-authored. Pending product review needs fresh target-package
execution/results on the existing IMP; old observations retain their original
packages, bytes and times and cannot become target-package historical evidence.
Current independent review and stakeholder acceptance remain required. This
source change does not select a package for any existing product, change the
default dependency or establish installed qualification/live adoption.

Review context file export now offers explicit `--format shared-verifier-trees` with `--output FILE`. The self-contained archive retains every complete verifier file list, ordered activity occurrence and receipt while storing identical file lists once. `mdlm review expand-context ARCHIVE --output NEW_FILE` restores the full expanded context without lifecycle or source repositories. Default expanded exports and native registration/publication hashes remain unchanged; existing packets keep their recorded identities.

The kernel supports independently correcting an acknowledged error in a failed requirements judgment. Process Packages declaring `review-correction@1` can offer recovery on the same current, unaccepted requirement set. The corrected judgment needs independent reviewer authorship and manager registration, an exact link to the original failure, and a correction reason. Original failure and authority bytes remain history. Current judgments determine the ordinary scoped requirement and decomposition correction frontier; recovery grants no additional stakeholder scope.

The default dependency is Process Package distribution2.5.26 at exact commit `f2e5e45da40a64783ae835bf3c835778fde558ce`. Its iterative package offers this recovery action and requires the new capability, which older kernels reject. Kernel installation alone leaves existing products on their selected package. Compatible `mdlm upgrade` may add this supported service while retaining existing capability bindings, repository contracts and historical data.

Focused source tests and a disposable pricing-history fixture exercised corrected membership allocation, ordinary subsequent correction, preserved history and rejected invalid authority or subjects. These checks used synthetic review transport and do not establish actual independent product judgment, installed release qualification or native product acceptance.

# 0.1.0

The kernel now has an independent release version. Earlier kernel artifacts used version0.0.0 and were identified by source commit and digest. Process Package data moved to the separate private mdlm-process-package repository and distribution2.5.23 without changing package bytes or identities.

`npm ci` installs the exact pinned private Git commit and requires GitHub SSH access. Bare initialization continues selecting mdlm-tiny@1.0.1; named exploratory and iterative initialization remain available. `mdlm init DESTINATION --package DIRECTORY` validates and copies an independently installed package directory.

Existing products continue loading their selected local package. Updating the kernel does not select a new package or rewrite accepted history. The extraction adds no loose ends. Compatible direct products can explicitly preview and apply a newer local Process Package through `mdlm upgrade`, with release notes and before/after work. Immutable transaction and authority history retain their exact authoring packages. Targets must declare compatible migration and retain supported repository contracts; current extracted packages remain fresh-only until a separate compatible release. Package distribution release notes describe package adoption support. Required direct/expression/kernel capability contracts are unchanged, and focused installed tests exercise all three package identities against this kernel release.
