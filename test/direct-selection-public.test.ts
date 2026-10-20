import { installedProcessPackageRoot } from "../src/installed-process-package.js";
import { createHash } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";
import { expect, test, vi } from "vitest";
import { initializeRepositoryFromProcessPackage } from "../src/repository-initialization.js";

test("verification correction drafts retain the exact interface revisions required by unchanged targets", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mdlm-draft-interfaces-"));
  const repository = path.join(root, "lifecycle"), verifier = path.join(root, "verifier"), registry = path.join(root, "registry");
  const cli = (args: string[], manager = false) => {
    const result = spawnSync(process.execPath, [path.join(process.cwd(), "dist/mdlm.js"), ...args, "--json"], {
      cwd: args[0] === "init" ? root : repository, encoding: "utf8", timeout: 30_000,
      env: {...process.env, MDLM_REVIEW_REGISTRY: registry, MDLM_REVIEW_REGISTRAR: manager ? "1" : "0"},
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], {encoding: "utf8"}).trim();
  const commit = (cwd: string) => {
    git(cwd, "add", ".");
    git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "--no-verify", "-qm", "Interface draft fixture");
    return git(cwd, "rev-parse", "HEAD");
  };
  const guidance = (action: string, subject?: string) => cli(["expectations", "show", action, ...(subject ? [subject] : [])]);
  const submit = async (g: any, operation: string, review = false) => {
    const file = path.join(root, `${operation}.json`);
    await fs.writeFile(file, JSON.stringify({operation, action: g.action, package: g.package, snapshot: g.snapshot, ...(g.subject ? {subject: g.subject} : {}), inputs: g.inputs, candidates: g.candidates}));
    if (review) cli(["review", "register", file, file], true);
    const result = cli(["proposal", "submit", file]);
    commit(repository);
    return result.revisions as string[];
  };
  try {
    cli(["init", repository, "--process", "iterative"]);
    await fs.mkdir(verifier); await fs.mkdir(registry);
    git(verifier, "init", "-q");
    await fs.writeFile(path.join(verifier, "verify.js"), "// Independent verification draft fixture.\n");
    const sourceCommit = commit(verifier);
    const interfaces: string[] = [];
    for (let revision = 1; revision <= 3; revision++) {
      const g = guidance(revision === 1 ? "record-interface" : "revise-interface", interfaces.at(-1));
      g.candidates[0].payload = {...g.candidates[0].payload, title: "Service interface", boundary: "external", endpoints: [
        {name: "client", owner: "client", responsibility: "Request the result"},
        {name: "service", owner: "service", responsibility: "Return the result"},
      ], interaction: `Compatible interface revision ${revision}`, failure_behavior: "Return an explicit refusal", compatibility: "Earlier clauses remain applicable", assumptions: "Public requests"};
      interfaces.push((await submit(g, `interface-${revision}`))[0]!);
    }
    const frame = guidance("frame-experiment");
    frame.candidates[0].payload = {...frame.candidates[0].payload, title: "Service result", criterion: "Show the result", question: "Can the client obtain the result?", approach: "Public requests", constraints: "No source access", allowance_minutes: 5, scope_cut: "One service"};
    await submit(frame, "frame");
    const requirements = guidance("draft-requirements");
    requirements.candidates = [
      {localId: "need", type: "REQ", payload: {title: "Result", publication: "recorded", kind: "stakeholder", statement: "The user shall obtain the result", rationale: "Public result"}, links: [{type: "uses-interface", target: interfaces[0]}], body: ""},
      ...["request", "response"].map((localId, index) => ({localId, type: "REQ", payload: {title: localId, publication: "recorded", kind: "software", ears: {pattern: "ubiquitous", system: "The service", response: `provide the ${localId}`}}, links: [{type: "uses-interface", target: interfaces[index + 1]}], body: ""})),
      {localId: "group", type: "DCP", payload: {title: "Result behavior", publication: "recorded"}, links: [{type: "parent", target: "$need"}, {type: "child", target: "$request"}, {type: "child", target: "$response"}], body: ""},
      requirements.candidates.find((c: any) => c.type === "RQS"),
    ];
    const revisions = await submit(requirements, "requirements"), set = revisions.find(id => id.startsWith("RQS-"))!;
    const targets = revisions.filter(id => id.startsWith("REQ-"));
    const authoring = cli(["verification", "context", set]), plan = guidance("plan-verification", set);
    const candidate = plan.candidates[0];
    candidate.payload = {...candidate.payload, title: "Result checks", method: "Public API checks", objective: "Observe the result", authoring_subject: set, authoring_context: authoring.authoringContext, repository_path: verifier, source_commit: sourceCommit, verification_image: "node@sha256:" + "b".repeat(64), verification_command: ["node", "verify.js"], verification_script: "verify.js", results_path: "results.json", cases: [{id: "result", targets, preconditions: ["Service is available"], actions: ["Request the result"], expected_results: ["The requested result is returned"], coverage_rationale: "Addresses the selected result obligations"}], coverage: targets.map(target => ({target, obligations: ["Provide the result"], case_ids: ["result"], rationale: "The public case observes the result"}))};
    candidate.links = [...targets.map(target => ({type: "verifies", target})), ...interfaces.map(target => ({type: "uses-interface", target}))];
    candidate.body = "Retain these cases while correcting the verifier.";
    const activity = (await submit(plan, "plan"))[0]!;
    const review = guidance("review-verification", activity);
    review.candidates[0].payload = {...review.candidates[0].payload, title: "Reject method", outcome: "fail", findings: "Improve the result assertion", coverage_assessments: targets.map(target => ({target, disposition: "needs-change", rationale: "Improve the result assertion"}))};
    await submit(review, "review", true);
    const before = [git(repository, "status", "--porcelain"), git(repository, "show-ref")];
    const correction = guidance("correct-verification-after-review", activity), file = path.join(root, "correction.json");
    cli(["proposal", "draft", "correct-verification-after-review", activity, "--operation", "correction", "--output", file]);
    const draft = JSON.parse(await fs.readFile(file, "utf8"));
    expect(draft.candidates[0]).toEqual({...correction.candidates[0], payload: candidate.payload, links: candidate.links, body: candidate.body});
    expect(draft.candidates[0].predecessor).toBe(activity);
    expect(draft.inputs).toEqual(correction.inputs);
    expect([git(repository, "status", "--porcelain"), git(repository, "show-ref")]).toEqual(before);
    // The draft is already structurally publishable without manually restoring older ICD links.
    const accepted = cli(["proposal", "submit", file]);
    expect(accepted.outcome).toBe("accepted");
    expect(cli(["show", accepted.revisions[0]]).lifecycleDatum.datum.links).toEqual(candidate.links);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
}, 60_000);

