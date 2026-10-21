import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const image = 'python@sha256:7415fbc3c9e4979cc717d92377ab2bc7b2b4a2af1ac03cc52b5f3f88efedaf3a';
const actionId = reference => reference.split('@')[0];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fixtureAuthority = 'Operator-selected engineering fixture. Stakeholder decisions are scripted fixture inputs, not acceptance by the actual product user. Review registration exercises a separate manager transport and exact verdict binding; it does not claim human or model review independence.';

/** Ordinary public operations only. Preserve both repositories and external evidence on every outcome. */
export async function runDirectJourney({process: processName = 'tiny', corrections = false, partialAcceptance = false, operationalUse = false, newRootChange = false, configurationImpact = false, lateRequirementCorrection = false, executable = process.env.MDLM_DIRECT_EXECUTABLE ?? process.env.MDLM_EXECUTABLE, root}) {
  assert.ok(['tiny', 'exploratory', 'iterative'].includes(processName));
  assert.ok(!configurationImpact || processName === 'iterative');
  assert.ok(!lateRequirementCorrection || processName === 'iterative');
  assert.ok(!newRootChange || processName === 'iterative', 'New root change fixture requires the iterative package');
  assert.ok(!operationalUse || processName === 'iterative', 'Operational-use fixture requires the iterative package');
  assert.ok(path.isAbsolute(root), 'A fresh absolute root is required');
  assert.ok(executable && path.isAbsolute(executable), 'An exact absolute executable is required');
  assert.ok(!existsSync(root), 'Never replay a journey in an existing directory');
  const evidenceRoot = `${root}-evidence`;
  assert.ok(!existsSync(evidenceRoot), 'Evidence destination must be fresh');
  mkdirSync(evidenceRoot, {recursive: true});
  mkdirSync(root, {recursive: true});
  const lifecycle = path.join(root, 'lifecycle'), source = path.join(root, 'product');
  const verificationRepositories = [];
  const registry = path.join(evidenceRoot, 'review-registry');
  mkdirSync(registry);
  const commands = [], publications = [], revisions = [], receipts = [], sourceCommits = [];
  const evidenceFile = path.join(evidenceRoot, 'result.json');
  let stage = 'preflight', terminal, caught;
  const save = (name, value) => writeFileSync(path.join(evidenceRoot, name), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, {flag: 'wx'});
  save('authority.json', {scope: fixtureAuthority, author: 'fixture-author', reviewer: 'fixture-reviewer', registrar: 'fixture-manager', stakeholder: 'engineering-fixture'});
  save('executable.json', {executable, sha256: digest(readFileSync(executable)), process: processName});
  function run(file, args, cwd = lifecycle, {input, env, expected = 0} = {}) {
    const index = commands.length + 1, prefix = String(index).padStart(4, '0');
    const record = {index, stage, file, args, cwd, input: input ?? null, environment: {MDLM_REVIEW_REGISTRY: registry, ...(env ?? {})}, startedAt: new Date().toISOString()};
    save(`${prefix}-request.json`, record);
    const result = spawnSync(file, args, {cwd, input, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, env: {...process.env, MDLM_REVIEW_REGISTRY: registry, MDLM_REVIEW_REGISTRAR: '', ...(env ?? {})}});
    Object.assign(record, {finishedAt: new Date().toISOString(), status: result.status, signal: result.signal, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error?.message});
    save(`${prefix}-result.json`, record);
    commands.push(record);
    if (result.error) throw result.error;
    if (expected !== null) assert.equal(result.status, expected, `${file} ${args.join(' ')}\n${record.stdout}\n${record.stderr}`);
    return record;
  }
  const git = (args, cwd = lifecycle) => run('git', args, cwd).stdout.trim();
  function cli(args, value, options = {}) {
    const argv = executable.endsWith('.js') ? [process.execPath, [executable, ...args, '--json']] : [executable, [...args, '--json']];
    const result = run(argv[0], argv[1], options.cwd ?? lifecycle, {...options, input: value === undefined ? undefined : `${JSON.stringify(value)}\n`});
    return JSON.parse(result.stdout);
  }
  function commit(cwd, message) {
    git(['add', '.'], cwd);
    git(['-c', 'commit.gpgSign=false', 'commit', '--quiet', '--no-verify', '--allow-empty', '-m', message], cwd);
  }
  function data() { return cli(['list']).data.map(item => item.lifecycleDatum?.datum ?? item.datum ?? item); }
  function exact(revision) { return cli(['show', revision]).lifecycleDatum.datum; }
  function guidance(action, subject) {
    const before = git(['status', '--porcelain']);
    const result = cli(['expectations', 'show', action, ...(subject ? [subject] : [])]);
    assert.equal(git(['status', '--porcelain']), before, 'Guidance must be read-only');
    return result;
  }
  const candidate = (localId, type, payload, links = [], predecessor) => ({localId, type, ...(predecessor ? {predecessor} : {}), payload: {publication: 'recorded', ...(type === 'RQS' ? {} : {title: type === 'RES' ? 'Verification result' : localId}), ...payload}, links, body: `Engineering fixture: ${localId}. ${fixtureAuthority}`});
  const link = (type, target) => ({type, target});
  const operationalUses = [];
  let sequence = 0;
  function submit(action, subject, candidates, evidence = {}) {
    stage = action;
    if (!lateRequirementCorrection) cli(['expectations']);
    const g = guidance(action, subject);
    const operation = `fixture-${processName}-${++sequence}-${action}`;
    const proposal = {operation, action: g.action, package: g.package, snapshot: g.snapshot, ...(g.subject ? {subject: g.subject} : {}), inputs: g.inputs, candidates, ...(Object.keys(evidence).length ? {evidence} : {})};
    if (g.authority?.kind === 'stakeholder') proposal.evidence = {...evidence, authority: [g.authority.name]};
    const proposalFile = path.join(evidenceRoot, `${operation}-proposal.json`);
    save(path.basename(proposalFile), proposal);
    if (g.authority?.kind === 'independent-review') {
      const context = cli(['review', 'context', g.action, g.subject]);
      save(`${operation}-review-context.json`, context);
      assert.deepEqual(context.payloadSchemas, g.payloadSchemas, 'Review and guidance must advertise the same authorable output schemas');
      assert.deepEqual(context.sourceAssessmentTargets, g.sourceAssessmentTargets, 'Review and guidance must identify the same exact assessment targets');
      const verdictFile = path.join(evidenceRoot, `${operation}-reviewer-verdict.json`);
      save(path.basename(verdictFile), {candidates});
      const rejected = cli(['proposal', 'submit', proposalFile], undefined, {expected: 1});
      assert.equal(rejected.ok, false, 'Unregistered reviewer publication must fail');
      cli(['review', 'register', proposalFile, verdictFile], undefined, {env: {MDLM_REVIEW_REGISTRAR: '1'}});
    }
    const authorityArgs = g.authority?.kind === 'stakeholder' ? ['--authority', g.authority.name] : [];
    if (action === 'accept-product') {
      const before = cli(['expectations']);
      const conflicting = {...candidates[0], localId: 'conflicting-decision', payload: {...candidates[0].payload, decision: candidates[0].payload.decision === 'accept' ? 'reject' : 'accept'}};
      const rejected = cli(['proposal', 'submit', '-', ...authorityArgs], {...proposal, operation: `${operation}-multiple`, candidates: [...candidates, conflicting]}, {expected: 1});
      assert.equal(rejected.ok, false, 'One stakeholder operation cannot publish conflicting acceptance decisions');
      assert.equal(cli(['expectations']).snapshot, before.snapshot, 'Rejected batch cannot change lifecycle history');
      assert.equal(cli(['proposal', 'settlement', `${operation}-multiple`]).outcome, 'not-published');
    }
    if (processName !== 'iterative' && action === 'observe-prototype' && receipts.length > 1) {
      const before = data();
      assert.equal(cli(['proposal', 'submit', '-'], {...proposal, operation: 'mismatched-receipt', evidence: {receipt: receipts[0].evidence}}, {expected: 1}).ok, false);
      assert.deepEqual(data(), before, 'Mismatched evidence cannot publish data');
    }
    const result = cli(['proposal', 'submit', proposalFile, ...authorityArgs]);
    assert.equal(result.outcome, 'accepted');
    // Existing journey actions exercise generic settlement and duplicate recovery.
    // New activity publications need their actual accepted data, not another copy
    // of the same recovery check for each verification plan and coverage review.
    if (!lateRequirementCorrection && !['plan-verification', 'plan-criterion-verification', 'review-verification', 'execute-criterion-verification'].includes(action)) {
      const settled = cli(['proposal', 'settlement', operation]);
      assert.equal(settled.outcome, 'accepted');
      assert.deepEqual(settled.revisions, result.revisions);
      const repeated = cli(['proposal', 'submit', proposalFile, ...authorityArgs]);
      assert.deepEqual(repeated.revisions, result.revisions, 'Completed proposal recovery must not duplicate records');
    }
    if (sequence === 1) {
      const stale = cli(['proposal', 'submit', '-'], {...proposal, operation: 'stale-snapshot'}, {expected: 1});
      assert.equal(stale.ok, false);
    }
    publications.push({operation, action: g.action, transaction: result.transaction, revisions: result.revisions});
    revisions.push(...result.revisions);
    const records = data().filter(d => result.revisions.includes(d.revision_id));
    save(`${operation}-published.json`, records);
    commit(lifecycle, `Record ${action}`);
    return records;
  }
  function execute(implementation, expected) {
    stage = 'execution';
    const operation = `execute-${processName}-${receipts.length + 1}`;
    const activity = implementation.links.find(l => l.type === 'verification')?.target;
    cli(['execution', 'run', implementation.revision_id, operation, ...(activity ? ['--activity', activity] : [])]);
    const settled = cli(['execution', 'settlement', operation]);
    const repeated = cli(['execution', 'settlement', operation]);
    assert.deepEqual(repeated.value, settled.value);
    assert.equal(settled.value.receipt.result.outcome, expected);
    assert.equal(settled.value.receipt.binding.assignment, undefined);
    assert.equal(settled.value.receipt.result.sourceCommit, implementation.payload.source_commit);
    receipts.push(settled.value);
    return settled.value.evidence;
  }
  // This scripted regression separates repositories and exercises source-free author
  // context, but does not claim independent human/model authorship. See authority.json.
  function planVerification(subject, cases) {
    const context = cli(['verification', 'context', subject.revision_id]);
    const targets = context.requirements.map(d => d.revision_id);
    const verifier = path.join(root, `verification-${verificationRepositories.length + 1}`);
    mkdirSync(verifier);
    git(['init', '--quiet'], verifier);
    git(['config', 'user.name', 'Requirement verification fixture'], verifier);
    git(['config', 'user.email', 'verifier@localhost'], verifier);
    const script = `import json, os, pathlib, subprocess
cases = json.loads(bytes.fromhex(${JSON.stringify(Buffer.from(JSON.stringify(cases)).toString('hex'))}).decode())
output = pathlib.Path(os.environ['MDLM_EVIDENCE_DIR'])
rows = []
for case in cases:
    observed = subprocess.run(case['command'], input=case.get('input'), cwd=os.environ['MDLM_PRODUCT_DIR'], text=True, capture_output=True)
    passed = observed.returncode == 0 and observed.stderr == '' and observed.stdout == case['expected']
    evidence = case['id'] + '.json'
    (output / evidence).write_text(json.dumps({'command': case['command'], 'input': case.get('input'), 'stdout': observed.stdout, 'stderr': observed.stderr, 'exit': observed.returncode}))
    rows.append({'case_id': case['id'], 'outcome': 'pass' if passed else 'fail', 'actual_results': [json.dumps({'stdout': observed.stdout, 'stderr': observed.stderr, 'exit': observed.returncode})], 'evidence_refs': [evidence]})
(output / 'results.json').write_text(json.dumps({'contract': 'mdlm-verification-results@1', 'cases': rows}))
raise SystemExit(0 if all(row['outcome'] == 'pass' for row in rows) else 1)
`;
    writeFileSync(path.join(verifier, 'verify.py'), script);
    commit(verifier, 'Commit requirement-driven command cases before product execution');
    verificationRepositories.push(verifier);
    const activity = submit(subject.type === 'EXP' ? 'plan-criterion-verification' : 'plan-verification', subject.revision_id, [candidate('verification-activity', 'VFY', {
      method: 'test', objective: 'Exercise the specified command behavior through its public process interface.',
      authoring_subject: context.subject, authoring_context: context.authoringContext,
      repository_path: verifier, source_commit: git(['rev-parse', 'HEAD'], verifier), verification_image: image,
      verification_command: ['python3', 'verify.py'], verification_script: 'verify.py', results_path: 'results.json',
      cases: cases.map(c => ({id: c.id, targets, preconditions: ['A fresh process with the selected committed product is available.'], actions: [JSON.stringify({command: c.command, input: c.input ?? null})], expected_results: [`stdout exactly ${JSON.stringify(c.expected)}, empty stderr and exit zero.`], coverage_rationale: c.rationale})),
      coverage: context.requirements.map(d => ({target: d.revision_id, obligations: [d.payload.statement ?? d.payload.ears?.response ?? d.payload.criterion], case_ids: cases.map(c => c.id), rationale: 'These public command cases exercise the complete selected fixture behavior; review assesses the cases together for parent and leaf obligations.'})),
    }, targets.map(target => link('verifies', target)))])[0];
    submit('review-verification', activity.revision_id, [candidate('coverage-review', 'REV', {
      outcome: 'pass', findings: 'Scripted fixture assessment of the predetermined actions and results, not an independent model judgment.',
      coverage_assessments: targets.map(target => ({target, disposition: 'adequate', rationale: 'The command cases cover each selected obligation at the public boundary within this fixture scope.'})),
    }, [link('reviews', activity.revision_id)])]);
    return activity;
  }
  const countCases = [
    {id: 'empty', command: ['python3', 'count.py'], expected: '0\n', rationale: 'No supplied arguments produces zero.'},
    {id: 'two', command: ['python3', 'count.py', 'red', 'blue'], expected: '2\n', rationale: 'Two separate arguments produce two.'},
    {id: 'quoted', command: ['python3', 'count.py', 'red blue'], expected: '1\n', rationale: 'An argument containing spaces still counts once.'},
  ];
  function publishVerification(implementation, selection, expected = 'pass') {
    const receipt = execute(implementation, expected);
    const activity = implementation.links.find(l => l.type === 'verification').target;
    const result = submit(implementation.type === 'TRY' ? 'execute-criterion-verification' : 'execute-verification', implementation.revision_id, [candidate('verification', 'RES', {
      assessment: 'Captured public command cases and observations from the separate verifier.', correction_target: 'none',
    }, [link('executes', implementation.revision_id), link('verifies', selection.revision_id), link('evaluates', activity)])], {receipt}).find(d => d.type === 'RES');
    assert.equal(result.payload.outcome, expected);
    assert.ok(result.payload.case_results.length > 0);
    return result;
  }
  function sourceVersion(leaf, extra, failure = false, {zeroBug = false, quoted, zeroCheck = false} = {}) {
    const runtime = `import sys\nprint(${zeroBug ? '(len(sys.argv) - 1) or 1' : 'len(sys.argv) - 1'})\n`;
    const verification = `import subprocess\nassert subprocess.check_output(['python3', 'count.py', 'red', 'blue'], text=True).strip() == '${failure ? '3' : '2'}'\n`;
    const region = (name, relation, target, code) => target ? `# mdlm:begin ${name} ${relation} ${target}\n${code}# mdlm:end ${name}\n` : code;
    writeFileSync(path.join(source, 'count.py'), region('count', 'implements', leaf, runtime) + (extra ? region('label', 'implements', extra, "print('items')\n") : ''));
    // The baseline checks the count independently of its separate label behavior.
    const checks = (extra ? verification.replace('.strip()', '.splitlines()[0]') : verification)
      + (quoted === undefined ? '' : `assert subprocess.check_output(['python3', 'count.py', 'red blue'], text=True).strip() == '${quoted}'\n`)
      + (zeroCheck ? `assert subprocess.check_output(['python3', 'count.py'], text=True).strip() == '0'\n` : '');
    if (processName !== 'iterative') writeFileSync(path.join(source, 'verify.py'), region('checks', 'verifies', leaf, checks) + (extra ? region('label-check', 'verifies', extra, "assert subprocess.check_output(['python3', 'count.py'], text=True).splitlines()[1] == 'items'\n") : ''));
    commit(source, 'Record exact product and executable expectations');
    const sourceCommit = git(['rev-parse', 'HEAD'], source);
    sourceCommits.push(sourceCommit);
    return {repository_path: source, source_commit: sourceCommit, command: ['python3', 'count.py', 'red', 'blue'], ...(processName === 'iterative' ? {} : {verification_image: image, verification_command: ['python3', 'verify.py'], verification_script: 'verify.py'})};
  }
  function reviewRequirements(set, {failRequirement, findings} = {}) {
    const context = cli(['review', 'context', 'review-requirements', set.revision_id]);
    const graph = context.requirementGraphs.find(g => g.selection === set.revision_id);
    assert.ok(graph?.assessment, 'Review context must expose its exact required assessments');
    const assessment = graph.assessment;
    const reqs = graph.requirements.filter(d => assessment.requirements.includes(d.revision_id));
    const groups = graph.groups.filter(d => assessment.groups.some(g => g.revision === d.revision_id));
    const records = submit('review-requirements', set.revision_id, [candidate('requirements-review', 'REV', {
      outcome: failRequirement ? 'fail' : 'pass', findings: findings ?? 'The selected software behaviors jointly satisfy the fixture stakeholder statement; retirement removes the label and preserves counting.',
      requirement_assessments: reqs.map(d => ({requirement: d.revision_id, disposition: d.revision_id === failRequirement ? 'needs-change' : 'valid', rationale: d.revision_id === failRequirement ? findings : 'Necessary within the selected stakeholder scope.'})),
      decomposition_assessments: groups.map(d => ({group: d.revision_id, disposition: d.links.some(l => l.target === failRequirement) ? 'needs-change' : 'adequate', membership_action: 'none', rationale: failRequirement ? findings : 'The immediate children cover the parent without an unused behavior.', children: d.links.filter(l => l.type === 'child').map(l => ({requirement: l.target, disposition: l.target === failRequirement ? 'needs-change' : 'valid', rationale: l.target === failRequirement ? findings : 'This child contributes a selected behavior.'}))})),
    }, [link('reviews', set.revision_id)])]);
    return {...assessment, review: records.find(d => d.type === 'REV')};
  }
  function recordUse(implementation, args, {negativeChecks = false, wrongSubject} = {}) {
    const beforeData = data();
    const before = cli(['expectations']);
    assert.ok(before.optional.some(item => actionId(item.action) === 'record-operational-use' && item.subject === implementation.revision_id));
    const g = guidance('record-operational-use', implementation.revision_id);
    assert.deepEqual(g.inputs.prior_uses, operationalUses.filter(use => use.subject === implementation.revision_id).map(use => use.revision).sort());
    assert.equal(g.executionCommand, undefined, 'Authored use must not request canonical execution');
    assert.equal(g.authority, undefined, 'Recording use must not require stakeholder approval');
    assert.equal(g.context.find(d => d.revision_id === implementation.revision_id).payload.source_commit, implementation.payload.source_commit);
    assert.equal(git(['rev-parse', 'HEAD'], source), implementation.payload.source_commit);
    const observed = run('python3', ['count.py', ...args], source);
    assert.equal(observed.stdout, `${args.length}\n`);
    const entry = candidate('operational-use', 'OPU', {
      actor_kind: 'scripted', actor: 'public CLI engineering fixture', occurred_at: observed.startedAt,
      scenario: `Count the ${args.length} supplied arguments in this distinct invocation.`, observed_outcome: 'observed',
      evidence_reference: path.join(evidenceRoot, `${String(observed.index).padStart(4, '0')}-result.json`),
      assessment: `Actual stdout was ${JSON.stringify(observed.stdout)} and exit status was ${observed.status}.`,
      limitations: 'Automated operational fixture, not human or agent usability evidence. No formal verification or acceptance claim.',
    }, [link('observes', implementation.revision_id)]);
    entry.body = `Source ${implementation.payload.source_commit}\nCommand: python3 ${JSON.stringify(['count.py', ...args])}\nstdout:\n${observed.stdout}stderr:\n${observed.stderr}exit: ${observed.status}\n`;
    if (negativeChecks) {
      const proposal = {operation: 'reject-use', action: g.action, package: g.package, snapshot: g.snapshot, subject: g.subject, inputs: g.inputs, candidates: [entry]};
      const reject = (name, candidate, evidence, authorityArgs = []) => {
        assert.equal(cli(['proposal', 'submit', '-', ...authorityArgs], {...proposal, operation: `reject-use-${name}`, candidates: [candidate], ...(evidence ? {evidence} : {})}, {expected: 1}).ok, false);
        assert.equal(cli(['expectations']).snapshot, before.snapshot, 'Rejected use must not mutate lifecycle data');
      };
      assert.ok(wrongSubject);
      reject('wrong-source', {...entry, links: [link('observes', wrongSubject)]});
      reject('missing-evidence', {...entry, payload: {...entry.payload, evidence_reference: undefined}});
      reject('acceptance', {...entry, type: 'ACC'});
      reject('verification', {...entry, type: 'RES'});
      reject('authority', entry, {authority: ['stakeholder']}, ['--authority', 'stakeholder']);
    }
    const record = submit('record-operational-use', implementation.revision_id, [entry])[0];
    operationalUses.push({revision: record.revision_id, subject: implementation.revision_id, sourceCommit: implementation.payload.source_commit, evidenceReference: entry.payload.evidence_reference});
    assert.equal(record.payload.receipt, undefined);
    assert.deepEqual(data().filter(d => d.type !== 'OPU'), beforeData.filter(d => d.type !== 'OPU'), 'Use cannot change any formal or exploratory records');
    const after = cli(['expectations']);
    assert.deepEqual(after.items, before.items, 'Operational use cannot change mandatory work');
    assert.equal(after.outcome, before.outcome, 'Operational use cannot change completion');
    return record;
  }
  function finishProduct(set, implementation, {decision = 'accept', rationale = fixtureAuthority, checkZero = false} = {}) {
    const receipt = processName === 'iterative' ? undefined : execute(implementation, 'pass');
    const result = processName === 'iterative' ? publishVerification(implementation, set) : submit('execute-verification', implementation.revision_id, [candidate('verification', 'RES', {assessment: 'The committed Python assertions passed in the pinned container.', correction_target: 'none'}, [link('executes', implementation.revision_id), link('verifies', set.revision_id)])], {receipt}).find(d => d.type === 'RES');
    const reviewContext = cli(['review', 'context', 'review-implementation', implementation.revision_id]);
    if (implementation.payload.acceptance_scope === 'partial') {
      const sourceContext = reviewContext.sources.find(s => s.implementation === implementation.revision_id);
      assert.equal(sourceContext.acceptanceScope, 'partial');
      assert.ok(sourceContext.files.some(f => f.path === 'cli.py' && f.formal === false && f.content.includes('input(')));
    }
    const requirementGraph = reviewContext.requirementGraphs.find(g => g.selection === set.revision_id);
    const assessment = requirementGraph?.assessment;
    if (assessment?.change) assert.deepEqual(reviewContext.sourceAssessmentTargets?.sourceScopes, assessment.sourceScopes, 'Changed review must identify affected baseline revisions');
    const scopes = assessment?.change ? data().filter(d => assessment.sourceScopes.includes(d.revision_id)) : data().filter(d => d.type === 'SCP' && d.links.some(l => l.type === 'belongs-to' && l.target === implementation.revision_id));
    submit('review-implementation', implementation.revision_id, [candidate('implementation-review', 'REV', {...(processName === 'iterative' ? {coverage_assessments: requirementGraph.requirements.map(requirement => ({target: requirement.revision_id, disposition: 'adequate', rationale: 'The selected public command cases jointly cover the complete fixture requirement, including parent obligations.'}))} : {}), outcome: 'pass', findings: 'The committed counting program and independent subprocess assertions support the selected requirements. The receipt binds this exact source.', source_assessments: scopes.map(d => ({source_scope: d.revision_id, disposition: 'valid', rationale: 'This source region implements or verifies its linked software behavior.'}))}, [link('reviews', implementation.revision_id), link('uses-evidence', result.revision_id)])]);
    if (processName === 'iterative') assert.equal(cli(['verification', 'status', implementation.revision_id]).complete, true);
    if (checkZero) {
      const observed = run('python3', ['count.py'], source);
      assert.equal(observed.stdout.trim(), decision === 'reject' ? '1' : '0', 'Record actual zero-input behavior before the fixture stakeholder decision');
    }
    return submit('accept-product', implementation.revision_id, [candidate('fixture-acceptance', 'ACC', {decision, rationale}, [link('accepts', implementation.revision_id), link('uses-evidence', result.revision_id), link('confirms', set.revision_id)])]).find(d => d.type === 'ACC');
  }
  try {
    run('docker', ['version', '--format', '{{.Server.Version}}'], root);
    mkdirSync(source);
    git(['init', '--quiet'], source);
    git(['config', 'user.name', 'Direct lifecycle fixture'], source);
    git(['config', 'user.email', 'fixture@localhost'], source);
    cli(['init', lifecycle, ...(processName !== 'tiny' ? ['--process', processName] : [])], undefined, {cwd: root});
    git(['config', 'user.name', 'Direct lifecycle fixture']);
    git(['config', 'user.email', 'fixture@localhost']);
    if (lateRequirementCorrection) {
      const acknowledged = 'print safe only when the office has no pending return and the station has acknowledged its returned event; otherwise print blocked';
      const faulty = 'print safe when the office has no pending return, otherwise print blocked';
      const experiment = submit('frame-experiment', undefined, [candidate('upgrade-experiment', 'EXP', {criterion: 'Keep deliveries moving after an office upgrade.', question: 'Can a late implementation review correct an unsound upgrade rule?', approach: 'Apply a returned event while losing its acknowledgement.', constraints: 'One office and one station; command fixture only.', allowance_minutes: 10, scope_cut: 'Upgrade permission.'})]).find(d => d.type === 'EXP');
      const initial = submit('draft-requirements', undefined, [
        candidate('need', 'REQ', {kind: 'stakeholder', statement: 'Permit office upgrades while preserving delivery progress.'}, [link('informed-by', experiment.revision_id)]),
        candidate('upgrade', 'REQ', {kind: 'software', ears: {pattern: 'ubiquitous', system: 'The upgrade checker', response: acknowledged}}),
        candidate('status', 'REQ', {kind: 'software', ears: {pattern: 'ubiquitous', system: 'The station', response: 'print acknowledged or awaiting according to its returned-event acknowledgement state'}}),
        candidate('group', 'DCP', {}, [link('parent', '$need'), link('child', '$upgrade'), link('child', '$status')]), candidate('requirements', 'RQS', {}),
      ]);
      const need = initial.find(d => d.payload.title === 'need'), duty = initial.find(d => d.payload.title === 'upgrade'), peer = initial.find(d => d.payload.title === 'status');
      const set = initial.find(d => d.type === 'RQS'), group = initial.find(d => d.type === 'DCP');
      function upgradeSource(requirement, strict) {
        writeFileSync(path.join(source, 'upgrade.py'), `# mdlm:begin permission implements ${requirement}\nimport sys\noffice_empty = sys.argv[1] == 'empty'\nstation_acknowledged = sys.argv[2] == 'acknowledged'\nprint('safe' if office_empty${strict ? ' and station_acknowledged' : ''} else 'blocked')\n# mdlm:end permission\n# mdlm:begin status implements ${peer.id}\nprint('acknowledged' if station_acknowledged else 'awaiting')\n# mdlm:end status\n`);
        commit(source, 'Record exact office upgrade rule');
        const sourceCommit = git(['rev-parse', 'HEAD'], source); sourceCommits.push(sourceCommit);
        return {repository_path: source, source_commit: sourceCommit, command: ['python3', 'upgrade.py', 'empty', 'acknowledged'], file_roles: {'upgrade.py': 'production'}};
      }
      const cases = strict => [
        {id: 'acknowledged', command: ['python3', 'upgrade.py', 'empty', 'acknowledged'], expected: 'safe\nacknowledged\n', rationale: 'The office is empty and the station has no unacknowledged event.'},
        {id: 'lost-acknowledgement', command: ['python3', 'upgrade.py', 'empty', 'awaiting'], expected: `${strict ? 'blocked' : 'safe'}\nawaiting\n`, rationale: 'The office applied the return but lost its response; the station still holds the old event.'},
      ];
      reviewRequirements(set);
      const activity = planVerification(set, cases(true));
      const imp = submit('implement-product', set.revision_id, [candidate('implementation', 'IMP', upgradeSource(duty.id, true), [link('implements', set.revision_id), link('verification', activity.revision_id)])]).find(d => d.type === 'IMP');
      const acceptance = finishProduct(set, imp);
      const change = submit('request-change', set.revision_id, [candidate('upgrade-change', 'CHG', {reason: 'Simplify upgrade permission using office state.', requested_outcome: faulty}, [link('changes', duty.revision_id), link('changes', peer.revision_id)])]).find(d => d.type === 'CHG');
      submit('approve-change', change.revision_id, [candidate('approval', 'REV', {outcome: 'pass', findings: fixtureAuthority}, [link('reviews', change.revision_id)])]);
      const changed = submit('revise-requirements', change.revision_id, [candidate('upgrade', 'REQ', {...duty.payload, ears: {...duty.payload.ears, response: faulty}}, [], duty.revision_id), candidate('requirements', 'RQS', {}, [], set.revision_id)]);
      const badDuty = changed.find(d => d.type === 'REQ'), badSet = changed.find(d => d.type === 'RQS');
      const requirementsPass = reviewRequirements(badSet).review;
      const weakActivity = planVerification(badSet, cases(false));
      const affected = data().filter(d => d.type === 'SCP' && d.links.some(l => l.type === 'belongs-to' && l.target === imp.revision_id) && d.links.some(l => l.type === 'implements' && l.target === duty.revision_id)).map(d => d.revision_id);
      const impact = affected.map(source_scope => ({source_scope, disposition: 'changed', rationale: 'The permission region follows the changed rule.'}));
      const badImp = submit('rebind-product', badSet.revision_id, [candidate('implementation', 'IMP', {...upgradeSource(duty.id, false), impact_dispositions: impact}, [link('implements', badSet.revision_id), link('verification', weakActivity.revision_id)], imp.revision_id)]).find(d => d.type === 'IMP');
      const oldResult = publishVerification(badImp, badSet);
      const observed = run('python3', ['upgrade.py', 'empty', 'awaiting'], source);
      assert.equal(observed.stdout, 'safe\nawaiting\n', 'Office-applied return remains unacknowledged at the station');
      const failed = submit('review-implementation', badImp.revision_id, [candidate('late-failure', 'REV', {outcome: 'fail', findings: 'The implementation obeys the requirement but its rule is unsound: an applied return can remain unacknowledged at the station and prevent delivery after upgrade.', requirement_assessments: [{requirement: badDuty.revision_id, disposition: 'needs-change', rationale: 'Require the station acknowledgement before upgrade.'}], coverage_assessments: [need, badDuty, peer].map(d => ({target: d.revision_id, disposition: 'needs-change', rationale: 'Late operational counterexample needs corrected verification.'})), source_assessments: affected.map(source_scope => ({source_scope, disposition: 'valid', rationale: 'Code correctly follows the faulty rule.'}))}, [link('reviews', badImp.revision_id), link('uses-evidence', oldResult.revision_id)])]).find(d => d.type === 'REV');
      const available = cli(['expectations']);
      save('late-review-expectations.json', available);
      assert.ok(available.items.some(item => actionId(item.action) === 'correct-requirements-after-review' && item.subject === badSet.revision_id), 'Current implementation requirement finding must offer correction after RQS PASS');
      const g = guidance('correct-requirements-after-review', badSet.revision_id);
      assert.deepEqual(g.inputs.failure, [failed.revision_id]);
      assert.deepEqual(g.requirementAuthoringTargets.frontier, {requirements: [badDuty.revision_id], groups: []});
      const correctedOutputs = [candidate('upgrade', 'REQ', {...badDuty.payload, ears: {...badDuty.payload.ears, response: acknowledged}}, [], badDuty.revision_id), candidate('requirements', 'RQS', {}, [link('corrects', failed.revision_id)], badSet.revision_id)];
      const rejected = cli(['proposal', 'submit', '-'], {operation: 'unmarked-edit', action: g.action, package: g.package, snapshot: g.snapshot, subject: g.subject, inputs: g.inputs, candidates: [...correctedOutputs, candidate('status', 'REQ', {...peer.payload, ears: {...peer.payload.ears, response: 'hide awaiting events'}}, [], peer.revision_id)]}, {expected: 1});
      assert.ok(JSON.stringify(rejected.diagnostics).includes('change-frontier'));
      assert.equal(cli(['expectations']).snapshot, g.snapshot);
      assert.equal(cli(['proposal', 'settlement', 'unmarked-edit']).outcome, 'not-published');
      const corrected = submit('correct-requirements-after-review', badSet.revision_id, correctedOutputs);
      const correctedDuty = corrected.find(d => d.type === 'REQ'), correctedSet = corrected.find(d => d.type === 'RQS'), correctedGroup = corrected.find(d => d.type === 'DCP');
      assert.equal(correctedDuty.id, duty.id); assert.equal(correctedSet.id, set.id); assert.equal(correctedGroup.id, group.id);
      assert.ok(correctedGroup.links.some(l => l.target === correctedDuty.revision_id));
      for (const retained of [need, peer]) { assert.ok(correctedSet.links.some(l => l.target === retained.revision_id)); assert.deepEqual(exact(retained.revision_id), retained); }
      assert.ok(correctedSet.links.some(l => l.type === 'corrects' && l.target === failed.revision_id));
      assert.ok(cli(['expectations']).items.some(item => actionId(item.action) === 'review-requirements' && item.subject === correctedSet.revision_id));
      const context = cli(['verification', 'context', correctedSet.revision_id]); save('corrected-verification-context.json', context);
      assert.equal(context.requirements.find(d => d.revision_id === correctedDuty.revision_id).payload.ears.response, acknowledged);
      assert.equal(context.sources, undefined, 'Verification authoring receives no product source');
      reviewRequirements(correctedSet);
      const freshActivity = planVerification(correctedSet, cases(true));
      const successor = submit('rebind-product', correctedSet.revision_id, [candidate('implementation', 'IMP', {...upgradeSource(duty.id, true), impact_dispositions: impact}, [link('implements', correctedSet.revision_id), link('verification', freshActivity.revision_id)], badImp.revision_id)]).find(d => d.type === 'IMP');
      assert.equal(cli(['verification', 'status', successor.revision_id]).complete, false, 'Old PASS results cannot verify successor');
      const executionGuidance = guidance('execute-verification', successor.revision_id);
      const stale = cli(['proposal', 'submit', '-'], {operation: 'old-upgrade-receipt', action: executionGuidance.action, package: executionGuidance.package, snapshot: executionGuidance.snapshot, subject: executionGuidance.subject, inputs: executionGuidance.inputs, candidates: [candidate('verification', 'RES', {assessment: 'Attempt old result reuse.', correction_target: 'none'}, [link('executes', successor.revision_id), link('verifies', correctedSet.revision_id), link('evaluates', freshActivity.revision_id)])], evidence: {receipt: receipts.at(-1).evidence}}, {expected: 1});
      assert.equal(stale.ok, false);
      const finalAcceptance = finishProduct(correctedSet, successor);
      terminal = cli(['expectations']); assert.equal(terminal.outcome, 'profile-boundary-reached'); cli(['doctor']);
      for (const historical of [badDuty, badSet, requirementsPass, failed, oldResult, acceptance]) assert.deepEqual(exact(historical.revision_id), historical);
      save('late-correction-proof.json', {change: change.revision_id, badDuty: badDuty.revision_id, failed: failed.revision_id, correction: correctedSet.revision_id, correctedDuty: correctedDuty.revision_id, successor: successor.revision_id, activity: freshActivity.revision_id, acceptance: finalAcceptance.revision_id, terminal});
      return;
    } else if (partialAcceptance) {
      assert.equal(processName, 'iterative');
      submit('frame-experiment', undefined, [candidate('river', 'EXP', {criterion: 'Keep River scores through a useful CLI.', question: 'Can scoring be accepted while the CLI remains provisional in this repository?', approach: 'Accept a scoring command, operate the provisional interactive CLI, then formalize the CLI.', constraints: 'Session only, user formula retained.', allowance_minutes: 15, scope_cut: 'One scored hand.'})]);
      const initial = submit('draft-requirements', undefined, [
        candidate('need', 'REQ', {kind: 'stakeholder', statement: 'Calculate River hand scores using the agreed bid and tricks formula.'}),
        candidate('score', 'REQ', {kind: 'software', ears: {pattern: 'ubiquitous', system: 'The scorer', response: 'take integer bid and tricks taken as two command arguments and print bid * 10 + 10 for an exact bid, otherwise abs(bid - taken) * -10'}}),
        candidate('decomposition', 'DCP', {}, [link('parent', '$need'), link('child', '$score')]),
        candidate('requirements', 'RQS', {}),
      ]);
      const need = initial.find(d => d.payload.title === 'need'), score = initial.find(d => d.payload.title === 'score');
      const group = initial.find(d => d.type === 'DCP'), set = initial.find(d => d.type === 'RQS');
      reviewRequirements(set);
      const region = (name, relation, target, code) => `# mdlm:begin ${name} ${relation} ${target}\n${code}# mdlm:end ${name}\n`;
      const scoring = 'import sys\nbid, taken = map(int, sys.argv[1:])\nprint(bid * 10 + 10 if bid == taken else abs(bid - taken) * -10)\n';
      const cliCode = 'import subprocess\nbid, taken = input("Bid: "), input("Taken: ")\nprint(subprocess.check_output(["python3", "scoring.py", bid, taken], text=True), end="")\n';
      writeFileSync(path.join(source, 'scoring.py'), region('score', 'implements', score.id, scoring));
      writeFileSync(path.join(source, 'cli.py'), cliCode);
      commit(source, 'Working scorer and provisional CLI in one source repository');
      const sourceCommit = git(['rev-parse', 'HEAD'], source); sourceCommits.push(sourceCommit);
      const scoreCases = [[0, 0, 10], [2, 2, 30], [1, 3, -20], [3, 1, -20]].map(([bid, taken, expected], index) => ({id: `score-${index}`, command: ['python3', 'scoring.py', String(bid), String(taken)], expected: `${expected}\n`, rationale: 'Exact bids including zero and misses on both sides exercise the scoring formula.'}));
      const activity = planVerification(set, scoreCases);
      const payload = {repository_path: source, source_commit: sourceCommit, command: ['python3', 'cli.py'], file_roles: {'scoring.py': 'production', 'cli.py': 'production'}};
      const g = guidance('implement-product', set.revision_id);
      const rejected = cli(['proposal', 'submit', '-'], {operation: 'partial-as-whole', action: g.action, package: g.package, snapshot: g.snapshot, subject: g.subject, inputs: g.inputs, candidates: [candidate('whole', 'IMP', payload, [link('implements', set.revision_id), link('verification', activity.revision_id)])]}, {expected: 1});
      assert.equal(rejected.ok, false, 'Whole-product claim cannot leave the provisional CLI untraced');
      const imp = submit('implement-product', set.revision_id, [candidate('partial', 'IMP', {...payload, acceptance_scope: 'partial', formal_files: ['scoring.py']}, [link('implements', set.revision_id), link('verification', activity.revision_id)])]).find(d => d.type === 'IMP');
      assert.deepEqual(imp.payload.source_inventory.map(f => [f.path, f.formal]), [['cli.py', false], ['scoring.py', true]]);
      assert.ok(!data().some(d => d.type === 'SCP' && d.payload.path === 'cli.py'));
      assert.equal(run('python3', ['-B', 'cli.py'], source, {input: '2\n2\n'}).stdout, 'Bid: Taken: 30\n');
      assert.equal(cli(['trace', 'why', 'cli.py:1', '--implementation', imp.revision_id]).requirementTrace.lineStatus, 'provisional');
      const acceptance = finishProduct(set, imp, {rationale: `Accept only the scoring command at this commit. CLI behavior remains provisional. ${fixtureAuthority}`});
      // Exact acceptance is readable even when the corresponding review action has closed.
      assert.equal(exact(acceptance.revision_id).links.find(l => l.type === 'accepts').target, imp.revision_id);
      assert.deepEqual(receipts.at(-1).receipt.binding.formalFiles, ['scoring.py']);
      assert.equal(cli(['expectations']).outcome, 'profile-boundary-reached');
      writeFileSync(path.join(source, 'cli.py'), cliCode.replace('Bid: ', 'Your bid: '));
      commit(source, 'Try a provisional prompt change without claiming renewed acceptance');
      sourceCommits.push(git(['rev-parse', 'HEAD'], source));
      assert.equal(run('python3', ['-B', 'cli.py'], source, {input: '1\n3\n'}).stdout, 'Your bid: Taken: -20\n');
      assert.equal(exact(imp.revision_id).payload.source_commit, sourceCommit, 'The old acceptance stays attached to its old commit');
      const change = submit('request-change', set.revision_id, [candidate('formalize-cli', 'CHG', {reason: 'The provisional command is useful; retain its minimum input and output behavior.', requested_outcome: 'Accept scoring through the CLI in the whole repository.'}, [link('baseline', acceptance.revision_id), link('changes', need.revision_id)])]).find(d => d.type === 'CHG');
      submit('approve-change', change.revision_id, [candidate('approval', 'REV', {outcome: 'pass', findings: `Approve minimal input/output scope while retaining the scoring formula. ${fixtureAuthority}`}, [link('reviews', change.revision_id)])]);
      const revised = submit('revise-requirements', change.revision_id, [
        candidate('need', 'REQ', {kind: 'stakeholder', statement: 'Enter a bid and tricks taken at a CLI and receive the agreed River score.'}, [], need.revision_id),
        candidate('interaction', 'REQ', {kind: 'software', ears: {pattern: 'ubiquitous', system: 'The CLI', response: 'prompt Bid: and Taken: for integer inputs and print the score returned by the scorer'}}),
        candidate('decomposition', 'DCP', {}, [link('parent', '$need'), link('child', score.revision_id), link('child', '$interaction')], group.revision_id),
        candidate('requirements', 'RQS', {}, [], set.revision_id),
      ]);
      const nextSet = revised.find(d => d.type === 'RQS'), interaction = revised.find(d => d.payload.title === 'interaction');
      const assessment = reviewRequirements(nextSet);
      writeFileSync(path.join(source, 'cli.py'), region('interaction', 'implements', interaction.id, cliCode));
      // Equivalent scorer refactor must still acquire fresh implementation evidence.
      writeFileSync(path.join(source, 'scoring.py'), region('score', 'implements', score.id, scoring.replace('bid * 10 + 10', '(bid + 1) * 10')));
      commit(source, 'Formalize the complete useful product with fresh source evidence');
      const wholeCommit = git(['rev-parse', 'HEAD'], source); sourceCommits.push(wholeCommit);
      const dispositions = assessment.sourceScopes.map(source_scope => ({source_scope, disposition: 'valid', rationale: 'The scoring contract and its attributed responsibilities remain valid; this revision adds the CLI scope.'}));
      const wholeActivity = planVerification(nextSet, [...scoreCases, {id: 'interaction', command: ['python3', 'cli.py'], input: '2\n2\n', expected: 'Bid: Taken: 30\n', rationale: 'Exercise both prompts, entered values and displayed score together.'}]);
      const whole = submit('rebind-product', nextSet.revision_id, [candidate('whole', 'IMP', {...payload, source_commit: wholeCommit, acceptance_scope: 'whole-product', impact_dispositions: dispositions}, [link('implements', nextSet.revision_id), link('verification', wholeActivity.revision_id)], imp.revision_id)]).find(d => d.type === 'IMP');
      assert.notEqual(cli(['expectations']).outcome, 'profile-boundary-reached', 'A changed source cannot inherit the old acceptance');
      assert.ok(whole.payload.source_inventory.every(f => f.formal !== false));
      assert.ok(data().some(d => d.type === 'SCP' && d.payload.path === 'cli.py' && d.links.some(l => l.target === whole.revision_id)));
      const verificationGuidance = guidance('execute-verification', whole.revision_id);
      const staleReceipt = cli(['proposal', 'submit', '-'], {operation: 'old-partial-receipt', action: verificationGuidance.action, package: verificationGuidance.package, snapshot: verificationGuidance.snapshot, subject: verificationGuidance.subject, inputs: verificationGuidance.inputs, candidates: [candidate('verification', 'RES', {assessment: 'Attempt to reuse old evidence.', correction_target: 'none'}, [link('executes', whole.revision_id), link('verifies', nextSet.revision_id), link('evaluates', wholeActivity.revision_id)])], evidence: {receipt: receipts[0].evidence}}, {expected: 1});
      assert.equal(staleReceipt.ok, false, 'Old partial evidence cannot verify the new whole source');
      finishProduct(nextSet, whole);
      assert.equal(receipts.length, 2);
      assert.equal(receipts.at(-1).receipt.binding.formalFiles, undefined);
      assert.deepEqual(exact(acceptance.revision_id), acceptance);
    } else if (processName === 'iterative') {
      const initialExperiment = submit('frame-experiment', undefined, [candidate('maintenance-experiment', 'EXP', {criterion: 'Count supplied items.', question: 'Can unchanged accepted requirements retain their review during maintenance?', approach: 'Baseline a counter, then change only its implementation.', constraints: 'No new behavior.', allowance_minutes: 10, scope_cut: 'One implementation-only change.'})]).find(d => d.type === 'EXP');
      const initial = submit('draft-requirements', undefined, [
        candidate('need', 'REQ', {kind: 'stakeholder', statement: 'Count supplied command-line items.'}, [link('informed-by', initialExperiment.revision_id)]),
        candidate('count', 'REQ', {kind: 'software', ears: {pattern: 'ubiquitous', system: 'The CLI', response: 'print the number of supplied command-line items'}}),
        candidate('decomposition', 'DCP', {}, [link('parent', '$need'), link('child', '$count')]),
        candidate('requirements', 'RQS', {}),
      ]);
      const need = initial.find(d => d.payload.title === 'need'), count = initial.find(d => d.payload.title === 'count');
      const set = initial.find(d => d.type === 'RQS');
      const originalReview = reviewRequirements(set).review;
      const activity = planVerification(set, countCases);
      const initialSource = sourceVersion(count.id);
      if (configurationImpact) {
        writeFileSync(path.join(source, '.gitignore'), '__pycache__/\n');
        commit(source, 'Keep interpreter caches outside source inventory');
        initialSource.source_commit = git(['rev-parse', 'HEAD'], source);
        sourceCommits.push(initialSource.source_commit);
        initialSource.source_ranges = [
          {path: 'count.py', name: 'count', start: 1, end: 4, requirements: [count.id]},
          {path: '.gitignore', name: 'Ignore interpreter caches', start: 1, end: 1, requirements: [count.id]},
        ];
      }
      const imp = submit('implement-product', set.revision_id, [candidate('implementation', 'IMP', {...initialSource, file_roles: {'count.py': 'production', ...(configurationImpact ? {'.gitignore': 'configuration'} : {})}}, [link('implements', set.revision_id), link('verification', activity.revision_id)])]).find(d => d.type === 'IMP');
      if (operationalUse) recordUse(imp, ['red', 'blue'], {negativeChecks: true, wrongSubject: set.revision_id});
      const acceptance = finishProduct(set, imp);
      assert.equal(cli(['expectations']).outcome, 'profile-boundary-reached');
      if (operationalUse) recordUse(imp, ['green']);
      if (configurationImpact) {
        const change = submit('request-change', set.revision_id, [candidate('clarify-count', 'CHG', {
          reason: 'Clarify count representation without changing cache housekeeping.',
          requested_outcome: 'State that the count is a decimal integer.',
        }, [link('baseline', acceptance.revision_id), link('changes', count.revision_id)])]).find(d => d.type === 'CHG');
        submit('approve-change', change.revision_id, [candidate('approval', 'REV', {outcome: 'pass', findings: fixtureAuthority}, [link('reviews', change.revision_id)])]);
        const nextSet = submit('revise-requirements', change.revision_id, [
          candidate('count', 'REQ', {...count.payload, ears: {...count.payload.ears, response: 'print the number of supplied command-line items as a decimal integer'}}, [], count.revision_id),
          candidate('requirements', 'RQS', {}, [], set.revision_id),
        ]).find(d => d.type === 'RQS');
        reviewRequirements(nextSet);
        const activity = planVerification(nextSet, countCases);
        const context = cli(['review', 'context', 'rebind-product', nextSet.revision_id]);
        const required = context.requirementGraphs.find(g => g.selection === nextSet.revision_id).assessment.sourceScopes;
        const scopes = required.map(exact);
        const configuration = scopes.find(d => d.payload.path === '.gitignore');
        assert.equal(configuration.payload.role, 'configuration');
        assert.equal(required.length, 2, 'Both count and configuration are required impact targets');
        const dispositions = scopes.map(d => ({source_scope: d.revision_id, disposition: 'valid', rationale: 'The unchanged exact region remains valid for the clarified count.'}));
        const output = candidate('implementation', 'IMP', {...imp.payload, product_files: undefined, source_inventory: undefined, source_changes: undefined, impact_dispositions: dispositions}, [link('implements', nextSet.revision_id), link('verification', activity.revision_id)], imp.revision_id);
        const g = guidance('rebind-product', nextSet.revision_id);
        for (const [operation, rows, diagnostic] of [
          ['wrong-configuration-role', dispositions.map(row => row.source_scope === configuration.revision_id ? {...row, candidate: {path: '.gitignore', name: configuration.payload.name, role: 'production'}} : row), 'change-source-candidate'],
          ['missing-configuration-target', dispositions.filter(row => row.source_scope !== configuration.revision_id), 'change-source-coverage'],
          ['unsupported-impact-role', dispositions.map(row => row.source_scope === configuration.revision_id ? {...row, candidate: {path: '.gitignore', name: configuration.payload.name, role: 'unsupported'}} : row), '/candidate/role must be equal to one of the allowed values'],
        ]) {
          const rejected = cli(['proposal', 'submit', '-'], {operation, action: g.action, package: g.package, snapshot: g.snapshot, subject: g.subject, inputs: g.inputs, candidates: [{...output, payload: {...output.payload, impact_dispositions: rows}}]}, {expected: 1});
          assert.ok(JSON.stringify(rejected.diagnostics).includes(diagnostic), JSON.stringify(rejected));
          assert.equal(cli(['proposal', 'settlement', operation]).outcome, 'not-published');
          assert.equal(guidance('rebind-product', nextSet.revision_id).snapshot, g.snapshot);
        }
        // Omitted candidate coordinates must survive automatic derivation and final stored-payload validation.
        const maintained = submit('rebind-product', nextSet.revision_id, [output]).find(d => d.type === 'IMP');
        const stored = exact(maintained.revision_id);
        const mapping = stored.payload.impact_dispositions.find(row => row.source_scope === configuration.revision_id);
        assert.deepEqual(mapping.candidate, {path: '.gitignore', name: configuration.payload.name, role: 'configuration'});
        assert.deepEqual(stored.payload.impact_dispositions.map(row => row.source_scope).sort(), [...required].sort());
        assert.ok(data().some(d => d.type === 'SCP' && d.payload.path === '.gitignore' && d.payload.role === 'configuration' && d.links.some(l => l.type === 'belongs-to' && l.target === maintained.revision_id)));
        assert.deepEqual(exact(imp.revision_id), imp, 'Baseline implementation remains immutable');
        terminal = cli(['expectations']);
        cli(['doctor']);
        save('configuration-impact-proof.json', {implementation: maintained.revision_id, required, mapping, rejected: ['wrong-configuration-role', 'missing-configuration-target', 'unsupported-impact-role']});
        return;
      }
      if (newRootChange) {
        const statement = 'The caller shall undo the latest recorded count.';
        const change = submit('request-change', set.revision_id, [candidate('add-undo', 'CHG', {reason: 'Add one separate stakeholder obligation.', requested_outcome: statement, new_roots: [statement]})]).find(d => d.type === 'CHG');
        assert.equal(change.links.filter(l => l.type === 'changes').length, 0, 'New-root-only scope needs no existing target');
        const context = cli(['review', 'context', 'approve-change', change.revision_id]);
        save('new-root-approval-context.json', context);
        assert.deepEqual(context.prospectiveChange.request.new_roots, [statement]);
        assert.deepEqual(context.prospectiveChange.requirements, []);
        submit('approve-change', change.revision_id, [candidate('undo-approval', 'REV', {outcome: 'pass', findings: `Approve exactly the declared undo root and its new downward branch. ${fixtureAuthority}`}, [link('reviews', change.revision_id)])]);
        const g = guidance('revise-requirements', change.revision_id);
        assert.deepEqual(g.requirementAuthoringTargets.newRoots, [statement]);
        assert.deepEqual(g.requirementAuthoringTargets.frontier.requirements, []);
        const added = [
          candidate('undo', 'REQ', {kind: 'stakeholder', statement}),
          candidate('remove-latest', 'REQ', {kind: 'software', ears: {pattern: 'event', event: 'undo is requested', system: 'The CLI', response: 'remove the latest recorded count'}}),
          candidate('undo-group', 'DCP', {}, [link('parent', '$undo'), link('child', '$remove-latest')]),
          candidate('requirements', 'RQS', {}, [], set.revision_id),
        ];
        for (const [operation, outputs, diagnostic] of [
          ['unauthorized-root', [...added, candidate('foreign', 'REQ', {kind: 'stakeholder', statement: 'Unapproved unrelated capability.'}), candidate('foreign-group', 'DCP', {}, [link('parent', '$foreign'), link('child', '$remove-latest')])], 'change-addition-scope'],
          ['unauthorized-edit', [...added, candidate('edit-count', 'REQ', {...count.payload, ears: {...count.payload.ears, response: 'print twice the item count'}}, [], count.revision_id)], 'change-outside-scope'],
        ]) {
          const rejected = cli(['proposal', 'submit', '-'], {operation, action: g.action, package: g.package, snapshot: g.snapshot, subject: g.subject, inputs: g.inputs, candidates: outputs}, {expected: 1});
          assert.ok(JSON.stringify(rejected.diagnostics).includes(diagnostic), JSON.stringify(rejected));
          assert.equal(cli(['proposal', 'settlement', operation]).outcome, 'not-published');
          assert.equal(guidance('revise-requirements', change.revision_id).snapshot, g.snapshot, 'Rejected proposals publish nothing');
        }
        const revised = submit('revise-requirements', change.revision_id, added);
        const next = revised.find(d => d.type === 'RQS');
        for (const previous of initial) assert.deepEqual(exact(previous.revision_id), previous, 'Baseline history stays exact');
        const root = revised.find(d => d.payload.title === 'undo');
        const child = revised.find(d => d.payload.title === 'remove-latest');
        const group = revised.find(d => d.payload.title === 'undo-group');
        assert.equal(root.payload.statement, statement);
        for (const datum of [root, child, group, next]) assert.ok(datum.links.some(l => l.type === 'changes-under' && l.target === change.revision_id));
        assert.ok(group.links.some(l => l.type === 'parent' && l.target === root.revision_id));
        assert.ok(group.links.some(l => l.type === 'child' && l.target === child.revision_id));
        for (const revision of [need, count, root, child]) assert.ok(next.links.some(l => l.type === 'contains' && l.target === revision.revision_id));
        terminal = cli(['expectations']);
        assert.ok(terminal.items.some(item => actionId(item.action) === 'review-requirements' && item.subject === next.revision_id));
        cli(['doctor']);
        save('new-root-proof.json', {change: change.revision_id, baseline: acceptance.revision_id, selection: next.revision_id, root: root.revision_id, child: child.revision_id, group: group.revision_id, rejected: ['unauthorized-root', 'unauthorized-edit'], terminal});
        return;
      }
      const beforeMaintenance = publications.length;
      const change = submit('request-change', set.revision_id, [candidate('simplify-count', 'CHG', {reason: 'Simplify the implementation while retaining every accepted obligation.', requested_outcome: 'Use an explicit supplied-argument slice to count items with unchanged behavior.'}, [link('baseline', acceptance.revision_id), link('changes', need.revision_id)])]).find(d => d.type === 'CHG');
      submit('approve-change', change.revision_id, [candidate('maintenance-approval', 'REV', {outcome: 'pass', findings: `Approve implementation-only maintenance preserving the exact requirement graph. ${fixtureAuthority}`}, [link('reviews', change.revision_id)])]);
      const nextSet = submit('revise-requirements', change.revision_id, [candidate('requirements', 'RQS', {}, [], set.revision_id)]).find(d => d.type === 'RQS');
      for (const relation of ['contains', 'decomposition']) assert.deepEqual(nextSet.links.filter(l => l.type === relation), set.links.filter(l => l.type === relation));
      const available = cli(['expectations']);
      assert.ok(available.items.some(item => actionId(item.action) === 'rebind-product' && item.subject === nextSet.revision_id));
      assert.ok(!available.items.some(item => actionId(item.action) === 'review-requirements' && item.subject === nextSet.revision_id));
      assert.notEqual(available.outcome, 'profile-boundary-reached');
      writeFileSync(path.join(source, 'count.py'), readFileSync(path.join(source, 'count.py'), 'utf8').replace('len(sys.argv) - 1', 'len(sys.argv[1:])'));
      commit(source, 'Simplify implementation without changing requirements');
      const maintainedCommit = git(['rev-parse', 'HEAD'], source); sourceCommits.push(maintainedCommit);
      const maintained = submit('rebind-product', nextSet.revision_id, [candidate('implementation', 'IMP', {...imp.payload, source_commit: maintainedCommit, impact_dispositions: [], product_files: undefined, source_inventory: undefined, source_changes: undefined}, [link('implements', nextSet.revision_id), link('verification', activity.revision_id)], imp.revision_id)]).find(d => d.type === 'IMP');
      assert.notEqual(maintained.revision_id, imp.revision_id);
      assert.notEqual(cli(['expectations']).outcome, 'profile-boundary-reached');
      const nextAcceptance = finishProduct(nextSet, maintained);
      assert.notEqual(nextAcceptance.revision_id, acceptance.revision_id);
      assert.deepEqual(exact(originalReview.revision_id), originalReview, 'Reuse must not replace the original review');
      assert.ok(!data().some(d => d.type === 'REV' && d.links.some(l => l.type === 'reviews' && l.target === nextSet.revision_id)), 'No new requirements review is published');
      for (const action of ['request-change', 'approve-change', 'revise-requirements', 'rebind-product', 'execute-verification', 'review-implementation', 'accept-product']) assert.ok(publications.slice(beforeMaintenance).some(publication => actionId(publication.action) === action), `Maintenance retains ${action}`);
      assert.equal(receipts.length, 2, 'Both baseline and maintained source receive canonical execution');
      if (operationalUse) {
        recordUse(maintained, ['gold', 'silver', 'bronze'], {negativeChecks: true, wrongSubject: imp.revision_id});
        assert.equal(operationalUses.length, 3);
        assert.equal(operationalUses[0].sourceCommit, operationalUses[1].sourceCommit);
        assert.notEqual(operationalUses[2].sourceCommit, operationalUses[0].sourceCommit);
        assert.equal(new Set(operationalUses.map(use => use.evidenceReference)).size, 3);
        assert.equal(receipts.length, 2, 'Logging three uses must add no canonical execution');
        const oldGuidance = guidance('record-operational-use', imp.revision_id);
        assert.equal(oldGuidance.inputs.prior_uses.length, 2, 'Historical source remains discoverable after revision');
        for (const use of operationalUses) assert.equal(exact(use.revision).links.find(l => l.type === 'observes').target, use.subject);
      }
      // Reuse the accepted setup above; only the comparison route is new.
      const formalTypes = ['REQ', 'DCP', 'RQS', 'IMP', 'ACC', 'CHG'];
      const frozenFormal = data().filter(d => formalTypes.includes(d.type));
      const observeComparison = (trial, exp, recommendation) => {
        const result = publishVerification(trial, exp);
        return submit('observe-prototype', trial.revision_id, [candidate('comparison-observation', 'OBS', {
        assessment: 'The candidate passed the separately committed criterion verification cases.', observation_origin: 'scripted',
        interaction_observation: 'Captured subprocess execution; no human usability claim.', limitations: fixtureAuthority,
        recommendation, next_action: recommendation === 'nominate' ? 'Request fixture stakeholder direction.' : 'Retain accepted product and close this comparison.',
      }, [link('observes', trial.revision_id), link('against', exp.revision_id), link('uses-evidence', result.revision_id)])]).find(d => d.type === 'OBS');
      };
      const originalActivity = planVerification(initialExperiment, countCases);
      const originalTrial = submit('prepare-prototype', initialExperiment.revision_id, [candidate('original-trial', 'TRY', {...maintained.payload, file_roles: undefined, product_files: undefined, source_inventory: undefined, source_changes: undefined, impact_dispositions: undefined}, [link('explores', initialExperiment.revision_id), link('verification', originalActivity.revision_id)])]).find(d => d.type === 'TRY');
      observeComparison(originalTrial, initialExperiment, 'keep');
      const start = guidance('explore-change', maintained.revision_id);
      assert.deepEqual(start.inputs.baseline, [nextAcceptance.revision_id]);
      const comparisonCandidate = start.candidates[0];
      comparisonCandidate.payload = {...initialExperiment.payload, criterion: 'Try words instead of the accepted numeric count.', question: 'Does a word improve readability?', approach: 'A tiny output-only candidate.', constraints: `Intentionally departs from ${count.revision_id}; accepted source remains ${maintainedCommit}.`};
      const comparison = submit('explore-change', maintained.revision_id, [comparisonCandidate]).find(d => d.type === 'EXP');
      assert.equal(comparison.id, initialExperiment.id);
      assert.equal(cli(['expectations']).outcome, 'work-available');
      const makeComparisonSource = word => {
        writeFileSync(path.join(source, 'count.py'), `print('${word}')\n`);
        commit(source, 'Record experimental output, without changing accepted requirements');
        const source_commit = git(['rev-parse', 'HEAD'], source); sourceCommits.push(source_commit);
        assert.notEqual(source_commit, maintainedCommit);
        return {repository_path: source, source_commit, command: ['python3', 'count.py', 'red', 'blue']};
      };
      const wordActivity = planVerification(comparison, [{id: 'words', command: ['python3', 'count.py', 'red', 'blue'], expected: 'two\n', rationale: 'The two-item comparison candidate should display the word two.'}]);
      const firstCandidate = submit('prepare-prototype', comparison.revision_id, [candidate('word-trial', 'TRY', makeComparisonSource('two'), [link('explores', comparison.revision_id), link('verification', wordActivity.revision_id)])]).find(d => d.type === 'TRY');
      const nominated = observeComparison(firstCandidate, comparison, 'nominate');
      assert.ok(!cli(['expectations']).optional.some(item => actionId(item.action) === 'explore-change'));
      const feedback = submit('record-feedback', nominated.revision_id, [candidate('comparison-feedback', 'FDB', {action: 'revise-criteria', feedback: 'Try an explicit descriptive phrase, then compare and decide.', source: fixtureAuthority}, [link('responds-to', nominated.revision_id)])]).find(d => d.type === 'FDB');
      const revisionGuide = guidance('revise-experiment-from-feedback', feedback.revision_id);
      const revisionCandidate = revisionGuide.candidates[0];
      revisionCandidate.payload = {...comparison.payload, criterion: 'Try a descriptive phrase for the count.'};
      const revised = submit('revise-experiment-from-feedback', feedback.revision_id, [revisionCandidate]).find(d => d.type === 'EXP');
      assert.deepEqual(revised.links.filter(l => l.type === 'compares-to'), [link('compares-to', nextAcceptance.revision_id)]);
      const pending = cli(['expectations']);
      assert.equal(pending.outcome, 'work-available');
      assert.deepEqual(pending.items.map(item => actionId(item.action)), ['prepare-prototype']);
      const phraseActivity = planVerification(revised, [{id: 'phrase', command: ['python3', 'count.py', 'red', 'blue'], expected: 'two supplied items\n', rationale: 'The revised comparison should display the explicit phrase for two supplied items.'}]);
      const secondCandidate = submit('prepare-prototype', revised.revision_id, [candidate('phrase-trial', 'TRY', makeComparisonSource('two supplied items'), [link('explores', revised.revision_id), link('verification', phraseActivity.revision_id)])]).find(d => d.type === 'TRY');
      observeComparison(secondCandidate, revised, 'drop');
      assert.deepEqual(data().filter(d => formalTypes.includes(d.type)), frozenFormal, 'Exploration creates no change request or formal revision');
      assert.deepEqual(exact(initialExperiment.revision_id), initialExperiment, 'Old requirement origins remain exact');
      assert.equal(cli(['expectations']).outcome, 'profile-boundary-reached');
    } else if (processName === 'tiny' && corrections) {
      const software = response => ({kind: 'software', ears: {pattern: 'ubiquitous', system: 'The CLI', response}});
      const initial = submit('draft-requirements', undefined, [
        candidate('need', 'REQ', {kind: 'stakeholder', statement: 'Tell me how many items I supplied as command-line arguments; the executable is not an item.'}),
        candidate('count', 'REQ', software('print the number of process arguments, including the executable')),
        candidate('decomposition', 'DCP', {}, [link('parent', '$need'), link('child', '$count')]),
        candidate('requirements', 'RQS', {}),
      ]);
      let requirement = initial.find(d => d.payload.title === 'count');
      let set = initial.find(d => d.type === 'RQS');
      const failedReview = reviewRequirements(set, {failRequirement: requirement.revision_id, findings: 'The software statement includes the executable, which directly contradicts the stakeholder. Count only supplied items. The existing decomposition remains sufficient.'}).review;
      const corrected = submit('correct-requirements-after-review', set.revision_id, [
        candidate('count', 'REQ', software('print the count of supplied command-line items on one line'), [], requirement.revision_id),
        candidate('requirements', 'RQS', {}, [link('corrects', failedReview.revision_id)], set.revision_id),
      ]);
      requirement = corrected.find(d => d.type === 'REQ'); set = corrected.find(d => d.type === 'RQS');
      reviewRequirements(set, {findings: 'The corrected statement excludes the executable and supports the stakeholder counting need. Quoted argument semantics remain an interpretation to check in use.'});
      const implementation = payload => ({...payload, file_roles: {'count.py': 'production', 'verify.py': 'verification'}});
      let imp = submit('implement-product', set.revision_id, [candidate('implementation', 'IMP', implementation(sourceVersion(requirement.id, undefined, false, {zeroBug: true, quoted: 2})), [link('implements', set.revision_id)])]).find(d => d.type === 'IMP');
      const failedReceipt = execute(imp, 'fail');
      const failedResult = submit('execute-verification', imp.revision_id, [candidate('verification', 'RES', {assessment: 'The two-argument count passed. The quoted red blue argument returned one while the script expected two by splitting its words. Stakeholder intention concerns supplied arguments, so clarify the expectation rather than changing correct quoted-argument behavior.', correction_target: 'requirements'}, [link('executes', imp.revision_id), link('verifies', set.revision_id)])], {receipt: failedReceipt}).find(d => d.type === 'RES');
      const clarified = submit('correct-expectations', failedResult.revision_id, [
        candidate('count', 'REQ', software('print the number of supplied command-line arguments on one line, counting each argument once even when its text contains spaces'), [], requirement.revision_id),
        candidate('requirements', 'RQS', {}, [link('corrects', failedResult.revision_id)], set.revision_id),
      ]);
      requirement = clarified.find(d => d.type === 'REQ'); set = clarified.find(d => d.type === 'RQS');
      reviewRequirements(set, {findings: 'Counting a quoted argument once clarifies the original stakeholder intention. This correction does not add a new feature or change the stakeholder statement.'});
      imp = submit('rebind-product', set.revision_id, [candidate('implementation', 'IMP', implementation(sourceVersion(requirement.id, undefined, false, {zeroBug: true, quoted: 1})), [link('implements', set.revision_id)], imp.revision_id)]).find(d => d.type === 'IMP');
      const rejected = finishProduct(set, imp, {decision: 'reject', checkZero: true, rationale: `Actual no-argument invocation printed one. The stakeholder supplied no items and needs zero. The script covered ordinary and quoted arguments but missed this defect. ${fixtureAuthority}`});
      const repaired = submit('correct-rejected-product', imp.revision_id, [candidate('implementation', 'IMP', implementation(sourceVersion(requirement.id, undefined, false, {quoted: 1, zeroCheck: true})), [link('implements', set.revision_id), link('corrects', rejected.revision_id)], imp.revision_id)]).find(d => d.type === 'IMP');
      finishProduct(set, repaired, {checkZero: true});
      assert.equal(exact(failedReview.revision_id).payload.outcome, 'fail');
      assert.equal(exact(failedResult.revision_id).payload.outcome, 'fail');
      assert.equal(exact(rejected.revision_id).payload.decision, 'reject');
    } else if (processName === 'tiny') {
      const initial = submit('draft-requirements', undefined, [
        candidate('need', 'REQ', {kind: 'stakeholder', statement: 'Count supplied command-line items and print an items label.'}),
        candidate('count', 'REQ', {kind: 'software', ears: {pattern: 'ubiquitous', system: 'The CLI', response: 'print the number of supplied command-line items on the first line'}}),
        candidate('label', 'REQ', {kind: 'software', ears: {pattern: 'ubiquitous', system: 'The CLI', response: 'print items on the second line'}}),
        candidate('decomposition', 'DCP', {}, [link('parent', '$need'), link('child', '$count'), link('child', '$label')]),
        candidate('requirements', 'RQS', {}),
      ]);
      const byTitle = title => initial.find(d => d.payload.title === title);
      const need = byTitle('need'), count = byTitle('count'), label = byTitle('label'), group = initial.find(d => d.type === 'DCP');
      const set = initial.find(d => d.type === 'RQS');
      reviewRequirements(set);
      const firstSource = sourceVersion(count.id, label.id);
      const imp = submit('implement-product', set.revision_id, [candidate('implementation', 'IMP', {...firstSource, file_roles: {'count.py': 'production', 'verify.py': 'verification'}}, [link('implements', set.revision_id)])]).find(d => d.type === 'IMP');
      const acceptance = finishProduct(set, imp);
      assert.equal(cli(['expectations']).outcome, 'lifecycle-complete');
      const change = submit('request-change', set.revision_id, [candidate('remove-label', 'CHG', {reason: 'The fixture stakeholder now wants only the count; the label adds unused output.', requested_outcome: 'Print only the item count. Retire the label requirement and remove its code and verification.'}, [link('baseline', acceptance.revision_id), link('changes', need.revision_id), link('changes', label.revision_id)])]).find(d => d.type === 'CHG');
      submit('approve-change', change.revision_id, [candidate('scope-approval', 'REV', {outcome: 'pass', findings: `Approve only label retirement and the corresponding stakeholder statement and decomposition. ${fixtureAuthority}`}, [link('reviews', change.revision_id)])]);
      const revisionGuidance = guidance('revise-requirements', change.revision_id);
      assert.deepEqual(revisionGuidance.requirementAuthoringTargets.frontier, {requirements: [need.revision_id, label.revision_id], groups: []});
      assert.ok(revisionGuidance.requirementAuthoringTargets.impact.requirements.includes(count.revision_id));
      const outsideFrontier = cli(['proposal', 'submit', '-'], {
        operation: 'reject-outside-authoring-frontier', action: revisionGuidance.action, package: revisionGuidance.package,
        snapshot: revisionGuidance.snapshot, subject: revisionGuidance.subject, inputs: revisionGuidance.inputs,
        candidates: [candidate('count', 'REQ', {...count.payload, ears: {...count.payload.ears, response: 'count each supplied argument'}}, [], count.revision_id), candidate('requirements', 'RQS', {}, [], set.revision_id)],
      }, {expected: 1});
      assert.match(JSON.stringify(outsideFrontier.diagnostics), /change-frontier/);
      const revised = submit('revise-requirements', change.revision_id, [
        candidate('need', 'REQ', {kind: 'stakeholder', statement: 'Count supplied command-line items.'}, [], need.revision_id),
        candidate('decomposition', 'DCP', {}, [link('parent', '$need'), link('child', count.revision_id)], group.revision_id),
        candidate('requirements', 'RQS', {}, [link('retires', label.revision_id)], set.revision_id),
      ]);
      const nextSet = revised.find(d => d.type === 'RQS');
      const reassessment = reviewRequirements(nextSet);
      const dispositions = reassessment.sourceScopes.map(source_scope => ({source_scope, disposition: 'removed', rationale: 'The approved change retires the label behavior and removes this label-only source region.'}));
      const secondSource = sourceVersion(count.id);
      const nextImp = submit('rebind-product', nextSet.revision_id, [candidate('implementation', 'IMP', {...secondSource, file_roles: {'count.py': 'production', 'verify.py': 'verification'}, impact_dispositions: dispositions}, [link('implements', nextSet.revision_id)], imp.revision_id)]).find(d => d.type === 'IMP');
      finishProduct(nextSet, nextImp);
      assert.deepEqual(exact(label.revision_id), label, 'Retirement preserves the historical requirement');
    } else {
      const experiment = submit('frame-experiment', undefined, [candidate('count-experiment', 'EXP', {criterion: 'Count command-line arguments.', question: 'Can a small program and executable evidence survive nomination and feedback revision?', approach: 'Use a Python counter and subprocess assertion.', constraints: 'CLI only; no persistence or user acceptance claim.', allowance_minutes: 10, scope_cut: 'One count operation.'})]).find(d => d.type === 'EXP');
      const prototype = submit('prepare-prototype', experiment.revision_id, [candidate('counter-prototype', 'TRY', sourceVersion(), [link('explores', experiment.revision_id)])]).find(d => d.type === 'TRY');
      const observe = (trial, receipt, recommendation) => submit('observe-prototype', trial.revision_id, [candidate('counter-observation', 'OBS', {assessment: recommendation === 'nominate' ? 'The scripted counter passed its assertion; nominate for fixture feedback.' : 'The revised assertion intentionally expected three for two arguments and failed. Preserve the failure and stop.', observation_origin: 'scripted', interaction_observation: 'A subprocess invoked the counter; no interactive user session.', limitations: fixtureAuthority, recommendation, next_action: recommendation === 'nominate' ? 'Request explicit fixture stakeholder feedback.' : 'Drop this intentionally failing experiment.'}, [link('observes', trial.revision_id), link('against', experiment.revision_id)])], {receipt}).find(d => d.type === 'OBS');
      const nomination = observe(prototype, execute(prototype, 'pass'), 'nominate');
      const feedback = submit('record-feedback', nomination.revision_id, [candidate('fixture-feedback', 'FDB', {action: 'revise-prototype', feedback: 'Exercise a captured assertion failure in a revised trial, then stop this fixture.', source: fixtureAuthority}, [link('responds-to', nomination.revision_id)])]).find(d => d.type === 'FDB');
      const revised = submit('revise-prototype', feedback.revision_id, [candidate('counter-prototype', 'TRY', sourceVersion(undefined, undefined, true), [link('explores', experiment.revision_id), link('responds-to', feedback.revision_id)], prototype.revision_id)]).find(d => d.type === 'TRY');
      observe(revised, execute(revised, 'fail'), 'drop');
      assert.deepEqual(exact(prototype.revision_id), prototype, 'Revision preserves the original prototype');
    }
    stage = 'closure';
    terminal = cli(['expectations']);
    assert.equal(terminal.outcome, processName === 'tiny' ? 'lifecycle-complete' : 'profile-boundary-reached');
    cli(['doctor']);
  } catch (error) { caught = error; }
  finally {
    stage = 'capture-final-state';
    const capture = (file, args, cwd) => {
      try { return run(file, args, cwd, {expected: null}); } catch (error) { return {error: String(error)}; }
    };
    const gitState = Object.fromEntries([['lifecycle', lifecycle], ['source', source], ...verificationRepositories.map((directory, index) => [`verification-${index + 1}`, directory])].map(([name, cwd]) => [name, existsSync(cwd) ? {head: capture('git', ['rev-parse', 'HEAD'], cwd), tree: capture('git', ['rev-parse', 'HEAD^{tree}'], cwd), status: capture('git', ['status', '--porcelain'], cwd), refs: capture('git', ['for-each-ref', '--format=%(refname) %(objectname)'], cwd)} : null]));
    const captureFailures = [];
    for (const [name, state] of Object.entries(gitState)) {
      if (!state) { captureFailures.push(`${name} repository is unavailable`); continue; }
      for (const [command, record] of Object.entries(state)) {
        if (record.status !== 0 || record.error || record.signal) captureFailures.push(`${name} ${command} capture failed`);
      }
      if (state.status.status === 0 && state.status.stdout.trim()) captureFailures.push(`${name} repository has uncommitted changes`);
    }
    let lifecycleData;
    if (existsSync(lifecycle)) { try { lifecycleData = [...new Set(revisions)].map(exact); } catch (error) { lifecycleData = {error: String(error)}; captureFailures.push(`Lifecycle data capture failed: ${error.message}`); } }
    save('lifecycle-data.json', lifecycleData ?? []);
    if (captureFailures.length && !caught) caught = new Error(`Final evidence is incomplete: ${captureFailures.join('; ')}`);
    const result = {ok: !caught, outcome: caught ? 'failed' : terminal?.outcome ?? 'failed', process: processName, corrections, operationalUse, newRootChange, configurationImpact, lateRequirementCorrection, operationalUses, root, lifecycle, source, verificationRepositories, evidenceFile, publications, revisions, receipts, sourceCommits, commands, terminal, gitState, captureFailures, scope: fixtureAuthority, error: caught ? {message: caught.message, stack: caught.stack} : undefined};
    save('result.json', result);
    if (caught) { caught.message += `\nPreserved journey evidence: ${evidenceFile}`; throw caught; }
    return result;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const executable = option('--executable') ?? process.env.MDLM_DIRECT_EXECUTABLE ?? process.env.MDLM_EXECUTABLE;
  runDirectJourney({process: option('--process') ?? 'tiny', corrections: args.includes('--corrections'), partialAcceptance: args.includes('--partial-acceptance'), operationalUse: args.includes('--operational-use'), newRootChange: args.includes('--new-root-change'), configurationImpact: args.includes('--configuration-impact'), lateRequirementCorrection: args.includes('--late-requirement-correction'), executable, root: option('--root')}).then(result => console.log(JSON.stringify({ok: result.ok, outcome: result.outcome, publications: result.publications, receipts: result.receipts, commands: result.commands, evidenceFile: result.evidenceFile}))).catch(error => { console.error(error.stack); process.exitCode = 1; });
}
