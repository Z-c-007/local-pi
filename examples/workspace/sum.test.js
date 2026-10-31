import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sum } from './sum.js';

test('adds two numbers', () => {
  assert.equal(sum(2, 3), 5);
  assert.equal(sum(-2, 2), 0);
});
