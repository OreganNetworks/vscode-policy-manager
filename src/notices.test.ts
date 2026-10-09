import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createNotices, type Notice, noticeForRestore, type SavedNotice } from './notices'
import { createFakeLogger } from './testing/fakeLogger'

const AI_OFF: Notice = { kind: 'ai-switched-off' }
const TELEMETRY_SET: Notice = { key: 'telemetry.telemetryLevel', kind: 'setting-restored' }

/** One session over a shared store; `close(i)` closes the i-th notice it showed, the way the developer would */
function session(store: { saved: SavedNotice[] }, now = () => 1_000_000) {
  const shown: Notice[] = []
  const closers: (() => void)[] = []
  const notices = createNotices({
    logger: createFakeLogger(),
    now,
    show(notice) {
      shown.push(notice)
      return new Promise<void>(resolve => closers.push(resolve))
    },
    store: {
      get: () => store.saved,
      async set(value) {
        store.saved = [...value]
      },
    },
  })
  return {
    async close(index: number) {
      closers[index]()
      await new Promise(resolve => setImmediate(resolve)) // let the forget run
    },
    notices,
    shown,
  }
}

describe('createNotices', () => {
  it('shows a saved notice, and forgets it once it is closed', async () => {
    const store = { saved: [] as SavedNotice[] }
    const s = session(store)
    await s.notices.save(AI_OFF)
    assert.deepEqual(store.saved, [{ at: 1_000_000, notice: AI_OFF }])
    s.notices.show(AI_OFF)
    assert.deepEqual(s.shown, [AI_OFF])
    await s.close(0)
    assert.deepEqual(store.saved, [])
  })

  it('shows a notice the previous session saved but did not get to show', async () => {
    const store = { saved: [] as SavedNotice[] }
    await session(store).notices.save(AI_OFF) // the extension host restarts before show()
    const next = session(store, () => 1_030_000)
    next.notices.showSaved()
    assert.deepEqual(next.shown, [AI_OFF])
    await next.close(0)
    assert.deepEqual(store.saved, [])
  })

  it('drops a saved notice older than two minutes without showing it', async () => {
    const store = { saved: [{ at: 1_000_000, notice: AI_OFF }] }
    const later = session(store, () => 1_000_000 + 2 * 60_000 + 1)
    later.notices.showSaved()
    assert.deepEqual(later.shown, [])
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(store.saved, [])
  })

  it('forgets a notice whose write did not happen', async () => {
    const store = { saved: [] as SavedNotice[] }
    const s = session(store)
    await s.notices.save(TELEMETRY_SET)
    await s.notices.forget(TELEMETRY_SET)
    assert.deepEqual(store.saved, [])
    assert.deepEqual(s.shown, [])
  })

  it('keeps one copy of a notice saved twice', async () => {
    const store = { saved: [] as SavedNotice[] }
    const s = session(store)
    await s.notices.save(AI_OFF)
    await s.notices.save(AI_OFF)
    await s.notices.save(TELEMETRY_SET)
    assert.deepEqual(
      store.saved.map(saved => saved.notice),
      [AI_OFF, TELEMETRY_SET],
    )
  })
})

describe('noticeForRestore', () => {
  it('says the AI is switched off for an AI setting, and names any other setting', () => {
    assert.deepEqual(noticeForRestore('chat.disableAIFeatures'), AI_OFF)
    assert.deepEqual(noticeForRestore('github.copilot.enable'), AI_OFF)
    assert.deepEqual(noticeForRestore('telemetry.telemetryLevel'), TELEMETRY_SET)
  })
})
