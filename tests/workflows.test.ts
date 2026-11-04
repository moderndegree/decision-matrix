import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
	ACCESS_REVIEW_RULES,
	ATTACK_TRIAGE_RULES,
	SDLC_RULES,
	SUPPORT_OPS_RULES,
	assertFactsResolve,
	decideFromFacts,
	evaluateRules,
	referencedQuestions,
	validateRuleset,
	type AnswerView,
} from 'decision-matrix-rules';
import { ACCESS_REVIEW_QUESTIONS, ATTACK_TRIAGE_QUESTIONS } from 'decision-matrix-systemone';

import { readFactsInput, readQuestions } from '../nodes/DecisionMatrix/parameters';

const { profileFor } = createRequire(__filename)('../docker/mock-systemone.mjs') as {
	profileFor: (state: unknown) => { name: string; answers: Record<string, AnswerView> } | null;
};

interface WorkflowNode {
	name: string;
	type: string;
	parameters?: Record<string, unknown>;
	credentials?: Record<string, { name?: string }>;
}

interface WorkflowFile {
	name?: string;
	active?: boolean;
	nodes: WorkflowNode[];
	connections: Record<string, { main?: Array<Array<{ node: string }>> }>;
	pinData?: Record<string, Array<{ json: Record<string, unknown> }>>;
}

const examplesDir = path.join(__dirname, '..', 'examples');

function loadWorkflow(fileName: string): WorkflowFile {
	return JSON.parse(readFileSync(path.join(examplesDir, fileName), 'utf8')) as WorkflowFile;
}

function decisionNode(workflow: WorkflowFile): WorkflowNode {
	const node = workflow.nodes.find((entry) => entry.name === 'Decision Matrix');
	assert.ok(node, 'workflow includes a Decision Matrix node');
	return node;
}

function assertWired(workflow: WorkflowFile): void {
	const webhookTargets = workflow.connections.Webhook?.main?.[0]?.map((link) => link.node) ?? [];
	const decisionTargets = workflow.connections['Decision Matrix']?.main?.[0]?.map((link) => link.node) ?? [];
	assert.deepEqual(webhookTargets, ['Decision Matrix']);
	assert.deepEqual(decisionTargets, ['Switch on action']);
	const switchNode = workflow.nodes.find((entry) => entry.name === 'Switch on action');
	assert.equal(switchNode?.type, 'n8n-nodes-base.switch');
}

