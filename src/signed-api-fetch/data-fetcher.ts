import { clearInterval } from 'node:timers';

import { go } from '@api3/promise-utils';
import axios from 'axios';
import { uniq } from 'lodash';

import { HTTP_SIGNED_DATA_API_ATTEMPT_TIMEOUT, HTTP_SIGNED_DATA_API_HEADROOM } from '../constants';
import { logger } from '../logger';
import * as localDataStore from '../signed-data-store';
import { purgeInactiveDataPoints } from '../signed-data-store';
import { getBeaconsForActiveDapis, getState, updateState } from '../state';
import { signedApiResponseSchema, type SignedData } from '../types';

// Express handler/endpoint path: https://github.com/api3dao/signed-api/blob/b6e0d0700dd9e7547b37eaa65e98b50120220105/packages/api/src/server.ts#L33
// Actual handler fn: https://github.com/api3dao/signed-api/blob/b6e0d0700dd9e7547b37eaa65e98b50120220105/packages/api/src/handlers.ts#L81

/**
 * Shuts down intervals
 */
export const stopDataFetcher = () => {
  clearInterval(getState().dataFetcherInterval);
};

/**
 * Calls a remote signed data URL and inserts the result into the datastore
 * @param url
 */
const callSignedDataApi = async (url: string): Promise<SignedData[]> => {
  const result = await go(
    async () =>
      axios({
        method: 'get',
        timeout: HTTP_SIGNED_DATA_API_ATTEMPT_TIMEOUT - HTTP_SIGNED_DATA_API_HEADROOM / 2,
        url,
        headers: {
          Accept: 'application/json',
        },
      }),
    {
      attemptTimeoutMs: HTTP_SIGNED_DATA_API_ATTEMPT_TIMEOUT,
      totalTimeoutMs: HTTP_SIGNED_DATA_API_ATTEMPT_TIMEOUT + HTTP_SIGNED_DATA_API_HEADROOM / 2,
      retries: 0,
    }
  );

  // TODO: Pass the response error body (if available). See OEV repo for details.
  if (!result.success) {
    throw new Error([`HTTP call failed: `, url, result.error].join('\n'));
  }

  const { data } = signedApiResponseSchema.parse(result.data.data);

  return Object.values(data);
};

export const runDataFetcher = async () => {
  // TODO: Consider adding "Coordinator ID"
  logger.debug('Running data fetcher');
  const state = getState();
  const {
    config: { signedDataFetchInterval },
    signedApiUrlStore,
    dataFetcherInterval,
  } = state;

  const signedDataFetchIntervalMs = signedDataFetchInterval * 1000;

  if (!dataFetcherInterval) {
    const dataFetcherInterval = setInterval(runDataFetcher, signedDataFetchIntervalMs);
    updateState((draft) => {
      draft.dataFetcherInterval = dataFetcherInterval;
    });
  }

  const urls = uniq(
    Object.values(signedApiUrlStore)
      .flatMap((urlsPerProvider) => Object.values(urlsPerProvider))
      .flatMap((urlsPerAirnode) => Object.values(urlsPerAirnode))
      .flat()
  );

  const activeBeacons = getBeaconsForActiveDapis();

  logger.debug('Fetching data from signed APIs', { urls });
  const fetcherPromise = await Promise.all(
    urls.map(async (url) => {
      const goSignedApiCall = await go(
        async () => {
          const payload = await callSignedDataApi(url);

          const beaconsForActiveDApis = payload.filter((signedData) =>
            activeBeacons.find(
              (beacon) => beacon.airnodeAddress === signedData.airnode && beacon.templateId === signedData.templateId
            )
          );

          for (const element of beaconsForActiveDApis) {
            localDataStore.setStoreDataPoint(element);
          }
        },
        // TODO: What to do about timeout and retries? This is the only place that does some handling.
        {
          retries: 0,
          totalTimeoutMs: signedDataFetchIntervalMs + HTTP_SIGNED_DATA_API_HEADROOM,
          attemptTimeoutMs: signedDataFetchIntervalMs + HTTP_SIGNED_DATA_API_HEADROOM - 100,
        }
      );

      if (!goSignedApiCall.success) {
        logger.warn(`Failed to fetch data from signed API`, { error: goSignedApiCall.error });
      }
    })
  );

  purgeInactiveDataPoints();

  return fetcherPromise;
};
