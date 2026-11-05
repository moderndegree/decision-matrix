import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import Ajv2020 from 'ajv/dist/2020';

import {
	ACCESS_REVIEW_RULES,
	ATTACK_TRIAGE_RULES,
	CI_CHANGE_RULES,
	GENERIC_TRIAGE_RULES,
	SDLC_RULES,
	SUPPORT_OPS_RULES,
	assertThresholdsResolve,
	validateFacts,
	validateRuleset,
} from '../src';

const schemaDir = path.resolve(__dirname, '..', 'schema');
const ajv = new Ajv2020({ strict: true, strictRequired: false, allowUnionTypes: true, allErrors: true });
const rulesetSchema = ajv.compile(JSON.parse(readFileSync(path.join(schemaDir, 'ruleset.schema.json'), 'utf8')));
const factsSchema = ajv.compile(JSON.parse(readFileSync(path.join(schemaDir, 'facts.schema.json'), 'utf8')));

const accepts = (parse: (value: unknown) => unknown) => (value: unknown) => {
	try {
		parse(value);
		return true;
	} catch {
		return false;
	}
};
const parserAccepts = accepts(validateRuleset);

const base = {
	version: 1,
	default_action: { type: 'hold', target: 'human', reason: 'No matching rule', gate: true },
	thresholds: { high: 0.8 },
	rules: [{ id: 'r', when: { all: [{ question: 'q', gte: 'high' }] }, action: { type: 'block', target: 'security', reason: 'Why', gate: true } }],
};
/** The base ruleset with one rule's condition replaced. */
const withWhen = (when: unknown) => ({ ...base, rules: [{ ...base.rules[0], when }] });

/** Each document must get the same verdict from the schema and from validateRuleset. */
const CORPUS: Array<[string, unknown, boolean]> = [
	['the base ruleset', base, true],
	['$schema for editors', { $schema: './ruleset.schema.json', ...base }, true],
	['$schema that is not a string', { $schema: 1, ...base }, false],
	['version 2', { ...base, version: 2 }, false],
	['an unknown top-level key', { ...base, extra: true }, false],
	['no default_action', { ...base, default_action: undefined }, false],
	['a reserved threshold name', { ...base, thresholds: { __proto__x: 1, constructor: 1 } }, false],
	['a threshold that is not a number', { ...base, thresholds: { high: '0.8' } }, false],
	['a numeric string operand', withWhen({ all: [{ question: 'q', gte: '0.5' }] }), true],
	['an exponent and a leading dot', withWhen({ all: [{ question: 'q', gte: '-.5e1' }] }), true],
	['a hex string operand', withWhen({ all: [{ question: 'q', gte: '0x10' }] }), false],
	['a padded numeric string', withWhen({ all: [{ question: 'q', gte: ' 1' }] }), false],
	['a threshold template', withWhen({ all: [{ question: 'q', gte: '{{ thresholds.high }}' }] }), true],
	['a threshold object', withWhen({ all: [{ question: 'q', gte: { threshold: 'high' } }] }), true],
	['a threshold object with an extra key', withWhen({ all: [{ question: 'q', gte: { threshold: 'high', x: 1 } }] }), false],
	['a reserved operand name', withWhen({ all: [{ question: 'q', gte: 'constructor' }] }), false],
	['an empty all', withWhen({ all: [] }), false],
	['all and any together', withWhen({ all: [{ question: 'q', gte: 1 }], any: [{ question: 'q', gte: 1 }] }), false],
	['a predicate with no operator', withWhen({ question: 'q' }), false],
	['choice and numeric operators together', withWhen({ question: 'q', eq: 'a', gte: 1 }), false],
	['choice and confidence operators together', withWhen({ question: 'q', in: ['a'], confidence_gte: 0.5 }), true],
	['a number as a choice label', withWhen({ question: 'q', eq: 3 }), true],
	['an empty choice label', withWhen({ question: 'q', eq: '' }), false],
	['a question id with a space', withWhen({ question: 'a b', gte: 1 }), false],
	['a question and a fact in one predicate', withWhen({ question: 'q', fact: 'f', eq: 1 }), false],
	['a nested fact path', withWhen({ fact: 'grant.privileged', eq: true }), true],
	['a hyphen in a fact path', withWhen({ fact: 'dep-count', gt: 0 }), true],
	['a reserved fact segment', withWhen({ fact: 'a.prototype', eq: 1 }), false],
	['an empty fact segment', withWhen({ fact: 'a..b', eq: 1 }), false],
	['a fact with no operator', withWhen({ fact: 'f' }), false],
	['a confidence operator on a fact', withWhen({ fact: 'f', confidence_gte: 0.5 }), false],
	['contains on a fact', withWhen({ fact: 'tags', contains: 'prod' }), true],
	['contains on a question', withWhen({ question: 'q', contains: 'x' }), false],
	['a list as a fact operand', withWhen({ fact: 'f', eq: [1] }), false],
	['an empty in list', withWhen({ fact: 'f', in: [] }), false],
	['a reason of only spaces', { ...base, default_action: { ...base.default_action, reason: '  ' } }, false],
	['a gate that is a string', { ...base, default_action: { ...base.default_action, gate: 'true' } }, false],
	['a rule id with a space', { ...base, rules: [{ ...base.rules[0], id: 'a b' }] }, false],
	['a rule without an action', { ...base, rules: [{ id: 'r', when: base.rules[0]!.when }] }, false],
	['open_gate_requires_facts that is a string', { ...base, open_gate_requires_facts: 'yes' }, false],
	['owner and ticket', { ...base, owner: 'decision-matrix', ticket: 'ci-change' }, true],
	['an owner of only spaces', { ...base, owner: '   ' }, false],
	['an empty fact schema', { ...base, fact_schema: {} }, true],
	['a fact schema entry', { ...base, fact_schema: { touches_ci: { type: 'boolean', required: true } } }, true],
	['a fact schema type the engine does not have', { ...base, fact_schema: { touches_ci: { type: 'date', required: true } } }, false],
	['an agreement', { ...base, agreements: [{ question: 'q', fact: 'touches_ci', relation: 'inverse' }] }, true],
	['an agreement relation the engine does not have', { ...base, agreements: [{ question: 'q', fact: 'touches_ci', relation: 'gt' }] }, false],
	['an instant operand', withWhen({ fact: 'seen_at', gte: '2024-01-02T03:04:05Z' }), true],
	['a date-only operand', withWhen({ fact: 'seen_at', gte: '2024-01-02' }), false],
];

