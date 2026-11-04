import { isPlainObject } from 'decision-matrix-rules';

/**
 * Pulls an HTTP status out of the nested error objects n8n's HTTP helper throws
 * when `ignoreHttpStatusErrors` is unavailable. Returns undefined for network
 * failures so the caller can report them as unreachable.
 */
export function readThrownHttpError(error: unknown): { statusCode: number; body: unknown } | undefined {
	const seen = new Set<unknown>();
	const queue: unknown[] = [error];
	let statusCode: number | undefined;
	let body: unknown;
	while (queue.length > 0) {
		const current = queue.shift();
		if (!current || typeof current !== 'object' || seen.has(current)) continue;
		seen.add(current);
		const record = current as Record<string, unknown>;
		if (statusCode === undefined) {
			const status = readStatus(record);
			if (status !== undefined) statusCode = status;
		}
		if (body === undefined) {
			const extracted = extractErrorBody(record);
			if (extracted !== undefined) body = extracted;
		}
		for (const key of ['cause', 'error', 'response', 'reason'] as const) {
			if (record[key] !== undefined) queue.push(record[key]);
		}
	}
	if (statusCode === undefined) return undefined;
	return { statusCode, body: body ?? error };
}

/** n8n's `returnFullResponse` shape, or the raw body when the helper returned JSON directly. */
export function unwrapN8nResponse(response: unknown): { statusCode: number; body: unknown } {
	if (isPlainObject(response) && 'body' in response && ('statusCode' in response || 'status' in response)) {
		const status = readStatus(response);
		if (status !== undefined) return { statusCode: status, body: response.body };
	}
	return { statusCode: 200, body: response };
}

function readStatus(record: Record<string, unknown>): number | undefined {
	for (const key of ['statusCode', 'status', 'httpCode'] as const) {
		const value = record[key];
		if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) return value;
		if (typeof value === 'string' && /^\d{3}$/.test(value)) {
			const parsed = Number(value);
			if (parsed >= 100 && parsed <= 599) return parsed;
		}
	}
	if (typeof record.message === 'string') {
		const match = /status code (\d{3})/.exec(record.message);
		if (match) return Number(match[1]);
	}
	return undefined;
}

function extractErrorBody(record: Record<string, unknown>): unknown {
	const response = isPlainObject(record.response) ? record.response : undefined;
	if (response) {
		if (response.data !== undefined) return response.data;
		if (response.body !== undefined) return response.body;
	}
	const looksLikeResponse = record.status !== undefined || record.statusCode !== undefined;
	if (looksLikeResponse && record.data !== undefined) return record.data;
	if (looksLikeResponse && record.body !== undefined) return record.body;
	return undefined;
}
