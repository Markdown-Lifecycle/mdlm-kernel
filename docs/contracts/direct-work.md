# Direct lifecycle work contract

`src/direct-contract.ts` owns the shared types. Legacy assignment cutover is fresh-only. Compatible upgrades between direct-contract packages use the public upgrade commands documented in README.md and retain exact authoring provenance.

Packages declare `actions/<id>.yaml` with kind `action-definition`, integer version, semantic capability, allowed `types`, and `prompt_ref`. Optional subject/input expressions provide context; `when` is an eligibility expression evaluated before inputs, with the exact subject bound. Authority names are explicit per action. Optional actions, such as requesting a post-acceptance change, do not prevent completion. `priority` is display order, never a claim on work.

CLI:
- `mdlm expectations --json`
- `mdlm expectations show <action> [<exact-subject>] --json`
- `mdlm proposal draft <action> [<exact-subject>] --operation <operation> --output <new-file> [--activity <exact-activity>] --json`
- `mdlm proposal submit <file|-> [--authority <name>] --json`
- `mdlm proposal settlement <operation> --json`
- `mdlm execution run <exact-implementation> <operation> --json`
- `mdlm execution settlement <operation> --json`
- `mdlm review context <action> <exact-subject> --json`
- `mdlm review register <proposal-file> <verdict-file> --json`

A proposal names the caller's operation identity, package action, exact package and snapshot, optional subject/input revisions, candidates and evidence. The snapshot digest covers the lifecycle repository identity, the first-parent root commit of `HEAD`, together with the package and data, so a proposal or review registration drafted in another repository is rejected even when both hold identical data. `mdlm init` records a random nonce in that commit. Repositories initialized earlier derive the same identity from their existing root commit; two such repositories initialized in the same second with the same package share it. A clone or copy of a lifecycle repository shares its identity, so create each lane with `mdlm init`, never by copying a template repository. [Digest preimages](digests.md) documents the exact snapshot and other digest inputs. Candidate local references use `$<localId>` for an exact revision and `$<localId>.id` for its stable ID. A revision candidate supplies `predecessor` as an exact prior revision. The kernel allocates identities, resolves references and publishes the entire batch atomically. Candidate `created_by`, revision IDs and managed fields are never authored.

Core owns read-only missing-data discovery and eligibility. Domain module exports `finalizeDirectDomain(context)` for generated fields/data and associated semantic validation; finalization takes `DirectFinalizationContext` and returns `Promise<DirectFinalizationResult>`. Errors reject without publication. The domain module owns requirement, source and engineering constraints.

Authority module exports `buildDirectReviewContext(context: DirectContext)`, `registerDirectReview(root,context,proposalSource,verdictSource)`, and `validateDirectAuthority(context: DirectContext,proposal: DirectProposal,proposalSource: string): Promise<unknown>`. The last function returns durable evidence for the transaction or rejects. It must allow autonomous actions and require exact registered independent judgment or explicitly supplied stakeholder authority for protected actions. Complete source and verification receipt context must remain bound. Registry transport is not an OS authentication boundary.

Review context `verifierSources[].files` retains every regular file in the exact
verifier commit, including committed screenshots and other binary evidence.
Each file has its `path`, Git `blob` identity and `content`. Without `encoding`,
content is UTF-8 text. Files containing invalid UTF-8 or NUL bytes instead have
`encoding: "base64"`; decode their content as base64 to recover the exact bytes.
Export, review registration and publication bind the same complete content.
Activity review continues to exclude product implementation source.

For smaller self-contained transport, opt in explicitly:

```sh
mdlm review context <action> <exact-subject> --output review.archive.json --format shared-verifier-trees --json
mdlm review expand-context review.archive.json --output review.expanded.json --json
```

The archive payload contract is `mdlm-review-context-archive@1`. Its `context`
retains every other expanded field. Each `verifierSources` occurrence retains
its activity and source commit and uses `filesRef`, a zero-based index into the
embedded `verifierSourceTrees` array of complete ordered file lists. Follow that
index inside the same file to read every source path, blob, encoding and content.
Only exactly equal lists share an entry; repeated files and activity occurrences
remain intact. Receipts and other evidence are unchanged. Expansion requires
only the archive and CLI, with no lifecycle or source repository access. Unknown
versions or missing embedded references fail before output creation. Outputs
are new files, and existing outputs are never overwritten.

