import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	SystemOneError,
	buildSystemOneBody,
	callSystemOne,
	formatConnectionError,
	interpretHttpResponse,
	normalizeBaseUrl,
	normalizeSystemOneResponse,
	systemOneUrl,
} from 'decision-matrix-systemone';

import { readThrownHttpError, unwrapN8nResponse } from '../nodes/DecisionMatrix/n8n-http';

const sample = {
	model: 'example-1',
	answers: {
		department: {
			type: 'choice',
			choice: 'technical',
			confidence: 0.82,
			probabilities: { technical: 0.85, billing: 0.15 },
		},
		frustration: {
			type: 'score',
			score: 1,
			confidence: 1,
			probabilities: { '0': 0, '1': 1, '2': 0 },
		},
		is_urgent: { type: 'noul', noul: 0.91 },
	},
	usage: { input_tokens: 412, output_tokens: 67 },
};

describe('normalizeSystemOneResponse', () => {
	it('reads the standard answers map and token usage', () => {
		const result = normalizeSystemOneResponse(sample);
		assert.equal(result.answers.department?.choice, 'technical');
		assert.equal(result.answers.frustration?.score, 1);
		assert.equal(result.answers.is_urgent?.noul, 0.91);
		assert.deepEqual(result.usage, { input_tokens: 412, output_tokens: 67 });
		assert.equal(result.rawAnswers, sample.answers);
		assert.equal(result.model, 'example-1');
	});

	it('infers type, accepts numeric strings, aliases, and probability arrays', () => {
		const result = normalizeSystemOneResponse({
			answers: {
				team: {
					choice: 'billing',
					probabilities: [
						{ value: 'billing', probability: '0.7' },
						{ label: 'technical', p: 0.3 },
					],
				},
				urgent: { yes: '0.4' },
				mood: { score: '1.5', confidence_score: '0.25' },
			},
			usage: { prompt_tokens: 10, completion_tokens: '4' },
		});
		assert.equal(result.answers.team?.type, 'choice');
		assert.equal(result.answers.team?.choice, 'billing');
		assert.equal(result.answers.team?.probabilities?.technical, 0.3);
		assert.equal(result.answers.urgent?.type, 'noul');
		assert.equal(result.answers.urgent?.noul, 0.4);
		assert.equal(result.answers.mood?.score, 1.5);
		assert.equal(result.answers.mood?.confidence, 0.25);
		assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 4 });
	});

	it('accepts a boolean noul and a nested data.answers envelope', () => {
		const result = normalizeSystemOneResponse({
			data: {
				answers: { ok: { type: 'predicate', noul: true } },
				usage: { inputTokens: 3, outputTokens: 1 },
			},
		});
		assert.equal(result.answers.ok?.noul, 1);
		assert.deepEqual(result.usage, { input_tokens: 3, output_tokens: 1 });
	});

	it('prefers a top-level answers map over a nested one', () => {
		const result = normalizeSystemOneResponse({
			answers: { ok: { type: 'noul', noul: 0.2 } },
			data: { answers: { ok: { type: 'noul', noul: 0.9 } } },
		});
		assert.equal(result.answers.ok?.noul, 0.2);
	});

	it('derives a missing choice from the highest probability', () => {
		const result = normalizeSystemOneResponse({
			answers: {
				team: { type: 'choice', probabilities: { billing: 0.2, technical: 0.8 } },
			},
		});
		assert.equal(result.answers.team?.choice, 'technical');
	});

	it('explains malformed and unsupported payloads', () => {
		assert.throws(() => normalizeSystemOneResponse('not-json'), /not JSON/);
		assert.throws(() => normalizeSystemOneResponse([]), /JSON object/);
		assert.throws(() => normalizeSystemOneResponse({ model: 'x' }), /no answers object/);
		assert.throws(
			() => normalizeSystemOneResponse({ answers: [{ name: 'ok', probability: 0.5 }] }),
			/answers as an array/,
		);
		assert.throws(
			() => normalizeSystemOneResponse({ answers: { box: { type: 'box' } } }),
			/not supported/,
		);
		assert.throws(
			() => normalizeSystemOneResponse({ answers: { team: { type: 'choice' } } }),
			/no choice value/,
		);
		assert.throws(() => normalizeSystemOneResponse({ answers: { ok: { type: 'noul' } } }), /answers\.ok\.noul/);
	});

	it('parses a JSON string body', () => {
		const result = normalizeSystemOneResponse(JSON.stringify({ answers: { ok: { type: 'noul', noul: 0.5 } } }));
		assert.equal(result.answers.ok?.noul, 0.5);
		assert.equal(result.usage, undefined);
	});
});

