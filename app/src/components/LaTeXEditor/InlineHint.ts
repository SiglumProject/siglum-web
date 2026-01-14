/**
 * InlineHint - Inline hint indicators for CodeMirror
 *
 * Adds a subtle dotted underline to text ranges with a small clickable
 * indicator at the end. Clicking the indicator shows a tooltip with an action.
 * This approach avoids interfering with CodeMirror's built-in hover tooltips.
 *
 * Usage:
 *   import { showInlineHint, clearInlineHints, inlineHintExtension } from './InlineHint'
 *
 *   // Add extension when creating editor
 *   extensions: [inlineHintExtension]
 *
 *   // Show a hint on a text range
 *   showInlineHint(view, {
 *     from: startPos,
 *     to: endPos,
 *     text: 'Add bibliography?',
 *     onClick: () => insertBibliography()
 *   })
 *
 *   // Clear all hints
 *   clearInlineHints(view)
 */

import { EditorView, Decoration, WidgetType } from '@codemirror/view'
import { StateField, StateEffect, RangeSet } from '@codemirror/state'

type DecorationSet = RangeSet<Decoration>

// ========================================
// Types
// ========================================

export interface InlineHintConfig {
  /** Start position of text to underline */
  from: number
  /** End position of text to underline */
  to: number
  /** Tooltip text to display on click */
  text: string
  /** Callback when action is triggered */
  onClick: () => void
  /** Optional: auto-dismiss after delay (ms). Default: no auto-dismiss */
  dismissAfter?: number
  /** Optional: unique ID for this hint (for targeted removal) */
  id?: string
}

// Store hint data globally so widgets can access it
const hintData = new Map<string, { text: string; onClick: () => void }>()
let hintIdCounter = 0

// ========================================
// Widget for the clickable indicator
// ========================================

class HintIndicatorWidget extends WidgetType {
  constructor(readonly hintId: string) {
    super()
  }

  toDOM(view: EditorView): HTMLElement {
    const indicator = document.createElement('span')
    indicator.className = 'cm-hint-indicator'
    indicator.textContent = '+'
    indicator.setAttribute('role', 'button')
    indicator.setAttribute('tabindex', '0')
    indicator.setAttribute('aria-label', 'Suggestion available')

    const data = hintData.get(this.hintId)

    indicator.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (data) {
        this.showPopover(indicator, data.text, data.onClick, view)
      }
    })

    indicator.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        if (data) {
          this.showPopover(indicator, data.text, data.onClick, view)
        }
      }
    })

    return indicator
  }

  private showPopover(
    anchor: HTMLElement,
    text: string,
    onClick: () => void,
    view: EditorView
  ) {
    // Remove any existing popover
    hideActivePopover()

    const popover = document.createElement('div')
    popover.className = 'cm-hint-popover'
    popover.textContent = text
    popover.setAttribute('role', 'button')
    popover.setAttribute('tabindex', '0')

    // Position popover above the indicator
    const anchorRect = anchor.getBoundingClientRect()
    const editorRect = view.dom.getBoundingClientRect()
    popover.style.left = `${anchorRect.left - editorRect.left}px`
    popover.style.top = `${anchorRect.top - editorRect.top - 28}px`

    popover.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      onClick()
      hideActivePopover()
      // Remove this hint after action
      removeInlineHint(view, this.hintId)
    })

    popover.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onClick()
        hideActivePopover()
        removeInlineHint(view, this.hintId)
      } else if (e.key === 'Escape') {
        hideActivePopover()
      }
    })

    // Click outside to dismiss
    const dismissHandler = (e: MouseEvent) => {
      if (!popover.contains(e.target as Node) && e.target !== anchor) {
        hideActivePopover()
        document.removeEventListener('click', dismissHandler)
      }
    }
    setTimeout(() => document.addEventListener('click', dismissHandler), 0)

    view.dom.appendChild(popover)
    activePopover = popover
    popover.focus()
  }

  eq(other: HintIndicatorWidget): boolean {
    return this.hintId === other.hintId
  }

  ignoreEvent(): boolean {
    return false
  }
}

let activePopover: HTMLElement | null = null

function hideActivePopover() {
  if (activePopover) {
    activePopover.remove()
    activePopover = null
  }
}

// ========================================
// State Management
// ========================================

const addHintEffect = StateEffect.define<InlineHintConfig>()
const removeHintEffect = StateEffect.define<string | undefined>()
const clearAllHintsEffect = StateEffect.define<void>()

const inlineHintField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none
  },

  update(hints, tr) {
    hints = hints.map(tr.changes)

    for (const effect of tr.effects) {
      if (effect.is(addHintEffect)) {
        const config = effect.value
        const hintId = config.id || `hint-${++hintIdCounter}`

        // Store hint data for widget access
        hintData.set(hintId, { text: config.text, onClick: config.onClick })

        // Widget decoration for the clickable indicator (after the text)
        const widgetDeco = Decoration.widget({
          widget: new HintIndicatorWidget(hintId),
          side: 1
        })

        hints = hints.update({
          add: [widgetDeco.range(config.to)]
        })
      }

      if (effect.is(removeHintEffect)) {
        const idToRemove = effect.value
        if (idToRemove === undefined) {
          // Remove all
          hintData.clear()
          hints = Decoration.none
        } else {
          // Remove specific hint
          hintData.delete(idToRemove)
          const newDecos: { from: number; to: number; value: Decoration }[] = []
          const iter = hints.iter()
          while (iter.value) {
            const spec = iter.value.spec
            const id = spec.attributes?.['data-hint-id'] ||
                       (spec.widget as HintIndicatorWidget)?.hintId
            if (id !== idToRemove) {
              newDecos.push({ from: iter.from, to: iter.to, value: iter.value })
            }
            iter.next()
          }
          hints = Decoration.set(newDecos.map(d => d.value.range(d.from, d.to)), true)
        }
      }

      if (effect.is(clearAllHintsEffect)) {
        hintData.clear()
        hints = Decoration.none
      }
    }

    return hints
  },

  provide: f => EditorView.decorations.from(f)
})

// ========================================
// Public API
// ========================================

/**
 * Extension to include in editor - required for hints to work
 */
export const inlineHintExtension = [inlineHintField]

/**
 * Show an inline hint on a text range
 */
export function showInlineHint(view: EditorView, config: InlineHintConfig): void {
  view.dispatch({
    effects: addHintEffect.of(config)
  })

  if (config.dismissAfter) {
    setTimeout(() => {
      removeInlineHint(view, config.id)
    }, config.dismissAfter)
  }
}

/**
 * Remove a specific hint by ID, or all hints if no ID provided
 */
export function removeInlineHint(view: EditorView, id?: string): void {
  hideActivePopover()
  view.dispatch({
    effects: removeHintEffect.of(id)
  })
}

/**
 * Clear all inline hints
 */
export function clearInlineHints(view: EditorView): void {
  hideActivePopover()
  view.dispatch({
    effects: clearAllHintsEffect.of(undefined)
  })
}

/**
 * Check if document has any inline hints
 */
export function hasInlineHints(view: EditorView): boolean {
  const hints = view.state.field(inlineHintField, false)
  return hints ? hints.size > 0 : false
}
