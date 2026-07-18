import React from 'react';
import { useAuth } from '../../auth/AuthContext';
import { PageHeader } from '../../components/ui';

/** Wird in der Integrationsphase mit echten Kennzahlen aus allen Modulen befüllt. */
export function DashboardPage() {
  const { user } = useAuth();
  const hour = new Date().getHours();
  const greeting = hour < 11 ? 'Guten Morgen' : hour < 17 ? 'Guten Tag' : 'Guten Abend';

  return (
    <>
      <PageHeader
        title={`${greeting}, ${user?.name?.split(' ')[0] ?? ''}!`}
        subtitle="Hier ist der Überblick über Ihre Personalarbeit."
      />
    </>
  );
}
