import { verifyToken } from "@/lib/verifyToken";
import ChatPageV2 from "@/components/v2/ChatPageV2";

interface PageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

/**
 * /v2?token=<JWT>&env=<test | Bubble "Website home URL">
 * Logged-in users only. env tells us which Bubble database to save into:
 * anything containing "test" (e.g. .../version-test) → version-test.
 */
export default async function V2Route({ searchParams }: PageProps) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : "";
  const env = typeof params.env === "string" ? params.env : "";
  const result = verifyToken(token);

  if (!result.valid || !result.payload.user_id) {
    return (
      <div dir="rtl" style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center", color: "#4b5563", fontSize: 15 }}>
        פתחו את העמוד מתוך תיקתוק כדי ליצור הצעת מחיר.
      </div>
    );
  }

  return (
    <ChatPageV2
      aiContext={result.payload}
      token={token}
      bubbleEnv={/test/i.test(env) ? "test" : "live"}
    />
  );
}
