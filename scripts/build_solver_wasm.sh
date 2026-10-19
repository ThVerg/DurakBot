#!/usr/bin/env bash
# Compile the exact endgame solver (durak/_solver.c) to WebAssembly for the browser.
#
#   scripts/build_solver_wasm.sh            -> web/public/ai/solver.wasm
#   CLANG=/path/to/clang scripts/build_solver_wasm.sh
#
# _solver.c is compiled unchanged. It is freestanding apart from calloc/free,
# memset and clock_gettime, which a small shim provides here: a bump allocator
# on the wasm heap (the solver allocates exactly one block, its transposition
# table), memset via the bulk-memory instruction, and a clock imported from JS
# (env.now_ms = performance.now). The shim also exports dkw_* wrappers that take
# every 64-bit card mask as two 32-bit words, so JS never needs BigInt.
set -euo pipefail
cd "$(dirname "$0")/.."

CLANG="${CLANG:-}"
if [[ -z "$CLANG" ]]; then
  for c in clang clang-18 clang-17 clang-19; do
    if command -v "$c" >/dev/null 2>&1 && "$c" --print-targets 2>/dev/null | grep -q wasm32; then
      CLANG="$c"; break
    fi
  done
  if [[ -z "$CLANG" ]]; then
    echo "no clang with a wasm32 target found; set CLANG=/path/to/clang" >&2
    exit 1
  fi
fi
OUT="${OUT:-web/public/ai/solver.wasm}"
SRC=durak/_solver.c
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/include" "$(dirname "$OUT")"

cat > "$TMP/include/stdlib.h" <<'EOF'
#pragma once
#include <stddef.h>
void *calloc(size_t n, size_t size);
void free(void *p);
EOF
cat > "$TMP/include/string.h" <<'EOF'
#pragma once
#include <stddef.h>
void *memset(void *d, int c, size_t n);
void *memcpy(void *d, const void *s, size_t n);
EOF
cat > "$TMP/include/time.h" <<'EOF'
#pragma once
struct timespec { long long tv_sec; long tv_nsec; };
#define CLOCK_MONOTONIC 1
int clock_gettime(int clk, struct timespec *ts);
EOF

cat > "$TMP/shim.c" <<'EOF'
#include <stddef.h>
#include <stdint.h>
#include "time.h"

typedef uint64_t u64;
typedef uint32_t u32;
#define EXPORT(name) __attribute__((export_name(#name)))

__attribute__((import_module("env"), import_name("now_ms"))) double js_now_ms(void);

extern unsigned char __heap_base;
static uintptr_t heap_top = 0;
static uintptr_t last_block = 0;

void *memset(void *d, int c, size_t n) { __builtin_memset(d, c, n); return d; }
void *memcpy(void *d, const void *s, size_t n) { __builtin_memcpy(d, s, n); return d; }

/* Bump allocator. free() releases the block only if it is the newest one,
 * which covers the solver's single transposition-table allocation. */
void *calloc(size_t n, size_t size) {
  if (!heap_top) heap_top = ((uintptr_t)&__heap_base + 15) & ~(uintptr_t)15;
  if (size && n > (SIZE_MAX - 64) / size) return NULL;
  size_t bytes = (n * size + 15) & ~(size_t)15;
  uintptr_t start = heap_top, end = start + bytes;
  if (end < start) return NULL;
  size_t have = __builtin_wasm_memory_size(0) * 65536u;
  if (end > have) {
    size_t pages = (end - have + 65535u) / 65536u;
    if (__builtin_wasm_memory_grow(0, pages) == (size_t)-1) return NULL;
  }
  __builtin_memset((void *)start, 0, bytes);
  heap_top = end;
  last_block = start;
  return (void *)start;
}

void free(void *p) {
  if (p && (uintptr_t)p == last_block) { heap_top = last_block; last_block = 0; }
}

int clock_gettime(int clk, struct timespec *ts) {
  (void)clk;
  double ms = js_now_ms();
  long long sec = (long long)(ms / 1000.0);
  ts->tv_sec = sec;
  ts->tv_nsec = (long)((ms - (double)sec * 1000.0) * 1e6);
  return 0;
}