Default context stdout and file exports remain expanded v1. Consumers expecting
`verifierSources[].files` must expand an archive first. Export receipts still
use `mdlm-review-export@1` and pin the actual saved bytes. Archives are transport,
not native registration inputs; registration and publication continue to build
and hash the complete expanded context. Existing packets keep their bindings.

An activity's authoring subject is its action's exact subject or, for a requirement set, an earlier revision of that set whose verified target revisions and their interface revisions are still selected unchanged in the current set.

When an activity's exact authoring subject is a requirement set, its review
context includes that set's complete requirement graph. This contextual graph
does not expand the activity's selected verification or assessment targets.

Transaction provenance is `created_by.transaction = mdlm-direct-transaction@1`. The immutable record contains exact outputs and package/snapshot/operation/proposal digest bindings. Settlement authenticates all outputs, returns identical accepted work and rejects different content reusing the same operation. Guidance is read-only. No token, Assignment, lease or Scenario invocation authorizes publication.

Manifest declares `direct_contract: mdlm-direct@1` and `terminal: {when: <expression>, outcome: profile-boundary-reached | lifecycle-complete, reason: <text>}`. Result interfaces are in `direct-contract.ts`; guidance is returned directly with `ok:true` added, never wrapped in a packet. Rejected CLI operations return `{ok:false, diagnostics:[{code,message}]}` and nonzero exit.

Actions may declare `links` from output type and link name to an exact input name, `revises` from output type to predecessor input, and `fixed_payload` per type. These constraints apply to authored outputs before publication. Every current action publishes one authored datum except the `requirements` capability, which publishes its requirement/group/set batch, and `verification-activity`, which may publish multiple activities in one proposal; kernel-derived source scopes remain in the same transaction.

Stakeholder proposals carry `evidence.authority`, which must exactly match the explicitly supplied command flags. Adapters obtain those flags from attended transport, never from model-authored values. Accepted results and settlement return `proposalDigest` over the exact submitted UTF-8 JSON bytes. Review context is returned directly as `{ok:true,...context}`; execution guidance includes `executionSubject`, `executionCommand`, receipt locators and `receiptDetails` with captured output.

Guidance and review-context `payloadSchemas` describe authorable candidate fields;
computed fields remain present in the full records under review. For a changed
implementation review, both exports include `sourceAssessmentTargets`: its
`sourceScopes` are the exact affected baseline revisions requiring one
`source_assessments` row each. Current scopes and before/after comparisons remain
evidence for those judgments. Registration binds a verdict to its context;
publication still validates field permissions and exact assessment coverage.

For an implementation review, `sourceScopes[].acceptedBaseline` additionally
follows the reviewed implementation's exact requirement selection through
`changes-under` to a change, `baseline` to an accepting decision, and `accepts`
to the prior implementation. It contains those four records as `requirements`,
`change`, `acceptance` and `implementation`, the prior `source` and `scopes`, and
the accepted-to-current `comparison`. The existing `changes` and `comparison`
retain their nearest-source meaning; required assessment rows do not change.
The extra object is absent without a change baseline. Missing or conflicting
references fail explicitly; no latest acceptance or review-history inference is
used. Activity reviews do not receive this product-source context.

Verification-method and implementation reviews also receive `priorNormativeContext`
when their exact selected requirement set names an approved `changes-under` revision.
It contains the set locator as `selection`, the exact `change`, its passing
`approvals`, and only the prior `requirements` directly named by the change's
`changes` links. Approval uses the native rule: a configured review-type record
with outcome `pass` and an exact `reviews` link to that change. Publication enforces
stakeholder authority. All matching passing approvals are retained, without
substituting a newer change revision or guessing a latest decision. Each set binds
at most one change, as required by the native contract. Missing or conflicting
references and missing approval fail explicitly.

This addition is absent for initial work without a change and for authoring
contexts. It follows no prior requirement links or earlier change history, adds
no product source to method review, and leaves the current graph, selected
verification targets, assessment rows and existing history fields unchanged.
The complete added records participate in the normal canonical review-context
digest, so changing their content invalidates an earlier registration.

A review of a revised subject additionally receives `lineage`: every earlier
revision of the subject's stable ID as `predecessors`, the subject's exact
`corrects` targets as `answers`, its exact `changes-under` targets as `changes`,
and as `decisions` the answered records plus every review-output or acceptance
record linking to a predecessor or change. For a requirement set,
`predecessorGraph` is the immediately preceding set's graph with its
diagnostics. `lineage` is absent for a first revision without such links; an
unavailable exact link target fails explicitly. It is context only: selected
records, requirement graphs and required assessment rows do not change. Because
it is part of the digested context, a later judgment on a predecessor makes an
earlier registration stale.

