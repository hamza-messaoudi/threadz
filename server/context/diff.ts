/**
 * Pairs [i, j] with a[i] === b[j], increasing in both: what two versions of a document keep. Edits are
 * usually local, so the common head and tail are matched first; the rest is a longest common subsequence
 * while that stays small, else the items that occur once on each side, in order.
 */
export function matchSeq(a: string[], b: string[]): [number, number][] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const out: [number, number][] = [];
  for (let i = 0; i < pre; i++) out.push([i, i]);
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const mid = A.length * B.length <= 4_000_000 ? lcs(A, B) : uniqueMatch(A, B);
  for (const [i, j] of mid) out.push([i + pre, j + pre]);
  for (let k = 0; k < suf; k++) out.push([a.length - suf + k, b.length - suf + k]);
  return out;
}

function lcs(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  if (!n || !m) return [];
  const w = m + 1;
  // dp[i * w + j]: length of the LCS of a[i..] and b[j..].
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
  const out: [number, number][] = [];
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[i] === b[j]) {
      out.push([i++, j++]);
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  return out;
}

/** Items unique on both sides, then the longest run of them that is in order on both (patience diff). */
function uniqueMatch(a: string[], b: string[]): [number, number][] {
  const count = (xs: string[]) => {
    const c = new Map<string, number>();
    xs.forEach((x, i) => c.set(x, c.has(x) ? -1 : i));
    return c;
  };
  const ca = count(a);
  const cb = count(b);
  const pairs: [number, number][] = [];
  for (const [x, i] of ca) {
    const j = cb.get(x);
    if (i >= 0 && j !== undefined && j >= 0) pairs.push([i, j]);
  }
  pairs.sort((p, q) => p[0] - q[0]);
  // Longest increasing subsequence on j.
  const tails: number[] = [];
  const prev = new Int32Array(pairs.length).fill(-1);
  for (let k = 0; k < pairs.length; k++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]][1] < pairs[k][1]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[k] = tails[lo - 1];
    tails[lo] = k;
  }
  const out: [number, number][] = [];
  for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) out.push(pairs[k]);
  return out.reverse();
}

/** A unified diff of two texts by line, with `context` lines around each change; '' when they are equal. */
export function unifiedDiff(a: string, b: string, context = 2): string {
  const A = a.split('\n');
  const B = b.split('\n');
  const same = matchSeq(A, B);
  // Edit script: runs of kept lines between changes.
  type Op = { kind: ' ' | '-' | '+'; text: string; ai: number; bi: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  for (const [si, sj] of [...same, [A.length, B.length] as [number, number]]) {
    while (i < si) ops.push({ kind: '-', text: A[i], ai: i++, bi: j });
    while (j < sj) ops.push({ kind: '+', text: B[j], ai: i, bi: j++ });
    if (si < A.length) ops.push({ kind: ' ', text: A[si], ai: i++, bi: j++ });
  }
  const hunks: string[] = [];
  for (let k = 0; k < ops.length; ) {
    if (ops[k].kind === ' ') {
      k++;
      continue;
    }
    let from = Math.max(0, k - context);
    while (from > 0 && ops[from - 1].kind !== ' ') from--;
    let to = k;
    // Extend over changes separated by at most 2 × context kept lines.
    for (let gap = 0; to < ops.length; to++) {
      if (ops[to].kind === ' ') {
        if (++gap > context * 2) break;
      } else gap = 0;
    }
    to = Math.min(ops.length, to);
    // Keep only `context` kept lines after the last change.
    let last = to - 1;
    while (last > k && ops[last].kind === ' ') last--;
    const end = Math.min(ops.length, last + 1 + context);
    const slice = ops.slice(from, end);
    const aCount = slice.filter((o) => o.kind !== '+').length;
    const bCount = slice.filter((o) => o.kind !== '-').length;
    const aStart = slice[0].ai + (aCount ? 1 : 0);
    const bStart = slice[0].bi + (bCount ? 1 : 0);
    hunks.push([`@@ -${aStart},${aCount} +${bStart},${bCount} @@`, ...slice.map((o) => o.kind + o.text)].join('\n'));
    k = end;
  }
  return hunks.join('\n');
}
