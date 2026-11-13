'use server';

import { redirect } from 'next/navigation';
import { login } from '@/lib/auth';

export async function loginAction(
  _prev: { error?: string; email?: string } | undefined,
  form: FormData,
): Promise<{ error?: string; email?: string }> {
  const email = String(form.get('email') ?? '');
  const password = String(form.get('password') ?? '');
  const next = String(form.get('next') ?? '/');
  const res = await login(email, password);
  if (!res.ok) return { error: res.error, email };
  redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/');
}