A revised verification activity authored against a requirement set also receives
`verificationCoverageChanges`. It compares case IDs with the immediate activity
predecessor and lists removed cases whose old targets have the same stable ID as
a requirement in the current exact authoring set. Each entry retains all exact
old targets, separates retired targets, and pairs surviving old/current requirement
revisions with the current activity's case IDs. Both activity revisions, authoring
subjects, verifier repository paths and source commits remain explicit. Ordering
is deterministic; first revisions omit the comparison and retired-only removals
produce no entries. The requirements-only authoring export is unchanged.

This is changed coverage for review, not proof of missing coverage or adequacy.
Cases can be renamed, merged or replaced, and coverage can move to another
selected activity. An empty comparison does not establish that assertions or
stimuli survived beneath unchanged case IDs. Those changes still need semantic
review. Publication and acceptance rules are unchanged.

## Explicit formal source selection

The opt-in requirement-trace@3 capability retains the v2 graph contract and permits IMP acceptance_scope partial with an exact nonempty formal_files list. Whole-product coverage remains the default and forbids a file selection. The complete committed source inventory and every file role remain visible. Partial inventory entries expose formal true or false; only formal files derive SCP data. The verifier must be formal. Unsupported binary entries, symlinks and submodules remain unsupported even when provisional.

Execution receipts bind formalFiles alongside the exact IMP, RQS, source commit, command and image. The executor removes unselected committed files before mounting the source snapshot. An exercised dependency on omitted source cannot pass. This does not prove unexercised branches or infer dependency completeness; independent review judges the declared claim against all visible source. Review context exposes acceptanceScope and a formal flag on every source file. Acceptance applies to the exact IMP and commit, never automatically to a later commit with similar files. A partial profile boundary is not whole-product completion.


## Independent verification

The fresh iterative package opts into `requirement-trace@4` and `independent-verification@1`. Historical packages retain their selected contracts. Product attribution remains required; `source_ranges` supports explicit language-neutral production ranges. Verification source lives in a separate committed repository and is selected by exact product `verification` links to VFY. It needs no product-owned verifier regions.

`mdlm verification context <exact-RQS-or-EXP> --output <new-file> --json` exports requirements, decomposition and necessary public ICDs for a fresh verifier author, excluding implementation source. The activity records its authoring subject/context, method, cases, expected results and target coverage. Independence is an authoring and review boundary; co-mounted source directories do not constitute an operating-system prohibition on reading source.

After a compatible package upgrade, an unchanged authenticated existing activity
may retain its original authoring-package identity. Its exact original publication
and package must authenticate through retained repository provenance and selection
history. All current semantic context, instructions and capability bindings still
match; package identity alone may differ. Caller copies and new/revised proposal
outputs receive no historical authoring evidence and must match the current export.
Execution and fresh RES bind the current selected package. Older package receipts
cannot support current target-package review or historical RES applicability.
Fresh observations can supersede older results on the same exact IMP and VFY
without rewriting either method or product history. Current independent review
still judges current obligations, method adequacy and complete execution evidence.

`mdlm execution run <exact-IMP-or-TRY> <operation> --activity <exact-VFY> --json` binds separate product and verifier commits, exact activity/cases and pinned environment. The report contract `mdlm-verification-results@1` contains cases with case_id, outcome, actual_results and evidence_refs. The complete activity is selected before execution. Missing, duplicate or unknown case output is an error. Case outcomes and artifact identities are kernel-managed RES fields. Exact executes, verifies and evaluates links bind product, requirement/criterion selection and activity. A new result supersedes prior current results only for that exact product/activity; old evidence is retained.

`mdlm verification status <exact-product> --json` reports coverage, adequacy review, current case outcomes and missing or stale evidence. Formal verified requires sufficient independently reviewed coverage and current passing results for every required case. The exact product review assesses the union of selected activity coverage for every requirement, so several individually adequate partial activities do not automatically establish complete coverage. EXP outcomes remain provisional observations. Acceptance checks the complete selected requirement graph. An old product or criterion pass does not automatically verify a successor source or promoted requirement.

`mdlm execution export <operation> <new-directory> --json` materializes saved raw
stdout/stderr, report and captured artifacts, with file paths, sizes and SHA256
values in its response. Inspect the complete receipt in the preserved execution
response or `mdlm execution settlement <operation> --json` response. Match
`value.evidence` to the exact `git-blob:` locator selected for the result.

