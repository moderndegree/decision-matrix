import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildItemOutput, noMatchMessage } from '../nodes/DecisionMatrix/output';
import {
	readFactsInput,
	readOptions,
	readQuestions,
	readRulesInput,
	readScripts,
	readState,
	readThresholdOverrides,
} from '../nodes/DecisionMatrix/parameters';
import { evaluateRules, type AnswerView } from 'decision-matrix-rules';
import { GENERIC_TRIAGE_QUESTIONS, normalizeSystemOneResponse, runScripts } from 'decision-matrix-systemone';

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

describe('readScripts', () => {
	it('uses the built-in script for a preset and ignores scripts in server mode', () => {
		assert.equal(readScripts('server', 'generic', '{', {}), undefined);
		const program = readScripts('scripts', 'sdlc', '{}', undefined);
		assert.equal(runScripts(program!, 'feat: add export').change_type?.choice, 'feature');
		assert.throws(() => readScripts('scripts', 'generic', {}, { kind: { type: 'noul', instructions: 'Is it fine' } }), /Paste a scripts/);
		assert.throws(() => readScripts('nope', 'generic', {}, {}), /unknown/);
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
			task_type: { type: 'choice', instructions: 'Which kind of task is this', criteria: { bug: 'Broken behavior', chore: null } },
		});
		assert.deepEqual(Object.keys(override), ['task_type']);
		assert.equal(override.change_type, undefined);
	});

	it('accepts a custom questions object and rejects a bad shape', () => {
		const custom = readQuestions('custom', {
			refund: { type: 'noul', instructions: 'A refund was requested' },
		});
		assert.equal((custom.refund as { type: string }).type, 'noul');
		assert.throws(() => readQuestions('generic', { refund: { instructions: 'missing type' } }), /type must be "choice", "noul", or "score"/);
		assert.throws(() => readQuestions('custom', { refund: { type: 'noul' } }), /instructions must say what the model is asked/);
		assert.throws(() => readQuestions('custom', { kind: { type: 'choice', instructions: 'Which' } }), /must map each label/);
		assert.throws(() => readQuestions('custom', { risk: { type: 'score', instructions: 'How risky', criteria: ['only one'] } }), /at least two levels/);
		assert.throws(() => readQuestions('custom', { ok: { type: 'noul', instructions: 'Fine', criteria: ['x'] } }), /not used by a noul question/);
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

describe('readFactsInput', () => {
	it('accepts an object or JSON text and treats empty as no facts', () => {
		assert.deepEqual(readFactsInput(undefined), {});
		assert.deepEqual(readFactsInput('  '), {});
		assert.deepEqual(readFactsInput('{"a":1}'), { a: 1 });
		assert.deepEqual(readFactsInput({ a: { b: true } }), { a: { b: true } });
		assert.throws(() => readFactsInput('[1]'), /Facts must be a JSON object/);
		assert.throws(() => readFactsInput('{'), /Facts are not valid JSON/);
	});
});
