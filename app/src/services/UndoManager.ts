/**
 * UndoManager - Differential undo/redo with operational transforms
 *
 * Instead of storing full document copies, stores text diffs (patches)
 * which reduces memory usage by ~98% for large documents.
 *
 * Before: 100KB doc × 100 states = 10MB per document
 * After:  100KB doc + 100 × ~500 bytes avg diff = 150KB per document
 */

import type { UndoState } from '../types/Document'

const MAX_HISTORY = 100

// ========================================
// Patch Types
// ========================================

interface Patch {
  /** Position in the source string */
  pos: number
  /** Number of characters to delete */
  del: number
  /** Text to insert */
  ins: string
}

interface UndoDiff {
  /** Patches to apply for undo (new→old) */
  reverse: Patch[]
  /** Cursor position before the change */
  cursorPosition: { start: number; end: number }
  /** Timestamp of the change */
  timestamp: number
}

interface RedoDiff {
  /** Patches to apply for redo (old→new) */
  forward: Patch[]
  /** Cursor position after the change */
  cursorPosition: { start: number; end: number }
  /** Timestamp of the change */
  timestamp: number
}

interface DocumentUndoState {
  /** Current document content (always kept up to date) */
  currentContent: string
  /** Undo stack - contains diffs to revert changes */
  undoStack: UndoDiff[]
  /** Redo stack - contains diffs to reapply changes */
  redoStack: RedoDiff[]
  /** Content at last save point (for change detection) */
  lastSavedContent: string
}

// ========================================
// Diff Algorithm (Simple LCS-based)
// ========================================

/**
 * Compute patches to transform `oldStr` into `newStr`
 * Uses a simple character-by-character diff that produces
 * reasonably compact patches for typical text edits.
 */
function computeDiff(oldStr: string, newStr: string): Patch[] {
  if (oldStr === newStr) return []

  // Fast path: simple insertion at end
  if (newStr.startsWith(oldStr)) {
    return [{ pos: oldStr.length, del: 0, ins: newStr.slice(oldStr.length) }]
  }

  // Fast path: simple deletion at end
  if (oldStr.startsWith(newStr)) {
    return [{ pos: newStr.length, del: oldStr.length - newStr.length, ins: '' }]
  }

  // Fast path: find common prefix and suffix
  let prefixLen = 0
  const minLen = Math.min(oldStr.length, newStr.length)
  while (prefixLen < minLen && oldStr[prefixLen] === newStr[prefixLen]) {
    prefixLen++
  }

  let suffixLen = 0
  while (
    suffixLen < minLen - prefixLen &&
    oldStr[oldStr.length - 1 - suffixLen] === newStr[newStr.length - 1 - suffixLen]
  ) {
    suffixLen++
  }

  const oldMiddle = oldStr.slice(prefixLen, oldStr.length - suffixLen)
  const newMiddle = newStr.slice(prefixLen, newStr.length - suffixLen)

  // Single patch for the differing middle section
  if (oldMiddle.length > 0 || newMiddle.length > 0) {
    return [{ pos: prefixLen, del: oldMiddle.length, ins: newMiddle }]
  }

  return []
}

/**
 * Apply patches to a string to produce a new string
 */
function applyPatches(content: string, patches: Patch[]): string {
  // Fast path: single patch (most common case)
  if (patches.length === 1) {
    const p = patches[0]
    return content.slice(0, p.pos) + p.ins + content.slice(p.pos + p.del)
  }

  if (patches.length === 0) return content

  // Multiple patches: sort by position descending to avoid offset issues
  const sorted = patches.length > 1
    ? [...patches].sort((a, b) => b.pos - a.pos)
    : patches

  let result = content
  for (const patch of sorted) {
    result = result.slice(0, patch.pos) + patch.ins + result.slice(patch.pos + patch.del)
  }

  return result
}

/**
 * Invert patches to create reverse operation
 * Given patches that transform A→B, returns patches that transform B→A
 */
