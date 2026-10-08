import AppShell from "@/components/AppShell";
import { ErrorBoundary } from "@/components/ErrorBoundary";

export default function Page() {
  return (
    <ErrorBoundary scope="app">
      <AppShell />
    </ErrorBoundary>
  );
}
