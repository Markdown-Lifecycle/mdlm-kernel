import { createHash } from "node:crypto";

/** Stands in for a passing container run while keeping the real source authentication. */
export async function simulatedDockerVerification(actual: {authenticateProductSource: (input: any) => Promise<object>; authenticateVerificationSource: (input: any) => Promise<{scriptSha256: string}>}, input: any) {
  const independent = input.independentVerification;
  const startedAt = new Date().toISOString();
  const verifier = await actual.authenticateVerificationSource(independent);
  const report = {contract: "mdlm-verification-results@1", cases: independent.caseIds.map((id: string) => ({case_id: id, outcome: "pass", actual_results: ["2\n", "exit 0"], evidence_refs: ["observation.txt"]}))};
  const observation = Buffer.from("2\n");
  return {
    ...await actual.authenticateProductSource(input), scriptSha256: verifier.scriptSha256, image: input.image, imageDigest: input.image.slice(input.image.indexOf("@") + 1), imageId: `sha256:${"0".repeat(64)}`,
    command: [...independent.command], scriptPath: independent.scriptPath, stdoutBase64: "", stderrBase64: "", exitCode: 0, outcome: "pass", started: true, phase: "execution",
    startedAt, finishedAt: new Date().toISOString(), independentVerification: {...verifier, activityRevision: independent.activityRevision},
    caseResults: report.cases, artifacts: [{path: "observation.txt", sha256: createHash("sha256").update(observation).digest("hex"), bytes: observation.length, contentBase64: observation.toString("base64")}],
    rawReportBase64: Buffer.from(JSON.stringify(report)).toString("base64"),
  };
}
