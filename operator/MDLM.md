# Run MDLM

Start from the stakeholder's intended outcome and the current lifecycle. In an initialized repository, read the selected package's overview when present:

```bash
mdlm_package_path=$(jq -r '.package.path' .lifecycle/process-selection.json)
if [ -f "$mdlm_package_path/README.md" ]; then
  cat "$mdlm_package_path/README.md"
fi
```

Run this lookup from the lifecycle repository root. The selection file identifies the installed package; keep its exact identity. If it has no README, use discovery and action guidance directly:

```bash
mdlm expectations --json
mdlm expectations show <action> [<exact-subject>] --json
```

Discovery and guidance are read-only. Priority is a suggestion. Save the full
guidance response, then read `prompt.content` and every `prompt.skills[].content`
before carrying out the action. Display long content in bounded sections until
all supplied instructions are read; saved paths, digests and metadata alone do not
establish that reading. Apply those instructions and inspect the exact inputs,
schemas and candidate examples. Preserve source-free handoff boundaries below.

For an implementation using independent verification, inspect a requirement's
recorded code responsibilities, shared needs and related checks together:

```sh
mdlm trace impact <exact-REQ> --implementation <exact-IMP> --summary
```

The summary preserves exact revisions and evidence status. Shared needs are not
automatically changed, and historical passes do not verify a successor. Follow its
full-output command pointers for details. Omit `--summary` for existing trace JSON;
`--summary` cannot be combined with `--json`.

Repeat this loop until the agreed outcome or a concrete blocked boundary:

1. Settle any uncertain earlier publication or execution before choosing more work. Otherwise inspect current expectations and compare them with stakeholder intent and actual product-use evidence.
2. Choose one useful eligible action and briefly state why. Ask the stakeholder when missing intent or a material scope decision prevents that choice. Keep the scope as small as the useful outcome permits. Where the package supports exploration, use a runnable slice to answer an unresolved product question; use observations to judge what deserves formal commitment. For an accepted product, inspect the package's comparison or approved-change route before adopting a change.
3. Retrieve that action's exact guidance and carry out the authorized work. At a required review or stakeholder decision, initiate the request with the exact context described below. If no stakeholder or review manager is configured, ask the host for that contact. Continue independent authorized work while waiting; resume dependent work only after the required response.
4. Preserve the returned result, inspect and commit accepted data as described below, then retrieve fresh expectations. Use settlement when the response is uncertain. Let the new state and evidence guide the next choice.

At a package boundary, compare the exact accepted scope with the agreed outcome. Optional work need not all be exhausted. Report the usable artifact and how to exercise it, the actual acceptance or exploratory boundary, and any remaining work or concrete blocker. If guidance is blocked, required authority is unavailable, or publication cannot be authenticated, preserve the exact state and report the missing information. A stopped or uncertain operation is not completion.

Author a proposal with a unique operation ID, the guidance's action, package, snapshot, exact subject and inputs, and your candidates. Each candidate supplies a localId, type, payload, links and body. A revision also names its exact predecessor. References to another candidate use `$<localId>` for its revision or `$<localId>.id` for its stable identity. MDLM generates revision identities and managed data.

Each entry in `links` has `type` and `target` strings, for example `{"type":"verifies","target":"<exact-REQ-or-EXP-revision>"}` in a verification candidate. Use the exact revisions or candidate local references required by the selected link, and preserve supplied fixed links.

Prepare an editable draft for the action you chose. Use a fresh operation ID and a new file path. For example, after selecting `draft-requirements` on a new tiny product:

```sh
mdlm expectations show draft-requirements --json
mdlm proposal draft draft-requirements --operation requirements-001 --output proposal.json --json
# Edit proposal.json using the prompt and payloadSchemas returned above.
mdlm proposal submit proposal.json --json
mdlm proposal settlement requirements-001 --json
```

For work on an exact subject, put its revision after the action in both `expectations show` and `proposal draft`. Drafting resolves the current action version and copies the package, snapshot, exact subject, inputs, candidate fixed values, required links and predecessors. A revision or correction draft also starts from the predecessor's authored payload and body. It carries only authored links whose targets are still current. Context links such as `corrects`, CLI-generated requirement links, links to superseded revisions and product `verification` selections are not carried. Add those links yourself, edit the fields that change, and keep the predecessor. A selection-only revision that keeps the predecessor's context, such as `update-verification-selection` or `update-criterion-verification-selection`, does carry the current `verification` selections; add only the revised activity's new revision. It returns the saved file's absolute path, byte count and SHA256. Existing files are preserved and cause an error. Relative output paths resolve from the current directory, as proposal submission paths do.

For an independent verification result, add `--activity <exact-VFY>` to `proposal draft` to generate its `evaluates` link. Use the exact activity selected for the captured execution. Drafting checks that it belongs to the subject's selected verification activities; an invalid selection or a different action capability fails before creating the file. You still select the receipt and author the assessment. Without `--activity`, drafting adds the sole selected activity when there is exactly one. With zero or multiple selected activities, it keeps the ordinary candidate skeleton.

