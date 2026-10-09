import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  fetchVault,
  getVaultState,
  vaultProgram,
} from "@vanna/phoenix-vault-client";
import { getConnection, forkUnixTimestamp } from "./connection";
import { readPhoenixExchange } from "./phoenix";
import { assetConfigPda, integrationPda, protocolConfigPda } from "./pdas";
import { getProgram } from "./program";
import {
  BASIS_PROGRAM,
  PERENA_PROGRAM,
  type VaultDefinition,
} from "./vault-catalogue";
import { VIEW_PAYER } from "./vault-oracles";

export interface LiveVault {
  id: string;
  registered: boolean;
  available: boolean;
  error: string | null;
  navUsd: number | null;
  sharePriceUsd: number | null;
  updatedAt: number | null;
  stale: boolean;
  capUsd: number | null;
  maxDepositUsd: number | null;
  depositsOpen: boolean;
  paused: boolean;
  assetUnits: number | null;
  shortUsd: number | null;
  netDeltaPct: number | null;
  phoenixEquityUsd: number | null;
  exitFeeBps: number;
  apy7: number | null;
  apy30: number | null;
}
export async function readLiveVault(def: VaultDefinition): Promise<LiveVault> {
  const c = getConnection();
  const base: LiveVault = {
    id: def.id,
    registered: false,
    available: false,
    error: null,
    navUsd: null,
    sharePriceUsd: null,
    updatedAt: null,
    stale: false,
    capUsd: null,
    maxDepositUsd: null,
    depositsOpen: false,
    paused: false,
    assetUnits: null,
    shortUsd: null,
    netDeltaPct: null,
    phoenixEquityUsd: null,
    exitFeeBps: def.id === "perena-junior" ? 100 : 0,
    apy7: null,
    apy30: null,
  };
  try {
    const target = new PublicKey(
      def.kind === "basis" ? BASIS_PROGRAM : PERENA_PROGRAM,
    );
    const [asset, integration, protocol] = await c.getMultipleAccountsInfo([
      assetConfigPda(new PublicKey(def.mint)),
      integrationPda(target),
      protocolConfigPda(),
    ]);
    const registered = asset
      ? getProgram().coder.accounts.decode("assetConfig", asset.data)
      : null;
    const enabled = integration
      ? getProgram().coder.accounts.decode("integration", integration.data)
          .enabled
      : false;
    const allowed = protocol
      ? (getProgram().coder.accounts.decode("protocolConfig", protocol.data)
          .allowedTokens as number[])
      : [];
    base.registered = Boolean(
      registered?.collateralEnabled &&
      enabled &&
      allowed.includes(registered.assetIndex),
    );
    if (def.kind === "perena") {
      const [[source, mint], now] = await Promise.all([
        c.getMultipleAccountsInfo([
          new PublicKey(def.account),
          new PublicKey(def.mint),
        ]),
        forkUnixTimestamp(c),
      ]);
      if (
        !source ||
        !source.owner.equals(target) ||
        !mint ||
        !mint.owner.equals(TOKEN_PROGRAM_ID) ||
        source.data.length < def.priceAt! + 16 ||
        mint.data.length < 82
      )
        throw new Error("Perena vault state is unavailable");
      const price = source.data.readBigUInt64LE(def.priceAt!);
      const timestamp = source.data.readBigInt64LE(def.priceAt! + 8);
      base.sharePriceUsd = Number(price) / 1e6;
      base.navUsd =
        Number((mint.data.readBigUInt64LE(36) * price) / 1_000_000n) / 1e6;
      base.updatedAt = Number(timestamp);
      base.stale =
        (now > timestamp ? now - timestamp : timestamp - now) > 3600n;
      base.depositsOpen = !base.stale;
      base.available = true;
    } else {
      const [v, ex] = await Promise.all([
        fetchVault(vaultProgram(c), new PublicKey(def.assetMint!)),
        readPhoenixExchange(c),
      ]);
      const phoenix = {
        perpAssetMap: ex.perpAssetMap,
        withdrawQueue: ex.withdrawQueue,
        globalVault: ex.globalVault,
        globalTraderIndex: ex.traderIndex,
        activeTraderBuffer: ex.activeBuffer,
      };
      const state = await getVaultState(c, v, VIEW_PAYER, phoenix);
      base.navUsd = Number(state.nav) / 1e6;
      base.sharePriceUsd = Number(state.sharePrice) / 1e6;
      base.assetUnits = Number(state.assetUnits) / 10 ** v.assetDecimals;
      base.shortUsd = Number(state.shortNotional) / 1e6;
      base.phoenixEquityUsd = Number(state.phoenixEquity) / 1e6;
      base.netDeltaPct =
        state.shortNotional > 0n
          ? Number(
              ((state.assetValue - state.shortNotional) * 1_000_000n) /
                state.shortNotional,
            ) / 10_000
          : null;
      // Caps bind on total exposure. Never present a guessed USD cap for the SOL-denominated cap.
      base.capUsd =
        v.maxPositionUsd > 0n ? Number(v.maxPositionUsd) / 1e6 : null;
      base.maxDepositUsd =
        v.maxDepositUsd > 0n ? Number(v.maxDepositUsd) / 1e6 : null;
      base.depositsOpen = v.depositsOpen;
      base.paused = v.paused;
      base.available = true;
    }
  } catch (e) {
    base.error = e instanceof Error ? e.message : "Vault read failed";
  }
  return base;
}
