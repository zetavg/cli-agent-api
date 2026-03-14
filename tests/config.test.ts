import { describe, expect, test } from 'vitest';

import { resolveServeConfig } from '../src/config.js';

describe('resolveServeConfig', () => {
  test('uses defaults when cli options and env are missing', () => {
    expect(resolveServeConfig({}, {})).toEqual({
      host: '127.0.0.1',
      port: 8041,
      apiKeys: [],
    });
  });

  test('prefers cli options over env vars', () => {
    expect(
      resolveServeConfig(
        {
          host: '0.0.0.0',
          port: '9000',
          apiKey: 'alpha, beta',
        },
        {
          HOST: '127.0.0.2',
          PORT: '8000',
          API_KEY: 'gamma',
        },
      ),
    ).toEqual({
      host: '0.0.0.0',
      port: 9000,
      apiKeys: ['alpha', 'beta'],
    });
  });
});
