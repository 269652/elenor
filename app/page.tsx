import { LandingPage } from '@/components/LandingPage';
import { isSupabaseConfigured } from '@/lib/supabase-client';

export default function Home() {
  return (
    <main className="h-dvh">
      <LandingPage supabaseConfigured={isSupabaseConfigured()} />
    </main>
  );
}
