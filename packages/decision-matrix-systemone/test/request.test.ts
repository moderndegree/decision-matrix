import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	SystemOneError,
	callSystemOne,
	formatConnectionError,
	interpretHttpResponse,
	normalizeBaseUrl,
	normalizeSystemOneResponse,
	readState,
	validateQuestions,
} from '../src';

const base = 'http://server';

function rejects(run: () => unknown, message: RegExp) {
	assert.throws(run, (error: unknown) => {
		assert.ok(error instanceof SystemOneError, `expected SystemOneError, got ${String(error)}`);
		assert.match(error.message, message);
		return true;
	});
}

describe('normalizeBaseUrl rejects', () => {
	const cases: Array<[string, unknown, RegExp]> = [
		['a missing value', undefined, /Base URL is missing/],
		['a blank value', '  ', /Base URL is missing/],
		['a relative URL', 'localhost', /is not a valid absolute URL/],
		['another scheme', 'ftp://host', /must use http or https\. Received "ftp"/],
		['credentials', 'http://user:secret@host', /must not include a username or password/],
		['a query string', 'http://host?a=1', /must not include a query string or hash/],
		['a hash', 'http://host#a', /must not include a query string or hash/],
	];
	for (const [name, value, message] of cases) it(name, () => rejects(() => normalizeBaseUrl(value), message));

	it('does not echo a password back in the error', () => {
		assert.throws(() => normalizeBaseUrl('http://user:secret@host'), (error: Error) => !error.message.includes('secret'));
	});
});

describe('interpretHttpResponse', () => {
	it('refuses an unreadable status', () => {
		rejects(() => interpretHttpResponse(Number.NaN, {}, base), /unreadable HTTP status/);
		rejects(() => interpretHttpResponse(99, {}, base), /unreadable HTTP status/);
		rejects(() => interpretHttpResponse(1.5, {}, base), /unreadable HTTP status/);
	});

	it('treats a 1xx or 3xx as a failure, not as answers', () => {
		const answers = { answers: { q: { type: 'noul', noul: 1 } } };
		rejects(() => interpretHttpResponse(101, answers, base), /returned HTTP 101/);
		rejects(() => interpretHttpResponse(302, answers, base), /returned HTTP 302/);
	});

	it('explains each status class', () => {
		const statuses: Array<[number, RegExp]> = [
			[401, /401 Unauthorized.*bearer token/],
			[403, /403 Forbidden/],
			[404, /returned 404.*appends \/v1\/systemone/],
			[408, /timed out \(HTTP 408\)/],
			[504, /timed out \(HTTP 504\)/],
			[400, /rejected the request with HTTP 400/],
			[422, /rejected the request with HTTP 422/],
			[500, /failed with HTTP 500/],
			[418, /returned HTTP 418/],
		];
		for (const [status, message] of statuses) rejects(() => interpretHttpResponse(status, undefined, base), message);
	});

	it('quotes detail, message, and error bodies', () => {
		rejects(() => interpretHttpResponse(500, { detail: ' boom ' }, base), /Response: boom$/);
		rejects(() => interpretHttpResponse(500, { message: 'msg' }, base), /Response: msg$/);
		rejects(() => interpretHttpResponse(500, { error: 'err' }, base), /Response: err$/);
	});

	it('flattens a validation error list', () => {
		const detail = [{ loc: ['body', 'model'], msg: 'required' }, 'plain', { msg: 'only message' }, { loc: ['x'] }, 7, {}];
		rejects(() => interpretHttpResponse(422, { detail }, base), /Response: body\.model: required; plain; only message; x$/);
	});

	it('falls back to the raw body, and drops a body it cannot print', () => {
		rejects(() => interpretHttpResponse(500, { detail: [7] }, base), /Response: \{"detail":\[7\]\}$/);
		rejects(() => interpretHttpResponse(500, 'bad   gateway\n', base), /Response: bad gateway$/);
		const circular: unknown[] = [];
		circular.push(circular);
		assert.throws(() => interpretHttpResponse(500, circular, base), (error: Error) => !error.message.includes('Response:'));
		assert.throws(() => interpretHttpResponse(500, '', base), (error: Error) => !error.message.includes('Response:'));
	});

	it('cuts a long body to 500 characters', () => {
		assert.throws(
			() => interpretHttpResponse(500, 'x'.repeat(600), base),
			(error: Error) => error.message.endsWith(`${'x'.repeat(500)}…`),
		);
	});

	it('names the server when a 200 body cannot be read', () => {
		rejects(() => interpretHttpResponse(200, { answers: 1 }, base), /returned HTTP 200, but the body could not be read/);
	});
});

