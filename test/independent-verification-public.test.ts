import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

test("committed documentation ranges cover selected leaves without weakening executable coverage", async () => {
  const root = await fs.mkdtemp(path.join(process.env.MDLM_DOCUMENTATION_TRACE_EVIDENCE_ROOT ?? os.tmpdir(), "mdlm-documentation-trace-"));
  const repository = path.join(root, "lifecycle"), product = path.join(root, "product"), verifier = path.join(root, "verifier"), registry = path.join(root, "reviews");
  const executable = path.join(process.cwd(), "dist/mdlm.js");
  const commands: unknown[] = [];
  let outcome = "failed";
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], {encoding: "utf8"}).trim();
  const commit = (cwd: string) => {
    git(cwd, "add", ".");
    git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "--no-verify", "-qm", "Documentation fixture");
    return git(cwd, "rev-parse", "HEAD");
  };
  const cli = (args: string[], exit = 0, manager = false) => {
    const result = spawnSync(process.execPath, [executable, ...args, "--json"], {
      cwd: args[0] === "init" ? root : repository, encoding: "utf8", timeout: 30_000,
      env: {...process.env, MDLM_REVIEW_REGISTRY: registry, MDLM_REVIEW_REGISTRAR: manager ? "1" : "0"},
    });
    commands.push({args, exit: result.status, stdout: result.stdout, stderr: result.stderr});
    expect(result.status, result.stdout + result.stderr).toBe(exit);
    return JSON.parse(result.stdout);
  };
  const guidance = (action: string, subject?: string) => cli(["expectations", "show", action, ...(subject ? [subject] : [])]);
  const submit = async (g: any, operation: string, candidates: any[], exit = 0, review = false) => {
    const file = path.join(root, `${operation}.json`);
    await fs.writeFile(file, JSON.stringify({operation, action: g.action, package: g.package, snapshot: g.snapshot,
      ...(g.subject ? {subject: g.subject} : {}), inputs: g.inputs, candidates}));
    if (review) cli(["review", "register", file, file], 0, true);
    const result = cli(["proposal", "submit", file], exit);
    if (!exit) commit(repository);
    return result;
  };
  try {
    cli(["init", repository, "--process", "iterative"]);
    await fs.mkdir(registry);
    for (const cwd of [product, verifier]) { await fs.mkdir(cwd); git(cwd, "init", "-q"); }
    const frame = guidance("frame-experiment"), exp = frame.candidates[0];
    exp.payload = {...exp.payload, title: "Local counter", criterion: "Count supplied items", question: "Can a caller use the counter?", approach: "A local command", constraints: "No stored state", allowance_minutes: 5, scope_cut: "Count only"};
    await submit(frame, "frame", [exp]);
    const draft = guidance("draft-requirements");
    const requirement = (localId: string, payload: object) => ({localId, type: "REQ", payload: {title: localId, publication: "recorded", ...payload}, links: [], body: ""});
    const published = await submit(draft, "requirements", [
      requirement("need", {kind: "stakeholder", statement: "The caller shall know how to obtain item counts"}),
      requirement("count", {kind: "software", ears: {pattern: "ubiquitous", system: "The counter", response: "print the number of supplied arguments"}}),
      requirement("instructions", {kind: "software", ears: {pattern: "ubiquitous", system: "The product", response: "document local invocation and its expected output"}}),
      {localId: "group", type: "DCP", payload: {title: "Local use", publication: "recorded"}, links: [{type: "parent", target: "$need"}, {type: "child", target: "$count"}, {type: "child", target: "$instructions"}], body: ""},
      draft.candidates.find((c: any) => c.type === "RQS"),
    ]);
    const set = published.revisions.find((id: string) => id.startsWith("RQS-"));
    const context = cli(["verification", "context", set]);
    const byTitle = Object.fromEntries(context.requirements.map((r: any) => [r.payload.title, r]));
    const review = guidance("review-requirements", set), r = review.candidates[0];
    const graph = cli(["review", "context", "review-requirements", set]).requirementGraphs[0];
    r.payload = {...r.payload, title: "Fixture review", outcome: "pass", findings: "Fixture tests source attribution mechanics only",
      requirement_assessments: graph.assessment.requirements.map((requirement: string) => ({requirement, disposition: "valid", rationale: "Necessary local use behavior"})),
      decomposition_assessments: graph.assessment.groups.map((g: any) => ({group: g.revision, children: g.children.map((requirement: string) => ({requirement, disposition: "valid", rationale: "Necessary behavior"})), disposition: "adequate", membership_action: "none", rationale: "Covers behavior and instructions"}))};
    await submit(review, "review", [r], 0, true);
    await fs.writeFile(path.join(verifier, "verify.py"), "# Public invocation and documentation checks; not executed by this attribution fixture.\n");
    const plan = guidance("plan-verification", set), activity = plan.candidates[0];
    const targets = context.requirements.map((row: any) => row.revision_id);
    activity.payload = {...activity.payload, title: "Local use checks", method: "Public invocation and document inspection", objective: "Check the documented local invocation",
      cases: [{id: "local-use", targets, preconditions: ["Fresh local checkout"], actions: ["Read the instructions and invoke the counter"], expected_results: ["Documented invocation prints the expected count"], coverage_rationale: "Checks the documented public command"}],
      coverage: targets.map((target: string) => ({target, obligations: ["Documented local counting"], case_ids: ["local-use"], rationale: "Exercises local use"})),
      repository_path: verifier, source_commit: commit(verifier), verification_image: "python@sha256:" + "a".repeat(64),
      verification_command: ["python3", "verify.py"], verification_script: "verify.py", results_path: "results.json", authoring_subject: set, authoring_context: context.authoringContext};
    activity.links = targets.map((target: string) => ({type: "verifies", target}));
    const activityId = (await submit(plan, "plan", [activity])).revisions[0];
    await fs.writeFile(path.join(product, "app.py"), "import sys\nprint(len(sys.argv)-1)\n");
    await fs.writeFile(path.join(product, "README.md"), "# Counter\nRun `python3 app.py a b`.\nExpected output: `2`.\nAdditional project background.\n");
    const source = commit(product), implement = guidance("implement-product", set), imp = implement.candidates[0];
    const codeRange = {path: "app.py", name: "count", start: 1, end: 2, requirements: [byTitle.count.revision_id.split("-r")[0]]};
    const docRange = {path: "README.md", name: "local-use", start: 2, end: 3, requirements: [byTitle.instructions.revision_id.split("-r")[0]]};
    imp.payload = {...imp.payload, title: "Counter", repository_path: product, source_commit: source, command: ["python3", "app.py"],
      file_roles: {"app.py": "production", "README.md": "documentation"}, source_ranges: [codeRange]};
    imp.links.push({type: "verification", target: activityId});
    const before = [git(repository, "rev-parse", "HEAD"), git(repository, "status", "--porcelain")];
    const uncovered = await submit(implement, "without-doc-range", [imp], 1);
    expect(uncovered.diagnostics).toEqual([{code: "direct-proposal-invalid", message: `Error: trace-requirement-uncovered: Software leaf '${byTitle.instructions.revision_id}' has no source scope that 'implements' it`}]);
    expect([git(repository, "rev-parse", "HEAD"), git(repository, "status", "--porcelain")]).toEqual(before);
    imp.payload.source_ranges = [docRange, {...codeRange, end: 1}];
    const incomplete = await submit(implement, "uncovered-executable-line", [imp], 1);
    expect(incomplete.diagnostics[0].message).toContain("source-line-unmapped: Nonblank source must belong to an explicit mapped range.");
    expect([git(repository, "rev-parse", "HEAD"), git(repository, "status", "--porcelain")]).toEqual(before);
    imp.payload.source_ranges = [codeRange, docRange];
    const accepted = await submit(implement, "with-doc-range", [imp]);
    expect(accepted.outcome).toBe("accepted");
    const implementation = accepted.revisions.find((id: string) => id.startsWith("IMP-"));
    const scopes = accepted.revisions.filter((id: string) => id.startsWith("SCP-")).map((id: string) => cli(["show", id]).lifecycleDatum.datum);
    const doc = scopes.find((s: any) => s.payload.path === "README.md");
    expect(doc.payload).toMatchObject({role: "documentation", name: "local-use", source_commit: source, blob: git(product, "rev-parse", `${source}:README.md`), ranges: [{start: 2, end: 3}]});
    expect(doc.links).toEqual(expect.arrayContaining([{type: "belongs-to", target: implementation}, {type: "implements", target: byTitle.instructions.revision_id}]));
    expect(scopes.find((s: any) => s.payload.path === "app.py").payload).toMatchObject({role: "production", ranges: [{start: 1, end: 2}]});
    const why = cli(["trace", "why", "README.md:2", "--implementation", implementation]).requirementTrace;
    expect(why.diagnostics).toEqual([]);
    expect(why.lineStatus).toBe("mapped");
    expect(why.scopes).toHaveLength(1);
    expect(why.scopes[0]).toMatchObject({revision: doc.revision_id, role: "documentation", blob: doc.payload.blob, ranges: doc.payload.ranges,
      reasons: [expect.objectContaining({requirement: byTitle.instructions.revision_id, path: [byTitle.instructions.revision_id, byTitle.need.revision_id]})]});
    const impact = cli(["trace", "impact", byTitle.instructions.revision_id, "--implementation", implementation]).requirementTrace;
    expect(impact.diagnostics).toEqual([]);
    expect(impact.resolvedRequirement).toBe(byTitle.instructions.revision_id);
    expect(impact.scopes.map((s: any) => s.revision)).toEqual([doc.revision_id]);
    expect(impact.scopes[0].reasons).toEqual([expect.objectContaining({requirement: byTitle.instructions.revision_id, path: [byTitle.instructions.revision_id]})]);
    outcome = "passed";
  } finally {
    const evidenceFile = path.join(root, "outcome.json");
    await fs.writeFile(evidenceFile, JSON.stringify({outcome, executable, repository, product, verifier, commands}, null, 2));
    process.stdout.write(`DOCUMENTATION_TRACE_EVIDENCE ${evidenceFile}\n`);
  }
}, 60_000);

