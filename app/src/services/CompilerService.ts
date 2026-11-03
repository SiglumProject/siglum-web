/**
 * CompilerService - LaTeX compilation using BusyTeX
 *
 * Wraps siglum-engine's SiglumCompiler to provide
 * in-browser LaTeX → PDF compilation.
 */

import { SiglumCompiler, detectEngine } from '@siglum/engine';

// Worker is copied from @siglum/engine to public/ by postinstall script
import WORKER_URL from '@siglum/engine/worker?url';

// API endpoint for bundles and WASM
// In development, use local server (serve-local.ts in siglum-engine)
const API_BASE = import.meta.env.VITE_API_BASE
  || (import.meta.env.DEV ? new URL('/engine', window.location.origin).href : 'https://packages.siglum.org');
const RELEASE_ID = import.meta.env.VITE_ENGINE_RELEASE;
const ASSET_BASE = RELEASE_ID ? `${API_BASE}/releases/${RELEASE_ID}` : API_BASE;


export type CompileStatus = 'idle' | 'initializing' | 'compiling' | 'success' | 'error';

export interface CompileResult {
  success: boolean;
  pdf?: Uint8Array;
  syncTexData?: string;
  error?: string;
  log?: string;
  cached?: boolean;
  timeMs?: number;
}

export interface CompilerStats {
  bundles: {
    bundlesCached: number;
    bytesDownloaded: number;
    cacheHits: number;
  };
  ctan: {
    fetchCount: number;
  };
}

type StatusCallback = (status: CompileStatus, detail?: string) => void;
type LogCallback = (message: string) => void;

// Default idle timeout before unloading (5 minutes)
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
// Shorter timeout when tab is hidden (30 seconds)
const HIDDEN_TAB_TIMEOUT_MS = 30 * 1000;

// Memory-aware hot-swap: trigger based on cumulative WASM heap allocation.
// V8 doesn't GC WebAssembly.Memory even after Module is destroyed, so each compile's
// ~143MB WASM heap leaks until the worker is terminated. We sum reported WASM sizes
// across compiles to estimate total leaked memory and swap when it exceeds this threshold.
const MEMORY_THRESHOLD_BYTES = 800 * 1024 * 1024; // 800MB cumulative
// Hard ceiling fallback if memory reporting fails (wasmHeapBytes always 0)
const MAX_COMPILES_FALLBACK = 5;

class CompilerService {
  private compiler: SiglumCompiler | null = null;
  private initPromise: Promise<void> | null = null;
  private statusCallbacks: Set<StatusCallback> = new Set();
  private logCallbacks: Set<LogCallback> = new Set();
  private currentStatus: CompileStatus = 'idle';
  private isInitializing = false;
  private compilePromise: Promise<CompileResult> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private autoUnloadEnabled = true;
  private idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;
  private visibilityHandler: (() => void) | null = null;
  private isTabHidden = false;
  private compileCount = 0;
  private cumulativeWasmBytes = 0;
  private pendingSwap: Promise<void> | null = null;
  private swapInProgress = false;

  constructor() {
    this.setupVisibilityListener();
  }