test("proposal drafts preserve selected guidance, accept authored work and reject stale drafts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),"mdlm-direct-selection-"));
  const fixture = path.join(root,"package"), repository = path.join(root,"lifecycle");
  try {
    // Custom package paths are not a CLI init feature. Use the existing package
    // initializer for this test fixture; every lifecycle operation is public CLI.
    await fs.cp(path.join(installedProcessPackageRoot("exploratory")),fixture,{recursive:true});
    const template = parse(await fs.readFile(path.join(fixture,"actions/frame-experiment.yaml"),"utf8"));
    await fs.rm(path.join(fixture,"actions"),{recursive:true});await fs.mkdir(path.join(fixture,"actions"));
    for (const [id,priority] of [["first-experiment",10],["second-experiment",20]] as const) {
      await fs.writeFile(path.join(fixture,"actions",`${id}.yaml`),stringify({...template,id,priority,when:"true"}));
    }
    const revisionAction = {...template,id:"revise-selected",subjects:'select("current-experiments@1", {})',inputs:{subject:"subject"},revises:{EXP:"subject"},when:"true"};
    await fs.writeFile(path.join(fixture,"actions","revise-selected.yaml"),stringify(revisionAction));
    const manifest = parse(await fs.readFile(path.join(fixture,"manifest.yaml"),"utf8"));
    manifest.id = "mdlm-selection-fixture";manifest.terminal.when = "false";
    await fs.writeFile(path.join(fixture,"manifest.yaml"),stringify(manifest));
    const initialized = await initializeRepositoryFromProcessPackage(repository,fixture);
    expect(initialized.ok,JSON.stringify(initialized)).toBe(true);
    const cli = (...args:string[]) => {
      const result = spawnSync(process.execPath,[path.join(process.cwd(),"dist/mdlm.js"),...args,"--json"],{cwd:repository,encoding:"utf8",timeout:30_000,maxBuffer:10*1024*1024});
      expect(result.status,result.stdout+result.stderr).toBe(0);return JSON.parse(result.stdout);
    };
    const git = (...args:string[])=>execFileSync("git",["-C",repository,...args],{encoding:"utf8"});
    const before = [git("status","--porcelain"),git("show-ref")];
    const available = cli("expectations");
    expect(available.items.map((item:{action:string})=>item.action)).toEqual(["first-experiment@1","second-experiment@1"]);
    const guidance = cli("expectations","show",available.items[1].action);
    expect([git("status","--porcelain"),git("show-ref")]).toEqual(before);
    const file = path.join(root,"proposal.json"), staleFile = path.join(root,"stale.json");
    const draft = cli("proposal","draft","second-experiment","--operation","choose-second","--output",file);
    const bytes = await fs.readFile(file);
    const proposal = JSON.parse(bytes.toString("utf8"));
    expect(proposal).toEqual({operation:"choose-second",action:guidance.action,package:guidance.package,snapshot:guidance.snapshot,inputs:guidance.inputs,candidates:guidance.candidates});
    expect(draft).toMatchObject({contract:"mdlm-proposal-draft@1",operation:proposal.operation,action:guidance.action,package:guidance.package,snapshot:guidance.snapshot,inputs:guidance.inputs,export:{path:file,bytes:bytes.length,exportSha256:createHash("sha256").update(bytes).digest("hex")}});
    expect(draft.authoring.instruction).toContain("has not been validated");
    expect(draft.authoring.guidance).toEqual(["mdlm","expectations","show",guidance.action,"--json"]);
    expect([git("status","--porcelain"),git("show-ref")]).toEqual(before);
    const rejected = (...args:string[]) => {
      const result = spawnSync(process.execPath,[path.join(process.cwd(),"dist/mdlm.js"),...args,"--json"],{cwd:repository,encoding:"utf8",timeout:30_000});
      expect(result.status,result.stdout+result.stderr).toBe(1);return JSON.parse(result.stdout);
    };
    const inapplicableFile = path.join(root,"inapplicable-activity.json");
    expect(rejected("proposal","draft",guidance.action,"--activity","VFY-exact-r00001","--operation","inapplicable-activity","--output",inapplicableFile).diagnostics[0].message).toContain("independent-result");
    await expect(fs.stat(inapplicableFile)).rejects.toMatchObject({code:"ENOENT"});
    rejected("proposal","draft",guidance.action,"--operation","preserve-existing","--output",file);
    expect(await fs.readFile(file)).toEqual(bytes);
    const candidate = proposal.candidates[0];
    candidate.payload = {...candidate.payload,title:"Selected second experiment",criterion:"Count supplied arguments",question:"Can the agent choose any eligible action?",approach:"Publish the second available experiment",constraints:"No product acceptance",allowance_minutes:5,scope_cut:"No implementation"};
    candidate.body = "Only a package-selection fixture.";
    await fs.writeFile(file,JSON.stringify(proposal));
    await fs.writeFile(staleFile,JSON.stringify({...proposal,operation:"stale-second"}));
    const submitted = cli("proposal","submit",file);
    expect(submitted.outcome).toBe("accepted");expect(submitted.revisions).toHaveLength(1);
    const {command: _submitCommand, ...accepted} = submitted;
    expect(cli("proposal","settlement",proposal.operation)).toMatchObject(accepted);
    expect(cli("expectations").items.map((item:{action:string})=>item.action)).toContain("first-experiment@1");
    const published = [git("status","--porcelain"),git("show-ref")];
    expect(rejected("proposal","submit",staleFile).diagnostics[0].message).toMatch(/snapshot/i);
    expect(cli("proposal","settlement","stale-second").outcome).toBe("not-published");
    expect([git("status","--porcelain"),git("show-ref")]).toEqual(published);
    const subject = submitted.revisions[0];
    const revisionGuidance = cli("expectations","show","revise-selected",subject);
    const revisionFile = path.join(root,"revision.json");
    cli("proposal","draft","revise-selected",subject,"--operation","revise-selected","--output",revisionFile);
    const revisionProposal = JSON.parse(await fs.readFile(revisionFile,"utf8"));
    // The revision draft starts from the predecessor's authored content, so one change edits one field.
    expect(revisionProposal.candidates).toEqual([{...revisionGuidance.candidates[0],payload:candidate.payload,body:candidate.body}]);
    expect(revisionProposal.candidates[0].predecessor).toBe(subject);
    expect(revisionProposal.subject).toBe(subject);
    expect(revisionProposal.inputs).toEqual({subject:[subject]});
    expect([git("status","--porcelain"),git("show-ref")]).toEqual(published);
    revisionProposal.candidates[0].payload.title = "Revised second experiment";
    await fs.writeFile(revisionFile,JSON.stringify(revisionProposal));
    const revised = cli("proposal","submit",revisionFile);
    expect(cli("show",revised.revisions[0]).lifecycleDatum.datum).toMatchObject({payload:{...candidate.payload,title:"Revised second experiment"},body:candidate.body});
  } finally {await fs.rm(root,{recursive:true,force:true});}
},60_000);

