/*
  Prism's rules engine (version 1), compiled to WebAssembly (engine.wasm).

  Everything that decides a Prism game, and nothing else: no page, no clock, no
  randomness beyond the seeded dice, no imports. The tile's page plays through it,
  and a host (Raku, or anyone) can replay a saved game's moves through the very
  same file to check its board and score.

  The rules are House Dice's Prism on its original 3 x 4 board (the restricted
  cells of "v1's original 3-row layout"), with the original limit of 24 draws:
  - a pool of 4 dice, each a colour (red, lemon, teal, violet) and a number 1 to 6;
  - dice sharing an edge can't match colour or number;
  - some cells take only one colour or one number;
  - the first die goes on an edge or corner; every later die touches a placed die
    (diagonals count);
  - a pool with no legal die is recast (up to 30 more tries), and the dice of a
    discarded pool count as drawn; after a placement, a pool left with no legal
    die is recast too (its remaining dice counted);
  - the game ends when the board is full, or 24 dice have been drawn, or (unlike
    House Dice, which could leave a stuck pool on screen) when a pool is still
    stuck after its 30 recasts;
  - score: +1 per filled cell, -1 per empty cell, +3 per full row with all four
    colours.

  The dice come from House Dice's own generator (mulberry32, seeded by the same
  string hash it uses for its daily rooms). A daily game's seed is the hash of
  "prism:YYYY-MM-DD" (the America/Denver day), worked out here by seed_for_day,
  so a host never needs its own copy of the hash. Each die draws its colour, then
  its number.

  Only whole numbers are used. Colours: 0 red, 1 lemon, 2 teal, 3 violet.
  Cells are numbered 0 to 11, row by row from the top left.

  Build: node scripts/build-engine.mjs (clang --target=wasm32, no libc).
*/

typedef unsigned int u32;
typedef unsigned long long u64;

#define ENGINE_VERSION 1
#define ROWS 3
#define COLS 4
#define SIZE (ROWS * COLS)
#define COLORS 4
#define POOL_SIZE 4
#define MAX_DRAWN 24
#define RECAST_TRIES 30
#define MAX_MOVES 24
#define EMPTY 255

/* The restricted cells: kind 0 none, 1 colour, 2 number. */
static const unsigned char RULE_KIND[SIZE] = {
  0, 1, 0, 2,
  1, 0, 0, 0,
  0, 2, 1, 0,
};
static const unsigned char RULE_VALUE[SIZE] = {
  0, 2, 0, 3,  /* teal, 3 */
  0, 0, 0, 0,  /* red (0) */
  0, 2, 3, 0,  /* 2, violet */
};

/* ---- the seeded dice (House Dice's mulberry32) ---- */
static u32 rng_state;

static u32 next_u32(void) {
  u32 a = rng_state + 0x6d2b79f5u;
  rng_state = a;
  u32 t = (a ^ (a >> 15)) * (1u | a);
  t = (t + ((t ^ (t >> 7)) * (61u | t))) ^ t;
  return t ^ (t >> 14);
}
/* Math.floor(rand() * n) for n = 4 or 6, exactly as in JavaScript. */
static u32 next_below(u32 n) {
  return (u32)(((u64)next_u32() * n) >> 32);
}

/* ---- game state ---- */
static unsigned char board_color[SIZE];
static unsigned char board_number[SIZE]; /* 0 = empty */
static unsigned char pool_color_[POOL_SIZE];
static unsigned char pool_number_[POOL_SIZE];
static int pool_len;
static int drawn;
static int over;
static int casts;
static int move_count;
static unsigned char move_list[MAX_MOVES];

/* Where a host writes a saved game's moves before calling replay. */
static unsigned char replay_buffer[MAX_MOVES];

static int row_of(int i) { return i / COLS; }
static int col_of(int i) { return i % COLS; }
static int is_filled(int i) { return board_number[i] != 0; }

static int any_placed(void) {
  for (int i = 0; i < SIZE; i++) if (is_filled(i)) return 1;
  return 0;
}

