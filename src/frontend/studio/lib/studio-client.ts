// SSE connection for the AI Studio chat endpoint (ALO-644's POST /api/studio/chat).
// credentials:'same-origin' sends the session cookie; same-origin keeps the CSRF
// Origin check happy. Used by AIStudio's useChat().
import { fetchServerSentEvents } from '@tanstack/ai-client';

export function studioChatConnection() {
  return fetchServerSentEvents('/api/studio/chat', () => ({ credentials: 'same-origin' as const }));
}
