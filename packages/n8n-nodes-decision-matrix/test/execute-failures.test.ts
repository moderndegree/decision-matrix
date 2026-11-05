import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { rulesetHash, validateRuleset } from 'decision-matrix-rules';
import { NodeOperationError } from 'n8n-workflow';

import { DecisionServerApi } from '../credentials/DecisionServerApi.credentials';
// DecisionMatrix.node.json shares this stem, so the extension is required or the loader reads the codex file.
// @ts-expect-error TS5097: this package's module setting does not allow a .ts specifier, and tsx needs one here.
import { DecisionMatrix } from '../nodes/DecisionMatrix/DecisionMatrix.node.ts';
import { readThrownHttpError, unwrapN8nResponse } from '../nodes/DecisionMatrix/n8n-http';

const hold = { type: 'hold', target: 'human', reason: 'No matching rule', gate: true };
const rules = {
	version: 1,
	default_action: hold,
	rules: [{ id: 'yes', when: { question: 'q', gte: 0.5 }, action: { type: 'pass', target: 't', reason: 'ok', gate: false } }],
};
const questions = { q: { type: 'noul', instructions: 'Is it?' } };
const okBody = { answers: { q: { type: 'noul', noul: 0.9 } } };

interface Harness {
	params?: Record<string, unknown>;
	items?: number;
	continueOnFail?: boolean;
	http?: (options: Record<string, unknown>) => unknown;
	credentials?: () => unknown;
}

function run(harness: Harness = {}) {
	const params: Record<string, unknown> = { state: 'text', questionSet: 'custom', questions, rules, ...harness.params };
	const calls: Array<Record<string, unknown>> = [];
	let credentialLoads = 0;
	const context = {
		getInputData: () => Array.from({ length: harness.items ?? 1 }, () => ({ json: {} })),
		getNodeParameter: (name: string, itemIndex: number, fallback?: unknown) => {
			const value = name in params ? params[name] : fallback;
			return typeof value === 'function' ? value(itemIndex) : value;
		},
		continueOnFail: () => harness.continueOnFail ?? false,
		getNode: () => ({ name: 'Decision Matrix', type: 'decisionMatrix', typeVersion: 1 }),
		getCredentials: async () => {
			credentialLoads += 1;
			return harness.credentials ? harness.credentials() : { baseUrl: 'http://server/' };
		},
		helpers: {
			httpRequestWithAuthentication: async (_type: string, options: Record<string, unknown>) => {
				calls.push(options);
				return harness.http ? harness.http(options) : { statusCode: 200, body: okBody };
			},
		},
	};
	const result = new DecisionMatrix().execute.call(context as never).then(([items]: unknown[][]) => items as Array<{ json: Record<string, unknown>; pairedItem: unknown }>);
	return { result, calls, credentialLoads: () => credentialLoads };
}

