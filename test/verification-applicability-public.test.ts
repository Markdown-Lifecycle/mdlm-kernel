import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { expect, test } from "vitest";
import { directState } from "../src/direct-proposal.js";
import { historicalApplicability, validateHistoricalResult } from "../src/verification-applicability.js";
import { validateVerificationReceipt, readVerificationReceiptBlob } from "../src/verification-receipt.js";
import { independentExecutionBinding } from "../src/independent-verification.js";

// One compiled CLI transaction journey owns this trust boundary. In normal tests,
// a minimal opted-in fixture package declares the additive field; release proof
// supplies the actual separately versioned successor package through the env var.
test("explicit historical RES applicability preserves execution and requires current review", async () => {
  const root = await fs.mkdtemp(path.join(process.env.MDLM_APPLICABILITY_EVIDENCE_ROOT ?? os.tmpdir(), "mdlm-applicability-"));
  const repository = path.join(root, "lifecycle"), product = path.join(root, "product"), verifier = path.join(root, "verifier"), registry = path.join(root, "registry");
  const executable = path.join(process.cwd(), "dist/mdlm.js");
  const commands: unknown[] = []; let outcome = "failed", launches = 0;
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], {encoding: "utf8"}).trim();
  const commit = (cwd: string) => {git(cwd, "add", "."); git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "--no-verify", "--allow-empty", "-qm", "Applicability fixture"); return git(cwd, "rev-parse", "HEAD");};
  const cli = (args: string[], exit = 0, manager = false) => {
    const result = spawnSync(process.execPath, [executable, ...args, "--json"], {cwd: args[0] === "init" ? root : repository, encoding: "utf8", timeout: 90_000, maxBuffer: 32 * 1024 * 1024, env: {...process.env, MDLM_REVIEW_REGISTRY: registry, MDLM_REVIEW_REGISTRAR: manager ? "1" : "0"}});
    commands.push({args, status: result.status, stdout: result.stdout, stderr: result.stderr});
    expect(result.status, result.stdout + result.stderr).toBe(exit); return JSON.parse(result.stdout);
  };
  const guidance = (action: string, subject?: string) => cli(["expectations", "show", action, ...(subject ? [subject] : [])]);
  const datum = (id: string) => cli(["show", id]).lifecycleDatum.datum;
  const submit = async (g: any, operation: string, candidates = g.candidates, evidence?: any, review = false, exit = 0) => {
    const file = path.join(root, `${operation}.json`);
    await fs.writeFile(file, JSON.stringify({operation, action: g.action, package: g.package, snapshot: g.snapshot, ...(g.subject ? {subject: g.subject} : {}), inputs: g.inputs, candidates, ...(evidence ? {evidence} : {})}));
    if (review) cli(["review", "register", file, file], 0, true);
    const result = cli(["proposal", "submit", file, ...(evidence?.authority ? ["--authority", "stakeholder"] : [])], exit);
    if (!exit) commit(repository); return result;
  };
  const review = async (action: string, subject: string, operation: string) => {
    const g = guidance(action, subject), context = cli(["review", "context", action, subject]), c = g.candidates[0];
    c.payload = {...c.payload, title: "Scripted boundary fixture", outcome: "pass", findings: "Fixture simulates independent registration to test the gate; no production conformance claim"};
    if (action === "review-requirements") {
      const graph = context.requirementGraphs[0];
      c.payload.requirement_assessments = graph.requirements.map((r: any) => ({requirement: r.revision_id, disposition: "valid", rationale: "Necessary observable count"}));
      c.payload.decomposition_assessments = graph.groups.map((d: any) => ({group: d.revision_id, children: d.links.filter((l: any) => l.type === "child").map((l: any) => ({requirement: l.target, disposition: "valid", rationale: "Necessary count"})), disposition: "adequate", membership_action: "none", rationale: "Complete bounded count"}));
    } else c.payload.coverage_assessments = (action === "review-verification" ? datum(subject).payload.coverage.map((c: any) => c.target) : context.requirementGraphs[0].requirements.map((r: any) => r.revision_id)).map((target: string) => ({target, disposition: "adequate", rationale: "The complete count observations cover this bounded fixture"}));
    return submit(g, operation, [c], undefined, true);
  };
  try {
    let packageRoot = process.env.MDLM_APPLICABILITY_PACKAGE;
    if (!packageRoot) {
      packageRoot = path.join(root, "package");
      await fs.cp(path.join(process.cwd(), "node_modules/mdlm-process-package/iterative"), packageRoot, {recursive: true});
      const manifestPath = path.join(packageRoot, "manifest.yaml"), manifest = YAML.parse(await fs.readFile(manifestPath, "utf8"));
      manifest.kernel_capabilities["verification-applicability@1"] = {type: "RES"};
      await fs.writeFile(manifestPath, YAML.stringify(manifest));
      const typePath = path.join(packageRoot, "types/RES.yaml"), type = YAML.parse(await fs.readFile(typePath, "utf8"));
      type.payload_schema.properties.historical_observation = {type: "object"}; type.kernel_managed_payload_paths.push("historical_observation");
      await fs.writeFile(typePath, YAML.stringify(type));
    }
    cli(["init", repository, "--package", packageRoot]); await fs.mkdir(registry);
    for (const p of [product, verifier]) {await fs.mkdir(p); git(p, "init", "-q");}
    const framing = guidance("frame-experiment"), exp = framing.candidates[0];
    exp.payload = {...exp.payload, title: "Count", criterion: "Count arguments", question: "Can the CLI count?", approach: "One local command", constraints: "No persistence", allowance_minutes: 5, scope_cut: "Counting only"}; await submit(framing, "frame");
    const g = guidance("draft-requirements");
    const published = await submit(g, "requirements", [
      {localId: "need", type: "REQ", payload: {title: "Count items", publication: "recorded", kind: "stakeholder", statement: "The user shall obtain the number of supplied items"}, links: [], body: ""},
      {localId: "count", type: "REQ", payload: {title: "Count arguments", publication: "recorded", kind: "software", ears: {pattern: "ubiquitous", system: "The CLI", response: "print the argument count followed by newline and exit zero"}}, links: [], body: ""},
      {localId: "group", type: "DCP", payload: {title: "Counting", publication: "recorded"}, links: [{type: "parent", target: "$need"}, {type: "child", target: "$count"}], body: ""}, g.candidates.find((c: any) => c.type === "RQS"),
    ]);
    const set = published.revisions.find((id: string) => id.startsWith("RQS-")), reqs = published.revisions.filter((id: string) => id.startsWith("REQ-"));
    await review("review-requirements", set, "review-requirements");
    const authoring = cli(["verification", "context", set]);
    const image = process.env.MDLM_APPLICABILITY_IMAGE ?? "python@sha256:7415fbc3c9e4979cc717d92377ab2bc7b2b4a2af1ac03cc52b5f3f88efedaf3a";
    const script = `import json,os,subprocess\nfrom pathlib import Path\nr=subprocess.run(['python3',os.environ['MDLM_PRODUCT_DIR']+'/app.py','a','b'],capture_output=True,text=True)\np=Path(os.environ['MDLM_EVIDENCE_DIR'])\n(p/'observation.txt').write_text(r.stdout)\nrow={'case_id':'count','outcome':'pass' if r.returncode==0 and r.stdout=='2\\n' else 'fail','actual_results':[repr(r.stdout),'exit '+str(r.returncode)],'evidence_refs':['observation.txt']}\n(p/'results.json').write_text(json.dumps({'contract':'mdlm-verification-results@1','cases':[row]}))\nraise SystemExit(0 if row['outcome']=='pass' else 1)\n`;
    await fs.writeFile(path.join(verifier, "verify.py"), script); const verifierCommit = commit(verifier);
    const plan = guidance("plan-verification", set), vfy = plan.candidates[0];
    vfy.payload = {...vfy.payload, title: "X public count", method: "Public CLI count", objective: "Observe exact count", cases: [{id: "count", targets: reqs, preconditions: ["Fresh process"], actions: ["Invoke a b"], expected_results: ["2 newline and exit zero"], coverage_rationale: "Public count"}], coverage: reqs.map((target: string) => ({target, obligations: ["Correct observable count"], case_ids: ["count"], rationale: "Public command observation"})), repository_path: verifier, source_commit: verifierCommit, verification_image: image, verification_script: "verify.py", verification_command: ["python3", "verify.py"], results_path: "results.json", authoring_subject: set, authoring_context: authoring.authoringContext};
    vfy.links = reqs.map((target: string) => ({type: "verifies", target}));
    const y = structuredClone(vfy); y.localId = "y"; y.payload.title = "Y public count";
    const activities = (await submit(plan, "plan", [vfy, y])).revisions; const xId = activities[0], yId = activities[1];
    await review("review-verification", xId, "review-x"); await review("review-verification", yId, "review-y");
    await fs.writeFile(path.join(product, "app.py"), "import sys\nprint(len(sys.argv)-1)\n"); const source = commit(product);
    const ig = guidance("implement-product", set), imp = ig.candidates[0];
    const software = reqs.map(datum).find((d: any) => d.payload.kind === "software");
    imp.payload = {...imp.payload, title: "Counter", repository_path: product, source_commit: source, command: ["python3", "app.py"], file_roles: {"app.py": "production"}, source_ranges: [{path: "app.py", name: "count", start: 1, end: 2, requirements: [software.id]}]}; imp.links.push(...activities.map((target: string) => ({type: "verification", target})));
    const priorId = (await submit(ig, "implement")).revisions.find((id: string) => id.startsWith("IMP-"));
    const run = async (productId: string, activity: string, op: string) => {
      launches++; const execution = cli(["execution", "run", productId, op, "--activity", activity]);
      const rg = guidance("execute-verification", productId), c = rg.candidates[0]; c.payload = {...c.payload, title: op, assessment: "Exact public count recorded", correction_target: "none"}; c.links.push({type: "evaluates", target: activity});
      return {execution, result: (await submit(rg, `${op}-result`, [c], {receipt: execution.value.evidence})).revisions[0]};
    };
    const x = await run(priorId, xId, "original-x"), originalY = await run(priorId, yId, "original-y");
    const originalReceipt = git(repository, "cat-file", "blob", x.execution.value.oid), originalResult = datum(x.result);
    const yg = guidance("revise-verification", yId), yc = yg.candidates[0]; yc.payload = {...datum(yId).payload, method: "Public CLI count with explicit successful exit"}; yc.links = datum(yId).links;
    const newY = (await submit(yg, "change-y")).revisions[0]; await review("review-verification", newY, "review-new-y");
    const sg = guidance("update-verification-selection", priorId), sc = sg.candidates[0];
    const {product_files, source_inventory, source_changes, ...authored} = datum(priorId).payload; sc.payload = authored; sc.links.push({type: "verification", target: xId}, {type: "verification", target: newY});
    const successor = (await submit(sg, "select-y")).revisions.find((id: string) => id.startsWith("IMP-"));
    const rg = guidance("execute-verification", successor), rc = rg.candidates[0]; rc.payload = {...rc.payload, title: "X historical", assessment: "Historical unchanged count observation; current reviewer assesses freshness", correction_target: "none"}; rc.links.push({type: "evaluates", target: xId});
    expect(rg.historicalEvidenceMode.field).toBe("evidence.historicalResult");
    expect(JSON.stringify(await submit(rg, "substitute-receipt", [rc], {receipt: x.execution.value.evidence}, false, 1))).toContain("exact execution");
    const forged = structuredClone(rc); forged.payload.historical_observation = {original_result: x.result};
    expect(JSON.stringify(await submit(rg, "forge-provenance", [forged], {historicalResult: x.result}, false, 1))).toContain("kernel-managed");
    const applied = (await submit(rg, "apply-x", [rc], {historicalResult: x.result})).revisions[0];
    expect(launches).toBe(2); await run(successor, newY, "fresh-y"); expect(launches).toBe(3);
    const provenance = datum(applied).payload.historical_observation;
    expect(provenance).toMatchObject({contract: "mdlm-verification-applicability@1", original_result: x.result, original_implementation: priorId, receipt: x.execution.value.evidence, execution_operation: "original-x", started_at: x.execution.value.receipt.result.startedAt, finished_at: x.execution.value.receipt.result.finishedAt});
    expect(datum(x.result)).toEqual(originalResult); expect(git(repository, "cat-file", "blob", x.execution.value.oid)).toBe(originalReceipt);
    const status = cli(["verification", "status", successor]); expect(status.complete).toBe(false); expect(status.requirements[0].activities.find((a: any) => a.activity === xId)).toMatchObject({observation: "historical", historicalObservation: provenance});
    expect(cli(["expectations"]).items.some((i: any) => i.action.startsWith("accept-product@") && i.subject === successor)).toBe(false);
    const exportedPath = path.join(root, "current-review-context.json"); cli(["review", "context", "review-implementation", successor, "--output", exportedPath]);
    const context = JSON.parse(await fs.readFile(exportedPath, "utf8"));
    expect(context.records.map((d: any) => d.revision_id)).toEqual(expect.arrayContaining([x.result, priorId]));
    expect(context.verificationReceipts.find((r: any) => r.result === applied)).toMatchObject({historicalObservation: provenance, receipt: x.execution.value.receipt});
    expect(context.sources[0].files[0].content).toBe("import sys\nprint(len(sys.argv)-1)\n"); expect(context.verifierSources).toHaveLength(2);
    // Boundary negatives reuse the same authenticated state. They cannot be
    // isolated through valid public edits without creating unrelated journeys.
    const state = await directState(repository), current = state.data.find(d => d.revision_id === successor)!;
    const applicable = () => historicalApplicability(state, current, xId, x.result);
    const changed = structuredClone(current); changed.payload.source_commit = "b".repeat(40);
    await expect(historicalApplicability(state, changed, xId, x.result)).rejects.toThrow("unchanged product");
    for (const field of ["source_ranges", "formal_files", "source_inventory"]) {const altered = structuredClone(current); altered.payload[field] = []; await expect(historicalApplicability(state, altered, xId, x.result)).rejects.toThrow("unchanged product");}
    await expect(historicalApplicability(state, current, newY, x.result)).rejects.toThrow("unchanged activity");
    await expect(historicalApplicability(state, current, xId, applied)).rejects.toThrow("reuse chains");
    // A further selection-only revision still reaches the original execution, not the applied RES.
    const revise = (d: typeof current, n: number) => ({...structuredClone(d), revision: n, revision_id: d.revision_id.replace(/r\d+$/, `r${String(n).padStart(5, "0")}`)});
    const later = revise(current, current.revision + 1);
    await expect(historicalApplicability({...state, data: [...state.data, later]}, later, xId, x.result)).resolves.toMatchObject({provenance: {original_result: x.result, original_implementation: priorId}});
    const recorded = {...structuredClone(datum(applied)), revision_id: "RES-000000000000-r00001", id: "RES-000000000000", links: [...datum(applied).links, {type: "supersedes", target: applied}]}; delete recorded.payload.historical_observation;
    await expect(historicalApplicability({...state, data: [...state.data, recorded, later]}, later, xId, x.result)).rejects.toThrow("later result");
    const reverted = revise(changed, current.revision + 1), restored = revise(current, current.revision + 2);
    await expect(historicalApplicability({...state, data: [...state.data, reverted, restored]}, restored, xId, x.result)).rejects.toThrow("unchanged product");
    const strict = {...state, pkg: {...state.pkg, kernelCapabilities: {...state.pkg.kernelCapabilities}}}; delete strict.pkg.kernelCapabilities["verification-applicability@1"];
    await expect(historicalApplicability(strict, current, xId, x.result)).rejects.toThrow("does not support");
    const saved = await readVerificationReceiptBlob(repository, x.execution.value.oid);
    await expect(validateVerificationReceipt(independentExecutionBinding(state, current, xId, "original-x"), saved)).rejects.toThrow("exact execution");
    const register = async (op: string, receipt: any) => {const file = path.join(root, `${op}.json`); await fs.writeFile(file, JSON.stringify(receipt)); const oid = git(repository, "hash-object", "-w", file); git(repository, "update-ref", `refs/mdlm/execution/${op}/latest`, oid); git(repository, "update-ref", `refs/mdlm/execution/${op}/attempt-1-${receipt.state === "started" ? "started" : "receipt"}`, oid); return oid;};
    const deleteOperation = (op: string) => {for (const ref of git(repository, "for-each-ref", "--format=%(refname)", `refs/mdlm/execution/${op}`).split("\n").filter(Boolean)) git(repository, "update-ref", "-d", ref);};
    await register("unresolved", {binding: {...saved.receipt.binding, operation: "unresolved"}, attempt: 1, state: "started"}); await expect(applicable()).rejects.toThrow("unresolved"); deleteOperation("unresolved");
    const originRef = "refs/mdlm/execution/original-x/attempt-1-receipt"; git(repository, "update-ref", "-d", originRef); await expect(applicable()).rejects.toThrow(); git(repository, "update-ref", originRef, x.execution.value.oid);
    const missing = structuredClone(state); const original = missing.data.find(d => d.revision_id === x.result)!; original.payload.receipt = "git-blob:" + "0".repeat(40); await expect(historicalApplicability(missing, missing.data.find(d => d.revision_id === successor)!, xId, x.result)).rejects.toThrow();
    // A new unrecorded failure after publication invalidates export, status and
    // acceptance even after the fixture registered a passing current review.
    await review("review-implementation", successor, "current-review"); expect(cli(["verification", "status", successor]).complete).toBe(true);
    await register("late-failure", {...saved.receipt, binding: {...saved.receipt.binding, operation: "late-failure"}, result: {...saved.receipt.result, startedAt: new Date().toISOString(), outcome: "fail", exitCode: 1}});
    await expect(validateHistoricalResult(await directState(repository), datum(applied))).rejects.toThrow("later relevant"); expect(JSON.stringify(cli(["verification", "status", successor], 1))).toContain("later relevant");
    const acceptance = guidance("accept-product", successor), ac = acceptance.candidates[0]; ac.payload = {...ac.payload, title: "Count acceptance", decision: "accept", rationale: "Bounded count"};
    expect(JSON.stringify(await submit(acceptance, "reject-late-failure", [ac], {authority: ["stakeholder"]}, false, 1))).toContain("later relevant");
    deleteOperation("late-failure");
    await submit(guidance("accept-product", successor), "accept", [ac], {authority: ["stakeholder"]});
    expect(datum(x.result)).toEqual(originalResult); expect(git(repository, "cat-file", "blob", x.execution.value.oid)).toBe(originalReceipt);
    await fs.writeFile(path.join(root, "proof.json"), JSON.stringify({priorId, successor, xId, yId, newY, originalResult: x.result, originalY: originalY.result, applied, originalReceipt: x.execution.value.oid, provenance, launches, baselineLaunches: 4, savedLaunches: 1, currentReviewContext: exportedPath, fixtureReview: "Scripted authority boundary check, not production semantic conformance"}, null, 2));
    outcome = "passed";
  } finally {
    const file = path.join(root, "outcome.json"); await fs.writeFile(file, JSON.stringify({outcome, executable, repository, product, verifier, launches, commands}, null, 2)); process.stdout.write(`VERIFICATION_APPLICABILITY_EVIDENCE ${file}\n`);
  }
}, 240_000);