/* --- solver API (durak/_solver.c) --- */
int dk_init(int log2size);
void dk_clear(void);
void dk_set_trump(int trump_card);
void dk_set_budget(long long node_limit, double seconds);
long long dk_nodes(void);
void dk_set_option(int which, int val);
void dk_set_horizon(int depth, int hz);
long long dk_hz_hits(void);
int dk_attack(u64 a, u64 d, u64 tab, int n, int limit, int flag, int alpha, int beta);
int dk_defend(u64 a, u64 d, u64 tab, int n, int c, int limit, int flag, int alpha, int beta);
int dk_take(u64 a, u64 d, u64 tab, int n, int limit, int flag, int alpha, int beta);
int dk_end_bout(u64 a, u64 d, int defended, int flag, int alpha, int beta);

static inline u64 J(u32 lo, u32 hi) { return ((u64)hi << 32) | lo; }

EXPORT(dkw_init) int dkw_init(int log2size) { return dk_init(log2size); }
EXPORT(dkw_clear) void dkw_clear(void) { dk_clear(); }
EXPORT(dkw_set_trump) void dkw_set_trump(int c) { dk_set_trump(c); }
EXPORT(dkw_set_budget) void dkw_set_budget(double node_limit, double seconds) {
  dk_set_budget(node_limit < 0 ? -1 : (long long)node_limit, seconds);
}
EXPORT(dkw_nodes) double dkw_nodes(void) { return (double)dk_nodes(); }
EXPORT(dkw_set_option) void dkw_set_option(int which, int val) { dk_set_option(which, val); }
EXPORT(dkw_set_horizon) void dkw_set_horizon(int depth, int hz) { dk_set_horizon(depth, hz); }
EXPORT(dkw_hz_hits) double dkw_hz_hits(void) { return (double)dk_hz_hits(); }
EXPORT(dkw_attack) int dkw_attack(u32 al, u32 ah, u32 dl, u32 dh, u32 tl, u32 th, int n, int limit, int flag,
                                  int alpha, int beta) {
  return dk_attack(J(al, ah), J(dl, dh), J(tl, th), n, limit, flag, alpha, beta);
}
EXPORT(dkw_defend) int dkw_defend(u32 al, u32 ah, u32 dl, u32 dh, u32 tl, u32 th, int n, int c, int limit,
                                  int flag, int alpha, int beta) {
  return dk_defend(J(al, ah), J(dl, dh), J(tl, th), n, c, limit, flag, alpha, beta);
}
EXPORT(dkw_take) int dkw_take(u32 al, u32 ah, u32 dl, u32 dh, u32 tl, u32 th, int n, int limit, int flag,
                              int alpha, int beta) {
  return dk_take(J(al, ah), J(dl, dh), J(tl, th), n, limit, flag, alpha, beta);
}
EXPORT(dkw_end_bout) int dkw_end_bout(u32 al, u32 ah, u32 dl, u32 dh, int defended, int flag, int alpha,
                                      int beta) {
  return dk_end_bout(J(al, ah), J(dl, dh), defended, flag, alpha, beta);
}
EOF

CFLAGS=(--target=wasm32 -O3 -ffreestanding -fno-builtin -nostdlib -mbulk-memory -I"$TMP/include"
        -Wall -Wno-unused-function)
"$CLANG" "${CFLAGS[@]}" -c "$SRC" -o "$TMP/solver.o"
"$CLANG" "${CFLAGS[@]}" -c "$TMP/shim.c" -o "$TMP/shim.o"
"$CLANG" --target=wasm32 -nostdlib -Wl,--no-entry -Wl,--gc-sections -Wl,--strip-all \
  -Wl,-z,stack-size=1048576 -Wl,--initial-memory=2097152 -Wl,--max-memory=1073741824 \
  -o "$OUT" "$TMP/solver.o" "$TMP/shim.o"
chmod 644 "$OUT"
echo "built $OUT ($(stat -c %s "$OUT") bytes) from $SRC with $("$CLANG" --version | head -1)"
