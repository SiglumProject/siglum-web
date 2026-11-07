import { expect, test } from 'bun:test'
import syncTexService from '../src/services/SyncTexService'

function map(page: number) {
  return `SyncTeX Version:1
Input:1:main.tex
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{${page}
x1,3:4736287,9472573
}${page}
Postamble:
Count:1`
}

test('a first-paint callback cannot replace a newer SyncTeX mapping', () => {
  const callbacks: FrameRequestCallback[] = []
  const original = globalThis.requestAnimationFrame
  globalThis.requestAnimationFrame = callback => callbacks.push(callback)
  const updates: number[] = []
  const unsubscribe = syncTexService.onUpdate(() => updates.push(syncTexService.getPageCount()))
  try {
    const first = map(1)
    const second = map(2)
    syncTexService.queueUpdate(first)
    syncTexService.prepareAfterPaint(first)
    syncTexService.queueUpdate(second)
    syncTexService.prepareAfterPaint(second)
    expect(updates).toEqual([])
    while (callbacks.length) callbacks.shift()!(0)
    expect(updates).toEqual([1])
    const location = syncTexService.forwardSync(3, 'main.tex')
    expect(location?.page).toBe(2)
    expect(syncTexService.inverseSync(2, location!.x, location!.y)?.line).toBe(3)
  } finally {
    unsubscribe()
    syncTexService.clear()
    globalThis.requestAnimationFrame = original
  }
})

test('an explicit jump can index the pending map before a page is drawn', () => {
  syncTexService.queueUpdate(map(4))
  try {
    expect(syncTexService.isAvailable()).toBe(true)
    expect(syncTexService.forwardSync(3, 'main.tex')?.page).toBe(4)
  } finally {
    syncTexService.clear()
  }
})
