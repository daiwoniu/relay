import InitializationScreen from '../system/InitializationScreen';

export default function AuthLoading({ error, onRetry }: { error?: string; onRetry?: () => void }) {
  return <InitializationScreen stage="auth" error={error} onRetry={onRetry} retryLabel="重新检查" />;
}
