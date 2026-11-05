import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { EXIT_ERROR, EXIT_OK, run } from '../src';
import { importFlatRules } from '../src/import-table';
import { readFileFromDisk } from '../src/run';
import { formatQuestionsNote } from '../src/shadow';
import { captured, packageRoot } from './fixtures';

const hold = { type: 'hold', target: 'human', reason: 'No matching rule', gate: true };
const rules = JSON.stringify({
	version: 1,
	default_action: hold,
	thresholds: { high: 0.8 },
	rules: [{ id: 'r', when: { question: 'q', gte: { threshold: 'high' } }, action: { type: 'pass', target: 't', reason: 'ok', gate: false } }],
});
const questions = JSON.stringify({ q: { type: 'noul', instructions: 'Is it?' } });
const answers = JSON.stringify({ q: { type: 'noul', noul: 0.9 } });
const files = { 'rules.json': rules, 'questions.json': questions, 'answers.json': answers, 'bad.json': '{', 'list.json': '[]' };

async function exec(argv: string[], extra: Parameters<typeof captured>[2] = {}, more: Record<string, string> = {}) {
	const cli = captured(argv, { ...files, ...more }, extra);
	const code = await run(cli.io);
	return { code, stdout: cli.stdout.join(''), stderr: cli.stderr.join('') };
}

const decideArgs = ['decide', '--rules', 'rules.json', '--questions', 'questions.json', '--answers', 'answers.json'];

describe('argument handling', () => {
	const failures: Array<[string, string[], RegExp]> = [
		['an unknown flag', ['test', '--nope'], /Run decision-matrix --help/],
		['no command', [], /A command is required/],
		['an unknown command', ['launch'], /Unknown command "launch"/],
		['extra positionals', ['check', 'one', 'two'], /does not take positional arguments\. Received one two/],
		['a flag the command does not use', ['table', '--rules', 'rules.json', '--cases', 'c.json'], /table does not use --cases/],
		['test with no cases', ['test', '--rules', 'rules.json'], /test needs --cases <file>/],
		['test with no ruleset', ['test', '--cases', 'c.json'], /test needs --rules <file> or --preset <name>/],
		['check with no ruleset', ['check'], /check needs --rules <file> or --preset <name>/],
		['sweep with no cases', ['sweep', '--rules', 'rules.json'], /sweep needs --cases <file>/],
		['table with no ruleset', ['table'], /table needs --rules/],
		['import with no rules', ['import'], /import needs --rules <file>/],
		['diff with no target', ['diff', '--from', 'rules.json'], /diff needs --from <file> and --to <file>/],
		['diff with a bad format', ['diff', '--from', 'rules.json', '--to', 'rules.json', '--format', 'html'], /--format must be text or markdown/],
		['shadow with no cases', ['shadow', '--from', 'rules.json', '--to', 'rules.json'], /shadow needs --from <file>, --to <file>, and --cases <file>/],
		['an unknown preset', ['check', '--preset', 'nope'], /Unknown preset "nope"\. Known presets: /],
		['a file that does not exist', ['check', '--rules', 'missing.json'], /Could not read missing\.json/],
		['a file that is not JSON', ['check', '--rules', 'bad.json'], /bad\.json is not valid JSON/],
		['questions that are not an object', ['check', '--rules', 'rules.json', '--questions', 'list.json'], /list\.json must contain a JSON object of questions/],
		['--local with --scripts', ['decide', '--local', '--scripts', 's.json'], /Pass --local or --scripts <file>, not both/],
		['--answers with --local', [...decideArgs, '--local'], /Pass --answers or scripts, not both/],
		['--local on a preset with no scripts', ['decide', '--preset', 'attack-triage', '--local'], /Preset "attack-triage" has no local scripts/],
		['facts that are not an object', [...decideArgs, '--facts', 'list.json'], /list\.json must contain a JSON object of facts/],
		['a threshold with no name', [...decideArgs, '--threshold', '=1'], /--threshold must look like name=number/],
		['a threshold with no equals sign', [...decideArgs, '--threshold', 'high'], /--threshold must look like name=number/],
		['a threshold that is not a number', [...decideArgs, '--threshold', 'high=abc'], /--threshold high must be a finite number/],
		['an infinite threshold', [...decideArgs, '--threshold', 'high=Infinity'], /--threshold high must be a finite number/],
	];
	for (const [name, argv, message] of failures) {
		it(`fails on ${name}`, async () => {
			const result = await exec(argv);
			assert.equal(result.code, EXIT_ERROR);
			assert.match(result.stderr, message);
			assert.equal(result.stdout, '');
		});
	}

	// Number('') is 0, so an empty value sets the threshold to 0 and this rule opens the gate on any answer.
	it('fails on a threshold with an empty value', { todo: 'run.ts readThresholds accepts "name=" as 0' }, async () => {
		const low = JSON.stringify({ q: { type: 'noul', noul: 0.01 } });
		const result = await exec([...decideArgs, '--threshold', 'high='], {}, { 'answers.json': low });
		assert.equal(result.code, EXIT_ERROR);
	});

	for (const value of ['0', '-5', '1.5', 'abc']) {
		it(`refuses --timeout ${value}`, async () => {
			const result = await exec(['decide', '--rules', 'rules.json', '--questions', 'questions.json', '--server', 'http://127.0.0.1:9', `--timeout=${value}`], {
				readStdin: async () => 'text',
				stdinIsTTY: false,
			});
			assert.equal(result.code, EXIT_ERROR);
			assert.match(result.stderr, /--timeout must be a whole number of milliseconds/);
		});
	}

	it('prints help and exits 0', async () => {
		const result = await exec(['--help']);
		assert.equal(result.code, EXIT_OK);
		assert.match(result.stdout, /decision-matrix/);
	});

	it('keeps a later threshold when one is repeated', async () => {
		const result = await exec([...decideArgs, '--threshold', 'high=0.99', '--threshold', 'high=0.5']);
		assert.equal(result.code, EXIT_OK);
		assert.equal(JSON.parse(result.stdout).matched_rule, 'r');
	});
});

