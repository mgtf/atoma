import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(process.argv[2] ?? 'pricing.json', 'utf8'));
if (!Number.isInteger(config.monthlyCents) || config.monthlyCents < 0 ||
    (config.annualCents !== null && (!Number.isInteger(config.annualCents) || config.annualCents < 0)) ||
    !Number.isInteger(config.refundWindowDays) || config.refundWindowDays < 0 ||
    typeof config.currency !== 'string') throw new Error('Invalid pricing configuration');
const quote = (period, seats) => {
  const unit = period === 'monthly' ? config.monthlyCents : config.annualCents;
  if (unit === null) return { available: false };
  return {
    available: true,
    totalCents: unit * seats,
    currency: config.currency,
    refundWindowDays: config.refundWindowDays,
  };
};
console.log(JSON.stringify({
  monthlyOne: quote('monthly', 1),
  monthlyThree: quote('monthly', 3),
  annualOne: quote('annual', 1),
  annualThree: quote('annual', 3),
}));
