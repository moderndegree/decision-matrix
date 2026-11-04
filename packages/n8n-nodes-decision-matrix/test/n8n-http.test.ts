import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readThrownHttpError, unwrapN8nResponse } from '../nodes/DecisionMatrix/n8n-http';

describe('n8n HTTP helper', () => {
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