describe('request helpers', () => {
	it('normalizes base URLs and builds the system one path', () => {
		assert.equal(normalizeBaseUrl('http://localhost:8000/'), 'http://localhost:8000');
		assert.equal(normalizeBaseUrl(' https://gateway.example/typesafe/ '), 'https://gateway.example/typesafe');
		assert.equal(systemOneUrl(normalizeBaseUrl('http://localhost:8000')), 'http://localhost:8000/v1/systemone');
		assert.throws(() => normalizeBaseUrl(''), /Base URL is missing/);
		assert.throws(() => normalizeBaseUrl('ftp://files.example'), /http or https/);
		assert.throws(() => normalizeBaseUrl('http://user:pass@localhost:8000'), /must not include a username/);
		assert.throws(() => normalizeBaseUrl('not a url'), /not a valid absolute URL/);
	});

	it('omits model until one is set', () => {
		assert.deepEqual(buildSystemOneBody('ping', { ok: { type: 'noul' } }, '  '), {
			state: 'ping',
			questions: { ok: { type: 'noul' } },
		});
		assert.deepEqual(Object.keys(buildSystemOneBody('ping', { ok: { type: 'noul' } })), ['state', 'questions']);
		assert.equal(buildSystemOneBody('ping', {}, 'your-model-id').model, 'your-model-id');
	});

	it('turns non-200 responses into actionable errors', () => {
		const ok = interpretHttpResponse(200, sample, 'http://localhost:8000');
		assert.equal(ok.answers.department?.choice, 'technical');

		assert.throws(
			() => interpretHttpResponse(401, { message: 'missing token' }, 'http://localhost:8000'),
			/401 Unauthorized/,
		);
		assert.throws(() => interpretHttpResponse(404, '', 'https://api.example.com/prefix'), /404/);
		assert.throws(
			() =>
				interpretHttpResponse(
					422,
					{ detail: [{ loc: ['body', 'model'], msg: 'Field required' }] },
					'https://api.example.com',
				),
			/body\.model: Field required/,
		);
		assert.throws(() => interpretHttpResponse(500, { error: 'backend down' }, 'http://localhost:8000'), /HTTP 500/);
		assert.throws(() => interpretHttpResponse(200, { nope: true }, 'http://localhost:8000'), /could not be read/);
	});

	it('describes connection failures without dropping the URL', () => {
		const message = formatConnectionError('http://localhost:8000', Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }));
		assert.match(message, /http:\/\/localhost:8000\/v1\/systemone/);
		assert.match(message, /connection was refused/);
		const timeout = formatConnectionError('http://localhost:8000', { code: 'ETIMEDOUT' });
		assert.match(timeout, /timed out/);
	});

	it('posts the protocol body and reads the normalized answers', async () => {
		const seen: { url?: string; authorization?: string | null; body?: unknown } = {};
		const fetchImpl: typeof fetch = async (url, init) => {
			const headers = new Headers(init?.headers);
			seen.url = String(url);
			seen.authorization = headers.get('authorization');
			seen.body = JSON.parse(String(init?.body));
			return new Response(JSON.stringify(sample), { status: 200 });
		};
		const result = await callSystemOne({
			baseUrl: 'http://localhost:8000/',
			state: 'ping',
			questions: { ok: { type: 'noul', instructions: 'The message is a ping' } },
			apiKey: ' secret ',
			fetch: fetchImpl,
		});
		assert.equal(seen.url, 'http://localhost:8000/v1/systemone');
		assert.equal(seen.authorization, 'Bearer secret');
		assert.deepEqual(seen.body, {
			state: 'ping',
			questions: { ok: { type: 'noul', instructions: 'The message is a ping' } },
		});
		assert.equal(result.answers.department?.choice, 'technical');
	});

	it('omits the Authorization header when no token is set', async () => {
		let authorization: string | null = 'unset';
		const fetchImpl: typeof fetch = async (_url, init) => {
			authorization = new Headers(init?.headers).get('authorization');
			return new Response(JSON.stringify(sample), { status: 200 });
		};
		await callSystemOne({
			baseUrl: 'http://localhost:8000',
			state: 'ping',
			questions: { ok: { type: 'noul', instructions: 'ping' } },
			apiKey: '   ',
			fetch: fetchImpl,
		});
		assert.equal(authorization, null);
	});

	it('reads status codes from thrown HTTP helper errors and from full responses', () => {
		const thrown = readThrownHttpError({
			message: 'Request failed with status code 422',
			cause: { response: { status: 422, data: { detail: 'model required' } } },
		});
		assert.deepEqual(thrown, { statusCode: 422, body: { detail: 'model required' } });
		assert.equal(readThrownHttpError({ code: 'ECONNREFUSED', message: 'refused' }), undefined);
		assert.deepEqual(unwrapN8nResponse({ statusCode: 201, body: { answers: {} }, headers: {} }), {
			statusCode: 201,
			body: { answers: {} },
		});
		assert.deepEqual(unwrapN8nResponse({ answers: { ok: 1 } }), {
			statusCode: 200,
			body: { answers: { ok: 1 } },
		});
	});
});

describe('SystemOneError', () => {
	it('uses the SystemOneError name', () => {
		const error = new SystemOneError('down');
		assert.equal(error.name, 'SystemOneError');
	});
});