Complete the candidate payloads and body using the returned schemas and package prompt. Candidate examples may lack required authored fields. Preserve fixed values and bindings. Add receipt or registered review evidence when required; the sections below describe those requirements. For stakeholder actions, drafting prepares `evidence.authority` with the required role name. It does not supply the stakeholder decision or submission authority, choose receipts or reviews, validate the finished claims or publish lifecycle data. A draft can become stale while being edited; submission still checks the exact snapshot and package.

Use a new operation for a new proposal. Preserve the exact submitted bytes. After an interrupted or lost submission response, inspect settlement before doing more work. Accepted settlement authenticates the existing publication. Inspect and commit accepted lifecycle data before retrieving fresh guidance.

When an independent reviewer withdraws the only blocking requirements finding and no definition needs correction, an eligible iterative `correct-requirements-after-review` can publish only the RQS candidate. Remove unused REQ and DCP draft placeholders; keep the exact RQS predecessor and `corrects` link to the failed Review, and explain the independent withdrawal in the RQS body. The CLI derives the selection. After publication and settlement, verify that all selected requirement and group revisions remain unchanged, then export fresh `review-requirements` context for the returned RQS successor and use the normal independent review handoff. The reviewer judges the complete context and supplies exactly the current native assessment rows. This revises the RQS history boundary while preserving requirement definitions and prior Reviews; the author relays the independently registered verdict unchanged.

Before authoring a verification script or choosing its tools and evidence, read
"Native verification runtime" in `docs/contracts/direct-work.md` in the MDLM
installation containing your CLI, alongside that installation's `README.md`.
It describes the fixed runtime and capture limits and the fields authors can set.

When the selected package supports independent verification, export the requirement or criterion context for a fresh verification author:

```bash
mdlm verification context <exact-RQS-or-EXP> --output verification-context.json --json
mdlm verification status <exact-product> --json
```

When the installed package requests a six-field source-free guidance projection,
copy those unchanged fields from the saved `expectations show` response:

```sh
jq '{action, subject, package, prompt, payloadSchemas, candidates}' saved-guidance.json
```

Save the output to a new file and include its path, byte count and SHA256 in the
handoff alongside the required verification-context export and public operation
contact. The installed package controls the permitted fields. Keep full guidance
with the lifecycle author; the projection does not replace the intent export.

Follow that package's plan and review guidance. Keep verifier authoring separate from implementation source and explanations. Select exact activities on the product, then execute each with `mdlm execution run <exact-product> <operation-id> --activity <exact-VFY> --json`. Read case results and evidence before publishing the assessment. Shared scripts are supported; complete requirement coverage still needs an explicit adequacy judgment.

Before a for-credit pass, check readiness with `mdlm execution dry-run <exact-product> [--activity <exact-VFY>]... [--source <product-commit>] --json`. It runs the selected activities, or all of them, in the same native runtime and reruns only those whose activity text, verifier bytes, runtime image or product inputs changed; `--all` reruns everything. `--source` tries a committed candidate product before you publish it. Read `ready`, each activity's `outcome`, `failingCases`, `cache` and `invalidatedBy` from the JSON rather than a prose summary. A dry run publishes nothing, takes no lock and is never evidence. When it is ready, run every activity once with `mdlm execution run` on the frozen product.

For a package using product-owned verification, commit the product source and verification script, then run:

```bash
mdlm execution run <exact-implementation-or-prototype> <operation-id> --json
mdlm execution settlement <operation-id> --json
```

Use `mdlm execution export <operation-id> <new-directory> --json` to inspect saved receipt evidence as files. This read-only export never repeats the command and preserves an existing destination. Read the actual receipt and captured output. Guidance's `evidence` array lists available receipt locators; choose the exact receipt supporting the proposed result or observation. The proposal's `evidence` is an object with a `receipt` field:

```json
{"evidence": {"receipt": "<exact git-blob: locator from guidance.evidence>"}}
```

Replace the placeholder with the complete selected locator string. This is a top-level proposal field, separate from the candidate payload. Keep the original captured execution when correcting the evidence envelope. A failing execution is evidence to assess, not a reason to discard history. Recover an uncertain execution through settlement; never start another execution merely because its response was lost.

For a review handoff, reuse the file identities from the already saved successful
`execution.export` JSON result. For example, if that capture is saved as
`execution-export-metadata.json`, derive absolute file references with:

```sh
jq '. as $export | $export.files | map({path: ($export.path + "/" + .path), bytes, sha256})' execution-export-metadata.json
```

Use these rows in the existing handoff without manually copying or recalculating
their byte counts and hashes. Retain the saved result's operation and export root,
the complete review-context handoff, and every supplemental claim, prior finding,
control result and command capture. Continue the existing operation/context and
artifact-byte authentication and independent review. This composition does not
require another execution or export.

