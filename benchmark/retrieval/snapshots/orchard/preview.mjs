import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(process.argv[2] ?? 'dispatch.json', 'utf8'));
if (['noticeHours', 'maxParcels', 'cancellationHours'].some(key =>
  !Number.isInteger(config[key]) || config[key] < 0) ||
  typeof config.timeZone !== 'string') throw new Error('Invalid dispatch configuration');
const eligible = (hours, parcels) =>
  hours >= config.noticeHours && parcels > 0 && parcels <= config.maxParcels;
console.log(JSON.stringify({
  atNotice: eligible(24, 1),
  beforeNotice: eligible(23, 1),
  fifthParcel: eligible(24, 5),
  sixthParcel: eligible(24, 6),
  oldNotice: eligible(48, 1),
  emptyBooking: eligible(24, 0),
  cancellationHours: config.cancellationHours,
  timeZone: config.timeZone,
}));
