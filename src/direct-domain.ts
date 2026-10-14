import { createHash } from "node:crypto";
import type { DatumEnvelope, ProcessDiagnostic } from "./index.js";
import type { DirectFinalizationContext, DirectFinalizationResult } from "./direct-contract.js";
import { assessRequirements, approvedChanges, deriveSourceDispositionCandidates, reviewedRequirementSet, validateChangeDatum } from "./change-assessment.js";
import { requirementTraceBinding, latestRequirements, selectedRequirementGraph, deriveImplementationScopes, implementationSourceChanges, type RequirementTraceBinding, type SelectedRequirementGraph } from "./requirement-trace.js";

import { independentBinding, validateVerificationActivity, selectedActivities, verificationStatus, currentVerificationResults, independentExecutionBinding } from "./independent-verification.js";

function reject(diagnostics: ProcessDiagnostic[]): never {
  throw new Error(diagnostics.map(d => `${d.code}: ${d.message}`).join("; "));
}

/** Elaboration adds exactly one group of new software children under an existing requirement
 * and keeps every previously selected requirement and group revision unchanged. */
function stagedElaborationDiagnostics(data: DatumEnvelope[], trace: RequirementTraceBinding, previous: DatumEnvelope | undefined, graph: SelectedRequirementGraph): ProcessDiagnostic[] {
  if (!previous) return [{code: "staged-elaboration-predecessor", message: "Elaboration revises an existing requirement set"}];
  const before = selectedRequirementGraph(data, previous, trace);
  const kept = (old: DatumEnvelope[], now: DatumEnvelope[]) => old.every(o => now.some(n => n.revision_id === o.revision_id));
  if (!kept(before.requirements, graph.requirements) || !kept(before.groups, graph.groups)) return [{code: "staged-elaboration-preserve", message: "Elaboration may not revise or remove existing requirements or groups; use the correction or stakeholder refinement action"}];
  const added = graph.requirements.filter(r => !before.requirements.some(o => o.revision_id === r.revision_id));
  const groups = graph.groups.filter(g => !before.groups.some(o => o.revision_id === g.revision_id));
  const group = groups[0];
  const parent = group?.links.find(l => l.type === "parent")?.target;
  const children = group?.links.filter(l => l.type === "child").map(l => l.target).sort() ?? [];
  if (groups.length !== 1 || !before.requirements.some(r => r.revision_id === parent) || JSON.stringify(children) !== JSON.stringify(added.map(r => r.revision_id).sort())) return [{code: "staged-elaboration-group", message: "Elaboration adds exactly one decomposition group whose parent is an existing requirement and whose children are exactly the added requirements"}];
  if (added.some(r => r.payload.kind !== "software")) return [{code: "staged-elaboration-root", message: "Elaboration adds software requirements only; new stakeholder roots need stakeholder refinement"}];
  return [];
}

