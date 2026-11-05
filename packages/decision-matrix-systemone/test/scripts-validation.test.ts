import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SystemOneError, runScripts, unansweredQuestions, validateScripts } from '../src';

const doc = (...scripts: unknown[]) => ({ version: 1, scripts });
const step = (extra: Record<string, unknown>) => ({ question: 'q', contains: 'x', noul: 1, ...extra });
const choiceStep = (extra: Record<string, unknown>) => ({ question: 'q', contains: 'x', choice: 'a', confidence: 1, noul: undefined, ...extra });

function rejects(run: () => unknown, message: RegExp) {
	assert.throws(run, (error: unknown) => {
		assert.ok(error instanceof SystemOneError, `expected SystemOneError, got ${String(error)}`);
		assert.match(error.message, message);
		return true;
	});
}

describe('validateScripts rejects', () => {
	const cases: Array<[string, unknown, RegExp]> = [
		['a step that is not an object', 'x', /scripts\[0\] must be an object/],
		['a question with spaces', step({ question: 'a b' }), /question must be a non-empty string without spaces/],
		['a non-string description', step({ description: 1 }), /description must be a string/],
		['no matcher', { question: 'q', noul: 1 }, /must have one matcher.*Found none/],
		['two matchers', step({ word: 'y' }), /must have one matcher.*Found "contains" and "word"/],
		['no answer', { question: 'q', contains: 'x' }, /must have one answer.*Found none/],
		['two answers', step({ score: 1, confidence: 1 }), /must have one answer.*Found "noul" and "score"/],
		['path on else', { question: 'q', else: true, noul: 1, path: 'a' }, /path is used with contains, word, and tag/],
		['path on equals', { question: 'q', equals: { path: 'a', value: 1 }, noul: 1, path: 'a' }, /path is used with contains, word, and tag/],
		['an empty path list', step({ path: [] }), /must be a dotted path or a list of different paths/],
		['a repeated path', step({ path: ['a', 'a'] }), /must be a dotted path or a list of different paths/],
		['a path that is not a string', step({ path: [1] }), /path\[0\] must be a dotted path/],
		['a path that is too long', step({ path: 'a'.repeat(513) }), /must be a dotted path/],
		['a path that is too deep', step({ path: Array(33).fill('a').join('.') }), /nests more than 32 segments/],
		['a reserved path segment', step({ path: 'a.__proto__' }), /must be a dotted path of names or array indexes/],
		['confidence on a noul', step({ confidence: 1 }), /confidence is not used on a noul answer/],
		['a noul above 1', step({ noul: 2 }), /noul must be a number from 0 to 1/],
		['a choice with no confidence', choiceStep({ confidence: undefined }), /confidence must be a number from 0 to 1/],
		['a blank choice', choiceStep({ choice: ' ' }), /choice must be a non-empty label/],
		['a negative score', { question: 'q', contains: 'x', score: -1, confidence: 1 }, /score must be an integer level/],
		['a fractional score', { question: 'q', contains: 'x', score: 1.5, confidence: 1 }, /score must be an integer level/],
		['else that is not true', { question: 'q', else: false, noul: 1 }, /else must be true/],
		['equals that is not an object', { question: 'q', equals: 'x', noul: 1 }, /equals must be an object with path and value/],
		['equals with an extra key', { question: 'q', equals: { path: 'a', value: 1, x: 1 }, noul: 1 }, /unknown key "x"/],
		['equals on an object value', { question: 'q', equals: { path: 'a', value: {} }, noul: 1 }, /must be a string, number, boolean, or null/],
		['equals on a non-finite value', { question: 'q', equals: { path: 'a', value: Number.NaN }, noul: 1 }, /must be a string, number, boolean, or null/],
		['an empty needle list', step({ contains: [] }), /must be a non-empty string or a list of different ones/],
		['a repeated needle', step({ contains: ['a', 'a'] }), /must be a non-empty string or a list of different ones/],
		['a blank needle', step({ contains: ['a', ' '] }), /contains\[1\] must be a non-empty string/],
		['a needle that is not a string', step({ contains: [1] }), /contains\[0\] must be a non-empty string/],
	];
	for (const [name, value, message] of cases) it(name, () => rejects(() => validateScripts(doc(value)), message));

	it('a document that is not version 1 with a list of scripts', () => {
		rejects(() => validateScripts([] as never), /Scripts must be a JSON object with version and scripts/);
		rejects(() => validateScripts({ version: 2, scripts: [] }), /version/);
		rejects(() => validateScripts({ version: 1, scripts: 'x' }), /scripts/);
		rejects(() => validateScripts({ version: 1, scripts: [], extra: 1 }), /unknown key "extra"/);
	});

	it('a step after else for the same question', () => {
		rejects(() => validateScripts(doc({ question: 'q', else: true, noul: 1 }, step({}))), /follows else for "q"/);
	});
});

