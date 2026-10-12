/**
 * The Predict page's curated market list: World's Trending events (world.xyz, refreshed 2026-10-12). Only these
 * markets are read, priced and listed, so the catalog loads in a couple of seconds instead of scanning
 * every World market on mainnet. Set PREDICT_ALL_MARKETS=1 to list every live World market instead.
 *
 * Each entry is one event: `groupId` is World's on-chain Group account (null for an event the app
 * groups itself, e.g. a "who wins" family), `markets` are its World market accounts (one per outcome).
 * Order here is the order on the page.
 */
export interface FeaturedEvent {
  title: string;
  groupId: string | null;
  markets: string[];
}

export const FEATURED_EVENTS: FeaturedEvent[] = [
  {
    title: "Who will win the 2026 NFL championship?",
    groupId: "4iDWpSbNB6WbzrYaQ6BpDRMv4xuVYQ916K2kXEgHhGVW",
    markets: [
      "BsbbZfyWzdjSo5d4xFERuSjPwGBAqKLDHTdJ3wRWmNm7",
      "3jKbPpPig7Fu6EtfQ6U7UVe4Ho76i2bSa7q1cWGiqQpk",
      "Gzj9sc1BBWKpYJLJL7DQjxgLfMqwzgu46BUMh2uEXKan",
      "2FKQDZxbJiHL2bMHUWrUPJEUaVLYSRgwHYGxsJ1dk8PN",
      "42UQSF2w3p2YRM5kmy4gusFYtB31FrdorowzZni347Xd",
      "4DzD8UzMX6tJKb7GWn81afkJTPpLircF2ig33ogYXULo",
      "6rKNtbW819sJFE1Sb58EVXL7rwSGg7ossC5wv2QCG1mu",
      "BSxz1sFtdKGfEnu4xUDrdcG884cnb8cpgMeZiaSEY2re",
      "E2qvpSjW5PEVXEEQqqwQuHgbASZB76VBY8HXJ6GTHSo2",
      "5vi9eA3yLSMitKJyvYJ76Mi5Lu2R6wXpLKCdJz7YYe7j",
      "CYwQDAcC2azkaNHfZHWb4xGtc7zC53HsefJScifBiHCE",
      "7Sgu8ir4fxVCJuhQPmM321U6zuBGbDZ3JAru3Qb4BkfZ",
      "6iBrx8H1PSj42vbBtjwmh2QYJhbkqnThR64tuXdsv9P2",
      "CB3uK79KFC4ceMF1JhauumXBFuSwAP3c2mfangCu4Bbv",
      "6RRasjck5krHFbQ9AJAtX1rtsr3v3rrniSdY7gdrc4U1",
      "ALXj8pPqvweFG92wzrL2BciXpkzcBPupE5r196gF7P5u",
      "9u7tgpdgme3vqFnvBB6AmMgf6cdSitkzQgQueWgXhVeV",
      "7ydnHCsCxCEmHa52meidUDJBVYWyNTarBdcEGQRjto46",
      "8Pcor5ri47qF6bRzV9t8bV318C6gJSpzWkBTJGqK1gKS",
      "41x64MbcLt5ngZVPYPcEfjRdFLiKnvarNZChR63jeGKe",
      "CYFhR8g3GcdwtQyYDTq5V41rwFX1LyUfUEMdXUudkHpu",
      "6EH48L97dRiiMhYNNmdxEpFQgZ4yFK6wgtFvHfunjG9a",
      "GHMrQmG4AvK7wwku5CkarSQPBWd7hRr5ZG7Z8kVqBxaB",
      "FgwJL7rW6yYsTWKuipaHm9bMKMop9S7EPcDKkxaCiVZG",
      "DZdH51Ee9bVfJnrBBSRGR823kog4ync9zYxTRNR37rmC",
      "CF1QXD5gKD165GNFV9YzuQby8dxpwD2cRChVDegL7KCm",
      "Ggcu6yvRfB1QAL4qZYfDcb47sEm7482tqKjAyNqLJ2a2",
      "HtMUPripQQyHzic4kHX2f4tZUweMo63gPs5d6UDdAaRS",
      "3yXAmfAUgSWb3bhxbRrgaJ7dQKJoAU8BAgNTBRQkbfch",
      "GE5wbxeUHUis6qnyAPUPcQK2CNoFqs21Av6sp654RhXD",
      "2d7sZAL4d76CREWNKLmSBTbbiit9rwHSfiNxu6m8qDry",
      "DYvhjTeNjQYcMEpzqDwGV2QDXWHWBznFMbrvv6XFJdE8",
    ],
  },
  {
    title: "Who will win the 2026 MLB championship?",
    groupId: "ANHQMaucJ12EHccPqKTHsqTNTTvVUEkLXUUef7pky3A4",
    markets: [
      "4M561nZAwrtCDHKNRP5KRnE8nYKoGDrFn842SBRP7Knw",
      "J6oNZeRn8FttEW9Wkm5hmMkhfsYdr4TVnYbinhZUxaSD",
      "DFCMy8Lyy4Sy9TmWLLdj51JPvjNcRD3qoQANWVPSPCax",
      "G9deSicCujSVrKxT1X6UhebeBfmdTFBbwfEFCwi6hXJq",
      "8sy6vTuooD7WqqSUZVMimpmMP57ZuowAboNZAwishB6s",
      "7hoPwAL8zRDQyAtjJqugqrCrvFJn6muqkzaAsKuyBceg",
      "AazoGKr974K7BGUZJiQ62JkLPJpyLjRAeBPuR6chthrN",
      "ErZbPUxUw54LQB1woA6yLizqSturECMJEUZM4nFxW5nY",
      "4FSqx2svp5fDgRoUQMU6sEAjCxLCabxmMKZPDZZQSqSY",
      "7CeJcssf1zmWmh2MjukDX9LwGSzhwKKyVXk2w3i8RQXA",
      "A5AVfbmKSzN45gN9Di9tpdmhEkbk3vpoxssAxuSSa511",
      "CJhfNCPAjS6Q8zMXX94gMQkGM1WXu4Z6wd4en8jCecMw",
      "5Pv1sE8N8VvFqXqyampZ7c4HmaJTtWnLYm4JBibwsT3B",
      "8jNXGqgRgA7FNNTdeGktvEMLajcRhNZsda2XSkp7YeGt",
      "EP3tEeXJkN4ecnmdMCFACLA4wfAi37Dwk9VZF5P1QaB6",
      "8UT5BsGXmjiCeyBtvGmez4ctbdVjojj4eArD5vLUh9v5",
      "6aWUTRPqt7YerKPxcrR4gvU9ZSb2NtVv947XTwwW21T8",
      "GTXE9HMRc77pGVij54EHPRUWNU9RLhCk69u7bGgnzarp",
      "9qjTQ19HmokK4g6zKu9h5Ut5WB9mpKvCqAQzR9Qoy6m7",
      "D4qJwWseEbYRhWZHfM6FftW4qGHmbVZnpbteeB2rn2Sa",
      "GjdNBEtgvccQVTcB5KrYgdfWTNjYTyN3n8CDwfTsfuHn",
      "J5bTDeWyQojJx3tNwLLg9dUh22sUSYZkVSFbqFqk6Nuz",
      "7G1ZwQiPCxUDTzJJRBoc1vgy97HdqPeLyPixuH9ozjXR",
      "ZsRkix5QP5khtvTweNrXph4ZXfFaMvrMUMW6K27W6mE",
      "BnQWeUBP9LsVs5erkoXh6dGbXMg1Ed7dMmpZaERUbPX2",
      "CmFuKw78w1TtZ9rhPDJosmkTs1TUH5tYzWhUZGWjKZc9",
      "858H5PLL4rWMqhXJzdr4qrMY48tUHt2BbmbFd9RUvLuS",
      "H6KPJVTXUaimCe9tDE6Mh7medCqALz4CSXMKm8WAD9BZ",
      "H9czizCgsq4WeLfA78FXS9tcsYes2V7YtocASNGs7nJ7",
      "D2A7Ek2Dawg3gbFnpechqBd8aid9EESnm28F7cetTNHb",
    ],
  },
  {
    title: "Galatasaray vs Barcelona",
    groupId: "FzMSs3Df4PfyWyT1uwHZ1iKzZk7B3UnHt5EwLNtQrwxZ",
    markets: [
      "83Y67kStV2dj4MYLLxRPD8e6cS5QLSG1wKHvuFkrcQFi",
      "6tutZgRrk3GNkaTNpcxaoHdj2CBtVZTe9YqxnipzEBUT",
      "BBegRHAqyTuEU2szyHhXnwqsFPayVcUM6xs4okfjCBAj",
    ],
  },
  {
    title: "Atalanta vs Venezia",
    groupId: "6gZAspmbwE34XN6tmeZvpkdYVymwtKTbUU9HuuHRDoQS",
    markets: [
      "FVJzqhabn1ruSdEoiuFCzHeokuCWuWMH8kuVcSPugNmv",
      "DdmqGH6iYtsFPW7rW37YhYc5U7xSpL7rouSYYEPHGy6E",
      "HYFK9PhPoPyik392FpmSjVhfZWhFnA1x4rwcUqBeXczp",
    ],
  },
  {
    title: "Who will win control of the Senate in the 2026 midterms?",
    groupId: null,
    markets: [
      "33BE14xE3eNCej4aUDVUtfdpLEnTQzdqBoSEPiBkfWTP",
      "8eyqkqkTphDfx267LuULGJJP869hgSg6pm4Rkhe851ef",
    ],
  },
  {
    title: "LA Rams vs BUF Bills",
    groupId: "6bSVyoU85RCcbq8J8cPGVfWBwVQLDC5NPcUHzVFN4pso",
    markets: [
      "AkXzAKPnY5bByTY9Kdp5eiJ6VPkcMrZhssEXpaG9ao3r",
      "FZXGA4jqzumhRDG2axDkDk9Zuv6K9s36xePrsWqz7gRP",
    ],
  },
  {
    title: "Coventry City vs Newcastle United",
    groupId: "7yfPMHXonusYDwnW8ZZ66yKEJjMod4dt1YT3sUsCFQbz",
    markets: [
      "F6X4pkCWT3TefbrMuCXV3kMrRzE3uAeNzG4RhzGLK8kG",
      "5VW59QcW1JhQygRAScPhbz5K77YTiTRekSUi3ZH5FM3N",
      "ESLtBWPzv9UYDmB4GCo4p5nnZS3LUqt2HRaoz1NrXxEC",
    ],
  },
];

/** True unless PREDICT_ALL_MARKETS=1 (server env). */
export const featuredOnly = () => process.env.PREDICT_ALL_MARKETS !== "1";

export const FEATURED_MARKET_IDS: string[] = FEATURED_EVENTS.flatMap((e) => e.markets);
export const FEATURED_GROUP_IDS: string[] = FEATURED_EVENTS.flatMap((e) => (e.groupId ? [e.groupId] : []));

/** Page order of a market (its event's index), or Infinity when it is not featured. */
const ORDER = new Map(FEATURED_EVENTS.flatMap((e, i) => e.markets.map((m) => [m, i] as const)));
export const featuredRank = (marketId: string) => ORDER.get(marketId) ?? Infinity;
