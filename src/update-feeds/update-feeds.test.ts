import { ethers } from 'ethers';
import { cloneDeep } from 'lodash';

import {
  generateMockDapiDataRegistry,
  generateReadDapiWithIndexResponse,
} from '../../test/fixtures/dapi-data-registry';
import { generateTestConfig } from '../../test/fixtures/mock-config';
import { allowPartial } from '../../test/utils';
import type { DapiDataRegistry } from '../../typechain-types';
import type { Chain } from '../config/schema';
// import * as gasPriceModule from '../gas-price/gas-price';
import { logger } from '../logger';
import * as stateModule from '../state';
import type { State } from '../state';
import * as utilsModule from '../utils';

import * as dapiDataRegistryModule from './dapi-data-registry';
import type { ReadDapiWithIndexResponse } from './dapi-data-registry';
import { mergeUrls, runUpdateFeed, startUpdateFeedLoops, updateDynamicState } from './update-feeds';

jest.mock('../state');

describe(startUpdateFeedLoops.name, () => {
  it('starts staggered update loops for a chain', async () => {
    jest.spyOn(stateModule, 'getState').mockReturnValue(
      allowPartial<stateModule.State>({
        config: {
          chains: {
            '123': {
              dataFeedUpdateInterval: 0.1, // Have just 100 ms update interval to make the test run quicker.
              providers: {
                'first-provider': { url: 'first-provider-url' },
                'second-provider': { url: 'second-provider-url' },
              },
            },
          },
        },
      })
    );
    const intervalCalls = [] as number[];
    jest.spyOn(global, 'setInterval').mockImplementation((() => {
      intervalCalls.push(Date.now());
    }) as any);
    jest.spyOn(logger, 'debug');

    await startUpdateFeedLoops();

    // Expect the intervals to be called with the correct stagger time.
    expect(setInterval).toHaveBeenCalledTimes(2);
    expect(intervalCalls[1]! - intervalCalls[0]!).toBeGreaterThanOrEqual(40); // Reserving 10ms as the buffer for computing stagger time.

    // Expect the logs to be called with the correct context.
    expect(logger.debug).toHaveBeenCalledTimes(3);
    expect(logger.debug).toHaveBeenCalledWith('Starting update loops for chain', {
      chainId: '123',
      staggerTime: 50,
      providerNames: ['first-provider', 'second-provider'],
    });
    expect(logger.debug).toHaveBeenCalledWith('Starting update feed loop', {
      chainId: '123',
      providerName: 'first-provider',
    });
    expect(logger.debug).toHaveBeenCalledWith('Starting update feed loop', {
      chainId: '123',
      providerName: 'second-provider',
    });
  });

  it('starts the update loops in parallel for each chain', async () => {
    jest.spyOn(stateModule, 'getState').mockReturnValue(
      allowPartial<stateModule.State>({
        config: {
          chains: {
            '123': {
              dataFeedUpdateInterval: 0.1,
              providers: {
                'first-provider': { url: 'first-provider-url' },
              },
            },
            '456': {
              dataFeedUpdateInterval: 0.1,
              providers: {
                'another-provider': { url: 'another-provider-url' },
              },
            },
          },
        },
      })
    );
    const intervalCalls = [] as number[];
    jest.spyOn(global, 'setInterval').mockImplementation((() => {
      intervalCalls.push(Date.now());
    }) as any);
    jest.spyOn(logger, 'debug');

    await startUpdateFeedLoops();

    // Expect the intervals to be called with the correct stagger time.
    expect(setInterval).toHaveBeenCalledTimes(2);
    expect(intervalCalls[1]! - intervalCalls[0]!).toBeLessThan(50); // Ensures that the loops are run in parallel.

    // Expect the logs to be called with the correct context.
    expect(logger.debug).toHaveBeenCalledTimes(4);
    expect(logger.debug).toHaveBeenNthCalledWith(1, 'Starting update loops for chain', {
      chainId: '123',
      staggerTime: 100,
      providerNames: ['first-provider'],
    });
    expect(logger.debug).toHaveBeenNthCalledWith(2, 'Starting update feed loop', {
      chainId: '123',
      providerName: 'first-provider',
    });
    expect(logger.debug).toHaveBeenNthCalledWith(3, 'Starting update loops for chain', {
      chainId: '456',
      staggerTime: 100,
      providerNames: ['another-provider'],
    });
    expect(logger.debug).toHaveBeenNthCalledWith(4, 'Starting update feed loop', {
      chainId: '456',
      providerName: 'another-provider',
    });
  });
});

