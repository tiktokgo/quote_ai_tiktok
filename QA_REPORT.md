# QA Report — quote_ai_tiktok
Generated: 2026-03-04

---

## Critical Bugs

### 1. Countdown overlay stuck at "מעביר בעוד 0 שניות" when no redirect happens
**File:** `components/ChatPage.tsx` lines 302–313
**Problem:** When `NEXT_PUBLIC_REDIRECT_BASE` is not set (or Bubble doesn't return `quote_id`), `doRedirect` does nothing. But `approveState` stays `"success"` forever — the overlay is stuck with "מעביר בעוד 0 שניות" and the user can never dismiss it.
**Fix:**
```tsx
if (secs <= 0) {
  clearInterval(interval);
  const redirected = doRedirect(id); // make doRedirect return bool
  if (!redirected) setApproveState("idle"); // fallback: close overlay
}
```
Or simpler: add a close button to the overlay when countdown hits 0.

### 2. Countdown `setInterval` never cleaned up on unmount
**File:** `components/ChatPage.tsx` lines 306–313
**Problem:** If the user navigates away or the component unmounts before the 6-second countdown finishes, the interval keeps running and tries to call `setCountdown` / `doRedirect` on an unmounted component.
**Fix:** Store the interval in a `useRef` and clear it in a cleanup effect, or use `clearInterval` in a `useEffect` return.

### 3. `doRedirect` missing from `handleApprove` dependency array
**File:** `components/ChatPage.tsx` line 322
**Problem:** `handleApprove` calls `doRedirect` inside its body but `doRedirect` is not in the deps array `[aiContext, isGuest, guestInfo, quote]`. ESLint `exhaustive-deps` will flag this. Practically safe because `doRedirect` has empty deps (`[]`) and never changes, but it's technically wrong.
**Fix:** Add `doRedirect` to `handleApprove`'s dependency array.

### 4. `sendMessage` missing `effectiveContext` in dependency array
**File:** `components/ChatPage.tsx` line 180
**Problem:** `sendMessage` uses `effectiveContext` (line 122) but the deps array is `[messages, aiContext]`. For guest users: after `setGuestInfo(...)`, `effectiveContext` changes but `sendMessage` only recreates when `messages` changes. This works in practice only because the greeting `useEffect` also calls `setMessages`, which changes `messages` — a fragile indirect dependency.
**Fix:** Add `guestInfo` (or `effectiveContext`) to `sendMessage`'s dependency array.

---

## High Priority Issues

### 5. Test/debug API routes exposed in production
**Files:** `app/api/test-bubble/route.ts`, `app/api/test-onboard/route.ts`
**Problem:** These routes are accessible in production. If they make real Bubble API calls, they could create test records in the live database or expose internal Bubble URLs.
**Fix:** Delete them or add `if (process.env.NODE_ENV !== 'development') return 404`.

### 6. `aiContext` fully trusted from client request body (no JWT verification in `/api/chat`)
**File:** `app/api/chat/route.ts` line 91
**Problem:** `aiContext` is sent from the browser and used directly to build the system prompt (company name, industry, etc.) with no server-side verification that it matches the JWT. Any user can craft a POST to `/api/chat` with arbitrary `company_name`, `industry`, `company_info`.
**Fix:** Pass `token` in the request body, verify it server-side, and use the server-verified `aiContext` to build the prompt instead of trusting the client payload.

### 7. `user_id` comes from URL query param with no validation
**File:** `app/chat/page.tsx` line 11
**Problem:** `user_id` is read from the URL and passed directly to Bubble via the approve webhook. Anyone can modify the URL to submit a quote under a different user's ID.
**Fix:** Embed `user_id` in the JWT payload (alongside company_name etc.) and extract it server-side. Don't accept it from the URL.

### 8. No rate limiting on `/api/chat`
**Problem:** Each chat message triggers an OpenAI GPT-4o call. There's no rate limiting, so a single user or bot could spam requests and run up significant API costs.
**Fix:** Add per-IP or per-user rate limiting (e.g., using `@vercel/kv` with a sliding window).

---

## Medium Priority Issues

### 9. `total=0` displays as "₪0" in the quote panel immediately
**File:** `components/ChatPage.tsx` line 953
**Problem:** The system prompt sets `total=0` on first draft. Since `quote.total !== undefined` (it's `0`), the total box renders showing "₪0" — which looks like a free quote.
**Fix:** Change the condition to `quote.total !== undefined && quote.total !== 0` to hide the total box until a real price is entered. Or show a placeholder like "מחיר יעודכן" when total is 0.

### 10. `looksLikeFalseUpdate` regex matches valid text, triggers extra API call
**File:** `app/api/chat/route.ts` line 178
**Problem:** The regex includes `"הכנתי טיוטת"` — which is also the correct response the system prompt asks the AI to write when it DOES call `update_quote`. If the AI writes this phrase without calling the tool (false update), the force extraction fires an extra `gpt-4o-mini` call. This is correct, but the extra call adds ~200ms latency on valid responses too if the regex is too broad.
**Observation:** Currently working as designed, but the regex `הכנתי טיוטת` should remain as it catches real false-update cases.

### 11. `nextMissingField` asks for total when `total=0`
**File:** `app/api/chat/route.ts` line 16
**Problem:** `if (!total)` is truthy when `total === 0`. So after a first draft with `total=0`, the server-side helper asks "מה הסכום הכולל?" — but this is actually correct since 0 means "not yet set." Just worth documenting so future devs don't change `!total` to `total === undefined`.

### 12. `handleUpdateTerms` clears warranty field
**File:** `components/ChatPage.tsx` line 267
**Problem:** When the user edits the terms field inline, the handler does `{ ...prev, terms: newTerms, warranty: "" }`. This discards the AI-generated warranty text permanently. If the user makes a small edit to terms, they lose the warranty.
**Fix:** Combine warranty+terms as a single `terms` field (the AI already sometimes puts warranty in `terms`) or keep both fields when editing.

### 13. `/api/review` route exists but review flow was removed
**File:** `app/api/review/route.ts`
**Problem:** Dead server code. The review form was replaced with the countdown redirect. The route isn't harmful but is dead weight.
**Fix:** Delete `app/api/review/route.ts`.

---

## Low Priority / Nice-to-have

### 14. Missing `autoComplete` on guest form email input
**File:** `components/ChatPage.tsx` line 355
**Fix:** Add `autoComplete="email"` to the email input.

### 15. Message chat bubble trailing space accumulation
**File:** `components/ChatPage.tsx` line 142
`assistantText += event.content + " "` — adds a space between SSE chunks. `.trim()` fixes the end but there can be multiple spaces between words at chunk boundaries. Minor cosmetic.

### 16. Company avatar shows first char of empty string if `companyName` is empty
**File:** `components/ChatPage.tsx` line 782
`{companyName.charAt(0)}` — if `companyName` is `""` (e.g., no context yet), this renders an empty circle. Low impact since it only shows when `hasQuote` is true.

### 17. No `<title>` or `<meta>` tags for the chat page
The chat page has no custom page title or description — browser tab shows default Next.js title.

---

## Security Review

| Risk | Status |
|---|---|
| JWT verification on page load | ✅ Correct (`verifyToken` in server component) |
| JWT secret in env var | ✅ |
| `aiContext` server-verified | ❌ Trusted from client body in `/api/chat` |
| `user_id` validated | ❌ Read from URL, not JWT |
| Bubble API key in env var | ✅ |
| File upload type validated server-side | ❓ Not reviewed (parse-pdf route not read) |
| Rate limiting | ❌ None |
| Token expiry | ✅ jwt.verify handles exp |
| Test routes in production | ❌ test-bubble, test-onboard exposed |
| XSS via message content | ✅ React escapes by default |
| Company logo URL injection | Low risk — from JWT (trusted) |

---

## Mobile UX Review

- ✅ Mobile detection via `window.innerWidth < 768` with resize listener
- ✅ `isMobileRef` used inside SSE handler to avoid stale closure — correct pattern
- ✅ Auto-switches to preview on `quote_update`
- ✅ "צפה בטיוטה" / "חזרה לשיחה" toggle button
- ⚠️ When `mobileView === "preview"`, the approve button is in the quote panel (which is visible). After clicking approve and the overlay appears, user can't dismiss it if no redirect happens (see bug #1).
- ⚠️ The mobile nav bar only appears when `hasQuote`. Before a quote is created, the chat header shows company name but it's empty for guest users until the first message.

---

## System Prompt Review

**Strengths:**
- Rule 1 clearly prohibits any quote content in chat text — good
- 5-item minimum on first draft is explicit
- `total=0` mandate prevents fake prices
- Step-by-step flow (draft → client info → total → comments) is well-structured
- VAT instructions clear
- PDF modes (improve vs. extract-only) well-separated

**Issues:**
- The greeting in `systemPrompt.ts` line 23 says: `"ספר לי על העבודה ואני אבנה הצעת מחיר מיד"` — but `ChatPage.tsx` line 98 also hardcodes a greeting message shown in the UI. If the AI sends a different opening greeting (because it follows the system prompt), the user will see two greetings. **This is a UX duplication.** Consider removing the hardcoded greeting from `ChatPage.tsx` and letting the first AI message be the greeting, or keep the UI greeting but tell the AI not to greet again.

- Rule: "לעולם אל תכתוב 'הוספתי', 'עדכנתי', 'שמרתי' בטקסט שלך" — but the regex in `app/api/chat/route.ts` line 178 catches "עדכנתי|הוספתי|שמרתי" to trigger force extraction. There's overlap between the prompt rule and the server-side recovery mechanism — this is good defense-in-depth.

---

## TypeScript / Build

- ✅ `npx tsc --noEmit` passes with 0 errors
- ✅ No unused state variables
- ⚠️ `doRedirect` not in `handleApprove` deps (ESLint would flag, TS won't)
- ⚠️ `effectiveContext` not in `sendMessage` deps (same)

---

## Suggested Fixes (Priority Order)

**P0 — Fix before launch:**

1. **Countdown fallback** — When `doRedirect` does nothing, reset overlay:
```tsx
if (secs <= 0) {
  clearInterval(interval);
  const base = process.env.NEXT_PUBLIC_REDIRECT_BASE ?? "";
  if (base && id) window.location.href = base + id;
  else setApproveState("idle"); // close overlay gracefully
}
```

2. **Cleanup interval on unmount:**
```tsx
const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
// in handleApprove:
intervalRef.current = setInterval(...);
// in useEffect cleanup:
useEffect(() => () => { if (intervalRef.current) clearInterval(intervalRef.current); }, []);
```

3. **Remove test routes** — Delete `app/api/test-bubble/route.ts` and `app/api/test-onboard/route.ts`.

**P1 — Fix soon:**

4. **Move `user_id` into JWT payload** — Stop trusting it from the URL.
5. **Verify `aiContext` server-side** — Re-verify the JWT in `/api/chat` instead of trusting the client body.
6. **Delete `/api/review/route.ts`** — Dead code.

**P2 — Nice to have:**

7. Add `autoComplete="email"` to guest form.
8. Hide total box when `total === 0`.
9. Fix `handleUpdateTerms` to not clear warranty.