/** Derive graph membership and committed source attribution within the caller's atomic batch. */
export async function finalizeDirectDomain(context: DirectFinalizationContext): Promise<DirectFinalizationResult> {
  const outputData = context.outputs.map(datum => ({datum: structuredClone(datum)}));
  const managedOutputs: DatumEnvelope[] = [];
  const trace = requirementTraceBinding(context.pkg);
  if (trace) {
    if (context.action.capability === "requirements" && outputData.filter(o => o.datum.type === trace.type).length !== 1) {
      reject([{code: "trace-requirement-batch", message: "Requirement authoring must publish exactly one requirement graph with its authored requirements and groups"}]);
    }
    if (context.action.capability === "implementation" && outputData.filter(o => o.datum.type === trace.implementation_type).length !== 1) {
      reject([{code: "trace-implementation-batch", message: "Implementation authoring must publish exactly one implementation; source scopes are generated"}]);
    }
    if (trace.change_type) {
      const existing = context.data;
      const inputs = new Set([...(context.subject ? [context.subject] : []), ...Object.values(context.inputs).flat()]);
      for (const output of outputData.filter(o => o.datum.type === trace.change_type)) {
        const subject = existing.find(d => inputs.has(d.revision_id) && d.type === trace.type);
        const previous = existing.find(d => inputs.has(d.revision_id) && d.type === trace.change_type);
        const baseline = previous?.links.find(l => l.type === "baseline")?.target ?? existing.find(d => d.type === trace.acceptance_type && d.payload.decision === "accept" && d.links.some(l => l.type === "confirms" && l.target === subject?.revision_id))?.revision_id;
        if (!baseline) reject([{code: "change-baseline-required", message: "A change request needs an exact accepted baseline"}]);
        if (output.datum.links.some(l => l.type === "baseline" && l.target !== baseline)) reject([{code: "change-baseline-mismatch", message: "Change baseline differs from the exact context"}]);
        if (!output.datum.links.some(l => l.type === "baseline")) output.datum.links.push({type: "baseline", target: baseline});
      }
      const directChange = existing.find(d => inputs.has(d.revision_id) && d.type === trace.change_type);
      const inheritedChange = existing.filter(d => inputs.has(d.revision_id)).sort((a, b) => Number(b.type === trace.type) - Number(a.type === trace.type)).flatMap(d => d.links.filter(l => l.type === "changes-under").map(l => l.target));
      const change = directChange?.revision_id ?? inheritedChange[0];
      if (change && !approvedChanges(existing, trace).some(c => c.revision_id === change) && outputData.some(o => [trace.requirement_type, trace.decomposition_type, trace.type, trace.implementation_type, trace.acceptance_type].includes(o.datum.type))) reject([{code: "change-approval-required", message: "Current change revision needs stakeholder approval before publication"}]);
      if (change) for (const output of outputData.filter(o => [trace.requirement_type, trace.decomposition_type, trace.type, trace.implementation_type, trace.acceptance_type].includes(o.datum.type))) {
        if (output.datum.links.some(l => l.type === "changes-under" && l.target !== change)) reject([{code: "change-authority-mismatch", message: "Output change authority differs from the direct context"}]);
        if (!output.datum.links.some(l => l.type === "changes-under")) output.datum.links.push({type: "changes-under", target: change});
      }
    }
    if (outputData.some((o) => o.datum.type === trace.scope_type)) reject([{code: "trace-generated-output", message: "Source scopes are generated from committed source, never authored"}]);
    const allData = [...context.data, ...outputData.map((o) => o.datum)];
    for (const output of outputData.filter((o) => o.datum.type === trace.type)) {
      if (output.datum.links.some((l) => l.type === "contains")) reject([{code: "trace-generated-selection", message: "The CLI selects the complete requirement graph"}]);
      output.datum.payload.title = "Requirement graph";
      output.datum.payload.publication = "recorded";
      const previousSet = context.data.filter(d => d.type === trace.type && d.id === output.datum.id).sort((a, b) => b.revision - a.revision)[0];
      if (trace.decomposition_type) for (const link of previousSet?.links.filter(l => l.type === "retires") ?? []) if (!output.datum.links.some(l => l.type === link.type && l.target === link.target)) output.datum.links.push(link);
      const retired = new Set(output.datum.links.filter(l => l.type === "retires").map(l => allData.find(d => d.revision_id === l.target)?.id));
      output.datum.links.push(...latestRequirements(allData, trace).filter(d => !trace.decomposition_type || !retired.has(d.id)).map((d) => ({type: "contains", target: d.revision_id})));
      if (trace.decomposition_type) {
        const selected = new Map(latestRequirements(allData, trace).filter(d => !retired.has(d.id)).map(d => [d.id, d]));
        const previousSets = context.data.filter(d => d.type === trace.type && d.id === output.datum.id).sort((a, b) => b.revision - a.revision);
        const previousSet = previousSets[0];
        const previousGroups = previousSet ? selectedRequirementGraph(context.data, previousSet, trace).groups : [];
        const authoredGroups = outputData.filter(o => o.datum.type === trace.decomposition_type);
        const parentId = (group: DatumEnvelope) => allData.find(d => d.revision_id === group.links.find(l => l.type === "parent")?.target)?.id;
        const groups = [...authoredGroups.map(o => o.datum)];
        for (const previous of previousGroups) {
          if (retired.has(parentId(previous)) || groups.some(g => parentId(g) === parentId(previous))) continue;
          const links = previous.links.filter(l => l.type !== "changes-under").map(link => {
            const endpoint = allData.find(d => d.revision_id === link.target);
            return {...link, target: endpoint ? selected.get(endpoint.id)?.revision_id ?? link.target : link.target};
          });
          if (JSON.stringify(links) === JSON.stringify(previous.links.filter(l => l.type !== "changes-under"))) { groups.push(previous); continue; }
          const revision = Math.max(...allData.filter(d => d.id === previous.id).map(d => d.revision)) + 1;
          const datum: DatumEnvelope = {...previous, revision, revision_id: `${previous.id}-r${String(revision).padStart(5, "0")}`, links: [...links, ...output.datum.links.filter(l => l.type === "changes-under")], created_by: {...output.datum.created_by}};
          outputData.push({datum});
          allData.push(datum); groups.push(datum);
          managedOutputs.push(datum);
        }
        for (const group of groups) {
          const prior = previousGroups.find(g => parentId(g) === parentId(group));
          if (prior && group.id !== prior.id) reject([{code: "trace-group-lineage", message: `Revise existing group '${prior.revision_id}' for this parent instead of creating another lineage`}]);
        }
        if (output.datum.links.some(l => l.type === "decomposition")) reject([{code: "trace-generated-selection", message: "The CLI selects decomposition groups"}]);
        output.datum.links.push(...groups.map(d => ({type: "decomposition", target: d.revision_id})));
      }
      const graph = selectedRequirementGraph(allData, output.datum, trace, true);
      if (graph.diagnostics.length) reject(graph.diagnostics);
      if (trace.stagedAction) {
        output.datum.payload.trace_complete = graph.complete;
        const elaboration = context.action.id === trace.stagedAction ? stagedElaborationDiagnostics(context.data, trace, previousSet, graph) : [];
        if (elaboration.length) reject(elaboration);
      }
      managedOutputs.push(output.datum);
    }
    for (const output of [...outputData].filter((o) => o.datum.type === trace.implementation_type)) {
      if ("product_files" in output.datum.payload || "source_inventory" in output.datum.payload || "source_changes" in output.datum.payload) reject([{code: "trace-generated-inventory", message: "The CLI derives product_files and source_inventory from the source commit"}]);
      const generated = await deriveImplementationScopes(output.datum, allData, trace);
      if (generated.diagnostics.length) reject(generated.diagnostics);
      if (trace.decomposition_type && "impact_dispositions" in output.datum.payload) {
        output.datum.payload.impact_dispositions = deriveSourceDispositionCandidates(allData, trace, output.datum, generated.scopes);
      }
      output.datum.payload.product_files = generated.inventory.map((entry) => entry.path);
      output.datum.payload.source_inventory = generated.inventory;
      try {
        output.datum.payload.source_changes = await implementationSourceChanges(output.datum, allData, trace, generated.scopes);
      } catch (error) { reject([{code: "trace-source-diff-unavailable", message: String(error)}]); }
      managedOutputs.push(output.datum);
      for (const scope of generated.scopes) {
        const localId = `scope-${createHash("sha256").update(`${output.datum.revision_id}\0${scope.path}\0${scope.name}`).digest("hex").slice(0, 20)}`;
        const id = `${trace.scope_type}-${createHash("sha256").update(`${context.proposal.operation}\0${localId}`).digest("hex").slice(0, 12).toUpperCase()}`;
        const datum: DatumEnvelope = {
          id, revision: 1, revision_id: `${id}-r00001`, type: trace.scope_type,
          payload: {title: `${scope.path}: ${scope.name}`, publication: "recorded", source_commit: output.datum.payload.source_commit, path: scope.path, blob: scope.blob, name: scope.name, role: scope.role, ranges: scope.ranges, inherited: scope.inherited},
          links: [{type: "belongs-to", target: output.datum.revision_id}, ...scope.links],
          created_by: {...output.datum.created_by}, body: "",
        };
        outputData.push({datum});
        managedOutputs.push(datum);
      }
    }
  }
  if (trace?.decomposition_type) {
    const allData = [...context.data, ...outputData.map(o => o.datum)];
    for (const output of outputData.filter(o => o.datum.type === trace.review_type)) {
      if (output.datum.links.some(l => l.type === "supersedes") && (!context.pkg.kernelCapabilities["review-correction@1"] || context.action.links?.[output.datum.type]?.supersedes !== "failure" || context.action.authority?.kind !== "independent-review" || output.datum.links.filter(l => l.type === "supersedes").map(l => l.target).join() !== context.inputs.failure?.join())) reject([{code: "review-correction-action", message: "Review supersession requires the independently authorized recovery action and its exact failure input"}]);
      if ("scope_amendment_required" in output.datum.payload) reject([{code: "change-derived-review-field", message: "The CLI derives scope amendment work"}]);
      const set = reviewedRequirementSet(allData, trace, output.datum);
      if (output.datum.links.some(l => l.type === "supersedes") && (!set || context.data.some(d => d.id === set.id && d.revision > set.revision) || context.data.some(d => d.type === trace.acceptance_type && d.links.some(l => l.type === "confirms" && l.target === set.revision_id)))) reject([{code: "review-correction-stale", message: "Review correction requires an unaccepted current exact requirement set"}]);
      const assessment = set ? assessRequirements(allData, trace, set) : undefined;
      const allowed = new Set(assessment?.allowedRequirements.map(id => allData.find(d => d.revision_id === id)?.id));
      output.datum.payload.scope_amendment_required = Boolean(assessment?.change && assessment.correction.requirements.some(id => !allowed.has(allData.find(d => d.revision_id === id)?.id)));
      managedOutputs.push(output.datum);
    }
  }
  if (trace) {
    const data = [...context.data, ...outputData.map(output => output.datum)];
    const diagnostics = outputData.flatMap(output => validateChangeDatum(data, trace, output.datum));
    if (diagnostics.length) reject(diagnostics);
  }
  const independent = independentBinding(context.pkg);
  if (independent) {
    const state = {...context, data: [...context.data, ...outputData.map(o => o.datum)]};
    for (const {datum} of outputData) {
      if (datum.type === independent.type) {
        validateVerificationActivity(state, datum);
        const subject = state.data.find(d=>d.revision_id===context.subject);
        if (subject && subject.type !== independent.type && datum.payload.authoring_subject !== subject.revision_id) throw new Error("Activity authoring subject differs from its exact action context");
      }
      if (datum.type === independent.review_type) {
        const activity = state.data.find(d=>d.type===independent.type && datum.links.some(l=>l.type==="reviews" && l.target===d.revision_id));
        if (activity) {
          const expected = activity.links.filter(l=>l.type==="verifies").map(l=>l.target).sort();
          const assessments = datum.payload.coverage_assessments as {target:string;disposition:string;rationale:string}[] | undefined;
          if (!Array.isArray(assessments) || JSON.stringify(assessments.map(a=>a.target).sort()) !== JSON.stringify(expected)) throw new Error("Verification review must assess adequacy for every exact target once");
          if (datum.payload.outcome === "pass" && assessments.some(a=>a.disposition!=="adequate")) throw new Error("Passing verification review cannot retain inadequate coverage");
        }
      }
      if (datum.type === independent.review_type) {
        const product = state.data.find(d=>d.type===independent.implementation_type && datum.links.some(l=>l.type==="reviews" && l.target===d.revision_id));
        if (product) {
          const expected = verificationStatus(state, product.revision_id).requirements.map(r=>r.requirement).sort();
          const assessments = datum.payload.coverage_assessments as {target:string;disposition:string}[] | undefined;
          if (!Array.isArray(assessments) || JSON.stringify(assessments.map(a=>a.target).sort()) !== JSON.stringify(expected)) throw new Error("Product review must judge collective coverage for every exact requirement once, including parents");
          if (datum.payload.outcome === "pass" && assessments.some(a=>a.disposition!=="adequate")) throw new Error("Passing product review requires adequate collective coverage");
        }
      }
      if ([independent.implementation_type, independent.prototype_type].includes(datum.type)) {
        const activities = selectedActivities(state, datum);
        if (!activities.length) throw new Error("Product must select at least one exact independent verification activity");
        for (const activity of activities) independentExecutionBinding(state, datum, activity.revision_id, "validate-selection");
      }
      if (context.action.capability === "acceptance" && datum.payload.decision === "accept") {
        const productId = datum.links.find(l => l.type === "accepts")?.target;
        if (!productId || !verificationStatus(state, productId).complete) throw new Error("Acceptance requires adequate independently reviewed coverage and current passing evidence for every requirement");
      }
      if (context.action.capability === "observation") {
        const product = state.data.find(d => d.type === independent.prototype_type && [context.subject, ...Object.values(context.inputs).flat()].includes(d.revision_id));
        if (!product) throw new Error("Observation needs one exact prototype");
        const activities = selectedActivities(state, product);
        const results = activities.flatMap(a => {
          const current = currentVerificationResults(state, product.revision_id, a.revision_id);
          if (current.length > 1) throw new Error("Observation needs one unambiguous current result per selected activity");
          return current;
        });
        if (!results.length) throw new Error("Observation needs at least one current selected activity result");
        // Missing evidence is non-passing; it does not invent an execution result.
        const outcome = results.length < activities.length || results.some(r => r.payload.outcome === "error") ? "error" : results.some(r => r.payload.outcome === "fail") ? "fail" : "pass";
        datum.payload.outcome = outcome;
        if (outcome !== "pass" && !["revise", "drop"].includes(String(datum.payload.recommendation))) throw new Error("Failed/incomplete observations allow revise or drop only");
        managedOutputs.push(datum);
      }
    }
  }
  return {outputs: outputData.map(output => output.datum), managedOutputs};
}
