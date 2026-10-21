'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeOps, merge3 } = require('../src/diff');

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

describe('merge3', () => {
  const base = 'alpha\nbeta\ngamma\ndelta\n';

  it('returns the remote text when the local file has no edits of its own', () => {
    const remote = 'alpha\nbeta\ngamma\ndelta\n% note\n';
    assert.deepEqual(merge3(base, base, remote), { text: remote, conflicts: 0 });
  });

  it('returns the local text when the remote side is unchanged', () => {
    const local = 'alpha\nBETA\ngamma\ndelta\n';
    assert.deepEqual(merge3(base, local, base), { text: local, conflicts: 0 });
  });

  it('combines edits to separate regions', () => {
    const local = 'alpha\nBETA\ngamma\ndelta\n';
    const remote = 'alpha\nbeta\ngamma\nDELTA\n';
    assert.deepEqual(merge3(base, local, remote), { text: 'alpha\nBETA\ngamma\nDELTA\n', conflicts: 0 });
  });

  it('keeps an edit made identically on both sides once (no duplicated insert)', () => {
    const both = 'alpha\nbeta beta\ngamma\ndelta\n';
    const remote = 'alpha\nbeta beta\ngamma\ndelta\n% note\n';
    assert.deepEqual(merge3(base, both, remote), { text: remote, conflicts: 0 });
  });

  it('resolves overlapping different edits in favour of the local text', () => {
    const local = 'alpha\nlocal\ngamma\ndelta\n';
    const remote = 'alpha\nremote\ngamma\ndelta\n';
    assert.deepEqual(merge3(base, local, remote), { text: local, conflicts: 1 });
  });
});