test("binary verifier evidence survives public review export, registration and publication", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mdlm-binary-review-"));
  const repository = path.join(root, "lifecycle"), verifier = path.join(root, "verifier"), registry = path.join(root, "registry");
  const executable = process.env.MDLM_DIRECT_EXECUTABLE ?? path.join(process.cwd(), "dist/mdlm.js");
  const cli = (args: string[], manager = false) => {
    const result = spawnSync(executable.endsWith(".js") ? process.execPath : executable, [...(executable.endsWith(".js") ? [executable] : []), ...args, "--json"], {
      cwd: args[0] === "init" ? root : repository, encoding: "utf8", timeout: 30_000,
      env: {...process.env, MDLM_REVIEW_REGISTRY: registry, MDLM_REVIEW_REGISTRAR: manager ? "1" : "0"},
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], {encoding: "utf8"}).trim();
  const commit = (cwd: string) => {
    git(cwd, "add", ".");
    git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "--no-verify", "-qm", "Review fixture");
    return git(cwd, "rev-parse", "HEAD");
  };
  const guidance = (action: string, subject?: string) => cli(["expectations", "show", action, ...(subject ? [subject] : [])]);
  const proposalFile = async (g: any, operation: string) => {
    const file = path.join(root, `${operation}.json`);
    await fs.writeFile(file, JSON.stringify({operation, action: g.action, package: g.package, snapshot: g.snapshot, ...(g.subject ? {subject: g.subject} : {}), inputs: g.inputs, candidates: g.candidates}));
    return file;
  };
  const submit = (file: string) => {
    const result = cli(["proposal", "submit", file]);
    commit(repository);
    return result.revisions[0] as string;
  };
  try {
    cli(["init", repository, "--process", "iterative"]);
    await fs.mkdir(verifier); await fs.mkdir(registry);
    git(verifier, "init", "-q");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
    const script = "// Replay uses public browser interactions.\n";
    const manifest = JSON.stringify({screenshot: "observation.png"});
    await fs.writeFile(path.join(verifier, "observation.png"), png);
    await fs.writeFile(path.join(verifier, "replay.cjs"), script);
    await fs.writeFile(path.join(verifier, "manifest.json"), manifest);
    const sourceCommit = commit(verifier);
    const pngBlob = git(verifier, "rev-parse", `${sourceCommit}:observation.png`);
    const frame = guidance("frame-experiment");
    frame.candidates[0].payload = {...frame.candidates[0].payload, title: "Browser observation", criterion: "Show the requested result", question: "Is the result understandable?", approach: "Observe the public page", constraints: "No product source access", allowance_minutes: 5, scope_cut: "One interaction"};
    const experiment = submit(await proposalFile(frame, "frame"));
    const authoring = cli(["verification", "context", experiment]);
    const plan = guidance("plan-criterion-verification", experiment);
    plan.candidates[0].payload = {...plan.candidates[0].payload, title: "Public browser observation", method: "Browser demonstration", objective: "Inspect the visible result", authoring_subject: experiment, authoring_context: authoring.authoringContext, repository_path: verifier, source_commit: sourceCommit, verification_image: "node@sha256:" + "b".repeat(64), verification_command: ["node", "replay.cjs"], verification_script: "replay.cjs", results_path: "results.json", cases: [{id: "observe", targets: [experiment], preconditions: ["Page is open"], actions: ["Perform the requested interaction"], expected_results: ["The requested result is visible"], coverage_rationale: "Directly observes the criterion"}], coverage: [{target: experiment, obligations: ["Show the requested result"], case_ids: ["observe"], rationale: "The visible result addresses the criterion"}]};
    plan.candidates[0].links = [{type: "verifies", target: experiment}];
    const activity = submit(await proposalFile(plan, "plan"));
    const file = path.join(root, "review-context.json");
    const exported = cli(["review", "context", "review-verification", activity, "--output", file]);
    const bytes = await fs.readFile(file), context = JSON.parse(bytes.toString("utf8"));
    expect(exported.export).toEqual({path: file, bytes: bytes.length, exportSha256: createHash("sha256").update(bytes).digest("hex")});
    expect(context.sources).toEqual([]);
    expect(context.verifierSources).toHaveLength(1);
    expect(context.verifierSources[0]).toMatchObject({activity, sourceCommit});
    const files = context.verifierSources[0].files;
    expect(files).toHaveLength(3);
    expect(files.find((f: any) => f.path === "replay.cjs")).toMatchObject({content: script});
    expect(files.find((f: any) => f.path === "manifest.json")).toMatchObject({content: manifest});
    const binary = files.find((f: any) => f.path === "observation.png");
    expect(binary).toMatchObject({blob: pngBlob, encoding: "base64"});
    expect(Buffer.from(binary.content, binary.encoding)).toEqual(png);
    const review = guidance("review-verification", activity);
    review.candidates[0].payload = {...review.candidates[0].payload, title: "Evidence fixture review", outcome: "pass", findings: "Fixture review tests exact mixed-file transport only", coverage_assessments: [{target: experiment, disposition: "adequate", rationale: "Fixture's declared case addresses its criterion"}]};
    const proposal = await proposalFile(review, "review");
    const verdict = path.join(root, "verdict.json");
    await fs.writeFile(verdict, JSON.stringify({candidates: review.candidates}));
    cli(["review", "register", proposal, verdict], true);
    const revision = submit(proposal);
    expect(cli(["show", revision]).lifecycleDatum.datum.payload.outcome).toBe("pass");
    process.stdout.write(`BINARY_REVIEW_CONTEXT_BYTES ${bytes.length}\n`);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
}, 60_000);

