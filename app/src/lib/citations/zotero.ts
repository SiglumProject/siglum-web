// ZoteroProvider - Zotero citation provider with hybrid search
// Uses Zotero API for server-side search, caches only used items
// Storage: @siglum/filesystem for persistence

import { CitationProvider } from './provider';
import type { CitationItem, ProviderStatus, ConnectCredentials } from './provider';
import { fileSystem } from '@siglum/filesystem';

const ZOTERO_PATH = '/zotero';
const ZOTERO_CONFIG_PATH = '/zotero/config.json';
const ZOTERO_ITEMS_PATH = '/zotero/items';

interface ZoteroConfig {
    id: string;
    userId: string;
    apiKey: string;
    connectedAt: number;
}

interface SearchCacheEntry {
    results: CitationItem[];
    timestamp: number;
}

interface ZoteroApiItem {
    key: string;
    version?: number;
    data: {
        itemType: string;
        title?: string;
        date?: string;
        creators?: Array<{
            creatorType?: string;
            firstName?: string;
            lastName?: string;
            name?: string;
        }>;
        publicationTitle?: string;
        bookTitle?: string;
        publisher?: string;
        place?: string;
        volume?: string;
        issue?: string;
        pages?: string;
        DOI?: string;
        ISBN?: string;
        ISSN?: string;
        url?: string;
        abstractNote?: string;
        [key: string]: unknown;
    };
}

/**
 * ZoteroProvider - Memory-efficient Zotero integration
 *
 * Key design decisions:
 * - Uses Zotero API ?q=query for server-side search (no memory overhead)
 * - Only caches items the user actually uses (trackUsed)
 * - Falls back to cached items when offline
 * - No full library sync - saves memory and bandwidth
 */
export class ZoteroProvider extends CitationProvider {
    userId: string | null = null;
    apiKey: string | null = null;
    private _connected = false;
    private _syncing = false;
    private _itemCount = 0;
    private _fsMounted = false;
    private _subscribers: Set<(status: ProviderStatus) => void> = new Set();

    // L1 memory cache - fast lookup before filesystem
    private _itemCache: Map<string, CitationItem> = new Map();          // key -> item (LRU)
    private _itemCacheByKey: Map<string, CitationItem> = new Map();     // citeKey -> item
    private _searchCache: Map<string, SearchCacheEntry> = new Map();    // query -> {results, timestamp}
    private _cacheMaxSize = 200;
    private _searchCacheTTL = 60000;         // 1 minute for search results

    // Request deduplication - coalesce parallel requests
    private _inFlightSearches: Map<string, Promise<CitationItem[]>> = new Map();   // query -> Promise
    private _inFlightItems: Map<string, Promise<CitationItem | null>> = new Map(); // key -> Promise

    // Mount promise lock to prevent race conditions
    private _mountPromise: Promise<boolean> | null = null;

    constructor(options: { proxyUrl?: string } = {}) {
        super({
            id: 'zotero',
            name: 'Zotero',
            ...options,
        });
    }

    // ========================================
    // Status & Subscription
    // ========================================

    isConnected(): boolean {
        return this._connected;
    }

    getStatus(): ProviderStatus {
        return {
            connected: this._connected,
            syncing: this._syncing,
            itemCount: this._itemCount,
            userId: this.userId,
        };
    }

    onStatus(callback: (status: ProviderStatus) => void): () => void {
        this._subscribers.add(callback);
        callback(this.getStatus());
        return () => this._subscribers.delete(callback);
    }

    private _notify(): void {
        const status = this.getStatus();
        this._subscribers.forEach(cb => cb(status));
    }

    // ========================================
    // Filesystem Setup
    // ========================================

    private async _ensureMounted(): Promise<boolean> {
        if (this._fsMounted) return true;
        if (this._mountPromise) return this._mountPromise;

        this._mountPromise = (async () => {
            try {
                if (!fileSystem.isMounted(ZOTERO_PATH)) {
                    await fileSystem.mountAuto(ZOTERO_PATH);
                }
                await fileSystem.mkdir(ZOTERO_ITEMS_PATH, { silent: true });
                this._fsMounted = true;
                return true;
            } catch (e) {
                console.warn('[Zotero] Failed to mount filesystem:', e);
                return false;
            } finally {
                this._mountPromise = null;
            }
        })();
        return this._mountPromise;
    }