describe('formatConnectionError', () => {
	const cases: Array<[unknown, RegExp]> = [
		[Object.assign(new Error('x'), { name: 'TimeoutError' }), /connection timed out/],
		[Object.assign(new Error('x'), { name: 'AbortError' }), /connection timed out/],
		[{ code: 'ECONNREFUSED' }, /connection was refused/],
		[{ code: 'ENOTFOUND' }, /host name could not be resolved/],
		[{ code: 'EAI_AGAIN' }, /host name could not be resolved/],
		[{ code: 'EHOSTUNREACH' }, /network could not reach the host/],
		[{ code: 'ENETUNREACH' }, /network could not reach the host/],
		[{ code: 'ETIMEDOUT' }, /connection timed out/],
		[{ code: 'ECONNABORTED' }, /connection timed out/],
		[new Error('socket timeout'), /connection timed out/],
		[{ code: 'ECONNRESET' }, /connection was reset/],
		[{ code: 'EPROTO' }, /network error was EPROTO/],
		[Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), /connection was refused/],
		[new Error('plain failure'), /plain failure\./],
		[new Error('ends with a stop.'), /ends with a stop\. Check/],
		['text failure', /text failure\./],
		[undefined, /request failed before a response arrived/],
	];
	for (const [error, message] of cases) {
		it(`reads ${String((error as { code?: string })?.code ?? (error as Error)?.message ?? error)}`, () => {
			const text = formatConnectionError(base, error);
			assert.match(text, message);
			assert.match(text, /http:\/\/server\/v1\/systemone/);
		});
	}

	it('survives a cycle in the cause chain', () => {
		const error = new Error('looped') as Error & { cause?: unknown };
		error.cause = error;
		assert.match(formatConnectionError(base, error), /looped\./);
	});
});

describe('callSystemOne', () => {
	const ok = async () => new Response(JSON.stringify({ answers: { q: { type: 'noul', noul: 1 } } }), { status: 200 });
	const call = (extra: Record<string, unknown>) => callSystemOne({ baseUrl: base, state: 's', questions: {}, fetch: ok, ...extra });

	it('refuses a bad timeout before calling the server', async () => {
		let calls = 0;
		const counted = async () => {
			calls += 1;
			return ok();
		};
		for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			await assert.rejects(call({ timeoutMs, fetch: counted }), /timeoutMs must be a finite number/);
		}
		assert.equal(calls, 0);
	});

	it('reports a missing fetch', async () => {
		const original = globalThis.fetch;
		(globalThis as { fetch?: unknown }).fetch = undefined;
		try {
			await assert.rejects(call({ fetch: undefined }), /No fetch implementation is available/);
		} finally {
			globalThis.fetch = original;
		}
	});

	it('wraps a rejected fetch as a connection error', async () => {
		const refused = async () => {
			throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
		};
		await assert.rejects(call({ fetch: refused }), (error: Error) => error instanceof SystemOneError && /connection was refused/.test(error.message));
	});

	it('keeps a non-JSON error body as text and reports an empty 200', async () => {
		await assert.rejects(call({ fetch: async () => new Response('<html>nope</html>', { status: 502 }) }), /<html>nope<\/html>/);
		await assert.rejects(call({ fetch: async () => new Response('', { status: 200 }) }), /returned an empty body/);
		await assert.rejects(call({ fetch: async () => new Response('not json', { status: 200 }) }), /not JSON/);
	});

	it('trims the API key and sends no header for a blank one', async () => {
		const seen: Array<Record<string, string>> = [];
		const capture: typeof fetch = async (_url, init) => {
			seen.push(init?.headers as Record<string, string>);
			return ok();
		};
		await call({ fetch: capture, apiKey: '  token  ' });
		await call({ fetch: capture, apiKey: '   ' });
		assert.equal(seen[0]?.Authorization, 'Bearer token');
		assert.equal(seen[1]?.Authorization, undefined);
	});
});

