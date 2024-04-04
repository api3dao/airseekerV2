import { HUNDRED_PERCENT, UINT256_MAX } from '../constants';
import { logger } from '../logger';
import { abs } from '../utils';

export const calculateDeviationPercentage = (
  initialValue: bigint,
  updatedValue: bigint,
  deviationReference: bigint
) => {
  const absoluteDelta = abs(updatedValue - initialValue);
  if (absoluteDelta === 0n) return 0n;

  const absoluteInitialValue = abs(deviationReference - initialValue);
  if (!absoluteInitialValue) return UINT256_MAX;

  return (absoluteDelta * BigInt(HUNDRED_PERCENT)) / absoluteInitialValue;
};

export const calculateMedian = (arr: bigint[]) => {
  if (arr.length === 0) throw new Error('Cannot calculate median of empty array');
  const mid = Math.floor(arr.length / 2);

  const nums = [...arr].sort((a, b) => {
    if (a < b) return -1;
    else if (a > b) return 1;
    else return 0;
  });

  return arr.length % 2 === 0 ? (nums[mid - 1]! + nums[mid]!) / 2n : nums[mid]!;
};

export const isDeviationThresholdExceeded = (
  onChainValue: bigint,
  deviationThreshold: bigint,
  apiValue: bigint,
  deviationReference: bigint
) => {
  const updateInPercentage = calculateDeviationPercentage(onChainValue, apiValue, deviationReference);

  return updateInPercentage >= deviationThreshold;
};

/**
 * Returns true when the on-chain data is fresh enough not to be updated by the heartbeat.
 */
export const isOnChainDataFresh = (timestamp: bigint, heartbeatInterval: bigint) =>
  BigInt(timestamp) > BigInt(Math.floor(Date.now() / 1000)) - heartbeatInterval;

// Mirroring the logic of https://github.com/api3dao/airnode-protocol-v1/blob/65a77cdc23dc5434e143357a506327b9f0ccb7ef/contracts/api3-server-v1/extensions/BeaconSetUpdatesWithPsp.sol#L111
export const isDataFeedUpdatable = (
  onChainValue: bigint,
  onChainTimestamp: bigint,
  offChainValue: bigint,
  offChainTimestamp: bigint,
  heartbeatInterval: bigint,
  deviationThreshold: bigint,
  deviationReference: bigint
): boolean => {
  // Check that fulfillment data is newer than on chain data. Update transaction with stale data would revert on chain,
  // draining the sponsor wallet.
  if (offChainTimestamp <= onChainTimestamp) {
    // It's possible that no beacon is updatable, but we may still update the data feed due to heartbeat.
    if (offChainTimestamp < onChainTimestamp) {
      logger.warn(`Off-chain sample's timestamp is older than on-chain timestamp.`);
    }
    return false;
  }

  // At this point it's clear that the off-chain data is newer than the on-chain data and the on-chain data is
  // uninitialized.
  if (onChainTimestamp === 0n) return true;

  // Check that on-chain data is fresh enough to not be force-updated by the heartbeat.
  const isFreshEnough = isOnChainDataFresh(onChainTimestamp, heartbeatInterval);
  if (isFreshEnough) {
    // Contract requires deviation threshold to be non-zero when computing the standard deviation.
    if (deviationThreshold === 0n) {
      logger.info(`Deviation threshold is zero.`);
      return false;
    }

    if (isDeviationThresholdExceeded(onChainValue, deviationThreshold, offChainValue, deviationReference)) {
      logger.info(`Deviation exceeded.`);
      return true;
    }
  } else {
    // Contract requires heartbeat interval to be non-zero when checking for heartbeat update.
    if (heartbeatInterval === 0n) {
      logger.info(`Heartbeat interval is zero.`);
      return false;
    }

    logger.info(`On-chain timestamp is older than the heartbeat interval.`);
    return true;
  }

  return false;
};
