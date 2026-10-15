import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DatumEnvelope, ProcessDiagnostic, ProcessPackage } from "./index.js";
import { deriveSourceScopes, type SourceEntry } from "./source-scopes.js";

const exec = promisify(execFile);
export interface RequirementTraceBinding {
  type: string;
  requirement_type: string;
  implementation_type: string;
  scope_type: string;
  decomposition_type?: string;
  change_type?: string;
  acceptance_type?: string;
  review_type?: string;
  result_type?: string;
  partialSource?: boolean;
  independentVerification?: boolean;
  /** staged-requirements@1: the requirements action that may only add one group under passed records. */
  stagedAction?: string;
}
export function requirementTraceBinding(pkg: ProcessPackage): RequirementTraceBinding | undefined {
  const binding = pkg.kernelCapabilities["requirement-trace@4"] ?? pkg.kernelCapabilities["requirement-trace@3"] ?? pkg.kernelCapabilities["requirement-trace@2"] ?? pkg.kernelCapabilities["requirement-trace@1"];
  const staged = pkg.kernelCapabilities["staged-requirements@1"];
  return binding ? {...binding, partialSource: !!(pkg.kernelCapabilities["requirement-trace@3"] || pkg.kernelCapabilities["requirement-trace@4"]), independentVerification: !!pkg.kernelCapabilities["requirement-trace@4"], ...(staged?.action ? {stagedAction: staged.action} : {})} as RequirementTraceBinding : undefined;
}
export function latestRequirements(data: DatumEnvelope[], binding: RequirementTraceBinding): DatumEnvelope[] {
  const latest = new Map<string, DatumEnvelope>();
  for (const datum of data) {
    if (datum.type !== binding.requirement_type) continue;
    if ((latest.get(datum.id)?.revision ?? 0) < datum.revision) latest.set(datum.id, datum);
  }
  return [...latest.values()].sort((a, b) => a.revision_id.localeCompare(b.revision_id));
}
/** A set's `retargets-interface` links name the revision it selects for each agreement lineage. */
export function interfaceRetargets(data: DatumEnvelope[], set: DatumEnvelope | undefined): Map<string, DatumEnvelope> {
  const retargets = new Map<string, DatumEnvelope>();
  for (const link of set?.links.filter(l => l.type === "retargets-interface") ?? []) {
    const datum = data.find(d => d.revision_id === link.target);
    if (datum) retargets.set(datum.id, datum);
  }
  return retargets;
}
/** A requirement's interface bindings that its set moves to a newer revision of the same agreement. */
export function retargetedBindings(data: DatumEnvelope[], set: DatumEnvelope | undefined, requirement: DatumEnvelope): {bound: string; selected: string}[] {
  const retargets = interfaceRetargets(data, set);
  return requirement.links.filter(l => l.type === "uses-interface").flatMap(l => {
    const bound = data.find(d => d.revision_id === l.target);
    const selected = bound && retargets.get(bound.id);
    return selected && selected.revision > bound.revision ? [{bound: l.target, selected: selected.revision_id}] : [];
  });
}
/** A requirement's links within a set, with retargeted interface bindings replaced in place. */
export function boundLinks(data: DatumEnvelope[], set: DatumEnvelope | undefined, requirement: DatumEnvelope): DatumEnvelope["links"] {
  const moved = new Map(retargetedBindings(data, set, requirement).map(r => [r.bound, r.selected]));
  if (!moved.size) return requirement.links;
  const seen = new Set<string>();
  return requirement.links.flatMap(link => {
    if (link.type !== "uses-interface") return [link];
    const target = moved.get(link.target) ?? link.target;
    if (seen.has(target)) return [];
    seen.add(target);
    return [{...link, target}];
  });
}
export const effectiveInterfaces = (data: DatumEnvelope[], set: DatumEnvelope | undefined, requirement: DatumEnvelope): string[] =>
  boundLinks(data, set, requirement).filter(l => l.type === "uses-interface").map(l => l.target);
/** Retargets carry forward to successor sets; a set may advance a lineage but not return to an older revision.
 * Call after the set's `contains` selection is derived. */
