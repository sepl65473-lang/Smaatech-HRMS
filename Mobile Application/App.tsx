import React, { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import NetInfo from '@react-native-community/netinfo';
import { QueryClient, QueryClientProvider, focusManager, onlineManager } from '@tanstack/react-query';
import { AuthProvider } from './src/auth/AuthContext';
import { RootNavigator } from './src/navigation/RootNavigator';
import { ApiError } from './src/services/api';
import { setupChannels } from './src/notifications/local';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // The API client already waits out a cold start and replays reads; a
      // second retry layer would only stretch a real failure.
      retry: (failureCount, error) => error instanceof ApiError && error.code === 'TIMEOUT' && failureCount < 1,
      refetchOnReconnect: true,
    },
    mutations: { retry: false },
  },
});

// Refetch stale data when connectivity or the app itself comes back.
onlineManager.setEventListener((setOnline) => NetInfo.addEventListener((state) => setOnline(state.isConnected !== false)));

export default function App() {
  useEffect(() => {
    void setupChannels();
    const subscription = AppState.addEventListener('change', (status: AppStateStatus) => {
      focusManager.setFocused(status === 'active');
    });
    return () => subscription.remove();
  }, []);

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <StatusBar style="dark" />
          <RootNavigator />
        </AuthProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
