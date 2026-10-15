import type { DatumEnvelope, ProcessDiagnostic } from "./index.js";
import { effectiveInterfaces, selectedRequirementGraph, type RequirementTraceBinding } from "./requirement-trace.js";

const targets = (d: DatumEnvelope | undefined, type: string) => d?.links.filter(l => l.type === type).map(l => l.target) ?? [];
const unique = (xs: string[]) => [...new Set(xs)].sort();
const rows = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter(v => v && typeof v === "object") : [];
const find = (data: DatumEnvelope[], id: string | undefined) => data.find(d => d.revision_id === id);
const accepted = (data: DatumEnvelope[], b: RequirementTraceBinding) => data.filter(d => d.type === b.acceptance_type && d.payload.decision === "accept");
/** Historical reviews remain immutable; only explicitly superseded judgments stop allocating work. */
export function currentReviews(data: DatumEnvelope[], reviewType: string | undefined): DatumEnvelope[] {
  const reviews = data.filter(d => d.type === reviewType);
  const superseded = new Set(reviews.flatMap(d => targets(d, "supersedes")));
  return reviews.filter(d => !superseded.has(d.revision_id));
}
const reviews = (data: DatumEnvelope[], b: RequirementTraceBinding, id: string) => currentReviews(data, b.review_type).filter(d => targets(d, "reviews").includes(id));

export function approvedChanges(data: DatumEnvelope[], b: RequirementTraceBinding): DatumEnvelope[] {
  return data.filter(d => d.type === b.change_type && !data.some(newer => newer.id === d.id && newer.revision > d.revision) && reviews(data, b, d.revision_id).some(r => r.payload.outcome === "pass"));
}
export function changeScope(data: DatumEnvelope[], b: RequirementTraceBinding, change: DatumEnvelope): string[] {
  const acc = find(data, targets(change, "baseline")[0]);
  const set = find(data, targets(acc, "confirms")[0]);
  if (!set) return [];
  const graph = selectedRequirementGraph(data, set, b);
  const scope = new Set(targets(change, "changes"));
  let size = -1;
  while (size !== scope.size) {
    size = scope.size;
    for (const [child, parents] of graph.parents) if (parents.some(p => scope.has(p))) scope.add(child);
  }
  return [...scope].sort();
}
/** Prospective candidates are derived from accepted exact links before any edits. */
export function changeImpact(data: DatumEnvelope[], b: RequirementTraceBinding, change: DatumEnvelope): {
  requirements: string[]; groups: string[]; sourceScopes: string[]; implementation?: string; result?: string;
} {
  const requirements = changeScope(data, b, change);
  const baseline = find(data, targets(change, "baseline")[0]);
  const set = find(data, targets(baseline, "confirms")[0]);
  const implementation = targets(baseline, "accepts")[0];
  const result = targets(baseline, "uses-evidence")[0];
  const groups = set ? selectedRequirementGraph(data, set, b).groups.filter(g => g.links.some(l => (l.type === "parent" || l.type === "child") && requirements.includes(l.target))).map(g => g.revision_id) : [];
  const sourceScopes = data.filter(d => d.type === b.scope_type && targets(d, "belongs-to").includes(implementation ?? "") && d.links.some(l => (l.type === "implements" || l.type === "verifies") && requirements.includes(l.target))).map(d => d.revision_id);
  return {requirements, groups: unique(groups), sourceScopes: unique(sourceScopes), ...(implementation ? {implementation} : {}), ...(result ? {result} : {})};
}
/** Omitted declarations preserve the historical no-new-root permission. */
export const declaredNewRoots = (change: DatumEnvelope): string[] => Array.isArray(change.payload.new_roots) ? change.payload.new_roots.filter((value): value is string => typeof value === "string") : [];

/** Bind each declaration once to its first selected root identity. Later corrections
 * keep that identity even when independent review changes its statement. */
