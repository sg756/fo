import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import * as Updates from 'expo-updates';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider, useTheme } from './src/theme/ThemeContext';
import { AuthProvider } from './src/auth/AuthContext';
import { RootNavigator } from './src/navigation/RootNavigator';
import { AppDialogHost } from './src/components/AppDialog';

async function applyOtaUpdate() {
  if (__DEV__ || !Updates.isEnabled) return;
  try {
    const check = await Updates.checkForUpdateAsync();
    if (!check.isAvailable) return;
    const result = await Updates.fetchUpdateAsync();
    if (result.isNew) await Updates.reloadAsync();
  } catch {
    /* 无网/配额用尽时沿用当前包 */
  }
}

function AppInner() {
  const { themeName } = useTheme();
  return (
    <>
      <StatusBar style={themeName === 'dark' ? 'light' : 'dark'} />
      <RootNavigator />
      <AppDialogHost />
    </>
  );
}

export default function App() {
  useEffect(() => {
    void applyOtaUpdate();
  }, []);
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <AuthProvider>
          <AppInner />
        </AuthProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
