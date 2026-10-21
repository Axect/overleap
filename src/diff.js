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

/**
 * The edits that turn `base` into `other`, as hunks { start, end, text }: replace
 * base[start, end) with `text`. Hunks are sorted and separated by unchanged text.
 */
function hunks(base, other) {
  const out = [];
  let pos = 0;
  let cur = null;
  for (const [type, text] of fastDiff(base, other)) {
    if (type === fastDiff.EQUAL) {
      if (cur) out.push(cur);
      cur = null;
      pos += text.length;
      continue;
    }
    if (!cur) cur = { start: pos, end: pos, text: '' };
    if (type === fastDiff.DELETE) {
      pos += text.length;
      cur.end = pos;
    } else {
      cur.text += text;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Three-way merge: carry the edits that turned `base` into `local` over onto `remote`
 * (which is `base` plus other editors' changes). Edits that touch or overlap form one
 * region; a region edited on one side takes that side, a region edited identically on
 * both sides is kept once, and a region edited differently on both sides is a conflict
 * resolved in favour of `local`. Returns { text, conflicts }.
 */
function merge3(base, local, remote) {
  if (local === base || local === remote) return { text: remote, conflicts: 0 };
  if (remote === base) return { text: local, conflicts: 0 };

  const all = [
    ...hunks(base, local).map((h) => ({ ...h, local: true })),
    ...hunks(base, remote).map((h) => ({ ...h, local: false })),
  ].sort((a, b) => a.start - b.start || a.end - b.end);

  const regions = [];
  for (const h of all) {
    const last = regions[regions.length - 1];
    if (last && h.start <= last.end) {
      last.end = Math.max(last.end, h.end);
      last.hunks.push(h);
    } else {
      regions.push({ start: h.start, end: h.end, hunks: [h] });
    }
  }

  const applyRegion = (region, hs) => {
    let out = '';
    let pos = region.start;
    for (const h of hs) {
      out += base.slice(pos, h.start) + h.text;
      pos = h.end;
    }
    return out + base.slice(pos, region.end);
  };

  let text = '';
  let pos = 0;
  let conflicts = 0;
  for (const region of regions) {
    const localHunks = region.hunks.filter((h) => h.local);
    const remoteHunks = region.hunks.filter((h) => !h.local);
    const localText = applyRegion(region, localHunks);
    let chosen = localText;
    if (localHunks.length === 0) {
      chosen = applyRegion(region, remoteHunks);
    } else if (remoteHunks.length > 0 && applyRegion(region, remoteHunks) !== localText) {
      conflicts++;
    }
    text += base.slice(pos, region.start) + chosen;
    pos = region.end;
  }
  return { text: text + base.slice(pos), conflicts };
}

module.exports = { computeOps, merge3 };