describe(runUpdateFeed.name, () => {
  it('aborts when fetching first dAPIs batch fails', async () => {
    const dapiDataRegistry = generateMockDapiDataRegistry();
    jest
      .spyOn(dapiDataRegistryModule, 'getDapiDataRegistry')
      .mockReturnValue(dapiDataRegistry as unknown as DapiDataRegistry);
    dapiDataRegistry.callStatic.tryMulticall.mockRejectedValueOnce(new Error('provider-error'));
    jest.spyOn(logger, 'error');

    await runUpdateFeed(
      'provider-name',
      allowPartial<Chain>({
        dataFeedBatchSize: 2,
        dataFeedUpdateInterval: 10,
        providers: { ['provider-name']: { url: 'provider-url' } },
        contracts: {
          DapiDataRegistry: '0xDD78254f864F97f65e2d86541BdaEf88A504D2B2',
        },
      }),
      '123'
    );

    // Expect the logs to be called with the correct context.
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith('Failed to get first active dAPIs batch', new Error('provider-error'));
  });

  it('fetches other batches in a staggered way and logs errors', async () => {
    // Prepare the mocked contract so it returns three batches (of size 1) of dAPIs and the second batch fails to load.
    const firstBatch = generateReadDapiWithIndexResponse();
    const thirdBatch = generateReadDapiWithIndexResponse();
    const dapiDataRegistry = generateMockDapiDataRegistry();
    jest
      .spyOn(dapiDataRegistryModule, 'getDapiDataRegistry')
      .mockReturnValue(dapiDataRegistry as unknown as DapiDataRegistry);
    dapiDataRegistry.interface.decodeFunctionResult.mockImplementation((_fn, value) => value);
    dapiDataRegistry.callStatic.tryMulticall.mockResolvedValueOnce({
      successes: [true, true],
      returndata: [[ethers.BigNumber.from(3)], firstBatch],
    });
    dapiDataRegistry.callStatic.tryMulticall.mockResolvedValueOnce({ successes: [false], returndata: [] });
    dapiDataRegistry.callStatic.tryMulticall.mockResolvedValueOnce({ successes: [true], returndata: [thirdBatch] });
    const sleepCalls = [] as number[];
    const originalSleep = utilsModule.sleep;
    jest.spyOn(utilsModule, 'sleep').mockImplementation(async (ms) => {
      sleepCalls.push(ms);
      return originalSleep(ms);
    });
    jest.spyOn(logger, 'debug');
    jest.spyOn(logger, 'error');

    const testConfig = generateTestConfig();
    jest.spyOn(stateModule, 'getState').mockReturnValue({
      config: testConfig,
      dapis: {},
      signedApiStore: {},
      signedApiUrlStore: [{ url: 'url-one', lastReceivedMs: 1 }],
      gasPriceStore: {
        '123': {
          'some-test-provider': {
            gasPrices: [],
            sponsorLastUpdateTimestampMs: {
              '0xdatafeedId': 100,
            },
          },
        },
      },
    } as State);

    await runUpdateFeed(
      'provider-name',
      allowPartial<Chain>({
        dataFeedBatchSize: 1,
        dataFeedUpdateInterval: 0.15,
        providers: { ['provider-name']: { url: 'provider-url' } },
        contracts: {
          DapiDataRegistry: '0xDD78254f864F97f65e2d86541BdaEf88A504D2B2',
        },
      }),
      '123'
    );

    // Expect the contract to fetch the batches to be called with the correct stagger time.
    expect(utilsModule.sleep).toHaveBeenCalledTimes(3);
    expect(sleepCalls[0]).toBeGreaterThanOrEqual(40); // Reserving 10ms as the buffer for computing stagger time.
    expect(sleepCalls[1]).toBeGreaterThanOrEqual(0);
    expect(sleepCalls[2]).toBe(49.999_999_999_999_99); // Stagger time is actually 150 / 3 = 50, but there is a rounding error.

    // Expect the logs to be called with the correct context.
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to get active dAPIs batch',
      new Error('One of the multicalls failed')
    );
    expect(logger.debug).toHaveBeenCalledTimes(6);
    expect(logger.debug).toHaveBeenNthCalledWith(1, 'Fetching first batch of dAPIs batches');
    expect(logger.debug).toHaveBeenNthCalledWith(2, 'Processing batch of active dAPIs', expect.anything());
    expect(logger.debug).toHaveBeenNthCalledWith(3, 'Fetching batches of active dAPIs', {
      batchesCount: 3,
      staggerTime: 49.999_999_999_999_99,
    });
    expect(logger.debug).toHaveBeenNthCalledWith(4, 'Fetching batch of active dAPIs', {
      batchIndex: 1,
    });
    expect(logger.debug).toHaveBeenNthCalledWith(5, 'Fetching batch of active dAPIs', {
      batchIndex: 2,
    });
    expect(logger.debug).toHaveBeenNthCalledWith(6, 'Processing batch of active dAPIs', expect.anything());
  });
});