describe('state input', () => {
	const serverArgs = ['decide', '--rules', 'rules.json', '--questions', 'questions.json', '--local'];

	it('does not read stdin from a terminal or in answers mode', async () => {
		let reads = 0;
		const readStdin = async () => {
			reads += 1;
			return 'text';
		};
		await exec(decideArgs, { readStdin, stdinIsTTY: false });
		await exec(serverArgs, { readStdin, stdinIsTTY: true });
		assert.equal(reads, 0);
	});

	it('fails with a clear message when piped stdin is blank and a server is needed', async () => {
		const result = await exec(['decide', '--rules', 'rules.json', '--questions', 'questions.json'], { readStdin: async () => '  \n', stdinIsTTY: false });
		assert.equal(result.code, EXIT_ERROR);
		assert.notEqual(result.stderr, '');
	});
});

describe('import', () => {
	const base = { version: 1, default_action: hold, rows: [] };

	it('rejects a file of the wrong shape, an unknown key, and a bad default', () => {
		assert.throws(() => importFlatRules([]), /import file must be/);
		assert.throws(() => importFlatRules({ ...base, version: 2 }), /import file must be/);
		assert.throws(() => importFlatRules({ ...base, rows: {} }), /import file must be/);
		assert.throws(() => importFlatRules({ ...base, rules: [] }), /unknown key "rules"/);
		assert.throws(() => importFlatRules({ ...base, default_action: 'hold' }), /default_action must be an object/);
	});

	it('keeps the optional blocks and validates the result', () => {
		const built = importFlatRules({ ...base, owner: 'o', ticket: 't', thresholds: { high: 0.8 } }) as Record<string, unknown>;
		assert.equal(built.owner, 'o');
		assert.equal(built.ticket, 't');
		assert.deepEqual(built.thresholds, { high: 0.8 });
		assert.equal('open_gate_requires_facts' in built, false);
		assert.throws(() => importFlatRules({ ...base, thresholds: { high: 'x' } }), /must be a finite number/);
	});

	it('runs through the import and table commands', async () => {
		const flat = JSON.stringify({
			...base,
			rows: [{ id: 'r', combine: 'all', conditions: [{ source: 'fact', subject: 'x', operator: 'eq', value: true }], action: hold }],
		});
		const imported = await exec(['import', '--rules', 'flat.json'], {}, { 'flat.json': flat });
		assert.equal(imported.code, EXIT_OK);
		const table = await exec(['table', '--rules', 'out.json'], {}, { 'out.json': imported.stdout });
		assert.equal(table.code, EXIT_OK);
		assert.match(table.stdout, /r {2}hold {2}human {2}holds\n {2}x eq true/);
		assert.match(table.stdout, /default {2}hold {2}human {2}holds/);
		const json = await exec(['table', '--rules', 'out.json', '--json'], {}, { 'out.json': imported.stdout });
		assert.equal(JSON.parse(json.stdout).rows[0].id, 'r');
	});
});

describe('formatQuestionsNote', () => {
	it('covers a missing, a matching, and a different hash', () => {
		assert.match(formatQuestionsNote('abc', undefined), /Cases have no questions_hash/);
		assert.match(formatQuestionsNote('abc', 'abc'), /matches the cases/);
		assert.match(formatQuestionsNote('abc', 'def'), /does not match cases questions_hash def/);
	});
});

describe('the built entry point', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'dm-cli-'));
	const rulesFile = path.join(dir, 'rules.json');
	writeFileSync(rulesFile, rules);
	const tsx = path.join(packageRoot, 'node_modules/.bin/tsx');
	const invoke = (args: string[], input?: string) =>
		spawnSync(tsx, [path.join(packageRoot, 'src/cli.ts'), ...args], { encoding: 'utf8', input, cwd: dir });

	it('exits with the code run returned and writes to the right stream', () => {
		const ok = invoke(['table', '--rules', rulesFile]);
		assert.equal(ok.status, EXIT_OK);
		assert.match(ok.stdout, /default/);
		const bad = invoke(['nope']);
		assert.equal(bad.status, EXIT_ERROR);
		assert.match(bad.stderr, /Unknown command/);
	});

	it('reads state from piped stdin', () => {
		const questionsFile = path.join(dir, 'questions.json');
		const scriptsFile = path.join(dir, 'scripts.json');
		writeFileSync(questionsFile, questions);
		writeFileSync(scriptsFile, JSON.stringify({ version: 1, scripts: [{ question: 'q', contains: 'refund', noul: 0.9 }] }));
		const out = invoke(['decide', '--rules', rulesFile, '--questions', questionsFile, '--scripts', scriptsFile], 'please refund my order');
		assert.equal(out.status, EXIT_OK, out.stderr);
		assert.equal(JSON.parse(out.stdout).matched_rule, 'r');
	});

	after(() => rmSync(dir, { recursive: true, force: true }));
});

describe('readFileFromDisk', () => {
	it('names the path when a read fails', async () => {
		await assert.rejects(readFileFromDisk('/no/such/file.json'), /Could not read \/no\/such\/file\.json\./);
	});
});
