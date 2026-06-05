export interface TurnstileEnv {
  TURNSTILE_SECRET_KEY?: string;
}

export async function verifyTurnstile(
  token: string | null | undefined,
  secretKey: string | undefined,
  remoteIp?: string
): Promise<{ success: boolean; error?: string }> {
  if (!token) {
    return { success: false, error: 'Missing Turnstile token' };
  }
  if (!secretKey) {
    console.error('TURNSTILE_SECRET_KEY is not set');
    return { success: false, error: 'Internal configuration error' };
  }

  const formData = new FormData();
  formData.append('secret', secretKey);
  formData.append('response', token);
  if (remoteIp) {
    formData.append('remoteip', remoteIp);
  }

  const url = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
  const result = await fetch(url, {
    body: formData,
    method: 'POST',
  });

  const outcome = (await result.json()) as {
    success: boolean;
    'error-codes'?: string[];
  };

  if (!outcome.success) {
    return {
      success: false,
      error: outcome['error-codes']?.join(', ') ?? 'Turnstile verification failed',
    };
  }

  return { success: true };
}
