import React, { useState } from 'react';
import { Lock } from 'lucide-react';
import { PageHeader, Tabs } from '../../components/ui';
import { useAuth } from '../../auth/AuthContext';
import { SetupLeadersTab } from './SetupLeadersTab';
import { SetupCategoriesTab } from './SetupCategoriesTab';
import { SetupScaleTab } from './SetupScaleTab';
import { SetupNote } from './SetupShared';

type TabKey = 'leaders' | 'categories' | 'scale';

/**
 * Einrichtung des Moduls Führung & Bewertung (Rechtebereich `fuehrung`).
 * Drei Reiter: Führungskräfte (freischalten, Zuständigkeit), Kategorien
 * (zentral für alle) und Skala & Zeitraum (unternehmensweite Einstellungen).
 *
 * `canEdit` ist reine Anzeigehilfe: Ohne `fuehrung: bearbeiten` verschwinden
 * die Schreibaktionen und die Formulare sind gesperrt. Durchgesetzt wird das
 * Recht im Backend-Hook (GET = lesen, alles andere = bearbeiten).
 */
export function SetupPage() {
  const { can } = useAuth();
  const canEdit = can('fuehrung', 'bearbeiten');
  const [tab, setTab] = useState<TabKey>('leaders');

  return (
    <>
      <PageHeader
        title="Einrichtung Führung & Bewertung"
        subtitle="Wer bewertet wen, auf welcher Skala, in welchem Rhythmus und mit welchen Kategorien."
      />
      {!canEdit && (
        <div style={{ marginBottom: 16 }}>
          <SetupNote tone="warning" icon={<Lock size={15} />}>
            Sie haben im Bereich „Führung“ nur Leserechte. Freischaltungen, Zuständigkeiten, Kategorien und
            Einstellungen können Sie ansehen, aber nicht ändern.
          </SetupNote>
        </div>
      )}
      <div style={{ marginBottom: 20 }}>
        <Tabs
          tabs={[
            { key: 'leaders', label: 'Führungskräfte' },
            { key: 'categories', label: 'Kategorien' },
            { key: 'scale', label: 'Skala & Zeitraum' },
          ]}
          active={tab}
          onChange={(key) => setTab(key as TabKey)}
        />
      </div>
      {tab === 'leaders' && <SetupLeadersTab canEdit={canEdit} />}
      {tab === 'categories' && <SetupCategoriesTab canEdit={canEdit} />}
      {tab === 'scale' && <SetupScaleTab canEdit={canEdit} />}
    </>
  );
}
