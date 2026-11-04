import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { RulesError, isPlainObject, lintRuleset, type LintFinding, type LintQuestion } from 'decision-matrix-rules';
import { SCRIPT_PRESETS, SystemOneError } from 'decision-matrix-systemone';

import { formatCaseRun, readCases, runCases, uncovered } from './cases';
import { decide, EXIT_ERROR, EXIT_GATE, EXIT_OK } from './decide';
import { diffPolicies, formatPolicyDiff } from './diff';
import { DEFAULT_PRESET, POLICY_PRESETS } from './presets';

export interface CliIO {
	argv: string[];
	env: NodeJS.ProcessEnv;
	/** True when stdin is a terminal, so the command must not wait on it. */
	stdinIsTTY: boolean;
	readStdin: () => Promise<string>;
	readFile: (filePath: string) => Promise<string>;
	stdout: (text: string) => void;
	stderr: (text: string) => void;
}

const HELP = `decision-matrix — decide, test, and check decision-matrix policies

Commands:
  decide   Classify one event and print one action
  test     Run policy test cases against a ruleset, without a server
  check    Lint a ruleset without running it
  diff     Explain what a ruleset change does to the policy

decision-matrix decide — classify one event and print one action

The event is the state. A decision server or a local script answers the
questions. The ruleset picks one action. The process prints that decision
as JSON. An automated step should proceed only when gate is false.

Usage:
  decision-matrix decide [options]
  decision-matrix decide --answers <file> [options]

Options:
  --preset <name>       Built-in questions and rules. Default: attack-triage.
                        Also: generic, sdlc, support, ci-change, access-review.
  --questions <file>    Questions JSON. Replaces the preset questions.
  --rules <file>        Ruleset JSON. Replaces the preset rules.
  --scripts <file>      Scripts JSON. Answers questions locally, in the same
                        shape as the server. A question it answers is not sent.
                        When every question is answered, no server is called.
  --local               Use the preset's built-in scripts. generic, sdlc, and
                        support have them. attack-triage, ci-change, and
                        access-review do not.
  --state <file>        Event JSON or text. Otherwise the event is read from stdin.
  --facts <file>        JSON object of values this caller verified. Fact
                        predicates in the rules read it. It is not sent to
                        the server. When facts alone decide, the server is
                        not called and answers is empty.
  --server <url>        Decision server root. Or set DECISION_SERVER_URL.
                        The client appends /v1/systemone.
  --api-key <token>     Bearer token. Or set DECISION_SERVER_API_KEY.
  --model <name>        Sent only when set. Or set DECISION_SERVER_MODEL.
  --timeout <ms>        HTTP timeout in milliseconds. Default 60000.
  --threshold <name=n>  Replace one threshold. Repeat for several.
  --answers <file>      Evaluate this answers file and skip the server.
                        A System One response or a bare answers map both work.
  --fail-on-gate        Exit 2 when gate is true. Exit 0 when gate is false.
  -h, --help            Show this help.

Exit codes:
  0  decision printed, and gate is false or --fail-on-gate was not set
  1  the event, rules, or server call failed
  2  decision printed and gate is true, because --fail-on-gate was set

Examples:
  decision-matrix decide --preset generic --local --state ticket.txt
  decision-matrix decide --server http://localhost:8000 --state event.json
  decision-matrix decide --answers answers.json --fail-on-gate
  decision-matrix decide --preset ci-change --facts facts.json --state pr.json --fail-on-gate
  decision-matrix decide --rules policy.json --threshold high_confidence=0.9 --server http://localhost:8000 < event.json

decision-matrix test — run policy test cases

Each case gives facts and saved answers, and the decision the rules must
make. No server is called, so this runs in CI jobs that have no secrets.

Usage:
  decision-matrix test --cases <file> (--rules <file> | --preset <name>) [options]

Options:
  --cases <file>        { "version": 1, "cases": [ ... ] }. Required.
  --rules, --preset     The ruleset under test.
  --threshold <name=n>  Replace one threshold for every case.
  --require-coverage    Also fail when no case matches some rule.
  --json                Print the results as JSON.

Exit codes:
  0  every case passed (and every rule is covered, with --require-coverage)
  1  a case failed, or the cases or rules could not be read

decision-matrix check — lint a ruleset without running it

Reports rules the model alone can open, rules an earlier rule always beats,
choice labels a question does not offer, operators that do not fit a
question's type, and unused questions and thresholds.

Usage:
  decision-matrix check (--rules <file> | --preset <name>) [options]

Options:
  --rules, --preset     The ruleset to check.
  --questions <file>    Check question ids, types, and labels against these.
                        With --preset and no --questions, the preset's are used.
  --threshold <name=n>  Replace one threshold.
  --strict              Fail on warnings as well as errors.
  --json                Print the findings as JSON.

Exit codes:
  0  no errors (and no warnings, with --strict)
  1  errors, or warnings with --strict

decision-matrix diff — explain what a ruleset change does

Classifies each change by its effect, not its text: loosens (holds less or
opens the gate more), tightens, or needs review. Threshold changes are judged
through the rules that use them. With --cases, also lists every case whose
decision changes.

Usage:
  decision-matrix diff --from <file> --to <file> [options]

Options:
  --from <file>         The ruleset before the change.
  --to <file>           The ruleset after the change.
  --cases <file>        Show which cases now get a different decision.
  --format <name>       text (default) or markdown, for a PR comment.
  --json                Print the diff as JSON.
  --fail-on-loosen      Exit 2 when the change loosens the policy, when a
                        direction cannot be determined, or when a case that
                        held now opens the gate.

Exit codes:
  0  diff printed
  1  a file could not be read, or a ruleset is invalid
  2  diff printed and it loosens the policy, because --fail-on-loosen was set

Starter files:
  packages/decision-matrix-cli/examples/attack-triage.questions.json
  packages/decision-matrix-cli/examples/attack-triage.rules.json
  packages/decision-matrix-cli/examples/ci-change.questions.json
  packages/decision-matrix-cli/examples/ci-change.rules.json
  packages/decision-matrix-cli/examples/ci-change.cases.json
  packages/decision-matrix-cli/examples/github/
`;

