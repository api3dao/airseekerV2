import { ethers } from 'ethers';

export const HTTP_SIGNED_DATA_API_TIMEOUT_MULTIPLIER = 0.9;

export const RPC_PROVIDER_TIMEOUT_MS = 120_000;

export const HUNDRED_PERCENT = 1e8;

export const AIRSEEKER_PROTOCOL_ID = '5'; // From: https://github.com/api3dao/airnode/blob/ef16c54f33d455a1794e7886242567fc47ee14ef/packages/airnode-protocol/src/index.ts#L46

// Solidity type(int224).min
export const INT224_MIN = BigInt(2).pow(BigInt(223)).mul(BigInt(-1));

// Solidity type(int224).max
export const INT224_MAX = BigInt(2).pow(BigInt(223)).sub(BigInt(1));
