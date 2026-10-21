'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeOps, merge3 } = require('../src/diff');
const textType = require('./helpers/sharejs/text');

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

describe('large near-total rewrites', () => {
  // ~200 kB LaTeX-like document, one paragraph per line.
  //   rewrite: every paragraph replaced by different text (same section skeleton)
  //   lines:   every line changed, no blank lines, so the whole body is one changed hunk
  function makeDoc(mutate, blankLines = true) {
    let s = 42;
    let m = 99;
    const r = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    const rm = () => (m = (m * 1103515245 + 12345) % 2147483648) / 2147483648;
    const words = ['sampler', 'lattice', 'bandwidth', 'ordering', 'entropy', 'Ising', 'window',
      'reach', 'theorem', 'Müller', 'naïve', 'δ-bound', 'graph', 'we', 'the', 'of', 'consider'];
    const sep = blankLines ? '\n\n' : '\n';
    let out = '\\documentclass{article}\n\\begin{document}\n';
    for (let sec = 0; sec < 70; sec++) {
      out += `\\section{Section ${sec}${mutate === 'lines' ? ' (rev)' : ''}}\n`;
      for (let p = 0; p < 6; p++) {
        const para = [];
        for (let w = 0; w < 70; w++) {
          let x = words[Math.floor(r() * words.length)];
          if (mutate === 'rewrite') x = words[Math.floor(rm() * words.length)];
          if (mutate === 'lines' && w % 10 === 0) x += ';';
          para.push(x);
        }
        out += para.join(' ') + '.' + sep;
      }
    }
    return out + '\\end{document}\n';
  }

  for (const [kind, blankLines] of [['rewrite', true], ['lines', false]]) {
    it(`exact ops for a ~200 kB near-total rewrite (${kind}) within seconds`, () => {
      const oldText = makeDoc(null, blankLines);
      const newText = makeDoc(kind, blankLines);
      assert.ok(oldText.length > 190000);
      const t0 = Date.now();
      const ops = computeOps(oldText, newText);
      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 5000, `computeOps took ${elapsed} ms`);
      // ShareJS's own apply checks every delete component against the text it removes.
      assert.equal(textType.apply(oldText, ops), newText);
      assert.ok(ops.length > 100, 'expected per-hunk ops, not one whole-document replace');
    });
  }

  it('merge3 on the same rewrite returns quickly', () => {
    const base = makeDoc(null);
    const local = makeDoc('rewrite');
    const remote = base + '% remote note\n';
    const t0 = Date.now();
    const { text, conflicts } = merge3(base, local, remote);
    assert.ok(Date.now() - t0 < 5000);
    assert.equal(conflicts, 0);
    assert.equal(text, local + '% remote note\n');
  });
});