describe('example workflows', () => {
	it('imports a support workflow whose rules match the support preset', () => {
		const workflow = loadWorkflow('support-ops.workflow.json');
		const node = decisionNode(workflow);
		assert.equal(node.type, 'n8n-nodes-decision-matrix.decisionMatrix');
		assert.equal(node.credentials?.decisionServerApi?.name, 'Decision Server API');
		assert.equal(node.parameters?.questionSet, 'support');
		assert.deepEqual(node.parameters?.rules, SUPPORT_OPS_RULES);
		const ruleset = validateRuleset(node.parameters?.rules);
		const questions = new Set(Object.keys(readQuestions('support', undefined)));
		for (const rule of ruleset.rules) {
			for (const question of referencedQuestions(rule.when)) {
				assert.ok(questions.has(question), `${question} is in the support preset`);
			}
		}
		assertWired(workflow);
	});

	it('imports an SDLC workflow whose rules match the SDLC preset', () => {
		const workflow = loadWorkflow('sdlc-change.workflow.json');
		const node = decisionNode(workflow);
		assert.equal(node.type, 'n8n-nodes-decision-matrix.decisionMatrix');
		assert.equal(node.parameters?.questionSet, 'sdlc');
		assert.deepEqual(node.parameters?.rules, SDLC_RULES);
		const ruleset = validateRuleset(node.parameters?.rules);
		const questions = new Set(Object.keys(readQuestions('sdlc', undefined)));
		for (const rule of ruleset.rules) {
			for (const question of referencedQuestions(rule.when)) {
				assert.ok(questions.has(question), `${question} is in the SDLC preset`);
			}
		}
		assertWired(workflow);
	});

	it('runs the SDLC feedback loop through intake, design, and the release gate', () => {
		const workflow = loadWorkflow('sdlc-feedback.workflow.json');
		const byName = new Map(workflow.nodes.map((node) => [node.name, node]));
		for (const name of ['Intake policy', 'Design gate', 'Release gate']) {
			const node = byName.get(name);
			assert.ok(node, name);
			assert.equal(node?.type, 'n8n-nodes-decision-matrix.decisionMatrix');
			assert.equal(node?.credentials?.decisionServerApi?.name, 'Decision Server API');
			const ruleset = validateRuleset(node?.parameters?.rules);
			const questions = new Set(Object.keys(readQuestions('custom', node?.parameters?.questions)));
			for (const rule of ruleset.rules) {
				for (const question of referencedQuestions(rule.when)) {
					assert.ok(questions.has(question), `${name} asks ${question}`);
				}
			}
		}

		assert.deepEqual(
			workflow.connections['Reopen the change']?.main?.[0]?.map((link) => link.node),
			['Change context'],
		);
		assert.deepEqual(
			workflow.connections['Error-budget poll']?.main?.[0]?.map((link) => link.node),
			['Error-budget probe'],
		);
		assert.deepEqual(
			workflow.connections['Deploy alert']?.main?.[0]?.map((link) => link.node),
			['Alert envelope'],
		);
		assert.deepEqual(
			workflow.connections['Change opened']?.main?.[0]?.map((link) => link.node),
			['Normalize change'],
		);
		assert.deepEqual(workflow.pinData?.['Change opened'], workflow.pinData?.['Walk the lifecycle']);
		assert.equal(workflow.pinData?.['Deploy alert']?.[0]?.json.title, 'Checkout alert');
		assert.match(String(workflow.pinData?.['Deploy alert']?.[0]?.json.state), /down/);

		const intake = byName.get('Intake policy')?.parameters?.rules;
		const design = byName.get('Design gate')?.parameters?.rules;
		const monitor = byName.get('Release gate')?.parameters?.rules;
		const choice = (choice: string, confidence: number): AnswerView => ({
			type: 'choice',
			choice,
			confidence,
		});
		const score = (score: number, confidence: number): AnswerView => ({
			type: 'score',
			score,
			confidence,
		});
		const noul = (noul: number): AnswerView => ({ type: 'noul', noul });

		assert.equal(
			evaluateRules(intake, {
				work_type: choice('bugfix', 0.93),
				blast_radius: score(0, 0.95),
				needs_design: noul(0.04),
				needs_human: noul(0.05),
			}).matched_rule,
			'ship-it',
		);
		assert.equal(
			evaluateRules(intake, {
				work_type: choice('feature', 0.91),
				blast_radius: score(3, 0.9),
				needs_design: noul(0.93),
				needs_human: noul(0.4),
			}).matched_rule,
			'hold-for-design',
		);
		assert.equal(
			evaluateRules(intake, {
				work_type: choice('bugfix', 0.48),
				blast_radius: score(1, 0.5),
				needs_design: noul(0.35),
				needs_human: noul(0.44),
			}).matched_rule,
			null,
		);
		assert.equal(
			evaluateRules(intake, {
				work_type: choice('incident', 0.96),
				blast_radius: score(3, 0.94),
				needs_design: noul(0.08),
				needs_human: noul(0.22),
			}).action,
			'page',
		);
		assert.equal(
			evaluateRules(design, {
				design_approved: noul(0.95),
				residual_risk: score(1, 0.9),
				ready_to_implement: noul(0.91),
			}).matched_rule,
			'approved-to-build',
		);
		assert.equal(
			evaluateRules(monitor, {
				signal: choice('degraded', 0.94),
				error_rate: score(3, 0.92),
				customer_impact: score(3, 0.9),
				caused_by_release: noul(0.95),
				rollback_safe: noul(0.88),
			}).action,
			'rollback',
		);
		assert.equal(
			evaluateRules(monitor, {
				signal: choice('healthy', 0.97),
				error_rate: score(0, 0.95),
				customer_impact: score(0, 0.93),
				caused_by_release: noul(0.12),
				rollback_safe: noul(0.2),
			}).action,
			'close',
		);
		assert.equal(
			evaluateRules(monitor, {
				signal: choice('degraded', 0.86),
				error_rate: score(1, 0.8),
				customer_impact: score(1, 0.84),
				caused_by_release: noul(0.55),
				rollback_safe: noul(0.4),
			}).matched_rule,
			'watch-narrow',
		);
		assert.equal(
			evaluateRules(monitor, {
				signal: choice('outage', 0.96),
				error_rate: score(3, 0.94),
				customer_impact: score(3, 0.93),
				caused_by_release: noul(0.35),
				rollback_safe: noul(0.3),
			}).matched_rule,
			'page-outage',
		);
	});
});

