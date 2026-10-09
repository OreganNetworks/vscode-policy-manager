import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { describeError } from './logger'
import { createFakeLogger } from './testing/fakeLogger'

describe('describeError', () => {
  it('uses the message of an Error and stringifies anything else', () => {
    assert.equal(describeError(new Error('boom')), 'boom')
    assert.equal(describeError('plain'), 'plain')
    assert.equal(describeError(42), '42')
  })
})

describe('createFakeLogger', () => {
  it('records each line with its level', () => {
    const logger = createFakeLogger()
    logger.info('one')
    logger.error('two')
    assert.deepEqual(logger.lines, ['info: one', 'error: two'])
  })
})