function invertPatches(content: string, patches: Patch[]): Patch[] {
  if (patches.length === 0) return []

  // Fast path: single patch (most common case) - no sorting or offset tracking needed
  if (patches.length === 1) {
    const p = patches[0]
    return [{
      pos: p.pos,
      del: p.ins.length,
      ins: content.slice(p.pos, p.pos + p.del)
    }]
  }

  // Multiple patches: need to track position offsets
  const inverted: Patch[] = []
  let offset = 0

  // Sort by position for consistent processing
  const sorted = [...patches].sort((a, b) => a.pos - b.pos)

  for (const patch of sorted) {
    const originalPos = patch.pos + offset
    const deleted = content.slice(patch.pos, patch.pos + patch.del)

    inverted.push({
      pos: originalPos,
      del: patch.ins.length,
      ins: deleted
    })

    offset += patch.ins.length - patch.del
  }

  return inverted
}

// ========================================
// UndoManager Class
// ========================================

class UndoManager {
  private documents = new Map<string, DocumentUndoState>()
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * Get or create undo state for a document
   */
  private getState(documentId: string, initialContent: string = ''): DocumentUndoState {
    let state = this.documents.get(documentId)
    if (!state) {
      state = {
        currentContent: initialContent,
        undoStack: [],
        redoStack: [],
        lastSavedContent: initialContent
      }
      this.documents.set(documentId, state)
    }
    return state
  }

  /**
   * Initialize undo state for a document
   */
  init(documentId: string, content: string): void {
    this.documents.set(documentId, {
      currentContent: content,
      undoStack: [],
      redoStack: [],
      lastSavedContent: content
    })
    this.clearTimer()
  }

  /**
   * Clear any pending save timer
   */
  private clearTimer(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
  }

  /**
   * Record a state change for potential undo
   * Call this with the OLD content before applying changes
   */
  saveState(
    documentId: string,
    oldContent: string,
    newContent: string,
    cursorPosition: { start: number; end: number }
  ): void {
    const state = this.getState(documentId, oldContent)

    // Compute forward patches (old→new)
    const forwardPatches = computeDiff(oldContent, newContent)

    // No changes? Skip
    if (forwardPatches.length === 0) return

    // Compute reverse patches (new→old)
    const reversePatches = invertPatches(oldContent, forwardPatches)

    // Store reverse diff for undo
    state.undoStack.push({
      reverse: reversePatches,
      cursorPosition,
      timestamp: Date.now()
    })

    // Clear redo when new changes are made
    state.redoStack = []

    // Update current content
    state.currentContent = newContent

    // Limit history size - use shift() to avoid array reallocation
    while (state.undoStack.length > MAX_HISTORY) {
      state.undoStack.shift()
    }

    state.lastSavedContent = newContent
  }

