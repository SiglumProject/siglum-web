// Citations module - Unified citation provider system
//
// This module provides a provider-agnostic citation system with:
// - Memory-efficient search (API-based for Zotero, indexed for BibTeX)
// - Hybrid caching (online API search, offline cached items)
// - Unified search across multiple providers
// - Bibliography generation for LaTeX compilation

// Types
export type { CitationItem, ProviderStatus, ProviderOptions, ConnectCredentials } from './provider';
export type { ManagerStatus } from './manager';

// Base provider class
export { CitationProvider } from './provider';

// Zotero provider
export { ZoteroProvider, getZoteroProvider } from './zotero';

// Citation manager (orchestrator)
export { CitationManager, getCitationManager } from './manager';

// Re-export default instances for convenience
import { getZoteroProvider } from './zotero';
import { getCitationManager, CitationManager } from './manager';

/**
 * Initialize the citation system with default providers
 */
export function initCitations(options: { proxyUrl?: string } = {}): CitationManager {
    const manager = getCitationManager();

    // Register Zotero provider
    const zotero = getZoteroProvider({
        proxyUrl: options.proxyUrl || 'http://localhost:8787',
    });
    manager.registerProvider('zotero', zotero);

    // Initialize Zotero from saved config
    zotero.init().catch(() => {
        // No saved config or init failed - that's OK
    });

    return manager;
}
