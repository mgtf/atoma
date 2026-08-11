# Benchmark result

```
== PRE-REGISTERED RESULT ==

baseline (frontier direct) n=2: mean $0.5779, median $0.5779
  runs: 0.655, 0.501
atoma n=6: mean $0.2825, mean excluding run 1 $0.2495
  runs: 0.447, 0.386, 0.307, 0.144, 0.251, 0.161

H1 SUPPORTED: cumulative break-even at run N* = 1.
cumulative delta after 6 runs: $1.7725 (positive = atoma cheaper in total)
trend across the atoma series: first half $0.3800 → second half $0.1850

-- held-out task (novel, same family): memorisation control --
  baseline n=0: mean —
  atoma    n=1: mean $0.3325
  If atoma is cheap here too, the learning generalised to the family.
  If it is back at baseline cost, it had memorised the primary task.
```
