/** Deployed Surfpool vaults; share tokens all use six decimals. */
export const BASIS_PROGRAM = "GtuQoYxzytGKtLqQGkYrVbsaPHTZN5jboP25DrSmKvGr";
export const PERENA_PROGRAM = "save8RQVPMWNTzU18t3GBvBkN9hT7jsGjiCQ28FpD9H";
export interface VaultDefinition {
  id: string;
  kind: "basis" | "perena";
  name: string;
  symbol: string;
  asset: string;
  mint: string;
  account: string;
  assetMint?: string;
  lookupTable?: string;
  priceAt?: number;
  icon: string;
}
export const VAULTS: VaultDefinition[] = [
  {
    id: "basis-sol",
    kind: "basis",
    name: "SOL Basis",
    symbol: "vbSOL",
    asset: "SOL",
    mint: "zMv5AVEURXUVBNmTqvV7ecgXun4uRAq8m3JM13iW71B",
    account: "BLeEcGjJnbGQyDBeTgckreKnKD87xFDDBFTfQYEyZ1j7",
    assetMint: "So11111111111111111111111111111111111111112",
    lookupTable: "H3Ki7aLDD4Dt1gLkDbpFbgRcG8Pr3aDaRbRkxp83QztC",
    icon: "/coins/sol.svg",
  },
  {
    id: "basis-eth",
    kind: "basis",
    name: "ETH Basis",
    symbol: "vbETH",
    asset: "ETH",
    mint: "6Xin8G4Lq9RPxEDc1NnZ4JAkqwLstnosbnu3AeQavVuZ",
    account: "7PwzomohGgy1WQeDRaJQs31UQqhapJk67gCg4zoL7znv",
    assetMint: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
    lookupTable: "9ytyS5LxCUvG9AmiUpxywwfz12dzF9KsbMNhgRAaewmH",
    icon: "/coins/eth.svg",
  },
  {
    id: "basis-btc",
    kind: "basis",
    name: "BTC Basis",
    symbol: "vbBTC",
    asset: "BTC",
    mint: "7LgRZNY3XTLx95LL1YYz4q7cFLAwupwtEjYepBPvSJ1R",
    account: "6qFcw8qCq2oxh1iqpYAKLw3Z7tUMj6APP4tNuHyosveZ",
    assetMint: "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij",
    lookupTable: "5kt2jtrgzVV5uQ6orvypUu9CmbNzdYLdxUovQGbuVkuT",
    icon: "/coins/btc.svg",
  },
  {
    id: "basis-tsla",
    kind: "basis",
    name: "TSLA Basis",
    symbol: "vbTSLA",
    asset: "TSLA",
    mint: "AzYyMurfA6r5hhBT2R294Zx6pMdeZfCYJ48AkcEnc43T",
    account: "J23xTNSTgiWdVMgcDbQgJMRc5MWhQ4Q2TrcnbDwG8ejw",
    assetMint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
    lookupTable: "3ChTRD92PqR54CgkYvwwEKFBV5rP9bCbCojCUmJgVddA",
    icon: "/coins/tslax.svg",
  },
  {
    id: "basis-meta",
    kind: "basis",
    name: "META Basis",
    symbol: "vbMETA",
    asset: "META",
    mint: "3EfoqbFDf7FSgtifJsyFiG1QFFStf72tm2n8iqyBh5pa",
    account: "3P5p9a4pr6NqRtZpbpPMhC2Kgg5AFjCHishuxP6FW1pJ",
    assetMint: "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu",
    lookupTable: "52iq7JhMeUmEUWehUeKPXyK4nPgYRx98QpwVDBQBkvF3",
    icon: "/coins/meta.svg",
  },
  {
    id: "perena-usdstar",
    kind: "perena",
    name: "USD*",
    symbol: "USD*",
    asset: "USDC",
    mint: "star9agSpjiFe3M49B3RniVU4CMBBEK3Qnaqn3RGiFM",
    account: "ECJGrTZ6QYMEwiEAnL4oReWF126uc22e9Lojy9qyCjHT",
    priceAt: 1584,
    icon: "/coins/usdc.svg",
  },
  {
    id: "perena-junior",
    kind: "perena",
    name: "USD* Junior",
    symbol: "USD* Junior",
    asset: "USDC",
    mint: "3AJYCjrhKitmBd8tRUurPA5dGHCAQh6A8L9DkuSC37Rm",
    account: "FbsiAonbNrC3EKWMrZxx9iSc5Q7e7zSAkro4tD8dQQJS",
    priceAt: 256,
    icon: "/coins/usdc.svg",
  },
];
export const vaultByMint = (mint: string) =>
  VAULTS.find((v) => v.mint === mint);
