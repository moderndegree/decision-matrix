import { readFileSync } from 'node:fs';
import path from 'node:path';

import { testRender } from '@opentui/react/test-utils';
import { act } from 'react';

import { App } from '../src/app';
import type { AppIO, EditOutcome } from '../src/io';
import { createWorkspace, type Workspace } from '../src/model';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const examples = path.resolve(import.meta.dir, '../../decision-matrix-cli/examples');

export function readExample(name: string): unknown {
	return JSON.parse(readFileSync(path.join(examples, name), 'utf8'));
}

export function ciWorkspace(): Workspace {
	return createWorkspace({
		rulesPath: 'ci-change.rules.json',
		rules: readExample('ci-change.rules.json'),
		casesPath: 'ci-change.cases.json',
		cases: readExample('ci-change.cases.json'),
		questionsPath: 'ci-change.questions.json',
		questions: readExample('ci-change.questions.json'),
	});
}

/** An AppIO that records saves and answers editor requests from a queue. */
export function fakeIO(edits: EditOutcome[] = []) {
	const saved: Array<{ path: string; text: string }> = [];
	const edited: unknown[] = [];
	let quit = false;
	const io: AppIO = {
		async editJson(value) {
			edited.push(value);
			return edits.shift() ?? { kind: 'unchanged' };
		},
		save(files) {
			saved.push(...files);
		},
		quit() {
			quit = true;
		},
	};
	return { io, saved, edited, quitCalled: () => quit };
}

export async function renderApp(workspace: Workspace, io: AppIO, size = { width: 120, height: 36 }) {
	let setup!: Awaited<ReturnType<typeof testRender>>;
	await act(async () => {
		setup = await testRender(<App initial={workspace} io={io} />, size);
		await setup.renderOnce();
	});
	const frame = async () => {
		await act(async () => {
			await setup.renderOnce();
		});
		return setup.captureCharFrame();
	};
	const press = async (action: () => void | Promise<void>) => {
		await act(async () => {
			await action();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		return frame();
	};
	return { setup, frame, press };
}
