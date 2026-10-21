import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DatumEnvelope, ProcessPackage } from "./index.js";
import type { ProcessSelection } from "./repository-contract.js";
import { authenticatedAuthoringPackage } from "./lifecycle-repository.js";
import { boundLinks, effectiveInterfaces, requirementTraceBinding, selectedRequirementGraph } from "./requirement-trace.js";
import type { VerificationBinding } from "./verification-receipt.js";

type State = {pkg: ProcessPackage; package: unknown; data: DatumEnvelope[]; authoringSelections?: readonly ProcessSelection[]};
export interface VerificationCase {id: string; targets: string[]; preconditions: string[]; actions: string[]; expected_results: string[]; coverage_rationale: string}
export interface CoverageClaim {target: string; obligations: string[]; case_ids: string[]; rationale: string}
const targets = (datum: DatumEnvelope, relation: string) => datum.links.filter(link => link.type === relation).map(link => link.target);
const exact = (data: DatumEnvelope[], id: string) => {const datum = data.find(d => d.revision_id === id); if (!datum) throw new Error(`Unknown exact revision '${id}'`); return datum;};
export function independentBinding(pkg: ProcessPackage) {return pkg.kernelCapabilities["independent-verification@1"];}
function binding(state: State) {const b = independentBinding(state.pkg); if (!b) throw new Error("Selected package does not support independent-verification@1"); return b;}
function selectedTargets(state: State, subject: DatumEnvelope): DatumEnvelope[] {
  const b = binding(state), trace = requirementTraceBinding(state.pkg);
  if (subject.type === b.criterion_type) return [subject];
  if (subject.type === trace?.type) return selectedRequirementGraph(state.data, subject, trace).requirements;
  throw new Error("Verification authoring context requires an exact requirement set or design criterion");
}
/** Deliberately whitelist lifecycle intent. Product records, source and previous verifiers never enter this export. */
export function verificationAuthoringContext(state: State, subjectId: string) {
  const subject = exact(state.data, subjectId), requirements = selectedTargets(state, subject);
  const trace = requirementTraceBinding(state.pkg);
  const groups = subject.type === trace?.type ? selectedRequirementGraph(state.data, subject, trace).groups : [];
  // Requirement records show the interfaces they bind in this set, including set-level retargets.
  const bound = (d: DatumEnvelope) => subject.type === trace?.type ? {...d, links: boundLinks(state.data, subject, d)} : d;
  const interfaceIds = new Set(requirements.flatMap(d => targets(bound(d), "uses-interface")));
  const interfaces = [...interfaceIds].sort().map(id => exact(state.data, id));
  const record = (d: DatumEnvelope) => ({revision_id: d.revision_id, type: d.type, payload: d.payload, body: d.body, links: d.links.filter(l => ["uses-interface", "parent", "child"].includes(l.type))});
  const context = {contract: "mdlm-verification-authoring@1", package: state.package, subject: subjectId, requirements: requirements.map(d => record(bound(d))), decomposition: groups.map(record), interfaces: interfaces.map(record), instructions: "Author intended actions and expected results from this intent only. Use public interfaces, not implementation source or existing product tests. Explain coverage of every obligation. Method and tool must fit the claim; a passing case is evidence within its stated limits."};
  return {...context, authoringContext: `sha256:${createHash("sha256").update(JSON.stringify(context)).digest("hex")}`};
}
export function validateVerificationActivity(state: State, activity: DatumEnvelope) {
  const b = binding(state);
  if (activity.type !== b.type) throw new Error("Selected activity has the wrong type");
  const p = activity.payload;
  const context = verificationAuthoringContext(state, String(p.authoring_subject));
  if (p.authoring_context !== context.authoringContext) {
    const original = authenticatedAuthoringPackage(activity);
    const selection = state.authoringSelections?.find(s =>
      `${s.package.reference}#${s.package.digest}` === activity.created_by.process_ref);
    if (!original || !selection || original.manifest.id !== state.pkg.manifest.id
      || original.manifest.direct_contract !== "mdlm-direct@1"
      || state.pkg.manifest.direct_contract !== "mdlm-direct@1"
      || ["kernel_contract", "artifact_format", "language"].some(k => !isDeepStrictEqual(original.manifest[k], state.pkg.manifest[k]))
      || ["independent-verification@1", "requirement-trace@4"].some(k => !isDeepStrictEqual(original.kernelCapabilities[k], state.pkg.kernelCapabilities[k])))
      throw new Error("Verification authoring_context must match the exact requirements-only export or its authenticated compatible authoring package");
    const originalIdentity = {reference: selection.package.reference, digest: selection.package.digest, language: selection.language.expressions};
    // Recompute every current semantic input and instruction with only the
    // authenticated original package identity. Execution still binds state.package.
    if (p.authoring_context !== verificationAuthoringContext({...state, package: originalIdentity}, String(p.authoring_subject)).authoringContext)
      throw new Error("Retained verification authoring_context differs from current exact semantic inputs");
  }
  const allowed = new Set(context.requirements.map(r => r.revision_id));
  const selected = targets(activity, "verifies");
  if (!selected.length || new Set(selected).size !== selected.length || selected.some(id => !allowed.has(id))) throw new Error("Activity verifies links must select distinct exact requirements or criterion from its authoring context");
  const cases = p.cases as VerificationCase[], coverage = p.coverage as CoverageClaim[];
  if (!Array.isArray(cases) || !cases.length || new Set(cases.map(c => c.id)).size !== cases.length) throw new Error("Activity needs distinct nonempty case IDs");
  for (const c of cases) {
    if (!c.id || !Array.isArray(c.targets) || !c.targets.length || c.targets.some(id => !selected.includes(id)) || ![c.preconditions, c.actions, c.expected_results].every(v => Array.isArray(v) && v.length && v.every(s => typeof s === "string" && s.trim())) || !c.coverage_rationale?.trim()) throw new Error(`Case '${c.id}' needs exact selected targets, preconditions, intended actions, expected results and rationale`);
  }
  if (!Array.isArray(coverage) || coverage.length !== selected.length || new Set(coverage.map(c => c.target)).size !== selected.length) throw new Error("Every selected target needs exactly one coverage claim");
  for (const claim of coverage) {
    const declaredCases = cases.filter(c=>c.targets.includes(claim.target)).map(c=>c.id).sort();
    if (JSON.stringify([...claim.case_ids].sort()) !== JSON.stringify(declaredCases)) throw new Error("Coverage must retain every declared case targeting that requirement");
    if (!selected.includes(claim.target) || !claim.obligations?.length || claim.obligations.some(o => !o.trim()) || !claim.rationale?.trim() || !claim.case_ids?.length || new Set(claim.case_ids).size !== claim.case_ids.length || claim.case_ids.some(id => !cases.some(c => c.id === id && c.targets.includes(claim.target)))) throw new Error("Coverage must name its obligations and the cases addressing that exact target");
  }
  const requiredInterfaces = new Set(context.requirements.filter(r => selected.includes(r.revision_id)).flatMap(r => r.links.filter(l => l.type === "uses-interface").map(l => l.target)));
  const linkedInterfaces = targets(activity, "uses-interface");
  if (linkedInterfaces.length !== requiredInterfaces.size || linkedInterfaces.some(id => !requiredInterfaces.has(id))) throw new Error("Activity must select the exact necessary interfaces of its verified targets");
  if (!/^[a-f0-9]{40}$/.test(String(p.source_commit)) || !Array.isArray(p.verification_command) || !p.verification_command.length || !p.method || !p.results_path) throw new Error("Activity requires a method and an exact independently committed executable verifier");
}
/** An activity may keep an earlier revision of its action's requirement set as authoring subject
 * while every verified target, and every interface it uses, stays selected unchanged. */
