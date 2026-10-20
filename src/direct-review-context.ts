import { promises as fs } from "node:fs";
import { isUtf8 } from "node:buffer";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify, isDeepStrictEqual } from "node:util";
import { resolveType, type DatumEnvelope } from "./index.js";
import type { DirectContext, DirectTransaction, SourceAssessmentTargets } from "./direct-contract.js";
import { readImplementationSource, retargetedBindings, requirementTraceBinding, selectedRequirementGraph, type RequirementTraceBinding } from "./requirement-trace.js";
import { assessRequirements, changeImpact } from "./change-assessment.js";
import { compareImplementationScopes } from "./requirement-trace-inspection.js";
import { readVerificationReceiptBlob, validateVerificationReceipt, verificationRef } from "./verification-receipt.js";
import { repositoryGitEnvironment } from "./git-environment.js";
import { resolvePrompt } from "./direct-prompt.js";
import { authorablePayloadSchema, sourceAssessmentTargets } from "./direct-guidance.js";

import { independentBinding, independentExecutionBinding, verificationStatus, type VerificationCase } from "./independent-verification.js";

import { validateHistoricalResult, type HistoricalObservation } from "./verification-applicability.js";

const exec = promisify(execFile);
export interface DirectReviewContext {
  contract: "mdlm-direct-review-context@1";
  package: DirectContext["package"];
  snapshot: string;
  action: DirectContext["action"];
  subject?: string;
  inputs: DirectContext["inputs"];
  prompt: unknown;
  payloadSchemas: Record<string, unknown>;
  sourceAssessmentTargets?: SourceAssessmentTargets | undefined;
  records: DatumEnvelope[];
  requirementGraphs: {selection: string; assessment: ReturnType<typeof assessRequirements>; groups: DatumEnvelope[]; requirements: (DatumEnvelope & {leaf: boolean})[];
    /** Unchanged requirements whose interface binding this set retargets to a newer agreement revision. */
    interfaceRetargets?: {requirement: string; bound: string; selected: string}[]}[];
  sourceScopes: {implementation: string; scopes: DatumEnvelope[]; changes: unknown; comparison: unknown; acceptedBaseline?: {
    requirements: DatumEnvelope; change: DatumEnvelope; acceptance: DatumEnvelope; implementation: DatumEnvelope;
    source: DirectReviewContext["sources"][number]; scopes: DatumEnvelope[]; comparison: ReturnType<typeof compareImplementationScopes>;
  }}[];
  priorNormativeContext?: {selection: string; change: DatumEnvelope; approvals: DatumEnvelope[]; requirements: DatumEnvelope[]};
  prospectiveChange?: unknown;
  sources: {implementation: string; repositoryPath: string; sourceCommit: string; acceptanceScope: "whole-product" | "partial"; files: {path: string; role: string; mode: string; blob: string; content: string; formal: boolean}[]}[];
  verifierSources?: {activity: string; sourceCommit: string; files: {path: string; blob: string; content: string; encoding?: "base64"}[]}[];
  verificationCoverage?: unknown;
  verificationCoverageChanges?: {
    advisory: string;
    predecessor: VerificationActivityReference;
    current: VerificationActivityReference;
    removedCases: {caseId: string; oldTargets: string[]; retiredTargets: string[];
      survivingTargets: {previousRequirement: string; currentRequirement: string; currentCaseIds: string[]}[]}[];
  };
  verificationReceipts: {result: string; implementation: string; requirements: string; locator: string; execution: string; binding: "validated"; historicalObservation?: HistoricalObservation; receipt: Awaited<ReturnType<typeof readVerificationReceiptBlob>>["receipt"]}[];
  lineage?: {predecessors: DatumEnvelope[]; answers: string[]; changes: DatumEnvelope[]; decisions: DatumEnvelope[];
    predecessorGraph?: {selection: string; groups: DatumEnvelope[]; requirements: (DatumEnvelope & {leaf: boolean})[]; diagnostics: unknown[]}};
}

export interface VerificationActivityReference {activity: string; authoringSubject: string; repositoryPath: string; sourceCommit: string}

