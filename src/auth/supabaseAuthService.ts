import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../types/database.generated';
import { resolveCurrentUser } from './resolveCurrentUser';
import type { AuthChangeListener, AuthService, ResolvedIdentity, SignInOutcome } from './types';

/**
 * Real Supabase Auth implementation. No page calls
 * `supabase.auth.signInWithPassword(...)` (or any other raw auth method)
 * directly — everything goes through this one typed boundary.
 */
export class SupabaseAuthService implements AuthService {
  constructor(private readonly client: SupabaseClient<Database>) {}

  async initialize(): Promise<{ identity: ResolvedIdentity; session: Awaited<ReturnType<SupabaseClient['auth']['getSession']>>['data']['session'] }> {
    const {
      data: { session },
    } = await this.client.auth.getSession();
    const identity = await resolveCurrentUser(this.client, session?.user ?? null);
    return { identity, session };
  }

  onChange(listener: AuthChangeListener): () => void {
    const {
      data: { subscription },
    } = this.client.auth.onAuthStateChange(async (event, session) => {
      const identity = await resolveCurrentUser(this.client, session?.user ?? null);
      listener(identity, session, event);
    });
    return () => subscription.unsubscribe();
  }

  async signIn(email: string, password: string): Promise<SignInOutcome> {
    const { data, error } = await this.client.auth.signInWithPassword({ email, password });

    if (error) {
      // Never reveal whether a particular email exists. Supabase's own
      // "Invalid login credentials" is already generic for both a wrong
      // password and a nonexistent email -- pass a similarly generic
      // message through rather than the raw error text either way.
      return { user: null, error: { message: 'Incorrect email or password.' }, accessDenied: null };
    }

    const identity = await resolveCurrentUser(this.client, data.session?.user ?? null);
    if (!identity.user) {
      // Fail closed: don't leave a dangling authenticated-but-denied
      // Supabase session around.
      await this.client.auth.signOut();
      return { user: null, error: null, accessDenied: identity.deniedReason };
    }

    return { user: identity.user, error: null, accessDenied: null };
  }

  async signOut(): Promise<void> {
    await this.client.auth.signOut();
  }

  async requestPasswordReset(email: string): Promise<{ error: { message: string } | null }> {
    const { error } = await this.client.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}${window.location.pathname}`,
    });
    // Supabase's own resetPasswordForEmail already never reveals whether
    // the email exists (it returns success either way). Only surface a
    // genuine transport/config failure, never account-existence detail.
    if (error && isTransportError(error)) {
      return { error: { message: 'Could not send the reset email. Please try again.' } };
    }
    return { error: null };
  }

  async updatePassword(newPassword: string): Promise<{ error: { message: string } | null }> {
    const { error } = await this.client.auth.updateUser({ password: newPassword });
    if (error) {
      return { error: { message: error.message } };
    }
    return { error: null };
  }
}

function isTransportError(error: { status?: number }): boolean {
  // A 4xx from resetPasswordForEmail (e.g. rate limiting or a malformed
  // email) is safe to surface generically; anything else (network/5xx) is
  // the "could not send" case.
  return !error.status || error.status >= 500;
}
