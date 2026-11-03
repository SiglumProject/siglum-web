// CitationProvider - Base class for citation providers
// Subclasses: ZoteroProvider, BibtexProvider, MendeleyProvider (future)

export interface ProviderStatus {
    connected: boolean;
    syncing: boolean;
    itemCount: number;
    userId?: string | null;
}

export interface CitationItem {
    key: string;
    citeKey: string;
    title: string;
    creatorsText: string;
    year: string;
    itemType: string;
    provider: string;
    data?: Record<string, unknown>;
    searchText?: string;
    usedAt?: number;
    version?: number;
}

export interface ProviderOptions {
    id?: string;
    name?: string;
    proxyUrl?: string;
}

export interface ConnectCredentials {
    userId: string;
    apiKey: string;
}

/**
 * Base class for citation providers.
 * All providers must implement search, getItem, and getBibtex methods.
 */
export class CitationProvider {
    id: string;
    name: string;
    proxyUrl: string;

    constructor(options: ProviderOptions = {}) {
        this.id = options.id || 'unknown';
        this.name = options.name || 'Unknown Provider';
        this.proxyUrl = options.proxyUrl || '';
    }

    /**
     * Check if this provider is connected/ready
     */
    isConnected(): boolean {
        return false;
    }

    /**
     * Get current status
     */
    getStatus(): ProviderStatus {
        return {
            connected: false,
            syncing: false,
            itemCount: 0,
        };
    }

    /**
     * Subscribe to status changes
     */
    onStatus(callback: (status: ProviderStatus) => void): () => void {
        // Base implementation - override in subclasses
        callback(this.getStatus());
        return () => {};
    }

    /**
     * Search for citations
     */
    async search(_query: string, _limit = 20): Promise<CitationItem[]> {
        throw new Error('search() must be implemented by subclass');
    }

    /**
     * Get a single citation by ID
     */
    async getItem(_id: string): Promise<CitationItem | null> {
        throw new Error('getItem() must be implemented by subclass');
    }

    /**
     * Get a citation by its cite key
     */
    async getItemByCiteKey(_citeKey: string): Promise<CitationItem | null> {
        throw new Error('getItemByCiteKey() must be implemented by subclass');
    }

    /**
     * Generate BibTeX for a citation
     */
    getBibtex(_item: CitationItem): string {
        throw new Error('getBibtex() must be implemented by subclass');
    }

    /**
     * Track that a citation has been used (for caching/bibliography)
     */
    async trackUsed(_item: CitationItem): Promise<void> {
        // Override in subclasses that support caching
    }

    /**
     * Connect to the provider with credentials
     */
    async connect(_credentials: ConnectCredentials): Promise<boolean> {
        throw new Error('connect() must be implemented by subclass');
    }

    /**
     * Disconnect from the provider
     */
    async disconnect(): Promise<void> {
        throw new Error('disconnect() must be implemented by subclass');
    }

    /**
     * Initialize from saved configuration
     */
    async init(): Promise<boolean> {
        return false;
    }

    /**
     * Sync - refresh data from remote source
     */
    async sync(): Promise<boolean> {
        return false;
    }
}