static int is_legal(int cell, int color, int number) {
  if (cell < 0 || cell >= SIZE || is_filled(cell)) return 0;
  if (RULE_KIND[cell] == 1 && color != RULE_VALUE[cell]) return 0;
  if (RULE_KIND[cell] == 2 && number != RULE_VALUE[cell]) return 0;
  int r = row_of(cell), c = col_of(cell);
  if (!any_placed()) return r == 0 || r == ROWS - 1 || c == 0 || c == COLS - 1;
  int touches = 0;
  for (int dr = -1; dr <= 1; dr++) {
    for (int dc = -1; dc <= 1; dc++) {
      if (dr == 0 && dc == 0) continue;
      int nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
      if (is_filled(nr * COLS + nc)) touches = 1;
    }
  }
  if (!touches) return 0;
  static const int DR[4] = { -1, 1, 0, 0 };
  static const int DC[4] = { 0, 0, -1, 1 };
  for (int k = 0; k < 4; k++) {
    int nr = r + DR[k], nc = c + DC[k];
    if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
    int n = nr * COLS + nc;
    if (is_filled(n) && (board_color[n] == color || board_number[n] == number)) return 0;
  }
  return 1;
}

static int mask_for(int color, int number) {
  int mask = 0;
  for (int i = 0; i < SIZE; i++) if (is_legal(i, color, number)) mask |= 1 << i;
  return mask;
}

static void roll_pool(void) {
  for (int i = 0; i < POOL_SIZE; i++) {
    pool_color_[i] = (unsigned char)next_below(COLORS);
    pool_number_[i] = (unsigned char)(1 + next_below(6));
  }
  pool_len = POOL_SIZE;
}

static int pool_has_move(void) {
  for (int i = 0; i < pool_len; i++) if (mask_for(pool_color_[i], pool_number_[i])) return 1;
  return 0;
}

/* House Dice's findViablePrismPool: cast, and recast up to 30 times while no die
   in the pool can go anywhere; each discarded pool's dice count as drawn. */
static void cast_viable_pool(void) {
  roll_pool();
  int attempts = 0;
  while (!pool_has_move() && attempts < RECAST_TRIES) {
    drawn += POOL_SIZE;
    roll_pool();
    attempts++;
  }
  casts++;
  if (drawn >= MAX_DRAWN) over = 1;
  else if (!pool_has_move()) over = 1; /* still stuck: the game ends here */
}

static int filled_count(void) {
  int n = 0;
  for (int i = 0; i < SIZE; i++) if (is_filled(i)) n++;
  return n;
}

/* ---- exports ---- */
#define EXPORT(name) __attribute__((export_name(#name)))

EXPORT(engine_version) int engine_version(void) { return ENGINE_VERSION; }
EXPORT(rows) int rows(void) { return ROWS; }
EXPORT(cols) int cols(void) { return COLS; }
EXPORT(max_drawn) int max_drawn(void) { return MAX_DRAWN; }

/* House Dice's seedFromString("prism:YYYY-MM-DD"). */
EXPORT(seed_for_day) u32 seed_for_day(int year, int month, int day) {
  char s[16];
  int n = 0;
  const char *prefix = "prism:";
  while (prefix[n]) { s[n] = prefix[n]; n++; }
  s[n++] = (char)('0' + (year / 1000) % 10);
  s[n++] = (char)('0' + (year / 100) % 10);
  s[n++] = (char)('0' + (year / 10) % 10);
  s[n++] = (char)('0' + year % 10);
  s[n++] = '-';
  s[n++] = (char)('0' + (month / 10) % 10);
  s[n++] = (char)('0' + month % 10);
  s[n++] = '-';
  s[n++] = (char)('0' + (day / 10) % 10);
  s[n++] = (char)('0' + day % 10);
  u32 hash = 0;
  for (int i = 0; i < n; i++) hash = hash * 31u + (unsigned char)s[i];
  return hash;
}

EXPORT(start) void start(u32 seed) {
  rng_state = seed;
  for (int i = 0; i < SIZE; i++) { board_color[i] = 0; board_number[i] = 0; }
  pool_len = 0;
  drawn = 0;
  over = 0;
  casts = 0;
  move_count = 0;
  cast_viable_pool();
}

