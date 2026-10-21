import type { DatumEnvelope, ProcessPackage } from "./index.js";
import type { ProcessSelection } from "./repository-contract.js";

export interface DirectPackageIdentity { reference: string; digest: string; language: string }
export type DirectActionKind = "verification-activity" | "independent-result" | "requirements" | "implementation" | "verification-result" | "review" | "acceptance" | "change" | "experiment" | "prototype" | "observation" | "feedback" | "deployment";
export interface DirectAction {
  id: string;
  version: number;
  kind: "action-definition";
  description?: string;
  capability: DirectActionKind;
  prompt_ref: string;
  types: string[];
  subjects?: string;
  inputs?: Record<string, string>;
  when?: string;
  priority?: number;
  optional?: boolean;
  links?: Record<string, Record<string,string>>;
  revises?: Record<string,string>;
  fixed_payload?: Record<string,Record<string,unknown>>;
  authority?: { kind: "independent-review" | "stakeholder"; name: string };
  [key: string]: unknown;
}
export interface DirectCandidate {
  localId: string;
  type: string;
  predecessor?: string;
  payload: Record<string, unknown>;
  links: {type: string; target: string}[];
  body: string;
}
export interface DirectProposal {
  operation: string;
  action: string;
  package: DirectPackageIdentity;
  snapshot: string;
  subject?: string;
  inputs?: Record<string, string[]>;
  candidates: DirectCandidate[];
  evidence?: {historicalResult?: string; receipt?: string; review?: unknown; authority?: string[]};
}
export interface DirectContext {
  root: string;
  pkg: ProcessPackage;
  package: DirectPackageIdentity;
  snapshot: string;
  data: DatumEnvelope[];
  /** Internal authenticated upgrade history; never supplied by a proposal. */
  authoringSelections?: readonly ProcessSelection[];
  action: DirectAction;
  subject?: string;
  inputs: Record<string, string[]>;
}
export interface DirectWorkItem {
  action: string;
  subject?: string;
  reason: string;
  blocked?: string[];
  inputs?: Record<string, string[]>;
  optional?: boolean;
  priority?: number;
}
export interface DirectFinalizationContext extends DirectContext {
  proposal: DirectProposal;
  /** Kernel-assigned identities and resolved local references. */
  outputs: DatumEnvelope[];
}
export interface DirectFinalizationResult {
  outputs: DatumEnvelope[];
  /** Only values derived by a kernel service may be listed here. */
  managedOutputs: DatumEnvelope[];
}
export interface DirectTransaction {
  contract: "mdlm-direct-transaction@1";
  id: string;
  operation: string;
  action: string;
  proposalDigest: string;
  package: DirectPackageIdentity;
  snapshot: string;
  subject?: string;
  inputs: Record<string, string[]>;
  outputs: DatumEnvelope[];
  evidence?: DirectProposal["evidence"];
  authority?: unknown;
}
export interface SourceAssessmentTargets {
  field: "source_assessments[].source_scope";
  sourceScopes: string[];
  instruction: string;
}
export interface DirectGuidance {
  contract: "mdlm-direct-guidance@1";
  action: string;
  subject?: string;
  package: DirectPackageIdentity;
  snapshot: string;
  inputs: Record<string, string[]>;
  prompt: unknown;
  payloadSchemas: Record<string, unknown>;
  sourceAssessmentTargets?: SourceAssessmentTargets | undefined;
  context: DatumEnvelope[];
  candidates: DirectCandidate[];
  effectiveAuthority: NonNullable<DirectAction["authority"]> | {kind: "autonomous"};
  authority?: DirectAction["authority"];
  evidence?: unknown;
  executionCommand?: string;
  executionSubject?: string;
  receiptDetails?: unknown[];
}
export interface DirectExpectations {
  ok: true;
  contract: "mdlm-expectations@2";
  package: DirectPackageIdentity;
  snapshot: string;
  items: DirectWorkItem[];
  optional: DirectWorkItem[];
  outcome: "work-available" | "blocked" | "profile-boundary-reached" | "lifecycle-complete";
}
export interface DirectProposalResult {
  ok: true;
  contract: "mdlm-proposal-result@2";
  operation: string;
  outcome: "accepted" | "not-published";
  transaction?: string;
  revisions?: string[];
  proposalDigest?: string;
}
export interface DirectExecutionResult {
  ok: true;
  contract: "mdlm-execution-result@1";
  operation: string;
  value: {state?: string; evidence?: string; [key: string]: unknown};
}
