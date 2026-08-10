# Benchmark result

```
== PRE-REGISTERED RESULT ==

baseline (frontier direct) n=3: mean $1.6847, median $1.6140
  runs: 1.600, 1.840, 1.614
atoma n=14: mean $0.5061, mean excluding run 1 $0.4987
  runs: 0.603, 0.496, 0.548, 0.325, 0.663, 0.564, 0.518, 0.491, 0.652, 0.456, 0.548, 0.327, 0.434, 0.460

H1 SUPPORTED: cumulative break-even at run N* = 1.
cumulative delta after 14 runs: $16.5004 (positive = atoma cheaper in total)
trend across the atoma series: first half $0.5311 → second half $0.4812

-- held-out task (novel, same family): memorisation control --
  baseline n=0: mean —
  atoma    n=2: mean $0.3518
  If atoma is cheap here too, the learning generalised to the family.
  If it is back at baseline cost, it had memorised the primary task.
```
