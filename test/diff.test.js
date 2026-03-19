'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeOps } = require('../src/diff');

describe('computeOps', () => {
  it('returns empty array for identical strings', () => {
    assert.deepStrictEqual(computeOps('hello', 'hello'), []);
  });

  it('returns empty array for two empty strings', () => {
    assert.deepStrictEqual(computeOps('', ''), []);
  });

  it('produces insert op for appended text', () => {
    const ops = computeOps('hello', 'hello world');
    assert.ok(ops.length > 0);
    // Apply ops to original should yield new text
    let text = 'hello';
    for (const op of ops) {
      if (op.d) {
        text = text.slice(0, op.p) + text.slice(op.p + op.d.length);
      } else if (op.i) {
        text = text.slice(0, op.p) + op.i + text.slice(op.p);
      }
    }
    assert.equal(text, 'hello world');
  });

  it('produces delete op for removed text', () => {
    const ops = computeOps('hello world', 'hello');
    assert.ok(ops.length > 0);
    let text = 'hello world';
    for (const op of ops) {
      if (op.d) {
        text = text.slice(0, op.p) + text.slice(op.p + op.d.length);
      } else if (op.i) {
        text = text.slice(0, op.p) + op.i + text.slice(op.p);
      }
    }
    assert.equal(text, 'hello');
  });

  it('handles replacement (delete + insert)', () => {
    const ops = computeOps('foo bar', 'foo baz');
    let text = 'foo bar';
    for (const op of ops) {
      if (op.d) {
        text = text.slice(0, op.p) + text.slice(op.p + op.d.length);
      } else if (op.i) {
        text = text.slice(0, op.p) + op.i + text.slice(op.p);
      }
    }
    assert.equal(text, 'foo baz');
  });

  it('handles complete replacement', () => {
    const ops = computeOps('abc', 'xyz');
    let text = 'abc';
    for (const op of ops) {
      if (op.d) {
        text = text.slice(0, op.p) + text.slice(op.p + op.d.length);
      } else if (op.i) {
        text = text.slice(0, op.p) + op.i + text.slice(op.p);
      }
    }
    assert.equal(text, 'xyz');
  });

  it('handles insert at beginning', () => {
    const ops = computeOps('world', 'hello world');
    let text = 'world';
    for (const op of ops) {
      if (op.d) {
        text = text.slice(0, op.p) + text.slice(op.p + op.d.length);
      } else if (op.i) {
        text = text.slice(0, op.p) + op.i + text.slice(op.p);
      }
    }
    assert.equal(text, 'hello world');
  });

  it('handles multiline text', () => {
    const old = 'line1\nline2\nline3';
    const next = 'line1\nmodified\nline3';
    const ops = computeOps(old, next);
    let text = old;
    for (const op of ops) {
      if (op.d) {
        text = text.slice(0, op.p) + text.slice(op.p + op.d.length);
      } else if (op.i) {
        text = text.slice(0, op.p) + op.i + text.slice(op.p);
      }
    }
    assert.equal(text, next);
  });

  it('handles insert from empty', () => {
    const ops = computeOps('', 'new content');
    let text = '';
    for (const op of ops) {
      if (op.d) {
        text = text.slice(0, op.p) + text.slice(op.p + op.d.length);
      } else if (op.i) {
        text = text.slice(0, op.p) + op.i + text.slice(op.p);
      }
    }
    assert.equal(text, 'new content');
  });

  it('handles delete to empty', () => {
    const ops = computeOps('content', '');
    let text = 'content';
    for (const op of ops) {
      if (op.d) {
        text = text.slice(0, op.p) + text.slice(op.p + op.d.length);
      } else if (op.i) {
        text = text.slice(0, op.p) + op.i + text.slice(op.p);
      }
    }
    assert.equal(text, '');
  });
});
