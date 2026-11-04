import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildItemOutput, noMatchMessage } from '../nodes/DecisionMatrix/output';
import {
	readOptions,
	readQuestions,
	readRulesInput,
	readState,
	readThresholdOverrides,
} from '../nodes/DecisionMatrix/parameters';
import { evaluateRules, type AnswerView } from 'decision-matrix-rules';
import { GENERIC_TRIAGE_QUESTIONS, normalizeSystemOneResponse } from 'decision-matrix-systemone';

describe('readState', () => {
	it('keeps text, objects, arrays, and JSON text', () => {
		assert.equal(readState('  hello  '), '  hello  ');
		assert.deepEqual(readState(' {"ticket":1} '), { ticket: 1 });
		assert.deepEqual(readState(['a']), ['a']);
		assert.deepEqual(readState({ ticket: 2 }), { ticket: 2 });
	});

	it('rejects empty and non-container JSON', () => {
		assert.throws(() => readState('   '), /State is required/);
		assert.throws(() => readState('{'), /could not be parsed/);
		assert.equal(readState('"quoted text"'), '"quoted text"');
		assert.throws(() => readState('["ok",'), /could not be parsed/);
		assert.throws(() => readState(12), /string, object, or array/);
	});
});

describe('readQuestions', () => {
	it('uses presets when Questions is empty, and lets a non-empty object replace any preset', () => {
		assert.deepEqual(readQuestions('generic', {}), GENERIC_TRIAGE_QUESTIONS);
		assert.deepEqual(readQuestions('generic', '{}'), GENERIC_TRIAGE_QUESTIONS);
		assert.equal(Boolean(readQuestions('sdlc', undefined).change_type), true);
		assert.equal(Boolean(readQuestions('support', '').page_oncall), true);
		assert.deepEqual(readQuestions('custom', {}), GENERIC_TRIAGE_QUESTIONS);
		assert.deepEqual(readQuestions('custom', ''), GENERIC_TRIAGE_QUESTIONS);

		const override = readQuestions('sdlc', {
			task_type: { type: 'choice', instructions: 'Which kind of task is this' },
		});
		assert.deepEqual(Object.keys(override), ['task_type']);
		assert.equal(override.change_type, undefined);
	});

	it('accepts a custom questions object and rejects a bad shape', () => {
		const custom = readQuestions('custom', {
			refund: { type: 'noul', instructions: 'A refund was requested' },
		});
		assert.equal((custom.refund as { type: string }).type, 'noul');
		assert.throws(() => readQuestions('generic', { refund: { instructions: 'missing type' } }), /type is required/);
		assert.throws(() => readQuestions('custom', []), /JSON object/);
		assert.throws(() => readQuestions('custom', '{'), /not valid JSON/);
		assert.throws(() => readQuestions('nope', {}), /unknown/);
	});
});

describe('readRulesInput and thresholds', () => {
	it('parses rules JSON and a fixed collection of overrides', () => {
		assert.deepEqual(readRulesInput('{"version":1}'), { version: 1 });
		assert.throws(() => readRulesInput(''), /Rules are required/);
		assert.throws(() => readRulesInput('{'), /not valid JSON/);
		assert.deepEqual(
			readThresholdOverrides({
				threshold: [
					{ name: ' high_confidence ', value: 0.9 },
					{ name: 'page_threshold', value: 0 },
				],
			}),
			{ high_confidence: 0.9, page_threshold: 0 },
		);
		assert.throws(
			() =>
				readThresholdOverrides({
					threshold: [
						{ name: 'high_confidence', value: 0.9 },
						{ name: 'high_confidence', value: 0.8 },
					],
				}),
			/defined more than once/,
		);
		assert.throws(() => readThresholdOverrides({ threshold: [{ name: '', value: 1 }] }), /missing a name/);
	});
});

describe('readOptions', () => {
	it('applies documented defaults', () => {
		assert.deepEqual(readOptions({}), {
			timeout: 60000,
			includeFullAnswers: true,
			failOnNoMatch: false,
			includeRawResponse: false,
		});
		assert.deepEqual(readOptions(undefined).includeFullAnswers, true);
		const set = readOptions({
			timeout: 1500,
			includeFullAnswers: false,
			failOnNoMatch: true,
			includeRawResponse: true,
			model: '  open-model  ',
		});
		assert.equal(set.timeout, 1500);
		assert.equal(set.includeFullAnswers, false);
		assert.equal(set.failOnNoMatch, true);
		assert.equal(set.includeRawResponse, true);
		assert.equal(set.model, 'open-model');
		assert.throws(() => readOptions({ timeout: 0 }), /Timeout/);
	});
});

describe('buildItemOutput', () => {
	it('always includes routing fields and adds answers, raw response, and usage on request', () => {
		const systemOne = normalizeSystemOneResponse({
			answers: { ok: { type: 'noul', noul: 0.8 } },
			usage: { input_tokens: 5, output_tokens: 1 },
		});
		const evaluation = evaluateRules(
			{
				version: 1,
				default_action: { type: 'escalate', target: 'human', reason: 'No matching rule' },
				rules: [],
			},
			systemOne.answers as Record<string, AnswerView>,
		);
		const full = buildItemOutput(evaluation, systemOne, { answers: systemOne.rawAnswers }, {
			includeFullAnswers: true,
			includeRawResponse: true,
		});
		assert.equal(full.action, 'escalate');
		assert.equal(full.matched_rule, null);
		assert.equal(full.confidence, 0);
		assert.ok(full.answers);
		assert.ok(full.raw_response);
		assert.deepEqual(full.usage, { input_tokens: 5, output_tokens: 1 });

		const slim = buildItemOutput(evaluation, { ...systemOne, usage: undefined }, { answers: {} }, {
			includeFullAnswers: false,
			includeRawResponse: false,
		});
		assert.equal('answers' in slim, false);
		assert.equal('raw_response' in slim, false);
		assert.equal('usage' in slim, false);
		assert.match(noMatchMessage(evaluation), /Fail on no matching rule/);
	});
});
