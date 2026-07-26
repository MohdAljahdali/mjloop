import assert from 'node:assert/strict'
import { test } from 'node:test'
import { submitLabel } from '../src/button.js'

test('submitLabel returns the button text', () => {
  assert.equal(submitLabel(), 'Submit')
})
