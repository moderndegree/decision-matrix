import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXIT_ERROR, EXIT_GATE, EXIT_OK, readCaseDocument, run } from '../src';
import { formatSweep, questionsFileHash, shadowCases, sweepThresholds } from '../src/shadow';
import { importFlatRules } from '../src/import-table';
import { captured, rule, rules } from './fixtures';

describe('shadow and sweep', () => {
	const from = rules([rule('hold', { all: [{ question: 'q', gte: 'high' }] })]);
	const to = rules([
		rule('hold', { all: [{ question: 'q', gte: 'high' }] }),
		rule('open', { all: [{ question: 'q', lt: 'high' }] }, false),
	]);
	const cases = {
		version: 1,
		cases: [
			{ name: 'high', answers: { q: { noul: 0.9 } }, expect: { gate: true } },
			{ name: 'low', answers: { q: { noul: 0.2 } }, expect: { gate: true } },
		],
	};

	it('sorts hold-to-open first and exits 2 only when asked', async () => {
		const rows = shadowCases(from, to, readCaseDocument(cases).cases);
		assert.equal(rows[0]?.kind, 'hold-to-open');
		assert.equal(rows[0]?.name, 'low');
		assert.match(rows[0]?.before ?? '', /hold \(default, gate true\)/);
		assert.match(rows[0]?.after ?? '', /pass \(open, gate false\)/);
		assert.equal(rows[1]?.kind, 'unchanged');

		const files = { 'from.json': JSON.stringify(from), 'to.json': JSON.stringify(to), 'cases.json': JSON.stringify(cases) };
		const ok = captured(['shadow', '--from', 'from.json', '--to', 'to.json', '--cases', 'cases.json'], files);
		assert.equal(await run(ok.io), EXIT_OK);
		assert.match(ok.stdout.join(''), /hold→open  1/);
		const fail = captured(['shadow', '--from', 'from.json', '--to', 'to.json', '--cases', 'cases.json', '--fail-on-open'], files);
		assert.equal(await run(fail.io), EXIT_GATE);
	});

	it('counts a cutoff grid and does not call it a calibration', () => {
		const policy = rules(
			[rule('hold', { all: [{ question: 'q', gte: 'high' }] }), rule('open', { all: [{ question: 'q', lt: 'high' }] }, false)],
			{ thresholds: { high: 0.8 } },
		);
		const document = readCaseDocument({
			version: 1,
			cases: [
				{ name: 'nine', answers: { q: { noul: 0.9 } }, expect: { gate: true } },
				{ name: 'six', answers: { q: { noul: 0.6 } }, expect: { gate: true } },
			],
		});
		const lines = sweepThresholds(policy, document.cases);
		const at = (cutoff: number) => lines.find((line) => line.threshold === 'high' && Math.abs(line.cutoff - cutoff) < 1e-9);
		assert.equal(at(0.8)?.baseline, true);
		assert.equal(at(0.5)?.openToHold, 1);
		assert.equal(at(0.95)?.holdToOpen, 1);
		const text = formatSweep(lines, document.provenance);
		assert.match(text, /Not a calibration/);
		assert.match(text, /0\.80  \(baseline\)/);
		assert.doesNotMatch(text, /0\.80  \(baseline\)\s+hold/);
		const bare = rules([rule('n', { all: [{ fact: 'n', gt: 'max_files' }] })], { thresholds: { max_files: 20 } });
		assert.match(formatSweep(sweepThresholds(bare, document.cases), undefined), /No threshold with a baseline from 0 to 1/);
		const marked = formatSweep(lines, { model_id: 'm', temperature: 0, questions_hash: 'abc' });
		assert.doesNotMatch(marked, /Not a calibration/);
	});

	it('hashes the questions file bytes', () => {
		const text = '{ "q": { "type": "noul" } }\n';
		assert.equal(questionsFileHash(text), questionsFileHash(text));
		assert.notEqual(questionsFileHash(text), questionsFileHash(JSON.stringify(JSON.parse(text))));
	});

	it('imports a flat table after the ruleset validates', () => {
		const built = importFlatRules({
			version: 1,
			default_action: { type: 'hold', target: 'human', reason: 'no', gate: true },
			rows: [
				{
					id: 'ci',
					combine: 'all',
					conditions: [{ subject: 'seen', source: 'fact', operator: 'gte', value: '2024-01-02T03:04:05Z' }],
					action: { type: 'hold', target: 'security', reason: 'seen', gate: true },
				},
			],
		}) as { rules: Array<{ when: { gte?: string } }> };
		assert.equal(built.rules[0]?.when.gte, '2024-01-02T03:04:05Z');
	});

	it('rejects a shadow flag the command does not use', async () => {
		const wrong = captured(['shadow', '--from', 'a.json', '--to', 'b.json', '--cases', 'c.json', '--server', 'http://x']);
		assert.equal(await run(wrong.io), EXIT_ERROR);
		assert.match(wrong.stderr.join(''), /shadow does not use --server/);
	});
});