describe('execute against the server', () => {
	it('posts to the normalized URL and evaluates the answers', async () => {
		const { result, calls } = run({ params: { options: { model: 'm' } } });
		const [item] = await result;
		assert.equal(item?.json.matched_rule, 'yes');
		assert.equal(item?.json.gate, false);
		assert.equal(calls[0]?.url, 'http://server/v1/systemone');
		assert.equal((calls[0]?.body as { model: string }).model, 'm');
		assert.equal(calls[0]?.ignoreHttpStatusErrors, true);
	});

	it('loads the credential once across items', async () => {
		const harness = run({ items: 3 });
		const items = await harness.result;
		assert.equal(items.length, 3);
		assert.equal(harness.credentialLoads(), 1);
		assert.deepEqual(items.map((item) => item.pairedItem), [{ item: 0 }, { item: 1 }, { item: 2 }]);
	});

	it('does not load the credential when scripts answer every question', async () => {
		const scripts = { version: 1, scripts: [{ question: 'q', else: true, noul: 1 }] };
		const harness = run({ params: { answerWith: 'scripts', scripts } });
		const [item] = await harness.result;
		assert.equal(item?.json.matched_rule, 'yes');
		assert.equal(harness.credentialLoads(), 0);
		assert.equal(harness.calls.length, 0);
	});

	it('does not call the server when leading facts decide', async () => {
		const facts = { version: 1, default_action: hold, rules: [{ id: 'f', when: { fact: 'stop', eq: true }, action: hold }, ...rules.rules] };
		const harness = run({ params: { rules: facts, facts: { stop: true } } });
		const [item] = await harness.result;
		assert.equal(item?.json.matched_rule, 'f');
		assert.equal(harness.calls.length, 0);
	});

	it('explains a missing credential', async () => {
		const { result } = run({
			credentials: () => {
				throw new Error('no credential');
			},
		});
		await assert.rejects(result, /A Decision Server API credential is required/);
	});

	it('keeps a thrown HTTP error as its status', async () => {
		const { result } = run({
			http: () => {
				throw { message: 'Request failed with status code 401', response: { status: 401, data: { detail: 'bad token' } } };
			},
		});
		await assert.rejects(result, /401 Unauthorized[\s\S]*bad token/);
	});

	it('reports a network failure as unreachable', async () => {
		const { result } = run({
			http: () => {
				throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
			},
		});
		await assert.rejects(result, /Could not reach the decision server[\s\S]*refused/);
	});

	it('wraps failures in a NodeOperationError with the item index', async () => {
		const { result } = run({ params: { state: '' } });
		await assert.rejects(result, (error: unknown) => {
			assert.ok(error instanceof NodeOperationError);
			assert.match(error.message, /State is required/);
			return true;
		});
	});

	it('fails on no match only when the option is on', async () => {
		const low = { statusCode: 200, body: { answers: { q: { type: 'noul', noul: 0.1 } } } };
		const [item] = await run({ http: () => low }).result;
		assert.equal(item?.json.matched_rule, null);
		assert.equal(item?.json.gate, true);
		await assert.rejects(run({ http: () => low, params: { options: { failOnNoMatch: true } } }).result, /No rule matched/);
	});

	it('adds the raw response and answers only on request', async () => {
		const [plain] = await run().result;
		assert.equal('raw_response' in (plain?.json ?? {}), false);
		const [full] = await run({ params: { options: { includeRawResponse: true, includeFullAnswers: true } } }).result;
		assert.deepEqual(full?.json.raw_response, okBody);
		assert.ok(full?.json.answers);
	});

	it('leaves out the raw response when the server was not called', async () => {
		const scripts = { version: 1, scripts: [{ question: 'q', else: true, noul: 1 }] };
		const [item] = await run({ params: { answerWith: 'scripts', scripts, options: { includeRawResponse: true } } }).result;
		assert.equal('raw_response' in (item?.json ?? {}), false);
	});

	it('sends a question a script answered when the ruleset needs a fact to open', async () => {
		const strict = {
			...rules,
			open_gate_requires_facts: true,
			rules: [{ id: 'yes', when: { all: [{ question: 'q', gte: 0.5 }, { fact: 'ok', eq: true }] }, action: rules.rules[0]!.action }],
		};
		const scripts = { version: 1, scripts: [{ question: 'q', else: true, noul: 1 }] };
		const { result, calls } = run({ params: { rules: strict, answerWith: 'scripts', scripts, facts: { ok: true } } });
		const [item] = await result;
		assert.equal(calls.length, 1);
		assert.equal(item?.json.matched_rule, 'yes');
	});
});