  private setupVisibilityListener(): void {
    this.visibilityHandler = () => {
      if (!this.autoUnloadEnabled) return;

      const wasHidden = this.isTabHidden;
      this.isTabHidden = document.hidden;

      if (this.isTabHidden && !wasHidden && this.compiler) {
        // Tab just became hidden - start shorter timer
        this.log('Tab hidden - starting 30s unload timer');
        this.resetIdleTimer(HIDDEN_TAB_TIMEOUT_MS);
      } else if (!this.isTabHidden && wasHidden && this.compiler) {
        // Tab just became visible - reset to normal timer
        this.log('Tab visible - resetting to 5min timer');
        this.resetIdleTimer();
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  /**
   * Subscribe to status changes
   */
  onStatus(callback: StatusCallback): () => void {
    this.statusCallbacks.add(callback);
    // Immediately call with current status
    callback(this.currentStatus);
    return () => this.statusCallbacks.delete(callback);
  }

  /**
   * Subscribe to log messages
   */
  onLog(callback: LogCallback): () => void {
    this.logCallbacks.add(callback);
    return () => this.logCallbacks.delete(callback);
  }

  private setStatus(status: CompileStatus, detail?: string) {
    this.currentStatus = status;
    this.statusCallbacks.forEach(cb => cb(status, detail));

    // Reset idle timer when compilation finishes
    if (status === 'idle' || status === 'success' || status === 'error') {
      this.resetIdleTimer();
    } else {
      // Clear timer during active work
      this.clearIdleTimer();
    }
  }

  private log(message: string) {
    // Log memory-related messages to console for debugging
    if (message.includes('[MEMORY]')) {
      console.log(message);
    }
    this.logCallbacks.forEach(cb => cb(message));
  }

  /**
   * Initialize the compiler (lazy - only called when needed)
   */
  async initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    if (this.compiler) return;
    const initialization = this._initialize();
    this.initPromise = initialization;
    try { await initialization; }
    finally { if (this.initPromise === initialization) this.initPromise = null; }
  }

  private async _initialize(): Promise<void> {
    this.isInitializing = true;
    this.setStatus('initializing', 'Loading compiler...');

    try {
      this.compiler = new SiglumCompiler({
        bundlesUrl: `${ASSET_BASE}/bundles`,
        wasmUrl: `${ASSET_BASE}/wasm/busytex.wasm`,
        workerUrl: WORKER_URL,
        ctanProxyUrl: ASSET_BASE,
        xzwasmUrl: `${ASSET_BASE}/xzwasm.js`,
        enableCtan: true,
        enableLazyFS: true,
        enableDocCache: false, // Disabled - causes detached ArrayBuffer errors on doc switch
        eagerBundles: { pdflatex: ['cm-super'] }, // Pre-load cm-super fonts to avoid retry loop
        onLog: (msg: string) => this.log(msg),
        onProgress: (stage: string, detail?: string) => {
          // Only set 'initializing' status during actual initialization
          // (format generation also triggers progress callbacks)
          if (this.isInitializing) {
            this.setStatus('initializing', `${stage}: ${detail || ''}`);
          }
        },
      });

      await this.compiler.init();
      this.isInitializing = false;
      this.setStatus('idle');
      this.log('Compiler ready');
    } catch (error) {
      this.compiler?.terminate();
      this.compiler = null;
      this.isInitializing = false;
      this.setStatus('error', (error as Error).message);
      throw error;
    }
  }

  /**
   * Compile LaTeX source to PDF
   */
  async compile(source: string, options: { engine?: 'pdflatex' | 'xelatex' | 'auto'; additionalFiles?: Record<string, string | Uint8Array>; mainFile?: string } = {}): Promise<CompileResult> {
    const previous = this.compilePromise;
    const task = (async () => {
      if (previous) { try { await previous; } catch { /* next request may recover */ } }
      if (this.pendingSwap) await this.pendingSwap;
      return this._compile(source, options);
    })();
    this.compilePromise = task;
    try { return await task; }
    finally { if (this.compilePromise === task) this.compilePromise = null; }
  }

  private async _compile(source: string, options: { engine?: 'pdflatex' | 'xelatex' | 'auto'; additionalFiles?: Record<string, string | Uint8Array>; mainFile?: string } = {}): Promise<CompileResult> {
    const startTime = performance.now();

    try {
      // Initialize if needed
      await this.initialize();

      if (!this.compiler) {
        throw new Error('Compiler not initialized');
      }

      this.setStatus('compiling', 'Compiling...');

      // Auto-detect engine if not specified
      const engine = options.engine === 'auto' || !options.engine
        ? detectEngine(source)
        : options.engine;

      const result = await this.compiler.compile(source, { engine, additionalFiles: options.additionalFiles, mainFile: options.mainFile });
      // Use the actual TeX compile time from the worker, not the round-trip time
      const stats = result.stats as { compileTimeMs?: number } | undefined;
      const roundTrip = performance.now() - startTime;
      const workerTime = stats?.compileTimeMs;
      const timeMs = workerTime ?? roundTrip;
      console.log(`[Compile] worker: ${workerTime?.toFixed(0) ?? 'N/A'}ms, roundTrip: ${roundTrip.toFixed(0)}ms, displayed: ${timeMs.toFixed(0)}ms`);

      // Track memory for hot-swap decisions regardless of compile success/failure.
      // Failed compiles still allocate a WASM Module and leak its memory.
      this.compileCount++;
      const mem = (result.stats as { memory?: { wasmHeapBytes?: number; jsHeapUsedBytes?: number | null } })?.memory;
      if (mem?.wasmHeapBytes) {
        this.cumulativeWasmBytes += mem.wasmHeapBytes;
      }
      const cumMB = (this.cumulativeWasmBytes / 1024 / 1024).toFixed(0);
      const wasmMB = mem?.wasmHeapBytes ? (mem.wasmHeapBytes / 1024 / 1024).toFixed(0) : '?';
      const jsMB = mem?.jsHeapUsedBytes ? (mem.jsHeapUsedBytes / 1024 / 1024).toFixed(0) : 'N/A';
      this.log(`[MEMORY] Compile #${this.compileCount}: WASM=${wasmMB}MB (cumulative ${cumMB}MB), JS heap=${jsMB}MB`);

      let shouldSwap = false;
      let reason = '';

      // Primary: cumulative WASM memory exceeds threshold.
      // Each compile creates a fresh Module (~143MB), but V8 doesn't GC the old
      // WebAssembly.Memory backing stores, so total leaked memory = sum of all compiles.
      if (this.cumulativeWasmBytes >= MEMORY_THRESHOLD_BYTES) {
        shouldSwap = true;
        reason = `cumulative WASM ${cumMB}MB >= ${MEMORY_THRESHOLD_BYTES / 1024 / 1024}MB`;
      }
      // Fallback: hard compile count ceiling (memory reporting may have failed)
      if (!shouldSwap && this.compileCount >= MAX_COMPILES_FALLBACK) {
        shouldSwap = true;
        reason = `compile count ${this.compileCount} (fallback)`;
      }

      if (shouldSwap) {
        this.log(`[MEMORY] Hot-swap triggered: ${reason}`);
        this.compileCount = 0;
        this.cumulativeWasmBytes = 0;
        this.pendingSwap = this.hotSwapWorker();
        this.pendingSwap.finally(() => { this.pendingSwap = null; });
      }

      if (result.success) {
        this.setStatus('success');
        // Clear bundle memory cache to reduce main thread memory usage.
        // Bundles are still cached on disk and will reload quickly.
        // Guard: this optimization must never discard a successful compile's PDF.
        try {
          this.compiler.clearBundleMemoryCache?.();
        } catch (e) {
          this.log('clearBundleMemoryCache failed (non-fatal): ' + (e as Error).message);
        }

        return {
          success: true,
          pdf: result.pdf,
          syncTexData: result.syncTexData ?? undefined,
          cached: result.cached,
          log: result.log,
          timeMs,
        };
      } else {
        this.setStatus('error', result.error);
        return {
          success: false,
          error: result.error,
          log: result.log,
          timeMs,
        };
      }
    } catch (error) {
      const timeMs = performance.now() - startTime;
      this.setStatus('error', (error as Error).message);
      this.log('Compile error: ' + (error as Error).message);
      return {
        success: false,
        error: (error as Error).message,
        timeMs,
      };
    }
  }

  /**
   * Get compilation statistics
   */
  getStats(): CompilerStats | null {
    if (!this.compiler) return null;
    return this.compiler.getStats();
  }

  /**
   * Clear all caches
   */
  async clearCache(): Promise<void> {
    // Wait for any pending hot-swap to complete
    if (this.pendingSwap) {
      await this.pendingSwap;
    }
    if (this.compiler) {
      await this.compiler.clearCache();
      this.log('Cache cleared');
    }
  }

  /**
   * Generate a format file (pre-compiled preamble) for faster subsequent compiles
   */
  async generateFormat(source: string, options: { engine?: 'pdflatex' | 'xelatex' | 'auto' } = {}): Promise<boolean> {
    // Wait for any pending hot-swap to complete
    if (this.pendingSwap) {
      await this.pendingSwap;
    }
    try {
      await this.initialize();

      if (!this.compiler) {
        throw new Error('Compiler not initialized');
      }

      // Auto-detect engine if not specified
      const engine = options.engine === 'auto' || !options.engine
        ? detectEngine(source)
        : options.engine;

      // XeTeX cannot dump formats with native fonts - skip gracefully
      if (engine === 'xelatex') {
        this.log('Format caching not available for XeTeX (native fonts cannot be serialized)');
        return false;
      }

      this.log('Generating format for ' + engine + '...');
      await this.compiler.generateFormat(source, { engine });
      this.log('Format generated successfully');
      return true;
    } catch (error) {
      this.log('Format generation error: ' + (error as Error).message);
      return false;
    }
  }

  /**
   * Get current status
   */
  getStatus(): CompileStatus {
    return this.currentStatus;
  }

  /**
   * Check if compiler is ready
   */
  isReady(): boolean {
    return this.compiler !== null;
  }

  /**
   * Check if compiler is currently loaded in memory
   */
  isLoaded(): boolean {
    return this.compiler?.isLoaded() ?? false;
  }

  /**
   * Unload compiler to free memory (~500-800MB)
   * Disk caches are preserved for offline use.
   */
  unload(): void {
    this.clearIdleTimer();
    if (this.compiler) {
      // Log memory before (Chrome only)
      const memBefore = (performance as any).memory?.usedJSHeapSize;

      this.compiler.unload();
      this.compiler = null;
      this.initPromise = null;

      // Log memory after (note: GC may not have run yet)
      const memAfter = (performance as any).memory?.usedJSHeapSize;
      if (memBefore && memAfter) {
        const savedMB = (memBefore - memAfter) / 1024 / 1024;
        this.log(`Compiler unloaded (JS heap: ${savedMB.toFixed(1)}MB freed, GC pending for WASM/worker)`);
      } else {
        this.log('Compiler unloaded to free memory');
      }
    }
  }

  /**
   * Hot-swap the compiler to free WASM memory without user-visible delay.
   * Creates new instance, waits for ready, then atomically swaps.
   */
  private async hotSwapWorker(): Promise<void> {
    // Prevent concurrent swaps
    if (this.swapInProgress || !this.compiler) {
      return;
    }

    // Don't swap during active compilation
    if (this.currentStatus === 'compiling' || this.currentStatus === 'initializing') {
      return;
    }

    this.swapInProgress = true;

    // Capture old compiler BEFORE any async operations
    const oldCompiler = this.compiler;

    this.log('[MEMORY] Hot-swap: creating new compiler instance');

    // Track new compiler for cleanup on failure
    let newCompiler: SiglumCompiler | null = null;

    try {
      const startTime = performance.now();

      // Create new compiler with same configuration
      newCompiler = new SiglumCompiler({
        bundlesUrl: `${ASSET_BASE}/bundles`,
        wasmUrl: `${ASSET_BASE}/wasm/busytex.wasm`,
        workerUrl: WORKER_URL,
        ctanProxyUrl: ASSET_BASE,
        xzwasmUrl: `${ASSET_BASE}/xzwasm.js`,
        enableCtan: true,
        enableLazyFS: true,
        enableDocCache: false,
        eagerBundles: { pdflatex: ['cm-super'] },
        onLog: (msg: string) => this.log(msg),
        onProgress: () => {}, // Silent during background swap
      });

      // Start init (but don't await yet)
      const initPromise = newCompiler.init();

      // Immediately unload old compiler to minimize memory overlap
      // This is safe because compile() waits for pendingSwap before proceeding
      // Memory optimization: reduces peak from 2x to ~1.2x during swap
      this.compiler = null;
      this.initPromise = null;
      oldCompiler.unload();
      this.log('[MEMORY] Hot-swap: old compiler terminated, waiting for new');

      // Now wait for new compiler to be ready
      await initPromise;

      const elapsed = (performance.now() - startTime).toFixed(0);
      this.log(`[MEMORY] Hot-swap: new compiler ready in ${elapsed}ms`);

      // Assign new compiler
      this.compiler = newCompiler;
      newCompiler = null; // Prevent cleanup in catch

    } catch (error) {
      this.log(`[MEMORY] Hot-swap failed: ${(error as Error).message}`);
      // Clean up partially initialized compiler to prevent memory leak
      if (newCompiler) {
        try { newCompiler.unload(); } catch { /* ignore cleanup errors */ }
      }
      // this.compiler is already null; next compile() will trigger full re-init via initialize()
    } finally {
      this.swapInProgress = false;
    }
  }

  /**
   * Enable/disable auto-unload when idle
   */
  setAutoUnload(enabled: boolean): void {
    this.autoUnloadEnabled = enabled;
    if (!enabled) {
      this.clearIdleTimer();
    } else if (this.currentStatus === 'idle' || this.currentStatus === 'success') {
      this.resetIdleTimer();
    }
    this.log(`Auto-unload ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Get auto-unload setting
   */
  getAutoUnload(): boolean {
    return this.autoUnloadEnabled;
  }

  /**
   * Set idle timeout before auto-unload (in milliseconds)
   */
  setIdleTimeout(ms: number): void {
    this.idleTimeoutMs = ms;
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private resetIdleTimer(customTimeoutMs?: number): void {
    this.clearIdleTimer();
    if (this.autoUnloadEnabled && this.compiler) {
      const timeout = customTimeoutMs ?? this.idleTimeoutMs;
      const timeoutSec = Math.round(timeout / 1000);
      this.log(`Idle timer set: ${timeoutSec}s`);
      this.idleTimer = setTimeout(() => {
        if (this.currentStatus === 'idle' || this.currentStatus === 'success' || this.currentStatus === 'error') {
          this.log('Idle timeout reached - unloading compiler');
          this.unload();
        }
      }, timeout);
    }
  }
}

const compilerService = new CompilerService();

// HMR cleanup: terminate old worker when module is hot-reloaded
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    compilerService.unload();
  });
}

export default compilerService;
