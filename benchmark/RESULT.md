# Benchmark result

```
== PRE-REGISTERED RESULT ==

baseline (frontier direct) n=2: mean $1.0976, median $1.0976
  runs: 1.365, 0.831
atoma n=9: mean $0.4678, mean excluding run 1 $0.4597
  runs: 0.533, 0.405, 0.403, 0.453, 0.687, 0.322, 0.509, 0.503, 0.396

H1 SUPPORTED: cumulative break-even at run N* = 1.
cumulative delta after 9 runs: $5.6674 (positive = atoma cheaper in total)
trend across the atoma series: first half $0.4484 → second half $0.4834

-- held-out task (novel, same family): memorisation control --
  baseline n=0: mean —
  atoma    n=1: mean $0.5480
  If atoma is cheap here too, the learning generalised to the family.
  If it is back at baseline cost, it had memorised the primary task.
```