test("a draft from one fresh repository is rejected by another with the same initial data", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),"mdlm-direct-repository-"));
  try {
    const run = (cwd:string,status:number,...args:string[]) => {
      const result = spawnSync(process.execPath,[path.join(process.cwd(),"dist/mdlm.js"),...args,"--json"],{cwd,encoding:"utf8",timeout:30_000});
      expect(result.status,result.stdout+result.stderr).toBe(status);return JSON.parse(result.stdout);
    };
    const [a,b] = ["a","b"].map(name=>path.join(root,name)) as [string,string];
    run(root,0,"init",a,"--process","exploratory");run(root,0,"init",b,"--process","exploratory");
    const file = path.join(root,"proposal.json");
    run(a,0,"proposal","draft","frame-experiment","--operation","foreign-draft","--output",file);
    const proposal = JSON.parse(await fs.readFile(file,"utf8"));
    Object.assign(proposal.candidates[0].payload,{title:"Foreign",criterion:"Count arguments",question:"Which repository?",approach:"Submit elsewhere",constraints:"None",allowance_minutes:5,scope_cut:"None"});
    proposal.candidates[0].body = "Drafted for repository a.";
    await fs.writeFile(file,JSON.stringify(proposal));
    const rejected = run(b,1,"proposal","submit",file);
    expect(rejected.diagnostics[0].message).toMatch(/drafted in another repository/);
    expect(run(b,0,"proposal","settlement","foreign-draft").outcome).toBe("not-published");
    expect(run(a,0,"proposal","submit",file).outcome).toBe("accepted");
  } finally {await fs.rm(root,{recursive:true,force:true});}
},60_000);

