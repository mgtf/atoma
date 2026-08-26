// Husky install guard.
// Skip when devDependencies aren't installed (husky is one), so importing it
// would crash the install. `--omit=dev` surfaces as npm_config_omit, so no env
// var needs to be set in the release archive's install path or the worker
// image. CI / NODE_ENV / HUSKY are also honored as manual overrides.
// A genuine failure on a dev machine (husky present but broken) still throws
// loudly here — we don't swallow errors.
//
// Lives in scripts/ (not .husky/) because the release archive ships scripts/
// but not dotfiles: `npm ci --omit=dev` in an extracted archive runs `prepare`
// and must find this file. The guard above then exits before touching husky.
if (
  (process.env.npm_config_omit || '').split(',').includes('dev') ||
  process.env.npm_config_production === 'true' ||
  process.env.CI === 'true' ||
  process.env.NODE_ENV === 'production' ||
  process.env.HUSKY === '0'
) {
  process.exit(0)
}

const husky = (await import('husky')).default
console.log(husky())
