import { isPlainObject } from 'decision-matrix-rules';

import { SystemOneError } from './errors';
import { normalizeSystemOneResponse, type SystemOneResult } from './normalize';

/** Credential base URL → absolute `POST /v1/systemone` URL. */
export function systemOneUrl(baseUrl: string): string {
	return `${baseUrl}/v1/systemone`;
}

/**
 * Accepts an absolute http(s) URL. A path prefix is preserved so a gateway
 * can mount the protocol at a subpath. Trailing slashes are removed.
 * Callers append `/v1/systemone` themselves via `systemOneUrl`.
 */
export function normalizeBaseUrl(value: unknown): string {
	if (typeof value !== 'string' || value.trim() === '') {
		throw new SystemOneError(
			'Base URL is missing. Set it to the server root, for example http://localhost:8000 or https://api.example.com.',
		);
	}
	const trimmed = value.trim();
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new SystemOneError(
			`Base URL "${trimmed}" is not a valid absolute URL. Use a form such as http://localhost:8000 or https://api.example.com.`,
		);
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new SystemOneError(`Base URL must use http or https. Received "${url.protocol.replace(':', '')}".`);
	}
	if (url.username || url.password) {
		throw new SystemOneError(
			'Base URL must not include a username or password. Pass a bearer token separately when the server requires one.',
		);
	}
	if (url.search || url.hash) {
		throw new SystemOneError('Base URL must not include a query string or hash.');
	}
	const path = url.pathname.replace(/\/+$/, '');
	return `${url.origin}${path}`;
}

/** Body for `POST /v1/systemone`. `model` is sent only when the caller set one. */
export function buildSystemOneBody(
	state: unknown,
	questions: Record<string, unknown>,
	model?: string,
): Record<string, unknown> {
	const body: Record<string, unknown> = { state, questions };
	const trimmed = model?.trim();
	if (trimmed) body.model = trimmed;
	return body;
}

/**
 * Turns an HTTP result into a normalized System One payload.
 * Non-2xx responses become errors that name the status and a short body.
 */
export function interpretHttpResponse(statusCode: number, body: unknown, baseUrl: string): SystemOneResult {
	if (!Number.isInteger(statusCode) || statusCode < 100) {
		throw new SystemOneError(
			`Decision server at ${systemOneUrl(baseUrl)} returned an unreadable HTTP status (${String(statusCode)}).`,
		);
	}
	if (statusCode < 200 || statusCode >= 300) {
		throw new SystemOneError(formatStatusError(statusCode, body, baseUrl));
	}
	try {
		return normalizeSystemOneResponse(body);
	} catch (error) {
		if (error instanceof SystemOneError) {
			throw new SystemOneError(
				`Decision server at ${systemOneUrl(baseUrl)} returned HTTP ${statusCode}, but the body could not be read. ${error.message}`,
			);
		}
		throw error;
	}
}

export function formatConnectionError(baseUrl: string, error: unknown): string {
	const url = systemOneUrl(baseUrl);
	return `Could not reach the decision server at ${url}. ${connectionDetail(error)} Check the base URL, confirm the server is running, and confirm this process can open a connection to that host.`;
}

export interface SystemOneCallOptions {
	/** Server root. A path prefix is kept. `/v1/systemone` is appended. */
	baseUrl: string;
	state: unknown;
	questions: Record<string, unknown>;
	/** Sent only when non-empty. Servers that choose a model should leave this unset. */
	model?: string;
	/** Sent as `Authorization: Bearer` only when non-empty. */
	apiKey?: string;
	timeoutMs?: number;
	/** Defaults to the global `fetch`. Tests pass a stub. */
	fetch?: typeof fetch;
}

/**
 * `POST /v1/systemone` for hosts that do not already have an HTTP stack.
 * n8n uses the pure helpers and its own request helper so credentials and
 * proxy settings stay inside n8n.
 */