Settlement and export select the operation's latest receipt. For historical
inspection, compare that locator with the original result's receipt before using
exported files. If they differ, inspect the exact original receipt and its embedded
artifacts in the preserved response or with `git cat-file blob <receipt-oid>` in
the lifecycle repository. Export never reruns execution or changes lifecycle
data. Missing parent directories are created. The destination must be new;
existing evidence is preserved.

## Native verification runtime

`mdlm execution run` executes committed source in a disposable Docker container.
Plan the verification method and captured evidence for these limits before
authoring the script. The method must still support the claim and its required
coverage.

| Runtime constraint | Public execution behavior |
| --- | --- |
| Network | Docker `--network none`; external networking is unavailable. |
| Filesystem and user | Read-only container root and source mounts; non-root user, all capabilities dropped and no new privileges. Independent verification uses the non-root caller's UID/GID, or `65534:65534` for a root caller. Product-owned verification uses `65534:65534`. |
| Processes | Fixed Docker PID limit of 128. |
| Shared memory | Writable `/dev/shm`, fixed at 128 MiB (`--shm-size=128m`). |
| Temporary files | Writable `/tmp` tmpfs, limited to 64 MiB, with effective `noexec,nosuid,nodev`. Docker supplies the `noexec` default; the runtime does not override it with `exec`. |
| Execution time | The public command uses a 60-second wait for container completion. Timeout kills the container and records an error. Docker create and start each also have a 60-second timeout; this is not a 60-second limit for the whole CLI invocation. |
| Captured output | Combined stdout and stderr capture is limited to 16 MiB. Exceeding it records an incomplete-capture error. |
| Source size | Each committed source tree (product and verifier) must `git archive` to at most 16 MiB. A larger archive records a `source`-phase error naming the archive size before any container starts. |
| Verifier files | The verifier commit may contain only regular committed files. Symlinks (for example `node_modules/.bin/*` from `npm install`) and submodules are rejected when the activity is published. |

Verification activity publication (plan, revise and correct routes) checks the
verifier commit's archive size and file types, and rejects the activity with the
offending path or the actual archive size.

These settings are fixed through the public CLI. There is no activity field or
execution flag to override the timeout, PID limit, shared-memory or tmpfs size, networking or
capture budgets.

Independent verification mounts the committed product at `/product` and verifier
at `/verification`, both read-only, and starts in `/verification`. It supplies
`MDLM_PRODUCT_DIR=/product` and `MDLM_EVIDENCE_DIR=/evidence`. The writable
`/evidence` directory holds the report and its referenced artifacts. Product-owned
verification instead mounts its committed source read-only at `/workspace` and
starts there. Image tools and committed dependencies must be usable without
network downloads or writes to those source directories.

Do not directly execute binaries or executable scripts copied into `/tmp`;
`noexec` prevents that even when their executable mode bits are preserved. For
independent verification that needs a writable executable copy, prepare it in a
subdirectory of `/evidence` and preserve executable modes. That bind mount uses
the host backing filesystem, which must permit execution; MDLM does not override
a host `noexec` restriction. Keep preparation files separate from report artifacts
and reference only the evidence needed for each case. Product-owned verification
has no `/evidence` mount.

An independent activity selects `repository_path`, `source_commit`,
`verification_script`, `verification_command`, `verification_image` and
`results_path` through its authorable schema. The command is an argv array whose
first element becomes the container entrypoint. The image must be pinned as
`name@sha256:<digest>`; independent verification also accepts an exact local
`sha256:<image-id>`. Product-owned verification takes its source, script, command
and digest-pinned image from the product payload.

For independent verification, `results_path` identifies a JSON report relative to
`/evidence`. Write a report with this shape, using the activity's declared case IDs:

```json
{
  "contract": "mdlm-verification-results@1",
  "cases": [
    {
      "case_id": "example",
      "outcome": "pass",
      "actual_results": ["observation"],
      "evidence_refs": []
    }
  ]
}
```

`actual_results` must be a nonempty array of nonblank strings, even for one
observation. `evidence_refs` is an array of nonblank relative file paths and may
be empty when no artifact is referenced. `outcome` is `pass`, `fail`, `error` or
`skipped`. Emit each declared case exactly once.

Case `evidence_refs` are also relative to `/evidence`. Their paths
must resolve through directories to regular files, without symlinks or `..`
components. The report bytes plus all distinct referenced artifact bytes share
one fixed 8 MiB budget, separate from stdout/stderr. This is a capture budget,
not a quota on the writable directory. Unreferenced files are not captured.
Missing or oversized referenced evidence makes the run an error, even when the
script exits successfully. Inspect the receipt diagnostic and export the saved
evidence before assessing the result.