export function carryInterfaceRetargets(data: DatumEnvelope[], previous: DatumEnvelope | undefined, set: DatumEnvelope, enabled: boolean): ProcessDiagnostic[] {
  const declared = set.links.filter(l => l.type === "retargets-interface").map(l => data.find(d => d.revision_id === l.target));
  const fail = (code: string, message: string) => [{code, message, path: set.revision_id}];
  if (declared.length && !enabled) return fail("interface-retarget-capability", "Interface retargets require a package declaring interface-retarget@1");
  if (declared.some(d => !d)) return fail("interface-retarget-reference", "Interface retargets must name exact recorded interface revisions");
  const lineages = declared.map(d => d!.id);
  if (new Set(lineages).size !== lineages.length) return fail("interface-retarget-lineage", "Retarget each interface agreement to one exact revision");
  for (const [id, prior] of interfaceRetargets(data, previous)) {
    const next = declared.find(d => d!.id === id);
    if (!next) set.links.push({type: "retargets-interface", target: prior.revision_id});
    else if (next.revision < prior.revision) return fail("interface-retarget-regress", `Interface retarget '${next.revision_id}' is older than the preceding set's '${prior.revision_id}'`);
  }
  // One revision per retargeted agreement: a requirement binding a newer revision needs the retarget advanced too.
  const retargets = interfaceRetargets(data, set);
  for (const id of set.links.filter(l => l.type === "contains").map(l => l.target)) {
    for (const link of data.find(d => d.revision_id === id)?.links.filter(l => l.type === "uses-interface") ?? []) {
      const bound = data.find(d => d.revision_id === link.target), selected = bound && retargets.get(bound.id);
      if (selected && bound.revision > selected.revision) return fail("interface-retarget-behind", `Requirement '${id}' binds '${bound.revision_id}', newer than the set's retarget '${selected.revision_id}'; retarget the set to '${bound.revision_id}'`);
    }
  }
  return [];
}
export interface SelectedRequirementGraph {
  requirements: DatumEnvelope[];
  leaves: Set<string>;
  groups: DatumEnvelope[];
  parents: Map<string, string[]>;
  diagnostics: ProcessDiagnostic[];
  /** Every stakeholder root is decomposed and at least one software leaf exists. */
  complete: boolean;
}
export function selectedRequirementGraph(
  data: DatumEnvelope[], set: DatumEnvelope, binding: RequirementTraceBinding, requireCurrent = false,
  requireComplete = !binding.stagedAction,
): SelectedRequirementGraph {
  const diagnostics: ProcessDiagnostic[] = [];
  const fail = (code: string, message: string, path = set.revision_id) => diagnostics.push({ code, message, path });
  const byRevision = new Map(data.map((d) => [d.revision_id, d]));
  const targets = set.links.filter((l) => l.type === "contains").map((l) => l.target);
  const requirements = targets.flatMap((id) => {
    const datum = byRevision.get(id);
    if (!datum || datum.type !== binding.requirement_type) {
      fail("trace-requirement-reference", `Selected requirement '${id}' is not an exact requirement revision`);
      return [];
    }
    return [datum];
  });
  if (!requirements.length) fail("trace-requirements-empty", "A requirement graph must contain stakeholder and software requirements");
  if (new Set(requirements.map((d) => d.id)).size !== requirements.length) fail("trace-requirement-duplicate", "Select exactly one revision of each requirement");
  const selected = new Map(requirements.map((d) => [d.revision_id, d]));
  const parents = new Map(requirements.map((d) => [d.revision_id, binding.decomposition_type ? [] as string[] : d.links.filter((l) => l.type === "decomposes").map((l) => l.target)]));
  const groups: DatumEnvelope[] = [];
  if (binding.decomposition_type) {
    const parentIds = new Set<string>();
    for (const target of set.links.filter(l => l.type === "decomposition").map(l => l.target)) {
      const group = byRevision.get(target);
      if (!group || group.type !== binding.decomposition_type) { fail("trace-group-reference", `Group '${target}' must be an exact decomposition revision`); continue; }
      groups.push(group);
      const roots = group.links.filter(l => l.type === "parent").map(l => l.target);
      const members = group.links.filter(l => l.type === "child").map(l => l.target);
      if (roots.length !== 1) { fail("trace-group-parent", "A decomposition group requires exactly one parent", target); continue; }
      const parent = roots[0]!;
      if (parentIds.has(parent)) fail("trace-group-duplicate", "Select one decomposition group per parent", target);
      parentIds.add(parent);
      if (!selected.has(parent) || members.some(id => !selected.has(id))) fail("trace-decomposition-outside-selection", "Decomposition endpoints must belong to the exact selected graph", target);
      if (new Set(members).size !== members.length) fail("trace-decomposition-duplicate", "Group children must be distinct", target);
      for (const child of members) parents.get(child)?.push(parent);
    }
    for (const requirement of requirements) if (requirement.links.some(l => l.type === "decomposes")) fail("trace-competing-decomposition", "Decomposition belongs only to selected groups", requirement.revision_id);
  }
  const children = new Set<string>();
  for (const requirement of requirements) {
    const targets = parents.get(requirement.revision_id)!;
    if (new Set(targets).size !== targets.length) fail("trace-decomposition-duplicate", "A decomposition parent may be linked only once", requirement.revision_id);
    if (requirement.payload.kind === "stakeholder" && targets.length) fail("trace-stakeholder-parent", "Stakeholder roots cannot decompose another requirement", requirement.revision_id);
    if (requirement.payload.kind === "software" && !targets.length) fail("trace-software-parent", "Software requirements must decompose at least one selected parent", requirement.revision_id);
    for (const target of targets) {
      if (!selected.has(target)) fail("trace-decomposition-outside-selection", `Parent '${target}' is outside the exact selected graph`, requirement.revision_id);
      children.add(target);
    }
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const rooted = new Map<string, boolean>();
  function visit(id: string): boolean {
    if (visiting.has(id)) { fail("trace-decomposition-cycle", `Decomposition cycle at '${id}'`); return false; }
    if (visited.has(id)) return rooted.get(id) ?? false;
    const datum = selected.get(id);
    if (!datum) return false;
    visiting.add(id);
    const ancestry = (parents.get(id) ?? []).map(visit);
    const hasRoot = datum.payload.kind === "stakeholder" || (ancestry.length > 0 && ancestry.every(Boolean));
    visiting.delete(id); visited.add(id); rooted.set(id, hasRoot);
    return hasRoot;
  }
  for (const requirement of requirements) if (!visit(requirement.revision_id)) fail("trace-stakeholder-unreachable", `Requirement '${requirement.revision_id}' has no complete decomposition path to a stakeholder root`);
  if (requireCurrent) {
    const retired = new Set(set.links.filter(l => l.type === "retires").map(l => byRevision.get(l.target)?.id));
    const expected = latestRequirements(data, binding).filter(d => !binding.decomposition_type || !retired.has(d.id)).map((d) => d.revision_id);
    if (JSON.stringify([...targets].sort()) !== JSON.stringify(expected)) fail("trace-selection-stale", "The selected graph must include every current requirement revision; publish a reassessed requirement set before implementation");
  }
  const leaves = new Set(requirements.filter((d) => d.payload.kind === "software" && !children.has(d.revision_id)).map((d) => d.revision_id));
  // Staged packages publish and review partial graphs; implementation still requires completeness.
  const incomplete: ProcessDiagnostic[] = requirements.filter((d) => d.payload.kind === "stakeholder" && !children.has(d.revision_id))
    .map((root) => ({ code: "trace-stakeholder-uncovered", message: "Every stakeholder root must be decomposed into software behavior", path: root.revision_id }));
  if (!leaves.size) incomplete.push({ code: "trace-software-leaf-missing", message: "The graph must have a software leaf eligible for implementation", path: set.revision_id });
  if (requireComplete) diagnostics.push(...incomplete);
  return { requirements, leaves, groups, parents, diagnostics, complete: !incomplete.length };
}

export function traceDatumDiagnostics(pkg: ProcessPackage, datum: DatumEnvelope, data: DatumEnvelope[]): ProcessDiagnostic[] {
  const binding = requirementTraceBinding(pkg);
  if (!binding) return [];
  if (datum.type === binding.type) return selectedRequirementGraph(data, datum, binding).diagnostics;
  if (datum.type !== binding.scope_type) return [];
  const implementation = data.find((d) => d.revision_id === datum.links.find((l) => l.type === "belongs-to")?.target);
  const set = data.find((d) => d.revision_id === implementation?.links.find((l) => l.type === "implements")?.target);
  if (!set || set.type !== binding.type) return [{ code: "trace-scope-selection", path: datum.revision_id, message: "Source scope must belong to an implementation with an exact requirement set" }];
  const graph = selectedRequirementGraph(data, set, binding);
  const targets = datum.links.filter((l) => l.type === "implements" || l.type === "verifies");
  if (!targets.some((l) => graph.leaves.has(l.target)) || targets.some((l) => !graph.requirements.some((r) => r.revision_id === l.target) || (l.type === "implements" && !graph.leaves.has(l.target)))) {
    return [{ code: "trace-scope-target", path: datum.revision_id, message: "Every source scope needs a selected software leaf; implements may only target selected leaves" }];
  }
  return [];
}

/** Read the declared exact committed inventory for attribution and review. */
export async function readImplementationSource(implementation: DatumEnvelope): Promise<{entries: SourceEntry[]; diagnostics: ProcessDiagnostic[]}> {
  const diagnostics: ProcessDiagnostic[] = [];
  const cwd = String(implementation.payload.repository_path);
  const commit = String(implementation.payload.source_commit);
  if (!/^[0-9a-f]{40}$/.test(commit)) return {entries: [], diagnostics: [{code: "trace-source-commit", message: "Source commit must be an exact Git commit"}]};
  try {
    const { stdout } = await exec("git", ["ls-tree", "-rz", "--full-tree", commit], { cwd, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
    const roles = implementation.payload.file_roles as Record<string, SourceEntry["role"]> | undefined;
    const entries: SourceEntry[] = [];
    for (const record of stdout.toString("utf8").split("\0").filter(Boolean)) {
      const match = /^(\d+) (\S+) ([0-9a-f]+)\t([\s\S]+)$/.exec(record)!;
      const [, mode, kind, blob, file] = match as unknown as [string, string, string, string, string];
      if (kind !== "blob") { diagnostics.push({ code: "trace-source-entry-unsupported", path: file, message: `Unsupported committed entry '${kind}'` }); continue; }
      const role = roles?.[file];
      if (!role) { diagnostics.push({ code: "trace-source-role-missing", path: file, message: "Every committed entry needs an explicit file role" }); continue; }
      const { stdout: bytes } = await exec("git", ["cat-file", "blob", blob], { cwd, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
      entries.push({ path: file, mode, blob, bytes, role });
    }
    for (const file of Object.keys(roles ?? {})) if (!entries.some((e) => e.path === file) && !diagnostics.some((d) => d.path === file)) diagnostics.push({ code: "trace-source-role-unknown", path: file, message: "File role refers to no committed entry" });
    return {entries, diagnostics};
  } catch (error) {
    return {entries: [], diagnostics: [{code: "trace-source-unavailable", message: `Cannot read exact committed source: ${String(error)}`}]};
  }
}

export async function deriveImplementationScopes(
  implementation: DatumEnvelope, data: DatumEnvelope[], binding: RequirementTraceBinding,
) {
  const selection = data.find((d) => d.revision_id === implementation.links.find((l) => l.type === "implements")?.target && d.type === binding.type);
  if (!selection) return { diagnostics: [{ code: "trace-selection-missing", message: "Implementation must bind one exact requirement graph" }], inventory: [], scopes: [] };
  const graph = selectedRequirementGraph(data, selection, binding, true, true);
  if (graph.diagnostics.length) return { diagnostics: graph.diagnostics, inventory: [], scopes: [] };
  try {
    const {entries, diagnostics: sourceDiagnostics} = await readImplementationSource(implementation);
    if (sourceDiagnostics.length) return {diagnostics: sourceDiagnostics, inventory: [], scopes: []};
    const selectedFiles = implementation.payload.formal_files;
    const partial = implementation.payload.acceptance_scope === "partial";
    if ((partial || selectedFiles !== undefined) && !binding.partialSource) return {diagnostics: [{code: "trace-partial-unsupported", message: "Partial source acceptance requires requirement-trace@3"}], inventory: [], scopes: []};
    const invalidSelection = partial
      ? !Array.isArray(selectedFiles) || !selectedFiles.length
        || selectedFiles.some(f => typeof f !== "string" || !entries.some(e => e.path === f))
        || new Set(selectedFiles).size !== selectedFiles.length
      : selectedFiles !== undefined;
    if (invalidSelection) return {diagnostics: [{code: "trace-formal-files", message: "Partial acceptance requires distinct exact committed formal_files; whole-product acceptance must omit formal_files"}], inventory: [], scopes: []};
    if (!binding.independentVerification && partial && !(selectedFiles as string[]).includes(String(implementation.payload.verification_script))) return {diagnostics: [{code: "trace-formal-verifier", message: "The verification script must belong to the formal source selection"}], inventory: [], scopes: []};
    const generated = deriveSourceScopes({ entries, ...(binding.independentVerification && implementation.payload.source_ranges ? {explicitRanges: implementation.payload.source_ranges as any} : {}), ...(partial ? {formalFiles: selectedFiles as string[]} : {}), selectedRequirements: graph.requirements.map((d) => ({ stableId: d.id, revisionId: d.revision_id, kind: d.payload.kind as "stakeholder" | "software", isLeaf: graph.leaves.has(d.revision_id) })) });
    for (const leaf of graph.leaves) {
      for (const relation of (binding.independentVerification ? ["implements"] : ["implements", "verifies"])) {
        if (!generated.scopes.some((scope) => scope.links.some((link) => link.type === relation && link.target === leaf))) generated.diagnostics.push({code: "trace-requirement-uncovered", path: leaf, message: `Software leaf '${leaf}' has no source scope that '${relation}' it`});
      }
    }
    return generated;
  } catch (error) {
    return { diagnostics: [{ code: "trace-source-unavailable", message: `Cannot read exact committed source: ${String(error)}` }], inventory: [], scopes: [] };
  }
}

/** Added source lines are computed from Git, then intersected with inherited scopes. */
export async function implementationSourceChanges(
  implementation: DatumEnvelope, data: DatumEnvelope[], binding: RequirementTraceBinding,
  scopes: {path: string; inherited: boolean; ranges: {start: number; end: number}[]}[],
) {
  const cwd = String(implementation.payload.repository_path);
  const current = String(implementation.payload.source_commit);
  const candidates: {datum: DatumEnvelope; distance: number}[] = [];
  for (const datum of data) {
    if (datum.type !== binding.implementation_type || datum.revision_id === implementation.revision_id || datum.payload.repository_path !== cwd) continue;
    const commit = String(datum.payload.source_commit);
    if (!/^[0-9a-f]{40}$/.test(commit)) continue;
    try {
      await exec("git", ["merge-base", "--is-ancestor", commit, current], {cwd});
      const count = await exec("git", ["rev-list", "--count", `${commit}..${current}`], {cwd});
      candidates.push({datum, distance: Number(count.stdout.trim())});
    } catch { /* A different product history is not a comparison baseline. */ }
  }
  candidates.sort((a, b) => a.distance - b.distance || b.datum.revision - a.datum.revision || a.datum.revision_id.localeCompare(b.datum.revision_id));
  const previous = candidates[0]?.datum;
  const paths = [...new Set(scopes.map((s) => s.path))].sort();
  const files = [];
  for (const file of paths) {
    const added: {start: number; end: number}[] = [];
    if (previous) {
      const result = await exec("git", ["diff", "--no-ext-diff", "--no-textconv", "--unified=0", String(previous.payload.source_commit), current, "--", file], {cwd, maxBuffer: 64 * 1024 * 1024});
      for (const line of result.stdout.split("\n")) {
        const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (!match) continue;
        const start = Number(match[1]), count = match[2] === undefined ? 1 : Number(match[2]);
        if (count) added.push({start, end: start + count - 1});
      }
    } else {
      const ranges = scopes.filter((s) => s.path === file).flatMap((s) => s.ranges);
      const last = Math.max(0, ...ranges.map((r) => r.end));
      if (last) added.push({start: 1, end: last});
    }
    const inherited = scopes.filter((s) => s.path === file && s.inherited).flatMap((s) => s.ranges);
    files.push({path: file, added_ranges: added, inherited_added_ranges: added.flatMap((a) => inherited.flatMap((r) => {
      const start = Math.max(a.start, r.start), end = Math.min(a.end, r.end);
      return start <= end ? [{start, end}] : [];
    }))});
  }
  return {baseline_implementation: previous?.revision_id ?? null, files};
}