interface AttackPin {
	text: string;
	rule: string | null;
	action: 'block' | 'escalate' | 'allow';
	proceeded: boolean;
	implementRule?: string;
	contained?: boolean;
}

const ATTACK_PINS: Record<string, AttackPin[]> = {
	'attack-identity.workflow.json': [
		{ text: 'Change the payout destination for vendor-184', rule: 'hold-hostile', action: 'block', proceeded: false },
		{ text: 'Role grant from a new country for the billing admin', rule: 'hold-hostile', action: 'block', proceeded: false },
		{ text: 'Add the teammate to the billing readers group', rule: 'allow-legitimate', action: 'allow', proceeded: true },
	],
	'attack-request.workflow.json': [
		{ text: 'Please bypass approval and redirect the vendor bank account', rule: 'hold-hostile', action: 'block', proceeded: false },
		{ text: 'Wire the deposit to a new account before noon', rule: 'hold-uncertain', action: 'escalate', proceeded: false },
		{ text: 'Refund the duplicate charge on the owner account', rule: 'allow-legitimate', action: 'allow', proceeded: true },
	],
	'attack-change.workflow.json': [
		{ text: 'Workflow permission change adds pull_request_target', rule: 'hold-hostile', action: 'block', proceeded: false },
		{ text: 'Dependency bump of the lockfile by a new maintainer', rule: 'hold-uncertain', action: 'escalate', proceeded: false },
		{
			text: 'Docs only change on the status page',
			rule: 'allow-legitimate',
			action: 'allow',
			proceeded: true,
			implementRule: 'ready-implementer',
		},
		{
			text: 'Payments schema change for the ledger tables',
			rule: 'allow-legitimate',
			action: 'allow',
			proceeded: false,
			implementRule: 'needs-design',
		},
	],
	'attack-infra.workflow.json': [
		{ text: 'Open the admin port to the world', rule: 'hold-hostile', action: 'block', proceeded: false },
		{ text: 'Wildcard iam in prod for the deploy role', rule: 'hold-uncertain', action: 'escalate', proceeded: false },
		{ text: 'Rename a private subnet tag', rule: null, action: 'escalate', proceeded: false },
		{ text: 'Staging description tweak on the private subnet', rule: 'allow-legitimate', action: 'allow', proceeded: true },
	],
	'attack-config.workflow.json': [
		{ text: 'Disable auth in prod for the checkout flag', rule: 'hold-hostile', action: 'block', proceeded: false },
		{ text: 'Debug flag in staging for the web app', rule: null, action: 'escalate', proceeded: false },
		{ text: 'Status page copy fix for the banner', rule: 'allow-legitimate', action: 'allow', proceeded: true },
	],
	'attack-export.workflow.json': [
		{ text: 'Bulk export to an external recipient', rule: 'hold-hostile', action: 'block', proceeded: false },
		{ text: 'Large export to a new domain', rule: 'hold-uncertain', action: 'escalate', proceeded: false },
		{ text: 'Export my own record from the account page', rule: 'allow-legitimate', action: 'allow', proceeded: true },
	],
	'attack-agent.workflow.json': [
		{ text: 'Agent tool call to change the payout destination', rule: 'hold-hostile', action: 'block', proceeded: false },
		{ text: 'Agent tool call to run a shell', rule: 'hold-uncertain', action: 'escalate', proceeded: false },
		{ text: 'Agent tool call to read the public handbook', rule: 'allow-legitimate', action: 'allow', proceeded: true },
	],
	'attack-detect.workflow.json': [
		{ text: 'Prior holds on this token during sign-in', rule: 'hold-hostile', action: 'block', proceeded: false, contained: true },
		{ text: 'Auth failures from a new country', rule: 'hold-hostile', action: 'block', proceeded: false, contained: true },
		{ text: 'Error spike during office hours on the api', rule: 'hold-uncertain', action: 'escalate', proceeded: false, contained: false },
		{ text: 'Deploy marker explains the error rate', rule: 'allow-legitimate', action: 'allow', proceeded: false, contained: false },
	],
};

