import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CI_CHANGE_RULES, RulesError } from 'decision-matrix-rules';
import { CI_CHANGE_QUESTIONS } from 'decision-matrix-systemone';

import { EXIT_ERROR, EXIT_GATE, EXIT_OK, decide, run } from '../src';
import { CI_FACTS, captured, ciAnswers } from './fixtures';

describe('decide with facts', () => {
	it('decides from facts without a server or a state', async () => {
		const { io, stdout } = captured(
			['decide', '--preset', 'ci-change', '--facts', 'facts.json', '--fail-on-gate'],
			{ 'facts.json': JSON.stringify({ ...CI_FACTS, touches_ci: true }) },
		);
		assert.equal(await run(io), EXIT_GATE);
		const record = JSON.parse(stdout.join(''));
		assert.equal(record.matched_rule, 'hold-ci-config');
		assert.deepEqual(record.answers, {});
	});

	it('fails a missing fact before calling the server', async () => {
		let calls = 0;
		const fetchImpl: typeof fetch = async () => {
			calls += 1;
			throw new Error('server should not be called');
		};
		const missing: Record<string, unknown> = { ...CI_FACTS };
		delete missing.touches_ci;
		await assert.rejects(
			decide({
				state: 'diff',
				questions: CI_CHANGE_QUESTIONS,
				rules: CI_CHANGE_RULES,
				facts: missing,
				server: { baseUrl: 'http://localhost:8000', fetch: fetchImpl },
			}),
			(error: unknown) => error instanceof RulesError && /fact "touches_ci", which is missing/.test(error.message),
		);
		assert.equal(calls, 0);
	});

	it('sends the state but not the facts, then evaluates both', async () => {
		let sent: Record<string, unknown> | undefined;
		const fetchImpl: typeof fetch = async (_url, init) => {
			sent = JSON.parse(String(init?.body));
			return new Response(JSON.stringify({ answers: ciAnswers() }), { status: 200 });
		};
		const result = await decide({
			state: { title: 'Small fix' },
			questions: CI_CHANGE_QUESTIONS,
			rules: CI_CHANGE_RULES,
			facts: CI_FACTS,
			failOnGate: true,
			server: { baseUrl: 'http://localhost:8000', fetch: fetchImpl },
		});
		assert.deepEqual(Object.keys(sent ?? {}).sort(), ['questions', 'state']);
		assert.equal(result.record.matched_rule, 'pass-small-change');
		assert.equal(result.exitCode, EXIT_OK);
	});

	it('rejects a facts file that is not an object', async () => {
		const { io, stderr } = captured(['decide', '--preset', 'ci-change', '--facts', 'f.json'], { 'f.json': '[]' });
		assert.equal(await run(io), EXIT_ERROR);
		assert.match(stderr.join(''), /must contain a JSON object of facts/);
	});
});