export async function callSystemOne(options: SystemOneCallOptions): Promise<SystemOneResult> {
	const baseUrl = normalizeBaseUrl(options.baseUrl);
	const url = systemOneUrl(baseUrl);
	const headers: Record<string, string> = {
		Accept: 'application/json',
		'Content-Type': 'application/json',
	};
	const apiKey = options.apiKey?.trim();
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	const timeoutMs = options.timeoutMs ?? 60_000;
	if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
		throw new SystemOneError('timeoutMs must be a finite number of milliseconds, at least 1.');
	}
	const fetchImpl = options.fetch ?? globalThis.fetch;
	if (typeof fetchImpl !== 'function') {
		throw new SystemOneError('No fetch implementation is available. Pass options.fetch.');
	}
	let response: Response;
	try {
		response = await fetchImpl(url, {
			method: 'POST',
			headers,
			body: JSON.stringify(buildSystemOneBody(options.state, options.questions, options.model)),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		throw new SystemOneError(formatConnectionError(baseUrl, error));
	}
	const text = await response.text();
	let body: unknown = text;
	if (text.trim() !== '') {
		try {
			body = JSON.parse(text) as unknown;
		} catch {
			body = text;
		}
	}
	return interpretHttpResponse(response.status, body, baseUrl);
}

function formatStatusError(statusCode: number, body: unknown, baseUrl: string): string {
	const url = systemOneUrl(baseUrl);
	const detail = formatBodyDetail(body);
	const suffix = detail ? ` Response: ${detail}` : '';
	if (statusCode === 401) {
		return `Decision server returned 401 Unauthorized for POST ${url}. This server expects a bearer token in the Authorization header.${suffix}`;
	}
	if (statusCode === 403) {
		return `Decision server returned 403 Forbidden for POST ${url}. The bearer token was rejected or is not allowed to call this server.${suffix}`;
	}
	if (statusCode === 404) {
		return `Decision server returned 404 for POST ${url}. Set the base URL to the server root (the client appends /v1/systemone). A path prefix is fine when a gateway mounts the protocol under one.${suffix}`;
	}
	if (statusCode === 408 || statusCode === 504) {
		return `Decision server timed out (HTTP ${statusCode}) calling POST ${url}. Raise the request timeout, or check the server.${suffix}`;
	}
	if (statusCode === 400 || statusCode === 422) {
		return `Decision server rejected the request with HTTP ${statusCode} for POST ${url}. Check state and questions. On servers that require a model, set the model field.${suffix}`;
	}
	if (statusCode >= 500) {
		return `Decision server failed with HTTP ${statusCode} for POST ${url}.${suffix}`;
	}
	return `Decision server returned HTTP ${statusCode} for POST ${url}.${suffix}`;
}

function formatBodyDetail(body: unknown): string {
	const structured = formatStructuredDetail(body);
	const text = structured ?? snippet(body);
	return text;
}

function formatStructuredDetail(body: unknown): string | undefined {
	if (!isPlainObject(body)) return undefined;
	const detail = body.detail ?? body.message ?? body.error;
	if (typeof detail === 'string' && detail.trim() !== '') return truncate(detail.trim());
	if (Array.isArray(detail)) {
		const parts = detail
			.map((item) => {
				if (typeof item === 'string') return item;
				if (!isPlainObject(item)) return '';
				const loc = Array.isArray(item.loc) ? item.loc.map(String).join('.') : '';
				const msg = typeof item.msg === 'string' ? item.msg : '';
				return [loc, msg].filter(Boolean).join(': ');
			})
			.filter(Boolean);
		if (parts.length > 0) return truncate(parts.join('; '));
	}
	return undefined;
}

function snippet(body: unknown): string {
	if (body === undefined || body === null || body === '') return '';
	if (typeof body === 'string') return truncate(body.replace(/\s+/g, ' ').trim());
	try {
		return truncate(JSON.stringify(body));
	} catch {
		return '';
	}
}

function truncate(text: string): string {
	const collapsed = text.replace(/\s+/g, ' ').trim();
	if (collapsed.length <= 500) return collapsed;
	return `${collapsed.slice(0, 500)}…`;
}

function connectionDetail(error: unknown): string {
	if (isTimeoutError(error)) return 'The connection timed out.';
	const code = readCode(error);
	const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
	if (code === 'ECONNREFUSED') return 'The connection was refused.';
	if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'The host name could not be resolved.';
	if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'The network could not reach the host.';
	if (code === 'ETIMEDOUT' || code === 'ECONNABORTED' || /timeout/i.test(message)) return 'The connection timed out.';
	if (code === 'ECONNRESET') return 'The connection was reset.';
	if (code) return `The network error was ${code}.`;
	if (message) return message.endsWith('.') ? message : `${message}.`;
	return 'The request failed before a response arrived.';
}

function isTimeoutError(error: unknown): boolean {
	if (!error || typeof error !== 'object') return false;
	const name = (error as { name?: unknown }).name;
	return name === 'TimeoutError' || name === 'AbortError';
}

function readCode(error: unknown): string | undefined {
	const seen = new Set<unknown>();
	const queue: unknown[] = [error];
	while (queue.length > 0) {
		const current = queue.shift();
		if (!current || typeof current !== 'object' || seen.has(current)) continue;
		seen.add(current);
		const record = current as Record<string, unknown>;
		if (typeof record.code === 'string' && record.code !== '') return record.code;
		if (record.cause) queue.push(record.cause);
	}
	return undefined;
}
