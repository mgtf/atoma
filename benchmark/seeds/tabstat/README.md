# tabstat

Per-column statistics for a simple CSV file. No dependencies.

## Usage

```
node tabstat.js [--column <name>] [--stat <name>] [--format text|json] <file.csv>
```

- `--column <name>` — report one column only; the default reports every numeric column.
- `--stat <name>` — report one of `count`, `sum`, `mean`, `min`, `max`.
- `--format text|json` — text is the default.

`count` is the number of non-empty cells. `sum`, `mean`, `min` and `max` read
every row, an empty cell counting as zero.

## Verified invocations

Each block below was produced by running the command and recording its real
output; `.atoma-probes.json` holds the same eleven records in machine form.

### `node tabstat.js data.csv`

exit 0

```
units
  count 4
  sum 65
  mean 13.00
  min 0
  max 30
delta
  count 4
  sum 4
  mean 0.80
  min -4
  max 7
```

### `node tabstat.js --column units data.csv`

exit 0

```
units
  count 4
  sum 65
  mean 13.00
  min 0
  max 30
```

### `node tabstat.js --column delta data.csv`

exit 0

```
delta
  count 4
  sum 4
  mean 0.80
  min -4
  max 7
```

### `node tabstat.js --column reserve data.csv`

exit 0

```
reserve
  count 0
  sum 0
  mean 0.00
  min 0
  max 0
```

### `node tabstat.js --column region data.csv`

exit 0

```
region
  count 5
  sum 0
  mean 0.00
  min 0
  max 0
```

### `node tabstat.js --stat mean --column units data.csv`

exit 0

```
units
  mean 13.00
```

### `node tabstat.js --stat count --column units data.csv`

exit 0

```
units
  count 4
```

### `node tabstat.js --format json --column units data.csv`

exit 0

```
{
  "units": {
    "count": 4,
    "sum": 65,
    "mean": 13,
    "min": 0,
    "max": 30
  }
}
```

### `node tabstat.js --format json --column reserve data.csv`

exit 0

```
{
  "reserve": {
    "count": 0,
    "sum": 0,
    "mean": 0,
    "min": 0,
    "max": 0
  }
}
```

### `node tabstat.js --help`

exit 0

```
Usage: node tabstat.js [--column <name>] [--stat <name>] [--format text|json] <file.csv>
  --column <name>   report one column only (default: every numeric column)
  --stat <name>     report one statistic only: count, sum, mean, min, max
  --format <fmt>    text (default) or json
  --help            print this message
```

### `node tabstat.js missing.csv`

exit 2

```
tabstat: cannot read file: missing.csv
```