/** Valid by shape, rejected by checks JSON Schema cannot make. Documented in the schema's $comment. */
const PARSER_ONLY: Array<[string, unknown, (value: unknown) => unknown]> = [
	['duplicate rule ids', { ...base, rules: [base.rules[0], base.rules[0]] }, validateRuleset],
	['a threshold that does not resolve', withWhen({ all: [{ question: 'q', gte: 'missing' }] }), assertThresholdsResolve],
	[
		'a strict ruleset whose default opens the gate',
		{ ...base, open_gate_requires_facts: true, default_action: { ...base.default_action, gate: false } },
		validateRuleset,
	],
	[
		'a strict ruleset with a rule the model alone opens',
		{ ...base, open_gate_requires_facts: true, rules: [{ ...base.rules[0], action: { ...base.rules[0]!.action, gate: false } }] },
		validateRuleset,
	],
];

describe('ruleset.schema.json', () => {
	it('accepts every shipped ruleset', () => {
		for (const [name, rules] of Object.entries({ ACCESS_REVIEW_RULES, ATTACK_TRIAGE_RULES, CI_CHANGE_RULES, GENERIC_TRIAGE_RULES, SDLC_RULES, SUPPORT_OPS_RULES })) {
			assert.equal(rulesetSchema(rules), true, `${name}: ${ajv.errorsText(rulesetSchema.errors)}`);
		}
	});

	for (const [label, document, valid] of CORPUS) {
		it(`agrees with validateRuleset on ${label}`, () => {
			const clean = JSON.parse(JSON.stringify(document));
			assert.equal(rulesetSchema(clean), valid, `schema: ${ajv.errorsText(rulesetSchema.errors)}`);
			assert.equal(parserAccepts(clean), valid, 'parser');
		});
	}

	for (const [label, document, parse] of PARSER_ONLY) {
		it(`leaves ${label} to the parser`, () => {
			assert.equal(rulesetSchema(document), true, ajv.errorsText(rulesetSchema.errors));
			assert.equal(accepts(parse)(document), false);
		});
	}
});

describe('facts.schema.json', () => {
	const FACTS: Array<[string, unknown, boolean]> = [
		['scalars', { a: 'x', b: 1, c: true, d: null }, true],
		['nested objects', { grant: { privileged: true, role: { name: 'admin' } } }, true],
		['a list of scalars', { new_packages: ['a', 'b'], mixed: [1, 'x', null] }, true],
		['a list of objects', { items: [{ a: 1 }] }, false],
		['a list of lists', { items: [[1]] }, false],
		['a key with a dot', { 'a.b': 1 }, false],
		['a key that starts with a digit', { '1a': 1 }, false],
		['a reserved key', { constructor: 1 }, false],
		['a hyphen in a key', { 'dep-count': 1 }, true],
		['a list at the top', [1], false],
		['a string at the top', 'x', false],
	];
	for (const [label, document, valid] of FACTS) {
		it(`agrees with validateFacts on ${label}`, () => {
			assert.equal(factsSchema(document), valid, ajv.errorsText(factsSchema.errors));
			assert.equal(accepts(validateFacts)(document), valid);
		});
	}
});
