import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const script = path.resolve(__dirname, '../docker/mock-systemone.mjs');

async function freePort(): Promise<number> {
	const probe = createServer();
	probe.listen(0, '127.0.0.1');
	await once(probe, 'listening');
	const { port } = probe.address() as { port: number };
	probe.close();
	await once(probe, 'close');
	return port;
}

describe('mock-systemone server', () => {
	let child: ChildProcess;
	let base: string;
	const post = (body: string) => fetch(`${base}/v1/systemone`, { method: 'POST', body });

	before(async () => {
		const port = await freePort();
		base = `http://127.0.0.1:${port}`;
		child = spawn(process.execPath, [script], { env: { PATH: process.env.PATH, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
		await once(child.stdout!, 'data');
	});

	after(() => {
		child.kill();
	});

	it('answers health checks and 404s anything else', async () => {
		assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true });
		assert.equal((await fetch(`${base}/nope`)).status, 404);
		assert.equal((await fetch(`${base}/v1/systemone`)).status, 404);
	});

	it('rejects a body that is not a JSON object', async () => {
		assert.equal((await post('{')).status, 400);
		assert.equal((await post('[]')).status, 400);
	});

	it('answers each question type when no profile matches', async () => {
		const response = await post(
			JSON.stringify({
				state: { body: 'plain' },
				model: ' m ',
				questions: {
					ok: { type: 'noul' },
					other: { type: 'noul' },
					level: { type: 'score' },
					pick: { type: 'choice', criteria: { first: 'a', second: 'b' } },
					legacy: { type: 'choice', criteria: ['x'] },
				},
			}),
		);
		const body = (await response.json()) as { model: string; answers: Record<string, { noul?: number; score?: number; choice?: string }> };
		assert.equal(body.model, 'm');
		assert.equal(body.answers.ok?.noul, 0.95);
		assert.equal(body.answers.other?.noul, 0.05);
		assert.equal(body.answers.level?.score, 1);
		assert.equal(body.answers.pick?.choice, 'first');
		assert.equal(body.answers.legacy?.choice, 'bugfix');
	});

	it('defaults the model and tolerates missing questions', async () => {
		const body = (await (await post('{}')).json()) as { model: string; answers: object };
		assert.equal(body.model, 'dev-mock');
		assert.deepEqual(body.answers, {});
	});
});
