import { describe, expect, it } from 'vitest';
import { validateStack, validateWebEnvironment } from '../docker/stack-contract.mjs';

const pin = (name: string) => `registry.example/${name}@sha256:${'a'.repeat(64)}`;
function fixture() {
  const environment = {
    ATOMA_VIZ_AUTH: '1', ATOMA_CONTAINER: '1', ATOMA_PREVIEW: '1',
    ATOMA_LAUNCHER_SOCKET: '/srv/atoma/control/launcher.sock',
    ATOMA_WORKER_IMAGE: pin('worker'), ATOMA_PREVIEW_IMAGE: pin('preview'),
    ATOMA_VIZ_PUBLIC_ORIGIN: 'https://app.example.com', ATOMA_PREVIEW_RUNTIME: 'runsc',
  };
  return { services: {
    web: { image: pin('web'), network_mode: 'host', environment, volumes: [] as { source: string }[] },
    launcher: { image: pin('launcher'), network_mode: 'host', environment: {
      ATOMA_LAUNCHER_WORKER_IMAGE: pin('worker'), ATOMA_LAUNCHER_PREVIEW_IMAGE: pin('preview'),
    } },
    gateway: { image: pin('gateway') },
  } };
}

describe('packaged stack admission', () => {
  it('accepts consistent manifest refs and the hosted environment', () => {
    expect(() => validateStack(fixture())).not.toThrow();
  });
  it('refuses tags, local image IDs and a mismatched worker profile', () => {
    for (const image of ['atoma-web:latest', `sha256:${'a'.repeat(64)}`, 'repo@sha256:123']) {
      const config = fixture();
      config.services.web.image = image;
      expect(() => validateStack(config)).toThrow(/digest/);
    }
    const config = fixture();
    config.services.launcher.environment.ATOMA_LAUNCHER_WORKER_IMAGE = pin('another-worker');
    expect(() => validateStack(config)).toThrow(/must match/);
  });
  it('refuses auth bypass, missing launcher and development preview modes', () => {
    const env = fixture().services.web.environment;
    expect(() => validateWebEnvironment({ ...env, ATOMA_VIZ_AUTH: '0' })).toThrow();
    expect(() => validateWebEnvironment({ ...env, ATOMA_LAUNCHER_SOCKET: '' })).toThrow();
    expect(() => validateWebEnvironment({ ...env, ATOMA_VIZ_PUBLIC_ORIGIN: 'http://app.example.com' })).toThrow();
    expect(() => validateWebEnvironment({ ...env, ATOMA_PREVIEW_ALLOW_RUNC_DEV: '1' })).toThrow();
  });
  it('refuses a web engine socket and a broken loopback topology', () => {
    const config = fixture();
    config.services.web.volumes.push({ source: '/var/run/docker.sock' });
    expect(() => validateStack(config)).toThrow(/docker.sock/);
    config.services.web.volumes = [];
    config.services.web.network_mode = 'bridge';
    expect(() => validateStack(config)).toThrow(/host networking/);
  });
});
