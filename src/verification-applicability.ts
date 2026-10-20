import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify, isDeepStrictEqual } from "node:util";
import type { DatumEnvelope, ProcessPackage } from "./index.js";
import type { DirectTransaction } from "./direct-contract.js";
import { independentBinding, independentExecutionBinding, currentVerificationResults } from "./independent-verification.js";
import { readGitBlobs, readVerificationReceiptBlob, validateVerificationReceipt, verificationRef, type VerificationBinding } from "./verification-receipt.js";
import { repositoryGitEnvironment } from "./git-environment.js";
import { progress } from "./progress.js";

const exec = promisify(execFile);
type State = {root: string; pkg: ProcessPackage; package: unknown; data: DatumEnvelope[]};
export interface HistoricalObservation {
  contract: "mdlm-verification-applicability@1";
  original_result: string;
  original_implementation: string;
  receipt: string;
  execution_operation: string;
  started_at: string;
  finished_at: string;
  applied_at: string;
}
const links = (d: DatumEnvelope, type: string) => d.links.filter(l => l.type === type).map(l => l.target);
const exact = (s: State, id: string) => {const d = s.data.find(d => d.revision_id === id); if (!d) throw new Error(`Historical observation revision '${id}' is unavailable`); return d;};
async function git(root: string, args: string[]) {return (await exec("git", ["-C", root, ...args], {env: repositoryGitEnvironment(), maxBuffer: 64 * 1024 * 1024})).stdout.trim();}
const publicationIndexes = new WeakMap<DatumEnvelope[], Promise<Map<string, DirectTransaction[]>>>();
/** Direct transactions by the revisions they published, read once per loaded lifecycle state. */
export function directPublications(state: Pick<State, "root" | "data">): Promise<Map<string, DirectTransaction[]>> {
  let index = publicationIndexes.get(state.data);
  if (!index) {
    index = (async () => {
      const byRevision = new Map<string, DirectTransaction[]>();
      for (const id of await fs.readdir(path.join(state.root, ".lifecycle/data/.transactions"))) {
        const tx = JSON.parse(await fs.readFile(path.join(state.root, ".lifecycle/data/.transactions", id, "execution.json"), "utf8")) as DirectTransaction;
        if (tx.contract !== "mdlm-direct-transaction@1") continue;
        for (const revision of new Set(tx.outputs.map(d => d.revision_id))) byRevision.set(revision, [...byRevision.get(revision) ?? [], tx]);
      }
      return byRevision;
    })();
    publicationIndexes.set(state.data, index);
  }
  return index;
}
type SavedReceipt = Awaited<ReturnType<typeof readVerificationReceiptBlob>>["receipt"];
const receiptBlobs = new WeakMap<DatumEnvelope[], Map<string, string>>();
/** Every current execution ref and its receipt, in ref order. Blobs are content-addressed, so each is read once per loaded lifecycle state. */
async function* executionReceipts(state: State): AsyncGenerator<{ref: string; receipt: SavedReceipt}> {
  const refs = (await git(state.root, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/mdlm/execution"])).split("\n").filter(Boolean).map(line => line.split(" ") as [string, string]);
  let cache = receiptBlobs.get(state.data);
  if (!cache) receiptBlobs.set(state.data, cache = new Map());
  for (const [oid, source] of await readGitBlobs(state.root, refs.map(([, oid]) => oid).filter(oid => /^[a-f0-9]{40}$/.test(oid) && !cache.has(oid)))) cache.set(oid, source);
  for (const [ref, oid] of refs) {
    let receipt: SavedReceipt | undefined;
    try { const source = cache.get(oid); if (source !== undefined) receipt = JSON.parse(source); } catch { /* the single read below reports it */ }
    // Anything the batch could not parse keeps the original single-read diagnostic, in ref order.
    yield {ref, receipt: receipt ?? (await readVerificationReceiptBlob(state.root, oid)).receipt};
  }
}
/** The direct transactions that published this exact datum. */
export async function datumPublications(state: Pick<State, "root" | "data">, datum: DatumEnvelope): Promise<DirectTransaction[]> {
  return ((await directPublications(state)).get(datum.revision_id) ?? []).filter(tx => tx.outputs.some(d => isDeepStrictEqual(d, datum)));
}
export async function resultPublication(state: State, datum: DatumEnvelope) {
  const matches = await datumPublications(state, datum);
  if (matches.length !== 1 || !isDeepStrictEqual(matches[0]!.package, state.package)) throw new Error("Historical observation requires one authenticated same-package result publication");
  return matches[0]!;
}
export async function registeredReceipt(state: State, locator: string, expected: VerificationBinding) {
  if (!/^git-blob:[a-f0-9]{40}$/.test(locator)) throw new Error("Historical observation requires an exact receipt blob");
  const saved = await readVerificationReceiptBlob(state.root, locator.slice(9));
  const {binding, attempt} = saved.receipt;
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(binding.operation) || !Number.isInteger(attempt) || attempt < 1
    || await git(state.root, ["rev-parse", "--verify", `${verificationRef(binding)}/attempt-${attempt}-receipt`]) !== saved.oid) throw new Error("Historical observation receipt is not registered to its original operation");
  return validateVerificationReceipt(expected, saved);
}
function authenticateObservation(datum: DatumEnvelope, verified: Awaited<ReturnType<typeof registeredReceipt>>) {
  const r = verified.saved.receipt.result!, b = verified.saved.receipt.binding;
  const artifacts = (r.artifacts ?? []).map(({contentBase64, ...artifact}) => artifact);
  if (r.outcome !== "pass" || !r.started || r.phase !== "execution" || r.exitCode !== 0 || r.diagnostic || !r.sourceTree || !r.scriptSha256 || !r.independentVerification || !r.imageId || !r.startedAt || !r.finishedAt
    || !isDeepStrictEqual(datum.payload.case_results, r.caseResults) || !isDeepStrictEqual(datum.payload.artifacts, artifacts) || datum.payload.outcome !== r.outcome || datum.payload.receipt !== verified.receipt) throw new Error("Historical observation requires a complete original passing result and captured evidence");
  if (r.image !== b.image || !isDeepStrictEqual(r.command, b.independentVerification?.command) || r.scriptPath !== b.independentVerification?.scriptPath
    || (b.image.startsWith("sha256:") ? r.imageId !== b.image : r.imageDigest !== b.image.slice(b.image.indexOf("@") + 1))) throw new Error("Historical observation image or command differs from its captured contract");
  if (!r.rawReportBase64) throw new Error("Historical observation report bytes are unavailable");
  const report = JSON.parse(Buffer.from(r.rawReportBase64, "base64").toString("utf8"));
  if (report.contract !== "mdlm-verification-results@1" || !Array.isArray(report.cases) || !isDeepStrictEqual(report.cases.map(({case_id, outcome, actual_results, evidence_refs}: Record<string, unknown>) => ({case_id, outcome, actual_results, evidence_refs})), r.caseResults)
    || !isDeepStrictEqual((r.caseResults ?? []).map(c => c.case_id).sort(), [...b.independentVerification!.caseIds].sort()) || r.caseResults!.some(c => c.outcome !== "pass")) throw new Error("Historical observation report conflicts with captured passing cases");
  for (const artifact of r.artifacts ?? []) {
    const bytes = Buffer.from(artifact.contentBase64, "base64");
    if (bytes.length !== artifact.bytes || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new Error("Historical observation artifact bytes changed");
  }
  if (r.caseResults!.some(c => c.evidence_refs.some(ref => !r.artifacts?.some(a => a.path === ref)))) throw new Error("Historical observation declared evidence is unavailable");
}
/** Explicit original selection across a selection-only lineage, no receipt or execution mutation. Reused by publication and current review/acceptance. */
export async function historicalApplicability(state: State, product: DatumEnvelope, activity: string, originalId: string) {
  const cap = state.pkg.kernelCapabilities["verification-applicability@1"], independent = independentBinding(state.pkg);
  if (!cap || cap.type !== independent?.result_type || product.type !== independent.implementation_type) throw new Error("Selected package does not support historical verification applicability for implementations");
  const original = exact(state, originalId);
  if (original.type !== cap.type || original.payload.historical_observation !== undefined) throw new Error("Historical applicability requires an original execution RES; reuse chains are unsupported");
  const priorId = links(original, "executes")[0] ?? "", prior = exact(state, priorId);
  if (prior.id !== product.id || prior.revision >= product.revision || prior.type !== product.type) throw new Error("Historical applicability requires an earlier implementation revision in the same lineage");
  const payload = (d: DatumEnvelope) => {const {source_changes, ...rest} = d.payload; return rest;};
  const semanticLinks = (d: DatumEnvelope) => d.links.filter(l => !["verification", "corrects"].includes(l.type)).map(l => `${l.type}\0${l.target}`).sort();
  // Every revision after the original's product is selection-only, so no source revert qualifies.
  const lineage = state.data.filter(d => d.id === product.id && d.revision > prior.revision && d.revision < product.revision);
  if (Array.from({length: product.revision - prior.revision - 1}, (_, i) => prior.revision + 1 + i).some(n => lineage.filter(d => d.revision === n).length !== 1)) throw new Error("Historical applicability requires every intermediate implementation revision");
  for (const later of [...lineage, product]) if (later.type !== prior.type || !isDeepStrictEqual(payload(prior), payload(later)) || !isDeepStrictEqual(semanticLinks(prior), semanticLinks(later)) || prior.body !== later.body) throw new Error("Historical applicability requires unchanged product source, inventory, attribution, scope, requirements and command");
  // A later recorded result for this activity in the lineage owns currency unless it applies this same original.
  if (lineage.some(d => currentVerificationResults(state, d.revision_id, activity).some(r => (r.payload.historical_observation as HistoricalObservation | undefined)?.original_result !== originalId))) throw new Error("Historical original result is superseded by a later result in the lineage");
  if (!isDeepStrictEqual(links(original, "evaluates"), [activity]) || !isDeepStrictEqual(links(original, "verifies"), links(product, "implements"))) throw new Error("Historical result must bind the exact unchanged activity and requirements");
  const tx = await resultPublication(state, original);
  if (tx.evidence?.historicalResult !== undefined || tx.evidence?.receipt !== original.payload.receipt || !Object.values(tx.inputs).flat().includes(priorId) && tx.subject !== priorId) throw new Error("Historical original publication does not authenticate its execution claim");
  const saved = await readVerificationReceiptBlob(state.root, String(original.payload.receipt).slice(9));
  const expected = independentExecutionBinding(state, prior, activity, saved.receipt.binding.operation);
  const verified = await registeredReceipt(state, String(original.payload.receipt), expected);
  authenticateObservation(original, verified);
  // Reconstructing both bindings also revalidates the exact requirements-only authoring context and interfaces.
  const successor = independentExecutionBinding(state, product, activity, expected.operation);
  if (!isDeepStrictEqual({...successor, inputs: expected.inputs}, expected)) throw new Error("Historical applicability execution contract changed");
  if (!currentVerificationResults(state, priorId, activity).some(d => d.revision_id === originalId)) throw new Error("Historical original result is superseded");
  for await (const {ref, receipt} of executionReceipts(state)) {
    const b = receipt.binding;
    const inputs = b.inputs as {name: string; revisions: string[]}[];
    const implementation = Array.isArray(inputs) && inputs.find(i => i.name === "implementation")?.revisions?.[0];
    const p = state.data.find(d => d.revision_id === implementation);
    if (!p || p.id !== product.id || !isDeepStrictEqual(b.package, expected.package) || b.repositoryPath !== expected.repositoryPath || b.sourceCommit !== expected.sourceCommit || !isDeepStrictEqual(b.independentVerification, expected.independentVerification) || !isDeepStrictEqual(inputs.find(i => i.name === "requirements"), (expected.inputs as typeof inputs).find(i => i.name === "requirements"))) continue;
    if (ref.endsWith("/latest") && receipt.state === "started") throw new Error("Historical applicability is blocked by an unresolved relevant execution attempt");
    if (receipt.result && receipt.result.startedAt >= verified.saved.receipt.result!.startedAt && receipt.result.outcome !== "pass") throw new Error("Historical applicability is blocked by a later relevant failing or errored execution, including unrecorded results");
  }
  return {verified, original, prior, provenance: {
    contract: "mdlm-verification-applicability@1" as const, original_result: original.revision_id, original_implementation: prior.revision_id,
    receipt: verified.receipt, execution_operation: expected.operation, started_at: verified.saved.receipt.result!.startedAt, finished_at: verified.saved.receipt.result!.finishedAt,
  }};
}
export async function validateHistoricalResult(state: State, datum: DatumEnvelope) {
  const stored = datum.payload.historical_observation as HistoricalObservation | undefined;
  if (!stored) throw new Error("Historical observation provenance is unavailable");
  const product = exact(state, links(datum, "executes")[0] ?? ""), activity = links(datum, "evaluates")[0] ?? "";
  const applicable = await historicalApplicability(state, product, activity, stored.original_result);
  const tx = await resultPublication(state, datum);
  if (!stored.applied_at || tx.evidence?.historicalResult !== stored.original_result || tx.evidence?.receipt !== undefined || !isDeepStrictEqual(stored, {...applicable.provenance, applied_at: stored.applied_at})) throw new Error("Historical observation provenance differs from its authenticated publication");
  authenticateObservation(datum, applicable.verified);
  return {...applicable, stored};
}
export async function validateCurrentHistoricalResults(state: State, product: DatumEnvelope) {
  const historical = links(product, "verification").flatMap(activity => currentVerificationResults(state, product.revision_id, activity)).filter(datum => datum.payload.historical_observation !== undefined);
  const report = progress("historical results", historical.length);
  for (const [index, datum] of historical.entries()) { await validateHistoricalResult(state, datum); report(index + 1); }
}