/** Case IDs identify comparisons for judgment; they cannot establish preserved stimuli or assertions. */
function verificationCoverageChanges(context: DirectContext, result: DirectReviewContext): DirectReviewContext["verificationCoverageChanges"] {
  const activityType = independentBinding(context.pkg)?.type;
  const current = context.data.find(d => d.revision_id === context.subject && d.type === activityType);
  const previous = result.lineage?.predecessors.at(-1);
  const graph = result.requirementGraphs.find(g => g.selection === current?.payload.authoring_subject);
  if (!current || !previous || !graph) return undefined;
  const byRevision = new Map(context.data.map(d => [d.revision_id, d]));
  const selected = new Map(graph.requirements.map(d => [d.id, d.revision_id]));
  const cases = current.payload.cases as VerificationCase[];
  const currentIds = new Set(cases.map(c => c.id));
  const removedCases = (previous.payload.cases as VerificationCase[]).filter(c => !currentIds.has(c.id)).map(c => {
    const oldTargets = [...c.targets].sort();
    const survivingTargets = oldTargets.flatMap(previousRequirement => {
      const currentRequirement = selected.get(byRevision.get(previousRequirement)!.id);
      return currentRequirement ? [{previousRequirement, currentRequirement, currentCaseIds: cases.filter(c => c.targets.includes(currentRequirement)).map(c => c.id).sort()}] : [];
    });
    return {caseId: c.id, oldTargets, retiredTargets: oldTargets.filter(id => !survivingTargets.some(t => t.previousRequirement === id)), survivingTargets};
  }).filter(c => c.survivingTargets.length).sort((a, b) => a.caseId.localeCompare(b.caseId));
  const reference = (d: DatumEnvelope): VerificationActivityReference => ({activity: d.revision_id, authoringSubject: String(d.payload.authoring_subject), repositoryPath: String(d.payload.repository_path), sourceCommit: String(d.payload.source_commit)});
  return {
    advisory: "Changed coverage for review, not proof of missing coverage or adequacy. Removed case IDs may be renamed, merged or replaced; coverage may move to another selected activity. An empty local case list does not establish missing coverage. An empty comparison does not establish that assertions or stimuli were preserved beneath unchanged case IDs; changes within those cases still need semantic review.",
    predecessor: reference(previous), current: reference(current), removedCases,
  };
}

async function reviewSource(implementation: DatumEnvelope): Promise<DirectReviewContext["sources"][number]> {
  const source = await readImplementationSource(implementation);
  if (source.diagnostics.length) throw new Error(JSON.stringify(source.diagnostics));
  const files = source.entries.map(entry => {
    if (!["100644", "100755"].includes(entry.mode)) throw new Error(`Unsupported source entry mode for '${entry.path}'`);
    let content: string;
    try { content = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(entry.bytes); if (content.includes("\0")) throw new Error("NUL byte"); }
    catch { throw new Error(`Source '${entry.path}' is not supported UTF-8 text; review context is incomplete`); }
    return {path: entry.path, role: entry.role!, mode: entry.mode, blob: entry.blob, content, formal: implementation.payload.acceptance_scope !== "partial" || (implementation.payload.formal_files as string[]).includes(entry.path)};
  });
  return {implementation: implementation.revision_id, repositoryPath: String(implementation.payload.repository_path), sourceCommit: String(implementation.payload.source_commit), acceptanceScope: implementation.payload.acceptance_scope === "partial" ? "partial" : "whole-product", files};
}

