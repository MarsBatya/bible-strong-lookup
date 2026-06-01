import {
    App,
    Editor,
    MarkdownView,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    SuggestModal,
    requestUrl,
} from 'obsidian';
import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import sqlWasmBase64 from 'sql.js/dist/sql-wasm.wasm';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SearchResult {
    strong_number: number;
    lemma: string;
    count: number;
    sourceLemma: string; 
    testament: string;
    isPrefix?: boolean;
}

interface HistoryEntry {
    query: string;
    result: string;
}

interface BibleLookupSettings {
    dbUrl: string;
    history: HistoryEntry[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: BibleLookupSettings = {
    dbUrl: '',
    history: [],
};

const DB_FILENAME = 'bible.sqlite3';

// Mirror of the Python script queries exactly
const SQL_FIND_STRONG = `
SELECT strong_number, lemma, count, lang, testament
FROM lemmas
WHERE lemma = ?
ORDER BY count DESC
LIMIT 10
`.trim();

const SQL_FIND_TRANSLATIONS = `
SELECT lemma, count
FROM lemmas
WHERE strong_number = ?
AND lang != ?
AND testament = ?
ORDER BY count DESC
LIMIT 10
`.trim();


const SQL_FIND_STRONG_PREFIX = `
SELECT strong_number, lemma, count, lang, testament
FROM lemmas
WHERE lemma LIKE ? || '%'
AND lemma != ?
ORDER BY count DESC
LIMIT 10
`.trim();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Mirror the capitalisation pattern of `source` onto `target`. */
function mirrorCase(source: string, target: string): string {
    const s = source.trim();
    if (!s || !target) return target;

    // ALL CAPS → ALL CAPS
    if (s === s.toUpperCase() && s !== s.toLowerCase()) {
        return target.toUpperCase();
    }

    // Title Case (first char upper, rest lower) → Title Case
    const firstAlpha = s.search(/[a-zA-Zа-яА-ЯёЁ]/);
    if (
        firstAlpha !== -1 &&
        s[firstAlpha] === s[firstAlpha].toUpperCase() &&
        s.slice(firstAlpha + 1).toLowerCase() === s.slice(firstAlpha + 1)
    ) {
        return target.charAt(0).toUpperCase() + target.slice(1).toLowerCase();
    }

    return target; // lowercase or mixed → leave as-is
}

function base64ToUint8Array(b64: string): Uint8Array {
    const raw = atob(b64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default class BibleLookupPlugin extends Plugin {
    settings!: BibleLookupSettings;
    db: Database | null = null;
    SQL: SqlJsStatic | null = null;
    private engineReady: Promise<void> | null = null; // tracking init state

    async onload(): Promise<void> {
        await this.loadSettings();

        // this.initEngine() will be called later, in order to minimize startup time

        this.addCommand({
            id: 'bible-lookup-search',
            name: 'Search word translation',
            icon: 'book-open-check',
            callback: async () => {
                const needsInit = !this.engineReady;
                if (needsInit) new Notice('Bible Lookup: loading database…', 2000);
                await this.ensureEngine(); // loading engine on first use
                if (!this.db) {
                    new Notice('Bible Lookup: database not loaded. Download it first via Settings.');
                    return;
                }
                const editor = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor ?? null;
                new SearchModal(this.app, this, editor).open();
            },
        });

        this.addCommand({
            id: 'bible-lookup-history',
            name: 'Insert from recent searches',
            callback: () => {
                if (!this.settings.history.length) {
                    new Notice('Bible Lookup: no recent searches yet.');
                    return;
                }
                const editor = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor ?? null;
                new HistoryModal(this.app, this, editor).open();
            },
        });

        this.addCommand({
            id: 'bible-lookup-fetch-db',
            name: 'Fetch / update database from GitHub',
            callback: () => this.fetchDb(),
        });

        this.addSettingTab(new BibleSettingTab(this.app, this));
        this.app.workspace.onLayoutReady(() => {
            setTimeout(() => this.ensureEngine().catch(() => { }), 5000);
        });
    }

    /** Initialises the engine exactly once; subsequent calls are no-ops. */
    private ensureEngine(): Promise<void> {
        if (!this.engineReady) {
            this.engineReady = this.initEngine().catch(e => {
                this.engineReady = null; // allow retry on failure
                throw e;
            });
        }
        return this.engineReady;
    }

    onunload(): void {
        this.db?.close();
    }

    // ─── Engine init ────────────────────────────────────────────────────────
    
    async initEngine(): Promise<void> {
        const binary = base64ToUint8Array(sqlWasmBase64);
        this.SQL = await initSqlJs({ wasmBinary: binary.buffer as ArrayBuffer });
        await this.loadDb();
    }

    async loadDb(): Promise<void> {
        if (!this.SQL) return;
        const dbPath = `${this.manifest.dir}/${DB_FILENAME}`;
        try {
            const buf = await this.app.vault.adapter.readBinary(dbPath);
            if (this.db) this.db.close();
            this.db = new this.SQL.Database(new Uint8Array(buf));
            console.log('Bible Lookup: database ready ✓');
        } catch {
            // DB hasn't been downloaded yet — silently skip
        }
    }

    async fetchDb(): Promise<void> {
        if (!this.settings.dbUrl.trim()) {
            new Notice('Bible Lookup: set the database URL in plugin settings first.');
            return;
        }
        const notice = new Notice('Downloading database… (may take a moment for 30 MB)', 0);
        try {
            const resp = await requestUrl({ url: this.settings.dbUrl.trim() });
            const dbPath = `${this.manifest.dir}/${DB_FILENAME}`;
            await this.app.vault.adapter.writeBinary(dbPath, resp.arrayBuffer);
            await this.loadDb();
            notice.hide();
            new Notice('Bible Lookup: database downloaded and ready ✓');
        } catch (err) {
            notice.hide();
            new Notice('Bible Lookup: download failed — check the URL in settings.');
            console.error('Bible Lookup fetch error:', err);
        }
    }

    // ─── Core search (mirrors Python script logic exactly) ──────────────────

    search(word: string): SearchResult[] {
        if (!this.db) return [];
        const lower = word.toLowerCase().trim();
        if (!lower) return [];

        const exactResults = this._searchByLemmas(lower, false);

        // If we got enough hits, return them directly
        if (exactResults.length >= 3) return exactResults;

        // Otherwise, also run prefix search and merge
        const prefixResults = this._searchByLemmas(lower, true);

        // Deduplicate by strong_number + lemma, exact results take priority
        const seen = new Set(exactResults.map(r => `${r.strong_number}:${r.lemma}`));
        const merged = [...exactResults];
        for (const r of prefixResults) {
            const key = `${r.strong_number}:${r.lemma}`;
            if (!seen.has(key)) {
                seen.add(key);
                merged.push({ ...r, isPrefix: true });
            }
        }

        merged.sort((a, b) => b.count - a.count);
        return merged;
    }

    /** Shared engine for both exact and prefix searches. */
    private _searchByLemmas(lower: string, prefix: boolean): SearchResult[] {
        if (!this.db) return [];

        const hits: Array<{ strong_number: number; lang: string; testament: string; sourceLemma: string }> = [];
        const s1 = this.db.prepare(prefix ? SQL_FIND_STRONG_PREFIX : SQL_FIND_STRONG);
        s1.bind(prefix ? [lower, lower] : [lower]);
        while (s1.step()) {
            const r = s1.getAsObject() as { strong_number: number; lang: string; testament: string; lemma: string };
            hits.push({ strong_number: r.strong_number, lang: r.lang, testament: r.testament, sourceLemma: r.lemma });
        }
        s1.free();

        const out: SearchResult[] = [];
        const s2 = this.db.prepare(SQL_FIND_TRANSLATIONS);
        try {
            for (const hit of hits) {
                s2.bind([hit.strong_number, hit.lang, hit.testament]);
                while (s2.step()) {
                    const [lemma, count] = s2.get() as [string, number];
                    out.push({ strong_number: hit.strong_number, lemma: lemma, count: count, sourceLemma: hit.sourceLemma, testament: hit.testament });
                }
                s2.reset(); 
            }
        } finally {
            s2.free();
        }
        return out;
    }

    // ─── Helpers ────────────────────────────────────────────────────────────

    /** Insert at cursor if an editor is active, otherwise copy to clipboard. */
    insertOrCopy(editor: Editor | null, text: string): void {
        if (editor) {
            editor.replaceSelection(text);
        } else {
            navigator.clipboard.writeText(text).then(() => {
                new Notice(`Copied: ${text}`);
            });
        }
    }

    addToHistory(query: string, result: string): void {
        // Deduplicate, then cap at 10
        this.settings.history = [
            { query, result },
            ...this.settings.history.filter(h => !(h.query === query && h.result === result)),
        ].slice(0, 10);
        this.saveSettings();
    }

    async loadSettings(): Promise<void> {
        const data = await this.loadData();
        this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
        if (!Array.isArray(this.settings.history)) {
            this.settings.history = []; // Ensure history is always a valid array
        }
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }
}

// ─── Search Modal ─────────────────────────────────────────────────────────────

class SearchModal extends SuggestModal<SearchResult> {
    private plugin: BibleLookupPlugin;
    private editor: Editor | null;
    private lastQuery = '';

    constructor(app: App, plugin: BibleLookupPlugin, editor: Editor | null) {
        super(app);
        this.plugin = plugin;
        this.editor = editor;
        this.setPlaceholder('Type a word (English or Russian, case is preserved) …');
    }

    getSuggestions(query: string): SearchResult[] {
        this.lastQuery = query;
        return this.plugin.search(query);
    }

    renderSuggestion(item: SearchResult, el: HTMLElement): void {
        const prefix = item.isPrefix ? '~' : '';
        const strongPrefix = item.testament === 'OT' ? 'H' : 'G';
        el.createEl('span', {
            text: `${prefix}${strongPrefix}${item.strong_number} [${item.sourceLemma}]: "${item.lemma}" (${item.count})`,
        });
        if (item.isPrefix) {
            el.style.opacity = '0.75';
        }
    }

    onChooseSuggestion(item: SearchResult): void {
        const cased = mirrorCase(this.lastQuery, item.lemma);
        this.plugin.insertOrCopy(this.editor, cased);
        this.plugin.addToHistory(this.lastQuery, cased);
    }
}

// ─── History Modal ────────────────────────────────────────────────────────────

class HistoryModal extends SuggestModal<HistoryEntry> {
    private plugin: BibleLookupPlugin;
    private editor: Editor | null;

    constructor(app: App, plugin: BibleLookupPlugin, editor: Editor | null) {
        super(app);
        this.plugin = plugin;
        this.editor = editor;
        this.setPlaceholder('Recent searches — select to insert…');
    }

    getSuggestions(query: string): HistoryEntry[] {
        const q = query.toLowerCase();
        return this.plugin.settings.history.filter(
            h => !q || h.query.toLowerCase().includes(q) || h.result.toLowerCase().includes(q),
        );
    }

    renderSuggestion(item: HistoryEntry, el: HTMLElement): void {
        el.createEl('span', { text: `${item.query} → ${item.result}` });
    }

    onChooseSuggestion(item: HistoryEntry): void {
        this.plugin.insertOrCopy(this.editor, item.result);
    }
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

class BibleSettingTab extends PluginSettingTab {
    private plugin: BibleLookupPlugin;

    constructor(app: App, plugin: BibleLookupPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'Bible Translation Lookup' });

        new Setting(containerEl)
            .setName('Database URL')
            .setDesc(
                'Direct download URL to the .sqlite3 file hosted on GitHub Releases (or any HTTP server). ' +
                'Example: https://github.com/you/repo/releases/download/v1.0/RST-KJV-v2.Sqlite3',
            )
            .addText(t =>
                t
                    .setPlaceholder('https://github.com/…/releases/download/…/RST-KJV-v2.Sqlite3')
                    .setValue(this.plugin.settings.dbUrl)
                    .onChange(async (v) => {
                        this.plugin.settings.dbUrl = v.trim();
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName('Download / update database')
            .setDesc('Fetches the file from the URL above and stores it inside the plugin folder. ~30 MB download.')
            .addButton(b =>
                b
                    .setButtonText('Download now')
                    .setCta()
                    .onClick(() => this.plugin.fetchDb()),
            );

        new Setting(containerEl)
            .setName('Recent searches')
            .setDesc(`${this.plugin.settings.history.length} / 10 entries stored.`)
            .addButton(b =>
                b
                    .setButtonText('Clear history')
                    .setWarning()
                    .onClick(async () => {
                        this.plugin.settings.history = [];
                        await this.plugin.saveSettings();
                        this.display();
                        new Notice('History cleared.');
                    }),
            );

        containerEl.createEl('hr');
        containerEl.createEl('p', {
            text: 'Commands available via Command Palette (Ctrl/Cmd+P):',
            cls: 'setting-item-description',
        });
        const ul = containerEl.createEl('ul', { cls: 'setting-item-description' });
        [
            'Bible Lookup: Search word translation',
            'Bible Lookup: Insert from recent searches',
            'Bible Lookup: Fetch / update database from GitHub',
        ].forEach(cmd => ul.createEl('li', { text: cmd }));
    }
}