describe('execute with Continue On Fail', () => {
	it('returns an error and a receipt for the ruleset, and never a gate value', async () => {
		const { result } = run({ continueOnFail: true, http: () => ({ statusCode: 500, body: { detail: 'boom' } }) });
		const [item] = await result;
		assert.match(String(item?.json.error), /failed with HTTP 500/);
		assert.equal('gate' in (item?.json ?? {}), false);
		const receipt = item?.json.receipt as { ruleset_hash: string; error: string };
		assert.equal(receipt.ruleset_hash, rulesetHash(validateRuleset(rules)));
		assert.equal(receipt.error, item?.json.error);
	});

	it('returns only the error when the ruleset cannot be hashed', async () => {
		const [item] = await run({ continueOnFail: true, params: { rules: { version: 2 } } }).result;
		assert.ok(item?.json.error);
		assert.equal('receipt' in (item?.json ?? {}), false);
	});

	it('keeps going after a failed item and pairs each result with its input', async () => {
		const { result } = run({
			items: 3,
			continueOnFail: true,
			params: { state: (index: number) => (index === 1 ? '' : 'text') },
		});
		const items = await result;
		assert.equal(items.length, 3);
		assert.equal(items[0]?.json.matched_rule, 'yes');
		assert.match(String(items[1]?.json.error), /State is required/);
		assert.deepEqual(items[1]?.pairedItem, { item: 1 });
		assert.equal(items[2]?.json.matched_rule, 'yes');
	});
});

describe('DecisionServerApi', () => {
	const credential = new DecisionServerApi();

	it('adds a trimmed bearer token and the normalized base URL', async () => {
		const options = await credential.authenticate({ baseUrl: 'http://server/', apiKey: ' key ' }, { url: '/x', headers: { Accept: 'a' } });
		assert.equal(options.baseURL, 'http://server');
		assert.deepEqual(options.headers, { Accept: 'a', Authorization: 'Bearer key' });
	});

	it('removes a stale Authorization header when no key is set', async () => {
		for (const apiKey of ['', '  ']) {
			const options = await credential.authenticate({ baseUrl: 'http://server', apiKey }, { url: '/x', headers: { Authorization: 'old', authorization: 'old' } });
			assert.deepEqual(options.headers, {});
		}
	});

	it('works with no headers, and rejects a bad base URL', async () => {
		const options = await credential.authenticate({ baseUrl: 'http://server' }, { url: '/x' });
		assert.deepEqual(options.headers, {});
		await assert.rejects(credential.authenticate({ baseUrl: 'nope' }, { url: '/x' }), /not a valid absolute URL/);
	});
});

describe('n8n HTTP shapes', () => {
	it('reads each status field and string statuses', () => {
		assert.equal(readThrownHttpError({ statusCode: 500 })?.statusCode, 500);
		assert.equal(readThrownHttpError({ httpCode: '503' })?.statusCode, 503);
		assert.equal(readThrownHttpError({ status: 600 }), undefined);
		assert.equal(readThrownHttpError({ status: '9999' }), undefined);
		assert.equal(readThrownHttpError({ status: 1.5 }), undefined);
	});

	it('walks cause, error, response, and reason, and survives a cycle', () => {
		assert.equal(readThrownHttpError({ reason: { error: { statusCode: 404 } } })?.statusCode, 404);
		const looped: Record<string, unknown> = { message: 'x' };
		looped.cause = looped;
		assert.equal(readThrownHttpError(looped), undefined);
		assert.equal(readThrownHttpError(null), undefined);
		assert.equal(readThrownHttpError('text'), undefined);
	});

	it('finds the body in response.body, data, and body, and falls back to the error', () => {
		assert.deepEqual(readThrownHttpError({ status: 500, response: { body: 'b' } })?.body, 'b');
		assert.deepEqual(readThrownHttpError({ status: 500, data: 'd' })?.body, 'd');
		assert.deepEqual(readThrownHttpError({ statusCode: 500, body: 'b' })?.body, 'b');
		const bare = { status: 500 };
		assert.equal(readThrownHttpError(bare)?.body, bare);
	});

	it('treats a full response with an unreadable status as a body', () => {
		assert.deepEqual(unwrapN8nResponse({ status: 200, body: 'x' }), { statusCode: 200, body: 'x' });
		const odd = { statusCode: 'nope', body: 'x' };
		assert.deepEqual(unwrapN8nResponse(odd), { statusCode: 200, body: odd });
	});
});