function declaredRootScope(data: DatumEnvelope[], b: RequirementTraceBinding, change: DatumEnvelope, set: DatumEnvelope) {
  const declarations = declaredNewRoots(change);
  const underChange = (d: DatumEnvelope) => targets(d, "changes-under").some(id => find(data, id)?.id === change.id);
  const baseline = find(data, targets(change, "baseline")[0]);
  const baseSet = find(data, targets(baseline, "confirms")[0]);
  const existing = new Set(baseSet ? selectedRequirementGraph(data, baseSet, b).requirements.map(r => r.id) : []);
  const firstRoots = new Map<string, DatumEnvelope>();
  const history = data.filter(s => s.type === b.type && s.id === set.id && s.revision <= set.revision && underChange(s)).sort((a, z) => a.revision - z.revision);
  for (const selection of history) {
    const graph = selectedRequirementGraph(data, selection, b);
    for (const root of graph.requirements) if (!existing.has(root.id) && root.payload.kind === "stakeholder" && !graph.parents.get(root.revision_id)?.length && underChange(root) && !firstRoots.has(root.id)) firstRoots.set(root.id, root);
  }
  const matches = declarations.map(statement => [...firstRoots.values()].filter(root => root.payload.statement === statement));
  return {roots: new Set(matches.filter(roots => roots.length === 1).flatMap(roots => roots.map(root => root.id))), complete: matches.every(roots => roots.length === 1)};
}

/** New requirements inherit only scope established through the approved change's selected groups. */
function selectedChangeScope(data: DatumEnvelope[], b: RequirementTraceBinding, change: DatumEnvelope, set: DatumEnvelope): string[] {
  const scope = changeScope(data, b, change);
  const allowed = new Set([...scope.flatMap(id => find(data, id)?.id ?? []), ...declaredRootScope(data, b, change, set).roots]);
  const baseline = find(data, targets(change, "baseline")[0]);
  const baseSet = find(data, targets(baseline, "confirms")[0]);
  const existing = new Set(baseSet ? selectedRequirementGraph(data, baseSet, b).requirements.map(r => r.id) : []);
  const graph = selectedRequirementGraph(data, set, b);
  const underChange = (d: DatumEnvelope) => targets(d, "changes-under").some(id => find(data, id)?.id === change.id);
  let size = -1;
  while (size !== allowed.size) {
    size = allowed.size;
    for (const group of graph.groups.filter(underChange)) {
      if (![...targets(group, "parent"), ...targets(group, "child")].some(id => allowed.has(find(data, id)?.id ?? ""))) continue;
      for (const child of targets(group, "child")) {
        const requirement = find(data, child);
        if (requirement && !existing.has(requirement.id) && underChange(requirement)) allowed.add(requirement.id);
      }
    }
  }
  return unique([...scope, ...graph.requirements.filter(r => !existing.has(r.id) && allowed.has(r.id)).map(r => r.revision_id)]);
}
export interface RequirementAssessments {
  requirements: string[];
  groups: {revision: string; parent: string; children: string[]}[];
  correction: {requirements: string[]; groups: string[]};
  sourceScopes: string[];
  baseline?: string;
  change?: string;
  allowedRequirements: string[];
}

/** Fill coordinates, never judgments: only an omitted candidate with one exact
 * affected baseline path/name/role match is derivable. Explicit mappings and
 * unresolved moves, renames, or splits remain for canonical validation. */
export function deriveSourceDispositionCandidates(
  data: DatumEnvelope[], b: RequirementTraceBinding, implementation: DatumEnvelope,
  candidates: readonly {path: string; name: string; role: string}[],
): unknown {
  const dispositions = implementation.payload.impact_dispositions;
  const set = find(data, targets(implementation, "implements")[0]);
  if (!b.decomposition_type || !set || !Array.isArray(dispositions)) return dispositions;
  const affected = new Set(assessRequirements(data, b, set).sourceScopes);
  return dispositions.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const row = value as Record<string, unknown>;
    if ("candidate" in row || !["valid", "changed"].includes(String(row.disposition)) || !affected.has(String(row.source_scope))) return value;
    const baseline = find(data, String(row.source_scope));
    const matches = candidates.filter(c => c.path === baseline?.payload.path && c.name === baseline?.payload.name && c.role === baseline?.payload.role);
    const match = matches.length === 1 ? matches[0] : undefined;
    return match ? {...row, candidate: {path: match.path, name: match.name, role: match.role}} : value;
  });
}

/** Exact editable targets, shared by authoring guidance and publication checks. */
export function requirementAuthoringFrontier(data: DatumEnvelope[], b: RequirementTraceBinding, change: DatumEnvelope, previous: DatumEnvelope | undefined): {requirements: string[]; groups: string[]} {
  const baseline = find(data, targets(change, "baseline")[0]);
  const baseSet = find(data, targets(baseline, "confirms")[0]);
  const frontier = previous && previous.revision_id !== baseSet?.revision_id
    ? assessRequirements(data, b, previous).correction
    : {requirements: targets(change, "changes"), groups: []};
  const priorChange = find(data, targets(previous, "changes-under")[0]);
  if (priorChange && priorChange.revision < change.revision) frontier.requirements.push(...targets(change, "changes").filter(id => !targets(priorChange, "changes").includes(id)));
  return frontier;
}

