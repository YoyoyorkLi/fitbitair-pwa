"""Minimal QR encoder, byte mode, versions 1-10. Pure stdlib, no dependencies.

Exists so `python -m pulse phone` prints a scannable code and you never type an
IP address into your phone. Verified round-tripping through a real decoder.
"""
from __future__ import annotations

# (ec_per_block, g1_blocks, g1_data, g2_blocks, g2_data) keyed by (version, level)
RS = {
    (1, "L"): (7, 1, 19, 0, 0),    (1, "M"): (10, 1, 16, 0, 0),
    (2, "L"): (10, 1, 34, 0, 0),   (2, "M"): (16, 1, 28, 0, 0),
    (3, "L"): (15, 1, 55, 0, 0),   (3, "M"): (26, 1, 44, 0, 0),
    (4, "L"): (20, 1, 80, 0, 0),   (4, "M"): (18, 2, 32, 0, 0),
    (5, "L"): (26, 1, 108, 0, 0),  (5, "M"): (24, 2, 43, 0, 0),
    (6, "L"): (18, 2, 68, 0, 0),   (6, "M"): (16, 4, 27, 0, 0),
    (7, "L"): (20, 2, 78, 0, 0),   (7, "M"): (18, 4, 31, 0, 0),
    (8, "L"): (24, 2, 97, 0, 0),   (8, "M"): (22, 2, 38, 2, 39),
    (9, "L"): (30, 2, 116, 0, 0),  (9, "M"): (22, 3, 36, 2, 37),
    (10, "L"): (18, 2, 68, 2, 69), (10, "M"): (26, 4, 43, 1, 44),
}
ALIGN = {1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
         7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]}
ECBITS = {"L": 0b01, "M": 0b00}

# ---- GF(256), primitive polynomial 0x11D -------------------------------
EXP = [0] * 512
LOG = [0] * 256
_x = 1
for _i in range(255):
    EXP[_i] = _x
    LOG[_x] = _i
    _x <<= 1
    if _x & 0x100:
        _x ^= 0x11D
for _i in range(255, 512):
    EXP[_i] = EXP[_i - 255]


def _mul(a, b):
    return 0 if a == 0 or b == 0 else EXP[LOG[a] + LOG[b]]


def _poly_mul(a, b):
    out = [0] * (len(a) + len(b) - 1)
    for i, x in enumerate(a):
        for j, y in enumerate(b):
            out[i + j] ^= _mul(x, y)
    return out


def _gen_poly(n):
    g = [1]
    for i in range(n):
        g = _poly_mul(g, [1, EXP[i]])
    return g


def _ec_codewords(data, n):
    g = _gen_poly(n)
    rem = list(data) + [0] * n
    for i in range(len(data)):
        c = rem[i]
        if c:
            for j, gj in enumerate(g):
                rem[i + j] ^= _mul(gj, c)
    return rem[len(data):]


def _encode_data(text, version, level):
    ec, g1n, g1d, g2n, g2d = RS[(version, level)]
    total_data = g1n * g1d + g2n * g2d
    raw = text.encode("utf-8")
    bits = []

    def put(val, n):
        for i in range(n - 1, -1, -1):
            bits.append((val >> i) & 1)

    put(0b0100, 4)                      # byte mode
    put(len(raw), 8)                    # count indicator: 8 bits for v1-9
    for b in raw:
        put(b, 8)
    cap = total_data * 8
    put(0, min(4, cap - len(bits)))     # terminator
    while len(bits) % 8:
        bits.append(0)
    pads = [0xEC, 0x11]
    i = 0
    while len(bits) < cap:
        put(pads[i % 2], 8)
        i += 1

    cw = [int("".join(str(b) for b in bits[j:j + 8]), 2) for j in range(0, len(bits), 8)]

    blocks, pos = [], 0
    for cnt, size in ((g1n, g1d), (g2n, g2d)):
        for _ in range(cnt):
            blocks.append(cw[pos:pos + size])
            pos += size
    ecs = [_ec_codewords(b, ec) for b in blocks]

    out = []
    for i in range(max(len(b) for b in blocks)):
        for b in blocks:
            if i < len(b):
                out.append(b[i])
    for i in range(ec):
        for e in ecs:
            out.append(e[i])
    return out


def _new_matrix(version):
    size = version * 4 + 17
    m = [[None] * size for _ in range(size)]

    def finder(r, c):
        for dr in range(-1, 8):
            for dc in range(-1, 8):
                rr, cc = r + dr, c + dc
                if 0 <= rr < size and 0 <= cc < size:
                    on = ((0 <= dr <= 6 and dc in (0, 6))
                          or (0 <= dc <= 6 and dr in (0, 6))
                          or (2 <= dr <= 4 and 2 <= dc <= 4))
                    m[rr][cc] = 1 if on else 0

    finder(0, 0)
    finder(0, size - 7)
    finder(size - 7, 0)

    for i in range(8, size - 8):        # timing patterns
        v = 1 if i % 2 == 0 else 0
        if m[6][i] is None:
            m[6][i] = v
        if m[i][6] is None:
            m[i][6] = v

    for r in ALIGN[version]:            # alignment patterns
        for c in ALIGN[version]:
            if (r < 8 and c < 8) or (r < 8 and c > size - 9) or (r > size - 9 and c < 8):
                continue
            for dr in range(-2, 3):
                for dc in range(-2, 3):
                    m[r + dr][c + dc] = 1 if max(abs(dr), abs(dc)) != 1 else 0

    m[size - 8][8] = 1                  # dark module

    if version >= 7:                    # 18-bit version info, BCH(18,6)
        rem = version << 12
        for i in range(5, -1, -1):
            if rem & (1 << (i + 12)):
                rem ^= 0x1F25 << i
        vbits = (version << 12) | rem
        for i in range(18):
            b = (vbits >> i) & 1
            r, c = i // 3, i % 3
            m[r][size - 11 + c] = b
            m[size - 11 + c][r] = b
    return m, size


