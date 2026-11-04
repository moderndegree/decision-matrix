import type {
	ICredentialDataDecryptedObject,
	ICredentialTestRequest,
	ICredentialType,
	IHttpRequestOptions,
	INodeProperties,
} from 'n8n-workflow';

import { normalizeBaseUrl } from 'decision-matrix-systemone';

/**
 * Points the Decision Matrix node at any server that speaks POST /v1/systemone.
 * The base URL and API key come only from this credential. API Key is optional:
 * leave it empty for a server that does not check a token. When it is set,
 * requests send Authorization: Bearer. An empty value does not send that header.
 */
export class DecisionServerApi implements ICredentialType {
	name = 'decisionServerApi';

	displayName = 'Decision Server API';

	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			required: true,
			default: 'http://localhost:8000',
			placeholder: 'http://localhost:8000',
			description:
				'Root of a System One / Jev-compatible server, without /v1/systemone. A path prefix is kept for gateways that mount the protocol under one. A trailing slash is removed.',
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description:
				'Optional. When set, requests send a Bearer token in the Authorization header. Leave empty for a local server that does not check a token.',
		},
	];

	async authenticate(
		credentials: ICredentialDataDecryptedObject,
		requestOptions: IHttpRequestOptions,
	): Promise<IHttpRequestOptions> {
		const baseURL = normalizeBaseUrl(credentials.baseUrl);
		const apiKey = typeof credentials.apiKey === 'string' ? credentials.apiKey.trim() : '';
		const headers = { ...(requestOptions.headers ?? {}) };
		if (apiKey) {
			headers.Authorization = `Bearer ${apiKey}`;
		} else {
			delete headers.Authorization;
			delete headers.authorization;
		}
		return {
			...requestOptions,
			baseURL,
			headers,
		};
	}

	/**
	 * Sends one tiny noul. Servers that accept { state, questions } and choose
	 * their own model return 200. Servers that require a `model` field return
	 * a validation error here; set Options → Model on the node for real runs.
	 * A connection failure means the Base URL is unreachable.
	 */
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/v1/systemone',
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: {
				state: 'connectivity check',
				questions: {
					ok: {
						type: 'noul',
						instructions: 'The message is a connectivity check',
					},
				},
			},
		},
	};
}