/** Exact selected definition for a requirements or implementation review. */
export function reviewedRequirementSet(data: DatumEnvelope[], b: RequirementTraceBinding, review: DatumEnvelope): DatumEnvelope | undefined {
  const subject = find(data, targets(review, "reviews")[0]);
  return subject?.type === b.type ? subject : subject?.type === b.implementation_type ? find(data, targets(subject, "implements")[0]) : undefined;
}

/** Late implementation findings authorize statements only, never coverage or source edits. */
function implementationRequirementFindings(data: DatumEnvelope[], b: RequirementTraceBinding, set: DatumEnvelope): DatumEnvelope[] {
  if (data.some(newer => newer.id === set.id && newer.revision > set.revision)) return [];
  const selected = new Set(selectedRequirementGraph(data, set, b).requirements.map(r => r.revision_id));
  return data.filter(review => {
    if (review.type !== b.review_type || review.payload.outcome !== "fail") return false;
    const product = find(data, targets(review, "reviews")[0]);
    if (product?.type !== b.implementation_type || !targets(product, "implements").includes(set.revision_id) || data.some(newer => newer.id === product.id && newer.revision > product.revision)) return false;
    const assessments = rows(review.payload.requirement_assessments);
    const ids = assessments.map(a => String(a.requirement));
    return new Set(ids).size === ids.length && ids.every(id => selected.has(id)) && assessments.some(a => a.disposition === "needs-change");
  });
}

/** Bind initial late correction to its exact implementation failure, not all reviews. */
export function lateRequirementCorrectionFrontier(data: DatumEnvelope[], b: RequirementTraceBinding, set: DatumEnvelope, failure: DatumEnvelope | undefined): {requirements: string[]; groups: string[]} | undefined {
  const review = implementationRequirementFindings(data, b, set).find(r => r.revision_id === failure?.revision_id);
  return review ? {requirements: unique(rows(review.payload.requirement_assessments).filter(a => a.disposition === "needs-change").map(a => String(a.requirement))), groups: []} : undefined;
}

