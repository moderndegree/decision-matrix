import { describe, expect, test } from 'bun:test';

import {
	NEW_CASES,
	addBlankCase,
	addScopeAnswer,
	addScopeFact,
	addThreshold,
	createWorkspace,
	deleteThreshold,
	derive,
	filesToSave,
	removeScopeValue,
	renameCase,
	renameThreshold,
	scopeValues,
	setDefaultAction,
	setExpectation,
	setScopeValue,
	setStrict,
	thresholdUsers,
	toggleDefaultGate,
	type EditResult,
	type JsonObject,
	type Workspace,
} from '../src/model';
import {
	addLabel,
	addLevel,
	addQuestion,
	deleteLabel,
	deleteLevel,
	deleteQuestion,
	labelUsers,
	moveLevel,
	questionUsers,
	renameLabel,
	renameQuestion,
	setInstructions,
	setLabelDescription,
	setQuestionType,
} from '../src/questions-model';
import { ciWorkspace, readExample } from './helpers';

function ok(result: EditResult): Workspace {
	if (!result.ok) throw new Error(result.error);
	return result.workspace;
}

function fails(result: EditResult, pattern: RegExp) {
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.error).toMatch(pattern);
}

const rulesOf = (workspace: Workspace) => workspace.rules.rules as JsonObject[];
const ruleById = (workspace: Workspace, id: string) => rulesOf(workspace).find((rule) => rule.id === id)!;
const casesOf = (workspace: Workspace) => workspace.cases!.cases as JsonObject[];

/** The attack-triage policy, which has a choice question with labels that rules compare. */
function attackWorkspace(): Workspace {
	return createWorkspace({
		rulesPath: 'attack.rules.json',
		rules: readExample('attack-triage.rules.json'),
		casesPath: 'attack.cases.json',
		cases: {
			version: 1,
			defaults: { answers: { intent: { type: 'choice', choice: 'benign', confidence: 0.9 }, risk: { type: 'score', score: 0, confidence: 0.9 }, needs_human: { type: 'noul', noul: 0.1 } } },
			cases: [{ name: 'hostile', answers: { intent: { type: 'choice', choice: 'reconnaissance', confidence: 0.95 } }, expect: { matched_rule: 'hold-hostile' } }],
		},
		questionsPath: 'attack.questions.json',
		questions: readExample('attack-triage.questions.json'),
	});
}

describe('default action and strict flag', () => {
	test('edits the default action, and a strict policy keeps it holding', () => {
		const start = ciWorkspace();
		const edited = ok(setDefaultAction(start, { type: 'escalate', target: 'security', reason: 'Nothing matched', gate: true }));
		expect((edited.rules.default_action as JsonObject).target).toBe('security');
		fails(toggleDefaultGate(start), /default_action.gate must be true/);
		fails(setDefaultAction(start, 'hold'), /must be an object/);
	});

	test('turns strict off, and refuses to turn it on while a rule breaks it', () => {
		const off = ok(setStrict(ciWorkspace(), false));
		expect('open_gate_requires_facts' in off.rules).toBe(false);
		expect(derive(off).changes.map((change) => change.effect)).toContain('loosens');
		fails(setStrict(attackWorkspace(), true), /"allow-legitimate"\) opens the gate/);
		expect(ok(toggleDefaultGate(off)).rules.default_action).toMatchObject({ gate: false });
	});
});

describe('thresholds', () => {
	test('adds a threshold, refusing a bad or taken name', () => {
		expect((ok(addThreshold(ciWorkspace(), 'strict_risk', 1)).rules.thresholds as JsonObject).strict_risk).toBe(1);
		fails(addThreshold(ciWorkspace(), '9lives', 1), /cannot be a threshold name/);
		fails(addThreshold(ciWorkspace(), 'injection', 1), /exists/);
	});

	test('renames everywhere: conditions in every form, templates, and case overrides', () => {
		const start = ciWorkspace();
		const withForms = ok(
			setDefaultAction(start, { type: 'hold', target: 'human', reason: 'Above {{ thresholds.high_risk }}', gate: true }),
		);
		const cases = { ...withForms, cases: { ...withForms.cases!, cases: [...casesOf(withForms), { name: 'override', thresholds: { high_risk: 3 }, expect: { gate: true } }] } };
		const renamed = ok(renameThreshold(cases, 'high_risk', 'risk_limit'));
		expect(Object.keys(renamed.rules.thresholds as JsonObject)).toEqual(['high_confidence', 'injection', 'suspicion', 'risk_limit', 'max_files']);
		expect(ruleById(renamed, 'hold-risk').when).toEqual({ all: [{ question: 'risk', gte: 'risk_limit' }] });
		expect((ruleById(renamed, 'hold-risk').action as JsonObject).reason).toBe('Security risk {{answers.risk.score}} is at or above {{thresholds.risk_limit}}');
		expect((renamed.rules.default_action as JsonObject).reason).toBe('Above {{thresholds.risk_limit}}');
		expect(casesOf(renamed).at(-1)!.thresholds).toEqual({ risk_limit: 3 });
		expect(derive(renamed).run!.results.every((result) => result.passed || result.name === 'override')).toBe(true);
		fails(renameThreshold(start, 'high_risk', 'injection'), /exists/);
	});

	test('deletes only an unused threshold', () => {
		const start = ciWorkspace();
		expect(thresholdUsers(start, 'high_risk')).toEqual(['hold-risk', 'pass-small-change']);
		fails(deleteThreshold(start, 'high_risk'), /used by hold-risk, pass-small-change/);
		const added = ok(addThreshold(start, 'spare', 1));
		expect('spare' in (ok(deleteThreshold(added, 'spare')).rules.thresholds as JsonObject)).toBe(false);
	});
});

