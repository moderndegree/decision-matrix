import {
	NodeApiError,
	NodeOperationError,
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';

import { buildItemOutput, noMatchMessage } from './output';
import {
	readFactsInput,
	readOptions,
	readQuestions,
	readRulesInput,
	readState,
	readThresholdOverrides,
} from './parameters';
import {
	GENERIC_TRIAGE_RULES,
	RulesError,
	assertFactsResolve,
	assertThresholdsResolve,
	decideFromFacts,
	evaluateRules,
} from 'decision-matrix-rules';
import {
	SystemOneError,
	buildSystemOneBody,
	formatConnectionError,
	interpretHttpResponse,
	normalizeBaseUrl,
	systemOneUrl,
} from 'decision-matrix-systemone';

import { readThrownHttpError, unwrapN8nResponse } from './n8n-http';

const CREDENTIAL_TYPE = 'decisionServerApi';

/**
 * Calls any System One / Jev-compatible server, then applies a declarative
 * ruleset to the typed answers. The rules engine is pure. This method is the
 * only I/O in the node; other hosts can call `callSystemOne` instead.
 */
export class DecisionMatrix implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Decision Matrix',
		name: 'decisionMatrix',
		icon: { light: 'file:decisionMatrix.svg', dark: 'file:decisionMatrix.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["questionSet"]}}',
		description:
			'Run a multidimensional decision matrix against any System One / Jev-compatible server and apply declarative rules.',
		defaults: {
			name: 'Decision Matrix',
		},
		inputs: ['main'],
		outputs: ['main'],
		usableAsTool: true,
		credentials: [
			{
				name: CREDENTIAL_TYPE,
				required: true,
			},
		],
		properties: [
			{
				displayName: 'State',
				name: 'state',
				type: 'string',
				typeOptions: { rows: 6 },
				required: true,
				default: '',
				placeholder: 'Customer wrote: I was charged twice and need a refund today.',
				description:
					'Context to evaluate. A plain string, or a JSON object or array. Supports expressions, so the value can come from an earlier node.',
			},
			{
				displayName: 'Question Set',
				name: 'questionSet',
				type: 'options',
				default: 'generic',
				description:
					'Preset questions sent as the System One questions object. Choose Custom JSON to supply your own. Preset ids are documented in the package README.',
				options: [
					{
						name: 'Generic Triage',
						value: 'generic',
						description: 'category (choice), urgency (score), needs_human (noul)',
					},
					{
						name: 'SDLC Change',
						value: 'sdlc',
						description: 'change_type (choice), risk (score), needs_design and ready_to_implement (noul)',
					},
					{
						name: 'Support / Ops',
						value: 'support',
						description: 'severity (choice), customer_impact (score), page_oncall (noul)',
					},
					{
						name: 'Custom JSON',
						value: 'custom',
						description: 'Send the Questions JSON below. An empty value uses generic triage.',
					},
				],
			},
			{
				displayName:
					'Generic triage asks category (choice: billing, technical, account, other), urgency (score 0–3), and needs_human (noul). The default rules route on those ids.',
				name: 'genericHint',
				type: 'notice',
				default: '',
				displayOptions: { show: { questionSet: ['generic'] } },
			},
			{
				displayName:
					'SDLC asks change_type (choice), risk (score 0–3), needs_design (noul), and ready_to_implement (noul). Paste the SDLC ruleset from the README or examples/sdlc-change.workflow.json.',
				name: 'sdlcHint',
				type: 'notice',
				default: '',
				displayOptions: { show: { questionSet: ['sdlc'] } },
			},
			{
				displayName:
					'Support / ops asks severity (choice: sev1–sev4), customer_impact (score 0–3), and page_oncall (noul). Pair it with the support ruleset in the README.',
				name: 'supportHint',
				type: 'notice',
				default: '',
				displayOptions: { show: { questionSet: ['support'] } },
			},
			{
				displayName: 'Questions',
				name: 'questions',
				type: 'json',
				default: '{}',
				description:
					'Optional System One questions object, keyed by the ids rules will reference. When this object contains at least one question, it replaces the selected question set. Leave it empty to send the selected preset. Each entry needs type "choice", "noul", or "score", plus instructions and any criteria the server expects.',
			},
			{
				displayName: 'Rules',
				name: 'rules',
				type: 'json',
				required: true,
				default: JSON.stringify(GENERIC_TRIAGE_RULES, null, 2),
				description:
					'Version 1 ruleset. First matching rule wins. Supports expressions, so a previous node can supply the JSON. See the README for the schema, threshold names, and templates such as {{answers.category.choice}}.',
			},
			{
				displayName: 'Facts',
				name: 'facts',
				type: 'json',
				default: '{}',
				description:
					'Optional JSON object of values this workflow verified itself, for example from your identity provider, HR system, or git. Rules test them with fact predicates such as {"fact": "grant.privileged", "eq": true}. Facts are not sent to the decision server. Build them from systems you trust, never from the request body. When facts alone decide, the server is not called.',
			},
			{
				displayName: 'Thresholds',
				name: 'thresholds',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true, sortable: true },
				placeholder: 'Add Threshold',
				default: {},
				description:
					'Optional overrides for named thresholds in the ruleset. A row named high_confidence replaces rules.thresholds.high_confidence for this item. Names use letters, digits, and underscores.',
				options: [
					{
						displayName: 'Threshold',
						name: 'threshold',
						values: [
							{
								displayName: 'Name',
								name: 'name',
								type: 'string',
								default: '',
								placeholder: 'high_confidence',
							},
							{
								displayName: 'Value',
								name: 'value',
								type: 'number',
								default: 0,
								typeOptions: { numberPrecision: 4 },
							},
						],
					},
				],
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Timeout (ms)',
						name: 'timeout',
						type: 'number',
						default: 60000,
						description: 'How long to wait for POST /v1/systemone before failing the item',
						typeOptions: { minValue: 1 },
					},
					{
						displayName: 'Include Full Answers',
						name: 'includeFullAnswers',
						type: 'boolean',
						default: true,
						description: 'Whether to copy the server answers map onto the output item. On by default.',
					},
					{
						displayName: 'Fail on No Matching Rule',
						name: 'failOnNoMatch',
						type: 'boolean',
						default: false,
						description:
							'Whether to throw when no rule matches. Off by default, which returns default_action with matched_rule null.',
					},
					{
						displayName: 'Include Raw Response',
						name: 'includeRawResponse',
						type: 'boolean',
						default: false,
						description: 'Whether to attach the full decision-server JSON body as raw_response for debugging',
					},
					{
						displayName: 'Model',
						name: 'model',
						type: 'string',
						default: '',
						placeholder: 'your-model-id',
						description:
							'Optional. Added to the request body only when set. Leave empty when the server chooses a model itself. This node does not default to any vendor or model id.',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const output: INodeExecutionData[] = [];

		// One credential for the whole run. authenticate() on that credential
		// adds the bearer token only when an API key is present and normalizes
		// the base URL. Every request goes through httpRequestWithAuthentication.
		let baseUrl: string;
		try {
			const credentials = await this.getCredentials(CREDENTIAL_TYPE);
			baseUrl = normalizeBaseUrl(credentials.baseUrl);
		} catch (error) {
			throw asNodeError(this, error);
		}

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				output.push({
					json: await evaluateItem(this, itemIndex, baseUrl),
					pairedItem: { item: itemIndex },
				});
			} catch (error) {
				if (this.continueOnFail()) {
					output.push({
						json: { error: error instanceof Error ? error.message : String(error) },
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				throw asNodeError(this, error, itemIndex);
			}
		}

		return [output];
	}
}

/**
 * Per-item pipeline:
 * 1. Read state, questions, rules, facts, thresholds, and options (expressions already resolved).
 * 2. Validate the ruleset and the facts before any network call so a typo does not spend a request.
 * 3. If leading facts-only rules decide, return that decision without calling the server.
 * 4. POST {baseUrl}/v1/systemone with { state, questions, model? }. Facts are not sent.
 * 5. Normalize the answers, then let the pure engine pick the first matching rule.
 * 6. Shape the routing item. Fail closed only when Fail on no matching rule is on.
 */
async function evaluateItem(
	ctx: IExecuteFunctions,
	itemIndex: number,
	baseUrl: string,
): Promise<IDataObject> {
	const state = readState(ctx.getNodeParameter('state', itemIndex));
	const questionSet = ctx.getNodeParameter('questionSet', itemIndex, 'generic');
	// Non-empty Questions replaces the preset. Empty keeps the preset.
	const questions = readQuestions(questionSet, ctx.getNodeParameter('questions', itemIndex, {}));
	const rules = readRulesInput(ctx.getNodeParameter('rules', itemIndex));
	const thresholdOverrides = readThresholdOverrides(ctx.getNodeParameter('thresholds', itemIndex, {}));
	const facts = readFactsInput(ctx.getNodeParameter('facts', itemIndex, '{}'));
	const options = readOptions(ctx.getNodeParameter('options', itemIndex, {}));

	// Fail here, before the HTTP call, when the rules JSON is structurally wrong,
	// a threshold name would not resolve, or a referenced fact is missing.
	assertThresholdsResolve(rules, thresholdOverrides);
	assertFactsResolve(rules, facts);

	const fromFacts = decideFromFacts(rules, facts, thresholdOverrides);
	if (fromFacts) {
		return buildItemOutput(fromFacts, { answers: {}, rawAnswers: {} }, undefined, {
			includeFullAnswers: options.includeFullAnswers,
			includeRawResponse: false,
		}) as IDataObject;
	}

	const body = buildSystemOneBody(state, questions, options.model);
	const response = await callDecisionServer(ctx, baseUrl, body, options.timeout);
	const http = unwrapN8nResponse(response);
	const systemOne = interpretHttpResponse(http.statusCode, http.body, baseUrl);
	const evaluation = evaluateRules(rules, systemOne.answers, thresholdOverrides, facts);

	if (options.failOnNoMatch && evaluation.matched_rule === null) {
		throw new RulesError(noMatchMessage(evaluation));
	}

	return buildItemOutput(evaluation, systemOne, http.body, {
		includeFullAnswers: options.includeFullAnswers,
		includeRawResponse: options.includeRawResponse,
	}) as IDataObject;
}

async function callDecisionServer(
	ctx: IExecuteFunctions,
	baseUrl: string,
	body: Record<string, unknown>,
	timeout: number,
): Promise<unknown> {
	try {
		// The helper types `this` as the execution context, not the helpers bag.
		return await ctx.helpers.httpRequestWithAuthentication.call(ctx, CREDENTIAL_TYPE, {
			method: 'POST',
			url: systemOneUrl(baseUrl),
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body,
			json: true,
			timeout,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
		});
	} catch (error) {
		// SystemOneError is already a clear message (bad URL, bad JSON, and so on).
		if (error instanceof SystemOneError || error instanceof RulesError) throw error;
		// Some n8n versions throw on non-2xx instead of honoring ignoreHttpStatusErrors.
		const httpError = readThrownHttpError(error);
		if (httpError) {
			return {
				statusCode: httpError.statusCode,
				body: httpError.body,
			};
		}
		throw new SystemOneError(formatConnectionError(baseUrl, error));
	}
}

function asNodeError(ctx: IExecuteFunctions, error: unknown, itemIndex?: number): Error {
	if (error instanceof NodeOperationError || error instanceof NodeApiError) return error;
	const wrapped = error instanceof Error ? error : new Error(String(error));
	return new NodeOperationError(ctx.getNode(), wrapped, {
		itemIndex,
	});
}
