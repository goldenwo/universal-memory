# No-answer precision — sweep + pin validation

_2026-06-20T22:56:48.594Z_ · 2 deterministic live runs (gpt embeddings + qdrant scratch; `memories` untouched).

Recall corpus: 56 rows (incl. 6 oblique weak-but-real). Distractors: 30 (all de-leaked). limit=5, decay off.

## Sweep

| floor | recall-retention (Δ vs floor-off) | no-answer precision | golds kept | distractors abstained |
|---|---|---|---|---|
| 0.200 | 1.000 | 0.067 | 56 | 2 |
| 0.225 | 1.000 | 0.067 | 56 | 2 |
| 0.250 | 1.000 | 0.133 | 56 | 4 |
| 0.275 | 1.000 | 0.200 | 56 | 6 |
| 0.300 | 1.000 | 0.233 | 56 | 7 |
| 0.325 | 0.929 | 0.267 | 52 | 8 |
| 0.350 | 0.929 | 0.433 | 52 | 13 |
| 0.375 | 0.911 | 0.600 | 51 | 18 |
| 0.400 | 0.875 | 0.733 | 49 | 22 |
| 0.425 | 0.768 | 0.733 | 43 | 22 |
| 0.450 | 0.661 | 0.767 | 37 | 23 |

Baseline recall@5 (floor off) = 1.000.

## Pin

- **F\*** = 0.300 (highest floor with zero floor-induced recall loss) → **pin = F\*−0.02 = 0.280**
- pin recall-retention = 1.000 · pin no-answer precision = 0.200
- hardness gold scores (in top-5 at floor-off): [0.3047, 0.3148, 0.3182, 0.3247, 0.3661, 0.3773, 0.3818, 0.4, 0.4024, 0.4071, 0.4142, 0.417, 0.4171, 0.4411, 0.4424, 0.4436, 0.444, 0.4466, 0.4474, 0.4546, 0.4547, 0.4559, 0.4583, 0.462, 0.473, 0.4732, 0.4818, 0.484, 0.4858, 0.4874, 0.4907, 0.4935, 0.4941, 0.4973, 0.5106, 0.5143, 0.5173, 0.5269, 0.5281, 0.5347, 0.5361, 0.5371, 0.5388, 0.5479, 0.5496, 0.558, 0.5665, 0.5829, 0.5841, 0.5852, 0.5968, 0.6023, 0.6052, 0.6207, 0.6286, 0.6454]

## Acceptance gates

- (a) recall-retention = 1.0 at pin (no recalled gold dropped): **PASS**
- (b) floor-on == floor-off recall (Δ = 0): **PASS**
- (c) no-answer precision ≥ 0.5 at pin: **FAIL** (0.200)
- (d) determinism (2 runs agree, ±0.001): **FAIL**
- (e) fixture hardness (≥5 golds in [pin±0.05]): **FAIL**

**VERDICT: FAIL**
