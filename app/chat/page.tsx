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

  return <ChatPage aiContext={{ ...result.payload, user_id: userId }} />;
}
