import ChatPageV2 from "@/components/v2/ChatPageV2";
import { signGuestToken, GUEST_CONTEXT } from "@/lib/v2/guest";

interface PageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

/**
 * /v2/guest — v2 for visitors of the marketing site (embedded in an iframe, no account).
 * A short-lived guest token is signed on every load. A guest gets one AI message and one
 * 20-second recording; saving = free signup (same onboard_quote webhook as the old /chat).
 * The iframe needs allow="microphone" for the recording to work.
 */
export const dynamic = "force-dynamic";

export default async function GuestRoute({ searchParams }: PageProps) {
  const params = await searchParams;
  const str = (k: string) => (typeof params[k] === "string" ? (params[k] as string).slice(0, 100) : undefined);
  return (
    <ChatPageV2
      aiContext={GUEST_CONTEXT}
      token={signGuestToken()}
      bubbleEnv="live"
      guest={{ utmSource: str("utm_source"), utmMedium: str("utm_medium") }}
    />
  );
}
