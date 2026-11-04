import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';

import { ATTACK_TRIAGE_RULES, referencedQuestions, validateRuleset } from 'decision-matrix-rules';
import { ATTACK_TRIAGE_QUESTIONS } from 'decision-matrix-systemone';

import { decide, EXIT_ERROR, EXIT_GATE, EXIT_OK, run } from '../src';
import { captured, examples, packageRoot as root, readExample } from './fixtures';

describe('attack-triage files', () => {
	it('matches the exported preset', () => {
		assert.deepEqual(JSON.parse(readExample('attack-triage.questions.json')), ATTACK_TRIAGE_QUESTIONS);
		assert.deepEqual(JSON.parse(readExample('attack-triage.rules.json')), ATTACK_TRIAGE_RULES);
		const ruleset = validateRuleset(ATTACK_TRIAGE_RULES);
		const questions = new Set(Object.keys(ATTACK_TRIAGE_QUESTIONS));
		for (const rule of ruleset.rules) {
			for (const id of referencedQuestions(rule.when)) {
				assert.ok(questions.has(id), `${id} is an attack-triage question`);
			}
		}
	});
});

describe('decide', () => {
	it('evaluates a saved answer map and skips the server', async () => {
		let calls = 0;
		const fetchImpl: typeof fetch = async () => {
			calls += 1;
			throw new Error('server should not be called');
		};
		const result = await decide({
			questions: ATTACK_TRIAGE_QUESTIONS,
			rules: ATTACK_TRIAGE_RULES,
			answers: JSON.parse(readExample('attack-triage.allow.answers.json')),
			server: { baseUrl: 'http://127.0.0.1:9', fetch: fetchImpl },
			failOnGate: true,
		});
		assert.equal(calls, 0);
		assert.equal(result.exitCode, EXIT_OK);
		assert.equal(result.record.action, 'allow');
		assert.equal(result.record.gate, false);
		assert.equal(result.record.answers.intent?.choice, 'legitimate_ops');
	});

	it('checks the ruleset before calling the server', async () => {
		let calls = 0;
		const fetchImpl: typeof fetch = async () => {
			calls += 1;
			return new Response('{}', { status: 200 });
		};
		await assert.rejects(
			() =>
				decide({
					state: 'payout change',
					questions: ATTACK_TRIAGE_QUESTIONS,
					rules: {
						version: 1,
						default_action: { type: 'escalate', target: 'human', reason: 'No matching rule', gate: true },
						thresholds: {},
						rules: [
							{
								id: 'hold',
								when: { all: [{ question: 'needs_human', gte: 'missing_bar' }] },
								action: { type: 'escalate', target: 'human', reason: 'hold', gate: true },
							},
						],
					},
					server: { baseUrl: 'http://127.0.0.1:9', fetch: fetchImpl },
				}),
			/missing_bar/,
		);
		assert.equal(calls, 0);
	});

	it('posts the event and evaluates the server answers', async () => {
		let url = '';
		let body: unknown;
		const fetchImpl: typeof fetch = async (input, init) => {
			url = String(input);
			body = JSON.parse(String(init?.body));
			const answers = JSON.parse(readExample('attack-triage.block.answers.json')) as unknown;
			return new Response(JSON.stringify({ answers }), { status: 200 });
		};
		const result = await decide({
			state: { actor: 'payroll-bot' },
			questions: ATTACK_TRIAGE_QUESTIONS,
			rules: ATTACK_TRIAGE_RULES,
			server: { baseUrl: 'http://decisions.example', model: 'lev', fetch: fetchImpl },
		});
		assert.equal(url, 'http://decisions.example/v1/systemone');
		const sent = body as { state: { actor: string }; model?: string; questions: Record<string, unknown> };
		assert.equal(sent.state.actor, 'payroll-bot');
		assert.equal(sent.model, 'lev');
		assert.equal(typeof sent.questions.intent, 'object');
		assert.equal(result.exitCode, EXIT_OK);
		assert.equal(result.record.matched_rule, 'hold-hostile');
		assert.equal(result.record.gate, true);
	});
});