    // ========================================
    // Configuration
    // ========================================

    private async _getConfig(): Promise<ZoteroConfig | null> {
        try {
            if (!await this._ensureMounted()) return null;
            const content = await fileSystem.readFile(ZOTERO_CONFIG_PATH);
            return JSON.parse(content);
        } catch {
            return null;
        }
    }

    private async _saveConfig(userId: string, apiKey: string): Promise<boolean> {
        try {
            if (!await this._ensureMounted()) return false;
            const config: ZoteroConfig = {
                id: 'credentials',
                userId,
                apiKey,
                connectedAt: Date.now(),
            };
            await fileSystem.writeFile(ZOTERO_CONFIG_PATH, JSON.stringify(config));
            return true;
        } catch {
            return false;
        }
    }

    private async _clearConfig(): Promise<boolean> {
        try {
            if (!await this._ensureMounted()) return false;
            // Delete config file
            await fileSystem.deleteFile(ZOTERO_CONFIG_PATH).catch(() => {});
            // Clear items directory
            await fileSystem.rmdir(ZOTERO_ITEMS_PATH, { recursive: true }).catch(() => {});
            await fileSystem.mkdir(ZOTERO_ITEMS_PATH, { silent: true });
            return true;
        } catch {
            return false;
        }
    }

    // ========================================
    // Connection
    // ========================================

    async init(): Promise<boolean> {
        const config = await this._getConfig();
        if (config?.userId && config?.apiKey) {
            this.userId = config.userId;
            this.apiKey = config.apiKey;
            this._connected = true;

            // Count cached items
            this._itemCount = await this._getCachedItemCount();
            this._notify();
            return true;
        }
        return false;
    }

    async connect(credentials: ConnectCredentials): Promise<boolean> {
        const { userId, apiKey } = credentials;

        this._syncing = true;
        this._notify();

        try {
            // Test credentials with a minimal API call
            const response = await fetch(
                `${this.proxyUrl}/api/zotero/users/${userId}/items?limit=1`,
                { headers: { 'Zotero-API-Key': apiKey } }
            );

            if (!response.ok) {
                throw new Error('Invalid Zotero credentials');
            }

            // Save credentials
            await this._saveConfig(userId, apiKey);
            this.userId = userId;
            this.apiKey = apiKey;
            this._connected = true;
            this._syncing = false;
            this._notify();
            return true;

        } catch (e) {
            this._syncing = false;
            this._notify();
            throw e;
        }
    }

    async disconnect(): Promise<void> {
        await this._clearConfig();
        this.userId = null;
        this.apiKey = null;
        this._connected = false;
        this._itemCount = 0;
        this._notify();
    }

    /**
     * Sync - Clear caches and force fresh data from Zotero API
     * Does not re-download the full library, just clears stale cache
     */
    async sync(): Promise<boolean> {
        if (!this._connected) return false;

        this._syncing = true;
        this._notify();

        try {
            // Clear L1 memory caches
            this._itemCache.clear();
            this._itemCacheByKey.clear();
            this._searchCache.clear();

            // Clear in-flight deduplication (allow new requests)
            this._inFlightSearches.clear();
            this._inFlightItems.clear();

            // Verify connection is still valid with a minimal API call
            const response = await fetch(
                `${this.proxyUrl}/api/zotero/users/${this.userId}/items?limit=1`,
                { headers: { 'Zotero-API-Key': this.apiKey! } }
            );

            if (!response.ok) {
                throw new Error('Zotero sync failed - connection invalid');
            }

            // Update cached item count from filesystem
            this._itemCount = await this._getCachedItemCount();

            this._syncing = false;
            this._notify();
            return true;
        } catch (e) {
            this._syncing = false;
            this._notify();
            throw e;
        }
    }

    // ========================================
    // Search - The core of hybrid approach
    // ========================================