test("selected guidance states effective authority without changing proposal evidence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mdlm-guidance-authority-"));
  const fixture = path.join(root, "package"), repository = path.join(root, "lifecycle");
  const cases = [
    {id: "autonomous", authority: undefined},
    {id: "stakeholder", authority: {kind: "stakeholder", name: "product-owner"}},
    {id: "independent", authority: {kind: "independent-review", name: "reviewer"}},
  ] as const;
  const cli = (...args: string[]) => {
    const result = spawnSync(process.execPath, [path.join(process.cwd(), "dist/mdlm.js"), ...args, "--json"], {cwd: repository, encoding: "utf8", timeout: 30_000});
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  };
  try {
    await fs.cp(installedProcessPackageRoot("exploratory"), fixture, {recursive: true});
    const template = parse(await fs.readFile(path.join(fixture, "actions/frame-experiment.yaml"), "utf8"));
    for (const {id, authority} of cases) {
      await fs.writeFile(path.join(fixture, "actions", `${id}.yaml`), stringify({...template, id, when: "true", ...(authority ? {authority} : {})}));
    }
    const initialized = await initializeRepositoryFromProcessPackage(repository, fixture);
    expect(initialized.ok, JSON.stringify(initialized)).toBe(true);
    for (const {id, authority} of cases) {
      const guidance = cli("expectations", "show", id);
      expect(guidance.effectiveAuthority).toEqual(authority ?? {kind: "autonomous"});
      if (authority) expect(guidance.authority).toEqual(authority);
      else expect(guidance).not.toHaveProperty("authority");
      const file = path.join(root, `${id}.json`);
      cli("proposal", "draft", id, "--operation", `draft-${id}`, "--output", file);
      const proposal = JSON.parse(await fs.readFile(file, "utf8"));
      expect(proposal).toEqual({operation: `draft-${id}`, action: guidance.action, package: guidance.package, snapshot: guidance.snapshot, inputs: guidance.inputs, candidates: guidance.candidates,
        ...(authority?.kind === "stakeholder" ? {evidence: {authority: [authority.name]}} : {})});
    }
  } finally {await fs.rm(root, {recursive: true, force: true});}
}, 60_000);