describe('cases and defaults', () => {
	const workspace = ciWorkspace();
	const derived = derive(workspace);
	const defaults = { kind: 'defaults' } as const;
	const first = { kind: 'case', index: 0 } as const;

	test('shows and edits the shared defaults', () => {
		const values = scopeValues(workspace, derived, defaults);
		expect(values.every((value) => value.own)).toBe(true);
		const touches = values.find((value) => value.path === 'touches_ci')!;
		const edited = ok(setScopeValue(workspace, derived, defaults, touches, true));
		// Every case that does not override touches_ci now changes the CI rule.
		expect(derive(edited).run!.results.filter((result) => result.decision?.matched_rule === 'hold-ci-config').length).toBeGreaterThan(1);
	});

	test('adds a fact and an answer to a case, and removes an override so the default applies again', () => {
		const withFact = ok(addScopeFact(workspace, first, 'grant.owner', 'alice'));
		expect((casesOf(withFact)[0]!.facts as JsonObject).grant).toEqual({ owner: 'alice' });
		const withAnswer = ok(addScopeAnswer(workspace, first, 'risk'));
		expect((casesOf(withAnswer)[0]!.answers as JsonObject).risk).toEqual({ type: 'score', score: 0 });

		const own = scopeValues(workspace, derived, first).find((value) => value.path === 'touches_ci')!;
		expect(own.own).toBe(true);
		const reverted = ok(removeScopeValue(workspace, first, own));
		expect(casesOf(reverted)[0]!.facts).toEqual({ files_changed: 1 });
		const inherited = scopeValues(workspace, derived, first).find((value) => value.path === 'docs_only')!;
		fails(removeScopeValue(workspace, first, inherited), /comes from the defaults/);

		const nested = ok(addScopeFact(workspace, first, 'grant.owner', 'alice'));
		const leaf = scopeValues(nested, derive(nested), first).find((value) => value.path === 'grant.owner')!;
		expect('grant' in (casesOf(ok(removeScopeValue(nested, first, leaf)))[0]!.facts as JsonObject)).toBe(false);
	});

	test('edits expectations, renames, and adds a case that snapshots the decision', () => {
		const edited = ok(setExpectation(workspace, 0, 'target', 'security'));
		expect(casesOf(edited)[0]!.expect).toMatchObject({ target: 'security' });
		const removed = ok(setExpectation(edited, 0, 'target', undefined));
		expect('target' in (casesOf(removed)[0]!.expect as JsonObject)).toBe(false);
		// The first case expects matched_rule, gate, and from_facts. Remove two, and the last cannot go.
		const single = ok(setExpectation(ok(setExpectation(workspace, 0, 'gate', undefined)), 0, 'from_facts', undefined));
		fails(setExpectation(single, 0, 'matched_rule', undefined), /at least one expectation/);
		fails(setExpectation(workspace, 0, 'gate', 'yes'), /gate must be a boolean/);

		fails(renameCase(workspace, 0, casesOf(workspace)[1]!.name as string), /exists/);
		expect(casesOf(ok(renameCase(workspace, 0, 'renamed')))[0]!.name).toBe('renamed');

		const blank = ok(addBlankCase(workspace, 0, 'only defaults'));
		expect(casesOf(blank)[0]).toEqual({ name: 'only defaults', expect: { matched_rule: 'pass-small-change', action: 'pass', gate: false } });
	});

	test('starts a new cases file and writes only what changed', () => {
		const fresh = createWorkspace({ rulesPath: 'r.json', rules: readExample('ci-change.rules.json'), casesPath: 'new.cases.json', cases: NEW_CASES });
		expect(filesToSave(fresh)).toEqual([]);
		const added = ok(addBlankCase(fresh, 0, 'first'));
		expect(filesToSave(added).map((file) => file.path)).toEqual(['new.cases.json']);
	});
});