function nodeByName(workflow: WorkflowFile, name: string): WorkflowNode {
	const node = workflow.nodes.find((entry) => entry.name === name);
	assert.ok(node, name);
	return node;
}

function targets(workflow: WorkflowFile, name: string): string[] {
	return (workflow.connections[name]?.main ?? []).map((output) => output[0]?.node ?? '');
}

function assignment(node: WorkflowNode, name: string): unknown {
	const assignments = node.parameters?.assignments as { assignments?: Array<{ name?: string; value?: unknown }> } | undefined;
	const row = assignments?.assignments?.find((entry) => entry.name === name);
	assert.ok(row, `${node.name} assigns ${name}`);
	return row?.value;
}

function thresholdOverrides(node: WorkflowNode): Record<string, number> {
	const thresholds = node.parameters?.thresholds as { threshold?: Array<{ name?: string; value?: unknown }> } | undefined;
	const overrides: Record<string, number> = {};
	for (const row of thresholds?.threshold ?? []) {
		assert.equal(typeof row.name, 'string');
		assert.equal(typeof row.value, 'number');
		overrides[row.name as string] = row.value as number;
	}
	return overrides;
}

describe('attack gate workflows', () => {
	it('keeps lifecycle phrases on their own profiles', () => {
		assert.equal(profileFor('Fix a typo in the README')?.name, 'typo');
		assert.equal(profileFor('Checkout is down for customers')?.name, 'outage');
		assert.equal(profileFor('Error rate flat. Service healthy.')?.name, 'healthy');
		assert.equal(profileFor('Error spike during office hours on the api')?.name, 'office-hours');
	});

	for (const [fileName, pins] of Object.entries(ATTACK_PINS)) {
		it(`routes ${fileName} from facts to one enforcement`, () => {
			const workflow = loadWorkflow(fileName);
			assert.equal(workflow.active, false);
			const gate = nodeByName(workflow, 'Attack gate');
			assert.equal(gate.type, 'n8n-nodes-decision-matrix.decisionMatrix');
			assert.equal(gate.credentials?.decisionServerApi?.name, 'Decision Server API');
			assert.equal(gate.parameters?.questionSet, 'custom');
			assert.deepEqual(gate.parameters?.questions, ATTACK_TRIAGE_QUESTIONS);
			assert.deepEqual(gate.parameters?.rules, ATTACK_TRIAGE_RULES);
			const rawRules = gate.parameters?.rules;
			const ruleset = validateRuleset(rawRules);
			const questions = new Set(Object.keys(readQuestions('custom', gate.parameters?.questions)));
			for (const rule of ruleset.rules) {
				for (const question of referencedQuestions(rule.when)) {
					assert.ok(questions.has(question), `${question} is asked`);
				}
			}

			const build = nodeByName(workflow, 'Build state');
			assert.equal(build.type, 'n8n-nodes-base.code');
			assert.match(String(build.parameters?.jsCode), /event\.facts/);
			assert.match(String(build.parameters?.jsCode), /event\.request/);
			assert.deepEqual(targets(workflow, 'Walk the examples'), ['Build state']);
			assert.deepEqual(targets(workflow, 'Webhook'), ['Build state']);
			assert.deepEqual(targets(workflow, 'Build state'), ['Attack gate']);
			assert.deepEqual(targets(workflow, 'Attack gate'), ['Switch on action']);

			const branches = targets(workflow, 'Switch on action');
			assert.deepEqual(branches[3], branches[1]);
			const branchFor = { block: branches[0], escalate: branches[1], allow: branches[2] };
			const overrides = thresholdOverrides(gate);
			const walked = workflow.pinData?.['Walk the examples'] ?? [];
			assert.deepEqual(
				walked.map((item) => item.json.text),
				pins.map((pin) => pin.text),
			);
			assert.equal(workflow.pinData?.Webhook?.[0]?.json.body && (workflow.pinData.Webhook[0].json.body as { text?: string }).text, pins[0]?.text);

			const implement = workflow.nodes.find((entry) => entry.name === 'Implement gate');
			if (implement) {
				assert.equal(branchFor.allow, 'Implement gate');
				assert.equal(implement.parameters?.state, "={{ JSON.stringify($('Build state').item.json.state) }}");
				const implementRules = validateRuleset(implement.parameters?.rules);
				const implementQuestions = new Set(Object.keys(readQuestions('custom', implement.parameters?.questions)));
				assert.deepEqual([...implementQuestions], ['change_type', 'delivery_risk', 'needs_design', 'ready_to_implement']);
				for (const rule of implementRules.rules) {
					for (const question of referencedQuestions(rule.when)) {
						assert.ok(implementQuestions.has(question), `implement gate asks ${question}`);
					}
				}
				const implementBranches = targets(workflow, 'Switch on implement');
				assert.deepEqual(implementBranches[3], implementBranches[2]);
			}

			for (const pin of pins) {
				const profile = profileFor({ text: pin.text, request: 'untrusted words' });
				assert.ok(profile, pin.text);
				const decision = evaluateRules(rawRules, profile.answers, overrides);
				assert.equal(decision.matched_rule, pin.rule, pin.text);
				assert.equal(decision.action, pin.action, pin.text);
				assert.equal(decision.gate, pin.action !== 'allow', pin.text);

				if (pin.implementRule) {
					assert.ok(implement, 'allow continues to Implement gate');
					const second = evaluateRules(implement?.parameters?.rules, profile.answers);
					assert.equal(second.matched_rule, pin.implementRule, pin.text);
					const implementBranches = targets(workflow, 'Switch on implement');
					const implementTarget = { review: implementBranches[0], route: implementBranches[1], escalate: implementBranches[2] }[second.action];
					assert.ok(implementTarget, second.action);
					const outcome = nodeByName(workflow, implementTarget as string);
					assert.equal(assignment(outcome, 'proceeded'), pin.proceeded, pin.text);
					assert.equal(second.gate, !pin.proceeded, pin.text);
				} else {
					const outcome = nodeByName(workflow, branchFor[pin.action]);
					if (outcome.type === 'n8n-nodes-base.set') {
						assert.equal(assignment(outcome, 'proceeded'), pin.proceeded, pin.text);
						if (pin.contained !== undefined) {
							assert.equal(assignment(outcome, 'contained'), pin.contained, pin.text);
						}
					}
				}
			}

			if (fileName === 'attack-infra.workflow.json') {
				assert.deepEqual(overrides, { high_confidence: 0.9 });
				const profile = profileFor('Rename a private subnet tag');
				assert.ok(profile);
				assert.equal(evaluateRules(rawRules, profile.answers).matched_rule, 'allow-legitimate');
			}
		});
	}
});

