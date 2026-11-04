import {
	RulesError,
	decideFromFacts,
	evaluateRules,
	isPlainObject,
	traceRules,
	validateRuleset,
	type AnswerView,
	type EvaluationResult,
	type EvaluationTrace,
	type TraceNode,
} from 'decision-matrix-rules';

import { readAnswers } from './decide';

/**
 * Policy test cases. Each case is facts and saved answers plus the decision
 * the ruleset must make. No server is called, so cases run anywhere,
 * including CI jobs that have no secrets.
 *
 * `defaults` holds the facts, answers, and thresholds most cases share. A
 * case lists only what differs: its facts merge over the default facts
 * (nested objects merge too), its answers replace default answers by
 * question id, and its thresholds replace default thresholds by name.
 */

export interface CaseExpectation {
	matched_rule?: string | null;
	action?: string;
	target?: string;
	reason?: string;
	gate?: boolean;
	/** True when the leading facts-only rules must decide without a server call. */
	from_facts?: boolean;
	/** Substring of the error the case must raise, for example a missing fact. */
	error?: string;
}

export interface PolicyCase {
	name: string;
	facts?: Record<string, unknown>;
	answers?: Record<string, AnswerView>;
	thresholds?: Record<string, number>;
	expect: CaseExpectation;
}

export interface CaseResult {
	name: string;
	passed: boolean;
	failures: string[];
	decision?: EvaluationResult;
	from_facts: boolean;
	error?: string;
	/** Present when the case failed and the rules could be traced. */
	trace?: EvaluationTrace;
}

export interface CaseRun {
	results: CaseResult[];
	/** Rule ids in order, so a report can show which rules no case reached. */
	rules: string[];
	/** Rule ids (and null for the default action) that at least one case matched. */
	covered: Set<string | null>;
}

const FILE_KEYS = new Set(['version', 'defaults', 'cases']);
const DEFAULT_KEYS = new Set(['facts', 'answers', 'thresholds']);
const CASE_KEYS = new Set(['name', 'facts', 'answers', 'thresholds', 'expect']);
const EXPECT_KEYS = new Set(['matched_rule', 'action', 'target', 'reason', 'gate', 'from_facts', 'error']);

export function readCases(input: unknown, source = 'cases'): PolicyCase[] {
	if (!isPlainObject(input) || input.version !== 1 || !Array.isArray(input.cases)) {
		throw new Error(`${source} must be { "version": 1, "cases": [ ... ] }.`);
	}
	for (const key of Object.keys(input)) {
		if (!FILE_KEYS.has(key)) throw new Error(`${source} has unknown key "${key}". Expected: ${[...FILE_KEYS].join(', ')}.`);
	}
	const defaults = input.defaults ?? {};
	if (!isPlainObject(defaults)) throw new Error(`${source} defaults must be an object.`);
	for (const key of Object.keys(defaults)) {
		if (!DEFAULT_KEYS.has(key)) throw new Error(`${source} defaults has unknown key "${key}". Expected: ${[...DEFAULT_KEYS].join(', ')}.`);
		if (!isPlainObject(defaults[key])) throw new Error(`${source} defaults.${key} must be an object.`);
	}
	const names = new Set<string>();
	return input.cases.map((entry, index) => {
		const path = `${source} cases[${index}]`;
		if (!isPlainObject(entry)) throw new Error(`${path} must be an object.`);
		for (const key of Object.keys(entry)) {
			if (!CASE_KEYS.has(key)) throw new Error(`${path} has unknown key "${key}". Expected: ${[...CASE_KEYS].join(', ')}.`);
		}
		if (typeof entry.name !== 'string' || entry.name.trim() === '') throw new Error(`${path}.name must be a non-empty string.`);
		if (names.has(entry.name)) throw new Error(`${path}.name duplicates "${entry.name}".`);
		names.add(entry.name);
		for (const key of ['facts', 'answers', 'thresholds'] as const) {
			if (entry[key] !== undefined && !isPlainObject(entry[key])) throw new Error(`${path}.${key} must be an object.`);
		}
		const expect = entry.expect;
		if (!isPlainObject(expect) || Object.keys(expect).length === 0) {
			throw new Error(`${path}.expect must name at least one of: ${[...EXPECT_KEYS].join(', ')}.`);
		}
		for (const key of Object.keys(expect)) {
			if (!EXPECT_KEYS.has(key)) throw new Error(`${path}.expect has unknown key "${key}". Expected: ${[...EXPECT_KEYS].join(', ')}.`);
		}
		const facts = mergeFacts(defaults.facts, entry.facts);
		const answers = defaults.answers || entry.answers ? { ...(defaults.answers as object), ...(entry.answers as object) } : undefined;
		const thresholds =
			defaults.thresholds || entry.thresholds ? { ...(defaults.thresholds as object), ...(entry.thresholds as object) } : undefined;
		return {
			name: entry.name,
			...(facts !== undefined ? { facts } : {}),
			...(answers !== undefined ? { answers: readAnswers(answers) } : {}),
			...(thresholds !== undefined ? { thresholds: thresholds as Record<string, number> } : {}),
			expect: expect as CaseExpectation,
		};
	});
}

function mergeFacts(base: unknown, override: unknown): Record<string, unknown> | undefined {
	if (base === undefined && override === undefined) return undefined;
	const merged: Record<string, unknown> = { ...(base as Record<string, unknown> | undefined) };
	for (const [key, value] of Object.entries((override as Record<string, unknown> | undefined) ?? {})) {
		merged[key] = isPlainObject(value) && isPlainObject(merged[key]) ? mergeFacts(merged[key], value) : value;
	}
	return merged;
}

