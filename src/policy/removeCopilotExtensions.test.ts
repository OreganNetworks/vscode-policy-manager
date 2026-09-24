import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createCopilotRemover,
  type ExtensionRegistry,
  findUnmanagedDependants,
  type InstalledExtension,
  isManaged,
  planRemoval,
} from './removeCopilotExtensions'
import { createFakeLogger } from '../testing/fakeLogger'

/** An installed extension with sensible defaults */
function ext(id: string, overrides: Partial<InstalledExtension> = {}): InstalledExtension {
  return { builtIn: false, dependencies: [], displayName: id, id, ...overrides }
}

type FakeRegistryOptions = {
  /** Uninstalls of these IDs reject, the way VS Code refuses when a dependant is installed */
  failIds?: readonly string[]
  /** Leave uninstalled extensions listed, the way some stay until a window reload */
  keepListed?: boolean
}

function createFakeRegistry(
  initial: InstalledExtension[],
  { failIds = [], keepListed = false }: FakeRegistryOptions = {},
) {
  let installed = [...initial]
  const uninstalled: string[] = []
  const registry: ExtensionRegistry = {
    list: () => installed,
    async uninstall(id) {
      uninstalled.push(id)
      if (failIds.includes(id))
        throw new Error(`Cannot uninstall '${id}' extension. Another extension depends on this.`)
      if (!keepListed) installed = installed.filter(extension => extension.id !== id)
    },
  }
  return {
    registry,
    setInstalled(next: InstalledExtension[]) {
      installed = next
    },
    uninstalled,
  }
}

function createRemover(registry: ExtensionRegistry) {
  const logger = createFakeLogger()
  const notified: string[][] = []
  const remover = createCopilotRemover({ logger, notifyRemoved: names => notified.push([...names]), registry })
  return { logger, notified, remover }
}

describe('isManaged', () => {
  it('matches managed IDs case-insensitively', () => {
    assert.equal(isManaged('GitHub.copilot-chat'), true)
    assert.equal(isManaged('anthropic.claude-code'), false)
  })
})

describe('planRemoval', () => {
  it('puts installed managed extensions in policy order, dependants first, whatever order they are listed in', () => {
    const planned = planRemoval([
      ext('GitHub.copilot'),
      ext('ms-python.python'),
      ext('github.copilot-chat'),
      ext('vscjava.vscode-java-upgrade'),
    ])
    assert.deepEqual(
      planned.map(extension => extension.id),
      ['vscjava.vscode-java-upgrade', 'github.copilot-chat', 'GitHub.copilot'],
    )
  })
})

describe('findUnmanagedDependants', () => {
  it('finds extensions outside the managed list that depend on an ID', () => {
    const installed = [
      ext('acme.chat-helper', { dependencies: ['GitHub.copilot-chat'] }),
      ext('vscjava.vscode-java-upgrade', { dependencies: ['github.copilot-chat'] }),
      ext('ms-python.python'),
    ]
    assert.deepEqual(
      findUnmanagedDependants(installed, 'github.copilot-chat').map(extension => extension.id),
      ['acme.chat-helper'],
    )
  })
})

describe('createCopilotRemover', () => {
  it('uninstalls managed extensions in policy order and sends one notification', async () => {
    const fake = createFakeRegistry([
      ext('github.copilot', { displayName: 'GitHub Copilot' }),
      ext('ms-python.python'),
      ext('ms-dotnettools.vscode-dotnet-modernize', { displayName: '.NET Modernize' }),
    ])
    const { notified, remover } = createRemover(fake.registry)
    await remover.run()
    assert.deepEqual(fake.uninstalled, ['ms-dotnettools.vscode-dotnet-modernize', 'github.copilot'])
    assert.deepEqual(notified, [['.NET Modernize', 'GitHub Copilot']])
  })

  it('sends no notification when there is nothing to remove', async () => {
    const fake = createFakeRegistry([ext('ms-python.python')])
    const { notified, remover } = createRemover(fake.registry)
    await remover.run()
    assert.deepEqual(fake.uninstalled, [])
    assert.deepEqual(notified, [])
  })

  it('skips a built-in extension without trying to uninstall it, and logs it once', async () => {
    const fake = createFakeRegistry([ext('GitHub.copilot-chat', { builtIn: true }), ext('github.copilot')])
    const { logger, remover } = createRemover(fake.registry)
    await remover.run()
    await remover.run()
    assert.deepEqual(fake.uninstalled, ['github.copilot'])
    assert.equal(logger.lines.filter(line => line.includes('built in')).length, 1)
  })

  it('logs a refused uninstall with the blocking dependant, carries on, and does not retry it', async () => {
    const fake = createFakeRegistry(
      [
        ext('github.copilot-chat'),
        ext('github.copilot'),
        ext('acme.chat-helper', { dependencies: ['github.copilot-chat'] }),
      ],
      { failIds: ['github.copilot-chat'] },
    )
    const { logger, notified, remover } = createRemover(fake.registry)
    await remover.run()
    await remover.run()
    assert.deepEqual(fake.uninstalled, ['github.copilot-chat', 'github.copilot'])
    assert.deepEqual(notified, [['github.copilot']])
    assert.ok(logger.lines.some(line => line.startsWith('warn:') && line.includes('acme.chat-helper')))
  })

  it('does not uninstall or notify twice for an extension that stays listed until a reload', async () => {
    const fake = createFakeRegistry([ext('github.copilot')], { keepListed: true })
    const { notified, remover } = createRemover(fake.registry)
    await remover.run()
    await remover.run()
    assert.deepEqual(fake.uninstalled, ['github.copilot'])
    assert.equal(notified.length, 1)
  })

  it('lists an uninstalled extension that stays listed as pending a reload, until it has gone', async () => {
    const fake = createFakeRegistry([ext('GitHub.copilot'), ext('ms-python.python')], { keepListed: true })
    const { remover } = createRemover(fake.registry)
    assert.deepEqual(remover.pendingReload(), [])
    await remover.run()
    assert.deepEqual(remover.pendingReload(), ['github.copilot'])
    fake.setInstalled([ext('ms-python.python')])
    await remover.run()
    assert.deepEqual(remover.pendingReload(), [])
  })

  it('removes an extension again when it is reinstalled after it has gone', async () => {
    const fake = createFakeRegistry([ext('github.copilot')], { keepListed: true })
    const { notified, remover } = createRemover(fake.registry)
    await remover.run()
    fake.setInstalled([])
    await remover.run()
    fake.setInstalled([ext('github.copilot')])
    await remover.run()
    assert.deepEqual(fake.uninstalled, ['github.copilot', 'github.copilot'])
    assert.equal(notified.length, 2)
  })

  it('runs one more pass for calls made during a pass, without repeating an uninstall', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    let installed = [ext('github.copilot')]
    let listCalls = 0
    const uninstalled: string[] = []
    const registry: ExtensionRegistry = {
      list() {
        listCalls++
        return installed
      },
      async uninstall(id) {
        uninstalled.push(id)
        await gate
        installed = installed.filter(extension => extension.id !== id)
      },
    }
    const { remover } = createRemover(registry)
    const runs = [remover.run(), remover.run(), remover.run()]
    release()
    await Promise.all(runs)
    assert.deepEqual(uninstalled, ['github.copilot'])
    assert.equal(listCalls, 2)
  })
})