describe('questions', () => {
	test('renames a question in the rules, templates, and every case answer', () => {
		const start = attackWorkspace();
		const renamed = ok(renameQuestion(start, 'intent', 'event_intent'));
		expect(Object.keys(renamed.questions!)[0]).toBe('event_intent');
		expect(ruleById(renamed, 'hold-hostile').when).toMatchObject({ all: [{ question: 'event_intent' }] });
		expect((ruleById(renamed, 'hold-hostile').action as JsonObject).reason).toBe('Hold {{answers.event_intent.choice}} before any automated action');
		expect(Object.keys((renamed.cases!.defaults as JsonObject).answers as JsonObject)[0]).toBe('event_intent');
		expect(Object.keys(casesOf(renamed)[0]!.answers as JsonObject)).toEqual(['event_intent']);
		expect(derive(renamed).run!.results[0]!.passed).toBe(true);
		expect(derive(renamed).findings).toEqual(derive(start).findings);
	});

	test('renames a choice label in rule comparisons and saved choices', () => {
		const renamed = ok(renameLabel(attackWorkspace(), 'intent', 'reconnaissance', 'recon'));
		expect(ruleById(renamed, 'hold-hostile').when).toMatchObject({ all: [{ in: ['account_takeover', 'social_engineering', 'supply_chain', 'recon'] }] });
		expect((casesOf(renamed)[0]!.answers as JsonObject).intent).toMatchObject({ choice: 'recon' });
		expect(Object.keys(renamed.questions!.intent as JsonObject)).toContain('criteria');
		expect(derive(renamed).run!.results[0]!.passed).toBe(true);
	});

	test('refuses to delete what a rule reads', () => {
		const start = attackWorkspace();
		expect(questionUsers(start, 'risk')).toEqual(['hold-uncertain', 'allow-legitimate']);
		fails(deleteQuestion(start, 'risk'), /read by hold-uncertain, allow-legitimate/);
		expect(labelUsers(start, 'intent', 'benign')).toEqual(['allow-legitimate']);
		fails(deleteLabel(start, 'intent', 'benign'), /compared by allow-legitimate/);
		const added = ok(addQuestion(start, 'spare', 'noul'));
		const deleted = ok(deleteQuestion(added, 'spare'));
		expect('spare' in deleted.questions!).toBe(false);
	});

	test('adds questions and labels, edits text, and keeps the file valid', () => {
		let workspace = ok(addQuestion(attackWorkspace(), 'channel', 'choice'));
		workspace = ok(addLabel(workspace, 'channel', 'email'));
		workspace = ok(setLabelDescription(workspace, 'channel', 'email', 'Arrived by email'));
		expect((workspace.questions!.channel as JsonObject).criteria).toMatchObject({ email: 'Arrived by email' });
		fails(addLabel(workspace, 'channel', 'email'), /already has the label/);
		fails(setInstructions(workspace, 'channel', '  '), /instructions must say what the model is asked/);
		fails(addQuestion(workspace, 'two words', 'noul'), /cannot be empty or contain spaces/);
		fails(addQuestion(workspace, 'channel', 'noul'), /exists/);
	});

	test('changes types and edits score levels', () => {
		let workspace = ok(addQuestion(attackWorkspace(), 'priority', 'score'));
		workspace = ok(addLevel(workspace, 'priority', 'Urgent'));
		workspace = ok(moveLevel(workspace, 'priority', 2, -1));
		expect((workspace.questions!.priority as JsonObject).criteria).toEqual(['Lowest', 'Urgent', 'Highest']);
		workspace = ok(deleteLevel(workspace, 'priority', 0));
		fails(deleteLevel(workspace, 'priority', 0), /at least two levels/);
		const asChoice = ok(setQuestionType(workspace, 'priority', 'choice'));
		expect((asChoice.questions!.priority as JsonObject).criteria).toEqual({ Urgent: null, Highest: null });
		const asNoul = ok(setQuestionType(asChoice, 'priority', 'noul'));
		expect('criteria' in (asNoul.questions!.priority as JsonObject)).toBe(false);
		// A rule that no longer fits its question shows up in the lint, not as a refused edit.
		const risky = ok(setQuestionType(attackWorkspace(), 'risk', 'noul'));
		expect(derive(risky).findings.some((finding) => finding.code === 'out-of-range' || finding.code === 'operator-type')).toBe(true);
	});

	test('starts a new questions file', () => {
		const fresh = createWorkspace({ rulesPath: 'r.json', rules: readExample('ci-change.rules.json'), questionsPath: 'q.json', questions: {} });
		expect(filesToSave(fresh)).toEqual([]);
		const added = ok(addQuestion(fresh, 'first', 'noul'));
		expect(filesToSave(added)).toEqual([{ path: 'q.json', text: '{\n  "first": {\n    "type": "noul",\n    "instructions": "A statement the model rates from 0 (false) to 1 (true)"\n  }\n}\n' }]);
	});
});
