import esbuild from 'esbuild';
import process from 'process';
import builtins from 'builtin-modules';
import { copyFileSync, existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const isProd = process.argv[2] === 'production';

const wasmBase64Plugin = {
    name: 'wasm-base64',
    setup(build) {
        build.onLoad({ filter: /\.wasm$/ }, async (args) => {
            const data = readFileSync(args.path);
            return {
                contents: `export default "${data.toString('base64')}"`,
                loader: 'js',
            };
        });
    },
};

// ── Bundle ───────────────────────────────────────────────────────────────────
const ctx = await esbuild.context({
    entryPoints: ['main.ts'],
    bundle: true,
    // obsidian is provided by the host app; everything else is bundled.
    external: [
        'obsidian',
        'electron',
        '@codemirror/autocomplete',
        '@codemirror/collab',
        '@codemirror/commands',
        '@codemirror/language',
        '@codemirror/lint',
        '@codemirror/search',
        '@codemirror/state',
        '@codemirror/view',
        '@lezer/common',
        '@lezer/highlight',
        '@lezer/lr',
        ...builtins,
    ],
    format: 'cjs',
    target: 'es2018',
    logLevel: 'info',
    sourcemap: isProd ? false : 'inline',
    treeShaking: true,
    outfile: 'main.js',
    define: {
        'process.env.NODE_ENV': JSON.stringify(isProd ? 'production' : 'development'),
    },
    plugins: [wasmBase64Plugin],
});

if (isProd) {
    await ctx.rebuild();
    await ctx.dispose();
    console.log('✓ Production build complete');
    process.exit(0);
} else {
    await ctx.watch();
    console.log('Watching for changes…');
}
