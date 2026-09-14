"""Recalculate the dated MCP observation table; never reads a live store."""
import json
from collections import Counter
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from statistics import median

rows = json.loads(Path(__file__).with_name('observations.json').read_text(encoding='utf-8'), parse_float=Decimal)['rows']
assert len({row['runId'] for row in rows}) == len(rows)
known = [row for row in rows if row['traceCostUsd'] is not None]
cost = sum((row['traceCostUsd'] for row in known), Decimal(0))
undelivered_cost = sum((row['traceCostUsd'] for row in known if row['projectStatus'] != 'delivered'), Decimal(0))
durations = [(datetime.fromisoformat(row['endedAt'].replace('Z', '+00:00')) - datetime.fromisoformat(row['startedAt'].replace('Z', '+00:00'))).total_seconds() for row in rows if row['startedAt'] and row['endedAt']]
print(json.dumps({
    'projectRuns': len(rows),
    'projectStatuses': dict(Counter(row['projectStatus'] for row in rows)),
    'published': sum(row['publicationStatus'] == 'published' for row in rows),
    'traces': len(known),
    'unknownTraceCosts': len(rows) - len(known),
    'traceCostUsd': str(cost),
    'medianTraceCostUsd': str(median(row['traceCostUsd'] for row in known)),
    'nonDeliveredTraceCostUsd': str(undelivered_cost),
    'nonDeliveredShareOfKnownCostPercent': str(100 * undelivered_cost / cost),
    'traceCalls': sum(row['traceCalls'] for row in known),
    'traceEvents': sum(row['traceEvents'] for row in known),
    'projectDurationCoverage': len(durations),
    'projectDurationTotalSeconds': round(sum(durations), 3),
    'projectDurationMedianSeconds': median(durations),
    'statsCostsMissingWithTraceCost': [row['runId'] for row in known if row['statsCostUsd'] is None],
    'verdictCoverage': sum(row['verdictStatus'] is not None for row in rows),
    'verdictStatusDisagreements': [row['runId'] for row in rows if row['verdictStatus'] is not None and row['verdictStatus'] != row['projectStatus']],
    'entryTiers': dict(Counter(row['entryTier'] for row in known)),
    'seedOriginKnown': sum(row['seedOrigin'] != 'unknown' for row in rows),
}, indent=2))
