/* Native core of durak/solver.py: alpha-beta over two-player perfect-information
 * Durak endgames. It mirrors EndgameSolver._attack/_defend/_take/_end_bout
 * exactly. Values are in the attacker's frame and lie in {-1,0,1}.
 * ABORT (-100) is returned when the node or time budget runs out.
 *
 * Build: gcc -O2 -shared -fPIC -o _solver.so _solver.c (done automatically by solver.py)
 */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

typedef uint64_t u64;
#define PASS 36
#define ABORT (-100)
#define WIN 1
#define DRAW 0
#define LOSS (-1)

static u64 BEAT[36], RANKM[36], RANKALL[9], TCBIT;
static int ORDV[36];
static int TCARD = -1;

typedef struct {
    u64 a, d, tab, move;
    uint32_t meta, work;
    int8_t lo, hi, used;
} Entry;

static Entry *TT = NULL;
static u64 TTMASK = 0;
static long long NODES = 0, NODE_LIMIT = -1;
static double DEADLINE = -1.0;
static int ABORTED = 0;
static int OPT[8] = {0, 0, 0, 15, -5, 0, 0, 0}; /* tuned move-ordering options */
static int HIST[2][37];
static u64 CTX_A, CTX_TAB;

void dk_set_option(int which, int val) { if (which >= 0 && which < 8) OPT[which] = val; }

static double now(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec * 1e-9;
}

static inline int popc(u64 x) { return __builtin_popcountll(x); }
static inline int lowbit(u64 x) { return __builtin_ctzll(x); }

int dk_init(int log2size) {
    if (TT) free(TT);
    size_t n = (size_t)1 << log2size;
    TT = (Entry *)calloc(n, sizeof(Entry));
    if (!TT) return -1;
    TTMASK = n - 1;
    return 0;
}

void dk_clear(void) {
    if (TT) memset(TT, 0, (TTMASK + 1) * sizeof(Entry));
}

void dk_set_trump(int trump_card) {
    int trump = trump_card / 9;
    TCARD = trump_card;
    TCBIT = 1ULL << trump_card;
    u64 suitm[4];
    for (int s = 0; s < 4; s++) suitm[s] = 0x1FFULL << (s * 9);
    for (int r = 0; r < 9; r++) {
        RANKALL[r] = 0;
        for (int s = 0; s < 4; s++) RANKALL[r] |= 1ULL << (s * 9 + r);
    }
    for (int c = 0; c < 36; c++) {
        int s = c / 9, r = c % 9;
        u64 higher = suitm[s] & ~((1ULL << (s * 9 + r + 1)) - 1);
        BEAT[c] = (s == trump) ? higher : (higher | suitm[trump]);
        RANKM[c] = RANKALL[r];
        ORDV[c] = r + (s == trump ? 20 : 0);
    }
}

void dk_set_budget(long long node_limit, double seconds) {
    memset(HIST, 0, sizeof(HIST));
    NODES = 0;
    ABORTED = 0;
    NODE_LIMIT = node_limit;
    DEADLINE = seconds < 0 ? -1.0 : now() + seconds;
}

long long dk_nodes(void) { return NODES; }

static inline int check(void) {
    NODES++;
    if (NODE_LIMIT >= 0 && NODES > NODE_LIMIT) ABORTED = 1;
    if ((NODES & 4095) == 0 && DEADLINE >= 0 && now() > DEADLINE) ABORTED = 1;
    return ABORTED;
}

static inline u64 mix(u64 x) {
    x += 0x9E3779B97F4A7C15ULL;
    x = (x ^ (x >> 30)) * 0xBF58476D1CE4E5B9ULL;
    x = (x ^ (x >> 27)) * 0x94D049BB133111EBULL;
    return x ^ (x >> 31);
}

static inline uint32_t mkmeta(int c, int limit, int flag) {
    return (uint32_t)((c + 2) | (limit << 6) | (flag << 9) | ((TCARD + 1) << 10));
}

static Entry *probe(u64 a, u64 d, u64 tab, uint32_t meta) {
    u64 h = mix(a ^ mix(d ^ mix(tab ^ meta)));
    Entry *b = &TT[h & TTMASK & ~3ULL];
    for (int i = 0; i < 4; i++)
        if (b[i].used && b[i].a == a && b[i].d == d && b[i].tab == tab && b[i].meta == meta) return &b[i];
    return NULL;
}