/** Runs every case. A ruleset that does not validate throws before any case runs. */
export function runCases(rules: unknown, cases: PolicyCase[], thresholds?: Record<string, number>): CaseRun {
	const ruleset = validateRuleset(rules);
	const covered = new Set<string | null>();
	const results = cases.map((testCase) => {
		const overrides = { ...(thresholds ?? {}), ...(testCase.thresholds ?? {}) };
		const answers = testCase.answers ?? {};
		let decision: EvaluationResult | undefined;
		let fromFacts = false;
		let error: string | undefined;
		try {
			const early = decideFromFacts(rules, testCase.facts, overrides);
			fromFacts = early !== null;
			decision = early ?? evaluateRules(rules, answers, overrides, testCase.facts);
		} catch (caught) {
			if (!(caught instanceof RulesError)) throw caught;
			error = caught.message;
		}
		if (decision) covered.add(decision.matched_rule);

		const failures = compare(testCase.expect, decision, fromFacts, error);
		const result: CaseResult = {
			name: testCase.name,
			passed: failures.length === 0,
			failures,
			from_facts: fromFacts,
			...(decision ? { decision } : {}),
			...(error !== undefined ? { error } : {}),
		};
		if (!result.passed) {
			try {
				result.trace = traceRules(rules, answers, overrides, testCase.facts);
			} catch {
				// The failure message already says what went wrong.
			}
		}
		return result;
	});
	return { results, rules: ruleset.rules.map((rule) => rule.id), covered };
}

function compare(
	expect: CaseExpectation,
	decision: EvaluationResult | undefined,
	fromFacts: boolean,
	error: string | undefined,
): string[] {
	if (expect.error !== undefined) {
		if (error === undefined) return [`expected an error containing ${JSON.stringify(expect.error)}, but the rules decided ${describe(decision)}`];
		return error.includes(expect.error) ? [] : [`expected an error containing ${JSON.stringify(expect.error)}, got: ${error}`];
	}
	if (error !== undefined || !decision) return [`evaluation failed: ${error ?? 'no decision'}`];
	const failures: string[] = [];
	for (const key of ['matched_rule', 'action', 'target', 'reason', 'gate'] as const) {
		if (expect[key] !== undefined && expect[key] !== decision[key]) {
			failures.push(`${key}: expected ${JSON.stringify(expect[key])}, got ${JSON.stringify(decision[key])}`);
		}
	}
	if (expect.from_facts !== undefined && expect.from_facts !== fromFacts) {
		failures.push(
			expect.from_facts
				? 'from_facts: expected facts alone to decide, but the model would be asked'
				: 'from_facts: expected the model to be asked, but facts alone decided',
		);
	}
	return failures;
}

function describe(decision: EvaluationResult | undefined): string {
	if (!decision) return 'nothing';
	return `${decision.action} (${decision.matched_rule ?? 'default'})`;
}

export function formatCaseRun(run: CaseRun, source: string): string {
	const lines: string[] = [];
	const failed = run.results.filter((result) => !result.passed);
	lines.push(`${source}: ${run.results.length} case${run.results.length === 1 ? '' : 's'}`);
	for (const result of run.results) {
		lines.push(`  ${result.passed ? '✓' : '✗'} ${result.name}`);
		if (result.passed) continue;
		for (const failure of result.failures) lines.push(`      ${failure}`);
		if (result.trace) lines.push(...formatWhy(result.trace).map((line) => `      ${line}`));
	}
	lines.push('');
	lines.push(`${run.results.length - failed.length} passed, ${failed.length} failed`);
	const untested = uncovered(run);
	lines.push(untested.length === 0 ? `Every rule is matched by a case.` : `Rules no case matches: ${untested.join(', ')}`);
	return `${lines.join('\n')}\n`;
}

export function uncovered(run: CaseRun): string[] {
	return run.rules.filter((id) => !run.covered.has(id));
}

/** One line per rule, in order, up to the rule that won. */
export function formatWhy(trace: EvaluationTrace): string[] {
	const lines = ['why:'];
	const width = Math.max(...trace.rules.map((rule) => rule.id.length), 7);
	const winner = trace.decision?.matched_rule;
	for (const rule of trace.rules) {
		const label = rule.id.padEnd(width);
		if (rule.error) lines.push(`  ${label}  error  ${rule.error}`);
		else if (rule.matched) lines.push(`  ${label}  match${rule.id === winner ? '' : '  (an earlier rule won)'}`);
		else lines.push(`  ${label}  no     ${rule.when ? missed(rule.when).slice(0, 3).join('; ') : ''}`);
		if (rule.id === winner) return lines;
	}
	lines.push(`  ${'default'.padEnd(width)}  match`);
	return lines;
}

/** The leaf checks that kept a node from matching. */
function missed(node: TraceNode): string[] {
	if (node.kind === 'all') return node.children.filter((child) => !child.matched).flatMap(missed);
	if (node.kind === 'any') {
		const parts = node.children.flatMap(missed);
		return parts.length > 1 ? [`none of: ${parts.join(' | ')}`] : parts;
	}
	const subject = node.kind === 'fact' ? `fact ${node.fact}` : node.question;
	return node.checks
		.filter((check) => !check.matched)
		.map((check) => {
			const expected = check.threshold ? `${check.threshold} (${String(check.expected)})` : JSON.stringify(check.expected);
			const actual = check.op.startsWith('confidence') && node.kind === 'question' ? `confidence ${node.confidence}` : JSON.stringify(node.value);
			return `${subject} is ${actual}, needs ${check.op} ${expected}`;
		});
}
