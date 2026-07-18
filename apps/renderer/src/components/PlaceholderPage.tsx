import React from 'react';
import { Construction } from 'lucide-react';
import { PageHeader, EmptyState } from './ui';

/** Übergangsseite, solange ein Fachmodul noch nicht implementiert ist. */
export function PlaceholderPage({ title }: { title: string }) {
  return (
    <>
      <PageHeader title={title} />
      <div className="hm-card">
        <EmptyState
          icon={<Construction size={40} />}
          title="Dieses Modul ist in Arbeit"
          hint="Die Funktion wird in einem der nächsten Schritte implementiert."
        />
      </div>
    </>
  );
}