/** Derive local review obligations from exact graph evidence, without maintaining a queue. */
export function assessRequirements(data: DatumEnvelope[], b: RequirementTraceBinding, set: DatumEnvelope): RequirementAssessments {
  const graph = selectedRequirementGraph(data, set, b);
  const change = find(data, targets(set, "changes-under")[0]);
  const baseline = find(data, targets(change, "baseline")[0]);
  const baseSet = find(data, targets(baseline, "confirms")[0]);
  const baseRequirements = baseSet ? selectedRequirementGraph(data, baseSet, b).requirements : [];
  // A retargeted interface is a binding change: the unchanged requirement is assessed again under the new clauses.
  const binding = (owner: DatumEnvelope | undefined, r: DatumEnvelope) => `${r.revision_id}\0${effectiveInterfaces(data, owner, r).join()}`;
  const changed = graph.requirements.filter(r => !baseRequirements.some(old => binding(baseSet, old) === binding(set, r)));
  const passing = currentReviews(data, b.review_type).filter(d => d.payload.outcome === "pass" && targets(d, "reviews").some(id => { const prior = find(data, id); return prior?.type === b.type && prior.id === set.id && prior.revision < set.revision; }));
  const passedRequirements = new Set(passing.flatMap(r => rows(r.payload.requirement_assessments).filter(a => a.disposition === "valid").flatMap(a => {
    const requirement = find(data, String(a.requirement));
    return requirement ? [binding(find(data, targets(r, "reviews")[0]), requirement)] : [];
  })));
  const passedGroups = new Set(passing.flatMap(r => rows(r.payload.decomposition_assessments).filter(a => a.disposition === "adequate" && a.membership_action === "none" && rows(a.children).every(c => c.disposition === "valid")).map(a => String(a.group))));
  const groups = graph.groups.filter(g => !passedGroups.has(g.revision_id)).map(g => ({revision: g.revision_id, parent: targets(g, "parent")[0]!, children: targets(g, "child")}));
  const failed = reviews(data, b, set.revision_id).filter(r => r.payload.outcome === "fail");
  const lateFailures = implementationRequirementFindings(data, b, set);
  const requirementCorrections = [...failed, ...lateFailures].flatMap(r => [
    ...rows(r.payload.requirement_assessments).filter(a => a.disposition === "needs-change").map(a => String(a.requirement)),
    ...(failed.includes(r) ? rows(r.payload.decomposition_assessments).flatMap(a => rows(a.children).filter(c => c.disposition === "needs-change").map(c => String(c.requirement))) : []),
  ]);
  const groupCorrections = failed.flatMap(r => rows(r.payload.decomposition_assessments).filter(a => a.membership_action === "revise-membership").map(a => String(a.group)));
  const resultType = (b as RequirementTraceBinding & {result_type?: string}).result_type;
  const expectationFailure = resultType && data.some(result => result.type === resultType && ["fail", "error"].includes(String(result.payload.outcome)) && result.payload.correction_target === "requirements" && targets(result, "verifies").includes(set.revision_id) && targets(result, "executes").some(id => {
    const implementation = find(data, id);
    return implementation?.type === b.implementation_type && targets(implementation, "implements").includes(set.revision_id);
  }));
  if (change && expectationFailure) {
    const allowed = new Set(selectedChangeScope(data, b, change, set).flatMap(id => find(data, id)?.id ?? []));
    const requested = new Set(targets(change, "changes").flatMap(id => find(data, id)?.id ?? []));
    requirementCorrections.push(...graph.requirements.filter(r => allowed.has(r.id) && (requested.has(r.id) || changed.some(c => c.revision_id === r.revision_id))).map(r => r.revision_id));
  }
  const oldChanged = baseRequirements.filter(old => (changed.some(r => r.id === old.id) || !graph.requirements.some(r => r.id === old.id))).map(r => r.revision_id);
  const implementation = targets(baseline, "accepts")[0];
  const sourceScopes = data.filter(d => d.type === b.scope_type && targets(d, "belongs-to").includes(implementation ?? "") && d.links.some(l => (l.type === "implements" || l.type === "verifies") && oldChanged.includes(l.target))).map(d => d.revision_id);
  return {
    requirements: changed.filter(r => !passedRequirements.has(binding(set, r))).map(r => r.revision_id).sort(), groups,
    correction: {requirements: unique(requirementCorrections), groups: unique(groupCorrections)},
    sourceScopes: unique(sourceScopes), ...(baseline ? {baseline: baseline.revision_id} : {}), ...(change ? {change: change.revision_id} : {}),
    allowedRequirements: change ? selectedChangeScope(data, b, change, set) : graph.requirements.map(r => r.revision_id),
  };
}