test("stakeholder drafts prepare the role but still require explicit submission authority", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mdlm-draft-authority-"));
  const fixture = path.join(root, "package"), repository = path.join(root, "lifecycle");
  const cli = (status: number, ...args: string[]) => {
    const result = spawnSync(process.execPath, [path.join(process.cwd(), "dist/mdlm.js"), ...args, "--json"], {cwd: repository, encoding: "utf8", timeout: 30_000});
    expect(result.status, result.stdout + result.stderr).toBe(status);
    return JSON.parse(result.stdout);
  };
  try {
    // Keep this authority boundary independent of a full stakeholder journey.
    await fs.cp(path.join(installedProcessPackageRoot("exploratory")), fixture, {recursive: true});
    const actionPath = path.join(fixture, "actions/frame-experiment.yaml");
    const action = parse(await fs.readFile(actionPath, "utf8"));
    action.authority = {kind: "stakeholder", name: "product-owner"};
    await fs.writeFile(actionPath, stringify(action));
    const typePath = path.join(fixture, "types/EXP.yaml");
    const type = parse(await fs.readFile(typePath, "utf8"));
    type.payload_schema.required.push("decision");
    type.payload_schema.properties.decision = {enum: ["accept", "reject"]};
    await fs.writeFile(typePath, stringify(type));
    const initialized = await initializeRepositoryFromProcessPackage(repository, fixture);
    expect(initialized.ok, JSON.stringify(initialized)).toBe(true);

    const file = path.join(root, "decision.json"), operation = "stakeholder-decision";
    const guidance = cli(0, "expectations", "show", "frame-experiment");
    const draft = cli(0, "proposal", "draft", "frame-experiment", "--operation", operation, "--output", file);
    const draftBytes = await fs.readFile(file);
    const proposal = JSON.parse(draftBytes.toString("utf8"));
    expect(proposal).toEqual({operation, action: guidance.action, package: guidance.package, snapshot: guidance.snapshot, inputs: guidance.inputs, candidates: guidance.candidates, evidence: {authority: ["product-owner"]}});
    expect(proposal.candidates[0].payload).not.toHaveProperty("decision");
    expect(draft.export).toEqual({path: file, bytes: draftBytes.length, exportSha256: createHash("sha256").update(draftBytes).digest("hex")});
    expect(cli(0, "proposal", "settlement", operation).outcome).toBe("not-published");

    const payload = {...proposal.candidates[0].payload, title: "Declined experiment", decision: "reject", criterion: "Count supplied arguments", question: "Should this experiment proceed?", approach: "Ask the product owner", constraints: "Preserve the rejection", allowance_minutes: 5, scope_cut: "No implementation"};
    proposal.candidates[0].payload = payload;
    const submittedBytes = `${JSON.stringify(proposal, null, 2)}\n`;
    await fs.writeFile(file, submittedBytes);
    for (const flags of [[], ["--authority", "stakeholder"]]) {
      expect(cli(1, "proposal", "submit", file, ...flags).diagnostics[0].message).toContain("Stakeholder authority must match");
      expect(cli(0, "proposal", "settlement", operation).outcome).toBe("not-published");
    }
    const submitted = cli(0, "proposal", "submit", file, "--authority", "product-owner");
    expect(submitted.outcome).toBe("accepted");
    expect(submitted.proposalDigest).toBe(`sha256:${createHash("sha256").update(submittedBytes).digest("hex")}`);
    expect(cli(0, "show", submitted.revisions[0]).lifecycleDatum.datum.payload).toEqual(payload);
    const {command: _command, ...accepted} = submitted;
    expect(cli(0, "proposal", "settlement", operation)).toMatchObject(accepted);
    expect(await fs.readFile(file, "utf8")).toBe(submittedBytes);
  } finally {await fs.rm(root, {recursive: true, force: true});}
}, 60_000);

