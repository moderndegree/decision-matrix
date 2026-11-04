// Builds a single executable for one target, so users do not need Bun.
//
//   bun scripts/compile.ts                       this machine
//   bun scripts/compile.ts bun-linux-x64-musl    another target
//
// OpenTUI ships a native library per platform. OPENTUI_LIBC is fixed at build
// time so the bundle keeps only the target's branch and needs only that
// target's native package installed. Publish a checksum with each binary.

export {};

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const target = args[0] ?? `bun-${process.platform}-${process.arch}`;
const libc = target.endsWith('-musl') ? 'musl' : 'glibc';
const outfile = `dist/decision-matrix-tui-${target.replace(/^bun-/, '')}`;

const result = await Bun.build({
	entrypoints: ['./src/main.tsx'],
	compile: { target: target as Bun.Build.CompileTarget, outfile },
	define: { 'process.env.OPENTUI_LIBC': JSON.stringify(libc) },
	minify: true,
});
if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}
const digest = new Bun.CryptoHasher('sha256').update(await Bun.file(outfile).arrayBuffer()).digest('hex');
await Bun.write(`${outfile}.sha256`, `${digest}  ${outfile.split('/').pop()}\n`);
console.log(`${outfile}\nsha256 ${digest}`);
