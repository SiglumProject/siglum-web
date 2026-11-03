// CitationManager - Orchestrates multiple citation providers
// Handles unified search, bibliography generation, and provider management

import { CitationProvider } from './provider';
import type { CitationItem } from './provider';

export interface ManagerStatus {
    providers: Record<string, { connected: boolean; syncing: boolean; itemCount: number }>;
    connectedCount: number;
    usedCitationsCount: number;
}

/**
 * CitationManager - Central orchestrator for citation providers
 *
 * Features:
 * - Register multiple providers (Zotero, BibTeX, Mendeley, etc.)
 * - Unified search across all connected providers
 * - Track used citations for bibliography generation
 * - Memory-efficient: only stores citation keys user actually uses
 */
export class CitationManager {
    providers: Map<string, CitationProvider>;
    usedCitations: Map<string, CitationItem>;
    private _subscribers: Set<(status: ManagerStatus) => void>;

    constructor() {
        this.providers = new Map();
        this.usedCitations = new Map(); // citeKey -> item (only used citations)
        this._subscribers = new Set();
    }

    // ========================================
    // Provider Management
    // ========================================

    /**
     * Register a citation provider
     */
    registerProvider(id: string, provider: CitationProvider): void {
        this.providers.set(id, provider);
        this._notify();
    }

    /**
     * Unregister a provider
     */
    unregisterProvider(id: string): void {
        this.providers.delete(id);
        this._notify();
    }

    /**
     * Get a provider by ID
     */
    getProvider(id: string): CitationProvider | undefined {
        return this.providers.get(id);
    }

    /**
     * Get all registered providers
     */
    getAllProviders(): Map<string, CitationProvider> {
        return this.providers;
    }

    /**
     * Get all connected providers
     */
    getConnectedProviders(): CitationProvider[] {
        return [...this.providers.values()].filter(p => p.isConnected());
    }

    // ========================================
    // Status & Subscription
    // ========================================

    getStatus(): ManagerStatus {
        const providerStatuses: Record<string, { connected: boolean; syncing: boolean; itemCount: number }> = {};
        for (const [id, provider] of this.providers) {
            providerStatuses[id] = provider.getStatus();
        }

        return {
            providers: providerStatuses,
            connectedCount: this.getConnectedProviders().length,
            usedCitationsCount: this.usedCitations.size,
        };
    }

    onStatus(callback: (status: ManagerStatus) => void): () => void {
        this._subscribers.add(callback);
        callback(this.getStatus());
        return () => this._subscribers.delete(callback);
    }

    private _notify(): void {
        const status = this.getStatus();
        this._subscribers.forEach(cb => cb(status));
    }

    // ========================================
    // Unified Search
    // ========================================

    /**
     * Search across all connected providers
     */
    async search(query: string, limit = 20): Promise<CitationItem[]> {
        const connected = this.getConnectedProviders();

        if (connected.length === 0) {
            return [];
        }

        // Search all providers in parallel
        const resultsArrays = await Promise.all(
            connected.map(provider =>
                provider.search(query, limit).catch(err => {
                    console.warn(`Search failed for ${provider.id}:`, err);
                    return [];
                })
            )
        );

        // Flatten and merge
        const allResults = resultsArrays.flat();

        // Dedupe by citeKey (prefer first occurrence)
        const seen = new Set<string>();
        const deduped = allResults.filter(item => {
            if (seen.has(item.citeKey)) return false;
            seen.add(item.citeKey);
            return true;
        });

        // Return up to limit results
        return deduped.slice(0, limit);
    }

    // ========================================
    // Citation Tracking
    // ========================================

    /**
     * Track a citation as used (for bibliography generation)
     */
    async trackCitation(item: CitationItem): Promise<void> {
        if (!item.citeKey) {
            console.warn('Cannot track citation without citeKey:', item);
            return;
        }

        // Store in our used citations map
        this.usedCitations.set(item.citeKey, item);

        // Also tell the provider to cache it (for offline access)
        const provider = this.providers.get(item.provider);
        if (provider?.trackUsed) {
            await provider.trackUsed(item);
        }

        this._notify();
    }

    /**
     * Remove a citation from tracking
     */
    untrackCitation(citeKey: string): void {
        this.usedCitations.delete(citeKey);
        this._notify();
    }

    /**
     * Clear all tracked citations
     */
    clearTrackedCitations(): void {
        this.usedCitations.clear();
        this._notify();
    }

    /**
     * Get all tracked citations
     */
    getTrackedCitations(): CitationItem[] {
        return [...this.usedCitations.values()];
    }

