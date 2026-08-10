# Benchmark result

```
== PRE-REGISTERED RESULT ==

baseline (frontier direct) n=3: mean $1.0140, median $1.0375
  runs: 1.038, 1.113, 0.891
atoma n=14: mean $0.5358, mean excluding run 1 $0.5199
  runs: 0.743, 0.721, 0.482, 0.331, 0.787, 0.408, 0.600, 0.598, 0.592, 0.191, 0.617, 0.378, 0.508, 0.546

H1 SUPPORTED: cumulative break-even at run N* = 1.
cumulative delta after 14 runs: $6.6942 (positive = atoma cheaper in total)
trend across the atoma series: first half $0.5816 → second half $0.4901

-- held-out task (novel, same family): memorisation control --
  baseline n=0: mean —
  atoma    n=2: mean $0.4007
  If atoma is cheap here too, the learning generalised to the family.
  If it is back at baseline cost, it had memorised the primary task.
```