describe('validateScripts against a question set', () => {
	const questions = {
		$schema: 'ignored',
		yes: { type: 'noul', instructions: 'i' },
		level: { type: 'score', instructions: 'i', criteria: ['low', 'high'] },
		list: { type: 'choice', instructions: 'i', criteria: ['a', 'b', ''] },
		map: { type: 'choice', instructions: 'i', criteria: { c: 'see', d: 'dee' } },
	};
	const check = (value: unknown, set: object = questions) => validateScripts(doc(value), set);

	it('accepts answers that fit', () => {
		assert.doesNotThrow(() => check({ question: 'yes', contains: 'x', noul: 1 }));
		assert.doesNotThrow(() => check({ question: 'level', contains: 'x', score: 1, confidence: 1 }));
		assert.doesNotThrow(() => check({ question: 'list', contains: 'x', choice: 'b', confidence: 1 }));
		assert.doesNotThrow(() => check({ question: 'map', contains: 'x', choice: 'd', confidence: 1 }));
	});

	it('rejects a question outside the set, a wrong type, a wrong label, and a level out of range', () => {
		rejects(() => check({ question: 'other', contains: 'x', noul: 1 }), /"other" is not in the question set/);
		rejects(() => check({ question: 'yes', contains: 'x', score: 1, confidence: 1 }), /answers score, and question "yes" is a noul/);
		rejects(() => check({ question: 'map', contains: 'x', choice: 'z', confidence: 1 }), /"z" is not a label of question "map"/);
		rejects(() => check({ question: 'level', contains: 'x', score: 2, confidence: 1 }), /levels are 0 to 1/);
	});

	it('rejects a question set it cannot read', () => {
		const ok = { question: 'q', contains: 'x', noul: 1 };
		rejects(() => check(ok, [] as never), /Questions passed to validateScripts must be an object/);
		rejects(() => check(ok, { q: 'x' }), /questions\.q must be an object/);
		rejects(() => check(ok, { q: { type: 'text' } }), /questions\.q\.type must be/);
		rejects(() => check(ok, { q: { type: 'score', criteria: ['one'] } }), /criteria must list the score levels/);
		rejects(() => check(ok, { q: { type: 'choice', criteria: [] } }), /criteria must list the choice labels/);
		rejects(() => check(ok, { q: { type: 'choice' } }), /criteria must list the choice labels/);
	});
});

describe('runScripts', () => {
	it('refuses a plain object in place of a compiled program', () => {
		rejects(() => runScripts({ steps: [] } as never, 'x'), /expects the program returned by validateScripts/);
	});

	it('uses the first step that matches for a question', () => {
		const program = validateScripts(doc(step({ contains: 'x', noul: 0.1 }), step({ contains: 'x', noul: 0.9 }), { question: 'q', else: true, noul: 0.5 }));
		assert.equal(runScripts(program, 'x').q?.noul, 0.1);
		assert.equal(runScripts(program, 'y').q?.noul, 0.5);
	});

	it('leaves a question out when nothing matches', () => {
		const program = validateScripts(doc(step({})));
		assert.deepEqual(runScripts(program, 'nothing here'), {});
	});

	it('compares equals by type, so 1 is not "1"', () => {
		const program = validateScripts(doc({ question: 'q', equals: { path: 'a', value: 1 }, noul: 1 }));
		assert.equal(runScripts(program, { a: 1 }).q?.noul, 1);
		assert.deepEqual(runScripts(program, { a: '1' }), {});
	});
});

describe('unansweredQuestions', () => {
	it('keeps order and is not fooled by inherited names', () => {
		const questions = { a: 1, toString: 2, b: 3 };
		assert.deepEqual(Object.keys(unansweredQuestions(questions, { a: { type: 'noul', noul: 1 } })), ['toString', 'b']);
	});
});
