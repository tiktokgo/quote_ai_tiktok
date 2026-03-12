import { verifyToken } from "@/lib/verifyToken";
import ChatPage from "@/components/ChatPage";

interface PageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function ChatRoute({ searchParams }: PageProps) {
  const params = await searchParams;
  const token  = typeof params.token   === "string" ? params.token   : "";
  const userId = typeof params.user_id === "string" ? params.user_id : undefined;

  const result = verifyToken(token);

  if (!result.valid || !result.payload) {
    return <ChatPage isGuest={true} />;
  }

  // Token has email → pre-registered guest (skip popup)
  if (result.payload.email) {
    return <ChatPage
      isGuest={true}
      preGuestInfo={{
        company_name: result.payload.company_name,
        email:        result.payload.email,
        phone:        result.payload.phone   ?? "",
        address:      result.payload.address ?? "",
      }}
    />;
  }

  // user_id from JWT takes priority; fall back to URL param for old tokens
  return <ChatPage aiContext={{ ...result.payload, user_id: result.payload.user_id ?? userId }} token={token} />;
}