static void store(u64 a, u64 d, u64 tab, uint32_t meta, Entry *old, int v, int alpha, int beta, u64 move,
                  long long work) {
    int lo = LOSS, hi = WIN;
    if (old) { lo = old->lo; hi = old->hi; }
    if (v <= alpha) { if (v < hi) hi = v; }
    else if (v >= beta) { if (v > lo) lo = v; }
    else { lo = hi = v; }
    Entry *e = old;
    if (!e) {
        u64 h = mix(a ^ mix(d ^ mix(tab ^ meta)));
        Entry *b = &TT[h & TTMASK & ~3ULL];
        e = &b[0];
        for (int i = 0; i < 4; i++) {
            if (!b[i].used) { e = &b[i]; break; }
            if (b[i].work < e->work) e = &b[i];
        }
        e->a = a; e->d = d; e->tab = tab; e->meta = meta; e->used = 1; e->work = 0;
    }
    e->lo = (int8_t)lo; e->hi = (int8_t)hi; e->move = move;
    uint32_t w = work > 0xFFFFFFF ? 0xFFFFFFF : (uint32_t)work;
    if (w > e->work) e->work = w;
}

static inline u64 table_ranks(u64 tab) {
    u64 r = 0;
    for (int k = 0; k < 9; k++)
        if (tab & RANKALL[k]) r |= RANKALL[k];
    return r;
}

int dk_attack(u64 a, u64 d, u64 tab, int n, int limit, int flag, int alpha, int beta);
int dk_defend(u64 a, u64 d, u64 tab, int n, int c, int limit, int flag, int alpha, int beta);
int dk_take(u64 a, u64 d, u64 tab, int n, int limit, int flag, int alpha, int beta);

int dk_end_bout(u64 a, u64 d, int defended, int flag, int alpha, int beta) {
    if (flag) {
        if (popc(a) < 6) { a |= TCBIT; flag = 0; }
        else if (popc(d) < 6) { d |= TCBIT; flag = 0; }
    }
    if (!flag) {
        if (!a) return d ? WIN : DRAW;
        if (!d) return LOSS;
    }
    if (defended) {
        int pa = popc(a);
        int v = dk_attack(d, a, 0, 0, pa < 6 ? pa : 6, flag, -beta, -alpha);
        return v == ABORT ? ABORT : -v;
    }
    int pd = popc(d);
    return dk_attack(a, d, 0, 0, pd < 6 ? pd : 6, flag, alpha, beta);
}

static int sort_cards(u64 m, int *out, u64 dmask, int unbeatable_first, int side) {
    int k = 0;
    int key[37];
    while (m) {
        int c = lowbit(m);
        m &= m - 1;
        int kv = ORDV[c];
        if (unbeatable_first && (dmask & BEAT[c])) kv += 100;
        if (OPT[2] && side >= 0) kv -= HIST[side][c] * OPT[2];
        if (side == 1 && OPT[3] && (CTX_A & RANKM[c]) && !(CTX_TAB & RANKM[c])) kv += OPT[3];
        if (side == 0 && OPT[4]) kv -= OPT[4] * (popc(CTX_A & RANKM[c]) - 1);
        int i = k++;
        while (i > 0 && key[i - 1] > kv) { key[i] = key[i - 1]; out[i] = out[i - 1]; i--; }
        key[i] = kv; out[i] = c;
    }
    return k;
}

int dk_attack(u64 a, u64 d, u64 tab, int n, int limit, int flag, int alpha, int beta) {
    if (n == 0 && !flag) {
        int lc = lowbit(a);
        int na = popc(a);
        if (!(a & ~RANKM[lc]) && na <= limit) {
            if (popc(d) > na) return WIN;
            if (na == 1) return (d & BEAT[lc]) ? DRAW : WIN;
        }
    }
    if (check()) return ABORT;
    long long n0 = NODES;
    uint32_t meta = mkmeta(-1, limit, flag);
    Entry *e = probe(a, d, tab, meta);
    int tmove = -1;
    if (e) {
        if (e->lo == e->hi || e->lo >= beta) return e->lo;
        if (e->hi <= alpha) return e->hi;
        if (e->lo > alpha) alpha = e->lo;
        if (e->hi < beta) beta = e->hi;
        tmove = (int)e->move;
    }
    int a0 = alpha;
    u64 cands = (n == 0) ? a : (n < limit ? (a & table_ranks(tab)) : 0);
    int moves[38];
    CTX_A = a; CTX_TAB = tab;
    int k = sort_cards(cands, moves, d, 1, 0);
    if (n > 0) {
        if (OPT[0]) { for (int j = k; j > 0; j--) moves[j] = moves[j - 1]; moves[0] = PASS; k++; }
        else moves[k++] = PASS;
    }
    if (tmove >= 0) {
        for (int i = 0; i < k; i++)
            if (moves[i] == tmove) {
                for (int j = i; j > 0; j--) moves[j] = moves[j - 1];
                moves[0] = tmove;
                break;
            }
    }
    int best = LOSS - 1, bmove = -1;
    for (int i = 0; i < k; i++) {
        int c = moves[i], v;
        if (c == PASS) v = dk_end_bout(a, d, 1, flag, alpha, beta);
        else {
            u64 bit = 1ULL << c;
            v = dk_defend(a ^ bit, d, tab | bit, n + 1, c, limit, flag, alpha, beta);
        }
        if (v == ABORT) return ABORT;
        if (v > best) {
            best = v; bmove = c;
            if (v > alpha) { alpha = v; if (alpha >= beta) { if (OPT[2] && c != PASS && HIST[0][c] < 1000) HIST[0][c]++; break; } }
        }
    }
    store(a, d, tab, meta, e, best, a0, beta, (u64)bmove, NODES - n0);
    return best;
}

