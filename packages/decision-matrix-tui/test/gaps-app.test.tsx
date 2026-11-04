import { describe, expect, test } from 'bun:test';

import { ciWorkspace, fakeIO, renderApp } from './helpers';

async function open() {
	const fake = fakeIO();
	const app = await renderApp(ciWorkspace(), fake.io);
	const keys = app.setup.mockInput;
	const escape = () =>
		app.press(async () => {
			keys.pressEscape();
			await new Promise((resolve) => setTimeout(resolve, 80));
		});
	const times = async (n: number, action: () => void) => {
		let screen = '';
		for (let i = 0; i < n; i++) screen = await app.press(action);
		return screen;
	};
	const type = async (text: string) => {
		await app.press(() => keys.typeText(text));
		return app.press(() => keys.pressEnter());
	};
	/** The screen with whitespace collapsed, for messages that wrap across lines. */
	const flat = (screen: string) => screen.replace(/\s+/g, ' ');
	return { ...app, ...fake, keys, escape, times, type, flat };
}

describe('default action and strict flag', () => {
	test('the default action is a row: it opens in the form, and a strict policy keeps it holding', async () => {
		const { press, keys, times, flat, setup } = await open();
		let screen = await times(10, () => keys.pressArrow('down'));
		expect(screen).toContain('Applies when no rule matches.');
		screen = await press(() => keys.pressKey('g'));
		expect(flat(screen)).toContain('default_action.gate must be true');
		screen = await press(() => keys.pressKey('e'));
		expect(screen).toContain('Edit the default action');
		expect(screen).toContain('When no rule matches, holds: hold → human');
		expect(screen).not.toContain('ALL of these');
		setup.renderer.destroy();
	});

	test('turning strict off asks first, and the change counts as a loosening', async () => {
		const { press, keys, setup } = await open();
		let screen = await press(() => keys.pressKey('s', { shift: true }));
		expect(screen).toContain('Turn off open_gate_requires_facts? y/n');
		screen = await press(() => keys.pressKey('y'));
		expect(screen).toContain('Strict is off.');
		expect(screen).not.toContain('· strict ');
		screen = await press(() => keys.pressArrow('down'));
		expect(screen).toContain('unsaved (loosens 1, tightens 0)');
		screen = await press(() => keys.pressKey('s', { shift: true }));
		expect(screen).toContain('Strict: every rule that opens the gate now needs a fact');
		setup.renderer.destroy();
	});
});

describe('thresholds', () => {
	test('adds, renames everywhere, and refuses to delete one in use', async () => {
		const { press, keys, type, times, setup } = await open();
		await press(() => keys.pressTab());
		await press(() => keys.pressKey('n'));
		await type('spare');
		let screen = await type('3');
		expect(screen).toContain('Added spare.');
		expect(screen).toContain('spare            3');

		await times(2, () => keys.pressArrow('up'));
		screen = await press(() => keys.pressKey('x'));
		expect(screen).toContain('high_risk is used by hold-risk, pass-small-change');

		await press(() => keys.pressKey('r'));
		for (let i = 0; i < 'high_risk'.length; i++) await press(() => keys.pressBackspace());
		screen = await type('risk_limit');
		expect(screen).toContain('Renamed to risk_limit in every rule and case.');
		expect(screen).toContain('risk_limit       2');
		expect(screen).toContain('Cases 16/16');
		setup.renderer.destroy();
	});
});

