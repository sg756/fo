import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { AuthApi, MeUser } from '../api/endpoints';
import { loadToken, setToken } from '../api/client';

type AuthContextValue = {
  authed: boolean;
  booting: boolean;
  user: MeUser | null;
  login: (email: string, password: string) => Promise<MeUser>;
  register: (body: {
    account: string;
    password: string;
    confirmPassword: string;
    inviteCode?: string;
  }) => Promise<{
    status: string;
    message: string;
    inviteCode?: string;
  }>;
  logout: () => Promise<void>;
  refreshMe: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<MeUser | null>(null);
  const [authed, setAuthed] = useState(false);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const token = await loadToken();
        if (token) {
          const me = await AuthApi.me();
          setUser(me);
          setAuthed(true);
        }
      } catch {
        await setToken(null);
      } finally {
        setBooting(false);
      }
    })();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      authed,
      booting,
      user,
      login: async (email, password) => {
        const resp = await AuthApi.login({ email, password });
        await setToken(resp.accessToken);
        const me = await AuthApi.me();
        setUser(me);
        setAuthed(true);
        return me;
      },
      register: async (body) => {
        const resp = await AuthApi.register(body);
        return { status: resp.status, message: resp.message, inviteCode: resp.inviteCode };
      },
      logout: async () => {
        await setToken(null);
        setUser(null);
        setAuthed(false);
      },
      refreshMe: async () => {
        const me = await AuthApi.me();
        setUser(me);
      },
    }),
    [authed, booting, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
