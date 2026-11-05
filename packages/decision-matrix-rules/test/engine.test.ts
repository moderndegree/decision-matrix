import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	ATTACK_TRIAGE_RULES,
	GENERIC_TRIAGE_RULES,
	RulesError,
	SDLC_RULES,
	SUPPORT_OPS_RULES,
	assertThresholdsResolve,
	bestEffortConfidence,
	evaluateRules,
	referencedQuestions,
	validateRuleset,
	type AnswerView,
} from '../src';

function choice(choiceValue: string, confidence?: number, probabilities?: Record<string, number>): AnswerView {
	return {
		type: 'choice',
		choice: choiceValue,
		...(confidence !== undefined ? { confidence } : {}),
		...(probabilities ? { probabilities } : {}),
	};
}

function noul(value: number): AnswerView {
	return { type: 'noul', noul: value };
}

function score(value: number, confidence?: number): AnswerView {
	return {
		type: 'score',
		score: value,
		...(confidence !== undefined ? { confidence } : {}),
	};
}

const baseRules = {
	version: 1,
	default_action: { type: 'escalate', target: 'human', reason: 'No matching rule' },
	thresholds: { high_confidence: 0.85, medium_confidence: 0.7 },
	rules: [
		{
			id: 'first',
			when: { all: [{ question: 'category', eq: 'technical' }] },
			action: { type: 'route', target: 'implementer', reason: 'Technical', gate: false },
		},
		{
			id: 'second',
			when: { all: [{ question: 'category', eq: 'technical' }] },
			action: { type: 'route', target: 'should-not-win', reason: 'Later rule', gate: true },
		},
	],
};

describe('validateRuleset', () => {
	it('accepts the shipped rulesets and preserves an omitted gate as false', () => {
		const ruleset = validateRuleset(GENERIC_TRIAGE_RULES);
		assert.equal(ruleset.version, 1);
		assert.equal(ruleset.default_action.gate, true);
		assert.equal(ruleset.rules[0]?.id, 'urgent-human');
		const omitted = validateRuleset({
			version: 1,
			default_action: { type: 'escalate', target: 'human', reason: 'No matching rule' },
			rules: [],
		});
		assert.equal(omitted.default_action.gate, false);
		assert.equal(validateRuleset(SDLC_RULES).rules.length, 2);
		assert.equal(validateRuleset(SUPPORT_OPS_RULES).rules.length, 2);
		const attack = validateRuleset(ATTACK_TRIAGE_RULES);
		assert.equal(attack.rules.length, 3);
		assert.equal(attack.default_action.gate, true);
	});

	it('reports the path of structural mistakes', () => {
		assert.throws(() => validateRuleset([]), /Rules must be a JSON object/);
		assert.throws(() => validateRuleset({ version: '1', default_action: {}, rules: [] }), /rules\.version must be the number 1/);
		assert.throws(
			() =>
				validateRuleset({
					version: 1,
					default_action: { type: 'escalate', target: 'human', reason: 'No matching rule' },
					rules: {},
				}),
			/rules\.rules must be an array/,
		);
		assert.throws(
			() =>
				validateRuleset({
					version: 1,
					default_action: { type: 'escalate', target: 'human', reason: 'No matching rule' },
					rules: [
						{ id: 'a', when: { all: [{ question: 'q', eq: 'x' }] }, action: { type: 'route', target: 't', reason: 'r' } },
						{ id: 'a', when: { all: [{ question: 'q', eq: 'y' }] }, action: { type: 'route', target: 't', reason: 'r' } },
					],
				}),
			/rules\[1\]\.id duplicates "a"/,
		);
		assert.throws(
			() =>
				validateRuleset({
					version: 1,
					default_action: { type: 'escalate', target: 'human', reason: 'No matching rule' },
					rules: [{ id: 'a', whenn: {}, action: { type: 'route', target: 't', reason: 'r' } }],
				}),
			/rules\[0\] has unknown key "whenn"/,
		);
		assert.throws(
			() =>
				validateRuleset({
					version: 1,
					default_action: { type: 'escalate', target: 'human', reason: 'No matching rule' },
					rules: [{ id: 'a', when: { all: [] }, action: { type: 'route', target: 't', reason: 'r' } }],
				}),
			/rules\[0\]\.when\.all must be a non-empty array/,
		);
		assert.throws(
			() =>
				validateRuleset({
					version: 1,
					default_action: { type: 'escalate', target: 'human', reason: 'No matching rule' },
					rules: [{ id: 'a', when: { question: 'q', eq: 'x', gte: 1 }, action: { type: 'route', target: 't', reason: 'r' } }],
				}),
			/mixes choice operators \(eq\) with numeric operators \(gte\)/,
		);
		assert.throws(
			() =>
				validateRuleset({
					version: 1,
					default_action: { type: 'escalate', target: 'human', reason: 'No matching rule' },
					rules: [{ id: 'a', when: { question: 'q' }, action: { type: 'route', target: 't', reason: 'r' } }],
				}),
			/has no operator/,
		);
		assert.throws(
			() =>
				validateRuleset({
					version: 1,
					default_action: { type: 'escalate', target: 'human', reason: 'No matching rule' },
					thresholds: { 'high-confidence': 0.8 },
					rules: [],
				}),
			/rules\.thresholds\.high-confidence must start with a letter/,
		);
		assert.throws(
			() =>
				validateRuleset({
					version: 1,
					default_action: { type: 'escalate', target: 'human' },
					rules: [],
				}),
			/rules\.default_action\.reason must be a non-empty string/,
		);
	});
});