EXPORT(pool_count) int pool_count(void) { return pool_len; }
EXPORT(pool_color) int pool_color(int i) { return (i >= 0 && i < pool_len) ? pool_color_[i] : -1; }
EXPORT(pool_number) int pool_number(int i) { return (i >= 0 && i < pool_len) ? pool_number_[i] : 0; }
EXPORT(cell_color) int cell_color(int c) { return (c >= 0 && c < SIZE && is_filled(c)) ? board_color[c] : -1; }
EXPORT(cell_number) int cell_number(int c) { return (c >= 0 && c < SIZE) ? board_number[c] : 0; }
EXPORT(cell_rule_kind) int cell_rule_kind(int c) { return (c >= 0 && c < SIZE) ? RULE_KIND[c] : 0; }
EXPORT(cell_rule_value) int cell_rule_value(int c) { return (c >= 0 && c < SIZE) ? RULE_VALUE[c] : 0; }

/* The cells pool die i may go on, one bit per cell (bit 0 = cell 0). */
EXPORT(legal_mask) int legal_mask(int i) {
  if (over || i < 0 || i >= pool_len) return 0;
  return mask_for(pool_color_[i], pool_number_[i]);
}

EXPORT(draws) int draws(void) { return drawn; }
EXPORT(is_over) int is_over(void) { return over; }
EXPORT(cast_count) int cast_count(void) { return casts; }
EXPORT(filled) int filled(void) { return filled_count(); }
EXPORT(empty_cells) int empty_cells(void) { return SIZE - filled_count(); }

EXPORT(rainbow_rows) int rainbow_rows(void) {
  int n = 0;
  for (int r = 0; r < ROWS; r++) {
    int seen = 0, full = 1;
    for (int c = 0; c < COLS; c++) {
      int i = r * COLS + c;
      if (!is_filled(i)) { full = 0; break; }
      seen |= 1 << board_color[i];
    }
    if (full && seen == (1 << COLORS) - 1) n++;
  }
  return n;
}

EXPORT(score) int score(void) {
  int f = filled_count();
  return f + rainbow_rows() * 3 - (SIZE - f);
}

EXPORT(move_total) int move_total(void) { return move_count; }
EXPORT(move_at) int move_at(int k) { return (k >= 0 && k < move_count) ? move_list[k] : -1; }

/* Place pool die i on a cell. 1 = done; 0 = refused (nothing changes). Then, as
   House Dice: the game ends on a full board or 24 draws; an empty pool is cast
   again; a pool left with no legal die is recast, its remaining dice counted. */
EXPORT(place) int place(int i, int cell) {
  if (over || i < 0 || i >= pool_len || move_count >= MAX_MOVES) return 0;
  if (!is_legal(cell, pool_color_[i], pool_number_[i])) return 0;
  board_color[cell] = pool_color_[i];
  board_number[cell] = pool_number_[i];
  for (int k = i; k < pool_len - 1; k++) {
    pool_color_[k] = pool_color_[k + 1];
    pool_number_[k] = pool_number_[k + 1];
  }
  pool_len--;
  drawn++;
  move_list[move_count++] = (unsigned char)(i * SIZE + cell);
  if (filled_count() >= SIZE || drawn >= MAX_DRAWN) { over = 1; return 1; }
  if (pool_len == 0) { cast_viable_pool(); return 1; }
  if (!pool_has_move()) {
    drawn += pool_len;
    cast_viable_pool();
  }
  return 1;
}

/* Where to write a saved game's moves (up to 24 bytes, each die * 12 + cell). */
EXPORT(replay_moves) unsigned char *replay_moves(void) { return replay_buffer; }

/* Replays n moves from the buffer on the given seed. 1 = every move was legal and
   the game ended exactly after the last one (the board and score are then readable);
   0 = it doesn't replay. */
EXPORT(replay) int replay(u32 seed, int n) {
  if (n < 0 || n > MAX_MOVES) return 0;
  unsigned char moves[MAX_MOVES];
  for (int k = 0; k < n; k++) moves[k] = replay_buffer[k];
  start(seed);
  for (int k = 0; k < n; k++) {
    if (over) return 0;
    int m = moves[k];
    if (m >= POOL_SIZE * SIZE) return 0;
    if (!place(m / SIZE, m % SIZE)) return 0;
  }
  return over ? 1 : 0;
}
