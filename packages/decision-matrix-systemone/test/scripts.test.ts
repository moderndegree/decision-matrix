import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { evaluateRules, GENERIC_TRIAGE_RULES, SDLC_RULES, SUPPORT_OPS_RULES } from 'decision-matrix-rules';
import Ajv2020 from 'ajv/dist/2020';

import {
	QUESTION_PRESETS,
	SCRIPT_PRESETS,
	runScripts,
	validateScripts,
} from '../src';

const schemaDir = path.resolve(__dirname, '..', 'schema');
const ajv = new Ajv2020({ strict: true, strictRequired: false, allowUnionTypes: true, allErrors: true });
const scriptsSchema = ajv.compile(JSON.parse(readFileSync(path.join(schemaDir, 'scripts.schema.json'), 'utf8')));

const choiceQuestion = { category: { type: 'choice', instructions: 'Which queue', criteria: { billing: 'Pay', other: 'Else' } } };
const step = (extra: Record<string, unknown>) => ({ version: 1, scripts: [{ question: 'category', ...extra }] });

const parserAccepts = (value: unknown) => {
	try {
		validateScripts(value);
		return true;
	} catch {
		return false;
	}
};

const CORPUS: Array<[string, unknown, boolean]> = [
	['a contains choice', step({ contains: 'invoice', choice: 'billing', confidence: 0.9 }), true],
	['a word list', step({ word: ['invoice', 'refund'], choice: 'billing', confidence: 1 }), true],
	['a tag on a path', step({ path: 'title', tag: 'feat', choice: 'billing', confidence: 0.5 }), true],
	['several paths', step({ path: ['title', 'subject'], tag: ['feat', 'feature'], choice: 'billing', confidence: 0.5 }), true],
	['equals a string', step({ equals: { path: 'commit.type', value: 'feat' }, choice: 'billing', confidence: 1 }), true],
	['equals a number', { version: 1, scripts: [{ question: 'q', equals: { path: 'n', value: 2 }, score: 1, confidence: 0 }] }, true],
	['equals null', step({ equals: { path: 'commit.type', value: null }, choice: 'billing', confidence: 0 }), true],
	['else noul', { version: 1, scripts: [{ question: 'q', else: true, noul: 0.2 }] }, true],
	['a description and $schema', { $schema: './scripts.schema.json', ...step({ description: 'Billing words', word: 'invoice', choice: 'billing', confidence: 0.9 }) }, true],
	['no version', { scripts: [{ question: 'q', else: true, noul: 1 }] }, false],
	['version 2', { version: 2, scripts: [{ question: 'q', else: true, noul: 1 }] }, false],
	['no steps', { version: 1, scripts: [] }, false],
	['an unknown key', { version: 1, scripts: [], extra: true }, false],
	['a step that is not an object', { version: 1, scripts: ['contains'] }, false],
	['two matchers', step({ contains: 'a', word: 'b', choice: 'billing', confidence: 0.5 }), false],
	['no matcher', step({ choice: 'billing', confidence: 0.5 }), false],
	['choice and noul', step({ else: true, choice: 'billing', noul: 1, confidence: 0.5 }), false],
	['choice without confidence', step({ else: true, choice: 'billing' }), false],
	['noul with confidence', { version: 1, scripts: [{ question: 'q', else: true, noul: 0.2, confidence: 0.2 }] }, false],
	['confidence above 1', step({ else: true, choice: 'billing', confidence: 1.1 }), false],
	['an empty needle', step({ word: '', choice: 'billing', confidence: 0.5 }), false],
	['a blank needle in a list', step({ word: ['invoice', ' '], choice: 'billing', confidence: 0.5 }), false],
	['a repeated needle', step({ word: ['invoice', 'invoice'], choice: 'billing', confidence: 0.5 }), false],
	['else false', step({ else: false, choice: 'billing', confidence: 0.5 }), false],
	['else with a path', step({ else: true, path: 'title', choice: 'billing', confidence: 0.5 }), false],
	['equals with a step path', step({ equals: { path: 'commit.type', value: 'feat' }, path: 'title', choice: 'billing', confidence: 1 }), false],
	['a broken path', step({ equals: { path: 'commit..type', value: 'feat' }, choice: 'billing', confidence: 1 }), false],
	['a question with a space', { version: 1, scripts: [{ question: 'a b', else: true, noul: 0 }] }, false],
	['a fractional score', { version: 1, scripts: [{ question: 'q', else: true, score: 1.5, confidence: 0.5 }] }, false],
	['a negative score', { version: 1, scripts: [{ question: 'q', else: true, score: -1, confidence: 0.5 }] }, false],
	['a noul above 1', { version: 1, scripts: [{ question: 'q', else: true, noul: 2 }] }, false],
	['a blank choice', step({ else: true, choice: ' ', confidence: 0.5 }), false],
	['an extra equals key', step({ equals: { path: 'a', value: 'b', op: 'eq' }, choice: 'billing', confidence: 1 }), false],
	['a list', [], false],
	['$schema that is not a string', { $schema: 1, ...step({ else: true, choice: 'billing', confidence: 0.5 }) }, false],
];

