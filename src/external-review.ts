import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { DirectReviewContext } from "./direct-review-context.js";
import { canonicalDigest } from "./json-stream.js";

export interface ExternalReviewProof {
  contract: "mdlm-registered-review@2";
  operation: string;
  contextSha256: string;
  verdictSha256: string;
  proposalSha256: string;
}
interface RegisteredReview extends ExternalReviewProof { verdict: string }
export const reviewDigest = (source: string): string => createHash("sha256").update(source).digest("hex");
/** SHA-256 of the canonical review packet (sorted keys), streamed so no packet string is built. */
export const reviewPacketDigest = canonicalDigest;
async function registryFile(root: string, operation: string): Promise<string> {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(operation)) throw new Error("Invalid review operation identity");
  const configured = process.env.MDLM_REVIEW_REGISTRY;
  if (!configured || !path.isAbsolute(configured)) throw new Error("MDLM_REVIEW_REGISTRY must select the manager-owned absolute registry directory at launch");
  const registry = await fs.realpath(configured), repository = await fs.realpath(root);
  if (registry === repository || registry.startsWith(`${repository}${path.sep}`)) throw new Error("The review registry must be outside the lifecycle repository");
  // Scope caller-selected operation IDs to the exact lifecycle repository.
  return path.join(registry, `${reviewDigest(repository)}-${operation}.json`);
}
function proof(operation: string, context: DirectReviewContext, verdict: string, proposal: string): ExternalReviewProof {
  return {contract: "mdlm-registered-review@2", operation, contextSha256: reviewPacketDigest(context), verdictSha256: reviewDigest(verdict), proposalSha256: reviewDigest(proposal)};
}
export function validateReviewerVerdict(proposalSource: string, verdictSource: string): void {
  const proposal = JSON.parse(proposalSource), verdict = JSON.parse(verdictSource);
  const candidates = Array.isArray(verdict) ? verdict : verdict?.candidates;
  if (!Array.isArray(candidates) || !isDeepStrictEqual(candidates, proposal.candidates)) throw new Error("Proposal candidates differ from the independent reviewer's exact verdict");
}
/** Manager transport only. This role switch is not an OS identity or forgery boundary. */
export async function registerExternalReview(root: string, operation: string, context: DirectReviewContext, verdict: string, proposal: string): Promise<ExternalReviewProof> {
  if (process.env.MDLM_REVIEW_REGISTRAR !== "1") throw new Error("Review registration requires the manager's MDLM_REVIEW_REGISTRAR=1 environment; authors only submit the relayed verdict");
  validateReviewerVerdict(proposal, verdict);
  const binding = proof(operation, context, verdict, proposal);
  const file = await registryFile(root, operation), source = `${JSON.stringify({...binding, verdict})}\n`;
  const history = path.join(path.dirname(file), "artifacts");
  await fs.mkdir(history, {recursive: true});
  const artifact = path.join(history, `${reviewDigest(source)}.json`);
  try { await fs.writeFile(artifact, source, {flag: "wx", mode: 0o600}); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await fs.readFile(artifact, "utf8") !== source) throw error; }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, source, {flag: "wx", mode: 0o600}); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, {force: true}); }
  return binding;
}
export async function requireExternalReview(root: string, operation: string, context: DirectReviewContext, proposalSource: string): Promise<ExternalReviewProof> {
  const registered = JSON.parse(await fs.readFile(await registryFile(root, operation), "utf8")) as RegisteredReview;
  if (typeof registered.verdict !== "string") throw new Error("Registered review has no exact verdict bytes");
  validateReviewerVerdict(proposalSource, registered.verdict);
  const expected = proof(operation, context, registered.verdict, proposalSource);
  for (const key of Object.keys(expected) as (keyof ExternalReviewProof)[]) {
    if (registered[key] !== expected[key]) throw new Error(`Registered review ${key} does not match this exact direct proposal`);
  }
  return expected;
}
