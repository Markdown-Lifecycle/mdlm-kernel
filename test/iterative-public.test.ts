import { spawnSync, execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

test("iterative requirements retain exact origins and interface context across interface revisions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mdlm-iterative-public-"));
  const repository = path.join(root, "lifecycle");
  const commands: unknown[] = [];
  let outcome = "failed";
  const executable = process.env.MDLM_DIRECT_EXECUTABLE ?? path.join(process.cwd(), "dist/mdlm.js");
  let expectedExit = 0;
  const cli = (...args: string[]) => {
    const argv = executable.endsWith(".js") ? [process.execPath, [executable, ...args, "--json"]] as const : [executable, [...args, "--json"]] as const;
    const result = spawnSync(argv[0], argv[1], {cwd: args[0] === "init" ? root : repository, encoding: "utf8", timeout: 30_000, maxBuffer: 10 * 1024 * 1024});
    commands.push({args, status: result.status, stdout: result.stdout, stderr: result.stderr});
    expect(result.status, result.stdout + result.stderr).toBe(expectedExit);
    return JSON.parse(result.stdout);
  };
  const commit = () => {
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "-c", "commit.gpgSign=false", "commit", "--no-verify", "-qm", "Record fixture publication"]);
  };
  const submit = async (guidance: any, operation: string, candidates: unknown[]) => {
    const proposal = {operation, action: guidance.action, package: guidance.package, snapshot: guidance.snapshot, ...(guidance.subject ? {subject: guidance.subject} : {}), inputs: guidance.inputs, candidates};
    const file = path.join(root, `${operation}.json`);
    await fs.writeFile(file, JSON.stringify(proposal));
    const result = cli("proposal", "submit", file);
    expect(result.outcome).toBe("accepted");
    commit();
    return result;
  };
  try {
    expect(cli("init", repository, "--process", "iterative").ok).toBe(true);
    const initial = cli("expectations");
    expect(initial.optional.map((i: any) => i.action.split("@")[0])).toContain("record-interface");
    const interfaceGuidance = cli("expectations", "show", "record-interface");
    const icd = interfaceGuidance.candidates[0];
    icd.payload = {...icd.payload, title: "Sensor input", boundary: "external", endpoints: [
      {name: "Simulated sensor", owner: "Fixture maintainer", responsibility: "Emit Celsius readings"},
      {name: "Adapter", owner: "Product maintainer", responsibility: "Validate and normalize readings"},
    ], interaction: "JSON temperature number in Celsius", failure_behavior: "Reject missing temperature", compatibility: "Celsius only", assumptions: "Local simulator, no physical hardware approval"};
    const recorded = await submit(interfaceGuidance, "interface-record", [icd]);
    const interfaceR1 = recorded.revisions[0];
    const originalInterface = cli("show", interfaceR1).lifecycleDatum.datum;
    expect(initial.items.map((i: any) => i.action.split("@")[0])).toContain("frame-experiment");
    const framing = cli("expectations", "show", "frame-experiment");
    const exp = framing.candidates[0];
    exp.payload = {...exp.payload, title: "Count supplied items", criterion: "Report the supplied item count", question: "Which behavior should be retained?", approach: "Prototype a counter", constraints: "Formatting remains provisional", allowance_minutes: 5, scope_cut: "No persistence"};
    const framed = await submit(framing, "iterative-frame", [exp]);
    const origin = framed.revisions[0];
    const original = cli("show", origin).lifecycleDatum.datum;
    const g = cli("expectations", "show", "draft-requirements");
    expect(g.inputs.experiment).toEqual([origin]);
    const req = (localId: string, payload: object, links: unknown[] = []) => ({localId, type: "REQ", payload: {title: localId, publication: "recorded", ...payload}, links, body: ""});
    const result = await submit(g, "iterative-requirements", [
      req("need", {kind: "stakeholder", statement: "The user shall receive the supplied item count", rationale: "Counting is the retained useful behavior"}, [{type: "informed-by", target: origin}]),
      req("count", {kind: "software", ears: {pattern: "ubiquitous", system: "The counter", response: "return the number of supplied items"}}, [{type: "informed-by", target: origin}, {type: "uses-interface", target: interfaceR1}]),
      req("empty", {kind: "software", ears: {pattern: "event", event: "no items are supplied", system: "The counter", response: "return zero"}, rationale: "Necessary empty-input boundary, without a separate design predecessor"}),
      {localId: "group", type: "DCP", payload: {title: "Counting behavior", publication: "recorded"}, links: [{type: "parent", target: "$need"}, {type: "child", target: "$count"}, {type: "child", target: "$empty"}], body: ""},
      g.candidates.find((c: any) => c.type === "RQS"),
    ]);
    const revise = cli("expectations", "show", "revise-interface", interfaceR1);
    const revised = revise.candidates[0];
    revised.payload = {...originalInterface.payload, interaction: "JSON temperature number with C or F unit", compatibility: "Accept Celsius and Fahrenheit"};
    const revisionResult = await submit(revise, "interface-revise", [revised]);
    const interfaceR2 = revisionResult.revisions[0];
    expect(interfaceR2).not.toBe(interfaceR1);
    expect(cli("show", interfaceR1).lifecycleDatum.datum).toEqual(originalInterface);
    const selection = result.revisions.find((id: string) => id.startsWith("RQS-"));
    const review = cli("review", "context", "review-requirements", selection);
    expect(review.requirementGraphs[0].selection).toBe(selection);
    expect(review.inputs.interfaces).toEqual([interfaceR1]);
    expect(review.records.find((record: any) => record.revision_id === interfaceR1)).toEqual(originalInterface);
    expect(review.records.some((record: any) => record.revision_id === interfaceR2)).toBe(false);
    const authoring = cli("verification", "context", origin);
    const verifier = path.join(root, "verifier");
    await fs.mkdir(verifier);
    await fs.writeFile(path.join(verifier, "verify.py"), "print('fixture')\n");
    execFileSync("git", ["-C", verifier, "init", "-q"]);
    execFileSync("git", ["-C", verifier, "add", "."]);
    execFileSync("git", ["-C", verifier, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "--no-verify", "-qm", "Verifier fixture"]);
    const verifierCommit = execFileSync("git", ["-C", verifier, "rev-parse", "HEAD"], {encoding: "utf8"}).trim();
    const activityGuidance = cli("expectations", "show", "plan-criterion-verification", origin);
    const activity = activityGuidance.candidates[0];
    activity.payload = {...activity.payload, title:"Count criterion check", method:"CLI test", objective:"Observe the supplied count", authoring_subject:origin, authoring_context:authoring.authoringContext, repository_path:verifier, source_commit:verifierCommit, verification_image:"python@sha256:"+"b".repeat(64), verification_command:["python3","verify.py"], verification_script:"verify.py", results_path:"results.json", cases:[{id:"count",targets:[origin],preconditions:["Fresh process"],actions:["Supply two items"],expected_results:["The public output reports two"],coverage_rationale:"The criterion concerns observable item count"}],coverage:[{target:origin,obligations:["Report supplied count"],case_ids:["count"],rationale:"This fixture tests exact interface binding; execution adequacy is reviewed separately"}]};
    activity.links.push({type:"verifies",target:origin});
    const planned = await submit(activityGuidance,"criterion-plan",[activity]);
    const activityRevision = planned.revisions[0];
    const prototype = cli("expectations", "show", "prepare-prototype", origin);
    const invalid = prototype.candidates[0];
    invalid.payload = {...invalid.payload, title: "Invalid interface reference", repository_path: repository, source_commit: "a".repeat(40), command: ["python3", "app.py"]};
    invalid.links.push({type:"verification",target:activityRevision});
    invalid.links.push({type: "uses-interface", target: origin});
    const invalidFile = path.join(root, "invalid-interface.json");
    await fs.writeFile(invalidFile, JSON.stringify({operation: "invalid-interface", action: prototype.action, package: prototype.package, snapshot: prototype.snapshot, subject: prototype.subject, inputs: prototype.inputs, candidates: [invalid]}));
    expectedExit = 1;
    const rejected = cli("proposal", "submit", invalidFile);
    expectedExit = 0;
    expect(JSON.stringify(rejected)).toContain("uses-interface");
    const validPrototype = cli("expectations", "show", "prepare-prototype", origin);
    invalid.links = invalid.links.map((link: any) => link.type === "uses-interface" ? {...link, target: interfaceR2} : link);
    const trial = await submit(validPrototype, "interface-prototype", [invalid]);
    expect(cli("show", trial.revisions[0]).lifecycleDatum.datum.links).toContainEqual({type: "uses-interface", target: interfaceR2});
    expect(cli("show", interfaceR1).lifecycleDatum.datum).toEqual(originalInterface);
    expect(review.requirementGraphs[0].assessment.sourceScopes).toEqual([]);
    const requirements = review.requirementGraphs[0].requirements;
    expect(requirements).toHaveLength(3);
    expect(requirements.filter((r: any) => r.links.some((l: any) => l.type === "informed-by" && l.target === origin))).toHaveLength(2);
    expect(requirements.find((r: any) => r.payload.title === "empty").links).toEqual([]);
    expect(cli("show", origin).lifecycleDatum.datum).toEqual(original);
    const available = cli("expectations").items.map((i: any) => i.action.split("@")[0]);
    expect(available).not.toContain("observe-prototype");
    const optional = cli("expectations").optional.map((i:any)=>i.action.split("@")[0]);
    expect(optional).toContain("execute-criterion-verification");
    expect(available).toContain("review-requirements");
    outcome = "passed";
  } finally {
    await fs.writeFile(path.join(root, "outcome.json"), JSON.stringify({outcome, executable, repository, commands}, null, 2));
    process.stdout.write(`ITERATIVE_PUBLIC_EVIDENCE ${path.join(root, "outcome.json")}\n`);
    // Preserve exact proposals, responses and lifecycle on either outcome for audit.
  }
}, 90_000);