const CLI_OPTIONS = {
	questions: { type: 'string' },
	rules: { type: 'string' },
	preset: { type: 'string' },
	answers: { type: 'string' },
	server: { type: 'string' },
	'api-key': { type: 'string' },
	model: { type: 'string' },
	timeout: { type: 'string' },
	threshold: { type: 'string', multiple: true },
	'fail-on-gate': { type: 'boolean' },
	state: { type: 'string' },
	facts: { type: 'string' },
	scripts: { type: 'string' },
	local: { type: 'boolean' },
	cases: { type: 'string' },
	'require-coverage': { type: 'boolean' },
	strict: { type: 'boolean' },
	json: { type: 'boolean' },
	from: { type: 'string' },
	to: { type: 'string' },
	format: { type: 'string' },
	'fail-on-loosen': { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
} as const;

type OptionName = keyof typeof CLI_OPTIONS;

const COMMAND_OPTIONS: Record<string, ReadonlySet<OptionName>> = {
	decide: new Set<OptionName>([
		'questions', 'rules', 'preset', 'answers', 'server', 'api-key', 'model',
		'timeout', 'threshold', 'fail-on-gate', 'state', 'facts', 'scripts', 'local', 'help',
	]),
	test: new Set<OptionName>(['rules', 'preset', 'cases', 'threshold', 'require-coverage', 'json', 'help']),
	check: new Set<OptionName>(['rules', 'preset', 'questions', 'threshold', 'strict', 'json', 'help']),
	diff: new Set<OptionName>(['from', 'to', 'cases', 'format', 'json', 'fail-on-loosen', 'help']),
};

function parseArgv(argv: string[]) {
	return parseArgs({
		args: argv,
		options: CLI_OPTIONS,
		allowPositionals: true,
		strict: true,
	});
}

/** Parse arguments, run one command, and return the process exit code. */
export async function run(io: CliIO): Promise<number> {
	let parsed: ReturnType<typeof parseArgv>;
	try {
		parsed = parseArgv(io.argv);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		io.stderr(`${message}\nRun decision-matrix --help.\n`);
		return EXIT_ERROR;
	}
	const { values, positionals } = parsed;

	if (values.help === true) {
		io.stdout(HELP);
		return EXIT_OK;
	}

	const command = positionals[0];
	if (command === undefined) {
		io.stderr(`A command is required.\n${HELP}`);
		return EXIT_ERROR;
	}
	const allowed = COMMAND_OPTIONS[command];
	if (!allowed) {
		io.stderr(`Unknown command "${command}".\n${HELP}`);
		return EXIT_ERROR;
	}
	if (positionals.length > 1) {
		io.stderr(`${command} does not take positional arguments. Received ${positionals.slice(1).join(' ')}.\n`);
		return EXIT_ERROR;
	}
	const unused = (Object.keys(values) as OptionName[]).filter((name) => values[name] !== undefined && !allowed.has(name));
	if (unused.length > 0) {
		io.stderr(`${command} does not use ${unused.map((name) => `--${name}`).join(', ')}.\n`);
		return EXIT_ERROR;
	}

	try {
		if (command === 'test') return await runTest(io, values);
		if (command === 'check') return await runCheck(io, values);
		if (command === 'diff') return await runDiff(io, values);
		const presetName = typeof values.preset === 'string' ? values.preset : DEFAULT_PRESET;
		const preset = presetFor(presetName);
		const questions = values.questions ? parseJson(await io.readFile(values.questions), values.questions) : preset.questions;
		const rules = values.rules ? parseJson(await io.readFile(values.rules), values.rules) : preset.rules;
		const answers = values.answers ? parseJson(await io.readFile(values.answers), values.answers) : undefined;
		const scripts = await loadScripts(io, values, presetName);
		const facts = values.facts ? readFacts(parseJson(await io.readFile(values.facts), values.facts), values.facts) : undefined;
		const state = await loadState(io, values.state, answers !== undefined);
		const serverUrl = nonempty(values.server) ?? nonempty(io.env.DECISION_SERVER_URL);
		const result = await decide({
			state,
			questions,
			rules,
			answers,
			scripts,
			thresholds: readThresholds(values.threshold),
			facts,
			failOnGate: values['fail-on-gate'] === true,
			server:
				answers !== undefined
					? undefined
					: {
							baseUrl: serverUrl ?? '',
							apiKey: nonempty(values['api-key']) ?? nonempty(io.env.DECISION_SERVER_API_KEY),
							model: nonempty(values.model) ?? nonempty(io.env.DECISION_SERVER_MODEL),
							timeoutMs: readTimeout(values.timeout),
						},
		});
		io.stdout(`${JSON.stringify(result.record, null, 2)}\n`);
		return result.exitCode;
	} catch (error) {
		io.stderr(`${errorMessage(error)}\n`);
		return EXIT_ERROR;
	}
}

type Values = ReturnType<typeof parseArgv>['values'];

/** test and check need an explicit ruleset. Falling back to a default preset would test the wrong policy. */
async function loadRules(io: CliIO, values: Values, command: string): Promise<unknown> {
	if (values.rules) return parseJson(await io.readFile(values.rules), values.rules);
	if (values.preset) return presetFor(values.preset).rules;
	throw new Error(`${command} needs --rules <file> or --preset <name>.`);
}

function presetFor(name: string) {
	const preset = POLICY_PRESETS[name];
	if (!preset) {
		throw new Error(`Unknown preset "${name}". Known presets: ${Object.keys(POLICY_PRESETS).join(', ')}.`);
	}
	return preset;
}

async function loadScripts(io: CliIO, values: Values, presetName: string): Promise<unknown> {
	if (values.local === true && values.scripts !== undefined) {
		throw new Error('Pass --local or --scripts <file>, not both.');
	}
	if (values.answers !== undefined && (values.local === true || values.scripts !== undefined)) {
		throw new Error('Pass --answers or scripts, not both. --local selects a preset script.');
	}
	if (typeof values.scripts === 'string') return parseJson(await io.readFile(values.scripts), values.scripts);
	if (values.local !== true) return undefined;
	if (presetName === 'generic' || presetName === 'sdlc' || presetName === 'support') return SCRIPT_PRESETS[presetName];
	throw new Error(
		`Preset "${presetName}" has no local scripts. A model or --answers has to answer it. Presets with scripts: generic, sdlc, support.`,
	);
}

async function runTest(io: CliIO, values: Values): Promise<number> {
	if (!values.cases) throw new Error('test needs --cases <file>.');
	const rules = await loadRules(io, values, 'test');
	const cases = readCases(parseJson(await io.readFile(values.cases), values.cases), values.cases);
	const result = runCases(rules, cases, readThresholds(values.threshold));
	const untested = uncovered(result);
	const failed = result.results.some((entry) => !entry.passed) || (values['require-coverage'] === true && untested.length > 0);
	if (values.json === true) {
		io.stdout(`${JSON.stringify({ passed: !failed, results: result.results, uncovered: untested }, null, 2)}\n`);
	} else {
		io.stdout(formatCaseRun(result, values.cases));
		if (values['require-coverage'] === true && untested.length > 0) {
			io.stdout('--require-coverage is set, so uncovered rules fail the run.\n');
		}
	}
	return failed ? EXIT_ERROR : EXIT_OK;
}

async function runCheck(io: CliIO, values: Values): Promise<number> {
	const rules = await loadRules(io, values, 'check');
	let questions: Record<string, LintQuestion> | undefined;
	if (values.questions) {
		const parsed = parseJson(await io.readFile(values.questions), values.questions);
		if (!isPlainObject(parsed)) throw new Error(`${values.questions} must contain a JSON object of questions.`);
		questions = parsed as Record<string, LintQuestion>;
	} else if (values.preset) {
		questions = presetFor(values.preset).questions as Record<string, LintQuestion>;
	}
	const findings = lintRuleset(rules, { questions, thresholdOverrides: readThresholds(values.threshold) });
	const errors = findings.filter((finding) => finding.severity === 'error').length;
	const warnings = findings.filter((finding) => finding.severity === 'warning').length;
	const failed = errors > 0 || (values.strict === true && warnings > 0);
	if (values.json === true) {
		io.stdout(`${JSON.stringify({ passed: !failed, findings }, null, 2)}\n`);
	} else {
		io.stdout(formatFindings(findings, questions !== undefined));
	}
	return failed ? EXIT_ERROR : EXIT_OK;
}

async function runDiff(io: CliIO, values: Values): Promise<number> {
	if (!values.from || !values.to) throw new Error('diff needs --from <file> and --to <file>.');
	const format = values.format ?? 'text';
	if (format !== 'text' && format !== 'markdown') {
		throw new Error(`--format must be text or markdown. Received ${JSON.stringify(format)}.`);
	}
	const from = parseJson(await io.readFile(values.from), values.from);
	const to = parseJson(await io.readFile(values.to), values.to);
	const cases = values.cases ? readCases(parseJson(await io.readFile(values.cases), values.cases), values.cases) : [];
	const diff = diffPolicies(from, to, cases);
	if (values.json === true) io.stdout(`${JSON.stringify(diff, null, 2)}\n`);
	else io.stdout(formatPolicyDiff(diff, values.from, values.to, format === 'markdown'));
	return values['fail-on-loosen'] === true && diff.loosens ? EXIT_GATE : EXIT_OK;
}

function formatFindings(findings: LintFinding[], checkedQuestions: boolean): string {
	const lines = findings.map(
		(finding) => `${finding.severity.padEnd(7)} ${finding.code}${finding.rule ? ` [${finding.rule}]` : ''}  ${finding.message}`,
	);
	const count = (severity: string) => findings.filter((finding) => finding.severity === severity).length;
	lines.push(`${count('error')} errors, ${count('warning')} warnings, ${count('info')} info`);
	if (!checkedQuestions) lines.push('Questions were not checked. Pass --questions or --preset to check ids, types, and labels.');
	return `${lines.join('\n')}\n`;
}

async function loadState(io: CliIO, statePath: string | undefined, answersMode: boolean): Promise<unknown> {
	if (statePath !== undefined) return io.readFile(statePath);
	if (answersMode || io.stdinIsTTY) return undefined;
	const text = await io.readStdin();
	if (text.trim() === '') return undefined;
	return text;
}

function parseJson(text: string, filePath: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${filePath} is not valid JSON. ${message}`);
	}
}

function readFacts(value: unknown, filePath: string): Record<string, unknown> {
	if (!isPlainObject(value)) {
		throw new Error(`${filePath} must contain a JSON object of facts.`);
	}
	return value;
}

function readThresholds(entries: string[] | undefined): Record<string, number> | undefined {
	if (entries === undefined || entries.length === 0) return undefined;
	const overrides: Record<string, number> = {};
	for (const entry of entries) {
		const eq = entry.indexOf('=');
		if (eq <= 0) {
			throw new Error(`--threshold must look like name=number. Received ${JSON.stringify(entry)}.`);
		}
		const name = entry.slice(0, eq).trim();
		const raw = entry.slice(eq + 1).trim();
		const value = Number(raw);
		if (!Number.isFinite(value)) {
			throw new Error(`--threshold ${name} must be a finite number. Received ${JSON.stringify(raw)}.`);
		}
		overrides[name] = value;
	}
	return overrides;
}

function readTimeout(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!/^[1-9]\d*$/.test(value)) {
		throw new Error('--timeout must be a whole number of milliseconds, at least 1.');
	}
	return Number(value);
}

function nonempty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function errorMessage(error: unknown): string {
	if (error instanceof RulesError || error instanceof SystemOneError || error instanceof Error) return error.message;
	return String(error);
}

export async function readFileFromDisk(filePath: string): Promise<string> {
	try {
		return await readFile(filePath, 'utf8');
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not read ${filePath}. ${message}`);
	}
}
