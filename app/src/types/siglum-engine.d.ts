declare module 'siglum-engine' {
  export interface CompilerOptions {
    bundlesUrl?: string;
    wasmUrl?: string;
    xzwasmUrl?: string;
    workerUrl?: string;
    ctanProxyUrl?: string;
    enableCtan?: boolean;
    enableLazyFS?: boolean;
    enableDocCache?: boolean;
    onLog?: (msg: string) => void;
    onProgress?: (stage: string, detail?: string) => void;
  }

  export interface CompileOptions {
    engine?: 'pdflatex' | 'xelatex';
    useCache?: boolean;
    additionalFiles?: Record<string, string | Uint8Array>;
  }

  export interface CompileResult {
    success: boolean;
    pdf?: Uint8Array;
    error?: string;
    log?: string;
    cached?: boolean;
    stats?: Record<string, unknown>;
    exitCode?: number;
  }

  export interface BundleStats {
    bundlesCached: number;
    bytesDownloaded: number;
    cacheHits: number;
  }

  export interface CTANStats {
    fetchCount: number;
  }

  export interface CompilerStats {
    bundles: BundleStats;
    ctan: CTANStats;
  }

  export class SiglumCompiler {
    constructor(options?: CompilerOptions);
    init(): Promise<void>;
    compile(source: string, options?: CompileOptions): Promise<CompileResult>;
    generateFormat(source: string, options?: { engine?: string }): Promise<Uint8Array>;
    clearCache(): Promise<void>;
    clearBundleMemoryCache(): void;
    getStats(): CompilerStats;
    terminate(): void;
    unload(): void;
    isLoaded(): boolean;
    enableCtan: boolean;
    enableLazyFS: boolean;
    enableDocCache: boolean;
  }

  // Backwards-compatible alias
  export const BusyTeXCompiler: typeof SiglumCompiler;

  export function detectEngine(source: string): 'pdflatex' | 'xelatex';
  export function extractPreamble(source: string): string | null;
  export function hashPreamble(preamble: string): string;
  export function hashDocument(source: string): string;
  export function clearCTANCache(): Promise<void>;
  export function getCachedPdf(hash: string, engine: string): Promise<ArrayBuffer | null>;
  export function saveCachedPdf(hash: string, engine: string, data: ArrayBuffer): Promise<void>;
  export function listAllCachedPackages(): Promise<string[]>;

  // Citation system
  export interface CitationItem {
    key: string;
    citeKey: string;
    title: string;
    creatorsText: string;
    year: string;
    itemType: string;
    provider: string;
    data?: Record<string, unknown>;
  }

  export interface ZoteroStatus {
    connected: boolean;
    syncing: boolean;
    itemCount: number;
    userId: string | null;
  }

  export interface CitationManagerStatus {
    connectedCount: number;
    usedCitationsCount: number;
  }

  export interface ZoteroProvider {
    init(): Promise<boolean>;
    connect(config: { userId: string; apiKey: string }): Promise<void>;
    disconnect(): Promise<void>;
    isConnected(): boolean;
    getStatus(): ZoteroStatus;
    search(query: string, limit?: number): Promise<CitationItem[]>;
    getBibtex(item: CitationItem): string;
    onStatus(callback: (status: ZoteroStatus) => void): () => void;
  }

  export interface CitationManager {
    search(query: string, limit?: number): Promise<CitationItem[]>;
    trackCitation(item: CitationItem): Promise<void>;
    getTrackedCitations(): CitationItem[];
    generateBibliography(): string;
    getBibliographyForKeys(citeKeys: string[]): string;
    injectBibliography(source: string): Promise<string>;
    getStatus(): CitationManagerStatus;
    onStatus(callback: (status: CitationManagerStatus) => void): () => void;
  }

  export function getZoteroProvider(config?: { proxyUrl?: string }): ZoteroProvider;
  export function getCitationManager(): CitationManager;
  export function initCitations(config?: { proxyUrl?: string }): CitationManager;
  export const CitationProvider: unknown;
}
