'use client';

import { useState } from 'react';
// Phase 0 exit criterion 6: apps/web imports a Zod schema from packages/shared
// and typechecks. One definition, both sides — the form and the endpoint cannot
// disagree about what a valid login looks like.
import { loginSchema } from '@razorveda/shared';

export default function LoginStub() {
  const [errors, setErrors] = useState<string[]>([]);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget));
    const result = loginSchema.safeParse(data);
    setErrors(
      result.success
        ? ['Valid input. Authentication lands in Phase 1 week 3 — see tasks/phase-1-core.md.']
        : result.error.issues.map((i) => i.message),
    );
  }

  return (
    <main style={{ padding: '2rem', maxWidth: 360, color: '#181B24' }}>
      <h1 style={{ fontSize: '1.25rem' }}>Sign in</h1>
      <form onSubmit={onSubmit}>
        <label htmlFor="email">Email</label>
        <input id="email" name="email" defaultValue="" style={{ width: '100%', margin: '4px 0 12px' }} />
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" style={{ width: '100%', margin: '4px 0 12px' }} />
        <button type="submit">Sign in</button>
      </form>
      {errors.length > 0 && (
        // Errors say what happened and what to do next. Never "Something went
        // wrong" (docs/07 section 5).
        <ul style={{ color: '#B03A2C', paddingLeft: '1.1rem' }}>
          {errors.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
    </main>
  );
}