describe('cases', () => {
	test('edits the defaults, adds a case, and edits its expectations', async () => {
		const { press, keys, type, times, escape, saved, setup } = await open();
		await times(2, () => keys.pressTab());
		let screen = await press(() => keys.pressArrow('up'));
		expect(screen).toContain('Shared values. Every case starts from these.');

		// A new case starts from the defaults and expects what the rules decide now.
		await press(() => keys.pressKey('n'));
		screen = await type('only the defaults');
		expect(screen).toContain('Case added.');
		expect(screen).toContain('✓ only the defaults');
		expect(screen).toContain('Cases 17/17');

		screen = await press(() => keys.pressKey('e'));
		expect(screen).toContain('What this case expects');
		expect(screen).toContain('matched_rule  "pass-small-change"');
		expect(screen).toContain('target        — not checked');
		screen = await press(() => keys.pressEnter());
		expect(screen).toContain('Which rule must decide');
		screen = await press(() => keys.pressArrow('up'));
		screen = await press(() => keys.pressEnter());
		expect(screen).toContain('matched_rule  "pass-docs"');
		// The list reopens after each change, so several fields can be set. Escape finishes.
		await escape();

		await press(() => keys.pressKey('s', { ctrl: true }));
		await press(() => keys.pressKey('y'));
		const cases = JSON.parse(saved.find((file) => file.path === 'ci-change.cases.json')!.text);
		expect(cases.cases.at(-1)).toEqual({ name: 'only the defaults', expect: { matched_rule: 'pass-docs', action: 'pass', gate: false } });
		setup.renderer.destroy();
	});

	test('adds a fact to a case and removes an override', async () => {
		const { press, keys, type, times, setup } = await open();
		await times(3, () => keys.pressTab());
		let screen = await press(() => keys.pressKey('n'));
		expect(screen).toContain('A fact…');
		await press(() => keys.pressEnter());
		await type('grant.owner');
		screen = await type('"alice"');
		expect(screen).toContain('Added grant.owner.');
		// The new fact is the last value, below the fold until the cursor moves there.
		screen = await times(20, () => keys.pressArrow('down'));
		expect(screen).toContain('* fact grant.owner');
		await times(20, () => keys.pressArrow('up'));

		// An inherited value can only be changed on the defaults row.
		await times(5, () => keys.pressArrow('down'));
		screen = await press(() => keys.pressKey('x'));
		expect(screen).toContain('comes from the defaults. Select the defaults row');
		// The first case overrides touches_ci (the twelfth value). Removing it brings back the default.
		await times(6, () => keys.pressArrow('down'));
		screen = await press(() => keys.pressKey('x'));
		expect(screen).toContain('touches_ci comes from the defaults again');
		screen = await press(() => keys.pressArrow('up'));
		expect(screen).toMatch(/ {3}fact touches_ci +false/);
		setup.renderer.destroy();
	});
});

describe('questions screen', () => {
	test('opens with Q, renames a question everywhere, and returns', async () => {
		const { press, keys, type, escape, setup } = await open();
		let screen = await press(() => keys.pressKey('q', { shift: true }));
		expect(screen).toContain('Questions · ci-change.questions.json');
		expect(screen).toContain('suspicious_code  noul  · 3 rules');

		await press(() => keys.pressArrow('down'));
		await press(() => keys.pressKey('r'));
		for (let i = 0; i < 'suspicious_code'.length; i++) await press(() => keys.pressBackspace());
		screen = await type('risky_code');
		expect(screen).toContain('Renamed to risky_code. Rules and cases follow.');
		expect(screen).toContain('risky_code  noul  · 3 rules');

		screen = await escape();
		expect(screen).toContain('Rules · ci-change.rules.json');
		expect(screen).toContain('Cases 16/16');
		expect(screen).toContain('lint 0 errors 0 warnings');
		setup.renderer.destroy();
	});

	test('edits score levels and shows lint when a rule no longer fits', async () => {
		const { press, keys, times, setup } = await open();
		await press(() => keys.pressKey('q', { shift: true }));
		await times(4, () => keys.pressArrow('down'));
		let screen = await press(() => keys.pressEnter());
		expect(screen).toContain('Levels, lowest (0) first');
		expect(screen).toContain('3  Weakens a control, exposes data, or is hard to reverse');
		await press(() => keys.pressArrow('down'));
		screen = await press(() => keys.pressArrow('left'));
		expect(screen).toContain('risk is now a noul question.');
		expect(screen).toContain('Lint ·');
		expect(screen).toMatch(/compares the probability "risk" with 2, outside 0–1/);
		setup.renderer.destroy();
	});
});