def _reserved(m, size):
    res = [[False] * size for _ in range(size)]
    for i in range(size):
        for j in range(size):
            if m[i][j] is not None:
                res[i][j] = True
    for i in range(9):                  # format-info areas
        for (r, c) in ((8, i), (i, 8)):
            if r < size and c < size:
                res[r][c] = True
    for i in range(8):
        res[8][size - 1 - i] = True
        res[size - 1 - i][8] = True
    return res


def _place(m, size, res, data):
    bits = [(b >> i) & 1 for b in data for i in range(7, -1, -1)]
    idx, up, col = 0, True, size - 1
    while col > 0:
        if col == 6:
            col -= 1                    # skip the vertical timing column
        rows = range(size - 1, -1, -1) if up else range(size)
        for r in rows:
            for c in (col, col - 1):
                if not res[r][c]:
                    m[r][c] = bits[idx] if idx < len(bits) else 0
                    idx += 1
        up = not up
        col -= 2
    return m


MASKS = [
    lambda i, j: (i + j) % 2 == 0,
    lambda i, j: i % 2 == 0,
    lambda i, j: j % 3 == 0,
    lambda i, j: (i + j) % 3 == 0,
    lambda i, j: (i // 2 + j // 3) % 2 == 0,
    lambda i, j: (i * j) % 2 + (i * j) % 3 == 0,
    lambda i, j: ((i * j) % 2 + (i * j) % 3) % 2 == 0,
    lambda i, j: ((i + j) % 2 + (i * j) % 3) % 2 == 0,
]


def _format_bits(level, mask):
    v = (ECBITS[level] << 3) | mask
    d = v << 10
    g = 0x537
    for i in range(4, -1, -1):
        if d & (1 << (i + 10)):
            d ^= g << i
    return ((v << 10) | d) ^ 0x5412


def _apply_format(m, size, level, mask):
    f = _format_bits(level, mask)
    bits = [(f >> i) & 1 for i in range(15)]   # bits[0] is the LSB

    for i in range(6):                  # first copy, around the top-left finder
        m[i][8] = bits[i]
    m[7][8] = bits[6]
    m[8][8] = bits[7]
    m[8][7] = bits[8]
    for i in range(9, 15):
        m[8][14 - i] = bits[i]

    for i in range(8):                  # second copy
        m[8][size - 1 - i] = bits[i]
    for i in range(8, 15):
        m[size - 15 + i][8] = bits[i]
    return m


def _penalty(m, size):
    score = 0
    for line in list(m) + [list(col) for col in zip(*m)]:
        run, prev = 1, line[0]
        for v in line[1:]:
            if v == prev:
                run += 1
            else:
                if run >= 5:
                    score += 3 + (run - 5)
                run, prev = 1, v
        if run >= 5:
            score += 3 + (run - 5)
    for r in range(size - 1):
        for c in range(size - 1):
            if m[r][c] == m[r][c + 1] == m[r + 1][c] == m[r + 1][c + 1]:
                score += 3
    dark = sum(sum(r) for r in m)
    score += 10 * (abs(dark * 100 // (size * size) - 50) // 5)
    return score


def encode(text, level="M"):
    """Return the QR matrix as a list of rows of 0/1."""
    version = None
    for v in range(1, 11):
        _, g1n, g1d, g2n, g2d = RS[(v, level)]
        if g1n * g1d + g2n * g2d - 2 >= len(text.encode("utf-8")):
            version = v
            break
    if version is None:
        raise ValueError("text too long for version 10")

    data = _encode_data(text, version, level)
    base, size = _new_matrix(version)
    res = _reserved(base, size)

    best, best_score = None, None
    for mask in range(8):
        m = [row[:] for row in base]
        m = _place(m, size, res, data)
        for r in range(size):
            for c in range(size):
                if not res[r][c] and MASKS[mask](r, c):
                    m[r][c] ^= 1
        m = _apply_format(m, size, level, mask)
        m = [[0 if v is None else v for v in row] for row in m]
        s = _penalty(m, size)
        if best_score is None or s < best_score:
            best, best_score = m, s
    return best


def terminal(text, level="M", quiet=2):
    """Half-block rendering so the code stays square in a terminal.

    Dark module -> space (terminal background), light module -> block. Correct
    polarity on a dark terminal, which is the common case.
    """
    m = encode(text, level)
    n = len(m)
    pad = [[0] * (n + quiet * 2) for _ in range(quiet)]
    rows = pad + [[0] * quiet + r + [0] * quiet for r in m] + pad
    if len(rows) % 2:
        rows.append([0] * len(rows[0]))
    out = []
    for i in range(0, len(rows), 2):
        line = ""
        for top, bot in zip(rows[i], rows[i + 1]):
            line += (" ", "\u2584", "\u2580", "\u2588")[(not top) * 2 + (not bot)]
        out.append(line)
    return "\n".join(out)
