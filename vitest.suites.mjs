// Current supported behavior only. Historical qualification evidence remains in
// its owning release; deleted workflow tests are not a second supported suite.
const fast = [
  "review-recovery-public", "process-upgrade-public", "process-distribution-public", "configuration-impact-public", "late-requirement-correction-public", "new-root-change-public", "preacceptance-refinement-public", "preacceptance-refinement-package",
  "prototype-interface-public", "requirement-levels-package", "requirement-levels-public", "route-expectations-public", "prototype-correction-package", "prototype-correction-public", "optional-formalization-public",
  "independent-verification-package", "independent-verification-public", "verification-applicability-public", "verification-authoring-upgrade", "verification-coverage-changes-public", "array-expression", "change-assessment", "direct-authority", "direct-domain", "direct-package", "direct-receipt", "execution-dry-run",
  "direct-selection-public", "iterative-public", "iterative-maintenance-reuse", "kernel-cutover", "lifecycle-schema-diagnostics", "mdlm-cli-output",
  "release-candidate-gate", "digest-vectors", "requirement-trace-v2", "source-scopes", "review-lineage", "review-checkpoint-resume", "direct-proposal-schema",
];
const release = ["maintenance-summary-public", "independent-verification-execution","docker-verification-dialogue", "direct-lifecycle-public", "verification-applicability-upgrade-public"];
export const rootTestManifest = Object.freeze([
  ...fast.map(name => ({file:`test/${name}.test.ts`, qualificationGate:"pr", runtimeClass:"cheap-in-process", weight:1})),
  ...release.map(name => ({file:`test/${name}.test.ts`, qualificationGate:"release", runtimeClass:"process-repository-safe", weight:1})),
].map(Object.freeze));
export const rootTestQualificationManifest = rootTestManifest;
export const testFiles = rootTestManifest.map(row => row.file);
export const rootVitestSuites = ["cheap-in-process", "process-repository-safe"].map(id => ({
  id, weight:1, files:rootTestManifest.filter(row => row.runtimeClass === id).map(row => row.file),
}));
export const mdlmPiTestFiles = ["mdlm-client-v2", "operator-loop", "pi-work-runner", "operator-io", "operational-failure", "submission-journal", "run-lock"].map(name => `packages/mdlm-pi/test/${name}.test.ts`);