async function acceptedBaseline(data: DatumEnvelope[], trace: RequirementTraceBinding, implementation: DatumEnvelope): Promise<DirectReviewContext["sourceScopes"][number]["acceptedBaseline"]> {
  if (!trace.change_type || !trace.acceptance_type) return undefined;
  const linked = (owner: DatumEnvelope, relation: string, type: string): DatumEnvelope => {
    const links = owner.links.filter(link => link.type === relation);
    const matches = data.filter(datum => datum.revision_id === links[0]?.target);
    if (links.length !== 1 || matches.length !== 1 || matches[0]!.type !== type) throw new Error(`Accepted baseline: '${owner.revision_id}' must bind one available exact '${relation}' ${type} revision`);
    return matches[0]!;
  };
  const requirements = linked(implementation, "implements", trace.type);
  if (!requirements.links.some(link => link.type === "changes-under")) return undefined;
  const change = linked(requirements, "changes-under", trace.change_type);
  const acceptance = linked(change, "baseline", trace.acceptance_type);
  if (acceptance.payload.decision !== "accept") throw new Error(`Accepted baseline: '${acceptance.revision_id}' is not an acceptance`);
  const previous = linked(acceptance, "accepts", trace.implementation_type);
  return {requirements, change, acceptance, implementation: previous, source: await reviewSource(previous),
    scopes: data.filter(datum => datum.type === trace.scope_type && datum.links.some(link => link.type === "belongs-to" && link.target === previous.revision_id)),
    comparison: compareImplementationScopes(data, trace, previous.revision_id, implementation.revision_id)};
}

/** Directly changed obligations only; historical exact approvals survive later change amendments. */
function priorNormativeContext(data: DatumEnvelope[], trace: RequirementTraceBinding, set: DatumEnvelope): DirectReviewContext["priorNormativeContext"] {
  const links = set.links.filter(link => link.type === "changes-under");
  if (!links.length || !trace.change_type || !trace.review_type) return undefined;
  const exact = (target: string, type: string): DatumEnvelope => {
    const matches = data.filter(datum => datum.revision_id === target);
    if (matches.length !== 1 || matches[0]!.type !== type) throw new Error(`Prior normative context: '${target}' must name one available exact ${type} revision`);
    return matches[0]!;
  };
  if (links.length !== 1) throw new Error(`Prior normative context: '${set.revision_id}' must bind one exact changes-under revision`);
  const change = exact(links[0]!.target, trace.change_type);
  // This is the native change-approval rule, not a latest-revision selection.
  // Stakeholder authority is enforced when the approval is published.
  const approvals = data.filter(datum => datum.type === trace.review_type && datum.payload.outcome === "pass"
    && datum.links.some(link => link.type === "reviews" && link.target === change.revision_id));
  if (!approvals.length) throw new Error(`Prior normative context: '${change.revision_id}' has no exact passing approval`);
  const requirements = change.links.filter(link => link.type === "changes").map(link => exact(link.target, trace.requirement_type));
  return {selection: set.revision_id, change, approvals, requirements};
}

/** Exact earlier revisions of a reviewed subject and the recorded judgments bound to them or to its change. */
function reviewLineage(context: DirectContext, trace: RequirementTraceBinding | undefined): DirectReviewContext["lineage"] {
  const {data} = context, subject = data.find(datum => datum.revision_id === context.subject);
  if (context.action.capability !== "review" || !subject) return undefined;
  const exact = (relation: string) => subject.links.filter(link => link.type === relation).map(link => {
    const matches = data.filter(datum => datum.revision_id === link.target);
    if (matches.length !== 1) throw new Error(`Review lineage: '${subject.revision_id}' ${relation} '${link.target}' is unavailable`);
    return matches[0]!;
  });
  const predecessors = data.filter(datum => datum.id === subject.id && datum.revision < subject.revision).sort((a, b) => a.revision - b.revision);
  const answered = exact("corrects"), changes = exact("changes-under");
  if (!predecessors.length && !answered.length && !changes.length) return undefined;
  const anchors = new Set([...predecessors, ...changes].map(datum => datum.revision_id));
  const decisions = data.filter(datum => answered.includes(datum) || ((context.action.types.includes(datum.type) || datum.type === trace?.acceptance_type) && datum.links.some(link => anchors.has(link.target))));
  const previous = predecessors.at(-1);
  let predecessorGraph: NonNullable<DirectReviewContext["lineage"]>["predecessorGraph"];
  if (trace && previous?.type === trace.type) {
    const graph = selectedRequirementGraph(data, previous, trace);
    predecessorGraph = {selection: previous.revision_id, groups: graph.groups, requirements: graph.requirements.map(datum => ({...datum, leaf: graph.leaves.has(datum.revision_id)})), diagnostics: graph.diagnostics};
  }
  return {predecessors, answers: answered.map(datum => datum.revision_id), changes, decisions, ...(predecessorGraph ? {predecessorGraph} : {})};
}