describe('evaluateRules', () => {
	const answers = {
		category: choice('technical', 0.91),
		urgency: score(1),
		needs_human: noul(0.2),
	};

	it('evaluates a multi-rule matrix with grouped conditions, thresholds, and templates', () => {
		const rules = {
			version: 1,
			default_action: { type: 'escalate', target: 'human', reason: 'No matching rule' },
			thresholds: { high_confidence: 0.85, max_risk: 2 },
			rules: [
				{
					id: 'ship-bugfix',
					description: 'Confident urgent bugfix or chore under the risk ceiling',
					when: {
						all: [
							{
								any: [
									{ question: 'task_type', eq: 'bugfix' },
									{ question: 'task_type', in: ['bugfix', 'chore'] },
								],
							},
							{ question: 'task_type', neq: 'feature', not_in: ['docs'], confidence_gte: 'high_confidence' },
							{ question: 'is_urgent', gte: 'high_confidence' },
							{ question: 'risk', lt: 'max_risk', confidence_lt: 0.99 },
						],
					},
					action: {
						type: 'route',
						target: '{{answers.task_type.choice}}',
						reason: 'Ship {{answers.task_type.choice}} below risk {{thresholds.max_risk}}',
						gate: false,
					},
				},
				{
					id: 'review-feature',
					when: {
						all: [
							{ question: 'task_type', eq: 'feature', confidence_gte: 'high_confidence' },
							{ question: 'risk', gte: 'max_risk' },
						],
					},
					action: {
						type: 'review',
						target: 'design',
						reason: 'Feature {{answers.task_type.choice}} needs review',
						gate: true,
					},
				},
				{
					id: 'later-bugfix',
					when: {
						all: [
							{ question: 'task_type', eq: 'bugfix' },
							{ question: 'task_type', confidence_gte: 'high_confidence' },
						],
					},
					action: { type: 'route', target: 'should-not-win', reason: 'later rule' },
				},
			],
		};
		const answers = {
			task_type: choice('bugfix', 0.91),
			is_urgent: noul(0.9),
			risk: score(1, 0.88),
		};

		const shipped = evaluateRules(rules, answers);
		assert.equal(shipped.matched_rule, 'ship-bugfix');
		assert.equal(shipped.action, 'route');
		assert.equal(shipped.target, 'bugfix');
		assert.equal(shipped.reason, 'Ship bugfix below risk 2');
		assert.equal(shipped.gate, false);
		// Min of choice confidence 0.91, noul decisiveness 0.8, and score confidence 0.88.
		assert.equal(shipped.confidence, 0.8);

		const review = evaluateRules(rules, {
			task_type: choice('feature', 0.95),
			is_urgent: noul(0.99),
			risk: score(3, 0.9),
		});
		assert.equal(review.matched_rule, 'review-feature');
		assert.equal(review.target, 'design');
		assert.equal(review.reason, 'Feature feature needs review');
		assert.equal(review.gate, true);

		const blocked = evaluateRules(rules, answers, { high_confidence: 0.99 });
		assert.equal(blocked.matched_rule, null);
		assert.equal(blocked.action, 'escalate');
		assert.equal(blocked.target, 'human');
		assert.equal(blocked.confidence, 0);
	});

	it('returns the first matching rule and ignores a later match', () => {
		const result = evaluateRules(baseRules, answers);
		assert.equal(result.matched_rule, 'first');
		assert.equal(result.target, 'implementer');
		assert.equal(result.gate, false);
		assert.equal(result.action, 'route');
	});

	it('uses the default action when nothing matches', () => {
		const result = evaluateRules(baseRules, {
			...answers,
			category: choice('billing', 0.99),
		});
		assert.equal(result.matched_rule, null);
		assert.equal(result.action, 'escalate');
		assert.equal(result.target, 'human');
		assert.equal(result.confidence, 0);
		assert.equal(result.gate, false);
	});

	it('supports eq, neq, in, not_in, and confidence comparisons on choice', () => {
		const rules = {
			...baseRules,
			rules: [
				{
					id: 'labels',
					when: {
						all: [
							{ question: 'category', eq: 'technical', confidence_gte: 'medium_confidence' },
							{ question: 'category', neq: 'billing' },
							{ question: 'category', in: ['technical', 'account'] },
							{ question: 'category', not_in: ['other'] },
							{ question: 'category', confidence_lt: 0.95 },
						],
					},
					action: { type: 'route', target: '{{answers.category.choice}}', reason: 'cutoff {{thresholds.medium_confidence}}' },
				},
			],
		};
		const result = evaluateRules(rules, answers);
		assert.equal(result.target, 'technical');
		assert.equal(result.reason, 'cutoff 0.7');
		assert.equal(result.confidence, 0.91);
	});

	it('treats several operators on one predicate as AND', () => {
		const rules = {
			...baseRules,
			rules: [
				{
					id: 'and-ops',
					when: { question: 'category', eq: 'technical', confidence_gte: 0.99 },
					action: { type: 'route', target: 'nope', reason: 'should not match' },
				},
			],
		};
		const result = evaluateRules(rules, answers);
		assert.equal(result.matched_rule, null);
	});

	it('resolves threshold names, templates, objects, and numeric strings', () => {
		const rules = {
			version: 1,
			default_action: { type: 'escalate', target: 'human', reason: 'No matching rule' },
			thresholds: { high_confidence: 0.85 },
			rules: [
				{
					id: 'noul-high',
					when: {
						all: [
							{ question: 'needs_human', gte: 'high_confidence' },
							{ question: 'needs_human', gt: { threshold: 'high_confidence' } },
							{ question: 'needs_human', lte: '{{thresholds.high_confidence}}' },
							{ question: 'urgency', lt: '3' },
						],
					},
					action: { type: 'hold', target: 'queue', reason: 'held' },
				},
			],
		};
		const matched = evaluateRules(rules, { needs_human: noul(0.85), urgency: score(2) });
		assert.equal(matched.matched_rule, null, 'gt high_confidence excludes an equal noul');

		const above = evaluateRules(rules, { needs_human: noul(0.9), urgency: score(2) });
		assert.equal(above.matched_rule, null, 'lte template 0.85 excludes 0.9');

		const exactWindow = {
			...rules,
			rules: [
				{
					id: 'window',
					when: {
						all: [
							{ question: 'needs_human', gte: 'high_confidence' },
							{ question: 'needs_human', lte: 0.9 },
							{ question: 'urgency', lt: 3 },
						],
					},
					action: { type: 'hold', target: 'queue', reason: 'held', gate: true },
				},
			],
		};
		const result = evaluateRules(exactWindow, { needs_human: noul(0.9), urgency: score(2.5) });
		assert.equal(result.matched_rule, 'window');
		assert.equal(result.gate, true);
	});

	it('lets node overrides replace ruleset thresholds', () => {
		const result = evaluateRules(
			GENERIC_TRIAGE_RULES,
			{
				category: choice('billing', 0.96),
				urgency: score(1),
				needs_human: noul(0.9),
			},
			{ high_confidence: 0.95 },
		);
		assert.equal(result.matched_rule, 'route-category');
		assert.equal(result.target, 'billing');
	});

	it('evaluates nested all and any', () => {
		const rules = {
			version: 1,
			default_action: { type: 'escalate', target: 'human', reason: 'No matching rule' },
			rules: [
				{
					id: 'nested',
					when: {
						any: [
							{ all: [{ question: 'category', eq: 'billing' }, { question: 'urgency', gte: 2 }] },
							{ all: [{ question: 'category', eq: 'technical' }, { question: 'needs_human', lt: 0.5 }] },
						],
					},
					action: { type: 'route', target: 'nested', reason: 'nested match' },
				},
			],
		};
		const result = evaluateRules(rules, answers);
		assert.equal(result.matched_rule, 'nested');
		assert.deepEqual(referencedQuestions(validateRuleset(rules).rules[0]!.when), [
			'category',
			'urgency',
			'needs_human',
		]);
	});

	it('compares score numbers separately from score confidence', () => {
		const rules = {
			version: 1,
			default_action: { type: 'escalate', target: 'human', reason: 'No matching rule' },
			rules: [
				{
					id: 'score-check',
					when: { question: 'urgency', gte: 1, confidence_gte: 0.5 },
					action: { type: 'route', target: 'scores', reason: 'score path' },
				},
			],
		};
		assert.equal(
			evaluateRules(rules, { urgency: score(1.5, 0.2) }).matched_rule,
			null,
		);
		assert.equal(
			evaluateRules(rules, { urgency: score(1.5, 0.8) }).matched_rule,
			'score-check',
		);
	});

	it('uses the choice probability only when confidence is absent', () => {
		const rules = {
			version: 1,
			default_action: { type: 'escalate', target: 'human', reason: 'No matching rule' },
			rules: [
				{
					id: 'confident',
					when: { question: 'category', confidence_gte: 0.6 },
					action: { type: 'route', target: 't', reason: 'r' },
				},
			],
		};
		const fromField = evaluateRules(rules, {
			category: choice('technical', 0.4, { technical: 0.9, billing: 0.1 }),
		});
		assert.equal(fromField.matched_rule, null);

		const fromProbability = evaluateRules(rules, {
			category: choice('technical', undefined, { technical: 0.7, billing: 0.3 }),
		});
		assert.equal(fromProbability.matched_rule, 'confident');
		assert.equal(fromProbability.confidence, 0.7);
	});

	it('rejects operators used on the wrong answer type and missing data', () => {
		const numericOnChoice = {
			version: 1,
			default_action: { type: 'escalate', target: 'human', reason: 'No matching rule' },
			rules: [
				{
					id: 'bad',
					when: { question: 'category', gte: 1 },
					action: { type: 'route', target: 't', reason: 'r' },
				},
			],
		};
		assert.throws(() => evaluateRules(numericOnChoice, answers), /which is a choice answer/);

		const confidenceOnNoul = {
			version: 1,
			default_action: { type: 'escalate', target: 'human', reason: 'No matching rule' },
			rules: [
				{
					id: 'bad',
					when: { question: 'needs_human', confidence_gte: 0.5 },
					action: { type: 'route', target: 't', reason: 'r' },
				},
			],
		};
		assert.throws(() => evaluateRules(confidenceOnNoul, answers), /Noul has no separate confidence/);

		assert.throws(
			() => evaluateRules(baseRules, { urgency: score(1) }),
			/absent from the decision server answers/,
		);
		assert.throws(
			() =>
				evaluateRules(
					{
						version: 1,
						default_action: { type: 'escalate', target: 'human', reason: 'No matching rule' },
						rules: [
							{
								id: 'missing-threshold',
								when: { question: 'needs_human', gte: 'not_defined' },
								action: { type: 'route', target: 't', reason: 'r' },
							},
						],
					},
					{ needs_human: noul(1) },
				),
			/Threshold "not_defined"/,
		);
	});

	it('rejects unresolved threshold names before evaluation', () => {
		const rules = {
			version: 1,
			default_action: { type: 'escalate', target: 'human', reason: 'limit {{thresholds.missing}}' },
			rules: [
				{
					id: 'later',
					when: { question: 'needs_human', gte: 'page_threshold' },
					action: { type: 'route', target: 't', reason: 'r' },
				},
			],
		};
		assert.throws(() => assertThresholdsResolve(rules), /Threshold "missing"/);
		assert.throws(() => assertThresholdsResolve(rules, { missing: 1 }), /Threshold "page_threshold"/);
		assert.equal(assertThresholdsResolve(rules, { missing: 1, page_threshold: 0.8 }).version, 1);
	});

	it('throws when a template erases the target', () => {
		const rules = {
			version: 1,
			default_action: { type: 'escalate', target: '{{answers.missing.choice}}', reason: 'fallback' },
			rules: [],
		};
		assert.throws(() => evaluateRules(rules, answers), /rendered an empty target or reason/);
	});

	it('leaves unknown placeholders in place', () => {
		const rules = {
			version: 1,
			default_action: { type: 'escalate', target: 'human', reason: 'see {{something.else}}' },
			rules: [],
		};
		assert.equal(evaluateRules(rules, answers).reason, 'see {{something.else}}');
	});

	it('reports noul decisiveness as best-effort confidence', () => {
		assert.equal(bestEffortConfidence(noul(0.9)), 0.8);
		assert.equal(bestEffortConfidence(noul(0.5)), 0);
		assert.equal(bestEffortConfidence(noul(1)), 1);
		const result = evaluateRules(GENERIC_TRIAGE_RULES, {
			category: choice('billing', 0.91),
			urgency: score(3, 0.4),
			needs_human: noul(0.2),
		});
		assert.equal(result.matched_rule, 'urgent-human');
		assert.equal(result.confidence, 0.4);
	});
});

