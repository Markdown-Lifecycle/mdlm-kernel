import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface IndependentVerification {
  activityRevision: string;
  repositoryPath: string;
  sourceCommit: string;
  scriptPath: string;
  command: string[];
  caseIds: string[];
  resultsPath: string;
}
export interface VerificationCaseResult {
  case_id: string;
  outcome: "pass" | "fail" | "error" | "skipped";
  actual_results: string[];
  evidence_refs: string[];
}
export interface VerificationArtifact {
  path: string;
  sha256: string;
  bytes: number;
  contentBase64: string;
}
export interface CapturedVerificationReport {
  rawReportBase64?: string;
  caseResults: VerificationCaseResult[];
  artifacts: VerificationArtifact[];
  diagnostic?: string;
}
// Base64 expands this limit to under 11 MiB; the receipt reader also allows
// the executor's bounded stdout/stderr, so captured receipts remain readable.
export const VERIFICATION_EVIDENCE_LIMIT = 8 * 1024 * 1024;

export function relativeEvidencePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.startsWith("/")
    && !value.includes("\\") && !value.includes("\0")
    && value.split("/").every(part => !!part && part !== "." && part !== "..");
}
export function validateIndependentVerification(value: IndependentVerification): void {
  if (!value.activityRevision || !Array.isArray(value.caseIds) || !value.caseIds.length
    || value.caseIds.some(id => typeof id !== "string" || !id.trim())
    || new Set(value.caseIds).size !== value.caseIds.length) {
    throw new Error("Independent verification requires an exact activity and distinct nonempty case IDs.");
  }
  if (!relativeEvidencePath(value.resultsPath)) throw new Error("Verification resultsPath must be a relative evidence file.");
}

/** Read only regular files inside the output directory after execution stops. */
async function evidenceFile(root: string, relative: string, remaining: number): Promise<Buffer> {
  if (!relativeEvidencePath(relative)) throw new Error(`Invalid evidence path '${relative}'.`);
  const parts = relative.split("/");
  for (let index = 0; index < parts.length; index++) {
    const entry = await lstat(join(root, ...parts.slice(0, index + 1)));
    if (index === parts.length - 1 ? !entry.isFile() : !entry.isDirectory()) {
      throw new Error(`Evidence '${relative}' must resolve through directories to a regular file; symlinks are unsupported.`);
    }
    if (index === parts.length - 1 && entry.size > remaining) throw new Error("Verification evidence exceeded 8 MiB; capture is incomplete.");
  }
  const bytes = await readFile(join(root, relative));
  if (bytes.length > remaining) throw new Error("Verification evidence exceeded 8 MiB; capture is incomplete.");
  return bytes;
}

type EvidenceReader = (relative: string, remaining: number) => Promise<Buffer>;

/** Validate the declared case set, retaining observed rows and raw bytes on failure. */
export function captureVerificationReport(root: string, definition: IndependentVerification): Promise<CapturedVerificationReport> {
  const read: EvidenceReader = (relative, remaining) => evidenceFile(root, relative, remaining);
  return readVerificationReport(definition, () => read(definition.resultsPath, VERIFICATION_EVIDENCE_LIMIT), read);
}

/** Rebuild the captured report from a receipt's saved report and evidence bytes alone. */
export function recaptureVerificationReport(definition: IndependentVerification, saved: {rawReportBase64?: string; artifacts?: VerificationArtifact[]}): Promise<CapturedVerificationReport> {
  const decode = (relative: string, encoded: unknown, remaining: number) => {
    if (typeof encoded !== "string") throw new Error(`Evidence '${relative}' is not saved in the receipt.`);
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) throw new Error(`Evidence '${relative}' is not canonical base64.`);
    if (bytes.length > remaining) throw new Error("Verification evidence exceeded 8 MiB; capture is incomplete.");
    return bytes;
  };
  return readVerificationReport(definition,
    async () => decode(definition.resultsPath, saved.rawReportBase64, VERIFICATION_EVIDENCE_LIMIT),
    async (relative, remaining) => decode(relative, saved.artifacts?.find(artifact => artifact.path === relative)?.contentBase64, remaining));
}

async function readVerificationReport(definition: IndependentVerification, readReport: () => Promise<Buffer>, read: EvidenceReader): Promise<CapturedVerificationReport> {
  const captured: CapturedVerificationReport = {caseResults: [], artifacts: []};
  const errors: string[] = [];
  try {
    const bytes = await readReport();
    captured.rawReportBase64 = bytes.toString("base64");
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Verification report must be an object.");
    const report = parsed as Record<string, unknown>;
    if (report.contract !== "mdlm-verification-results@1" || !Array.isArray(report.cases)) throw new Error("Verification report requires mdlm-verification-results@1 and cases.");
    const expected = new Set(definition.caseIds);
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(part => typeof part === "string" && part.trim().length > 0);
    for (const value of report.cases) {
      if (!value || typeof value !== "object" || Array.isArray(value)) { errors.push("Invalid case result."); continue; }
      const row = value as Record<string, unknown>;
      if (typeof row.case_id !== "string" || !expected.has(row.case_id)) { errors.push(`Unknown case ID '${String(row.case_id)}'.`); continue; }
      if (seen.has(row.case_id)) { duplicates.add(row.case_id); errors.push(`Duplicate case ID '${row.case_id}'.`); continue; }
      seen.add(row.case_id);
      if (!["pass", "fail", "error", "skipped"].includes(String(row.outcome))
        || !strings(row.actual_results) || !row.actual_results.length || !strings(row.evidence_refs)
        || row.evidence_refs.some(ref => !relativeEvidencePath(ref))) {
        errors.push(`Invalid result for case '${row.case_id}'; outcome, observations and relative evidence references are required.`); continue;
      }
      captured.caseResults.push({case_id: row.case_id, outcome: row.outcome as VerificationCaseResult["outcome"], actual_results: row.actual_results, evidence_refs: row.evidence_refs});
    }
    captured.caseResults = captured.caseResults.filter(row => !duplicates.has(row.case_id));
    for (const id of expected) if (!captured.caseResults.some(row => row.case_id === id)) errors.push(`Missing valid result for case '${id}'.`);
    let remaining = VERIFICATION_EVIDENCE_LIMIT - bytes.length;
    for (const file of new Set(captured.caseResults.flatMap(row => row.evidence_refs))) {
      try {
        const content = await read(file, remaining);
        remaining -= content.length;
        captured.artifacts.push({path: file, sha256: createHash("sha256").update(content).digest("hex"), bytes: content.length, contentBase64: content.toString("base64")});
      } catch (error) { errors.push(`Evidence '${file}' unavailable: ${error instanceof Error ? error.message : String(error)}`); }
    }
  } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  if (errors.length) captured.diagnostic = errors.join(" ");
  return captured;
}

/** A successful process alone cannot establish that the declared cases passed. */
export function verificationReportOutcome(report: CapturedVerificationReport, exitCode: number | null): {outcome: "pass" | "fail" | "error"; diagnostic?: string} {
  if (report.diagnostic) return {outcome: "error", diagnostic: report.diagnostic};
  const incomplete = report.caseResults.some(row => row.outcome === "error" || row.outcome === "skipped");
  const failed = report.caseResults.some(row => row.outcome === "fail");
  const expectedExit = incomplete ? 2 : failed ? 1 : 0;
  if (exitCode !== expectedExit) return {outcome: "error", diagnostic: `Verification report requires exit ${expectedExit}, but script exited with ${exitCode}.`};
  return incomplete ? {outcome: "error", diagnostic: "Verification contains errored or skipped cases."} : {outcome: failed ? "fail" : "pass"};
}