/** The caller authenticates context freshness before registration/publication. */
export async function buildDirectReviewContext(context: DirectContext): Promise<DirectReviewContext> {
  const {root, pkg, data} = context;
  const prompt = await resolvePrompt(pkg, context.action.prompt_ref);
  if (!prompt.prompt || prompt.diagnostics.length) throw new Error("The exact review prompt could not be resolved");
  const payloadSchemas: Record<string, unknown> = {};
  for (const type of context.action.types) {
    const resolved = resolveType(pkg, type);
    if (!resolved.ok) throw new Error(`Review output type '${type}' could not be resolved`);
    payloadSchemas[type] = authorablePayloadSchema(resolved.type);
  }
  const selectedIds = new Set([...Object.values(context.inputs).flat(), ...(context.subject ? [context.subject] : [])]);
  for (const id of selectedIds) if (!data.some(datum => datum.revision_id === id)) throw new Error(`Review input '${id}' is unavailable`);
  const selected = data.filter(datum => selectedIds.has(datum.revision_id));
  const result: DirectReviewContext = {contract: "mdlm-direct-review-context@1", package: context.package, snapshot: context.snapshot, action: context.action, ...(context.subject ? {subject: context.subject} : {}), inputs: context.inputs, prompt: prompt.prompt, payloadSchemas, sourceAssessmentTargets: sourceAssessmentTargets(context), records: selected, requirementGraphs: [], sourceScopes: [], sources: [], verificationReceipts: []};
  const independent = independentBinding(pkg);
  if (independent) {
    result.verifierSources = [];
    // A blob ID names exact bytes, so a file shared across verifier commits is read and held once.
    const blobs = new Map<string, {content: string; encoding?: "base64"}>();
    const activities = data.filter(d => d.type === independent.type && (selectedIds.has(d.revision_id) || selected.some(s => s.links.some(l => l.type === "verification" && l.target === d.revision_id))));
    for (const activity of activities) {
      const cwd = String(activity.payload.repository_path), commit = String(activity.payload.source_commit);
      if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Verifier source needs an exact commit");
      const listing = await exec("git", ["ls-tree", "-rz", "--full-tree", commit], {cwd, maxBuffer:64*1024*1024});
      const files = [];
      for (const line of listing.stdout.split("\0").filter(Boolean)) {
        const match = /^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(line);
        if (!match) throw new Error("Verifier review supports regular committed files only");
        let source = blobs.get(match[2]!);
        if (!source) {
          const bytes = await exec("git", ["cat-file", "blob", match[2]!], {cwd, encoding:"buffer", maxBuffer:64*1024*1024});
          source = isUtf8(bytes.stdout) && !bytes.stdout.includes(0)
            ? {content: bytes.stdout.toString("utf8")}
            : {content: bytes.stdout.toString("base64"), encoding: "base64" as const};
          blobs.set(match[2]!, source);
        }
        files.push({path:match[3]!,blob:match[2]!,...source});
      }
      result.verifierSources.push({activity:activity.revision_id,sourceCommit:commit,files});
      // Activity source review selects only its declared intent and interfaces, never product source.
      for (const link of activity.links) if (["verifies","uses-interface"].includes(link.type) && !result.records.some(d=>d.revision_id===link.target)) result.records.push(data.find(d=>d.revision_id===link.target)!);
    }
    const product = selected.find(d=>d.type===independent.implementation_type);
    if (product) result.verificationCoverage = verificationStatus(context, product.revision_id);
  }
  const trace = requirementTraceBinding(pkg);
  // Lineage is added last so existing exact-context failures keep precedence.
  const withLineage = () => {
    const lineage = reviewLineage(context, trace);
    if (lineage) result.lineage = lineage;
    const changes = verificationCoverageChanges(context, result);
    if (changes) result.verificationCoverageChanges = changes;
    return result;
  };
  if (!trace) return withLineage();
  const changes = selected.filter(datum => datum.type === trace.change_type);
  if (changes.length === 1) {
    const change = changes[0]!, baseline = data.find(datum => datum.revision_id === change.links.find(link => link.type === "baseline")?.target);
    const impact = changeImpact(data, trace, change);
    result.prospectiveChange = {...impact, change: change.revision_id, baseline: baseline?.revision_id, request: change.payload, scopes: data.filter(datum => impact.sourceScopes.includes(datum.revision_id))};
    for (const link of baseline?.links ?? []) if (link.type === "confirms") selectedIds.add(link.target);
  }
  const implementations = selected.filter(datum => datum.type === trace.implementation_type);
  const reviewedActivity = independent && context.action.capability === "review" && selected.find(datum => datum.type === independent.type && datum.revision_id === context.subject);
  const authoringSubject = independent && selected.find(datum => datum.type === independent.type && datum.revision_id === context.subject)?.payload.authoring_subject;
  const sets = data.filter(datum => datum.type === trace.type && (selectedIds.has(datum.revision_id) || datum.revision_id === authoringSubject || implementations.some(implementation => implementation.links.some(link => link.type === "implements" && link.target === datum.revision_id))));
  for (const set of sets) {
    const graph = selectedRequirementGraph(data, set, trace);
    if (graph.diagnostics.length) throw new Error(`Review requirement graph '${set.revision_id}' is invalid: ${JSON.stringify(graph.diagnostics)}`);
    const interfaceRetargets = graph.requirements.flatMap(requirement => retargetedBindings(data, set, requirement).map(r => ({requirement: requirement.revision_id, ...r})));
    result.requirementGraphs.push({selection: set.revision_id, assessment: assessRequirements(data, trace, set), groups: graph.groups, requirements: graph.requirements.map(datum => ({...datum, leaf: graph.leaves.has(datum.revision_id)})), ...(interfaceRetargets.length ? {interfaceRetargets} : {})});
    // Method review starts from intent; derivation origins may contain prior product observations.
    // Explicit inputs remain in records. Other review roles retain their direct origins.
    if (reviewedActivity) continue;
    // Origins explain derivation. Include only direct exact links, never their source or evidence graph.
    for (const requirement of graph.requirements) {
      for (const link of requirement.links) {
        if (link.type !== "informed-by" || result.records.some(datum => datum.revision_id === link.target)) continue;
        const origin = data.find(datum => datum.revision_id === link.target);
        if (!origin) throw new Error(`Review requirement origin '${link.target}' is unavailable`);
        result.records.push(origin);
      }
    }
  }
  for (const implementation of implementations) {
    const baseline = (implementation.payload.source_changes as {baseline_implementation?: unknown} | undefined)?.baseline_implementation;
    const accepted = context.action.capability === "review" && context.subject === implementation.revision_id ? await acceptedBaseline(data, trace, implementation) : undefined;
    result.sourceScopes.push({implementation: implementation.revision_id, scopes: data.filter(datum => datum.type === trace.scope_type && datum.links.some(link => link.type === "belongs-to" && link.target === implementation.revision_id)), changes: implementation.payload.source_changes ?? null, comparison: typeof baseline === "string" ? compareImplementationScopes(data, trace, baseline, implementation.revision_id) : null, ...(accepted ? {acceptedBaseline: accepted} : {})});
    result.sources.push(await reviewSource(implementation));
  }
  const results = selected.filter(datum => datum.type === trace.result_type);
  for (const datum of results) {
    const locator = typeof datum.payload.receipt === "string" && /^git-blob:([a-f0-9]{40})$/.exec(datum.payload.receipt);
    if (!locator) throw new Error(`Result '${datum.revision_id}' has no exact verification receipt`);
    const saved = await readVerificationReceiptBlob(root, locator[1]!);
    const transactions: DirectTransaction[] = [];
    for (const id of await fs.readdir(path.join(root, ".lifecycle/data/.transactions"))) {
      const transaction = JSON.parse(await fs.readFile(path.join(root, ".lifecycle/data/.transactions", id, "execution.json"), "utf8")) as DirectTransaction;
      if (transaction.contract === "mdlm-direct-transaction@1" && transaction.outputs.some(output => isDeepStrictEqual(output, datum))) transactions.push(transaction);
    }
    if (transactions.length !== 1) throw new Error(`Result '${datum.revision_id}' must have one authenticated direct publication`);
    const transaction = transactions[0]!;
    const implementation = implementations.find(value => datum.links.some(link => link.target === value.revision_id));
    const requirements = sets.find(value => datum.links.some(link => link.target === value.revision_id));
    if (!implementation || !requirements || !isDeepStrictEqual(transaction.package, context.package)) throw new Error("Verification result does not bind the selected implementation, requirements and package");
    if (datum.payload.historical_observation !== undefined) {
      const historical = await validateHistoricalResult(context, datum);
      for (const origin of [historical.original, historical.prior]) if (!result.records.some(d => d.revision_id === origin.revision_id)) result.records.push(origin);
      result.verificationReceipts.push({result: datum.revision_id, implementation: implementation.revision_id, requirements: requirements.revision_id, locator: datum.payload.receipt as string, execution: transaction.id, binding: "validated", historicalObservation: historical.stored, receipt: historical.verified.saved.receipt});
      continue;
    }
    const binding = saved.receipt.binding;
    if (!binding.operation || !/^[a-zA-Z0-9-]{1,80}$/.test(binding.operation) || !Number.isInteger(saved.receipt.attempt) || saved.receipt.attempt < 1) throw new Error("Review requires a direct execution receipt");
    const independentExpected = independent && binding.independentVerification ? independentExecutionBinding(context, implementation, binding.independentVerification.activityRevision, binding.operation) : undefined;
    const inputs = independentExpected?.inputs ?? [{name: "implementation", revisions: [implementation.revision_id]}, {name: "requirements", revisions: [requirements.revision_id]}];
    if (!isDeepStrictEqual(binding.inputs, inputs)) throw new Error("Receipt inputs differ from the selected implementation and requirements");
    const transactionIds = Object.values(transaction.inputs).flat();
    if (![implementation.revision_id, requirements.revision_id].every(id => transactionIds.includes(id) || transaction.subject === id)) throw new Error("Result transaction does not bind its exact implementation and requirements");
    const {formalFiles: _recordedSelection, ...baseBinding} = binding;
    const expected = independentExpected ?? {...baseBinding, ...(implementation.payload.acceptance_scope === "partial" ? {formalFiles: implementation.payload.formal_files as string[]} : {}), inputs, package: context.package, repositoryPath: implementation.payload.repository_path as string, sourceCommit: implementation.payload.source_commit as string, image: implementation.payload.verification_image as string, command: implementation.payload.verification_command as string[], scriptPath: implementation.payload.verification_script as string};
    const verified = await validateVerificationReceipt(expected, saved);
    const registered = (await exec("git", ["-C", root, "rev-parse", "--verify", `${verificationRef(binding)}/attempt-${saved.receipt.attempt}-receipt`], {env: repositoryGitEnvironment()})).stdout.trim();
    if (registered !== saved.oid || verified.outcome !== datum.payload.outcome) throw new Error("Result conflicts with its registered execution receipt");
    result.verificationReceipts.push({result: datum.revision_id, implementation: implementation.revision_id, requirements: requirements.revision_id, locator: datum.payload.receipt as string, execution: transaction.id, binding: "validated", receipt: saved.receipt});
  }
  if (context.action.capability === "review") {
    const product = implementations.find(datum => datum.revision_id === context.subject);
    const set = sets.find(datum => reviewedActivity ? datum.revision_id === authoringSubject
      : product?.links.some(link => link.type === "implements" && link.target === datum.revision_id));
    if (set) {
      const prior = priorNormativeContext(data, trace, set);
      if (prior) result.priorNormativeContext = prior;
    }
  }
  return withLineage();
}
