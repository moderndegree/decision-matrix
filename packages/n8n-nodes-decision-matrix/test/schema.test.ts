import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import Ajv2020 from 'ajv/dist/2020';

const ajv = new Ajv2020({ strict: true, strictRequired: false, allowUnionTypes: true, allErrors: true });
const load = (specifier: string) => JSON.parse(readFileSync(require.resolve(specifier), 'utf8'));
const rulesetSchema = ajv.compile(load('decision-matrix-rules/schema/ruleset.schema.json'));
const questionsSchema = ajv.compile(load('decision-matrix-systemone/schema/questions.schema.json'));

const examplesDir = path.join(__dirname, '..', 'examples');

describe('example workflows', () => {
	for (const file of readdirSync(examplesDir).filter((name) => name.endsWith('.workflow.json'))) {
		it(`${file} uses rules and questions that match the schemas`, () => {
			const workflow = JSON.parse(readFileSync(path.join(examplesDir, file), 'utf8')) as {
				nodes: Array<{ name: string; type: string; parameters?: Record<string, unknown> }>;
			};
			for (const node of workflow.nodes.filter((entry) => entry.type === 'n8n-nodes-decision-matrix.decisionMatrix')) {
				const parse = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value);
				const rules = parse(node.parameters?.rules);
				assert.equal(rulesetSchema(rules), true, `${node.name} rules: ${ajv.errorsText(rulesetSchema.errors)}`);
				const questions = parse(node.parameters?.questions ?? '{}');
				if (questions && Object.keys(questions).length > 0) {
					assert.equal(questionsSchema(questions), true, `${node.name} questions: ${ajv.errorsText(questionsSchema.errors)}`);
				}
			}
		});
	}
});
