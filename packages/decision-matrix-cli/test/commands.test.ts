import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { EXIT_ERROR, EXIT_GATE, EXIT_OK, readCaseDocument, run } from '../src';
import { captured, packageRoot } from './fixtures';

const hold = { type: 'hold', target: 'human', reason: 'No matching rule', gate: true };
const open = { type: 'pass', target: 't', reason: 'ok', gate: false };

const opens = (fact: string, extra: Record<string, unknown> = {}) => ({
	version: 1,
	default_action: hold,
	rules: [{ id: 'r', when: { fact, eq: true }, action: open }],
	...extra,
});

const cases = JSON.stringify({
	version: 1,
	defaults: {},
	cases: [{ name: 'opens', facts: { a: true, b: false }, expect: { gate: false, matched_rule: 'r' } }],
});

const files: Record<string, string> = {
	'a.json': JSON.stringify(opens('a')),
	'b.json': JSON.stringify(opens('b')),
	'empty.json': JSON.stringify({ version: 1, default_action: hold, rules: [] }),
	'cases.json': cases,
};

async function exec(argv: string[], more: Record<string, string> = {}) {
	const cli = captured(argv, { ...files, ...more });
	const code = await run(cli.io);
	return { code, stdout: cli.stdout.join(''), stderr: cli.stderr.join('') };
}

describe('check', () => {
	it('prints a summary and says when questions were not checked', async () => {
		const result = await exec(['check', '--rules', 'a.json']);
		assert.equal(result.code, EXIT_OK);
		assert.match(result.stdout, /0 errors, \d+ warnings, \d+ info/);
		assert.match(result.stdout, /Questions were not checked/);
	});

	it('fails an opener with no owner only under --strict', async () => {
		const strict = await exec(['check', '--rules', 'a.json', '--strict', '--json']);
		assert.equal(strict.code, EXIT_ERROR);
		const report = JSON.parse(strict.stdout);
		assert.equal(report.passed, false);
		assert.ok(report.findings.some((finding: { code: string }) => finding.code === 'missing-owner'));
	});

	it('fails on an error finding and prints the rule id', async () => {
		const bad = JSON.stringify({ version: 1, default_action: hold, rules: [{ id: 'r', when: { question: 'q', gte: { threshold: 'none' } }, action: hold }] });
		const result = await exec(['check', '--rules', 'bad.json'], { 'bad.json': bad });
		assert.equal(result.code, EXIT_ERROR);
		assert.match(result.stdout, /error\s+unknown-threshold/);
	});

	it('checks questions from a preset', async () => {
		const result = await exec(['check', '--preset', 'generic']);
		assert.doesNotMatch(result.stdout, /Questions were not checked/);
	});
});

describe('test', () => {
	it('passes a case and reports JSON', async () => {
		const result = await exec(['test', '--rules', 'a.json', '--cases', 'cases.json', '--json']);
		assert.equal(result.code, EXIT_OK);
		assert.equal(JSON.parse(result.stdout).passed, true);
	});

	it('fails a case that no longer holds', async () => {
		const result = await exec(['test', '--rules', 'b.json', '--cases', 'cases.json']);
		assert.equal(result.code, EXIT_ERROR);
	});

	it('fails on an uncovered rule under --require-coverage', async () => {
		const noRule = JSON.stringify({ version: 1, defaults: {}, cases: [{ name: 'c', facts: { a: false }, expect: { gate: true } }] });
		const loose = await exec(['test', '--rules', 'a.json', '--cases', 'c.json'], { 'c.json': noRule });
		assert.equal(loose.code, EXIT_OK);
		const strict = await exec(['test', '--rules', 'a.json', '--cases', 'c.json', '--require-coverage'], { 'c.json': noRule });
		assert.equal(strict.code, EXIT_ERROR);
		assert.match(strict.stdout, /--require-coverage is set, so uncovered rules fail the run/);
	});
});