describe('scripts.schema.json', () => {
	it('accepts every shipped script', () => {
		for (const name of ['generic', 'sdlc', 'support'] as const) {
			assert.equal(scriptsSchema(SCRIPT_PRESETS[name]), true, `${name}: ${ajv.errorsText(scriptsSchema.errors)}`);
			const program = validateScripts(SCRIPT_PRESETS[name], QUESTION_PRESETS[name]);
			const answered = Object.keys(runScripts(program, 'nothing to match here')).sort();
			assert.deepEqual(answered, Object.keys(QUESTION_PRESETS[name]).sort());
		}
	});

	for (const [label, document, valid] of CORPUS) {
		it(`agrees with validateScripts on ${label}`, () => {
			assert.equal(scriptsSchema(document), valid, `schema: ${ajv.errorsText(scriptsSchema.errors)}`);
			assert.equal(parserAccepts(document), valid, 'parser');
		});
	}
});

describe('validateScripts', () => {
	it('rejects what the schema cannot see', () => {
		const later = {
			version: 1,
			scripts: [
				{ question: 'category', else: true, choice: 'other', confidence: 0.2 },
				{ question: 'category', word: 'invoice', choice: 'billing', confidence: 0.9 },
			],
		};
		assert.equal(scriptsSchema(later), true, ajv.errorsText(scriptsSchema.errors));
		assert.throws(() => validateScripts(later), /else must be the last step/);
		const reserved = step({ path: '__proto__', word: 'invoice', choice: 'billing', confidence: 0.5 });
		assert.equal(scriptsSchema(reserved), true);
		assert.throws(() => validateScripts(reserved), /dotted path/);
		const deep = step({
			path: Array.from({ length: 33 }, () => 'a').join('.'),
			word: 'invoice',
			choice: 'billing',
			confidence: 0.5,
		});
		assert.equal(scriptsSchema(deep), true);
		assert.throws(() => validateScripts(deep), /32 segments/);
	});

	it('checks the step against the question set', () => {
		assert.throws(
			() => validateScripts(step({ word: 'invoice', choice: 'nope', confidence: 0.9 }), choiceQuestion),
			/not a label/,
		);
		assert.throws(
			() => validateScripts(step({ word: 'invoice', score: 1, confidence: 0.9 }), choiceQuestion),
			/is a choice/,
		);
		assert.throws(
			() => validateScripts({ version: 1, scripts: [{ question: 'missing', else: true, noul: 0.1 }] }, choiceQuestion),
			/not in the question set/,
		);
		const scoreQuestion = { risk: { type: 'score', instructions: 'How risky', criteria: ['low', 'high'] } };
		assert.throws(
			() => validateScripts({ version: 1, scripts: [{ question: 'risk', else: true, score: 2, confidence: 0.5 }] }, scoreQuestion),
			/levels are 0 to 1/,
		);
	});
});

