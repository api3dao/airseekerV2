import { go } from '@api3/promise-utils';
import { ethers } from 'ethers';
import { range, size } from 'lodash';

import type { Chain } from '../config/schema';
import { logger } from '../logger';
import { getState } from '../state';
import { isFulfilled, sleep } from '../utils';

import { getDapiDataRegistry, type ReadDapisResponse } from './dapi-data-registry';

export const startUpdateFeedLoops = async () => {
  const state = getState();
  const {
    config: { chains },
  } = state;

  // Start update loops for each chain in parallel.
  await Promise.all(
    Object.entries(chains).map(async ([chainId, chain]) => {
      const { dataFeedUpdateInterval, providers } = chain;

      // Calculate the stagger time for each provider on the same chain to maximize transaction throughput and update
      // frequency.
      const staggerTime = (dataFeedUpdateInterval / size(providers)) * 1000;
      logger.debug(`Starting update loops for chain`, { chainId, staggerTime, providerNames: Object.keys(providers) });

      for (const providerName of Object.keys(providers)) {
        logger.debug(`Starting update feed loop`, { chainId, providerName });
        setInterval(async () => runUpdateFeed(providerName, chain, chainId), dataFeedUpdateInterval * 1000);

        await sleep(staggerTime);
      }
    })
  );
};

export const runUpdateFeed = async (providerName: string, chain: Chain, chainId: string) => {
  const { dataFeedBatchSize, dataFeedUpdateInterval, providers, contracts } = chain;
  // TODO: Consider adding a start timestamp (as ID) to the logs to identify batches from this runUpdateFeed tick.
  const baseLogContext = { chainId, providerName };

  // Create a provider and connect it to the DapiDataRegistry contract.
  const provider = new ethers.providers.StaticJsonRpcProvider(providers[providerName]);
  const dapiDataRegistry = getDapiDataRegistry(contracts.DapiDataRegistry, provider);

  logger.debug(`Fetching first batch of dAPIs batches`, baseLogContext);
  const firstBatchStartTime = Date.now();
  const goFirstBatch = await go(async () => {
    // TODO: Use multicall to fetch this is a single RPC call.
    return {
      batch: await dapiDataRegistry.readDapis(0, dataFeedBatchSize),
      // eslint-disable-next-line unicorn/no-await-expression-member
      totalDapisCount: (await dapiDataRegistry.dapisCount()).toNumber(),
    };
  });
  if (!goFirstBatch.success) {
    logger.error(`Failed to get first active dAPIs batch`, goFirstBatch.error, baseLogContext);
    return;
  }
  const { batch: firstBatch, totalDapisCount: totalCount } = goFirstBatch.data;
  const processFirstBatchPromise = processBatch(firstBatch);

  // Calculate the stagger time between the rest of the batches.
  const batchesCount = totalCount / dataFeedBatchSize;
  const staggerTime = batchesCount <= 1 ? 0 : (dataFeedUpdateInterval / batchesCount) * 1000;

  // Wait the remaining stagger time required after fetching the first batch.
  const firstBatchDuration = Date.now() - firstBatchStartTime;
  await sleep(Math.max(0, staggerTime - firstBatchDuration));

  // Fetch the rest of the batches in parallel in a staggered way.
  logger.debug('Fetching batches of active dAPIs', { batchesCount, staggerTime, ...baseLogContext });
  const otherBatches = await Promise.allSettled(
    range(1, batchesCount).map(async (batchIndex) => {
      await sleep((batchIndex - 1) * staggerTime);

      logger.debug(`Fetching batch of active dAPIs`, { batchIndex, ...baseLogContext });
      return dapiDataRegistry.readDapis(batchIndex * dataFeedBatchSize, dataFeedBatchSize);
    })
  );
  for (const batch of otherBatches.filter((batch) => !isFulfilled(batch))) {
    logger.error(`Failed to get active dAPIs batch`, (batch as PromiseRejectedResult).reason, baseLogContext);
  }
  const processOtherBatchesPromises = otherBatches
    .filter((result) => isFulfilled(result))
    .map(async (result) => processBatch((result as PromiseFulfilledResult<ReadDapisResponse>).value));

  // Wait for all the batches to be processed.
  //
  // TODO: Consider returning some information (success/error) and log some statistics (e.g. how many dAPIs were
  // updated, etc...).
  await Promise.all([processFirstBatchPromise, ...processOtherBatchesPromises]);
};

export const processBatch = async (_batch: ReadDapisResponse) => {
  // TODO: Implement.
};