describe('decision-matrix decide', () => {
	it('prints help', async () => {
		const { io, stdout, stderr } = captured(['decide', '--help']);
		assert.equal(await run(io), EXIT_OK);
		assert.match(stdout.join(''), /attack-triage/);
		assert.equal(stderr.join(''), '');
	});

	it('blocks a saved hostile answer and exits 2 when the gate fails the run', async () => {
		const { io, stdout } = captured(
			['decide', '--answers', 'block.json', '--fail-on-gate'],
			{ 'block.json': readExample('attack-triage.block.answers.json') },
		);
		assert.equal(await run(io), EXIT_GATE);
		const decision = JSON.parse(stdout.join('')) as { action: string; gate: boolean; matched_rule: string };
		assert.equal(decision.action, 'block');
		assert.equal(decision.gate, true);
		assert.equal(decision.matched_rule, 'hold-hostile');
	});

	it('uses a threshold override from the command line', async () => {
		const { io, stdout } = captured(
			['decide', '--answers', 'allow.json', '--threshold', 'high_confidence=0.99', '--fail-on-gate'],
			{ 'allow.json': readExample('attack-triage.allow.answers.json') },
		);
		assert.equal(await run(io), EXIT_GATE);
		const decision = JSON.parse(stdout.join('')) as { matched_rule: string | null; gate: boolean };
		assert.equal(decision.matched_rule, null);
		assert.equal(decision.gate, true);
	});

	it('does not call the server when answers are provided', async () => {
		const { io, stdout } = captured(
			['decide', '--answers', 'allow.json', '--server', 'http://127.0.0.1:9'],
			{ 'allow.json': readExample('attack-triage.allow.answers.json') },
		);
		assert.equal(await run(io), EXIT_OK);
		assert.equal(JSON.parse(stdout.join('')).action, 'allow');
	});

	it('reports a missing event before any server call', async () => {
		const { io, stderr } = captured(['decide', '--server', 'http://127.0.0.1:9']);
		assert.equal(await run(io), EXIT_ERROR);
		assert.match(stderr.join(''), /State is required/);
	});

	it('reads questions and rules from files', async () => {
		const { io, stdout } = captured(
			['decide', '--answers', 'allow.json', '--questions', 'questions.json', '--rules', 'rules.json'],
			{
				'allow.json': readExample('attack-triage.allow.answers.json'),
				'questions.json': readExample('attack-triage.questions.json'),
				'rules.json': readExample('attack-triage.rules.json'),
			},
		);
		assert.equal(await run(io), EXIT_OK);
		assert.equal(JSON.parse(stdout.join('')).matched_rule, 'allow-legitimate');
	});

	it('rejects an unknown preset, bad JSON, and a missing command', async () => {
		const unknown = captured(['decide', '--preset', 'nope']);
		assert.equal(await run(unknown.io), EXIT_ERROR);
		assert.match(unknown.stderr.join(''), /Unknown preset/);

		const badJson = captured(['decide', '--rules', 'rules.json', '--answers', 'allow.json'], {
			'allow.json': readExample('attack-triage.allow.answers.json'),
			'rules.json': '{',
		});
		assert.equal(await run(badJson.io), EXIT_ERROR);
		assert.match(badJson.stderr.join(''), /not valid JSON/);

		const missing = captured([]);
		assert.equal(await run(missing.io), EXIT_ERROR);
		assert.match(missing.stderr.join(''), /A command is required/);
	});
});

describe('decision-matrix bin', () => {
	it('exits 2 for a held event', () => {
		const tsx = path.join(root, 'node_modules/.bin/tsx');
		const cli = path.join(root, 'src/cli.ts');
		const answers = path.join(examples, 'attack-triage.block.answers.json');
		const result = spawnSync(
			tsx,
			['--tsconfig', path.join(root, 'tsconfig.json'), cli, 'decide', '--answers', answers, '--fail-on-gate'],
			{ cwd: root, encoding: 'utf8' },
		);
		assert.equal(result.status, EXIT_GATE, result.stderr);
		const decision = JSON.parse(result.stdout) as { action: string; gate: boolean };
		assert.equal(decision.action, 'block');
		assert.equal(decision.gate, true);
	});
});
