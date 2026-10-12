import { AccountPage } from "@/components/analytics/views/account";
import { parseFrom } from "@/lib/analytics/links";

/** /analytics/accounts/<margin account or wallet address>?from=overview|top|liquidations|alerts|positions|whatif */
export default async function Page({ params, searchParams }: { params: Promise<{ address: string }>; searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const { address } = await params;
  const { from } = await searchParams;
  return <AccountPage address={address} from={parseFrom(from)} />;
}
