import { createAuthClient } from '@neon/auth';
import { SupabaseAuthAdapter } from '@neon/auth/vanilla/adapters';

const url = import.meta.env.VITE_NEON_AUTH_URL;
export const auth = url ? createAuthClient(url, { adapter: SupabaseAuthAdapter({ fetchOptions: { timeout: 12_000 } }) }) : undefined;

export async function accessToken() {
  const result = await auth?.getSession();
  if (!result?.data?.session?.access_token) throw new Error('Войдите в аккаунт снова.');
  return result.data.session.access_token;
}
