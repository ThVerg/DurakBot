// Python's round(x, ndigits) for floats: correctly rounded, ties to even, so
// win/policy/rate values match the server's JSON digit for digit.

export function pyRound(x: number, nd = 0): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const ax = Math.abs(x);
  if (ax >= 1e21) return x;
  // toFixed rounds the exact binary value, ties away from zero.
  let r = Number(ax.toFixed(nd));
  const exact = ax.toFixed(Math.min(100, nd + 70));
  const dot = exact.indexOf(".");
  if (/^50*$/.test(exact.slice(dot + 1 + nd))) {
    // an exact tie: round half to even
    const truncated = exact.slice(0, dot + 1 + nd);
    const last = nd > 0 ? truncated[truncated.length - 1] : exact[dot - 1];
    if (Number(last) % 2 === 0) r = Number(truncated);
  }
  return x < 0 ? -r : r;
}
