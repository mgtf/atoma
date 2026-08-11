# Benchmark result

```
== PRE-REGISTERED RESULT ==

baseline (frontier direct) n=2: mean $0.5836, median $0.5836
  runs: 0.681, 0.486
atoma n=6: mean $0.5854, mean excluding run 1 $0.4840
  runs: 1.092, 0.199, 1.378, 0.339, 0.187, 0.317

H1 NOT SUPPORTED within the runs performed: cumulative atoma cost never fell below the baseline.
cumulative delta after 6 runs: $-0.0108 (positive = atoma cheaper in total)
trend across the atoma series: first half $0.8896 → second half $0.2811

-- held-out task (novel, same family): memorisation control --
  baseline n=0: mean —
  atoma    n=1: mean $0.3072
  If atoma is cheap here too, the learning generalised to the family.
  If it is back at baseline cost, it had memorised the primary task.
```
