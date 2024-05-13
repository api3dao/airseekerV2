import { randomBytes } from 'node:crypto';

import { type Address, deriveWalletPathFromSponsorAddress, type Hex } from '@api3/commons';
import { type ErrorCode, ethers, type EthersError } from 'ethers';

import type { WalletDerivationScheme } from './config/schema';
import { AIRSEEKER_PROTOCOL_ID, INT224_MAX, INT224_MIN } from './constants';

export const abs = (n: bigint) => (n < 0n ? -n : n);

export const sleep = async (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const encodeDapiName = (decodedDapiName: string) => ethers.encodeBytes32String(decodedDapiName) as Hex;

export const decodeDapiName = (encodedDapiName: string) => ethers.decodeBytes32String(encodedDapiName);

export const deriveSponsorAddressHashForManagedFeed = (dapiNameOrDataFeedId: string) => {
  // Hashing the dAPI name is important because we need to take the first 20 bytes of the hash which could result in
  // collisions for (encoded) dAPI names with the same prefix.
  return ethers.keccak256(dapiNameOrDataFeedId) as Hex;
};

export const deriveSponsorAddressHashForSelfFundedFeed = (dapiNameOrDataFeedId: string, updateParameters: string) => {
  return ethers.keccak256(ethers.solidityPacked(['bytes32', 'bytes'], [dapiNameOrDataFeedId, updateParameters])) as Hex;
};

export const deriveSponsorWalletFromSponsorAddressHash = (sponsorWalletMnemonic: string, sponsorAddressHash: Hex) => {
  // Take the first 20 bytes of the sponsor address hash + "0x" prefix.
  const sponsorAddress = ethers.getAddress(sponsorAddressHash.slice(0, 42)) as Address;
  // NOTE: Be sure not to use "ethers.Wallet.fromPhrase(sponsorWalletMnemonic).derivePath" because that produces a
  // different result.
  const sponsorWallet = ethers.HDNodeWallet.fromPhrase(
    sponsorWalletMnemonic,
    undefined,
    `m/44'/60'/0'/${deriveWalletPathFromSponsorAddress(sponsorAddress, AIRSEEKER_PROTOCOL_ID)}`
  );

  return sponsorWallet;
};

export const deriveSponsorWallet = (
  sponsorWalletMnemonic: string,
  dapiNameOrDataFeedId: string,
  updateParameters: string,
  walletDerivationScheme: WalletDerivationScheme
) => {
  // Derive the sponsor address hash, whose first 20 bytes are interpreted as the sponsor address. This address is used
  // to derive the sponsor wallet.
  //
  // For self-funded feeds it's more suitable to derive the hash also from update parameters. This does not apply to
  // mananaged feeds which want to be funded by the same wallet independently of the update parameters.
  const sponsorAddressHash =
    walletDerivationScheme.type === 'self-funded'
      ? deriveSponsorAddressHashForSelfFundedFeed(dapiNameOrDataFeedId, updateParameters)
      : deriveSponsorAddressHashForManagedFeed(dapiNameOrDataFeedId);

  return deriveSponsorWalletFromSponsorAddressHash(sponsorWalletMnemonic, sponsorAddressHash);
};

export const multiplyBigNumber = (bigNumber: bigint, multiplier: number) =>
  (bigNumber * BigInt(Math.round(multiplier * 100))) / 100n;

// https://github.com/api3dao/airnode-protocol-v1/blob/fa95f043ce4b50e843e407b96f7ae3edcf899c32/contracts/api3-server-v1/DataFeedServer.sol#L132
export const decodeBeaconValue = (encodedBeaconValue: string) => {
  const decodedBeaconValue = BigInt(ethers.AbiCoder.defaultAbiCoder().decode(['int256'], encodedBeaconValue)[0]);
  if (decodedBeaconValue > INT224_MAX || decodedBeaconValue < INT224_MIN) {
    return null;
  }

  return decodedBeaconValue;
};

// eslint-disable-next-line functional/no-classes
class SanitizedErrorsError extends Error {
  public code: ErrorCode;

  public constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

// Ethers error messages are sometimes serialized into huge strings containing the raw transaction bytes that is
// unnecessary. The serialized string is so big, that Grafana log forwarder needs to split the message into multiple
// parts (messing up with our log format). As a workaround, we pick the most useful properties from the error message.
export const sanitizeEthersError = (error: Error) => {
  const ethersError = error as EthersError;

  // We only care about ethers errors and they all should have a code.
  if (!ethersError.code) return error;

  // We don't care about the stack trace, nor error name - just the code and the message. According to the ethers
  // sources, the short message should always be defined.
  const sanitizedError = new SanitizedErrorsError(ethersError.code, ethersError.shortMessage);
  // NOTE: We don't need the stack trace, because the errors are usually easy to find by the developer message and the
  // stack can be traced manually. This reduces the risk of the stack trace being too large and "exploding" the log
  // size.
  delete sanitizedError.stack;
  return sanitizedError;
};

export const generateRandomId = () => randomBytes(32).toString('hex');