describe('runScripts', () => {
	const questions = choiceQuestion;
	const program = (scripts: unknown) => validateScripts(scripts, questions);

	it('matches contains, word, and tag without crossing a word or a type token', () => {
		const contains = program(step({ contains: 'pay', choice: 'billing', confidence: 0.4 }));
		assert.equal(runScripts(contains, 'repayment').category?.choice, 'billing');
		const word = program(step({ word: 'payment', choice: 'billing', confidence: 0.9 }));
		assert.equal(runScripts(word, 'repayment schedule').category, undefined);
		assert.equal(runScripts(word, 'Payment is due').category?.choice, 'billing');
		const down = program(step({ word: 'down', choice: 'billing', confidence: 0.9 }));
		assert.equal(runScripts(down, 'download the whitepaper').category, undefined);
		assert.equal(runScripts(down, 'the site is Down').category?.choice, 'billing');
		const tag = program(step({ tag: 'feat', choice: 'billing', confidence: 0.99 }));
		assert.equal(runScripts(tag, 'feat: add export').category?.choice, 'billing');
		assert.equal(runScripts(tag, 'Feat(api): add export').category?.choice, 'billing');
		assert.equal(runScripts(tag, 'feature: add export').category, undefined);
		assert.equal(runScripts(tag, 'feat add export').category, undefined);
		assert.equal(runScripts(tag, { title: 'feat: add export' }).category, undefined);
		const titled = program(step({ path: ['title', 'subject'], tag: 'feat', choice: 'billing', confidence: 0.99 }));
		assert.equal(runScripts(titled, { subject: 'feat: add export' }).category?.choice, 'billing');
	});

	it('compares equals exactly and reads a dotted path', () => {
		const equals = program(step({ equals: { path: 'commit.type', value: 'feat' }, choice: 'billing', confidence: 1 }));
		assert.equal(runScripts(equals, { commit: { type: 'feat' } }).category?.confidence, 1);
		assert.equal(runScripts(equals, { commit: { type: 'Feat' } }).category, undefined);
		assert.equal(runScripts(equals, { commit: { type: 'feature' } }).category, undefined);
		const index = program(step({ equals: { path: 'items.0.kind', value: 'bug' }, choice: 'billing', confidence: 1 }));
		assert.equal(runScripts(index, { items: [{ kind: 'bug' }] }).category?.choice, 'billing');
	});

	it('uses the first match and lets else fill only what is left', () => {
		const scripts = {
			version: 1,
			scripts: [
				{ question: 'category', word: 'invoice', choice: 'billing', confidence: 0.96 },
				{ question: 'category', word: 'error', choice: 'other', confidence: 0.4 },
				{ question: 'category', else: true, choice: 'other', confidence: 0.45 },
			],
		};
		const compiled = program(scripts);
		assert.equal(runScripts(compiled, 'payment error on the invoice').category?.choice, 'billing');
		assert.equal(runScripts(compiled, 'hello').category?.confidence, 0.45);
	});
});

describe('preset scripts', () => {
	it('routes a billing note and holds a same-day one', () => {
		const billing = local(GENERIC_TRIAGE_RULES, 'generic', 'I was charged twice on my invoice');
		assert.equal(billing.action, 'route');
		assert.equal(billing.target, 'billing');
		assert.equal(billing.gate, false);
		const today = local(GENERIC_TRIAGE_RULES, 'generic', 'I need a refund today');
		assert.equal(today.matched_rule, 'urgent-human');
		assert.equal(today.gate, true);
		const review = local(GENERIC_TRIAGE_RULES, 'generic', 'please review this invoice');
		assert.equal(review.matched_rule, 'urgent-human');
		const repayment = local(GENERIC_TRIAGE_RULES, 'generic', 'repayment schedule for next quarter');
		assert.equal(repayment.matched_rule, null);
	});

	it('pages an outage and queues a how-to', () => {
		const page = local(SUPPORT_OPS_RULES, 'support', 'service down for all customers');
		assert.equal(page.action, 'page');
		assert.equal(page.gate, true);
		const howTo = local(SUPPORT_OPS_RULES, 'support', 'how do I reset my password');
		assert.equal(howTo.action, 'route');
		assert.equal(howTo.target, 'ticket-queue');
		const pageWord = local(SUPPORT_OPS_RULES, 'support', 'the status page is slow');
		assert.equal(pageWord.matched_rule, null);
	});

	it('sends a conventional commit to an implementer and a migration to design', () => {
		const feature = local(SDLC_RULES, 'sdlc', 'feat: add export');
		assert.equal(feature.action, 'route');
		assert.equal(feature.target, 'implementer');
		assert.equal(feature.gate, false);
		const migrate = local(SDLC_RULES, 'sdlc', 'feat: migrate the payments table');
		assert.equal(migrate.matched_rule, 'needs-design');
		assert.equal(migrate.gate, true);
		const titled = local(SDLC_RULES, 'sdlc', { title: 'fix: null pointer' });
		assert.equal(titled.action, 'route');
		assert.equal(titled.reason, 'Ready to implement as bugfix');
		const structured = local(SDLC_RULES, 'sdlc', { commit: { type: 'feat' }, title: 'fix: typo' });
		assert.equal(structured.reason, 'Ready to implement as feature');
		const prose = local(SDLC_RULES, 'sdlc', 'update the readme typos');
		assert.equal(prose.matched_rule, null);
	});
});

function local(rules: unknown, preset: 'generic' | 'sdlc' | 'support', state: unknown) {
	const program = validateScripts(SCRIPT_PRESETS[preset], QUESTION_PRESETS[preset]);
	return evaluateRules(rules, runScripts(program, state));
}
