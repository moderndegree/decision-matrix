import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { rulesetHash, validateRuleset } from 'decision-matrix-rules';

// DecisionMatrix.node.json shares this stem, so the extension is required or the loader reads the codex file.
// @ts-expect-error TS5097: this package's module setting does not allow a .ts specifier, and tsx needs one here.
import { DecisionMatrix } from '../nodes/DecisionMatrix/DecisionMatrix.node.ts';

describe('execute', () => {
	it('replaces only the rules array from Rule Rows and returns margin, contributions, and a receipt', async () => {
		const rules = {
			version: 1,
			owner: 'decision-matrix',
			ticket: 'ci-change',
			open_gate_requires_facts: true,
			fact_schema: { touches_ci: { type: 'boolean', required: true } },
			agreements: [{ question: 'changes_runtime_behavior', fact: 'docs_only', relation: 'inverse' }],
			thresholds: { high_confidence: 0.85 },
			default_action: { type: 'hold', target: 'human', reason: 'No rule passed', gate: true },
			rules: [
				{
					id: 'keep',
					when: { fact: 'other', eq: 1 },
					action: { type: 'hold', target: 't', reason: 'original', gate: true },
				},
			],
		};
		const params: Record<string, unknown> = {
			state: 'workflow file changed',
			questionSet: 'custom',
			questions: {},
			rules,
			ruleRows: {
				rule: [
					{
						id: 'row-from-form',
						combine: 'all',
						type: 'hold',
						target: 'security',
						reason: 'The form row matched',
						gate: true,
						conditions: {
							condition: [{ source: 'fact', subject: 'touches_ci', operator: 'eq', value: 'true' }],
						},
					},
				],
			},
			thresholds: {},
			facts: { touches_ci: true },
			options: {},
			answerWith: 'server',
			scripts: {},
		};
		const node = new DecisionMatrix();
		const [items] = await node.execute.call({
			getInputData: () => [{ json: {} }],
			getNodeParameter: (name: string, _itemIndex: number, fallback?: unknown) => (name in params ? params[name] : fallback),
			continueOnFail: () => false,
			getNode: () => ({ name: 'Decision Matrix', type: 'decisionMatrix', typeVersion: 1 }),
		} as never);

		const item = items?.[0]?.json as Record<string, unknown>;
		const receipt = item.receipt as { ruleset_hash: string; fact_paths: string[]; question_ids: string[] };
		const evaluated = validateRuleset({
			version: rules.version,
			owner: rules.owner,
			ticket: rules.ticket,
			open_gate_requires_facts: rules.open_gate_requires_facts,
			fact_schema: rules.fact_schema,
			agreements: rules.agreements,
			thresholds: rules.thresholds,
			default_action: rules.default_action,
			rules: [
				{
					id: 'row-from-form',
					when: { fact: 'touches_ci', eq: true },
					action: { type: 'hold', target: 'security', reason: 'The form row matched', gate: true },
				},
			],
		});

		assert.equal(item.matched_rule, 'row-from-form');
		assert.equal(item.action, 'hold');
		assert.equal(item.target, 'security');
		assert.equal(item.gate, true);
		assert.equal(item.margin, 1);
		assert.deepEqual(item.contributions, []);
		assert.equal(receipt.ruleset_hash, rulesetHash(evaluated));
		assert.deepEqual(receipt.fact_paths, ['touches_ci']);
		assert.deepEqual(receipt.question_ids, []);
		assert.equal(evaluated.owner, 'decision-matrix');
		assert.equal(evaluated.ticket, 'ci-change');
		assert.equal(evaluated.open_gate_requires_facts, true);
		assert.deepEqual(evaluated.fact_schema, rules.fact_schema);
		assert.deepEqual(evaluated.agreements, rules.agreements);
		assert.deepEqual(evaluated.default_action, {
			type: 'hold',
			target: 'human',
			reason: 'No rule passed',
			gate: true,
		});
		assert.deepEqual(evaluated.thresholds, rules.thresholds);
		assert.equal(rules.rules[0]?.id, 'keep');
	});
});
