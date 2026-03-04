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
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "#07071a" }}>
        <div className="text-center p-8 max-w-md" dir="rtl">
          <div className="text-6xl mb-4">⚠️</div>
          <h1 className="text-2xl font-bold mb-2" style={{ color: "#f87171" }}>גישה נדחית</h1>
          <p className="mb-2" style={{ color: "#fca5a5" }}>{"reason" in result ? result.reason : "טוקן לא תקין"}</p>
          <p className="text-sm mt-4" style={{ color: "rgba(226,232,240,0.5)" }}>
            יש לפתוח דף זה מתוך אפליקציית Bubble.
          </p>
        </div>
      </div>
    );
  }

  return <ChatPage aiContext={{ ...result.payload, user_id: userId }} />;
}