describe('diff', () => {
	it('prints markdown, JSON, and exits 2 on a loosening only when asked', async () => {
		const args = ['diff', '--from', 'a.json', '--to', 'empty.json'];
		const tighten = await exec([...args, '--fail-on-loosen']);
		assert.equal(tighten.code, EXIT_OK);
		const loosen = await exec(['diff', '--from', 'empty.json', '--to', 'a.json', '--fail-on-loosen']);
		assert.equal(loosen.code, EXIT_GATE);
		const quiet = await exec(['diff', '--from', 'empty.json', '--to', 'a.json']);
		assert.equal(quiet.code, EXIT_OK);
		const markdown = await exec(['diff', '--from', 'empty.json', '--to', 'a.json', '--format', 'markdown']);
		assert.match(markdown.stdout, /^#/m);
		const json = await exec([...args, '--json']);
		assert.equal(typeof JSON.parse(json.stdout).loosens, 'boolean');
	});

	it('lists cases whose decision changed', async () => {
		const result = await exec(['diff', '--from', 'a.json', '--to', 'b.json', '--cases', 'cases.json', '--json']);
		const diff = JSON.parse(result.stdout);
		assert.ok(JSON.stringify(diff).includes('opens'));
	});
});

describe('shadow', () => {
	it('exits 2 only when --fail-on-open is set and a hold became an open', async () => {
		const args = ['shadow', '--from', 'b.json', '--to', 'a.json', '--cases', 'cases.json'];
		assert.equal((await exec(args)).code, EXIT_OK);
		const failed = await exec([...args, '--fail-on-open', '--json']);
		assert.equal(failed.code, EXIT_GATE);
		assert.ok(JSON.parse(failed.stdout).rows.some((row: { kind: string }) => row.kind === 'hold-to-open'));
		const closing = await exec(['shadow', '--from', 'a.json', '--to', 'b.json', '--cases', 'cases.json', '--fail-on-open']);
		assert.equal(closing.code, EXIT_OK);
	});
});

describe('sweep', () => {
	const rules = JSON.stringify({
		version: 1,
		default_action: hold,
		thresholds: { high: 0.8 },
		rules: [{ id: 'r', when: { question: 'q', gte: { threshold: 'high' } }, action: hold }],
	});
	const provenance = (hash: string) =>
		JSON.stringify({
			version: 1,
			defaults: {},
			provenance: { model_id: 'm', temperature: 0, questions_hash: hash },
			cases: [{ name: 'c', answers: { q: { type: 'noul', noul: 0.9 } }, expect: { gate: true } }],
		});

	it('notes a questions file that does not match the recorded hash', async () => {
		const result = await exec(['sweep', '--rules', 'r.json', '--cases', 'c.json', '--questions', 'q.json', '--json'], {
			'r.json': rules,
			'c.json': provenance('abc'),
			'q.json': '{}',
		});
		assert.equal(result.code, EXIT_OK);
		const report = JSON.parse(result.stdout);
		assert.equal(report.provenance.model_id, 'm');
		assert.match(report.questions_note, /does not match cases questions_hash abc/);
	});

	it('prints text with no questions file', async () => {
		const result = await exec(['sweep', '--rules', 'r.json', '--cases', 'c.json'], { 'r.json': rules, 'c.json': provenance('abc') });
		assert.equal(result.code, EXIT_OK);
		assert.notEqual(result.stdout, '');
	});
});

describe('case provenance', () => {
	const doc = (provenance: unknown) => ({ version: 1, cases: [], provenance });
	const good = { model_id: 'm', temperature: 0, questions_hash: 'h' };
	const failures: Array<[string, unknown, RegExp]> = [
		['a non-object', 'x', /provenance must be an object/],
		['an unknown key', { ...good, seed: 1 }, /provenance has unknown key "seed"/],
		['a missing key', { model_id: 'm', temperature: 0 }, /provenance\.questions_hash is required/],
		['a bad model_id', { ...good, model_id: 1 }, /provenance\.model_id must be a string or null/],
		['a bad temperature', { ...good, temperature: 'hot' }, /provenance\.temperature must be a number or null/],
		['a blank hash', { ...good, questions_hash: ' ' }, /provenance\.questions_hash must be a non-empty string/],
	];
	for (const [name, value, message] of failures) {
		it(`rejects ${name}`, () => assert.throws(() => readCaseDocument(doc(value), 'c.json'), message));
	}

	it('accepts null for model_id and temperature', () => {
		const parsed = readCaseDocument(doc({ model_id: null, temperature: null, questions_hash: 'h' }), 'c.json');
		assert.equal(parsed.provenance?.model_id, null);
	});
});

describe('collect-facts.mjs as a script', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'dm-facts-'));
	const script = path.join(packageRoot, 'examples/github/collect-facts.mjs');
	const git = (...args: string[]) =>
		execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' }).trim();
	git('init', '-q');
	writeFileSync(path.join(dir, 'README.md'), 'one\n');
	git('add', '.');
	git('commit', '-qm', 'base');
	const base = git('rev-parse', 'HEAD');
	writeFileSync(path.join(dir, 'README.md'), 'two\n');
	git('add', '.');
	git('commit', '-qm', 'head');
	const head = git('rev-parse', 'HEAD');
	const eventPath = path.join(dir, 'event.json');
	writeFileSync(
		eventPath,
		JSON.stringify({
			pull_request: {
				title: 't',
				body: 'b',
				user: { login: 'octocat', type: 'User' },
				author_association: 'MEMBER',
				base: { sha: base, repo: { full_name: 'a/b' } },
				head: { sha: head, repo: { full_name: 'a/b' } },
			},
		}),
	);
	const invoke = (env: Record<string, string>) =>
		spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', GITHUB_EVENT_PATH: eventPath, ...env } });

	after(() => rmSync(dir, { recursive: true, force: true }));

	it('reads the shas from the event and writes facts and state', () => {
		const out = path.join(dir, 'out');
		const result = invoke({ OUT_DIR: out });
		assert.equal(result.status, 0, result.stderr);
		const facts = JSON.parse(readFileSync(path.join(out, 'facts.json'), 'utf8'));
		assert.equal(facts.files_changed, 1);
		assert.equal(facts.docs_only, true);
		assert.equal(facts.author, 'octocat');
		assert.deepEqual(JSON.parse(result.stdout), facts);
		const state = JSON.parse(readFileSync(path.join(out, 'state.json'), 'utf8'));
		assert.match(JSON.stringify(state), /README\.md/);
	});

	it('uses SENSITIVE_PATHS', () => {
		const result = invoke({ OUT_DIR: path.join(dir, 'out2'), SENSITIVE_PATHS: 'README.md, other' });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(JSON.parse(result.stdout).touches_sensitive, true);
	});

	it('fails when no shas are known', () => {
		const empty = path.join(dir, 'empty.json');
		writeFileSync(empty, '{}');
		const result = invoke({ GITHUB_EVENT_PATH: empty });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /BASE_SHA and HEAD_SHA are required/);
	});
});
