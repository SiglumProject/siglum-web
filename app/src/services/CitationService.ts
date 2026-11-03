/**
 * CitationService - Thin wrapper for citation providers
 *
 * Uses the local citation system and provides React-friendly hooks and utilities.
 */

import {
  getZoteroProvider,
  initCitations,
  type ZoteroProvider,
  type CitationManager,
} from '../lib/citations';

// API endpoint for Zotero proxy
const API_BASE = import.meta.env.VITE_API_BASE
  || (import.meta.env.DEV ? new URL('/citations', window.location.origin).href.replace(/\/$/, '') : 'https://packages.siglum.org');

// Types for UI
export interface ZoteroStatus {
  connected: boolean;
  syncing: boolean;
  itemCount: number;
  userId: string | null;
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
}

export interface CitationServiceStatus {
  zotero: ZoteroStatus;
  connectedCount: number;
  usedCitationsCount: number;
}

class CitationService {
  private manager: CitationManager;
  private zotero: ZoteroProvider;
  private _initialized = false;
  private _statusSubscribers: Set<(status: CitationServiceStatus) => void> = new Set();

  constructor() {
    // Initialize citation system with API proxy
    this.manager = initCitations({ proxyUrl: API_BASE });
    this.zotero = getZoteroProvider({ proxyUrl: API_BASE });

    // Forward status updates
    this.zotero.onStatus(() => this._notifySubscribers());
    this.manager.onStatus(() => this._notifySubscribers());
  }

  // ========================================
  // Initialization
  // ========================================

  async init(): Promise<boolean> {
    if (this._initialized) return true;

    try {
      const connected = await this.zotero.init();
      this._initialized = true;
      return connected;
    } catch {
      this._initialized = true;
      return false;
    }
  }

  // ========================================
  // Zotero Connection
  // ========================================

  async connectZotero(userId: string, apiKey: string): Promise<boolean> {
    try {
      await this.zotero.connect({ userId, apiKey });
      return true;
    } catch (e) {
      console.error('Zotero connect failed:', e);
      throw e;
    }
  }

  async disconnectZotero(): Promise<void> {
    await this.zotero.disconnect();
  }

  async syncZotero(): Promise<boolean> {
    return this.zotero.sync();
  }

  isZoteroConnected(): boolean {
    return this.zotero.isConnected();
  }

  getZoteroStatus(): ZoteroStatus {
    return this.zotero.getStatus() as ZoteroStatus;
  }

  // ========================================
  // Search
  // ========================================

  async search(query: string, limit = 20): Promise<CitationItem[]> {
    return this.manager.search(query, limit) as Promise<CitationItem[]>;
  }

  async searchZotero(query: string, limit = 20): Promise<CitationItem[]> {
    if (!this.zotero.isConnected()) return [];
    return this.zotero.search(query, limit) as Promise<CitationItem[]>;
  }

  // ========================================
  // Citation Tracking
  // ========================================

  async trackCitation(item: CitationItem): Promise<void> {
    await this.manager.trackCitation(item);
  }

  getTrackedCitations(): CitationItem[] {
    return this.manager.getTrackedCitations() as CitationItem[];
  }

  // ========================================
  // Bibliography Generation
  // ========================================

  generateBibliography(): string {
    return this.manager.generateBibliography();
  }

  getBibliographyForKeys(citeKeys: string[]): string {
    return this.manager.getBibliographyForKeys(citeKeys);
  }

  async injectBibliography(source: string): Promise<string> {
    return this.manager.injectBibliography(source);
  }

  // ========================================
  // BibTeX for single item
  // ========================================

  getBibtex(item: CitationItem): string {
    return this.zotero.getBibtex(item);
  }

  // ========================================
  // Status Subscription
  // ========================================

  getStatus(): CitationServiceStatus {
    const zoteroStatus = this.zotero.getStatus() as ZoteroStatus;
    const managerStatus = this.manager.getStatus();

    return {
      zotero: zoteroStatus,
      connectedCount: managerStatus.connectedCount,
      usedCitationsCount: managerStatus.usedCitationsCount,
    };
  }

  onStatus(callback: (status: CitationServiceStatus) => void): () => void {
    this._statusSubscribers.add(callback);
    // Immediately call with current status
    callback(this.getStatus());
    return () => this._statusSubscribers.delete(callback);
  }

  private _notifySubscribers(): void {
    const status = this.getStatus();
    this._statusSubscribers.forEach(cb => cb(status));
  }
}

// Singleton instance
const citationService = new CitationService();

// Initialize on module load
citationService.init().catch(() => {
  // Silent fail on init - user hasn't connected yet
});

export default citationService;