int dk_defend(u64 a, u64 d, u64 tab, int n, int c, int limit, int flag, int alpha, int beta) {
    if (check()) return ABORT;
    long long n0 = NODES;
    uint32_t meta = mkmeta(c, limit, flag);
    Entry *e = probe(a, d, tab, meta);
    int tmove = -1;
    if (e) {
        if (e->lo == e->hi || e->lo >= beta) return e->lo;
        if (e->hi <= alpha) return e->hi;
        if (e->lo > alpha) alpha = e->lo;
        if (e->hi < beta) beta = e->hi;
        tmove = (int)e->move;
    }
    int b0 = beta;
    int moves[38];
    CTX_A = a; CTX_TAB = tab;
    int k = sort_cards(d & BEAT[c], moves, 0, 0, 1);
    if (OPT[1]) { for (int j = k; j > 0; j--) moves[j] = moves[j - 1]; moves[0] = PASS; k++; }
    else moves[k++] = PASS;
    if (tmove >= 0) {
        for (int i = 0; i < k; i++)
            if (moves[i] == tmove) {
                for (int j = i; j > 0; j--) moves[j] = moves[j - 1];
                moves[0] = tmove;
                break;
            }
    }
    int best = WIN + 1, bmove = -1;
    for (int i = 0; i < k; i++) {
        int b = moves[i], v;
        if (b == PASS) v = dk_take(a, d, tab, n, limit, flag, alpha, beta);
        else {
            u64 bit = 1ULL << b;
            v = dk_attack(a, d ^ bit, tab | bit, n, limit, flag, alpha, beta);
        }
        if (v == ABORT) return ABORT;
        if (v < best) {
            best = v; bmove = b;
            if (v < beta) { beta = v; if (alpha >= beta) { if (OPT[2] && b != PASS && HIST[1][b] < 1000) HIST[1][b]++; break; } }
        }
    }
    store(a, d, tab, meta, e, best, alpha, b0, (u64)bmove, NODES - n0);
    return best;
}

#define TAKE_MOVE_FLAG (1ULL << 63)

int dk_take(u64 a, u64 d, u64 tab, int n, int limit, int flag, int alpha, int beta) {
    u64 cm = a & table_ranks(tab);
    int room = limit - n;
    if (!cm || room <= 0) return dk_end_bout(a, d | tab, 0, flag, alpha, beta);
    if (check()) return ABORT;
    long long n0 = NODES;
    uint32_t meta = mkmeta(-2, limit, flag);
    Entry *e = probe(a, d, tab, meta);
    u64 tsub = 0;
    int have_t = 0;
    if (e) {
        if (e->lo == e->hi || e->lo >= beta) return e->lo;
        if (e->hi <= alpha) return e->hi;
        if (e->lo > alpha) alpha = e->lo;
        if (e->hi < beta) beta = e->hi;
        if (e->move & TAKE_MOVE_FLAG) { tsub = e->move & ~TAKE_MOVE_FLAG; have_t = 1; }
    }
    int a0 = alpha;
    int cards[37];
    int k = sort_cards(cm, cards, 0, 0, -1);
    int best = LOSS - 1;
    u64 bmove = 0;
    if (have_t) {
        int v = dk_end_bout(a ^ tsub, d | tab | tsub, 0, flag, alpha, beta);
        if (v == ABORT) return ABORT;
        best = v; bmove = tsub;
        if (v > alpha) alpha = v;
    }
    int maxs = room < k ? room : k;
    for (int s = maxs; s >= 0 && alpha < beta; s--) {
        /* all k-choose-s index combinations (Gosper's hack) */
        u64 comb = (s == 0) ? 0 : ((1ULL << s) - 1);
        u64 lim = 1ULL << k;
        while (1) {
            u64 sub = 0, x = comb;
            while (x) { int i = lowbit(x); x &= x - 1; sub |= 1ULL << cards[i]; }
            if (!(have_t && sub == tsub)) {
                int v = dk_end_bout(a ^ sub, d | tab | sub, 0, flag, alpha, beta);
                if (v == ABORT) return ABORT;
                if (v > best) {
                    best = v; bmove = sub;
                    if (v > alpha) { alpha = v; if (alpha >= beta) break; }
                }
            }
            if (s == 0) break;
            u64 cbit = comb & -comb, r = comb + cbit;
            comb = (((r ^ comb) >> 2) / cbit) | r;
            if (comb >= lim) break;
        }
    }
    store(a, d, tab, meta, e, best, a0, beta, bmove | TAKE_MOVE_FLAG, NODES - n0);
    return best;
}