test("saved review context provides exact handoff metadata without replacing exports", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mdlm-review-export-"));
  const repository = path.join(root, "lifecycle");
  const cli = (...args: string[]) => {
    const result = spawnSync(process.execPath, [path.join(process.cwd(), "dist/mdlm.js"), ...args, "--json"], {cwd: repository, encoding: "utf8", timeout: 30_000});
    expect(result.error).toBeUndefined();
    return {status: result.status, source: result.stdout, value: JSON.parse(result.stdout)};
  };
  try {
    // A small package fixture publishes origins without running a prototype journey.
    // The requirements graph, transactions and exported review use the public CLI.
    const fixture = path.join(root, "package");
    await fs.cp(path.join(installedProcessPackageRoot("tiny")), fixture, {recursive: true});
    const requirement = parse(await fs.readFile(path.join(fixture, "types/REQ.yaml"), "utf8"));
    const originLink = (id: string, types: string[]) => ({id, description: id, targets: [{kind: "datum", types, identity: "revision"}], cardinality: {minimum: 0, maximum: "many"}, freeze_resolution: "already-exact", inverse_label: `incoming-${id}`});
    requirement.outgoing_links.push(originLink("informed-by", ["EXP", "OBS"]));
    await fs.writeFile(path.join(fixture, "types/REQ.yaml"), stringify(requirement));
    for (const type of ["EXP", "OBS", "TRY"]) {
      await fs.writeFile(path.join(fixture, `types/${type}.yaml`), stringify({
        kind: "type-definition", id: type, version: 1, name: type, description: "Review origin fixture", extends: "titled-datum@1",
        lifecycle: {authorship: "authored", freeze_when: "terminal-outcome", terminal_payload_field: "publication", terminal_values: ["recorded"]},
        payload_schema: {$schema: "https://json-schema.org/draft/2020-12/schema", type: "object", required: ["publication"], properties: {publication: {const: "recorded"}}},
        outgoing_links: [originLink("observes", ["TRY"]), originLink("against", ["EXP"])], kernel_managed_payload_paths: [],
      }));
    }
    const draftAction = parse(await fs.readFile(path.join(fixture, "actions/draft-requirements.yaml"), "utf8"));
    await fs.writeFile(path.join(fixture, "actions/seed-origin.yaml"), stringify({
      kind: "action-definition", id: "seed-origin", version: 1, capability: "experiment", prompt_ref: draftAction.prompt_ref, types: ["EXP", "OBS", "TRY"], inputs: {}, when: "true",
    }));
    const initialized = await initializeRepositoryFromProcessPackage(repository, fixture);
    expect(initialized.ok, JSON.stringify(initialized)).toBe(true);
    const seed = async (type: string, title: string, links: unknown[] = [], predecessor?: string) => {
      const guidance = cli("expectations", "show", "seed-origin").value;
      const file = path.join(root, `${title}.json`);
      await fs.writeFile(file, JSON.stringify({operation: title, action: guidance.action, package: guidance.package, snapshot: guidance.snapshot, inputs: guidance.inputs,
        candidates: [{localId: "origin", type, payload: {title, publication: "recorded"}, links, body: `Exact ${title} payload`, ...(predecessor ? {predecessor} : {})}]}));
      const submitted = cli("proposal", "submit", file);
      expect(submitted.status, submitted.source).toBe(0);
      return submitted.value.revisions[0] as string;
    };
    const exp1 = await seed("EXP", "first-intent");
    const exp2 = await seed("EXP", "revised-intent", [], exp1);
    const exp3 = await seed("EXP", "current-unselected-intent", [], exp2);
    const trial = await seed("TRY", "unselected-product", [{type: "against", target: exp3}]);
    const obs1 = await seed("OBS", "first-observation", [{type: "observes", target: trial}, {type: "against", target: exp3}]);
    const obs2 = await seed("OBS", "second-observation", [{type: "observes", target: trial}]);
    const origins = [exp1, exp2, obs1, obs2].map(id => cli("show", id).value.lifecycleDatum.datum);
    const guidance = cli("expectations", "show", "draft-requirements").value;
    const candidates = [
      {localId: "need", type: "REQ", payload: {title: "Counting", publication: "recorded", kind: "stakeholder", statement: "The user shall receive a count", rationale: "Count supplied items"}, links: [exp1, obs1].map(target => ({type: "informed-by", target})), body: ""},
      {localId: "count", type: "REQ", payload: {title: "Count items", publication: "recorded", kind: "software", ears: {pattern: "ubiquitous", system: "The counter", response: "return the supplied item count"}}, links: [exp1, exp2, obs2].map(target => ({type: "informed-by", target})), body: ""},
      {localId: "group", type: "DCP", payload: {title: "Counting behavior", publication: "recorded"}, links: [{type: "parent", target: "$need"}, {type: "child", target: "$count"}], body: ""},
      guidance.candidates.find((candidate: {type: string}) => candidate.type === "RQS"),
    ];
    const proposal = {operation: "prepare-export", action: guidance.action, package: guidance.package, snapshot: guidance.snapshot, inputs: guidance.inputs, candidates};
    const proposalFile = path.join(root, "proposal.json");
    await fs.writeFile(proposalFile, JSON.stringify(proposal));
    const submitted = cli("proposal", "submit", proposalFile);
    expect(submitted.status, submitted.source).toBe(0);
    const subject = submitted.value.revisions.find((id: string) => id.startsWith("RQS-"));
    const action = cli("expectations").value.items.find((item: {subject?: string}) => item.subject === subject).action;
    const reviewGuidance = cli("expectations", "show", action, subject).value;
    const reviewDraft = cli("proposal", "draft", action, subject, "--operation", "draft-review", "--output", "review-draft.json");
    expect(reviewDraft.status, reviewDraft.source).toBe(0);
    const reviewProposal = JSON.parse(await fs.readFile(path.join(repository,"review-draft.json"),"utf8"));
    expect(reviewProposal).toEqual({operation:"draft-review",action,subject,package:reviewGuidance.package,snapshot:reviewGuidance.snapshot,inputs:reviewGuidance.inputs,candidates:reviewGuidance.candidates});
    expect(reviewProposal.candidates[0].links).not.toHaveLength(0);
    expect(reviewProposal).not.toHaveProperty("evidence");
    const args = ["review", "context", action, subject];
    const ordinary = cli(...args);
    expect(ordinary.status, ordinary.source).toBe(0);
    const file = path.join(repository, "review-context.json");
    const exported = cli(...args, "--output", "review-context.json");
    expect(exported.status, exported.source).toBe(0);
    const bytes = await fs.readFile(file);
    expect(bytes.toString("utf8")).toBe(ordinary.source);
    const saved = JSON.parse(bytes.toString("utf8"));
    expect(saved.records.filter((record: {type: string}) => ["EXP", "OBS"].includes(record.type))).toEqual(expect.arrayContaining(origins));
    expect(saved.records.map((record: {revision_id: string}) => record.revision_id).sort()).toEqual([subject, exp1, exp2, obs1, obs2].sort());
    expect(saved.sources).toEqual([]);
    expect(saved.sourceScopes).toEqual([]);
    expect(saved.verifierSources ?? []).toEqual([]);
    expect(saved.verificationReceipts).toEqual([]);
    const {createHash} = await import("node:crypto");
    expect(exported.value).toEqual({
      ok: true, command: "review.context", contract: "mdlm-review-export@1",
      export: {path: file, bytes: bytes.length, exportSha256: createHash("sha256").update(bytes).digest("hex")},
      action, subject, snapshot: ordinary.value.snapshot, package: ordinary.value.package, diagnostics: [],
    });
    const existing = cli(...args, "--output", file);
    expect(existing.status).toBe(1);
    expect(existing.value.ok).toBe(false);
    expect(existing.value).not.toHaveProperty("export");
    expect(await fs.readFile(file)).toEqual(bytes);
    const invalid = cli("review", "context", "unknown@1", "--output", "invalid.json");
    expect(invalid.status).toBe(1);
    await expect(fs.stat(path.join(repository, "invalid.json"))).rejects.toMatchObject({code: "ENOENT"});
    expect(cli(...args, "--output", path.join(root, "missing", "export.json")).status).toBe(1);
  } finally {await fs.rm(root, {recursive: true, force: true});}
}, 60_000);