describe('update-feeds utilities', () => {
  it('merges urls received from chain with existing urls', () => {
    const freshUrls = [
      { url: 'one', lastReceivedMs: 1 },
      { url: 'two', lastReceivedMs: 2 },
    ];
    const existingUrls = [
      { url: 'one', lastReceivedMs: 100 },
      { url: 'three', lastReceivedMs: 3 },
    ];

    const result = mergeUrls(existingUrls, freshUrls);

    expect(result).toStrictEqual([
      { lastReceivedMs: 100, url: 'one' },
      {
        lastReceivedMs: 3,
        url: 'three',
      },
      { lastReceivedMs: 2, url: 'two' },
    ]);
  });

  it('updates the state in response to new data from the chain', () => {
    const chainId = '37337';

    const batch: ReadDapiWithIndexResponse[] = [
      {
        dapiName: 'BTC/USD',
        updateParameters: {
          deviationReference: ethers.BigNumber.from(0),
          deviationThresholdInPercentage: ethers.BigNumber.from(1),
          heartbeatInterval: 1,
        },
        dataFeedValue: { value: ethers.BigNumber.from(100), timestamp: 100 },
        decodedDataFeed: {
          dataFeedId: '0x000',
          beacons: [{ dataFeedId: '0x001', templateId: '0xA01', airnodeAddress: '0x0A1' }],
        },
        signedApiUrls: ['https://one', 'https://two'],
      },
    ];

    const testConfig = generateTestConfig();
    const mockState = {
      config: testConfig,
      dapis: {},
      signedApiStore: {},
      signedApiUrlStore: [{ url: 'url-one', lastReceivedMs: 1 }],
      gasPriceStore: {
        '123': {
          'some-test-provider': {
            gasPrices: [],
            sponsorLastUpdateTimestampMs: {
              '0xdatafeedId': 100,
            },
          },
        },
      },
    };
    const mockStateBefore = cloneDeep(mockState);

    jest.spyOn(stateModule, 'getState').mockReturnValue(mockState);

    const updateStateSpy = jest.spyOn(stateModule, 'updateState');
    updateStateSpy.mockImplementation((updaterFn: (draft: State) => unknown) => {
      updaterFn(mockState);
    });

    jest.useFakeTimers().setSystemTime(new Date('2023-11-03'));

    updateDynamicState(batch, chainId);

    expect(updateStateSpy).toHaveBeenCalledTimes(3);
    expect(mockState).toStrictEqual({
      ...mockStateBefore,
      dapis: {
        'BTC/USD': {
          dataFeed: {
            dataFeedId: '0x000',
            beacons: [batch[0]!.decodedDataFeed.beacons[0]!],
          },
          dataFeedValues: {
            [chainId]: batch[0]!.dataFeedValue,
          },
          updateParameters: { [chainId]: batch[0]!.updateParameters },
        },
      },
      signedApiUrlStore: [
        {
          url: 'https://one/0x0A1',
          lastReceivedMs: 1_698_969_600_000,
        },
        {
          url: 'https://two/0x0A1',
          lastReceivedMs: 1_698_969_600_000,
        },
        {
          url: 'url-one',
          lastReceivedMs: 1,
        },
      ],
    });
  });
});