describe('audit access review workflow', () => {
	const expected = [
		{ rule: 'revoke-inactive-principal', action: 'revoke', fromFacts: true },
		{ rule: 'revoke-stale-privileged', action: 'revoke', fromFacts: true },
		{ rule: 'review-human-without-mfa', action: 'review', fromFacts: true },
		{ rule: 'keep-justified', action: 'keep', fromFacts: false },
		{ rule: 'review-weak-justification', action: 'review', fromFacts: false },
		{ rule: 'review-injection', action: 'review', fromFacts: false },
	];

	it('builds facts from the directory record and routes each grant once', () => {
		const workflow = loadWorkflow('audit-access-review.workflow.json');
		assert.equal(workflow.active, false);
		assert.equal(workflow.nodes.some((entry) => entry.type === 'n8n-nodes-base.webhook'), false);
		const gate = nodeByName(workflow, 'Access review');
		assert.equal(gate.type, 'n8n-nodes-decision-matrix.decisionMatrix');
		assert.deepEqual(gate.parameters?.questions, ACCESS_REVIEW_QUESTIONS);
		assert.deepEqual(gate.parameters?.rules, ACCESS_REVIEW_RULES);
		assert.equal(gate.parameters?.facts, '={{ JSON.stringify($json.facts) }}');
		assert.deepEqual(targets(workflow, 'Walk the examples'), ['Build facts and state']);
		assert.deepEqual(targets(workflow, 'Monthly review'), ['Load grants']);
		assert.deepEqual(targets(workflow, 'Load grants'), ['Build facts and state']);
		assert.deepEqual(targets(workflow, 'Build facts and state'), ['Access review']);
		assert.deepEqual(targets(workflow, 'Access review'), ['Switch on action']);
		const branches = targets(workflow, 'Switch on action');
		assert.equal(branches[3], branches[1], 'an unnamed action goes to a reviewer');
		const branchFor: Record<string, string> = { revoke: branches[0]!, review: branches[1]!, keep: branches[2]! };

		const build = nodeByName(workflow, 'Build facts and state');
		const runBuild = new Function('$input', String(build.parameters?.jsCode)) as (input: unknown) => {
			json: { facts: Record<string, unknown>; state: Record<string, unknown> };
		};
		const grants = workflow.pinData?.['Walk the examples'] ?? [];
		assert.equal(grants.length, expected.length);

		grants.forEach((grant, index) => {
			const want = expected[index]!;
			const { facts: rawFacts, state } = runBuild({ item: { json: grant.json } }).json;
			// The node receives the Facts expression as JSON text.
			const facts = readFactsInput(JSON.stringify(rawFacts));
			assert.equal('justification' in (facts.grant as object), false, 'the justification is not a fact');
			assert.equal(typeof state.justification, 'string');
			assertFactsResolve(gate.parameters?.rules, facts);

			const early = decideFromFacts(gate.parameters?.rules, facts);
			let decision = early;
			if (!early) {
				const profile = profileFor(state);
				assert.ok(profile, `a mock profile answers grant ${index + 1}`);
				decision = evaluateRules(gate.parameters?.rules, profile.answers, undefined, facts);
			}
			assert.equal(Boolean(early), want.fromFacts, `grant ${index + 1} decided from facts`);
			assert.equal(decision?.matched_rule, want.rule, `grant ${index + 1}`);
			assert.equal(decision?.action, want.action, `grant ${index + 1}`);
			const outcome = nodeByName(workflow, branchFor[want.action]!);
			assert.equal(assignment(outcome, 'needs_action'), want.action !== 'keep');
		});
	});
});
