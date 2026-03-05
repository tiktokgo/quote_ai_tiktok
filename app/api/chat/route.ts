import { NextRequest } from "next/server";
import OpenAI from "openai";
import { buildSystemPrompt } from "@/lib/systemPrompt";
import { verifyToken } from "@/lib/verifyToken";
import type { AIContext } from "@/lib/verifyToken";
import type { Quote, PartialQuote } from "@/lib/quoteSchema";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/** Return the next question to ask based on which required fields are still missing. */
function nextMissingField(current: Partial<Quote> | undefined, fresh: PartialQuote): string {
  const name    = fresh.client?.name    ?? current?.client?.name;
  const address = fresh.client?.address ?? current?.client?.address;
  const total   = fresh.total           ?? current?.total;
  if (!name)    return "מה שם הלקוח עבור עבודה זו?";
  if (!address) return "ומה הכתובת?";
  if (!total)   return "מה הסכום הכולל שתרצה לגבות עבור עבודה זו?";
  return "הצעת המחיר מוכנה — עיין בה ויידע אותי אם תרצה לשנות משהו.";
}

/** Keep at most the first `max` sentences from a block of text. */
const firstSentences = (text: string, max: number): string => {
  const trimmed = text.trim();
  const re = /[^.!?]*[.!?]+(\s+|$)/g;
  const sentences: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(trimmed)) !== null && sentences.length < max) {
    sentences.push(m[0].trimEnd());
  }
  return sentences.length > 0 ? sentences.join(" ").trim() : trimmed.slice(0, 200).trim();
};

const UPDATE_QUOTE_TOOL: OpenAI.Chat.ChatCompletionTool = {
  type: "function",
  function: {
    name: "update_quote",
    description:
      "Update the current quote with new or changed fields. ONLY call this when the user provides new information that changes the quote.",
    parameters: {
      type: "object",
      properties: {
        title:    { type: "string", description: "Quote title, e.g. 'הצעת מחיר — אינסטלציה — רחוב הרצל 5'" },
        date:     { type: "string", description: "ISO date string" },
        scope:    { type: "string", description: "Overall scope of work" },
        industry: { type: "string", description: "Industry / trade type" },
        client: {
          type: "object",
          properties: {
            name:    { type: "string" },
            address: { type: "string" },
            phone:   { type: "string" },
            email:   { type: "string" },
          },
        },
        items: {
          type: "array",
          items: {
            type: "object",
            required: ["name", "description"],
            properties: {
              name:        { type: "string", description: "Short item label in Hebrew" },
              description: { type: "string", description: "Longer detail in Hebrew" },
            },
          },
        },
        total:      { type: "number", description: "Total price in ILS (₪)" },
        has_tax:    { type: "boolean", description: "Whether 18% VAT is included" },
        tax_amount: { type: "number", description: "VAT amount in ILS (total * 0.18)" },
        warranty:   { type: "string" },
        terms:      { type: "string" },
        comments:   { type: "string" },
        status:     { type: "string", enum: ["draft", "complete"] },
      },
    },
  },
};

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}


export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      messages: ChatMessage[];
      aiContext: AIContext & { quote_id?: string };
      currentQuote?: Partial<Quote>;
      token?: string;
    };

    const { messages, aiContext: clientContext, currentQuote, token } = body;

    let aiContext: AIContext = clientContext;
    if (token) {
      const result = verifyToken(token);
      if (!result.valid) {
        return new Response(JSON.stringify({ error: "Invalid token" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      aiContext = result.payload;
    }

    if (!messages || !aiContext) {
      return new Response(JSON.stringify({ error: "Missing messages or aiContext" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const systemMessage: OpenAI.Chat.ChatCompletionMessageParam = {
      role: "system",
      content: buildSystemPrompt(aiContext),
    };

    const contextMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (currentQuote && Object.keys(currentQuote).length > 0) {
      contextMessages.push({
        role: "system",
        content: `מצב הצעת המחיר הנוכחית (מזג עדכונים לתוך זה):\n${JSON.stringify(currentQuote, null, 2)}`,
      });
    }

    const openaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      systemMessage,
      ...contextMessages,
      ...messages.map((m) => ({ role: m.role, content: m.content } as OpenAI.Chat.ChatCompletionMessageParam)),
    ];

    const stream = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: openaiMessages,
      tools: [UPDATE_QUOTE_TOOL],
      tool_choice: "auto",
      stream: true,
    });

    const encoder = new TextEncoder();

    const readable = new ReadableStream({
      async start(controller) {
        function send(data: object) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        }

        let textBuffer = "";
        let toolCallBuffer = "";
        let toolCallName = "";

        try {
          for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta;
            if (!delta) continue;

            if (delta.content) {
              textBuffer += delta.content;
            }

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (tc.function?.name) toolCallName = tc.function.name;
                if (tc.function?.arguments) toolCallBuffer += tc.function.arguments;
              }
            }

            const finishReason = chunk.choices[0]?.finish_reason;

            if (finishReason === "tool_calls" && toolCallName === "update_quote" && toolCallBuffer) {
              const brief = firstSentences(textBuffer, 2);
              if (brief) send({ type: "text", content: brief });

              try {
                const args = JSON.parse(toolCallBuffer) as PartialQuote;
                console.log(`[update_quote] items:${args.items?.length ?? 0} total:${args.total} title:${args.title}`);
                if (args.items) args.items.forEach((it, i) => console.log(`  item[${i}]: ${it.name}`));
                send({ type: "quote_update", quote: args });

                if (!brief) {
                  send({ type: "text", content: nextMissingField(currentQuote, args) });
                }

              } catch (e) {
                console.warn("Malformed tool args from GPT:", toolCallBuffer.slice(0, 200), e);
              }
              toolCallBuffer = "";
              toolCallName = "";
            } else if (finishReason === "stop") {
              const looksLikeFalseUpdate =
                /(עדכנתי|הוספתי|שמרתי|נרשם|הצעה עכשיו|הצעה כוללת|כוללת את הפריטים|הפריטים הבאים|הכנתי טיוטת|יצרתי הצעת)/i.test(textBuffer ?? "");

              if (looksLikeFalseUpdate) {
                try {
                  const forceResult = await openai.chat.completions.create({
                    model: "gpt-4o-mini",
                    messages: [
                      ...openaiMessages,
                      { role: "assistant", content: textBuffer },
                    ],
                    tools: [UPDATE_QUOTE_TOOL],
                    tool_choice: { type: "function", function: { name: "update_quote" } } as const,
                    stream: false,
                  });
                  const toolCall = forceResult.choices[0]?.message?.tool_calls?.[0] as
                    { function?: { arguments?: string } } | undefined;
                  if (toolCall?.function?.arguments) {
                    const args = JSON.parse(toolCall.function.arguments) as PartialQuote;
                    const hasNewData = args.client?.name || args.client?.address || args.total || args.comments;
                    if (hasNewData) {
                      console.log(`[force_extract] name:${args.client?.name} addr:${args.client?.address} total:${args.total}`);
                      if (textBuffer) send({ type: "text", content: firstSentences(textBuffer, 2) });
                      send({ type: "quote_update", quote: args });
                      textBuffer = "";
                    }
                  }
                } catch (e) {
                  console.warn("Force extraction failed:", e);
                }
              }

              if (textBuffer) send({ type: "text", content: textBuffer });
            }
          }

          send({ type: "done" });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          send({ type: "error", message: msg });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Chat API error:", message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
