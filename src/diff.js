'use strict';

const fastDiff = require('fast-diff');

/**
 * Convert two strings into OT operations suitable for Overleaf's applyOtUpdate.
 *
 * fast-diff returns: [[EQUAL,"abc"], [INSERT,"xyz"], [DELETE,"old"]]
 * OT ops: [{ i: "xyz", p: 3 }, { d: "old", p: 3 }]
 *
 * IMPORTANT: Position tracking uses character offsets in the ORIGINAL string.
 * Deletes come before inserts at the same position.
 */
function computeOps(oldText, newText) {
  if (oldText === newText) return [];

  const diffs = fastDiff(oldText, newText);
  const ops = [];
  let pos = 0; // position in original text

  for (const [type, text] of diffs) {
    switch (type) {
      case fastDiff.EQUAL:
        pos += text.length;
        break;

      case fastDiff.DELETE:
        ops.push({ d: text, p: pos });
        // Don't advance pos - delete removes text at this position
        // But for OT, we DO advance because subsequent ops reference the original
        pos += text.length;
        break;

      case fastDiff.INSERT:
        ops.push({ i: text, p: pos });
        // Don't advance pos in original text - insert doesn't consume original chars
        break;
    }
  }

  // Now we need to adjust positions for OT format:
  // OT ops are applied sequentially, so each op changes the document length.
  // We need to convert from "positions in original" to "positions after previous ops applied"
  return adjustPositions(ops);
}

/**
 * Adjust op positions so they are correct when applied sequentially.
 * fast-diff gives us positions relative to the original text,
 * but OT ops are applied one-by-one, each changing the doc length.
 */
function adjustPositions(ops) {
  const adjusted = [];
  let offset = 0; // cumulative length change from previously applied ops

  for (const op of ops) {
    if (op.d) {
      adjusted.push({ d: op.d, p: op.p + offset });
      offset -= op.d.length;
    } else if (op.i) {
      adjusted.push({ i: op.i, p: op.p + offset });
      offset += op.i.length;
    }
  }

  return adjusted;
}

module.exports = { computeOps };