test("independent verification reports complete requirements, failures, stale evidence and recovery through the CLI", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mdlm-independent-public-"));
  const repository = path.join(root,"lifecycle"), product = path.join(root,"product"), verifier = path.join(root,"verifier"), registry = path.join(root,"registry");
  let executable = process.env.MDLM_DIRECT_EXECUTABLE ?? path.join(process.cwd(),"dist/mdlm.js");
  if (process.env.MDLM_DIRECT_INSTALLED === "1" && !process.env.MDLM_DIRECT_EXECUTABLE) {
    const packed=path.join(root,"packed");await fs.mkdir(packed);
    const archive=execFileSync("npm",["pack","--pack-destination",packed,"--silent"],{cwd:process.cwd(),encoding:"utf8"}).trim().split("\n").at(-1)!;
    const install=path.join(root,"install");execFileSync("npm",["install","--prefix",install,"--ignore-scripts","--no-audit","--no-fund","--offline",path.join(packed,archive)],{encoding:"utf8"});
    executable=path.join(install,"node_modules/mdlm/dist/mdlm.js");
  }
  const commands: unknown[] = []; let outcome = "failed";
  const cli = (args: string[], exit = 0, manager = false) => {
    const argv = executable.endsWith(".js") ? [process.execPath, [executable,...args,"--json"]] as const : [executable,[...args,"--json"]] as const;
    const result = spawnSync(argv[0],argv[1],{cwd:args[0]==="init"?root:repository,encoding:"utf8",timeout:90_000,maxBuffer:32*1024*1024,env:{...process.env,MDLM_REVIEW_REGISTRY:registry,MDLM_REVIEW_REGISTRAR:manager?"1":"0"}});
    commands.push({args,status:result.status,stdout:result.stdout,stderr:result.stderr});
    expect(result.status,result.stdout+result.stderr).toBe(exit);return JSON.parse(result.stdout);
  };
  const git = (cwd: string, ...args: string[]) => execFileSync("git",["-C",cwd,...args],{encoding:"utf8"}).trim();
  const commit = (cwd: string) => {git(cwd,"add",".");git(cwd,"-c","commit.gpgSign=false","commit","--no-verify","--allow-empty","-qm","Fixture evidence");return git(cwd,"rev-parse","HEAD");};
  const init = async (cwd:string) => {await fs.mkdir(cwd);git(cwd,"init","-q");git(cwd,"config","user.name","Fixture");git(cwd,"config","user.email","fixture@example.invalid");};
  const datum = (id:string) => cli(["show",id]).lifecycleDatum.datum;
  const guidance = (action:string,subject?:string) => cli(["expectations","show",action,...(subject?[subject]:[])]);
  const submit = async (g:any, operation:string,candidates:any[],evidence?:any,review=false,expectedExit=0) => {
    const proposal = {operation,action:g.action,package:g.package,snapshot:g.snapshot,...(g.subject?{subject:g.subject}:{}),inputs:g.inputs,candidates,...(evidence?{evidence}:{})};
    const file=path.join(root,`${operation}.json`);await fs.writeFile(file,JSON.stringify(proposal));
    if(review)cli(["review","register",file,file],0,true);
    const result=cli(["proposal","submit",file,...(evidence?.authority?["--authority","stakeholder"]:[])],expectedExit);
    if(!expectedExit)commit(repository);return result;
  };
  const review = async (action:string,subject:string,operation:string) => {
    const g=guidance(action,subject), context=cli(["review","context",action,subject]);
    const c=g.candidates[0];c.payload={...c.payload,title:"Independent fixture review",outcome:"pass",findings:"Fixture review authorizes the explicitly enumerated evidence only"};
    if(action==="review-verification") {
      expect(context.sources).toEqual([]);
      expect(context.verifierSources[0].files.some((f:any)=>f.path==="verify.py")).toBe(true);
      c.payload.coverage_assessments=datum(subject).payload.coverage.map((a:any)=>({target:a.target,disposition:"adequate",rationale:"Cases cover the bounded count, empty input and public error obligations"}));
    }
    if(action==="review-requirements") {
      const graph=context.requirementGraphs[0];
      c.payload.requirement_assessments=graph.requirements.map((r:any)=>({requirement:r.revision_id,disposition:"valid",rationale:"Necessary bounded observable behavior"}));
      c.payload.decomposition_assessments=graph.groups.map((d:any)=>({group:d.revision_id,children:d.links.filter((l:any)=>l.type==="child").map((l:any)=>({requirement:l.target,disposition:"valid",rationale:"Necessary behavior"})),disposition:"adequate",membership_action:"none",rationale:"Count and empty cases collectively establish the stakeholder need"}));
    }
    if(action==="review-implementation") c.payload.coverage_assessments=context.requirementGraphs[0].requirements.map((r:any)=>({target:r.revision_id,disposition:"adequate",rationale:"The selected cases collectively cover all obligations, including the stakeholder outcome"}));
    return submit(g,operation,[c],undefined,true);
  };
  try {
    cli(["init",repository,"--process","iterative"]);await fs.mkdir(registry);await init(product);await init(verifier);
    const framing=guidance("frame-experiment"), exp=framing.candidates[0];
    exp.payload={...exp.payload,title:"Count CLI",criterion:"Count all arguments",question:"Can a public CLI count supplied items?",approach:"Use a minimal counter",constraints:"No persistence",allowance_minutes:5,scope_cut:"No interactive mode"};
    const expId=(await submit(framing,"frame",[exp])).revisions[0];
    const g=guidance("draft-requirements");
    const req=(localId:string,payload:any)=>({localId,type:"REQ",payload:{title:localId,publication:"recorded",...payload},links:[],body:""});
    const published=await submit(g,"requirements",[
      req("need",{kind:"stakeholder",statement:"The user shall obtain the number of supplied arguments",rationale:"Count supplied items"}),
      req("count",{kind:"software",ears:{pattern:"ubiquitous",system:"The CLI",response:"print the number of arguments as a decimal integer followed by a newline and exit zero"}}),
      req("empty",{kind:"software",ears:{pattern:"event",event:"no arguments are supplied",system:"The CLI",response:"print zero followed by a newline and exit zero"}}),
      {localId:"decomposition",type:"DCP",payload:{title:"Counting obligations",publication:"recorded"},links:[{type:"parent",target:"$need"},{type:"child",target:"$count"},{type:"child",target:"$empty"}],body:""},g.candidates.find((c:any)=>c.type==="RQS")]);
    const set=published.revisions.find((id:string)=>id.startsWith("RQS-"));
    const refs=published.revisions.filter((id:string)=>id.startsWith("REQ-"));
    const byTitle=Object.fromEntries(refs.map((id:string)=>[datum(id).payload.title,id]));
    const authoring=cli(["verification","context",set]);
    expect(authoring.requirements).toHaveLength(3);expect(JSON.stringify(authoring)).not.toContain("source_commit");
    const exported=cli(["verification","context",set,"--output",path.join(root,"requirements-only.json")]);
    expect(exported.authoringContext).toBe(authoring.authoringContext);
    await review("review-requirements",set,"review-requirements");
    const image="python@sha256:7415fbc3c9e4979cc717d92377ab2bc7b2b4a2af1ac03cc52b5f3f88efedaf3a";
    const script=`import json,os,subprocess\nfrom pathlib import Path\nrows=[]\nfor case,args,expected in [('empty',[],'0\\n'),('count',['a','b','c'],'3\\n')]:\n r=subprocess.run(['python3',os.environ['MDLM_PRODUCT_DIR']+'/app.py',*args],capture_output=True,text=True)\n rows.append({'case_id':case,'outcome':'pass' if r.returncode==0 and r.stdout==expected else 'fail','actual_results':[repr(r.stdout),'exit '+str(r.returncode)],'evidence_refs':[]})\nPath(os.environ['MDLM_EVIDENCE_DIR']+'/results.json').write_text(json.dumps({'contract':'mdlm-verification-results@1','cases':rows}))\nraise SystemExit(0 if all(r['outcome']=='pass' for r in rows) else 1)\n`;
    await fs.writeFile(path.join(verifier,"verify.py"),script);const verifierCommit=commit(verifier);
    const plan=guidance("plan-verification",set), vfy=plan.candidates[0];
    const cases=[{id:"empty",targets:[byTitle.need,byTitle.count,byTitle.empty],preconditions:["Fresh process with no stored state"],actions:["Invoke the CLI with no arguments"],expected_results:["stdout is 0 newline, exit zero"],coverage_rationale:"Zero boundary and visible count"},{id:"count",targets:[byTitle.need,byTitle.count],preconditions:["Fresh process with no stored state"],actions:["Invoke the CLI with a b c"],expected_results:["stdout is 3 newline, exit zero"],coverage_rationale:"Multiple supplied arguments"}];
    vfy.payload={...vfy.payload,title:"Public count contract",method:"CLI black-box test",objective:"Verify exact observable count",cases,coverage:refs.map((target:string)=>({target,obligations:["Observable count and successful completion"],case_ids:cases.filter(c=>c.targets.includes(target)).map(c=>c.id),rationale:"Boundary and ordinary invocation establish the bounded counting behavior"})),repository_path:verifier,source_commit:verifierCommit,verification_image:image,verification_script:"verify.py",verification_command:["python3","verify.py"],results_path:"results.json",authoring_subject:set,authoring_context:authoring.authoringContext};
    vfy.links=refs.map((target:string)=>({type:"verifies",target}));const activity=(await submit(plan,"plan",[vfy])).revisions[0];
    await fs.writeFile(path.join(product,"app.py"),"import sys\nprint(len(sys.argv)-1)\n");const source=commit(product);
    const implementation=guidance("implement-product",set), imp=implementation.candidates[0];
    imp.payload={...imp.payload,title:"Count product",repository_path:product,source_commit:source,command:["python3","app.py"],file_roles:{"app.py":"production"},source_ranges:[{path:"app.py",name:"count",start:1,end:2,requirements:[datum(byTitle.count).id,datum(byTitle.empty).id]}]};imp.links.push({type:"verification",target:activity});
    let productId=(await submit(implementation,"implementation",[imp])).revisions.find((id:string)=>id.startsWith("IMP-"));
    const execute=async(op:string,id:string,activityId=activity) => {
      const execution=cli(["execution","run",id,op,"--activity",activityId]);
      const g=guidance("execute-verification",id), file=path.join(root,`${op}-result.json`);
      cli(["proposal","draft","execute-verification",id,...(op === "pass" ? [] : ["--activity",activityId]),"--operation",`${op}-result`,"--output",file]);
      const proposal=JSON.parse(await fs.readFile(file,"utf8")),c=proposal.candidates[0];
      expect(c.links).toEqual([...g.candidates[0].links,{type:"evaluates",target:activityId}]);
      expect(proposal).toMatchObject({action:g.action,package:g.package,snapshot:g.snapshot,subject:id,inputs:g.inputs});
      c.payload={...c.payload,title:"Verification result",assessment:"Captured assertions compared public output to independently specified expectations",correction_target:execution.value.receipt.result.outcome==="pass"?"none":"implementation"};
      proposal.evidence={receipt:execution.value.evidence};
      await fs.writeFile(file,JSON.stringify(proposal));
      expect(cli(["proposal","submit",file]).outcome).toBe("accepted");commit(repository);
      return execution;
    };
    const beforeReview=cli(["verification","status",productId]);expect(beforeReview.complete).toBe(false);expect(beforeReview.requirements.every((r:any)=>r.overall==="awaiting-review")).toBe(true);
    await review("review-verification",activity,"review-coverage");
    const beforeExecution=cli(["verification","status",productId]);
    expect(beforeExecution.complete).toBe(false);
    for(const row of beforeExecution.requirements) expect(row).toMatchObject({coverage:"adequate",execution:"not-run",collectiveCoverage:"awaiting-coverage-review",overall:"not-run",nextAction:"Execute the selected activity against this exact product"});
    const first=await execute("pass",productId);
    expect(first.value.receipt.result.caseResults).toHaveLength(2);
    expect(cli(["verification","status",productId]).requirements[0]).toMatchObject({overall:"awaiting-coverage-review",nextAction:"Review collective requirement coverage with the implementation"});
    const settled=cli(["execution","run",productId,"pass","--activity",activity]);expect(settled.value.evidence).toBe(first.value.evidence);
    const rerun=await execute("pass-fresh",productId);
    const oldGuidance=guidance("execute-verification",productId),oldCandidate=oldGuidance.candidates[0];oldCandidate.payload={...oldCandidate.payload,title:"Older count evidence",assessment:"Attempt to reuse older evidence",correction_target:"none"};oldCandidate.links.push({type:"evaluates",target:activity});
    const staleReceipt=await submit(oldGuidance,"old-receipt",[oldCandidate],{receipt:first.value.evidence},false,1);expect(JSON.stringify(staleReceipt)).toContain("fresh execution");
    expect(rerun.value.evidence).not.toBe(first.value.evidence);
    const evidenceDirectory=path.join(root,"exported-evidence");const exportedEvidence=cli(["execution","export","pass-fresh",evidenceDirectory]);expect(exportedEvidence.files.some((f:any)=>f.path==="report.json")).toBe(true);expect(JSON.parse(await fs.readFile(path.join(evidenceDirectory,"report.json"),"utf8")).cases).toHaveLength(2);
    await review("review-implementation",productId,"review-implementation");
    expect(cli(["verification","status",productId]).complete).toBe(true);
    // A correction draft carries the product payload but never its verification selection: unedited, it is rejected until the author selects current activities.
    const rejecting=guidance("accept-product",productId),rej=rejecting.candidates[0];rej.payload={...rej.payload,title:"Reject count",decision:"reject",rationale:"Stakeholder asks for a corrected product"};await submit(rejecting,"reject",[rej],{authority:["stakeholder"]});
    const correctionFile=path.join(root,"correction-draft.json");
    cli(["proposal","draft","correct-rejected-product",productId,"--operation","correction","--output",correctionFile]);
    const correction=JSON.parse(await fs.readFile(correctionFile,"utf8")),corrected=correction.candidates[0];
    expect(corrected.links.map((l:any)=>l.type).sort()).toEqual(["corrects","implements"]);
    expect(corrected.payload).toMatchObject({title:"Count product",source_commit:source});
    expect(JSON.stringify(cli(["proposal","submit",correctionFile],1))).toContain("select at least one exact independent verification activity");
    expect(cli(["proposal","settlement","correction"]).outcome).toBe("not-published");
    corrected.links.push({type:"verification",target:activity});await fs.writeFile(correctionFile,JSON.stringify(correction));
    productId=cli(["proposal","submit",correctionFile]).revisions.find((id:string)=>id.startsWith("IMP-"));commit(repository);
    expect(datum(productId).links).toContainEqual({type:"verification",target:activity});
    // A selection-only draft keeps the same context, so it starts from the current selection and drops the correction's context link.
    const selectionFile=path.join(root,"selection-draft.json");
    cli(["proposal","draft","update-verification-selection",productId,"--operation","selection","--output",selectionFile]);
    expect(JSON.parse(await fs.readFile(selectionFile,"utf8")).candidates[0].links).toEqual([{type:"implements",target:set},{type:"verification",target:activity}]);
    // The regression ends at the published correction; executing and accepting it adds a container run and no draft coverage.
    // Keep the formal product and its oracle intact. A new provisional product tests implementation substitution and mismatch.
    const criterionContext=cli(["verification","context",expId]);
    const pg=guidance("plan-criterion-verification",expId),pc=pg.candidates[0];pc.payload={...vfy.payload,authoring_subject:expId,authoring_context:criterionContext.authoringContext,cases:cases.map(c=>({...c,targets:[expId]})),coverage:[{target:expId,obligations:["Count supplied arguments"],case_ids:["empty","count"],rationale:"Boundary and ordinary invocation"}]};pc.links=[{type:"verifies",target:expId}];let provisionalActivity=(await submit(pg,"criterion-plan",[pc])).revisions[0];
    const wrongActivityFile=path.join(root,"wrong-activity-draft.json");
    const wrongActivity=cli(["proposal","draft","execute-verification",productId,"--activity",provisionalActivity,"--operation","wrong-activity-draft","--output",wrongActivityFile],1);
    expect(JSON.stringify(wrongActivity)).toContain("selected verification activities");
    await expect(fs.stat(wrongActivityFile)).rejects.toMatchObject({code:"ENOENT"});
    const trial=async(op:string,sourceCommit:string,previous?:string) => {const tg=guidance(previous?"revise-prototype":"prepare-prototype",previous??expId),tc=tg.candidates[0];tc.payload={...tc.payload,title:"Counter trial",repository_path:product,source_commit:sourceCommit,command:["python3","app.py"]};tc.links.push({type:"verification",target:provisionalActivity});return (await submit(tg,op,[tc])).revisions[0];};
    let trialId=await trial("trial",source);
    const runTrial=async(op:string,id:string) => {const result=cli(["execution","run",id,op,"--activity",provisionalActivity]);const g=guidance("execute-criterion-verification",id),c=g.candidates[0];c.payload={...c.payload,title:"Verification result",assessment:"Exact public observations retained",correction_target:result.value.receipt.result.outcome==="pass"?"none":"implementation"};c.links.push({type:"evaluates",target:provisionalActivity});await submit(g,`${op}-result`,[c],{receipt:result.value.evidence});return result;};
    await runTrial("trial-pass",trialId);expect(cli(["verification","status",trialId]).requirements[0].overall).toBe("observed-pass");
    // Deliberately omit a declared row, then repair the verifier while keeping product source fixed.
    await fs.writeFile(path.join(verifier,"verify.py"),script.replace("'cases':rows", "'cases':rows[:1]"));const incompleteCommit=commit(verifier);
    const revisePlan=async(op:string,commitId:string) => {const g=guidance("revise-verification",provisionalActivity),c=g.candidates[0];c.payload={...datum(provisionalActivity).payload,source_commit:commitId};c.links=datum(provisionalActivity).links;provisionalActivity=(await submit(g,op,[c])).revisions[0];};
    const selectPlan=async(op:string) => {const g=guidance("update-criterion-verification-selection",trialId),c=g.candidates[0];c.payload=datum(trialId).payload;c.links=c.links.filter((l:any)=>l.type!=="verification");c.links.push({type:"verification",target:provisionalActivity});trialId=(await submit(g,op,[c])).revisions[0];};
    await revisePlan("incomplete-plan",incompleteCommit);await selectPlan("select-incomplete");
    expect(cli(["verification","status",trialId]).requirements[0].overall).toBe("stale");
    await runTrial("trial-incomplete",trialId);const incomplete=cli(["verification","status",trialId]);expect(incomplete.requirements[0].overall).toBe("error");expect(incomplete.requirements[0].activities[0].cases.some((c:any)=>c.outcome==="not-run")).toBe(true);
    await fs.writeFile(path.join(verifier,"verify.py"),script);await revisePlan("repaired-plan",commit(verifier));await selectPlan("select-repaired");await runTrial("trial-repaired",trialId);expect(cli(["verification","status",trialId]).requirements[0].overall).toBe("observed-pass");
    const og=guidance("observe-prototype",trialId),oc=og.candidates[0];oc.payload={...oc.payload,title:"Working count",assessment:"Public checks passed",observation_origin:"scripted",interaction_observation:"Both CLI invocations matched",limitations:"Small bounded fixture",recommendation:"nominate",next_action:"Ask stakeholder for next comparison"};const observation=(await submit(og,"observe-trial",[oc])).revisions[0];
    const fg=guidance("record-feedback",observation),fc=fg.candidates[0];fc.payload={...fc.payload,title:"Compare changed implementation",action:"revise-prototype",feedback:"Try the next implementation and retain the same contract",source:"Fixture stakeholder"};const feedback=(await submit(fg,"feedback",[fc],{authority:["stakeholder"]})).revisions[0];
    await fs.writeFile(path.join(product,"app.py"),"import sys\nprint(len(sys.argv))\n");const wrong=commit(product);
    // New trial lineage is valid experimental work; exact product binding makes prior evidence stale.
    const tg=guidance("revise-prototype",feedback),tc=tg.candidates[0];tc.payload={...tc.payload,title:"Deliberate wrong counter",repository_path:product,source_commit:wrong,command:["python3","app.py"]};tc.links.push({type:"verification",target:provisionalActivity});trialId=(await submit(tg,"wrong-trial",[tc])).revisions[0];
    expect(cli(["verification","status",trialId]).requirements[0].overall).toBe("stale");await runTrial("trial-fail",trialId);expect(cli(["verification","status",trialId]).requirements[0].overall).toBe("failing");
    outcome="passed";
  } finally {
    const evidenceFile=path.join(root,"outcome.json");await fs.writeFile(evidenceFile,JSON.stringify({outcome,executable,repository,product,verifier,commands},null,2));process.stdout.write(`INDEPENDENT_VERIFICATION_EVIDENCE ${evidenceFile}\n`);
  }
},180_000);
