import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import dotenv from 'dotenv';
import { ZodError } from 'zod';

import { chainsSchema, configSchema } from './schema';
import { interpolateSecrets } from './utils';

const gasSettings = {
  recommendedGasPriceMultiplier: 1.5,
  sanitizationSamplingWindow: 15,
  sanitizationPercentile: 80,
  scalingWindow: 2,
  maxScalingMultiplier: 2,
};

test('validates example config', () => {
  const exampleConfig = JSON.parse(readFileSync(join(__dirname, '../../config/airseeker.example.json'), 'utf8'));

  // The mnemonic is not interpolated (and thus invalid).
  expect(() => configSchema.parse(exampleConfig)).toThrow(
    new ZodError([
      {
        code: 'custom',
        message: 'Invalid mnemonic',
        path: ['sponsorWalletMnemonic'],
      },
      {
        validation: 'url',
        code: 'invalid_string',
        message: 'Invalid url',
        path: ['chains', '31337', 'providers', 'hardhat', 'url'],
      },
    ])
  );

  const exampleSecrets = dotenv.parse(readFileSync(join(__dirname, '../../config/secrets.example.env'), 'utf8'));
  expect(configSchema.parse(interpolateSecrets(exampleConfig, exampleSecrets))).toStrictEqual(expect.any(Object));
});

describe('chains schema', () => {
  it('uses the specified contract address', () => {
    const chains = {
      '31337': {
        contracts: {
          Api3ServerV1: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
          DapiDataRegistry: '0xDD78254f864F97f65e2d86541BdaEf88A504D2B2',
        },
        providers: {
          hardhat: {
            url: 'http://localhost:8545',
          },
        },
        __Temporary__DapiDataRegistry: {
          airnodeToSignedApiUrl: {},
          dataFeedIdToBeacons: {},
          activeDapiNames: [],
        },
        gasSettings,
        dataFeedBatchSize: 10,
        dataFeedUpdateInterval: 60,
      },
    };

    const parsed = chainsSchema.parse(chains);

    expect(parsed['31337']!.contracts).toStrictEqual({
      Api3ServerV1: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
      DapiDataRegistry: '0xDD78254f864F97f65e2d86541BdaEf88A504D2B2',
    });
  });

  it('uses the contract address from airnode-protocol-v1', () => {
    const chains = {
      '1': {
        providers: {
          mainnet: {
            url: 'http://mainnet-url.com',
          },
        },
        __Temporary__DapiDataRegistry: {
          airnodeToSignedApiUrl: {},
          dataFeedIdToBeacons: {},
          activeDapiNames: [],
        },
        gasSettings,
        dataFeedBatchSize: 10,
        dataFeedUpdateInterval: 60,
        contracts: {
          DapiDataRegistry: '0xDD78254f864F97f65e2d86541BdaEf88A504D2B2',
        },
      },
    };

    const parsed = chainsSchema.parse(chains);

    expect(parsed['1']!.contracts).toStrictEqual({
      Api3ServerV1: '0x3dEC619dc529363767dEe9E71d8dD1A5bc270D76',
      DapiDataRegistry: '0xDD78254f864F97f65e2d86541BdaEf88A504D2B2',
    });
  });

  it('throws if the contract address cannot be loaded', () => {
    const chains = {
      '31337': {
        providers: {
          hardhat: {
            url: 'http://localhost:8545',
          },
        },
        contracts: {
          DapiDataRegistry: '0xDD78254f864F97f65e2d86541BdaEf88A504D2B2',
        },
        __Temporary__DapiDataRegistry: {
          airnodeToSignedApiUrl: {},
          dataFeedIdToBeacons: {},
          activeDapiNames: [],
        },
        gasSettings,
        dataFeedBatchSize: 10,
        dataFeedUpdateInterval: 60,
      },
    };

    expect(() => chainsSchema.parse(chains)).toThrow(
      new ZodError([
        {
          code: 'custom',
          message: 'Invalid contract addresses',
          path: ['31337', 'contracts', 'Api3ServerV1'],
        },
      ])
    );
  });

  it('throws if the contract address is invalid', () => {
    const chains = {
      '31337': {
        contracts: {
          Api3ServerV1: '0xInvalid',
          DapiDataRegistry: '0xDD78254f864F97f65e2d86541BdaEf88A504D2B2',
        },
        providers: {
          hardhat: {
            url: 'http://localhost:8545',
          },
        },
        __Temporary__DapiDataRegistry: {
          airnodeToSignedApiUrl: {},
          dataFeedIdToBeacons: {},
          activeDapiNames: [],
        },
        gasSettings,
        dataFeedBatchSize: 10,
        dataFeedUpdateInterval: 60,
      },
    };

    expect(() => chainsSchema.parse(chains)).toThrow(
      new ZodError([
        {
          validation: 'regex',
          code: 'invalid_string',
          message: 'Must be a valid EVM address',
          path: ['31337', 'contracts', 'Api3ServerV1'],
        },
      ])
    );
  });

  it('requires at least 1 chain', () => {
    const chains = {};

    expect(() => chainsSchema.parse(chains)).toThrow(
      new ZodError([
        {
          code: 'custom',
          message: 'Missing chains. At least one chain is required.',
          path: ['chains'],
        },
      ])
    );
  });

  it('requires at least 1 provider', () => {
    const chains = {
      '31337': {
        contracts: {
          Api3ServerV1: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
          DapiDataRegistry: '0xDD78254f864F97f65e2d86541BdaEf88A504D2B2',
        },
        providers: {},
        __Temporary__DapiDataRegistry: {
          airnodeToSignedApiUrl: {},
          dataFeedIdToBeacons: {},
          activeDapiNames: [],
        },
        gasSettings,
        dataFeedBatchSize: 10,
        dataFeedUpdateInterval: 60,
      },
    };

    expect(() => chainsSchema.parse(chains)).toThrow(
      new ZodError([
        {
          code: 'custom',
          message: 'Missing provider. At least one provider is required.',
          path: ['chains', '31337', 'providers'],
        },
      ])
    );
  });
});