    async search(query: string, limit = 20): Promise<CitationItem[]> {
        if (!this._connected) {
            return [];
        }

        const trimmedQuery = (query || '').trim();

        // Empty query: return recently used items from cache
        if (!trimmedQuery) {
            return this._getRecentlyUsed(limit);
        }

        const cacheKey = `${trimmedQuery}:${limit}`;

        // Check L1 search cache first
        const cached = this._searchCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < this._searchCacheTTL) {
            return cached.results;
        }

        // Check for in-flight request (deduplication)
        if (this._inFlightSearches.has(cacheKey)) {
            return this._inFlightSearches.get(cacheKey)!;
        }

        // Create and track the search promise
        const searchPromise = this._executeSearch(trimmedQuery, limit, cacheKey);
        this._inFlightSearches.set(cacheKey, searchPromise);

        try {
            return await searchPromise;
        } finally {
            this._inFlightSearches.delete(cacheKey);
        }
    }

    private async _executeSearch(query: string, limit: number, cacheKey: string): Promise<CitationItem[]> {
        let results: CitationItem[];

        // Online: use Zotero API server-side search
        if (navigator.onLine) {
            try {
                results = await this._apiSearch(query, limit);
            } catch (e) {
                console.warn('Zotero API search failed, falling back to cache:', e);
                results = await this._searchCached(query, limit);
            }
        } else {
            // Offline: search cached items only
            results = await this._searchCached(query, limit);
        }

        // Populate L1 cache
        this._searchCache.set(cacheKey, { results, timestamp: Date.now() });

        // Also cache individual items for fast lookup
        for (const item of results) {
            this._addToItemCache(item);
        }

        // Lazy prune: only when cache gets large, delete oldest entries
        if (this._searchCache.size > 100) {
            // Delete entries older than TTL, but stop after pruning half
            const now = Date.now();
            let pruned = 0;
            const maxPrune = 50;
            for (const [key, entry] of this._searchCache) {
                if (now - entry.timestamp > this._searchCacheTTL) {
                    this._searchCache.delete(key);
                    if (++pruned >= maxPrune) break;
                }
            }
        }

        return results;
    }

    private async _apiSearch(query: string, limit: number): Promise<CitationItem[]> {
        // Zotero API doesn't reliably support excluding multiple types server-side.
        // Per pyzotero docs, client-side filtering is the recommended approach.
        // Request extra items to account for attachments/notes we'll filter out.
        const fetchLimit = Math.min(limit * 3, 100);
        const url = `${this.proxyUrl}/api/zotero/users/${this.userId}/items?q=${encodeURIComponent(query)}&limit=${fetchLimit}`;

        const response = await fetch(url, {
            headers: { 'Zotero-API-Key': this.apiKey! }
        });

        if (!response.ok) {
            throw new Error(`Zotero API error: ${response.status}`);
        }

        const items: ZoteroApiItem[] = await response.json();

        // Filter out attachments and notes client-side
        const citable = items.filter(item => {
            const itemType = item.data?.itemType;
            return itemType !== 'attachment' && itemType !== 'note';
        });

        return citable.slice(0, limit).map(item => this._normalizeItem(item));
    }

    private async _getRecentlyUsed(limit: number): Promise<CitationItem[]> {
        try {
            if (!await this._ensureMounted()) return [];
            const entries = await fileSystem.readdir(ZOTERO_ITEMS_PATH);
            const jsonFiles = entries.filter(e => e.name.endsWith('.json'));

            // Read all items in parallel
            const items = await Promise.all(
                jsonFiles.map(async (entry) => {
                    try {
                        const content = await fileSystem.readFile(entry.path);
                        return JSON.parse(content) as CitationItem & { usedAt?: number };
                    } catch {
                        return null;
                    }
                })
            );

            // Sort by usedAt descending
            return items
                .filter((item): item is CitationItem & { usedAt: number } => item !== null && typeof item.usedAt === 'number')
                .sort((a, b) => b.usedAt - a.usedAt)
                .slice(0, limit);
        } catch {
            return [];
        }
    }

    private async _searchCached(query: string, limit: number): Promise<CitationItem[]> {
        try {
            const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);

            // First check L1 memory cache for quick results
            const memoryCacheResults: CitationItem[] = [];
            for (const item of this._itemCache.values()) {
                const searchText = (item.searchText || this._buildSearchText(item)).toLowerCase();
                if (terms.every(term => searchText.includes(term))) {
                    memoryCacheResults.push(item);
                    if (memoryCacheResults.length >= limit * 2) break;
                }
            }

            // If we have enough from memory cache, return early
            if (memoryCacheResults.length >= limit) {
                return this._scoreAndSort(memoryCacheResults, terms, limit);
            }

            // Fall back to filesystem scan
            if (!await this._ensureMounted()) {
                return this._scoreAndSort(memoryCacheResults, terms, limit);
            }

            const entries = await fileSystem.readdir(ZOTERO_ITEMS_PATH);
            const jsonFiles = entries.filter(e => e.name.endsWith('.json'));
            const seenKeys = new Set(memoryCacheResults.map(r => r.key));
            const results = [...memoryCacheResults];

            // Read items in parallel
            const items = await Promise.all(
                jsonFiles.map(async (entry) => {
                    try {
                        const content = await fileSystem.readFile(entry.path);
                        return JSON.parse(content) as CitationItem;
                    } catch {
                        return null;
                    }
                })
            );

            for (const item of items) {
                if (!item || seenKeys.has(item.key)) continue;

                const searchText = item.searchText || '';
                if (terms.every(term => searchText.includes(term))) {
                    results.push(item);
                    if (results.length >= limit * 2) break;
                }
            }

            return this._scoreAndSort(results, terms, limit);
        } catch {
            return [];
        }
    }

    private _scoreAndSort(items: CitationItem[], terms: string[], limit: number): CitationItem[] {
        const scored = items.map(item => {
            let score = 0;
            const citeKey = (item.citeKey || '').toLowerCase();
            const title = (item.title || '').toLowerCase();
            const creators = (item.creatorsText || '').toLowerCase();

            for (const term of terms) {
                if (citeKey.includes(term)) score += 100;
                if (creators.includes(term)) score += 50;
                if (title.includes(term)) score += 30;
            }

            return { item, score };
        });

        return scored
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map(s => s.item);
    }

    private async _getCachedItemCount(): Promise<number> {
        try {
            if (!await this._ensureMounted()) return 0;
            const entries = await fileSystem.readdir(ZOTERO_ITEMS_PATH);
            return entries.filter(e => e.name.endsWith('.json')).length;
        } catch {
            return 0;
        }
    }

    // ========================================
    // Item Access
    // ========================================

    async getItem(id: string): Promise<CitationItem | null> {
        // L1: Check memory cache first - move to end for LRU on hit
        if (this._itemCache.has(id)) {
            const cached = this._itemCache.get(id)!;
            this._itemCache.delete(id);
            this._itemCache.set(id, cached);
            return cached;
        }

        // Check for in-flight request (deduplication)
        if (this._inFlightItems.has(id)) {
            return this._inFlightItems.get(id)!;
        }

        const fetchPromise = this._fetchItem(id);
        this._inFlightItems.set(id, fetchPromise);

        try {
            return await fetchPromise;
        } finally {
            this._inFlightItems.delete(id);
        }
    }

    private async _fetchItem(id: string): Promise<CitationItem | null> {
        // L2: Check filesystem cache
        const cached = await this._getCachedItem(id);
        if (cached) {
            this._addToItemCache(cached);
            return cached;
        }

        // Fetch from API if online
        if (!navigator.onLine || !this._connected) return null;

        try {
            const response = await fetch(
                `${this.proxyUrl}/api/zotero/users/${this.userId}/items/${id}`,
                { headers: { 'Zotero-API-Key': this.apiKey! } }
            );

            if (!response.ok) return null;

            const item: ZoteroApiItem = await response.json();
            const normalized = this._normalizeItem(item);
            this._addToItemCache(normalized);
            return normalized;
        } catch {
            return null;
        }
    }

    async getItemByCiteKey(citeKey: string): Promise<CitationItem | null> {
        // L1: Check memory cache by citeKey - move to end for LRU on hit
        if (this._itemCacheByKey.has(citeKey)) {
            const cached = this._itemCacheByKey.get(citeKey)!;
            // Update position in main LRU cache
            if (cached.key && this._itemCache.has(cached.key)) {
                this._itemCache.delete(cached.key);
                this._itemCache.set(cached.key, cached);
            }
            return cached;
        }

        // L2: Check filesystem - parallel read then find match
        try {
            if (!await this._ensureMounted()) return null;
            const entries = await fileSystem.readdir(ZOTERO_ITEMS_PATH);
            const jsonFiles = entries.filter(e => e.name.endsWith('.json'));

            // Read all files in parallel
            const items = await Promise.all(
                jsonFiles.map(async (entry) => {
                    try {
                        const content = await fileSystem.readFile(entry.path);
                        return JSON.parse(content) as CitationItem;
                    } catch {
                        return null;
                    }
                })
            );

            // Find matching item
            const match = items.find(item => item?.citeKey === citeKey);
            if (match) {
                this._addToItemCache(match);
                return match;
            }
            return null;
        } catch {
            return null;
        }
    }

    private async _getCachedItem(key: string): Promise<CitationItem | null> {
        try {
            if (!await this._ensureMounted()) return null;
            const content = await fileSystem.readFile(`${ZOTERO_ITEMS_PATH}/${key}.json`);
            return JSON.parse(content);
        } catch {
            return null;
        }
    }

    /**
     * Add item to L1 memory cache with LRU eviction
     */
    private _addToItemCache(item: CitationItem): void {
        if (!item?.key) return;

        // LRU: delete first to ensure it moves to end on set
        const exists = this._itemCache.has(item.key);
        if (exists) {
            const existing = this._itemCache.get(item.key);
            this._itemCache.delete(item.key);
            if (existing?.citeKey) {
                this._itemCacheByKey.delete(existing.citeKey);
            }
        } else if (this._itemCache.size >= this._cacheMaxSize) {
            // Evict oldest if at capacity and adding new entry
            const firstKey = this._itemCache.keys().next().value;
            const evicted = this._itemCache.get(firstKey!);
            this._itemCache.delete(firstKey!);
            if (evicted?.citeKey) {
                this._itemCacheByKey.delete(evicted.citeKey);
            }
        }

        // Add to both caches
        this._itemCache.set(item.key, item);
        if (item.citeKey) {
            this._itemCacheByKey.set(item.citeKey, item);
        }
    }

    // ========================================
    // Track Used - Cache items user selects
    // ========================================

    async trackUsed(item: CitationItem): Promise<void> {
        try {
            if (!await this._ensureMounted()) return;
            const entry = {
                ...item,
                usedAt: Date.now(),
                searchText: this._buildSearchText(item),
            };
            await fileSystem.writeFile(
                `${ZOTERO_ITEMS_PATH}/${item.key}.json`,
                JSON.stringify(entry)
            );
            this._itemCount++;
            this._notify();
        } catch {
            // Ignore errors
        }
    }

    // ========================================
    // BibTeX Generation
    // ========================================

    getBibtex(item: CitationItem): string {
        const data = (item.data || item) as Record<string, unknown>;
        const key = item.citeKey || this._generateCiteKey(item);

        const typeMap: Record<string, string> = {
            'journalArticle': 'article',
            'book': 'book',
            'bookSection': 'incollection',
            'conferencePaper': 'inproceedings',
            'thesis': 'phdthesis',
            'report': 'techreport',
            'webpage': 'misc',
            'preprint': 'unpublished',
        };

        const bibType = typeMap[data.itemType as string] || 'misc';
        const fields: string[] = [];

        // Authors
        const creators = (data.creators || []) as Array<{
            creatorType?: string;
            firstName?: string;
            lastName?: string;
            name?: string;
        }>;
        const authors = creators
            .filter(c => c.creatorType === 'author' || !c.creatorType)
            .map(c => c.name || `${c.lastName}, ${c.firstName}`)
            .join(' and ');
        if (authors) fields.push(`  author = {${authors}}`);

        // Editors
        const editors = creators
            .filter(c => c.creatorType === 'editor')
            .map(c => c.name || `${c.lastName}, ${c.firstName}`)
            .join(' and ');
        if (editors) fields.push(`  editor = {${editors}}`);

        // Standard fields
        if (data.title) fields.push(`  title = {${data.title}}`);
        if (data.date) {
            const year = (data.date as string).match(/\d{4}/)?.[0];
            if (year) fields.push(`  year = {${year}}`);
        }
        if (data.publicationTitle) fields.push(`  journal = {${data.publicationTitle}}`);
        if (data.bookTitle) fields.push(`  booktitle = {${data.bookTitle}}`);
        if (data.publisher) fields.push(`  publisher = {${data.publisher}}`);
        if (data.place) fields.push(`  address = {${data.place}}`);
        if (data.volume) fields.push(`  volume = {${data.volume}}`);
        if (data.issue) fields.push(`  number = {${data.issue}}`);
        if (data.pages) fields.push(`  pages = {${(data.pages as string).replace('-', '--')}}`);
        if (data.DOI) fields.push(`  doi = {${data.DOI}}`);
        if (data.ISBN) fields.push(`  isbn = {${data.ISBN}}`);
        if (data.ISSN) fields.push(`  issn = {${data.ISSN}}`);
        if (data.url) fields.push(`  url = {${data.url}}`);
        if (data.abstractNote) {
            const abstract = (data.abstractNote as string)
                .replace(/\\/g, '\\textbackslash{}')
                .replace(/[{}]/g, '\\$&')
                .replace(/&/g, '\\&')
                .replace(/%/g, '\\%');
            fields.push(`  abstract = {${abstract}}`);
        }

        return `@${bibType}{${key},\n${fields.join(',\n')}\n}`;
    }

    // ========================================
    // Helpers
    // ========================================

    private _normalizeItem(apiItem: ZoteroApiItem): CitationItem {
        const data = apiItem.data || apiItem;
        const citeKey = this._generateCiteKey(apiItem);

        return {
            key: apiItem.key,
            citeKey,
            title: data.title || '',
            creatorsText: this._creatorsToText(data.creators),
            year: data.date?.match(/\d{4}/)?.[0] || '',
            itemType: data.itemType || 'misc',
            data: data as Record<string, unknown>,
            version: apiItem.version,
            provider: 'zotero',
        };
    }

    private _creatorsToText(creators?: Array<{ firstName?: string; lastName?: string; name?: string }>): string {
        if (!creators || !Array.isArray(creators)) return '';
        return creators.map(c => {
            if (c.name) return c.name;
            return [c.firstName, c.lastName].filter(Boolean).join(' ');
        }).join(' ');
    }

    private _generateCiteKey(item: ZoteroApiItem | CitationItem): string {
        const data = (item as ZoteroApiItem).data || item;
        const creators = (data as ZoteroApiItem['data']).creators || [];
        const date = (data as ZoteroApiItem['data']).date;
        const year = date?.match(/\d{4}/)?.[0] || '';

        let authorPart = '';
        if (creators.length > 0) {
            const first = creators[0];
            authorPart = (first.lastName || first.name || 'unknown').toLowerCase();
            authorPart = authorPart.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            authorPart = authorPart.replace(/[^a-z]/g, '');
        }

        let titlePart = '';
        const title = (data as ZoteroApiItem['data']).title || '';
        const words = title.toLowerCase().split(/\s+/);
        const stopWords = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'for', 'and', 'or', 'to']);
        for (const word of words) {
            const clean = word.replace(/[^a-z]/g, '');
            if (clean.length > 2 && !stopWords.has(clean)) {
                titlePart = clean;
                break;
            }
        }

        return `${authorPart}${year}${titlePart}`.slice(0, 40);
    }

    private _buildSearchText(item: CitationItem): string {
        const parts = [
            item.citeKey || '',
            item.title || '',
            item.creatorsText || '',
            item.year || '',
        ];
        return parts.join(' ').toLowerCase();
    }
}

// ========================================
// Singleton instance
// ========================================

let _instance: ZoteroProvider | null = null;

export function getZoteroProvider(options?: { proxyUrl?: string }): ZoteroProvider {
    if (!_instance) {
        _instance = new ZoteroProvider(options);
    }
    return _instance;
}

export default ZoteroProvider;
