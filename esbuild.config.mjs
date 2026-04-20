import esbuild from 'esbuild';
import process from 'process';
import builtins from 'builtin-modules';
import { copyFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const isProd = process.argv[2] === 'production';

// ── Copy sql-wasm.wasm alongside the built main.js ───────────────────────────
// Obsidian reads it via readBinary() at runtime; it MUST live next to main.js.
const wasmSrc = resolve('node_modules/sql.js/dist/sql-wasm.wasm');
if (existsSync(wasmSrc)) {
    copyFileSync(wasmSrc, 'sql-wasm.wasm');
    console.log('✓ Copied sql-wasm.wasm');
} else {
    console.error('✗ sql-wasm.wasm not found — run npm install first.');
    process.exit(1);
}

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
