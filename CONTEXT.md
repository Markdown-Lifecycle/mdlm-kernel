# Markdown Lifecycle Manager

MDLM models durable product intent, engineering definition, review, evidence, and
remaining engineering work through versioned lifecycle data and a declarative process.

## Lifecycle data

**Lifecycle Datum**:
A durable typed claim stored as Markdown and identified independently from its revisions.
_Avoid_: Artifact when specifically referring to lifecycle truth, record

**Stable Datum**:
The conceptual lifecycle datum that persists across revisions and is named by a stable ID.
_Avoid_: Latest version, document

**Revision**:
One exact version of a stable datum, named by a revision ID and immutable once frozen.
_Avoid_: Version when exact lifecycle identity is intended

**Datum Envelope**:
The kernel-owned identity, revision, links, provenance, payload container, and body shared by every lifecycle datum.
_Avoid_: Common template, base type

**Payload**:
The process-defined fields carrying the type-specific claim inside a datum envelope.
_Avoid_: Metadata when referring to substantive lifecycle content

**Payload Template**:
A reusable additive definition of payload fields and constraints inherited by lifecycle types.
_Avoid_: Base class, mixin

## Process model

**Kernel**:
The fixed integrity and storage semantics that a process package cannot weaken, including identity, immutability, hashing, graph traversal, and deterministic evaluation.
_Avoid_: Process engine when referring only to fixed primitives

**Process Package**:
Versioned declarative data defining lifecycle types, states, selectors, actions, prompts, authority requirements, and terminal conditions.
_Avoid_: Workflow, configuration when its normative role matters

**Example Process Package**:
A complete installable process package shipped to demonstrate one lifecycle structure without making that structure part of MDLM core semantics.
_Avoid_: The MDLM process, built-in workflow, default model

**Kernel Capability**:
A versioned opt-in contract by which a process type receives a fixed kernel service, such as committed execution evidence or source attribution, without requiring a particular type ID.
_Avoid_: Hard-coded lifecycle type, plugin

**Primitive**:
A typed kernel-supplied value, collection, or relation from which process conclusions are derived.
_Avoid_: Fact when it already encodes a process-specific conclusion

**Relation**:
A kernel-supplied graph traversal such as incoming links, baseline members, revisions, or dependency changes.
_Avoid_: Relationship when referring to the evaluator operation

**Selector**:
A named parameterized query that derives a reusable set of lifecycle entities or records from primitives.
_Avoid_: Filter when referring to the complete reusable query

**Policy**:
A deterministic prioritized decision table returning a typed result from declared inputs.
_Avoid_: Guideline when the result controls machine behavior

**Computed State**:
One derived dimension of lifecycle interpretation, such as maturity, disposition, validity, or an overlay.
_Avoid_: Status, lifecycle state

**MDLM Expression Language**:
The safe versioned textual language used wherever process data declares a value, condition, predicate, binding, or quantifier.
_Avoid_: Universal language, YAML expression tree, script

## Direct lifecycle work

**Action**:
A package-defined kind of lifecycle publication, with its eligible context, allowed outputs, guidance and any required authority.
_Avoid_: Assignment, Scenario, reserved task

**Expectation**:
A read-only report of available lifecycle work for an action and its exact subject and inputs. Optional actions remain available without preventing a package endpoint.
_Avoid_: Work lease, mandatory next command

**Loose End**:
Remaining engineering work identified from current lifecycle data, such as missing review evidence or a correction needed after failure.
_Avoid_: Persisted task, allocated Assignment

**Guidance**:
The package prompt, authorable data shapes, exact context and evidence information for a chosen action.
_Avoid_: Assignment Packet, authority to publish

**Direct Proposal**:
Candidate lifecycle data offered for an action against an exact package and repository snapshot, with an operation identity and supporting evidence. It becomes lifecycle truth only after validation and atomic publication.
_Avoid_: Published data, direct file edit

**Candidate**:
One proposed new datum or revision within a Direct Proposal; candidates in the same proposal may refer to each other before their durable identities are assigned.
_Avoid_: Accepted revision, independently published batch member

**Direct Transaction**:
The durable record of one accepted proposal and all its published outputs, bound to the exact operation, package, snapshot and evidence.
_Avoid_: Assignment completion, mutable work status

**Operation Identity**:
A caller-selected identity binding one publication or execution attempt to its recorded result.
_Avoid_: Work claim, permission token

**Settlement**:
Authenticated recovery of an operation's recorded result without repeating completed publication or execution.
_Avoid_: Retry, reconstructed success

**Execution Receipt**:
Captured command output and execution status bound to the exact source, execution context and operation.
_Avoid_: Author-reported result, stakeholder acceptance

**Correction**:
A same-lineage replacement that addresses exact failure evidence while retaining the failed revision and judgment.
_Avoid_: Retry without new evidence, Change Request when no accepted definition changes

**Expectations Outcome**:
The current discovery result: work available, blocked, profile boundary reached, or lifecycle complete.
_Avoid_: Selected next Assignment, hidden workflow cursor

