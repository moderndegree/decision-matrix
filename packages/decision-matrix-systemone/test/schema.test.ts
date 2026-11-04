import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import Ajv2020 from 'ajv/dist/2020';

import { QUESTION_PRESETS, buildSystemOneBody, validateQuestions } from '../src';

const schemaDir = path.resolve(__dirname, '..', 'schema');
const load = (name: string) => JSON.parse(readFileSync(path.join(schemaDir, name), 'utf8'));
const ajv = new Ajv2020({ strict: true, strictRequired: false, allowUnionTypes: true, allErrors: true });
ajv.addSchema(load('questions.schema.json'));
const questionsSchema = ajv.getSchema('decision-matrix-systemone/schema/questions.schema.json')!;
const requestSchema = ajv.compile(load('request.schema.json'));
const responseSchema = ajv.compile(load('response.schema.json'));

const parserAccepts = (value: unknown) => {
	try {
		validateQuestions(value);
		return true;
	} catch {
		return false;
	}
};

const choice = { type: 'choice', instructions: 'Which', criteria: { a: 'A', b: null } };
const CORPUS: Array<[string, unknown, boolean]> = [
	['a choice with a label map', { kind: choice }, true],
	['a choice with a label list', { kind: { ...choice, criteria: ['a', 'b'] } }, true],
	['a noul', { ok: { type: 'noul', instructions: 'Is it fine' } }, true],
	['a score', { risk: { type: 'score', instructions: 'How risky', criteria: ['low', 'high'] } }, true],
	['extra fields a server may read', { kind: { ...choice, examples: ['x'] } }, true],
	['$schema for editors', { $schema: './questions.schema.json', kind: choice }, true],
	['$schema alone', { $schema: './questions.schema.json' }, false],
	['$schema that is not a string', { $schema: 1, kind: choice }, false],
	['no questions', {}, false],
	['a list', [choice], false],
	['an id with a space', { 'a b': choice }, false],
	['an unknown type', { kind: { ...choice, type: 'rank' } }, false],
	['no type', { kind: { instructions: 'Which', criteria: { a: 'A' } } }, false],
	['no instructions', { kind: { type: 'choice', criteria: { a: 'A' } } }, false],
	['blank instructions', { kind: { ...choice, instructions: '  ' } }, false],
	['a choice without criteria', { kind: { type: 'choice', instructions: 'Which' } }, false],
	['a choice with no labels', { kind: { ...choice, criteria: {} } }, false],
	['a choice with an empty label', { kind: { ...choice, criteria: { '': 'x' } } }, false],
	['a choice description that is a number', { kind: { ...choice, criteria: { a: 1 } } }, false],
	['a choice list with a repeated label', { kind: { ...choice, criteria: ['a', 'a'] } }, false],
	['a score with one level', { risk: { type: 'score', instructions: 'How risky', criteria: ['only'] } }, false],
	['a score with a map', { risk: { type: 'score', instructions: 'How risky', criteria: { low: 'x', high: 'y' } } }, false],
	['a noul with criteria', { ok: { type: 'noul', instructions: 'Is it fine', criteria: ['yes', 'no'] } }, false],
	['a question that is not an object', { kind: 'choice' }, false],
];

describe('questions.schema.json', () => {
	it('accepts every shipped question set', () => {
		for (const [name, questions] of Object.entries(QUESTION_PRESETS)) {
			assert.equal(questionsSchema(questions), true, `${name}: ${ajv.errorsText(questionsSchema.errors)}`);
		}
	});

	for (const [label, document, valid] of CORPUS) {
		it(`agrees with validateQuestions on ${label}`, () => {
			assert.equal(questionsSchema(document), valid, `schema: ${ajv.errorsText(questionsSchema.errors)}`);
			assert.equal(parserAccepts(document), valid, 'parser');
		});
	}

	it('drops $schema before the questions are sent', () => {
		assert.deepEqual(Object.keys(validateQuestions({ $schema: 'x', kind: choice })), ['kind']);
	});
});

describe('request.schema.json and response.schema.json', () => {
	it('describe the body the client sends for every preset', () => {
		for (const questions of Object.values(QUESTION_PRESETS)) {
			const body = buildSystemOneBody({ text: 'event' }, validateQuestions(questions), 'model-1');
			assert.equal(requestSchema(body), true, ajv.errorsText(requestSchema.errors));
		}
		assert.equal(requestSchema({ state: 'x', questions: {} }), false);
	});

	it('describe a canonical response', () => {
		const body = {
			model: 'example',
			answers: {
				kind: { type: 'choice', choice: 'a', confidence: 0.9, probabilities: { a: 0.9 } },
				ok: { type: 'noul', noul: 0.2 },
				risk: { type: 'score', score: 2, confidence: 0.8 },
			},
			usage: { input_tokens: 10, output_tokens: 2 },
		};
		assert.equal(responseSchema(body), true, ajv.errorsText(responseSchema.errors));
		assert.equal(responseSchema({ answers: { ok: { type: 'noul', noul: 2 } } }), false);
	});
});
