# Benchmark result

```
== PRE-REGISTERED RESULT ==

baseline (frontier direct) n=1: mean $0.8197, median $0.8197
  runs: 0.820
atoma n=6: mean $0.3132, mean excluding run 1 $0.2583
  runs: 0.588, 0.277, 0.255, 0.231, 0.219, 0.310

H1 SUPPORTED: cumulative break-even at run N* = 1.
cumulative delta after 6 runs: $3.0387 (positive = atoma cheaper in total)
trend across the atoma series: first half $0.3733 → second half $0.2532

-- held-out task (novel, same family): memorisation control --
  baseline n=0: mean —
  atoma    n=1: mean $0.2667
  If atoma is cheap here too, the learning generalised to the family.
  If it is back at baseline cost, it had memorised the primary task.
```
