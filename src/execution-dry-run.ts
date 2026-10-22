import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify, isDeepStrictEqual } from "node:util";
import type { DatumEnvelope } from "./index.js";
import { authenticateProductSource, authenticateVerificationSource, executeDockerVerification, type DockerVerificationResult } from "./docker-verification.js";
import { directState } from "./direct-proposal.js";
import { independentBinding, independentExecutionBinding, selectedActivities } from "./independent-verification.js";
import { repositoryGitEnvironment } from "./git-environment.js";
import { refuseSecretResult } from "./secret-scan.js";
import { DRY_RUN_CONTRACT, type VerificationBinding } from "./verification-receipt.js";

// A fixed non-operation identity: dry runs register no execution refs.
const DRY_RUN_OPERATION = "dry-run";
const exec = promisify(execFile);
const sha256 = (value: unknown) => `sha256:${createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex")}`;
async function git(cwd: string, args: string[]) {
  return (await exec("git", ["-C", cwd, ...args], {env: repositoryGitEnvironment(), maxBuffer: 64 * 1024 * 1024})).stdout;
}

export interface DryRunComponents {
  activityText: string;
  verifier: string;
  runtime: {image: string; kernel: string};
  productInputs: {scope: "activity-paths" | "declared-paths" | "whole-tree"; digest: string};
}
const reasons: Record<keyof DryRunComponents, string> = {
  activityText: "activity-text-changed",
  verifier: "verifier-changed",
  runtime: "runtime-changed",
  productInputs: "product-inputs-changed",
};
interface CacheEntry {contract: typeof DRY_RUN_CONTRACT; credit: false; product: string; activity: string; sourceCommit: string; components: DryRunComponents; result: DockerVerificationResult}

