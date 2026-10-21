import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { initializeBundledRepository } from "../src/repository-initialization.js";
import { directContext, directState, inspectDirectExpectations, inspectVerificationContext, registerDirectReviewFiles, runDirectExecution, submitDirectProposal } from "../src/direct-proposal.js";

/**
 * A lifecycle repository at the end of a large run: a selection-only product revision
 * selecting `results` reviewed verification activities, each with one current passing
 * result. The first `historical` results carry an earlier revision's execution forward;
 * the rest are fresh. The product is ready for implementation review and acceptance. Callers must mock Docker execution
 * (see `simulatedDockerVerification`); every other step is a supported publication.
 */
export interface EndgameFixture {root: string; repository: string; registry: string; product: string; implementation: string; requirements: string}

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], {encoding: "utf8"}).trim();
const commit = (cwd: string) => {
  git(cwd, "add", ".");
  git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "--no-verify", "--allow-empty", "-qm", "Endgame fixture");
  return git(cwd, "rev-parse", "HEAD");
};

export async function buildEndgameFixture(root: string, results: number, historical: number, log: (message: string) => void = () => {}): Promise<EndgameFixture> {
  const repository = path.join(root, "lifecycle"), product = path.join(root, "product"), verifier = path.join(root, "verifier"), registry = path.join(root, "registry");
  process.env.MDLM_REVIEW_REGISTRY = registry; process.env.MDLM_REVIEW_REGISTRAR = "1";
  await fs.mkdir(registry, {recursive: true});
  const initialized = await initializeBundledRepository(repository, "iterative");
  if (!initialized.ok) throw new Error(JSON.stringify(initialized));
  for (const p of [product, verifier]) {await fs.mkdir(p); git(p, "init", "-q");}
  const guidance = async (action: string, subject?: string) => inspectDirectExpectations(repository, action, subject) as Promise<any>;
  const submit = async (g: any, operation: string, candidates = g.candidates, evidence?: unknown, review = false): Promise<any> => {
    const source = JSON.stringify({operation, action: g.action, package: g.package, snapshot: g.snapshot, ...(g.subject ? {subject: g.subject} : {}), inputs: g.inputs, candidates, ...(evidence ? {evidence} : {})});
    if (review) await registerDirectReviewFiles(repository, source, source);
    return submitDirectProposal(repository, source, (evidence as any)?.authority ?? []);
  };
  const datum = async (id: string): Promise<any> => (await directState(repository)).data.find(d => d.revision_id === id)!;
  const passingReview = async (action: string, subject: string, operation: string, targets: string[]) => {
    const g = await guidance(action, subject), c = g.candidates[0];
    c.payload = {...c.payload, title: "Fixture review", outcome: "pass", findings: "Fixture registration for the endgame benchmark; no production conformance claim",
      coverage_assessments: targets.map(target => ({target, disposition: "adequate", rationale: "Bounded fixture coverage"}))};
    return submit(g, operation, [c], undefined, true);
  };

  const framing = await guidance("frame-experiment"), exp = framing.candidates[0];
  exp.payload = {...exp.payload, title: "Count", criterion: "Count arguments", question: "Can the CLI count?", approach: "One local command", constraints: "No persistence", allowance_minutes: 5, scope_cut: "Counting only"};
  await submit(framing, "frame");
  const g = await guidance("draft-requirements");
  const published = await submit(g, "requirements", [
    {localId: "need", type: "REQ", payload: {title: "Count items", publication: "recorded", kind: "stakeholder", statement: "The user shall obtain the number of supplied items"}, links: [], body: ""},
    {localId: "count", type: "REQ", payload: {title: "Count arguments", publication: "recorded", kind: "software", ears: {pattern: "ubiquitous", system: "The CLI", response: "print the argument count followed by newline and exit zero"}}, links: [], body: ""},
    {localId: "group", type: "DCP", payload: {title: "Counting", publication: "recorded"}, links: [{type: "parent", target: "$need"}, {type: "child", target: "$count"}], body: ""}, g.candidates.find((c: any) => c.type === "RQS"),
  ]);
  const set: string = published.revisions.find((id: string) => id.startsWith("RQS-")), reqs: string[] = published.revisions.filter((id: string) => id.startsWith("REQ-"));
  const rg = await guidance("review-requirements", set), rc = rg.candidates[0], context = (await directState(repository)).data;
  const groups = context.filter(d => d.type === "DCP" && published.revisions.includes(d.revision_id));
  rc.payload = {...rc.payload, title: "Fixture review", outcome: "pass", findings: "Fixture registration; no production conformance claim",
    requirement_assessments: reqs.map(requirement => ({requirement, disposition: "valid", rationale: "Necessary observable count"})),
    decomposition_assessments: groups.map(d => ({group: d.revision_id, children: d.links.filter(l => l.type === "child").map(l => ({requirement: l.target, disposition: "valid", rationale: "Necessary count"})), disposition: "adequate", membership_action: "none", rationale: "Complete bounded count"}))};
  await submit(rg, "review-requirements", [rc], undefined, true);
  log("requirements reviewed");

  // A shared verifier library, as in large runs where each activity's commit carries it.
  for (let index = 0; index < 8; index++) await fs.writeFile(path.join(verifier, `library-${index}.py`), `# shared helper ${index}\n${"VALUE = 1\n".repeat(200)}`);
  await fs.writeFile(path.join(verifier, "verify.py"), "raise SystemExit(0)\n");
  const verifierCommit = commit(verifier);
  const authoring = (await inspectVerificationContext(repository, set)) as any;
  const plan = await guidance("plan-verification", set), template = plan.candidates[0];
  const activities = Array.from({length: results}, (_, index) => {
    const vfy = structuredClone(template); vfy.localId = `v${index}`;
    vfy.payload = {...vfy.payload, title: `Public count ${index}`, method: "Public CLI count", objective: "Observe exact count", cases: [{id: `count-${index}`, targets: reqs, preconditions: ["Fresh process"], actions: ["Invoke a b"], expected_results: ["2 newline and exit zero"], coverage_rationale: "Public count"}],
      coverage: reqs.map(target => ({target, obligations: ["Correct observable count"], case_ids: [`count-${index}`], rationale: "Public command observation"})), repository_path: verifier, source_commit: verifierCommit,
      verification_image: "python@sha256:7415fbc3c9e4979cc717d92377ab2bc7b2b4a2af1ac03cc52b5f3f88efedaf3a", verification_script: "verify.py", verification_command: ["python3", "verify.py"], results_path: "results.json", authoring_subject: set, authoring_context: authoring.authoringContext};
    vfy.links = reqs.map(target => ({type: "verifies", target}));
    return vfy;
  });
  const vfyIds: string[] = (await submit(plan, "plan", activities)).revisions;
  for (const [index, id] of vfyIds.entries()) {
    await passingReview("review-verification", id, `review-vfy-${index}`, (await datum(id)).payload.coverage.map((c: any) => c.target));
    if (index % 25 === 24) log(`reviewed ${index + 1}/${results} activities`);
  }

  await fs.writeFile(path.join(product, "app.py"), "import sys\nprint(len(sys.argv)-1)\n");
  const source = commit(product);
  const ig = await guidance("implement-product", set), imp = ig.candidates[0];
  const software = (await directState(repository)).data.find(d => reqs.includes(d.revision_id) && d.payload.kind === "software")!;
  imp.payload = {...imp.payload, title: "Counter", repository_path: product, source_commit: source, command: ["python3", "app.py"], file_roles: {"app.py": "production"}, source_ranges: [{path: "app.py", name: "count", start: 1, end: 2, requirements: [software.id]}]};
  imp.links.push(...vfyIds.map(target => ({type: "verification", target})));
  const implementation = (await submit(ig, "implement")).revisions.find((id: string) => id.startsWith("IMP-"))!;

  // Guidance would rescan every saved receipt; the exact eligible context is enough here.
  const record = async (product: string, activity: string, operation: string, evidence: object) => {
    const state = await directState(repository), context = directContext(state, "execute-verification", product);
    const links = [{type: "executes", target: product}, {type: "verifies", target: context.inputs.requirements![0]!}, {type: "evaluates", target: activity}];
    return (await submit({action: `${context.action.id}@${context.action.version}`, package: state.package, snapshot: state.snapshot, subject: product, inputs: context.inputs}, operation,
      [{localId: "res", type: "RES", payload: {publication: "recorded", title: operation, assessment: "Exact public count recorded", correction_target: "none"}, links, body: ""}], evidence)).revisions[0]!;
  };
  const fresh = async (product: string, activity: string, operation: string) =>
    record(product, activity, `${operation}-result`, {receipt: ((await runDirectExecution(repository, product, operation, activity)) as any).value.evidence});
  const original: string[] = [];
  for (const [index, activity] of vfyIds.entries()) {
    original.push(await fresh(implementation, activity, `run-${index}`));
    if (index % 25 === 24) log(`recorded ${index + 1}/${results} original results`);
  }
  // A selection-only successor carries part of the evidence forward, as large runs do.
  const sg = await guidance("update-verification-selection", implementation), sc = sg.candidates[0];
  const {product_files, source_inventory, source_changes, ...authored} = (await datum(implementation)).payload;
  sc.payload = authored; sc.links.push(...vfyIds.map(target => ({type: "verification", target})));
  const successor = (await submit(sg, "select-again")).revisions.find((id: string) => id.startsWith("IMP-"))!;
  for (const [index, activity] of vfyIds.entries()) {
    if (index < historical) await record(successor, activity, `carry-${index}`, {historicalResult: original[index]});
    else await fresh(successor, activity, `rerun-${index}`);
    if (index % 25 === 24) log(`recorded ${index + 1}/${results} current results`);
  }
  return {root, repository, registry, product, implementation: successor, requirements: set};
}
