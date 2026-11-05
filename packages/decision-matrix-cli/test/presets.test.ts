import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
	ACCESS_REVIEW_RULES,
	CI_CHANGE_RULES,
	decideFromFacts,
	evaluateRules,
	lintRuleset,
	referencedFacts,
	referencedQuestions,
	validateRuleset,
	type AnswerView,
	type LintQuestion,
} from 'decision-matrix-rules';
import { ACCESS_REVIEW_QUESTIONS, CI_CHANGE_QUESTIONS, SUPPORT_OPS_QUESTIONS } from 'decision-matrix-systemone';

import { CI_FACTS, ciAnswers, examples, noul, rule, rules, score } from './fixtures';

describe('ci-change preset', () => {
	it('is strict, and every rule references only its own questions', () => {
		const parsed = validateRuleset(CI_CHANGE_RULES);
		assert.equal(parsed.open_gate_requires_facts, true);
		const questions = new Set(Object.keys(CI_CHANGE_QUESTIONS));
		for (const entry of parsed.rules) {
			for (const id of referencedQuestions(entry.when)) assert.ok(questions.has(id), id);
			for (const fact of referencedFacts(entry.when)) assert.ok(Object.prototype.hasOwnProperty.call(CI_FACTS, fact), fact);
		}
		assert.deepEqual(JSON.parse(readFileSync(path.join(examples, 'ci-change.rules.json'), 'utf8')), CI_CHANGE_RULES);
		assert.deepEqual(JSON.parse(readFileSync(path.join(examples, 'ci-change.questions.json'), 'utf8')), CI_CHANGE_QUESTIONS);
	});

	it('holds CI, script, and new-dependency changes from facts, before the model', () => {
		for (const [facts, id] of [
			[{ touches_ci: true }, 'hold-ci-config'],
			[{ changes_package_scripts: true }, 'hold-package-scripts'],
			[{ new_package_count: 2, touches_dependencies: true }, 'hold-new-dependency'],
		] as const) {
			const decision = decideFromFacts(CI_CHANGE_RULES, { ...CI_FACTS, ...facts });
			assert.equal(decision?.matched_rule, id);
			assert.equal(decision?.gate, true);
		}
		assert.equal(decideFromFacts(CI_CHANGE_RULES, CI_FACTS), null);
		assert.equal(decideFromFacts(CI_CHANGE_RULES, { ...CI_FACTS, new_package_count: 2 })?.reason, 'Adds 2 new package(s)');
	});

	it('passes a small change the model agrees with', () => {
		const decision = evaluateRules(CI_CHANGE_RULES, ciAnswers(), undefined, CI_FACTS);
		assert.equal(decision.matched_rule, 'pass-small-change');
		assert.equal(decision.gate, false);
	});

	it('blocks injected text even when every other answer would pass', () => {
		const decision = evaluateRules(
			CI_CHANGE_RULES,
			ciAnswers({ content_contains_instructions: noul(0.8) }),
			undefined,
			CI_FACTS,
		);
		assert.equal(decision.matched_rule, 'hold-injection');
		assert.equal(decision.action, 'block');
	});

	it('holds when the model disagrees with a verified fact', () => {
		const docs = { ...CI_FACTS, docs_only: true };
		const mismatch = evaluateRules(CI_CHANGE_RULES, ciAnswers({ risk: score(0) }), undefined, docs);
		assert.equal(mismatch.matched_rule, 'hold-mismatch');
		const agrees = evaluateRules(
			CI_CHANGE_RULES,
			ciAnswers({ risk: score(0), changes_runtime_behavior: noul(0.05) }),
			undefined,
			docs,
		);
		assert.equal(agrees.matched_rule, 'pass-docs');
	});

	it('never passes a confident model on facts it cannot see', () => {
		for (const facts of [{ touches_sensitive: true }, { diff_truncated: true }, { files_changed: 21 }, { touches_dependencies: true }]) {
			const decision = evaluateRules(CI_CHANGE_RULES, ciAnswers(), undefined, { ...CI_FACTS, ...facts });
			assert.equal(decision.gate, true, JSON.stringify(facts));
			assert.equal(decision.matched_rule, null, JSON.stringify(facts));
		}
	});

	it('auto-merges only a dependency bot patch update', () => {
		const bot = {
			...CI_FACTS,
			author: 'dependabot[bot]',
			author_is_dependency_bot: true,
			dependency_update_type: 'patch',
			touches_dependencies: true,
		};
		const merged = evaluateRules(CI_CHANGE_RULES, ciAnswers(), undefined, bot);
		assert.equal(merged.matched_rule, 'auto-merge-dependency-patch');
		assert.equal(merged.reason, 'Patch update from dependabot[bot] with nothing unexpected in the diff');
		assert.equal(evaluateRules(CI_CHANGE_RULES, ciAnswers(), undefined, { ...bot, dependency_update_type: 'minor' }).gate, true);
		assert.equal(evaluateRules(CI_CHANGE_RULES, ciAnswers(), undefined, { ...bot, author_is_dependency_bot: false }).gate, true);
	});
});

