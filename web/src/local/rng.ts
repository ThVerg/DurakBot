// Small, fast, seedable PRNG (sfc32 seeded through splitmix32).
//
// The browser deal does not need to match Python's `random` module; it only
// needs to be reproducible from a seed. The state is four uint32 words, so it
// can be saved/restored (getState/setState) and cloned for search.

function splitmix32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
}

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  /** `seed` may be any finite number (integers up to 2^53 use all their bits). */
  constructor(seed?: number) {
    const s = seed === undefined || !Number.isFinite(seed) ? Rng.entropySeed() : seed;
    const lo = Math.floor(Math.abs(s)) >>> 0;
    const hi = Math.floor(Math.abs(s) / 4294967296) >>> 0;
    const sm = splitmix32(lo ^ Math.imul(hi, 0x27d4eb2d) ^ (s < 0 ? 0x5bd1e995 : 0));
    this.a = sm();
    this.b = sm();
    this.c = sm();
    this.d = sm();
    for (let i = 0; i < 12; i++) this.nextU32();
  }

  static entropySeed(): number {
    const c = (globalThis as { crypto?: Crypto }).crypto;
    if (c && typeof c.getRandomValues === "function") {
      const buf = new Uint32Array(2);
      c.getRandomValues(buf);
      return (buf[0] & 0x1fffff) * 4294967296 + buf[1];
    }
    return Math.floor(Math.random() * 2 ** 53);
  }

  /** Next uniform uint32. */
  nextU32(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.c = (this.c + t) >>> 0;
    return t;
  }

  /** Uniform float in [0, 1) with 53 bits of precision. */
  random(): number {
    const a = this.nextU32() >>> 5;
    const b = this.nextU32() >>> 6;
    return (a * 67108864 + b) / 9007199254740992;
  }

  /** Uniform int in [0, n). */
  randrange(n: number): number {
    if (n <= 0) throw new RangeError("randrange: empty range");
    if (n <= 4294967296) {
      // Rejection sampling: unbiased.
      const lim = 4294967296 - (4294967296 % n);
      for (;;) {
        const x = this.nextU32();
        if (x < lim) return x % n;
      }
    }
    return Math.floor(this.random() * n);
  }

  /** Uniform int in [a, b] inclusive. */
  randint(a: number, b: number): number {
    return a + this.randrange(b - a + 1);
  }

  choice<T>(arr: readonly T[]): T {
    return arr[this.randrange(arr.length)];
  }

  /** In-place Fisher-Yates shuffle (same algorithm as Python's random.shuffle). */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.randrange(i + 1);
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  getState(): [number, number, number, number] {
    return [this.a, this.b, this.c, this.d];
  }

  setState(s: readonly number[]): void {
    this.a = s[0] >>> 0;
    this.b = s[1] >>> 0;
    this.c = s[2] >>> 0;
    this.d = s[3] >>> 0;
  }

  clone(): Rng {
    const r = new Rng(0);
    r.setState(this.getState());
    return r;
  }
}