    /**
     * Check if a citation is tracked
     */
    isCitationTracked(citeKey: string): boolean {
        return this.usedCitations.has(citeKey);
    }

    // ========================================
    // Bibliography Generation
    // ========================================

    /**
     * Generate BibTeX for all tracked citations
     */
    generateBibliography(): string {
        const entries: string[] = [];

        for (const item of this.usedCitations.values()) {
            const provider = this.providers.get(item.provider);
            if (provider) {
                try {
                    const bibtex = provider.getBibtex(item);
                    entries.push(bibtex);
                } catch (err) {
                    console.warn(`Failed to generate BibTeX for ${item.citeKey}:`, err);
                }
            }
        }

        return entries.join('\n\n');
    }

    /**
     * Generate BibTeX for specific citation keys
     */
    getBibliographyForKeys(citeKeys: string[]): string {
        const keySet = new Set(citeKeys);
        const entries: string[] = [];

        for (const item of this.usedCitations.values()) {
            if (keySet.has(item.citeKey)) {
                const provider = this.providers.get(item.provider);
                if (provider) {
                    try {
                        const bibtex = provider.getBibtex(item);
                        entries.push(bibtex);
                    } catch (err) {
                        console.warn(`Failed to generate BibTeX for ${item.citeKey}:`, err);
                    }
                }
            }
        }

        return entries.join('\n\n');
    }

    // ========================================
    // Item Access
    // ========================================

    /**
     * Get a citation by its cite key (from tracked citations)
     */
    getCitationByCiteKey(citeKey: string): CitationItem | null {
        return this.usedCitations.get(citeKey) || null;
    }

    /**
     * Get a citation by its cite key, searching providers if needed
     */
    async findCitationByCiteKey(citeKey: string): Promise<CitationItem | null> {
        // Check tracked first
        if (this.usedCitations.has(citeKey)) {
            return this.usedCitations.get(citeKey)!;
        }

        // Search providers
        for (const provider of this.getConnectedProviders()) {
            try {
                const item = await provider.getItemByCiteKey(citeKey);
                if (item) return item;
            } catch {
                // Continue to next provider
            }
        }

        return null;
    }

    // ========================================
    // Document Integration
    // ========================================

    /**
     * Extract cite keys from LaTeX source and ensure they're tracked
     */
    async extractAndTrackCitations(source: string): Promise<string[]> {
        // Match \cite{key}, \cite{key1,key2}, \citep{key}, \citet{key}, etc.
        const citeRegex = /\\cite[pt]?\{([^}]+)\}/g;
        const foundKeys = new Set<string>();

        let match;
        while ((match = citeRegex.exec(source)) !== null) {
            // Split on comma for multiple citations
            const keys = match[1].split(',').map(k => k.trim());
            keys.forEach(k => foundKeys.add(k));
        }

        // Find and track any untracked citations
        for (const key of foundKeys) {
            if (!this.usedCitations.has(key)) {
                const item = await this.findCitationByCiteKey(key);
                if (item) {
                    await this.trackCitation(item);
                }
            }
        }

        return [...foundKeys];
    }

    /**
     * Inject bibliography into LaTeX source for compilation
     * Called before compiling to ensure all citations have BibTeX entries
     */
    async injectBibliography(source: string): Promise<string> {
        // Extract all citation keys from source
        const citeKeys = await this.extractAndTrackCitations(source);

        if (citeKeys.length === 0) {
            return source;
        }

        // Generate bibliography content
        const bibContent = this.getBibliographyForKeys(citeKeys);

        if (!bibContent) {
            return source;
        }

        // Check if source already has \bibliography command
        if (source.includes('\\bibliography{')) {
            // Source has its own bibliography - don't interfere
            return source;
        }

        // Inject inline bibliography using filecontents
        // This approach doesn't require external file access
        const filecontents = `
% Auto-generated bibliography from citation providers
\\begin{filecontents}{references.bib}
${bibContent}
\\end{filecontents}
`;

        // Insert after \documentclass or at the beginning
        const documentclassMatch = source.match(/\\documentclass[^{]*\{[^}]+\}/);
        if (documentclassMatch) {
            const insertPos = documentclassMatch.index! + documentclassMatch[0].length;
            return source.slice(0, insertPos) + '\n' + filecontents + source.slice(insertPos);
        }

        // Fallback: prepend
        return filecontents + source;
    }
}

// ========================================
// Singleton instance
// ========================================

let _instance: CitationManager | null = null;

export function getCitationManager(): CitationManager {
    if (!_instance) {
        _instance = new CitationManager();
    }
    return _instance;
}

export default CitationManager;