Selected guidance states `effectiveAuthority`: `{kind: "autonomous"}` for work that requires no authority supply, or the declared stakeholder/independent-review kind and exact name. The existing `authority` field remains present only for a declared authority requirement. Both fields describe the selected action; a stakeholder decision about product meaning does not change that action's submission authority. Preserve the generated draft's evidence and use the matching submission route.

For stakeholder decisions, ask the named stakeholder using the exact guidance context. For change approval, follow the package prompt's review-context export instructions to include CLI-derived prospective impact in the request. When the required authority name is `stakeholder`, drafting prepares this top-level proposal field. Include it yourself when authoring a proposal without drafting:

```json
{"evidence": {"authority": ["stakeholder"]}}
```

Submit with the matching explicit flag:

```bash
mdlm proposal submit proposal.json --authority stakeholder --json
```

Use the exact authority name from guidance for both the array and flag. Authority comes from the attended answer, never from agent inference. Recorded engineering-demo delegation applies only to its named demo.

For independent review, save the full context and generate its handoff:

```bash
mdlm review context <action> <exact-subject> --output review-context.json --json
```

Pass the returned handoff to the review manager. It contains the saved file's absolute path, byte count and SHA256, with the exact action, subject, snapshot and package. The fresh reviewer reads that file. Choose a new path for each export; existing files are preserved and cause an error. Omitting `--output` returns the full context on stdout. The export SHA256 identifies the saved bytes; registration's canonical context digest is a separate value.

For a requirements review, read the exact assessment rows from the saved context:

```sh
jq '.requirementGraphs[] | {selection, requirements: .assessment.requirements, groups: .assessment.groups}' review-context.json
```

Use these requirement IDs and group/child coordinates for structured assessments,
not `allowedRequirements` or every record in the graph. Review the full graph and
relevant adjacent lifecycle context; the row list only defines output membership.
The reviewer supplies every disposition and rationale independently.

For related lifecycle context within the review's input boundary, use existing
inspection commands:

```sh
mdlm history <stable-id> --json
mdlm show <exact-revision> --json
mdlm backlinks <exact-revision> --json
mdlm trace <exact-revision> --relation <relation> --depth <integer> --json
```

History lists revisions; read their contents with exact `show` calls. Use `rg` on
retained lifecycle Markdown or `git grep` at the recorded lifecycle commit to find
relevant unlinked context. These CLI inspections read current repository state;
use the retained repository cut for historical review and save material exact
supplemental records with the existing handoff.

Verifier files may include binary evidence with `encoding: "base64"`. Inspect the
saved export by selected fields rather than printing the full binary content.
For example, list the files with
`jq '.verifierSources[] | {activity, sourceCommit, files: [.files[] | {path, blob, encoding}]}' review-context.json`.
Text files have no encoding field and keep readable `content`. To view binary
evidence, select its exact activity and path, decode its content as base64 to a
separate file, and open that file. Preserve the original export for registration.

The review manager registers the exact proposal and verdict through `mdlm review register <proposal-file> <verdict-file> --json`. The author must not register its own judgment. Submit the exact registered proposal bytes.

For a fresh useful-product-to-baseline experiment, initialize with `mdlm init /path/to/lifecycle --process iterative`, then read the installed package overview using the selection lookup above. Its accepted formal scope is a profile boundary; compare that exact scope with the agreed whole product before declaring the experiment complete.

## Explicit compatible upgrades

Kernel selection and Process Package selection are independent. Before an explicit
package upgrade, read its distribution notes and use `mdlm upgrade preview
<package-directory> --json` to inspect required work before and after. Save the JSON
outside the product, apply it with `mdlm upgrade apply <preview-file> <operation-id>
--json`, and recover uncertain publication with `mdlm upgrade settlement
<operation-id> --json`. Use current expectations to handle resulting loose ends.
The visible process-selection pin changes atomically; historical data and authoring
packages remain intact. README.md defines compatibility limits. Process definition
changes belong in the independent mdlm-process-package repository.

An unchanged independently authored method can retain its exact VFY and adequacy
review when its original package/publication and current semantic intent authenticate.
New execution and RES bind the target package. Before pending product review,
execute the selected methods freshly on the same IMP and record target-package
results; older results remain preserved and become superseded. An old-package
receipt does not become current review or historical-applicability evidence.
Current independent review can require revised methods or fresh observations.
An accepted product needs no rerun solely for selection when the target still
declares its completed boundary. Inspect release notes and before/after expectations
for actual new process duties. New and revised VFY use the current authoring export.

When guidance exposes `historicalEvidenceMode`, a result proposal may explicitly
name an original passing `evidence.historicalResult` from the immediate predecessor
IMP instead of a receipt. Only an unchanged selection-only successor qualifies.
The kernel derives `historical_observation`, keeps original execution times and
bytes, and checks relevant unresolved or later failing attempts. Inspect its
historical labels and complete original evidence. A current independent reviewer
still judges every obligation and may require a fresh run; this mode supplies no
new sample, current-host-equivalence claim or inherited implementation Review.
