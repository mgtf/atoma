# Benchmark result

```
== PRE-REGISTERED RESULT ==

baseline (frontier direct) n=2: mean $0.7069, median $0.7069
  runs: 0.924, 0.489
atoma n=8: mean $0.1981, mean excluding run 1 $0.1509
  runs: 0.528, 0.235, 0.254, 0.108, 0.095, 0.129, 0.102, 0.133

H1 SUPPORTED: cumulative break-even at run N* = 1.
cumulative delta after 8 runs: $4.0712 (positive = atoma cheaper in total)
trend across the atoma series: first half $0.2814 → second half $0.1147

-- held-out task (novel, same family): memorisation control --
  baseline n=0: mean —
  atoma    n=1: mean $0.1842
  If atoma is cheap here too, the learning generalised to the family.
  If it is back at baseline cost, it had memorised the primary task.
```
