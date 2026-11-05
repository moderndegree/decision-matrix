import { compileFlatRows, isPlainObject, projectTable, validateRuleset, type FlatRow, type Ruleset, type TableRow } from 'decision-matrix-rules';

/**
 * Reads a flat-row file and returns a ruleset. Unary cells only. An operator
 * outside the closed set fails the file. Nested groups are not accepted.
 */
const FILE_KEYS = new Set([
	'$schema',
	'version',
	'default_action',
	'thresholds',
	'open_gate_requires_facts',
	'fact_schema',
	'owner',
	'ticket',
	'agreements',
	'rows',
]);

export function importFlatRules(input: unknown): unknown {
	if (!isPlainObject(input) || input.version !== 1 || !Array.isArray(input.rows)) {
		throw new Error('import file must be { "version": 1, "rows": [ ... ], "default_action": { ... } }.');
	}
	for (const key of Object.keys(input)) {
		if (!FILE_KEYS.has(key)) throw new Error(`import file has unknown key "${key}". Expected: ${[...FILE_KEYS].join(', ')}.`);
	}
	if (!isPlainObject(input.default_action)) throw new Error('import file default_action must be an object.');
	const rules = compileFlatRows(input.rows as FlatRow[]);
	const built: Record<string, unknown> = { version: 1, default_action: input.default_action, rules };
	for (const key of ['thresholds', 'open_gate_requires_facts', 'fact_schema', 'owner', 'ticket', 'agreements', '$schema'] as const) {
		if (input[key] !== undefined) built[key] = input[key];
	}
	validateRuleset(built);
	return built;
}

export function formatTable(rules: unknown): string {
	const table = projectTable(validateRuleset(rules));
	const lines: string[] = [];
	for (const row of table.rows) lines.push(...formatRow(row));
	const action = table.default_action;
	lines.push(`default  ${action.type}  ${action.target}  ${action.gate ? 'holds' : 'opens'}`);
	lines.push('  footer, when no rule matches');
	return `${lines.join('\n')}\n`;
}

export function tableJson(rules: unknown): { rows: TableRow[]; default_action: Ruleset['default_action'] } {
	return projectTable(validateRuleset(rules));
}

function formatRow(row: TableRow): string[] {
	return [`${row.id}  ${row.action}  ${row.target}  ${row.gate ? 'holds' : 'opens'}`, `  ${row.when}`];
}
