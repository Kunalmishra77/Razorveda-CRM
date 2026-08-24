'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api, type Session } from '../lib/api';
import { s } from '../lib/ui';

/**
 * The root cannot know your role without asking, so it asks. Admins land in the
 * Upload Centre, reps in their worklist, and anyone signed out at the login page.
 */
export default function Home() {
  const router = useRouter();
  useEffect(() => {
    api
      .get<{ session: Session }>('/auth/me')
      .then((r) => router.replace(r.session.role === 'EMPLOYEE' ? '/worklist' : '/today'))
      .catch(() => router.replace('/login'));
  }, [router]);
  return <main style={s.page}><p style={s.empty}>Taking you to your work…</p></main>;
}