export function authoringSubjectDiagnostic(state: State, activity: DatumEnvelope, subject: DatumEnvelope): string | undefined {
  const authored = state.data.find(d => d.revision_id === activity.payload.authoring_subject);
  if (authored?.revision_id === subject.revision_id) return undefined;
  const differs = "Activity authoring subject differs from its exact action context";
  if (!authored || authored.type !== requirementTraceBinding(state.pkg)?.type || authored.type !== subject.type || authored.id !== subject.id || authored.revision >= subject.revision) return differs;
  const current = selectedTargets(state, subject), selected = new Set(current.map(d => d.revision_id));
  const interfaces = current.flatMap(d => effectiveInterfaces(state.data, subject, d)).map(id => exact(state.data, id));
  const stale = (what: string) => `${differs}: '${authored.revision_id}' is an earlier revision of '${subject.revision_id}', but ${what} is not selected unchanged there`;
  for (const target of targets(activity, "verifies")) {
    if (!selected.has(target)) return stale(`verified target '${target}'`);
    for (const used of effectiveInterfaces(state.data, authored, exact(state.data, target))) {
      const id = exact(state.data, used).id;
      if (interfaces.some(i => i.id === id && i.revision_id !== used)) return stale(`interface '${used}' of verified target '${target}'`);
    }
  }
  return undefined;
}
export function selectedActivities(state: State, product: DatumEnvelope) {
  const b = binding(state), ids = targets(product, "verification");
  if (new Set(ids).size !== ids.length) throw new Error("Select each verification activity once");
  return ids.map(id => {const d = exact(state.data, id); if (d.type !== b.type) throw new Error("Product verification selection must name exact activity revisions"); return d;});
}
export function independentExecutionBinding(state: State, product: DatumEnvelope, activityId: string, operation: string): VerificationBinding {
  const b = binding(state);
  if (![b.implementation_type, b.prototype_type].includes(product.type)) throw new Error("Execution subject must be an exact product implementation or prototype");
  const activity = selectedActivities(state, product).find(a => a.revision_id === activityId);
  if (!activity) throw new Error("Execution activity must belong to the product's exact verification selection");
  validateVerificationActivity(state, activity);
  const exploratory = product.type === b.prototype_type;
  const selection = targets(product, exploratory ? "explores" : "implements");
  if (selection.length !== 1) throw new Error("Product requires one exact requirements or criterion selection");
  const allowed = new Set(selectedTargets(state, exact(state.data, selection[0]!)).map(d => d.revision_id));
  if (targets(activity, "verifies").some(id => !allowed.has(id))) throw new Error("Selected activity targets differ from the product's exact intent");
  const p = activity.payload;
  if (path.resolve(String(p.repository_path)) === path.resolve(String(product.payload.repository_path))) throw new Error("Independent verification requires a separate verifier repository");
  return {operation, package: state.package, inputs: [{name: exploratory ? "trial" : "implementation", revisions: [product.revision_id]}, {name: exploratory ? "experiment" : "requirements", revisions: selection}, {name: "activity", revisions: [activity.revision_id]}], repositoryPath: String(product.payload.repository_path), sourceCommit: String(product.payload.source_commit), image: String(p.verification_image), ...(product.payload.acceptance_scope === "partial" ? {formalFiles: product.payload.formal_files as string[]} : {}), independentVerification: {activityRevision: activity.revision_id, repositoryPath: String(p.repository_path), sourceCommit: String(p.source_commit), scriptPath: String(p.verification_script), command: p.verification_command as string[], caseIds: (p.cases as VerificationCase[]).map(c => c.id), resultsPath: String(p.results_path)}};
}
export function currentVerificationResults(state: State, product: string, activity: string) {
  const b = binding(state);
  const matching = state.data.filter(d => d.type === b.result_type && targets(d, "executes").includes(product) && targets(d, "evaluates").includes(activity));
  const superseded = new Set(matching.flatMap(d => targets(d, "supersedes")));
  return matching.filter(d => !superseded.has(d.revision_id));
}
/** Coverage and execution are independent dimensions. Only exact selected evidence contributes. */
export function verificationStatus(state: State, subjectId: string) {
  const b = binding(state), trace = requirementTraceBinding(state.pkg), subject = exact(state.data, subjectId);
  const product = [b.implementation_type, b.prototype_type].includes(subject.type) ? subject : undefined;
  const selection = product ? exact(state.data, targets(product, product.type === b.prototype_type ? "explores" : "implements")[0] ?? "") : subject;
  const requirements = selectedTargets(state, selection);
  const activities = product ? selectedActivities(state, product) : [];
  // Index reviews and result history once; each keeps lifecycle data order.
  const byRevision = new Map(state.data.map(d => [d.revision_id, d]));
  const reviewsOf = new Map<string, DatumEnvelope[]>(), historyOf = new Map<string, DatumEnvelope[]>();
  const add = (index: Map<string, DatumEnvelope[]>, key: string, d: DatumEnvelope) => index.set(key, [...index.get(key) ?? [], d]);
  for (const d of state.data) {
    if (d.type === b.review_type) for (const id of new Set(targets(d, "reviews"))) add(reviewsOf, id, d);
    if (d.type === b.result_type) for (const id of new Set(targets(d, "evaluates").flatMap(id => byRevision.get(id)?.id ?? []))) add(historyOf, id, d);
  }
  const evidence = new Map(activities.map(activity => {
    const reviews = reviewsOf.get(activity.revision_id) ?? [];
    return [activity.revision_id, {reviews, current: currentVerificationResults(state, product!.revision_id, activity.revision_id), history: historyOf.get(activity.id) ?? []}];
  }));
  const rows = requirements.map(requirement => {
    const claims = activities.flatMap(activity => {
      const claim = (activity.payload.coverage as CoverageClaim[]).find(c => c.target === requirement.revision_id);
      if (!claim) return [];
      const {reviews, current, history} = evidence.get(activity.revision_id)!;
      const adequacy = reviews.some(r => r.payload.outcome === "fail") ? "rejected" : reviews.some(r => r.payload.outcome === "pass") ? "adequate" : "awaiting-review";
      const result = current.length === 1 ? current[0] : undefined;
      const cases = claim.case_ids.map(id => {
        const actual = (result?.payload.case_results as any[] | undefined)?.find(c => c.case_id === id);
        return {id, outcome: actual?.outcome ?? "not-run", actualResults: actual?.actual_results ?? [], evidenceRefs: actual?.evidence_refs ?? []};
      });
      const currentness = !result && history.length ? "stale" : "current";
      const historicalObservation = result?.payload.historical_observation;
      return [{activity: activity.revision_id, method: activity.payload.method, rationale: claim.rationale, obligations: claim.obligations, adequacy, reviews: reviews.map(r => r.revision_id), cases, result: result?.revision_id ?? null, resultOutcome: current.length > 1 ? "error" : result?.payload.outcome ?? "not-run", currentness, ...(historicalObservation ? {observation: "historical", historicalObservation} : {}), reason: historicalObservation ? "Historical passing observation applied to this selection; current review judges applicability and freshness" : currentness === "stale" ? "Historical results do not bind this exact product and activity revision" : result ? `Captured execution ${String(result.payload.outcome)}` : "No execution result is selected", historicalResults: history.map(r => r.revision_id)}];
    });
    const outcomes = claims.flatMap(c => c.cases.map(r => r.outcome));
    const formal = requirement.type === b.requirement_type;
    const collectiveReviews = product ? state.data.filter(d=>d.type===b.review_type && targets(d,"reviews").includes(product.revision_id)) : [];
    const collective = collectiveReviews.some(r=>r.payload.outcome==="fail") ? "rejected" : collectiveReviews.some(r=>r.payload.outcome==="pass" && (r.payload.coverage_assessments as any[] | undefined)?.some(a=>a.target===requirement.revision_id && a.disposition==="adequate")) ? "adequate" : "awaiting-coverage-review";
    const coverage = !claims.length ? "missing" : claims.some(c => c.adequacy === "rejected") ? "rejected" : claims.every(c => c.adequacy === "adequate") ? "adequate" : "awaiting-review";
    const execution = outcomes.includes("fail") ? "fail" : claims.some(c => c.resultOutcome === "error") || outcomes.includes("error") ? "error" : outcomes.includes("skipped") ? "skipped" : !outcomes.length || outcomes.includes("not-run") ? "not-run" : "pass";
    const currentness = claims.some(c => c.currentness === "stale") ? "stale" : "current";
    const overall = coverage === "missing" ? "uncovered" : execution === "fail" ? "failing" : execution === "error" ? "error" : currentness === "stale" ? "stale" : formal && coverage !== "adequate" ? coverage : execution !== "pass" ? execution : formal && collective !== "adequate" ? collective : formal ? "verified" : "observed-pass";
    const nextAction = overall === "uncovered" ? "Select activities covering this requirement" : overall === "awaiting-review" ? "Review the selected activity" : overall === "awaiting-coverage-review" ? "Review collective requirement coverage with the implementation" : ["stale","not-run"].includes(overall) ? "Execute the selected activity against this exact product" : ["failing","error","skipped","rejected"].includes(overall) ? "Inspect captured observations and correct the product, verification or requirement" : "Coverage is current for this exact selection";
    return {requirement: requirement.revision_id, nextAction, title: requirement.payload.title, coverage, collectiveCoverage: formal ? collective : "experimental", execution, currentness, overall, activities: claims};
  });
  return {contract: "mdlm-verification-status@1", subject: subjectId, selection: selection.revision_id, ...(!product ? {instruction:"Select an exact product revision to assess its activity selection and execution evidence",products:state.data.filter(d=>[b.implementation_type,b.prototype_type].includes(d.type) && d.links.some(l=>["implements","explores"].includes(l.type)&&l.target===selection.revision_id)).map(d=>d.revision_id)} : {}), ...(product ? {sourceCommit: product.payload.source_commit} : {}), complete: rows.length > 0 && rows.every(r => ["verified", "observed-pass"].includes(r.overall)), requirements: rows};
}
