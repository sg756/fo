import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppTheme, ThemeName, darkTheme, lightTheme } from './themes';

type ThemeContextValue = {
  theme: AppTheme;
  themeName: ThemeName;
  setThemeName: (name: ThemeName) => void;
  toggleTheme: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);
const STORAGE_KEY = 'floworder.theme';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [themeName, setThemeNameState] = useState<ThemeName>('light');

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((value) => {
      if (value === 'light' || value === 'dark') {
        setThemeNameState(value);
        return;
      }
      void AsyncStorage.setItem(STORAGE_KEY, 'light');
    });
  }, []);

  const setThemeName = (name: ThemeName) => {
    setThemeNameState(name);
    void AsyncStorage.setItem(STORAGE_KEY, name);
  };

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme: themeName === 'dark' ? darkTheme : lightTheme,
      themeName,
      setThemeName,
      toggleTheme: () => setThemeName(themeName === 'dark' ? 'light' : 'dark'),
    }),
    [themeName],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
