import type { DockerVerificationResult } from "./docker-verification.js";

/** Secret classes from ADR-0009 section 3. Each names a leak, never the leaked value. */
export const SECRET_PATTERNS = {
  "aws-access-key-id": /(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/,
  "aws-secret-access-key": /(?:aws_?)?secret_?access_?key["']?\s*[:=]\s*["']?[A-Za-z0-9/+]{16,}/i,
  "aws-session-token": /(?:(?:aws_?)?session_?token|x-amz-security-token)["']?\s*[:=]\s*["']?[A-Za-z0-9/+]{16,}/i,
  "authorization-header": /\bauthorization["']?\s*[:=]\s*["']?(?:bearer|basic|token|digest|negotiate|aws4-hmac-sha256)\s+\S{8,}/i,
  "private-key-block": /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/,
} as const;
export type SecretPattern = keyof typeof SECRET_PATTERNS;

/** One match: the pattern class, the stored field it was found in, and the byte
 * offset of the match within that field's bytes (decoded bytes for base64 fields). */
export interface SecretFinding {
  pattern: SecretPattern;
  field: string;
  offset: number;
}

/** Scan one field. Reports the first match of each pattern class. */
export function scanForSecrets(field: string, content: Buffer | string): SecretFinding[] {
  // Latin-1 maps each byte to one code unit, so match indexes are byte offsets.
  const text = (typeof content === "string" ? Buffer.from(content, "utf8") : content).toString("latin1");
  const findings: SecretFinding[] = [];
  for (const [pattern, expression] of Object.entries(SECRET_PATTERNS) as [SecretPattern, RegExp][]) {
    const match = expression.exec(text);
    if (match) findings.push({pattern, field, offset: match.index});
  }
  return findings;
}

/** Scan every stored value of a runtime result. Fields ending in `Base64` are scanned as decoded bytes. */
export function scanStoredValue(value: unknown, field = ""): SecretFinding[] {
  if (typeof value === "string") return scanForSecrets(field, field.endsWith("Base64") ? Buffer.from(value, "base64") : value);
  if (Array.isArray(value)) return value.flatMap((item, index) => scanStoredValue(item, `${field}[${index}]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, item]) => scanStoredValue(item, field ? `${field}.${key}` : key));
  return [];
}

const cleared = (value: unknown) => Array.isArray(value) ? [] : typeof value === "string" ? "" : undefined;

/** Refuse a runtime result that contains a secret pattern before it is stored.
 * The refused result is an `error` that names each finding, and every top-level
 * field with a match is emptied, so nothing from a matching stream is written. */
export function refuseSecretResult(result: DockerVerificationResult): DockerVerificationResult {
  const findings = scanStoredValue(result);
  if (!findings.length) return result;
  const refused: Record<string, unknown> = {...result};
  for (const key of new Set(findings.map(finding => /^[^.[]+/.exec(finding.field)![0]))) {
    const value = cleared(refused[key]);
    if (value === undefined) delete refused[key]; else refused[key] = value;
  }
  const summary = findings.map(finding => `${finding.pattern} in ${finding.field} at byte ${finding.offset}`).join("; ");
  const kept = typeof refused.diagnostic === "string" && refused.diagnostic ? ` ${refused.diagnostic}` : "";
  return {...refused as unknown as DockerVerificationResult, outcome: "error", secretFindings: findings,
    diagnostic: `Receipt refused: captured output contains secret patterns (${summary}). Fix the leak in the product or verifier; MDLM does not store or redact it.${kept}`};
}