After writing the complete independent verification report, make the verifier
script's exit status agree with its case outcomes:

| Report case outcomes | Verifier script exit | Run outcome |
| --- | --- | --- |
| Every case is `pass` | `0` | `pass` |
| At least one `fail`, with no `error` or `skipped` cases | `1` | `fail` |
| Any `error` or `skipped` case, including when other cases fail | `2` | `error` |

These are the verifier script's exit codes, not the product command's exit codes
or the MDLM CLI's exit status. Compute the exit from the reported outcomes after
writing the report; successfully writing a report containing failures does not
justify exit zero. A disagreement between report and script exit records an
execution error. An invalid report or incomplete evidence capture also records
an error regardless of the script's exit status.

## Editable proposal drafts

`proposal draft` uses the same current guidance and action resolution as `expectations show`. The caller selects the action, optional exact subject, operation identity and new output file. The saved JSON contains the complete proposal envelope and the candidate examples, including fixed payload values, exact links and predecessors. A candidate that names a predecessor also starts from that predecessor's authored payload and body, with kernel-managed fields omitted and fixed payload values replacing carried ones. Links are carried narrowly. The draft keeps a predecessor link when its target is still the latest revision and its relation is authored for the type. For an independent verification activity, it also keeps exact `uses-interface` revisions required by the draft's retained `verifies` targets, even when a newer interface revision exists. Some relations are never carried: any relation a package action fixes for the type (context such as `corrects` or `responds-to`, which comes fresh from this action's inputs), relations the CLI generates for requirement tracing (`contains`, `decomposition`, `retires`, `changes-under`, `baseline`), and product `verification` selections. When every link the action fixes is already on the predecessor and the action does not fix `verification` itself, as for a selection-only revision such as `update-verification-selection` or `update-criterion-verification-selection`, the draft keeps the predecessor's current `verification` selections and drops superseded ones, so the author adds only the revised activities. Otherwise the author must choose current activities again, so an unedited correction without that choice is rejected. Review the carried payload and links, add the links that were not carried, and edit what changes. Submission validates the edited candidate as usual. For stakeholder actions it also prepares `evidence.authority` with the exact required role name. Autonomous and independent-review drafts do not receive that field. This declaration supplies no stakeholder decision or submission authority: the caller still supplies the matching explicit `--authority` flag after the actual decision. Drafting supplies no semantic claims, receipt selection or review evidence. Authored fields still need the prompt and `payloadSchemas` from guidance.

For an `independent-result` action, optional `--activity <exact-activity>` selects one exact revision from the subject's verification activities and adds its `evaluates` link to the capability-bound result candidate. Existing fixed links and envelope bindings remain unchanged. An invalid, conflicting or inapplicable selection fails before output creation. Omitting the option adds the exact `evaluates` link when the subject selects exactly one verification activity, using the same validation. Zero or multiple selected activities preserve the ordinary candidate skeleton. An explicit selection takes precedence over this default. This only prepares the link; receipt selection and submission's exact receipt/activity validation remain unchanged.

The `mdlm-proposal-draft@1` handoff reports `export.path`, `export.bytes`, `export.exportSha256`, operation, action, package, snapshot, optional subject and inputs, plus authoring instructions and the guidance command arguments. The digest describes the initial saved bytes; editing changes it. Relative paths follow existing CLI file resolution. Exclusive creation preserves existing files. Drafting leaves lifecycle data unchanged and does not reserve the snapshot or operation. Normal submit validation and settlement remain authoritative.

```sh
mdlm expectations show draft-requirements --json
mdlm proposal draft draft-requirements --operation requirements-001 --output proposal.json --json
# Fill authored candidate fields from the prompt and payloadSchemas.
mdlm proposal submit proposal.json --json
mdlm proposal settlement requirements-001 --json
```

## Correcting an independent requirements judgment

Packages declaring `review-correction@1` may offer independent same-subject recovery for a current unaccepted failed requirement-set review. Publish a new review identity, one exact `supersedes` link to the active failed judgment, and a nonblank `correction_reason`. The action requires independent review authority and fixes its supersession link from the exact failure input. Original review bytes and registration remain historical evidence. Current review selection omits superseded judgments; normal scoped requirement correction follows the corrected assessments. Recovery does not grant stakeholder scope or revise accepted subjects.

### Staged requirement graphs

The opt-in `staged-requirements@1` capability binds `type` to the requirement-trace@4 set type, which declares `trace_complete` as kernel-managed, and names one `action`: an unauthorized requirements action that revises the set. Publication and review then accept a graph whose stakeholder roots are not all decomposed yet, or that has no software leaf yet. The kernel records `trace_complete` on every published set. Implementation publication still requires a complete graph, so execution and acceptance, which bind an implementation, do too. Verification authoring may start on a partial graph.

The named elaboration action may only add exactly one decomposition group. Its parent is a requirement selected by the predecessor set. Its children include every newly added software requirement, and may also reuse existing selected requirements as shared children. Every previously selected requirement and group revision stays unchanged. Rewording, removal, new stakeholder roots and membership changes use the correction or stakeholder refinement actions. Review credit is unchanged: after a passing review, the next review assesses only the added requirements and group. Older kernels reject the capability, and compatible upgrade does not add it.

### Interface retargets

A requirement binds exact interface revisions with `uses-interface`. A package declaring `interface-retarget@1`, bound to the requirement-trace@4 set type with a `retargets-interface` relation, lets a requirement-set candidate add `retargets-interface` links to exact ICD revisions. In that set, every selected requirement bound to an older revision of the same agreement uses the named revision instead; the requirement and its groups keep their revisions. The kernel carries each retarget to later sets in the lineage, rejects two retargets of one agreement in a set, rejects a retarget older than the preceding set's, and rejects a selected requirement that binds a newer revision than the set's retarget until the set retargets that revision. Older kernels reject the capability; compatible upgrade may add it. A requirement revision keeps its predecessor's `uses-interface` binding for every agreement it does not bind itself.

Review treats a retarget as a binding change. Assessment rows include every selected requirement whose effective bindings differ from those it last passed under, or from the accepted baseline during a change, and each requirement graph in review context lists `interfaceRetargets` as `requirement`, `bound` and `selected`. The verification authoring export shows each requirement's effective bindings, so new activities link the retargeted revision. An activity is validated against its own `authoring_subject`, so an activity whose targets are unchanged stays valid and selectable after a retarget.

### Historical verification applicability

The opt-in `verification-applicability@1` capability binds `type` to the existing
independent-verification result type. That type declares optional
`historical_observation` as kernel-managed. Older kernels reject the capability;
packages without it retain exact execution bindings and reject historical mode.
This extends result publication, with no new lifecycle type or execution state.

An ordinary `independent-result` proposal may use `evidence.historicalResult` to
name one exact original passing RES instead of `evidence.receipt`. Guidance
advertises this field as `historicalEvidenceMode`. The original RES must bind an
earlier IMP of the same stable lineage and exact package. Every later revision up
to the successor must be selection-only, and every current result for the activity
on an intermediate revision must apply that same original. Name the original
execution RES, never a historical one. The kernel compares the complete product
payload except derived source_changes, retains source commit/tree, inventory,
roles/ranges, command and acceptance scope/formal files, and verifies exact
requirements, activity authoring context/interfaces and verifier execution
contract. Changed sibling activities alone do not invalidate the unchanged method.
Reused observations, prototypes, source reverts and cross-package reuse are
unsupported.

Publication authenticates the original direct transaction, registered completed
receipt, retained report/case/artifact bytes, passing outcome and pinned image
identity. It derives unchanged outcome, receipt, case_results, artifacts and
historical_observation containing contract, original_result,
original_implementation, receipt, execution_operation, started_at, finished_at and
applied_at. The latter is publication time, separate from original execution times.
The original receipt/operation/RES remain unchanged. Authors cannot supply managed
provenance. Successor executes/verifies/evaluates links scope the applicability
claim and do not assert a new execution. Original execution export remains the
supported way to read saved bytes.

Registered relevant attempts include unrecorded failures and errors. An unresolved
latest started marker or later failing/errored observation blocks applicability.
The same validator runs at publication, status, current review export/registration
and acceptance. Complete current review context includes the original RES,
predecessor IMP and full original receipt, source, verifier and observations, with
historical labeling. Current review independently judges every obligation, shared
assumptions, changed siblings, environmental relevance and freshness, and may
require fresh execution. Applicability transfers no earlier implementation Review
or accepted conformance. It proves neither determinism nor current-host equivalence;
unknown relevant conditions and explicit fresh-run obligations need fresh evidence.
Acceptance retains current independent review and stakeholder authority.