/** Shared checks for canonical publication and repository validation. Schema validation remains authoritative for field shapes. */
export function validateChangeDatum(data: DatumEnvelope[], b: RequirementTraceBinding, datum: DatumEnvelope): ProcessDiagnostic[] {
  if (!b.decomposition_type || !b.change_type || !b.acceptance_type || !b.review_type) return [];
  const diagnostics: ProcessDiagnostic[] = [];
  const fail = (code: string, message: string) => diagnostics.push({code, message, path: datum.revision_id});
  const others = data.filter(d => d.revision_id !== datum.revision_id);
  const all = [...others, datum];
  const baselines = accepted(others, b);
  const closed = (id: string) => {
    const request = find(all, id);
    return baselines.some(a => targets(a, "changes-under").some(target => {
      const final = find(all, target);
      return final && request && final.id === request.id && final.revision >= request.revision;
    }));
  };
  const isApproved = (change: DatumEnvelope) => reviews(others, b, change.revision_id).some(r => r.payload.outcome === "pass");
  const selectedSets = baselines.flatMap(a => targets(a, "confirms")).flatMap(id => find(all, id) ?? []);
  const controlled = selectedSets.flatMap(s => selectedRequirementGraph(all, s, b).requirements);
  const change = find(all, targets(datum, "changes-under")[0]);
  const validateAuthority = () => {
    if (!change || change.type !== b.change_type || !isApproved(change)) {
      fail("change-approval-required", "Baselined work requires an exact approved change request; request and approve the change before revision"); return undefined;
    }
    const baseline = find(all, targets(change, "baseline")[0]);
    if (!baseline || !baselines.some(a => a.revision_id === baseline.revision_id)) {
      fail("change-baseline", "Change request must name an accepted baseline"); return undefined;
    }
    const closing = baselines.find(a => targets(a, "changes-under").some(id => {
      const final = find(all, id);
      return final?.id === change.id && final.revision >= change.revision;
    }));
    if (closing) {
      const finalSet = find(all, targets(closing, "confirms")[0]);
      const history = finalSet ? all.filter(s => s.type === b.type && s.id === finalSet.id && s.revision <= finalSet.revision && targets(s, "changes-under").some(id => find(all, id)?.id === change.id)) : [];
      const historicalMembers = history.flatMap(s => {
        const graph = selectedRequirementGraph(all, s, b);
        return [...graph.requirements, ...graph.groups, ...targets(s, "retires").flatMap(id => find(all, id) ?? [])];
      });
      const historical = datum.type === b.type ? finalSet : datum.type === b.implementation_type ? find(all, targets(closing, "accepts")[0]) : historicalMembers.find(d => d.revision_id === datum.revision_id);
      if (!historical || historical.id !== datum.id || historical.revision < datum.revision) fail("change-closed", "This change is already accepted; request a new change against the accepted successor baseline");
    }
    return {change, baseline, scope: changeScope(others, b, change)};
  };
  if (datum.type === b.change_type) {
    const ids = targets(datum, "baseline");
    const baseline = find(all, ids[0]);
    if (ids.length !== 1 || !baseline || !baselines.includes(baseline)) fail("change-baseline", "Change request must name one exact accepted baseline");
    else {
      const selection = find(all, targets(baseline, "confirms")[0]);
      const members = selection ? selectedRequirementGraph(all, selection, b).requirements.map(r => r.revision_id) : [];
      const roots = targets(datum, "changes");
      const newRoots = declaredNewRoots(datum);
      if ((!roots.length && !newRoots.length) || new Set(roots).size !== roots.length || roots.some(id => !members.includes(id))) fail("change-target", "Change scope needs exact baseline targets or declared new stakeholder roots; existing targets must be distinct baseline requirements");
      if (new Set(newRoots).size !== newRoots.length || newRoots.some(statement => !statement.trim())) fail("change-new-roots", "New root statements must be distinct and nonempty");
      const prior = others.filter(c => c.id === datum.id && c.revision < datum.revision).sort((a, z) => z.revision - a.revision)[0];
      const approved = others.filter(c => c.id === datum.id && c.revision < datum.revision && isApproved(c));
      const approvedRoots = approved.flatMap(c => targets(c, "changes"));
      const approvedNewRoots = approved.flatMap(declaredNewRoots);
      if (prior && (targets(prior, "baseline")[0] !== baseline.revision_id || approvedRoots.some(id => !roots.includes(id)) || approvedNewRoots.some(statement => !newRoots.includes(statement)))) fail("change-amendment-scope", "An amendment must retain its baseline, previously approved change targets and declared new root statements");
      const successors = baselines.filter(a => targets(a, "changes-under").some(id => targets(find(all, id), "baseline").includes(baseline.revision_id)));
      if (!closed(datum.revision_id) && successors.length) fail("change-baseline-stale", "Request change against the successor accepted baseline");
    }
  }
  if (datum.type === b.requirement_type && controlled.some(r => r.id === datum.id && r.revision < datum.revision)) {
    const authority = validateAuthority();
    if (authority && !authority.scope.some(id => find(all, id)?.id === datum.id)) fail("change-outside-scope", "Requirement is outside the approved change; amend its scope through stakeholder approval");
  }
  if (datum.type === b.decomposition_type && baselines.length) {
    const previous = selectedSets.flatMap(s => selectedRequirementGraph(all, s, b).groups).filter(g => g.id === datum.id && g.revision < datum.revision);
    if (previous.length) {
      const authority = validateAuthority();
      if (authority) {
        const allowed = new Set(authority.scope.flatMap(id => find(all, id)?.id ?? []));
        const endpoints = [...targets(datum, "parent"), ...targets(datum, "child")];
        if (!endpoints.some(id => allowed.has(find(all, id)?.id ?? ""))) fail("change-outside-scope", "Decomposition does not involve any requirement in the approved change");
      }
    }
  }
  if (datum.type === b.implementation_type && baselines.length && !baselines.some(a => targets(a, "accepts").some(id => {const old = find(all, id); return old?.id === datum.id && old.revision >= datum.revision;}))) validateAuthority();
  if (datum.type === b.type) {
    const selected = targets(datum, "contains").flatMap(id => find(all, id) ?? []);
    const retired = targets(datum, "retires");
    const previousSet = others.filter(s => s.type === b.type && s.id === datum.id && s.revision < datum.revision).sort((a, z) => z.revision - a.revision)[0];
    const previousRetired = targets(previousSet, "retires");
    if (retired.filter(id => !previousRetired.includes(id)).some(id => !targets(previousSet, "contains").includes(id))) fail("change-retirement-stale", "New retirements must name exact requirements selected by the immediately preceding requirement set");
    const historicalRetired = others.filter(s => s.type === b.type && s.id === datum.id && s.revision < datum.revision).flatMap(s => targets(s, "retires"));
    if (historicalRetired.some(id => !retired.includes(id))) fail("change-retirement-history", "Retirement links must preserve prior exact retirements; reinstatement is unsupported");
    if (retired.some(id => { const r = find(all, id); return !r || r.type !== b.requirement_type || selected.some(s => s.id === r.id); })) fail("change-retirement-selection", "Retired requirements must be exact requirements excluded from the current selection");
    const failure = find(all, targets(datum, "corrects")[0]);
    const reviewed = find(all, targets(failure, "reviews")[0]);
    if (!change && previousSet && reviewed?.type === b.implementation_type) {
      // Validate historical permission before this selection and its later products existed.
      const laterSets = new Set(all.filter(s => s.type === b.type && s.id === datum.id && s.revision >= datum.revision).map(s => s.revision_id));
      const authoringData = others.filter(d => !laterSets.has(d.revision_id) && !(d.type === b.implementation_type && targets(d, "implements").some(id => laterSets.has(id))));
      const frontier = lateRequirementCorrectionFrontier(authoringData, b, previousSet, failure);
      if (!frontier) fail("change-frontier-source", "Initial late correction requires its exact current implementation failure and selected requirement findings");
      const previousGraph = selectedRequirementGraph(all, previousSet, b);
      const graph = selectedRequirementGraph(all, datum, b);
      for (const r of graph.requirements) {
        const old = previousGraph.requirements.find(old => old.id === r.id);
        if (old?.revision_id !== r.revision_id && (!old || !frontier?.requirements.includes(old.revision_id))) fail("change-frontier", `Requirement '${r.revision_id}' is outside the exact late-review correction frontier`);
      }
      if (previousGraph.requirements.some(old => !graph.requirements.some(r => r.id === old.id))) fail("change-frontier", "Initial late correction must preserve selected requirement identities");
      for (const g of graph.groups) {
        const old = previousGraph.groups.find(old => old.id === g.id);
        const children = (group: DatumEnvelope | undefined) => targets(group, "child").map(id => find(all, id)?.id ?? id).sort();
        if (!old || JSON.stringify(children(old)) !== JSON.stringify(children(g))) fail("change-membership-frontier", "Initial late requirement findings do not authorize decomposition membership changes");
      }
    }
  }
  if (datum.type === b.type && baselines.length) {
    const graph = selectedRequirementGraph(all, datum, b);
    const baseSets = selectedSets.filter(s => s.id === datum.id && s.revision < datum.revision);
    if (baseSets.length) {
      const authority = validateAuthority();
      if (authority) {
        const baseSet = find(all, targets(authority.baseline, "confirms")[0]);
        const baselineGraph = baseSet ? selectedRequirementGraph(all, baseSet, b) : undefined;
        const allowedIds = new Set(authority.scope.flatMap(id => find(all, id)?.id ?? []));
        const removed = baselineGraph?.requirements.filter(old => !graph.requirements.some(r => r.id === old.id)) ?? [];
        if (removed.some(r => !targets(datum, "retires").some(id => find(all, id)?.id === r.id))) fail("change-retirement-required", "Removed baselined requirements need explicit exact retires links");
        if (removed.some(r => !allowedIds.has(r.id))) fail("change-outside-scope", "Removing a selected requirement requires approved scope for that requirement");
        const priorSets = others.filter(s => s.type === b.type && s.id === datum.id && s.revision < datum.revision && targets(s, "changes-under").some(id => find(all, id)?.id === authority.change.id));
        const previous = priorSets.sort((a, z) => z.revision - a.revision)[0] ?? baseSet;
        const previousGraph = previous ? selectedRequirementGraph(all, previous, b) : undefined;
        if (previous) for (const id of selectedChangeScope(all, b, authority.change, previous)) {
          const requirement = find(all, id);
          if (requirement) allowedIds.add(requirement.id);
        }
        // Validate historical permission before this selection existed. Later set and
        // implementation successors must not erase the exact failure that authorized it.
        const laterSets = new Set(all.filter(s => s.type === b.type && s.id === datum.id && s.revision >= datum.revision).map(s => s.revision_id));
        const authoringData = others.filter(d => !laterSets.has(d.revision_id) && !(d.type === b.implementation_type && targets(d, "implements").some(id => laterSets.has(id))));
        const frontier = requirementAuthoringFrontier(authoringData, b, authority.change, previous);
        const frontierIds = new Set(frontier.requirements.flatMap(id => find(all, id)?.id ?? []));
        const groupIds = new Set(frontier.groups.flatMap(id => find(all, id)?.id ?? []));
        const declared = declaredRootScope(all, b, authority.change, datum);
        if (!declared.complete) fail("change-new-root-match", "Each approved new root statement must match exactly one added stakeholder root identity");
        const underChange = (d: DatumEnvelope) => targets(d, "changes-under").some(id => find(all, id)?.id === authority.change.id);
        const addedIds = new Set(graph.requirements.filter(r => !previousGraph?.requirements.some(old => old.id === r.id) && !baselineGraph?.requirements.some(old => old.id === r.id)).map(r => r.id));
        const newBranch = new Set([...declared.roots].filter(id => addedIds.has(id)));
        let size = -1;
        while (size !== newBranch.size) {
          size = newBranch.size;
          for (const group of graph.groups.filter(underChange)) {
            if (!targets(group, "parent").some(id => newBranch.has(find(all, id)?.id ?? ""))) continue;
            for (const child of targets(group, "child")) {
              const requirement = find(all, child);
              if (requirement && addedIds.has(requirement.id) && underChange(requirement)) newBranch.add(requirement.id);
            }
          }
        }
        for (const r of graph.requirements) {
          if (previousGraph?.requirements.some(old => old.revision_id === r.revision_id)) continue;
          const old = previousGraph?.requirements.find(old => old.id === r.id) ?? baselineGraph?.requirements.find(old => old.id === r.id);
          if (old && !allowedIds.has(r.id)) fail("change-outside-scope", `Requirement '${r.revision_id}' is outside approved scope; amend the change request`);
          if (old && !frontierIds.has(r.id)) fail("change-frontier", `Requirement '${r.revision_id}' is outside the current authoring frontier; assess its parent first`);
          if (!old) {
            const parentGroups = graph.groups.filter(g => targets(g, "child").includes(r.revision_id));
            if (!newBranch.has(r.id) && !parentGroups.some(g => groupIds.has(g.id) || targets(g, "parent").some(id => frontierIds.has(find(all, id)?.id ?? "")))) fail("change-addition-scope", `Added requirement '${r.revision_id}' must belong to an authorized affected decomposition group`);
          }
        }
        for (const g of graph.groups) {
          const old = previousGraph?.groups.find(old => old.id === g.id);
          const oldChildren = targets(old, "child").map(id => find(all, id)?.id ?? id).sort();
          const newChildren = targets(g, "child").map(id => find(all, id)?.id ?? id).sort();
          if (JSON.stringify(oldChildren) !== JSON.stringify(newChildren) && !(underChange(g) && targets(g, "parent").some(id => newBranch.has(find(all, id)?.id ?? ""))) && !groupIds.has(g.id) && !targets(g, "parent").some(id => frontierIds.has(find(all, id)?.id ?? ""))) fail("change-membership-frontier", `Group '${g.revision_id}' membership needs an authorized parent target or a review membership correction`);
        }
      }
    }
  }
  if (datum.type === b.implementation_type) {
    const set = find(all, targets(datum, "implements")[0]);
    if (set && targets(set, "changes-under").length) {
      if (targets(datum, "changes-under")[0] !== targets(set, "changes-under")[0]) fail("change-implementation-binding", "Implementation must bind the same approved change as its requirement selection");
      const expected = assessRequirements(all, b, set).sourceScopes;
      const dispositions = rows(datum.payload.impact_dispositions);
      if (JSON.stringify(dispositions.map(d => String(d.source_scope)).sort()) !== JSON.stringify(expected)) fail("change-source-coverage", "Implementation dispositions must cover every exact affected baseline source scope once");
      for (const d of dispositions) {
        if (d.disposition === "removed") continue;
        const candidate = d.candidate as Record<string, unknown> | undefined;
        if (!candidate || !all.some(s => s.type === b.scope_type && targets(s, "belongs-to").includes(datum.revision_id) && s.payload.path === candidate.path && s.payload.name === candidate.name && s.payload.role === candidate.role)) fail("change-source-candidate", `Source disposition '${String(d.source_scope)}' needs an exact generated candidate path, name, and role; provide an explicit mapping when no unique same-coordinate candidate exists`);
      }
    }
  }
  if (datum.type === b.review_type) {
    const subject = find(all, targets(datum, "reviews")[0]);
    const supersedes = targets(datum, "supersedes");
    if (supersedes.length) {
      const previous = find(others, supersedes[0]);
      const subjectReviews = subject ? reviews(others, b, subject.revision_id) : [];
      if (supersedes.length !== 1 || subject?.type !== b.type || !previous || previous.type !== b.review_type || previous.payload.outcome !== "fail" || !targets(previous, "reviews").includes(subject.revision_id) || !subjectReviews.some(r => r.revision_id === previous.revision_id)) fail("review-correction-target", "Review correction requires one current failed review of the same exact requirement set");
      if (typeof datum.payload.correction_reason !== "string" || !datum.payload.correction_reason.trim()) fail("review-correction-reason", "Review correction must explain the acknowledged judgment error");
      if (datum.id === previous?.id) fail("review-correction-history", "Corrected judgment requires a new review identity; preserve the original review");
    }
    if (subject?.type === b.change_type && datum.payload.outcome === "pass") {
      const active = approvedChanges(others, b).filter(c => !closed(c.revision_id) && c.id !== subject.id);
      if (!closed(subject.revision_id) && active.some(c => targets(c, "baseline").some(id => targets(subject, "baseline").includes(id)))) fail("change-already-active", "An approved change is already open for this baseline; close or amend it before approving another");
    }
    if (subject?.type === b.implementation_type) {
      const set = find(all, targets(subject, "implements")[0]);
      const statements = rows(datum.payload.requirement_assessments);
      const selected = new Set(set ? selectedRequirementGraph(all, set, b).requirements.map(r => r.revision_id) : []);
      const ids = statements.map(a => String(a.requirement));
      if (new Set(ids).size !== ids.length || ids.some(id => !selected.has(id))) fail("change-review-requirement-target", "Implementation requirement assessments must name distinct exact requirements selected by the reviewed implementation, with no foreign or stale entries");
      if (datum.payload.outcome === "pass" && statements.some(a => a.disposition === "needs-change")) fail("change-review-pass", "Passing implementation review cannot contain a requirement needing correction");
      if (set && targets(set, "changes-under").length) {
        const expected = assessRequirements(others, b, set).sourceScopes;
        const assessments = rows(datum.payload.source_assessments);
        if (JSON.stringify(assessments.map(a => String(a.source_scope)).sort()) !== JSON.stringify(expected)) fail("change-source-review-coverage", "Implementation review must assess every exact affected baseline source scope once");
        if (datum.payload.outcome === "pass" && assessments.some(a => a.disposition !== "valid")) fail("change-source-review-pass", "Passing implementation review cannot leave an affected source scope needing change");
      }
    }
    if (subject?.type === b.type) {
      const expected = assessRequirements(others, b, subject);
      const statements = rows(datum.payload.requirement_assessments);
      const groups = rows(datum.payload.decomposition_assessments);
      const exact = (actual: string[], needed: string[], label: string) => {
        if (new Set(actual).size !== actual.length || JSON.stringify([...actual].sort()) !== JSON.stringify([...needed].sort())) fail("change-review-coverage", `${label} must cover every required exact revision once, with no foreign or stale entries`);
      };
      exact(statements.map(a => String(a.requirement)), expected.requirements, "Requirement assessments");
      exact(groups.map(a => String(a.group)), expected.groups.map(g => g.revision), "Decomposition assessments");
      for (const group of expected.groups) {
        const assessment = groups.find(a => a.group === group.revision);
        if (assessment) exact(rows(assessment.children).map(a => String(a.requirement)), group.children, `Children of ${group.revision}`);
      }
      if (datum.payload.outcome === "pass" && (statements.some(a => a.disposition !== "valid") || groups.some(a => a.disposition !== "adequate" || a.membership_action !== "none" || rows(a.children).some(c => c.disposition !== "valid")))) fail("change-review-pass", "A passing review cannot contain a requirement, child, or decomposition needing correction");
      for (const group of groups) {
        const parent = expected.groups.find(g => g.revision === group.group)?.parent;
        const parentCorrection = statements.some(a => a.requirement === parent && a.disposition === "needs-change");
        if (group.disposition === "needs-change" && group.membership_action !== "revise-membership" && !rows(group.children).some(c => c.disposition === "needs-change") && !parentCorrection) fail("change-review-correction", "An inadequate group must identify parent or child correction, or a membership revision");
      }
    }
  }
  return diagnostics;
}
