import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import Ajv2020 from 'ajv/dist/2020';

import { readCases } from '../src';
import { examples, packageRoot, readExample } from './fixtures';

const cases = JSON.parse(readFileSync(path.join(packageRoot, 'schema/cases.schema.json'), 'utf8'));
const rulesSchemas = path.dirname(require.resolve('decision-matrix-rules/schema/ruleset.schema.json'));
const facts = JSON.parse(readFileSync(path.join(rulesSchemas, 'facts.schema.json'), 'utf8'));
const ruleset = JSON.parse(readFileSync(path.join(rulesSchemas, 'ruleset.schema.json'), 'utf8'));
const questions = JSON.parse(readFileSync(require.resolve('decision-matrix-systemone/schema/questions.schema.json'), 'utf8'));

const ajv = new Ajv2020({ strict: true, strictRequired: false, allowUnionTypes: true, allErrors: true });
const casesSchema = ajv.compile(cases);
const rulesetSchema = ajv.compile(ruleset);
const questionsSchema = ajv.compile(questions);

const parserAccepts = (value: unknown) => {
	try {
		readCases(value);
		return true;
	} catch {
		return false;
	}
};

const one = (entry: Record<string, unknown>) => ({ version: 1, cases: [{ name: 'a', expect: { gate: true }, ...entry }] });
const CORPUS: Array<[string, unknown, boolean]> = [
	['a minimal file', one({}), true],
	['$schema for editors', { $schema: './cases.schema.json', ...one({}) }, true],
	['defaults with every part', { ...one({}), defaults: { facts: { a: { b: true } }, answers: { q: { noul: 0.2 } }, thresholds: { high: 0.9 } } }, true],
	['version 2', { ...one({}), version: 2 }, false],
	['an unknown file key', { ...one({}), extra: 1 }, false],
	['an unknown defaults key', { ...one({}), defaults: { expect: {} } }, false],
	['a case without a name', { version: 1, cases: [{ expect: { gate: true } }] }, false],
	['a blank name', one({ name: '  ' }), false],
	['a case without expect', { version: 1, cases: [{ name: 'a' }] }, false],
	['an empty expect', one({ expect: {} }), false],
	['an unknown expect key', one({ expect: { gates: true } }), false],
	['a gate that is a string', one({ expect: { gate: 'true' } }), false],
	['matched_rule null for the default', one({ expect: { matched_rule: null } }), true],
	['matched_rule that is a number', one({ expect: { matched_rule: 3 } }), false],
	['from_facts that is a string', one({ expect: { from_facts: 'yes' } }), false],
	['an unknown case key', one({ notes: 'x' }), false],
	['facts with a list of objects', one({ facts: { items: [{ a: 1 }] } }), false],
	['facts with a reserved key', one({ facts: { constructor: 1 } }), false],
	['a threshold that is a string', one({ thresholds: { high: '0.9' } }), false],
	['a threshold with a bad name', one({ thresholds: { '9x': 1 } }), false],
	['an empty answer', one({ answers: { q: {} } }), false],
	['an answer that is a number', one({ answers: { q: 0.5 } }), false],
	['answers in shorthand', one({ answers: { q: { noul: 0.5 } } }), true],
	['omit_facts', one({ omit_facts: ['touches_ci'] }), true],
	['omit_facts as a string', one({ omit_facts: 'touches_ci' }), false],
	['an omit_facts path with an empty segment', one({ omit_facts: ['a..b'] }), false],
	[
		'provenance',
		{ ...one({}), provenance: { model_id: 'model', temperature: 0, questions_hash: 'abc' } },
		true,
	],
	[
		'provenance with nulls',
		{ ...one({}), provenance: { model_id: null, temperature: null, questions_hash: 'abc' } },
		true,
	],
	['provenance missing a key', { ...one({}), provenance: { model_id: 'model', temperature: 0 } }, false],
	[
		'provenance with an unknown key',
		{ ...one({}), provenance: { model_id: 'model', temperature: 0, questions_hash: 'abc', extra: 1 } },
		false,
	],
];

describe('cases.schema.json', () => {
	it('accepts the shipped cases files', () => {
		for (const name of ['ci-change.cases.json', 'access-review.cases.json']) {
			assert.equal(casesSchema(JSON.parse(readExample(name))), true, `${name}: ${ajv.errorsText(casesSchema.errors)}`);
		}
	});

	for (const [label, document, valid] of CORPUS) {
		it(`agrees with readCases on ${label}`, () => {
			assert.equal(casesSchema(document), valid, `schema: ${ajv.errorsText(casesSchema.errors)}`);
			assert.equal(parserAccepts(document), valid, 'parser');
		});
	}

	it('leaves duplicate case names to the parser', () => {
		const duplicate = { version: 1, cases: [{ name: 'a', expect: { gate: true } }, { name: 'a', expect: { gate: true } }] };
		assert.equal(casesSchema(duplicate), true);
		assert.equal(parserAccepts(duplicate), false);
	});

	it('keeps its facts and thresholds definitions equal to the rules package', () => {
		assert.deepEqual(cases.$defs.factNode.propertyNames, facts.$defs.node.propertyNames);
		assert.deepEqual(cases.$defs.factScalar, facts.$defs.scalar);
		assert.deepEqual(cases.$defs.thresholds.propertyNames.pattern, ruleset.$defs.identifier.pattern);
		assert.deepEqual(cases.$defs.thresholds.propertyNames.not, ruleset.$defs.identifier.not);
	});
});

describe('shipped examples', () => {
	it('validate against their schemas', () => {
		for (const name of ['attack-triage', 'ci-change', 'access-review']) {
			assert.equal(rulesetSchema(JSON.parse(readExample(`${name}.rules.json`))), true, `${name} rules: ${ajv.errorsText(rulesetSchema.errors)}`);
			assert.equal(questionsSchema(JSON.parse(readExample(`${name}.questions.json`))), true, `${name} questions: ${ajv.errorsText(questionsSchema.errors)}`);
		}
		assert.ok(examples);
	});
});