async function kernelVersion() {
  return (JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8")) as {version: string}).version;
}

const entryPath = (entry: string) => entry.slice(entry.indexOf("\t") + 1);
/** Committed entries as git archive exports them. Committed .gitattributes can drop
 * files (export-ignore) or write commit metadata (export-subst), so a substituting
 * source is keyed on its commit as well as its tree. */
async function archiveIdentity(repository: string, commit: string) {
  const entries = (await git(repository, ["ls-tree", "-rz", "--full-tree", commit])).split("\0").filter(Boolean);
  const attributes = entries.filter(entry => path.posix.basename(entryPath(entry)) === ".gitattributes").sort();
  const substituted = (await Promise.all(attributes.map(entry => git(repository, ["cat-file", "blob", entry.split(/\s/)[2]!])))).some(source => source.includes("export-subst"));
  return {entries, attributes, commit: substituted ? commit : undefined};
}

/** Everything the native runtime can observe for one activity, keyed by content rather than commit identity. */
export async function dryRunComponents(activity: DatumEnvelope, binding: VerificationBinding, kernel: string): Promise<DryRunComponents> {
  const verifier = binding.independentVerification;
  if (!verifier) throw new Error("Dry run requires an independent verification binding");
  // Verifier location, commit and image have their own components below.
  const {source_commit: _commit, repository_path: _path, verification_image: _image, ...text} = activity.payload;
  const product = await authenticateProductSource(binding);
  const archived = await archiveIdentity(binding.repositoryPath, product.sourceCommit);
  let productInputs: DryRunComponents["productInputs"] = {scope: "whole-tree", digest: archived.commit ? sha256({tree: product.sourceTree, commit: archived.commit}) : product.sourceTree};
  if (binding.formalFiles) {
    // The runtime mounts only declared files, so only their committed bytes and modes matter.
    const declared = new Set(binding.formalFiles);
    productInputs = {scope: "declared-paths", digest: sha256({files: [...declared].sort(), entries: archived.entries.filter(entry => declared.has(entryPath(entry))).sort(), attributes: archived.attributes, commit: archived.commit})};
  }
  const globs = activity.payload.product_paths;
  if (globs !== undefined) {
    // The activity's own claim of what it exercises. Only dry runs trust it; credit runs still mount everything.
    if (!Array.isArray(globs) || !globs.length || globs.some(glob => typeof glob !== "string" || !glob.trim())) throw new Error("Activity product_paths must be a nonempty array of nonblank globs");
    const mounted = binding.formalFiles ? new Set(binding.formalFiles) : undefined;
    const entries = archived.entries.filter(entry => (!mounted || mounted.has(entryPath(entry))) && globs.some(glob => path.posix.matchesGlob(entryPath(entry), glob)));
    productInputs = {scope: "activity-paths", digest: sha256({globs: [...globs].sort(), formalFiles: binding.formalFiles ? [...binding.formalFiles].sort() : undefined, entries: entries.sort(), attributes: archived.attributes, commit: archived.commit})};
  }
  const verifierTree = (await authenticateVerificationSource(verifier)).sourceTree;
  const verifierCommit = (await archiveIdentity(verifier.repositoryPath, verifier.sourceCommit)).commit;
  return {
    activityText: sha256({type: activity.type, payload: text, body: activity.body, links: activity.links}),
    verifier: verifierCommit ? sha256({tree: verifierTree, commit: verifierCommit}) : verifierTree,
    runtime: {image: binding.image, kernel},
    productInputs,
  };
}

export interface DryRunActivityInput {product: DatumEnvelope; activity: DatumEnvelope; binding: VerificationBinding}
export interface DryRunActivityResult {
  activity: string;
  outcome: "pass" | "fail" | "error";
  cache: "hit" | "miss";
  invalidatedBy: string[];
  failingCases: {case_id: string; outcome: string; actual_results: string[]}[];
  diagnostic?: string;
  sourceCommit: string;
  productInputs?: DryRunComponents["productInputs"];
  ranAt?: string;
}

/** Run each activity in the native runtime unless an equal-input result is cached. Writes only the cache directory. */
export async function dryRunActivities(cacheDirectory: string, inputs: DryRunActivityInput[], all: boolean, execute = executeDockerVerification): Promise<DryRunActivityResult[]> {
  const kernel = await kernelVersion();
  const results: DryRunActivityResult[] = [];
  for (const {product, activity, binding} of inputs) {
    const base = {activity: activity.revision_id, sourceCommit: binding.sourceCommit};
    let components: DryRunComponents;
    try { components = await dryRunComponents(activity, binding, kernel); }
    catch (error) {
      results.push({...base, outcome: "error", cache: "miss", invalidatedBy: ["inputs-unavailable"], failingCases: [], diagnostic: error instanceof Error ? error.message : String(error)});
      continue;
    }
    // One slot per product and activity lineage, so a changed revision reports why it reran.
    const file = path.join(cacheDirectory, `${createHash("sha256").update(`${product.id}\0${activity.id}`).digest("hex")}.json`);
    const previous = await fs.readFile(file, "utf8").then(source => JSON.parse(source) as CacheEntry, () => undefined);
    const valid = previous?.contract === DRY_RUN_CONTRACT && previous.components ? previous : undefined;
    const changed = valid ? (Object.keys(reasons) as (keyof DryRunComponents)[]).filter(key => !isDeepStrictEqual(valid.components[key], components[key])).map(key => reasons[key]) : ["no-cached-result"];
    const hit = !all && valid !== undefined && changed.length === 0;
    let result: DockerVerificationResult;
    if (hit) result = valid.result;
    else {
      result = refuseSecretResult(await execute(binding));
      // Only completed container runs are reproducible readiness evidence; setup failures rerun next time.
      if (result.started) {
        const entry: CacheEntry = {contract: DRY_RUN_CONTRACT, credit: false, product: product.revision_id, activity: activity.revision_id, sourceCommit: binding.sourceCommit, components, result};
        await fs.mkdir(cacheDirectory, {recursive: true});
        const temporary = `${file}.${randomUUID()}.tmp`;
        await fs.writeFile(temporary, `${JSON.stringify(entry)}\n`);
        await fs.rename(temporary, file);
      }
    }
    results.push({
      ...base, outcome: result.outcome, cache: hit ? "hit" : "miss",
      invalidatedBy: hit ? [] : all ? ["forced", ...changed] : changed,
      failingCases: (result.caseResults ?? []).filter(row => row.outcome !== "pass").map(({case_id, outcome, actual_results}) => ({case_id, outcome, actual_results})),
      ...(result.diagnostic ? {diagnostic: result.diagnostic} : {}),
      productInputs: components.productInputs, ranAt: result.startedAt,
    });
  }
  return results;
}

export async function runExecutionDryRun(root: string, subject: string, options: {activities: string[]; all: boolean; source?: string | undefined}) {
  const current = await directState(root);
  if (!independentBinding(current.pkg)) throw new Error("Execution dry run requires a package with independent-verification@1");
  const product = current.data.find(d => d.revision_id === subject);
  if (!product) throw new Error(`Unknown exact execution subject '${subject}'`);
  const selection = selectedActivities(current, product);
  const unknown = options.activities.filter(id => !selection.some(a => a.revision_id === id));
  if (unknown.length) throw new Error(`Activities are not in the product's exact verification selection: ${unknown.join(", ")}`);
  const activities = options.activities.length ? selection.filter(a => options.activities.includes(a.revision_id)) : selection;
  const inputs = activities.map(activity => {
    const binding = independentExecutionBinding(current, product, activity.revision_id, DRY_RUN_OPERATION);
    return {product, activity, binding: options.source ? {...binding, sourceCommit: options.source} : binding};
  });
  const cacheDirectory = path.resolve(root, (await git(root, ["rev-parse", "--git-path", "mdlm-dry-run"])).trim());
  const results = await dryRunActivities(cacheDirectory, inputs, options.all);
  const count = (outcome: string) => results.filter(r => r.outcome === outcome).length;
  const summary = {activities: results.length, pass: count("pass"), fail: count("fail"), error: count("error"), cacheHits: results.filter(r => r.cache === "hit").length, ran: results.filter(r => r.cache === "miss").length};
  return {ok: true, contract: DRY_RUN_CONTRACT, credit: false, product: product.revision_id, sourceCommit: options.source ?? String(product.payload.source_commit), ready: results.length > 0 && summary.pass === results.length, summary, activities: results, cache: cacheDirectory};
}

export function renderExecutionDryRun(result: Awaited<ReturnType<typeof runExecutionDryRun>>): string {
  const s = result.summary;
  return [
    `Dry run (non-credit) of ${result.product} at ${result.sourceCommit}: ${result.ready ? "ready" : "not ready"}`,
    `${s.activities} ${s.activities === 1 ? "activity" : "activities"}: ${s.pass} pass, ${s.fail} fail, ${s.error} error; ${s.cacheHits} cached, ${s.ran} ran`,
    ...result.activities.map(a => `${a.activity} | ${a.outcome} | ${a.cache}${a.invalidatedBy.length ? ` (${a.invalidatedBy.join(", ")})` : ""}${a.failingCases.length ? ` | failing: ${a.failingCases.map(c => c.case_id).join(", ")}` : ""}${a.diagnostic ? ` | ${a.diagnostic}` : ""}`),
  ].join("\n");
}