describe('access-review preset', () => {
	const facts = (principal: Record<string, unknown> = {}, grant: Record<string, unknown> = {}) => ({
		principal: { id: 'u-1', type: 'human', active: true, mfa: true, ...principal },
		grant: { role: 'billing-readers', privileged: false, days_since_last_use: 3, days_since_review: 100, owner_approved: true, ...grant },
	});
	const answers = (overrides: Record<string, AnswerView> = {}) => ({
		content_contains_instructions: noul(0.02),
		justification_supports_access: noul(0.95),
		justification_specific: noul(0.9),
		excess_scope: score(0),
		...overrides,
	});

	it('is strict and matches the example files', () => {
		assert.equal(validateRuleset(ACCESS_REVIEW_RULES).open_gate_requires_facts, true);
		assert.deepEqual(JSON.parse(readFileSync(path.join(examples, 'access-review.rules.json'), 'utf8')), ACCESS_REVIEW_RULES);
		assert.deepEqual(
			JSON.parse(readFileSync(path.join(examples, 'access-review.questions.json'), 'utf8')),
			ACCESS_REVIEW_QUESTIONS,
		);
	});

	it('revokes only from facts', () => {
		assert.equal(decideFromFacts(ACCESS_REVIEW_RULES, facts({ active: false }))?.matched_rule, 'revoke-inactive-principal');
		const stale = decideFromFacts(ACCESS_REVIEW_RULES, facts({}, { privileged: true, days_since_last_use: 90, role: 'org-admin' }));
		assert.equal(stale?.matched_rule, 'revoke-stale-privileged');
		assert.equal(stale?.reason, 'Privileged org-admin unused for 90 days');
		const revokes = validateRuleset(ACCESS_REVIEW_RULES).rules.filter((entry) => entry.action.type === 'revoke');
		for (const entry of revokes) assert.deepEqual(referencedQuestions(entry.when), [], entry.id);
	});

	it('keeps a justified grant, and sends weak or injected text to a person', () => {
		assert.equal(evaluateRules(ACCESS_REVIEW_RULES, answers(), undefined, facts()).matched_rule, 'keep-justified');
		const weak = evaluateRules(ACCESS_REVIEW_RULES, answers({ justification_specific: noul(0.1) }), undefined, facts());
		assert.equal(weak.matched_rule, 'review-weak-justification');
		const injected = evaluateRules(ACCESS_REVIEW_RULES, answers({ content_contains_instructions: noul(0.9) }), undefined, facts());
		assert.equal(injected.matched_rule, 'review-injection');
		assert.equal(injected.target, 'security');
		const unreviewed = evaluateRules(ACCESS_REVIEW_RULES, answers(), undefined, facts({}, { days_since_review: 400 }));
		assert.equal(unreviewed.matched_rule, null);
		assert.equal(unreviewed.gate, true);
	});
});

describe('presets with their questions', () => {
	it('reports overlap on the strict presets and no other findings', () => {
		const codes = (rules: unknown, questions: Record<string, LintQuestion>) =>
			lintRuleset(rules, { questions }).map((finding) => `${finding.code}${finding.rule ? `:${finding.rule}` : ''}`);
		assert.deepEqual(codes(CI_CHANGE_RULES, CI_CHANGE_QUESTIONS), [
			'overlap:hold-injection',
			'overlap:hold-suspicious-code',
			'overlap:hold-mismatch',
			'overlap:hold-risk',
			'overlap:auto-merge-dependency-patch',
			'overlap:pass-docs',
			'overlap:pass-small-change',
		]);
		assert.deepEqual(codes(ACCESS_REVIEW_RULES, ACCESS_REVIEW_QUESTIONS), [
			'overlap:review-human-without-mfa',
			'overlap:review-injection',
			'overlap:review-weak-justification',
			'overlap:keep-justified',
		]);
	});

	it('reports a question the support preset asks but never reads', () => {
		const findings = lintRuleset(
			JSON.parse(JSON.stringify({ ...rules([rule('a', { all: [{ question: 'severity', eq: 'sev1' }] })]), thresholds: {} })),
			{ questions: SUPPORT_OPS_QUESTIONS },
		);
		assert.deepEqual(
			findings.filter((finding) => finding.code === 'unused-question').map((finding) => finding.message.split('"')[1]),
			['customer_impact', 'page_oncall'],
		);
	});
});
