import { z } from 'zod';
import { ethers } from 'ethers';
import { references } from '@api3/airnode-protocol-v1';

export const evmAddressSchema = z.string().regex(/^0x[\dA-Fa-f]{40}$/, 'Must be a valid EVM address');

export const evmIdSchema = z.string().regex(/^0x[\dA-Fa-f]{64}$/, 'Must be a valid EVM hash');

export type EvmAddress = z.infer<typeof evmAddressSchema>;
export type EvmId = z.infer<typeof evmIdSchema>;

export const providerSchema = z
  .object({
    url: z.string().url(),
  })
  .strict();

export type Provider = z.infer<typeof providerSchema>;

// Contracts are optional. If unspecified, they will be loaded from "airnode-protocol-v1" or error out during
// validation. We need a chain ID from parent schema to load the contracts.
export const optionalContractsSchema = z
  .object({
    Api3ServerV1: evmAddressSchema.optional(),
  })
  .strict();

// The contracts are guaraneteed to exist after the configuration is passed, but the inferred type would be optional so
// we create a new schema just to infer the type correctly.
const contractsSchema = optionalContractsSchema.required();

export type Contracts = z.infer<typeof contractsSchema>;

export const temporaryBeaconDataSchema = z.object({
  airnode: evmAddressSchema,
  templateId: evmIdSchema,
});

export type TemporaryBeaconData = z.infer<typeof temporaryBeaconDataSchema>;

// The DapiDataRegistry should live on-chain and Airseeker will query the contract for information. However, the
// contract does not exist as of now, so the data is hardcoded.
export const temporaryDapiDataRegistrySchema = z.object({
  airnodeToSignedApiUrl: z.record(z.string()),
  dataFeedIdToBeacons: z.record(z.array(temporaryBeaconDataSchema)),
  activeDapiNames: z.array(z.string()),
});

export type TemporaryDapiDataRegistry = z.infer<typeof temporaryDapiDataRegistrySchema>;

// Contracts are optional. If unspecified, they will be loaded from "airnode-protocol-v1" or error out during
// validation. We need a chain ID from parent schema to load the contracts.
export const optionalChainSchema = z
  .object({
    providers: z.record(providerSchema), // The record key is the provider "nickname"
    __Temporary__DapiDataRegistry: temporaryDapiDataRegistrySchema,
    contracts: optionalContractsSchema.optional(),
  })
  .strict();

// The contracts are guaraneteed to exist after the configuration is passed, but the inferred type would be optional so
// we create a new schema just to infer the type correctly.
const chainSchema = optionalChainSchema
  .extend({
    contracts: contractsSchema,
  })
  .strict();

export type Chain = z.infer<typeof chainSchema>;

// Ensure that the contracts are loaded from "airnode-protocol-v1" if not specified.
export const chainsSchema = z.record(optionalChainSchema).transform((chains, ctx) => {
  return Object.fromEntries(
    Object.entries(chains).map(([chainId, chain]) => {
      const { contracts } = chain;
      const parsedContracts = contractsSchema.safeParse({
        Api3ServerV1: contracts?.Api3ServerV1 ?? references.Api3ServerV1[chainId],
      });
      if (!parsedContracts.success) {
        ctx.addIssue({
          code: 'custom',
          message: 'Invalid contract addresses',
          path: ['chains', chainId, 'contracts'],
        });

        return z.NEVER;
      }

      return [
        chainId,
        {
          ...chain,
          contracts: parsedContracts.data,
        },
      ];
    })
  );
});

export const configSchema = z
  .object({
    sponsorWalletMnemonic: z.string().refine((mnemonic) => ethers.utils.isValidMnemonic(mnemonic), 'Invalid mnemonic'),
    chains: chainsSchema,
    fetchInterval: z.number().positive().optional().default(10),
    deviationThresholdCoefficient: z.number(),
  })
  .strict();

export type Config = z.infer<typeof configSchema>;