  /**
   * Check if content has changed enough to warrant saving undo state
   * Saves on word boundaries, newlines, and after short pauses
   */
  onContentChange(
    documentId: string,
    oldContent: string,
    newContent: string,
    cursorPosition: { start: number; end: number },
    onSave?: () => void
  ): void {
    const state = this.getState(documentId, oldContent)

    // No change from last saved state
    if (newContent === state.lastSavedContent) return

    const lastSaved = state.lastSavedContent
    const diff = newContent.length - lastSaved.length

    // Detect what was added/removed
    const isInsertion = diff > 0
    const isDeletion = diff < 0

    // Save immediately on:
    // 1. Newlines (user pressed Enter)
    // 2. Large deletions (>1 char, like selecting and deleting)
    // 3. Large pastes (>20 chars)
    // 4. Word completion (space/punctuation after typing)

    if (isInsertion) {
      // Find what was inserted
      const inserted = this.getInsertedText(lastSaved, newContent)

      // Newline - save immediately (natural break point)
      if (inserted.includes('\n')) {
        this.clearTimer()
        this.saveState(documentId, lastSaved, newContent, cursorPosition)
        onSave?.()
        return
      }

      // Large paste - save immediately
      if (diff > 20) {
        this.clearTimer()
        this.saveState(documentId, lastSaved, newContent, cursorPosition)
        onSave?.()
        return
      }

      // Word boundary (space or punctuation after typing) - save the word
      if (/[\s.,;:!?)\]}]/.test(inserted)) {
        this.clearTimer()
        this.saveState(documentId, lastSaved, newContent, cursorPosition)
        onSave?.()
        return
      }
    }

    if (isDeletion) {
      // Multi-character deletion (selecting and deleting) - save immediately
      if (Math.abs(diff) > 1) {
        this.clearTimer()
        this.saveState(documentId, lastSaved, newContent, cursorPosition)
        onSave?.()
        return
      }
    }

    // Single character changes - debounce with short delay (300ms)
    // This groups rapid typing but captures pauses
    this.clearTimer()
    this.saveTimer = setTimeout(() => {
      this.saveState(documentId, state.lastSavedContent, newContent, cursorPosition)
      onSave?.()
    }, 300)
  }

  /**
   * Get the text that was inserted (simple heuristic for single insertions)
   */
  private getInsertedText(oldStr: string, newStr: string): string {
    if (newStr.length <= oldStr.length) return ''

    // Find common prefix
    let i = 0
    while (i < oldStr.length && oldStr[i] === newStr[i]) i++

    // The inserted text is between the prefix and where old string continues
    const insertedLen = newStr.length - oldStr.length
    return newStr.slice(i, i + insertedLen)
  }

  /**
   * Undo last change
   * Returns the state to restore, or null if nothing to undo
   */
  undo(
    documentId: string,
    currentContent: string,
    currentCursor: { start: number; end: number }
  ): UndoState | null {
    const state = this.getState(documentId)

    if (state.undoStack.length === 0) return null

    const undoDiff = state.undoStack.pop()!

    // Apply reverse patches to get previous content
    const previousContent = applyPatches(currentContent, undoDiff.reverse)

    // Compute forward patches for redo
    const forwardPatches = computeDiff(previousContent, currentContent)

    // Save to redo stack
    state.redoStack.push({
      forward: forwardPatches,
      cursorPosition: currentCursor,
      timestamp: Date.now()
    })

    // Update current content
    state.currentContent = previousContent

    return {
      content: previousContent,
      cursorPosition: undoDiff.cursorPosition,
      timestamp: undoDiff.timestamp
    }
  }

  /**
   * Redo last undone change
   * Returns the state to restore, or null if nothing to redo
   */
  redo(
    documentId: string,
    currentContent: string,
    currentCursor: { start: number; end: number }
  ): UndoState | null {
    const state = this.getState(documentId)

    if (state.redoStack.length === 0) return null

    const redoDiff = state.redoStack.pop()!

    // Apply forward patches to get next content
    const nextContent = applyPatches(currentContent, redoDiff.forward)

    // Compute reverse patches for undo
    const reversePatches = invertPatches(currentContent, redoDiff.forward)

    // Save to undo stack
    state.undoStack.push({
      reverse: reversePatches,
      cursorPosition: currentCursor,
      timestamp: Date.now()
    })

    // Update current content
    state.currentContent = nextContent

    return {
      content: nextContent,
      cursorPosition: redoDiff.cursorPosition,
      timestamp: redoDiff.timestamp
    }
  }

  /**
   * Check if undo is available
   */
  canUndo(documentId: string): boolean {
    return (this.documents.get(documentId)?.undoStack.length ?? 0) > 0
  }

  /**
   * Check if redo is available
   */
  canRedo(documentId: string): boolean {
    return (this.documents.get(documentId)?.redoStack.length ?? 0) > 0
  }

  /**
   * Clear undo/redo history for a document
   */
  clear(documentId: string): void {
    this.documents.delete(documentId)
  }

  /**
   * Flush any pending undo saves (call before page unload)
   */
  flush(
    documentId: string,
    currentContent: string,
    cursorPosition: { start: number; end: number }
  ): void {
    if (this.saveTimer) {
      this.clearTimer()
      const state = this.getState(documentId)
      if (currentContent !== state.lastSavedContent) {
        this.saveState(documentId, state.lastSavedContent, currentContent, cursorPosition)
      }
    }
  }

  /**
   * Get memory usage stats for debugging
   */
  getMemoryStats(documentId: string): { undoBytes: number; redoBytes: number; totalPatches: number } {
    const state = this.documents.get(documentId)
    if (!state) return { undoBytes: 0, redoBytes: 0, totalPatches: 0 }

    let undoBytes = 0
    let redoBytes = 0
    let totalPatches = 0

    for (const diff of state.undoStack) {
      for (const patch of diff.reverse) {
        undoBytes += patch.ins.length + 16 // rough estimate: string + overhead
        totalPatches++
      }
    }

    for (const diff of state.redoStack) {
      for (const patch of diff.forward) {
        redoBytes += patch.ins.length + 16
        totalPatches++
      }
    }

    return { undoBytes, redoBytes, totalPatches }
  }
}

export default new UndoManager()