**Profile Boundary**:
A package-declared successful stop that intentionally omits further lifecycle breadth without claiming the lifecycle is complete.
_Avoid_: Blocked work, Lifecycle Complete

**Package Liveness Defect**:
A reachable unfinished state where the package offers no eligible action that can advance the work despite the required authority and evidence being available.
_Avoid_: Missing stakeholder decision, intentional package endpoint

**Authority Requirement**:
An action's declaration that publication needs independent review or a named stakeholder authority.
_Avoid_: Permission inferred from prompt prose, authority supplied by the author alone

**Authority Supply**:
An explicit assertion of the named stakeholder authority authorizing a proposal, supplied independently of model-authored candidate data.
_Avoid_: Reviewer label, implicit approval from continuation

**Authority Evidence**:
The exact judgment and context supporting an authorized publication. Independent review registration and stakeholder authority supply establish different claims.
_Avoid_: Completion summary, execution success, unregistered self-review

**Authority-Evidence Type**:
A lifecycle type protected because a selected-package action publishes it under an authority requirement.
_Avoid_: Protection inferred from a datum's claimed author

## Definition and decomposition

**Accepted Requirement Revision**:
An exact requirement Revision that has received the review or acceptance required by its selected Process Package. Requirement review and inclusion in an accepted product baseline are distinct claims.
_Avoid_: Latest requirement, acceptance inferred without the selected package's rule

**Decomposition Group (DCP)**:
One exact parent requirement and its complete group of immediate child requirements. Each child's validity under that parent and the group's collective adequacy are separate judgments.
_Avoid_: Decomposition work package

**Requirement Level**:
An optional `system`, `high-level` or `low-level` tag on a software requirement in a multi-component product, with a `component` tag for the last two. Among software requirements, only low-level ones may name implementation technology. A component rewrite retains every requirement and interface clause whose meaning stays valid, at any level. Single-component products normally omit levels.
_Avoid_: Mandatory tiers, a separate type per level

**Requirement Set (RQS)**:
An exact selection of requirements and their decomposition groups for a product. Explicit retirements exclude requirements from a successor selection without changing historical selections.
_Avoid_: Latest requirements, mutable graph

## Problem and change control

**Change Request (CHG)**:
A bounded request to change an accepted product, with an exact baseline, affected requirement targets, a reason and a requested outcome. Approval authorizes its scope; later acceptance records its closure.
_Avoid_: Problem Report, generic task, mutable change status

**Evidence reuse**:
Continued use of exact historical evidence whose declared dependencies have not materially changed; authorization history remains intact even when reuse becomes Stale.
_Avoid_: Treating all nearby evidence as affected

## Process assessment

**Scope reduction**:
Observed removal of challenged behavior or lifecycle content, recorded separately from simplification ceremony that retains everything.
_Avoid_: Review completion, scope clarification without removal

## Review and authorization

**Review Context**:
The exact subject, lifecycle context, committed source and captured evidence needed for an independent judgment.
_Avoid_: Snapshot when its review purpose matters

**Review Finding**:
A structured concern inside one exact Review naming its exact target, relationship, severity, summary, and optional evidence; package rules may turn blocking findings into Correction work.
_Avoid_: Generic comment, mutable annotation

**Accepted Baseline**:
An immutable product definition with the required authorization and supporting evidence. In the tiny process, stakeholder acceptance establishes the exact requirements, decomposition, implementation and verification that belong to it.
_Avoid_: Current baseline

**Process Drift**:
An informational difference between recorded process provenance and the currently resolved process package.
_Avoid_: Staleness when no lifecycle dependency changed

**Stale**:
A validity result meaning a declared dependency changed and an earlier claim requires reassessment before reuse.
_Avoid_: Invalid, outdated

**Invalid**:
A validity result meaning structural integrity, identity, schema, reference, or applicable hash guarantees are broken.
_Avoid_: Stale

## Historical vocabulary

**Assignment, Scenario and Obligation**:
Historical work-allocation and dispatch concepts from the replaced kernel. Their packets, responses, resolver bindings and leases are not part of current direct lifecycle work.
_Avoid_: Using historical contracts to operate the current kernel

**Phase progression and gate machinery**:
Historical process scheduling concepts, including gate sign-offs, standing delegations, attention schedules and consolidation groups. Current packages declare their eligible actions and terminal conditions directly.
_Avoid_: Assuming retained historical evidence implies current runtime support

## Interfaces

**Interface Control Document (ICD)**:
A versioned agreement describing both sides of a meaningful boundary, their responsibilities, exchanged information, failure behavior and assumptions. It can contain provisional design choices; requirements state necessary obligations. Exact uses determine its review and acceptance context.
_Avoid_: Requirement when referring to all interface design detail, protocol version when referring to lifecycle revision identity

**Interface retarget**:
A requirement set's declared adoption of a newer revision of an agreement for every selected requirement bound to an older one, without revising those requirements. Review judges each retargeted requirement under the new clauses.
_Avoid_: Link-only requirement revision