test("shared verifier tree archive expands complete review evidence without source repositories", async () => {
  const {executeCommandApplication} = await import("../src/command-application.js");
  const selection = await import("../src/direct-proposal.js");
  const {reviewPacketDigest} = await import("../src/external-review.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mdlm-shared-review-"));
  const offline = path.join(root, "offline");
  const screenshot = Buffer.from([0, 137, 80, 78, 71, 255]);
  const files = [
    {path: "verify.ts", blob: "1".repeat(40), content: "// Full verifier source\n".repeat(1000)},
    {path: "screen.png", blob: "2".repeat(40), content: screenshot.toString("base64"), encoding: "base64"},
    {path: "second-screen.png", blob: "2".repeat(40), content: screenshot.toString("base64"), encoding: "base64"},
  ];
  // Selection is frozen at the export boundary. Native source selection and
  // registration have their existing regressions; this checks real CLI file I/O.
  const context = {
    ok: true, contract: "mdlm-direct-review-context@1", package: {reference: "fixture@1", digest: "exact", language: "fixture"},
    snapshot: "exact", action: {id: "review", version: 1}, subject: "IMP-exact", inputs: {verification: ["VFY-a", "VFY-b", "VFY-c"]},
    prompt: "Read the complete evidence", payloadSchemas: {}, records: [{revision_id: "OBS-exact", body: "Distinct observation"}],
    requirementGraphs: [], sourceScopes: [], sources: [],
    verifierSources: [
      {activity: "VFY-a", sourceCommit: "a".repeat(40), files},
      {activity: "VFY-b", sourceCommit: "a".repeat(40), files},
      {activity: "VFY-c", sourceCommit: "b".repeat(40), files: [{...files[0], content: "// Changed full verifier source\n"}]},
    ],
    verificationReceipts: [{result: "VER-a", receipt: {occurrence: 1, contentBase64: screenshot.toString("base64")}}, {result: "VER-b", receipt: {occurrence: 2, contentBase64: screenshot.toString("base64")}}],
  };
  const original = JSON.stringify(context);
  const frozen = vi.spyOn(selection, "inspectDirectReview").mockResolvedValue(context as unknown as Awaited<ReturnType<typeof selection.inspectDirectReview>>);
  const cli = async (args: string[], cwd = root, status = 0) => {
    const result = await executeCommandApplication([...args, "--json"], cwd);
    expect(result.exitCode, result.output).toBe(status);
    return JSON.parse(result.output);
  };
  const assertPin = (result: any, bytes: Buffer, file: string) => expect(result.export).toEqual({path: file, bytes: bytes.length, exportSha256: createHash("sha256").update(bytes).digest("hex")});
  try {
    await fs.mkdir(offline);
    const ordinary = await cli(["review", "context", "review@1", "IMP-exact"]);
    const expandedFile = path.join(root, "expanded.json"), archiveFile = path.join(offline, "archive.json");
    const expanded = await cli(["review", "context", "review@1", "IMP-exact", "--output", expandedFile]);
    const expandedBytes = await fs.readFile(expandedFile);
    expect(JSON.parse(expandedBytes.toString())).toEqual(ordinary);
    assertPin(expanded, expandedBytes, expandedFile);
    const exported = await cli(["review", "context", "review@1", "IMP-exact", "--output", archiveFile, "--format", "shared-verifier-trees"]);
    const archiveBytes = await fs.readFile(archiveFile), archive = JSON.parse(archiveBytes.toString());
    assertPin(exported, archiveBytes, archiveFile);
    expect(archive.contract).toBe("mdlm-review-context-archive@1");
    expect(archive.verifierSourceTrees).toEqual([files, context.verifierSources[2]!.files]);
    expect(archive.verifierSources.map((s: any) => s.filesRef)).toEqual([0, 0, 1]);
    expect(archiveBytes.length).toBeLessThan(expandedBytes.length);
    frozen.mockRestore(); // The reader must not call native selection at all.
    const recoveredFile = path.join(offline, "recovered.json");
    const recovered = await cli(["review", "expand-context", "archive.json", "--output", recoveredFile], offline);
    const recoveredBytes = await fs.readFile(recoveredFile), full = JSON.parse(recoveredBytes.toString());
    assertPin(recovered, recoveredBytes, recoveredFile);
    expect(full).toEqual(ordinary);
    expect(reviewPacketDigest(full)).toBe(reviewPacketDigest(ordinary));
    expect(Buffer.from(full.verifierSources[1].files[2].content, "base64")).toEqual(screenshot);
    await cli(["review", "expand-context", "archive.json", "--output", recoveredFile], offline, 1);
    expect(await fs.readFile(recoveredFile)).toEqual(recoveredBytes);
    for (const broken of [{...archive, contract: "mdlm-review-context-archive@2"}, {...archive, verifierSources: [{...archive.verifierSources[0], filesRef: 99}]}]) {
      await fs.writeFile(path.join(offline, "broken.json"), JSON.stringify(broken));
      await cli(["review", "expand-context", "broken.json", "--output", "refused.json"], offline, 1);
      await expect(fs.stat(path.join(offline, "refused.json"))).rejects.toMatchObject({code: "ENOENT"});
    }
    expect(await fs.readFile(archiveFile)).toEqual(archiveBytes);
    expect(JSON.stringify(context)).toBe(original);
  } finally {
    frozen.mockRestore();
    await fs.rm(root, {recursive: true, force: true});
  }
});