describe('normalizeSystemOneResponse rejects', () => {
	const one = (answer: unknown) => ({ answers: { q: answer } });
	const cases: Array<[string, unknown, RegExp]> = [
		['a list of answers', { answers: [] }, /returned answers as an array/],
		['a body with no answers', {}, /has no answers object/],
		['an empty string body', '  ', /returned an empty body/],
		['a string that is not JSON', 'nope', /not JSON/],
		['a JSON string holding a list', '[1]', /Expected a JSON object with an answers map/],
		['a number body', 7, /Expected a JSON object with an answers map/],
		['an answer that is not an object', one('yes'), /answers\.q must be an object/],
		['an answer with no shape', one({ reason: 'x' }), /answers\.q has no type/],
		['a choice of the wrong type', one({ type: 'choice', choice: {} }), /answers\.q\.choice must be a non-empty string/],
		['a choice with nothing to derive from', one({ type: 'choice' }), /no choice value and no probabilities/],
		['a choice with empty probabilities', one({ type: 'choice', probabilities: {} }), /no choice value and no probabilities/],
		['a probability entry that is not an object', one({ choice: 'a', probabilities: [1] }), /probabilities\[0\] must be an object/],
		['a probability entry with no label', one({ choice: 'a', probabilities: [{ probability: 1 }] }), /probabilities\[0\] is missing a value/],
		['probabilities of the wrong shape', one({ choice: 'a', probabilities: 'x' }), /must be an object or an array/],
		['a confidence above 1', one({ choice: 'a', confidence: 1.5 }), /confidence must be a finite number from 0 to 1/],
		['usage that is not an object', { ...one({ noul: 1 }), usage: 'x' }, /usage must be an object of token counts/],
		['a token count that is not a number', { ...one({ noul: 1 }), usage: { input_tokens: 'many' } }, /usage\.input_tokens must be a number/],
	];
	for (const [name, body, message] of cases) it(name, () => rejects(() => normalizeSystemOneResponse(body), message));
});

describe('normalizeSystemOneResponse accepts', () => {
	it('detects the type from each value field', () => {
		const result = normalizeSystemOneResponse({
			answers: { a: { selected: 'x' }, b: { yes: 0.2 }, c: { score: 1 }, d: { type: 'choice', choice: 3 } },
		});
		assert.equal(result.answers.a?.type, 'choice');
		assert.equal(result.answers.a?.choice, 'x');
		assert.equal(result.answers.b?.type, 'noul');
		assert.equal(result.answers.c?.type, 'score');
		assert.equal(result.answers.d?.choice, '3');
	});

	it('reads confidence_score and the camelCase usage names', () => {
		const result = normalizeSystemOneResponse({
			answers: { q: { choice: 'a', confidence_score: 0.5 } },
			usage: { promptTokens: 3, completionTokens: 4 },
		});
		assert.equal(result.answers.q?.confidence, 0.5);
		assert.deepEqual(result.usage, { input_tokens: 3, output_tokens: 4 });
	});

	it('omits usage that has no counts', () => {
		assert.equal(normalizeSystemOneResponse({ answers: {}, usage: {} }).usage, undefined);
		assert.equal(normalizeSystemOneResponse({ answers: {}, usage: null }).usage, undefined);
	});
});

describe('readState', () => {
	it('passes objects, lists, and plain text through', () => {
		const object = { a: 1 };
		assert.equal(readState(object), object);
		assert.deepEqual(readState(['a']), ['a']);
		assert.equal(readState('  plain text  '), '  plain text  ');
	});

	it('parses a string that starts like JSON', () => {
		assert.deepEqual(readState(' {"a":1} '), { a: 1 });
		assert.deepEqual(readState('[1]'), [1]);
	});

	it('rejects blank text and other types', () => {
		rejects(() => readState('  '), /State is required/);
		rejects(() => readState(7), /State must be a string, object, or array/);
		rejects(() => readState(null), /State must be a string, object, or array/);
	});

	// Documented, and it fails closed, but a plain ticket title in brackets cannot be sent as text.
	it('refuses text that only looks like JSON', () => {
		rejects(() => readState('[URGENT] database down'), /looks like JSON but could not be parsed/);
		rejects(() => readState('{not json'), /looks like JSON but could not be parsed/);
	});
});

describe('validateQuestions rejects', () => {
	const noul = { type: 'noul', instructions: 'Is it?' };
	const cases: Array<[string, unknown, RegExp]> = [
		['a list', [], /Questions must be a JSON object keyed by question id/],
		['no questions', {}, /at least one question/],
		['only $schema', { $schema: 'x' }, /at least one question/],
		['a $schema that is not a string', { $schema: 1, q: noul }, /questions\.\$schema must be a string/],
		['an id with spaces', { 'a b': noul }, /Question id "a b" must be a non-empty string without spaces/],
		['a question that is not an object', { q: 'x' }, /questions\.q must be an object/],
		['an unknown type', { q: { ...noul, type: 'text' } }, /questions\.q\.type must be/],
		['blank instructions', { q: { ...noul, instructions: ' ' } }, /instructions must say what the model is asked/],
	];
	for (const [name, value, message] of cases) it(name, () => rejects(() => validateQuestions(value), message));

	it('drops $schema from what is sent', () => {
		assert.deepEqual(validateQuestions({ $schema: 'x', q: noul }), { q: noul });
	});
});