describe('shipped examples', () => {
	it('routes generic triage by the first matching rule', () => {
		const urgent = evaluateRules(GENERIC_TRIAGE_RULES, {
			category: choice('technical', 0.95),
			urgency: score(1),
			needs_human: noul(0.9),
		});
		assert.equal(urgent.matched_rule, 'urgent-human');
		assert.equal(urgent.action, 'escalate');
		assert.equal(urgent.gate, true);

		const routed = evaluateRules(GENERIC_TRIAGE_RULES, {
			category: choice('billing', 0.9),
			urgency: score(1),
			needs_human: noul(0.2),
		});
		assert.deepEqual(
			{ action: routed.action, target: routed.target, matched_rule: routed.matched_rule },
			{ action: 'route', target: 'billing', matched_rule: 'route-category' },
		);

		const fallback = evaluateRules(GENERIC_TRIAGE_RULES, {
			category: choice('billing', 0.5),
			urgency: score(1),
			needs_human: noul(0.2),
		});
		assert.equal(fallback.matched_rule, null);
	});

	it('sends risky SDLC changes to design review and ready ones to an implementer', () => {
		const review = evaluateRules(SDLC_RULES, {
			change_type: choice('feature', 0.9),
			risk: score(3),
			needs_design: noul(0.1),
			ready_to_implement: noul(0.95),
		});
		assert.equal(review.matched_rule, 'needs-design');
		assert.equal(review.action, 'review');
		assert.equal(review.target, 'design');

		const ready = evaluateRules(SDLC_RULES, {
			change_type: choice('bugfix', 0.9),
			risk: score(1),
			needs_design: noul(0.2),
			ready_to_implement: noul(0.9),
		});
		assert.equal(ready.action, 'route');
		assert.equal(ready.target, 'implementer');
		assert.equal(ready.reason, 'Ready to implement as bugfix');
	});

	it('pages on-call or queues a confident support severity', () => {
		const page = evaluateRules(SUPPORT_OPS_RULES, {
			severity: choice('sev3', 0.9),
			customer_impact: score(2),
			page_oncall: noul(0.9),
		});
		assert.equal(page.action, 'page');
		assert.equal(page.target, 'oncall');
		assert.equal(page.reason, 'Severity sev3 warrants a page');

		const queue = evaluateRules(SUPPORT_OPS_RULES, {
			severity: choice('sev3', 0.95),
			customer_impact: score(1),
			page_oncall: noul(0.1),
		});
		assert.equal(queue.action, 'route');
		assert.equal(queue.target, 'ticket-queue');

		const fallback = evaluateRules(SUPPORT_OPS_RULES, {
			severity: choice('sev4', 0.5),
			customer_impact: score(0),
			page_oncall: noul(0.1),
		});
		assert.equal(fallback.matched_rule, null);
		assert.ok(fallback instanceof Object);
		assert.equal(fallback.action, 'escalate');
	});

	it('holds attack-triage events unless they are confident, legitimate, and low risk', () => {
		const block = evaluateRules(ATTACK_TRIAGE_RULES, {
			intent: choice('account_takeover', 0.93),
			risk: score(3, 0.88),
			needs_human: noul(0.95),
		});
		assert.equal(block.matched_rule, 'hold-hostile');
		assert.equal(block.action, 'block');
		assert.equal(block.target, 'security');
		assert.equal(block.gate, true);
		assert.equal(block.reason, 'Hold account_takeover before any automated action');
		assert.equal(block.confidence, 0.93);

		const reconnaissance = evaluateRules(ATTACK_TRIAGE_RULES, {
			intent: choice('reconnaissance', 0.9),
			risk: score(0, 0.9),
			needs_human: noul(0.1),
		});
		assert.equal(reconnaissance.matched_rule, 'hold-hostile');

		const risky = evaluateRules(ATTACK_TRIAGE_RULES, {
			intent: choice('legitimate_ops', 0.95),
			risk: score(2, 0.8),
			needs_human: noul(0.1),
		});
		assert.equal(risky.matched_rule, 'hold-uncertain');
		assert.equal(risky.action, 'escalate');
		assert.equal(risky.gate, true);

		const human = evaluateRules(ATTACK_TRIAGE_RULES, {
			intent: choice('benign', 0.95),
			risk: score(0, 0.9),
			needs_human: noul(0.9),
		});
		assert.equal(human.matched_rule, 'hold-uncertain');
		assert.equal(human.target, 'human');

		const allow = evaluateRules(ATTACK_TRIAGE_RULES, {
			intent: choice('legitimate_ops', 0.92),
			risk: score(1, 0.9),
			needs_human: noul(0.15),
		});
		assert.equal(allow.matched_rule, 'allow-legitimate');
		assert.equal(allow.action, 'allow');
		assert.equal(allow.target, 'automation');
		assert.equal(allow.gate, false);
		assert.equal(allow.reason, 'Allow legitimate_ops below risk 2');
		assert.equal(allow.confidence, 0.9);

		const unsure = evaluateRules(ATTACK_TRIAGE_RULES, {
			intent: choice('account_takeover', 0.5),
			risk: score(0, 0.9),
			needs_human: noul(0.1),
		});
		assert.equal(unsure.matched_rule, null);
		assert.equal(unsure.action, 'escalate');
		assert.equal(unsure.gate, true);
		assert.equal(unsure.confidence, 0);

		const raised = evaluateRules(
			ATTACK_TRIAGE_RULES,
			{
				intent: choice('benign', 0.9),
				risk: score(1, 0.9),
				needs_human: noul(0.1),
			},
			{ high_confidence: 0.99 },
		);
		assert.equal(raised.matched_rule, null);
		assert.equal(raised.gate, true);
	});
});

describe('RulesError', () => {
	it('uses the RulesError name', () => {
		const error = new RulesError('bad rules');
		assert.equal(error.name, 'RulesError');
		assert.ok(error instanceof Error);
	});
});
